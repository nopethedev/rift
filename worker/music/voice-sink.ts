// "Voice sink": a receiver that speaks just enough of the Discord voice protocol (gateway v8 + UDP/RTP, AES-GCM) for a
// Lavalink node to "connect to a voice channel" on it. Lavalink then sends the Opus audio of the playing track to us
// instead of to Discord, and we re-wrap it as an Ogg Opus stream the Rift cache pipeline can consume.
//
// Lavalink normally exposes no audio over HTTP, only through voice connections. This is the bridge.
import { createDecipheriv, randomBytes } from "node:crypto";
import dgram from "node:dgram";
import https from "node:https";
import { PassThrough } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { OggOpusMuxer } from "./ogg";

const MODE = "aead_aes256_gcm_rtpsize";

export interface SinkOptions {
  /** TLS key/cert for the wss:// gateway (Lavalink's JVM must trust the certificate). */
  key: string | Buffer;
  cert: string | Buffer;
  wssPort: number;
  udpPort: number;
  bindHost?: string;
  /** Host name Lavalink uses to reach the sink (goes into `endpoint`). */
  publicHost: string;
  /** IPv4 Lavalink should send RTP to. */
  publicIp: string;
}

export interface SinkTicket {
  /** Pass to Lavalink as the player's `voice` state. */
  voice: { token: string; endpoint: string; sessionId: string; channelId: string };
  guildId: string;
  /** Ogg Opus bytes, ends when the ticket is closed. */
  stream: PassThrough;
  /** Resolves once Lavalink has opened the voice connection. */
  connected: Promise<void>;
  stats: { packets: number; bytes: number; decryptErrors: number; connected: boolean };
  /** Flush, write the end-of-stream page and finish `stream`. */
  close(): void;
}

interface TicketInternal extends SinkTicket {
  ssrc: number;
  key: Buffer;
  muxer: OggOpusMuxer;
  lastSeq: number | null;
  ws?: WebSocket;
  flushTimer?: NodeJS.Timeout;
  closed: boolean;
  onConnected(): void;
  rejectConnected(e: Error): void;
}

const snowflake = () => String(BigInt(Date.now() - 1420070400000) << 22n | BigInt(Math.floor(Math.random() * 4194303)));

export class VoiceSink {
  private https?: https.Server;
  private wss?: WebSocketServer;
  private udp?: dgram.Socket;
  private byToken = new Map<string, TicketInternal>();
  private bySsrc = new Map<number, TicketInternal>();
  private nextSsrc = 1000 + Math.floor(Math.random() * 1_000_000);

  constructor(private readonly opts: SinkOptions) {}

  get endpoint(): string {
    return `${this.opts.publicHost}:${this.opts.wssPort}`;
  }

  async start(): Promise<void> {
    const server = https.createServer({ key: this.opts.key, cert: this.opts.cert });
    this.https = server;
    const wss = new WebSocketServer({ server });
    this.wss = wss;
    wss.on("connection", (ws) => this.onGateway(ws));
    const udp = dgram.createSocket("udp4");
    this.udp = udp;
    udp.on("message", (m, r) => this.onUdp(m, r));
    await Promise.all([
      new Promise<void>((res, rej) => { server.once("error", rej); server.listen(this.opts.wssPort, this.opts.bindHost ?? "0.0.0.0", () => res()); }),
      new Promise<void>((res, rej) => { udp.once("error", rej); udp.bind(this.opts.udpPort, this.opts.bindHost ?? "0.0.0.0", () => res()); }),
    ]);
  }

  async stop(): Promise<void> {
    for (const t of [...this.byToken.values()]) t.close();
    this.wss?.close();
    this.https?.closeAllConnections();
    await new Promise<void>((r) => (this.https ? this.https.close(() => r()) : r()));
    await new Promise<void>((r) => { try { this.udp?.close(() => r()); } catch { r(); } });
  }

  createTicket(): SinkTicket {
    const token = randomBytes(16).toString("hex");
    const muxer = new OggOpusMuxer();
    const stream = new PassThrough();
    let onConnected!: () => void;
    let rejectConnected!: (e: Error) => void;
    const connected = new Promise<void>((res, rej) => { onConnected = res; rejectConnected = rej; });
    connected.catch(() => {});
    const t: TicketInternal = {
      voice: { token, endpoint: this.endpoint, sessionId: randomBytes(8).toString("hex"), channelId: snowflake() },
      guildId: snowflake(),
      stream,
      connected,
      stats: { packets: 0, bytes: 0, decryptErrors: 0, connected: false },
      ssrc: this.nextSsrc++ >>> 0,
      key: randomBytes(32),
      muxer,
      lastSeq: null,
      closed: false,
      onConnected,
      rejectConnected,
      close: () => this.closeTicket(t),
    };
    stream.write(muxer.headers());
    this.byToken.set(token, t);
    this.bySsrc.set(t.ssrc, t);
    return t;
  }

