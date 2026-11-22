// Minimal Ogg Opus muxer: wraps raw Opus packets (20 ms frames) into Ogg pages a browser or ffmpeg can read live.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

export function oggCrc(buf: Buffer): number {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ buf[i]) & 0xff]) >>> 0;
  return crc >>> 0;
}

function page(serial: number, seq: number, granule: bigint, flags: number, packets: Buffer[]): Buffer {
  const segs: number[] = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) { segs.push(255); n -= 255; }
    segs.push(n);
  }
  if (segs.length > 255) throw new Error("ogg page overflow");
  const head = Buffer.alloc(27 + segs.length);
  head.write("OggS", 0, "ascii");
  head[4] = 0;
  head[5] = flags;
  head.writeBigUInt64LE(BigInt.asUintN(64, granule), 6);
  head.writeUInt32LE(serial >>> 0, 14);
  head.writeUInt32LE(seq, 18);
  head.writeUInt32LE(0, 22);
  head[26] = segs.length;
  for (let i = 0; i < segs.length; i++) head[27 + i] = segs[i];
  const out = Buffer.concat([head, ...packets]);
  out.writeUInt32LE(oggCrc(out), 22);
  return out;
}

export class OggOpusMuxer {
  private seq = 0;
  private granule = 0n;
  private pending: Buffer[] = [];
  private pendingSamples = 0n;
  private started = false;

  constructor(private readonly serial = (Math.random() * 0xffffffff) >>> 0, private readonly channels = 2, private readonly maxPackets = 8) {}

  /** The two mandatory header pages (OpusHead, OpusTags). Call once, first. */
  headers(): Buffer {
    const h = Buffer.alloc(19);
    h.write("OpusHead", 0, "ascii");
    h[8] = 1;
    h[9] = this.channels;
    h.writeUInt16LE(0, 10); // pre-skip
    h.writeUInt32LE(48000, 12); // original input rate (informational)
    h.writeInt16LE(0, 16); // output gain
    h[18] = 0; // mapping family 0
    const vendor = Buffer.from("rift");
    const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
    tags.write("OpusTags", 0, "ascii");
    tags.writeUInt32LE(vendor.length, 8);
    vendor.copy(tags, 12);
    tags.writeUInt32LE(0, 12 + vendor.length);
    this.started = true;
    return Buffer.concat([page(this.serial, this.seq++, 0n, 0x02, [h]), page(this.serial, this.seq++, 0n, 0, [tags])]);
  }

  /** Adds one Opus packet; returns a finished page when the batch is full, else null. */
  push(packet: Buffer, samples = 960): Buffer | null {
    if (!this.started) throw new Error("call headers() first");
    this.pending.push(packet);
    this.pendingSamples += BigInt(samples);
    return this.pending.length >= this.maxPackets ? this.flush(false) : null;
  }

  /** Emits whatever is buffered (and the end-of-stream marker when `eos`). */
  flush(eos: boolean): Buffer | null {
    if (!this.pending.length && !eos) return null;
    this.granule += this.pendingSamples;
    const out = page(this.serial, this.seq++, this.granule, eos ? 0x04 : 0, this.pending);
    this.pending = [];
    this.pendingSamples = 0n;
    return out;
  }
}
