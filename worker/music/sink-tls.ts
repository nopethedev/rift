// Starts the voice sink: finds or creates the TLS certificate Lavalink will be asked to trust.
import { execFile } from "node:child_process";
import dns from "node:dns/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { VoiceSink } from "./voice-sink";

export interface SinkEnv {
  enabled: boolean;
  tlsDir: string;
  publicHost: string;
  publicIp?: string;
  wssPort: number;
  udpPort: number;
}

export function loadSinkEnv(transcodeDir: string): SinkEnv {
  return {
    enabled: process.env.SINK_ENABLE !== "0",
    tlsDir: path.resolve(process.env.SINK_TLS_DIR || path.join(transcodeDir, "lavalink-sink")),
    publicHost: process.env.SINK_PUBLIC_HOST || "localhost",
    publicIp: process.env.SINK_PUBLIC_IP || undefined,
    wssPort: Number(process.env.SINK_WSS_PORT) || 4443,
    udpPort: Number(process.env.SINK_UDP_PORT) || 4444,
  };
}

const sh = (cmd: string, args: string[]) => new Promise<void>((res, rej) => execFile(cmd, args, (e, _o, se) => (e ? rej(new Error(`${cmd}: ${String(se).trim() || e.message}`)) : res())));

/** Self-signed certificate whose SAN covers the public host name (regenerated when that changes). */
async function ensureCert(env: SinkEnv): Promise<{ key: Buffer; cert: Buffer }> {
  await fs.mkdir(env.tlsDir, { recursive: true });
  const keyP = path.join(env.tlsDir, "key.pem");
  const certP = path.join(env.tlsDir, "cert.pem");
  const metaP = path.join(env.tlsDir, "host.txt");
  const want = `${env.publicHost}|${env.publicIp ?? ""}`;
  const have = await fs.readFile(metaP, "utf8").catch(() => "");
  if (have !== want || !(await fs.stat(certP).catch(() => null))) {
    const isIp = (h: string) => /^\d+\.\d+\.\d+\.\d+$/.test(h);
    const sans = new Set([`DNS:localhost`, `IP:127.0.0.1`, isIp(env.publicHost) ? `IP:${env.publicHost}` : `DNS:${env.publicHost}`]);
    if (env.publicIp) sans.add(`IP:${env.publicIp}`);
    await sh("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyP, "-out", certP, "-days", "3650", "-subj", "/CN=rift-voice-sink", "-addext", `subjectAltName=${[...sans].join(",")}`]);
    await fs.chmod(keyP, 0o600).catch(() => {});
    await fs.chmod(certP, 0o644).catch(() => {});
    await fs.writeFile(metaP, want);
  }
  return { key: await fs.readFile(keyP), cert: await fs.readFile(certP) };
}

export async function startSink(env: SinkEnv): Promise<VoiceSink> {
  const { key, cert } = await ensureCert(env);
  let ip = env.publicIp;
  if (!ip) ip = /^\d+\.\d+\.\d+\.\d+$/.test(env.publicHost) ? env.publicHost : (await dns.lookup(env.publicHost, { family: 4 }).catch(() => ({ address: "127.0.0.1" }))).address;
  const sink = new VoiceSink({ key, cert, wssPort: env.wssPort, udpPort: env.udpPort, publicHost: env.publicHost, publicIp: ip });
  await sink.start();
  return sink;
}