  private closeTicket(t: TicketInternal) {
    if (t.closed) return;
    t.closed = true;
    if (t.flushTimer) clearInterval(t.flushTimer);
    const last = t.muxer.flush(true);
    if (last) t.stream.write(last);
    t.stream.end();
    t.rejectConnected(new Error("voice sink ticket closed before Lavalink connected"));
    this.byToken.delete(t.voice.token);
    this.bySsrc.delete(t.ssrc);
    try { t.ws?.close(); } catch { /* already closed */ }
  }

  private onGateway(ws: WebSocket) {
    let ticket: TicketInternal | undefined;
    ws.send(JSON.stringify({ op: 8, d: { heartbeat_interval: 13750 } }));
    ws.on("message", (raw, isBinary) => {
      if (isBinary) return; // DAVE (E2EE) frames: never negotiated, ignore
      let msg: { op: number; d?: Record<string, unknown> };
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const d = msg.d ?? {};
      switch (msg.op) {
        case 0: { // Identify
          const t = this.byToken.get(String(d.token));
          if (!t || t.closed || String(d.session_id) !== t.voice.sessionId) { ws.close(4004, "Authentication failed"); return; }
          ticket = t;
          t.ws = ws;
          ws.send(JSON.stringify({ op: 2, d: { ssrc: t.ssrc, ip: this.opts.publicIp, port: this.opts.udpPort, modes: [MODE], heartbeat_interval: 13750 } }));
          break;
        }
        case 1: { // Select Protocol
          if (!ticket) return;
          const data = (d.data ?? {}) as { mode?: string };
          const mode = String(d.mode ?? data.mode ?? "");
          if (mode !== MODE) { ws.close(4016, "Unknown encryption mode"); return; }
          ws.send(JSON.stringify({ op: 4, d: { mode, secret_key: [...ticket.key], audio_codec: "opus", dave_protocol_version: 0 } }));
          ticket.stats.connected = true;
          ticket.onConnected();
          break;
        }
        case 3: ws.send(JSON.stringify({ op: 6, d: d ?? msg.d })); break; // Heartbeat -> ack
        case 7: ws.send(JSON.stringify({ op: 9, d: null })); break; // Resume
        default: break; // speaking (5), client connect/flags (11,12,15, ...) need no reply
      }
    });
    ws.on("close", () => { if (ticket && !ticket.closed && ticket.ws === ws) ticket.ws = undefined; });
    ws.on("error", () => {});
  }

  private onUdp(m: Buffer, r: dgram.RemoteInfo) {
    // IP discovery: 74 bytes, type 1 -> reply type 2 with the address we saw.
    if (m.length === 74 && m.readUInt16BE(0) === 1) {
      const out = Buffer.alloc(74);
      out.writeUInt16BE(2, 0);
      out.writeUInt16BE(70, 2);
      out.writeUInt32BE(m.readUInt32BE(4), 4);
      out.write(r.address, 8, "ascii");
      out.writeUInt16BE(r.port, 72);
      this.udp?.send(out, r.port, r.address);
      return;
    }
    if (m.length < 12 + 16 + 4 || (m[0] >> 6) !== 2) return;
    const t = this.bySsrc.get(m.readUInt32BE(8));
    if (!t || t.closed) return;
    const opus = decryptRtp(m, t.key);
    if (!opus) { t.stats.decryptErrors++; return; }
    const seq = m.readUInt16BE(2);
    if (t.lastSeq !== null && ((seq - t.lastSeq) & 0xffff) > 0x8000) return; // late / duplicate
    t.lastSeq = seq;
    if (!opus.length) return;
    t.stats.packets++;
    t.stats.bytes += opus.length;
    const pg = t.muxer.push(opus);
    if (pg) t.stream.write(pg);
    // Low-latency flush while the stream trickles in at realtime speed.
    if (!t.flushTimer) {
      t.flushTimer = setInterval(() => {
        const p = t.muxer.flush(false);
        if (p) t.stream.write(p);
      }, 250);
      t.flushTimer.unref();
    }
  }
}

/** Decrypts an `aead_aes256_gcm_rtpsize` RTP packet and returns the Opus payload (null when authentication fails). */
export function decryptRtp(pkt: Buffer, key: Buffer): Buffer | null {
  const cc = pkt[0] & 0x0f;
  const hasExt = (pkt[0] & 0x10) !== 0;
  const headerLen = 12 + cc * 4 + (hasExt ? 4 : 0);
  if (pkt.length < headerLen + 16 + 4) return null;
  const nonce = pkt.subarray(pkt.length - 4);
  const tag = pkt.subarray(pkt.length - 4 - 16, pkt.length - 4);
  const ct = pkt.subarray(headerLen, pkt.length - 4 - 16);
  const iv = Buffer.alloc(12);
  nonce.copy(iv, 0);
  try {
    const d = createDecipheriv("aes-256-gcm", key, iv);
    d.setAAD(pkt.subarray(0, headerLen));
    d.setAuthTag(tag);
    let pt = Buffer.concat([d.update(ct), d.final()]);
    if (hasExt) {
      const words = pkt.readUInt16BE(headerLen - 2);
      pt = pt.subarray(words * 4); // extension data is encrypted in the rtpsize modes
    }
    return pt;
  } catch {
    return null;
  }
}
