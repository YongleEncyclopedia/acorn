/**
 * Streaming ZIP writer with no dependencies: deflate through zlib, data descriptors so nothing has to be buffered or
 * sized ahead, UTF-8 names, ZIP64 once an entry or the archive grows past 4 GB. Enough for exports that Finder,
 * Explorer, unzip and 7-Zip open.
 */
import { createReadStream, statSync } from "node:fs";
import { Readable, type Writable } from "node:stream";
import { createDeflateRaw } from "node:zlib";

// Already-compressed formats are stored as they are; everything else is deflated.
const STORE = /\.(png|jpe?g|gif|webp|avif|heic|mp4|m4a|mp3|ogg|zip|gz|7z|rar|pdf|woff2?)$/i;
const ZIP64_LIMIT = 0xffffffff - 0x1000000; // a margin, since deflate can grow a file slightly

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** CRC-32 of `buf`, continuing from `crc` (the result of a previous call) when given. */
export function crc32(buf: Uint8Array, crc = 0): number {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d: Date): { time: number; date: number } {
  const y = Math.max(1980, d.getFullYear());
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

interface Entry {
  name: Buffer;
  offset: number;
  crc: number;
  csize: number;
  usize: number;
  method: number;
  time: number;
  date: number;
  zip64: boolean;
}

export class ZipWriter {
  private out: Writable;
  private offset = 0;
  private entries: Entry[] = [];
  private forceZip64: boolean;

  /** `forceZip64` writes the 64-bit records for every entry (for testing them without a 4 GB file). */
  constructor(out: Writable, opts: { forceZip64?: boolean } = {}) {
    this.out = out;
    this.forceZip64 = !!opts.forceZip64;
  }

  /** Add a file from disk, under `name` inside the archive. */
  async file(name: string, filePath: string, mtime?: Date): Promise<void> {
    const st = statSync(filePath);
    await this.entry(name, st.size, mtime || st.mtime, createReadStream(filePath));
  }

  async buffer(name: string, data: Buffer | string, mtime = new Date()): Promise<void> {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    await this.entry(name, buf.length, mtime, Readable.from([buf]));
  }

  /** Central directory and end records; ends the output stream. */
  async finish(): Promise<void> {
    const cdStart = this.offset;
    for (const e of this.entries) {
      const extra = Buffer.alloc(e.zip64 ? 28 : 0);
      if (e.zip64) {
        extra.writeUInt16LE(1, 0);
        extra.writeUInt16LE(24, 2);
        extra.writeBigUInt64LE(BigInt(e.usize), 4);
        extra.writeBigUInt64LE(BigInt(e.csize), 12);
        extra.writeBigUInt64LE(BigInt(e.offset), 20);
      }
      const h = Buffer.alloc(46 + e.name.length + extra.length);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(e.zip64 ? 45 : 20, 4);
      h.writeUInt16LE(e.zip64 ? 45 : 20, 6);
      h.writeUInt16LE(0x0808, 8); // data descriptor + UTF-8 names
      h.writeUInt16LE(e.method, 10);
      h.writeUInt16LE(e.time, 12);
      h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.zip64 ? 0xffffffff : e.csize, 20);
      h.writeUInt32LE(e.zip64 ? 0xffffffff : e.usize, 24);
      h.writeUInt16LE(e.name.length, 28);
      h.writeUInt16LE(extra.length, 30);
      h.writeUInt32LE(e.zip64 ? 0xffffffff : e.offset, 42);
      e.name.copy(h, 46);
      extra.copy(h, 46 + e.name.length);
      await this.write(h);
    }
    const cdSize = this.offset - cdStart;
    const n = this.entries.length;
    if (this.entries.some((e) => e.zip64) || n >= 0xffff || cdStart >= 0xffffffff || cdSize >= 0xffffffff) {
      const zipEnd = this.offset;
      const z = Buffer.alloc(56);
      z.writeUInt32LE(0x06064b50, 0);
      z.writeBigUInt64LE(44n, 4);
      z.writeUInt16LE(45, 12);
      z.writeUInt16LE(45, 14);
      z.writeBigUInt64LE(BigInt(n), 24);
      z.writeBigUInt64LE(BigInt(n), 32);
      z.writeBigUInt64LE(BigInt(cdSize), 40);
      z.writeBigUInt64LE(BigInt(cdStart), 48);
      await this.write(z);
      const l = Buffer.alloc(20);
      l.writeUInt32LE(0x07064b50, 0);
      l.writeBigUInt64LE(BigInt(zipEnd), 8);
      l.writeUInt32LE(1, 16);
      await this.write(l);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Math.min(n, 0xffff), 8);
    end.writeUInt16LE(Math.min(n, 0xffff), 10);
    end.writeUInt32LE(Math.min(cdSize, 0xffffffff), 12);
    end.writeUInt32LE(Math.min(cdStart, 0xffffffff), 16);
    await this.write(end);
    await new Promise<void>((resolve) => this.out.end(resolve));
  }

  private async entry(name: string, size: number, mtime: Date, source: Readable): Promise<void> {
    const nameBuf = Buffer.from(name.replace(/\\/g, "/").replace(/^\/+/, ""), "utf8");
    const deflate = !STORE.test(name);
    const zip64 = this.forceZip64 || size >= ZIP64_LIMIT || this.offset >= ZIP64_LIMIT;
    const e: Entry = { name: nameBuf, offset: this.offset, crc: 0, csize: 0, usize: 0, method: deflate ? 8 : 0, ...dosTime(mtime), zip64 };

    const h = Buffer.alloc(30 + nameBuf.length + (zip64 ? 20 : 0));
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(zip64 ? 45 : 20, 4);
    h.writeUInt16LE(0x0808, 6);
    h.writeUInt16LE(e.method, 8);
    h.writeUInt16LE(e.time, 10);
    h.writeUInt16LE(e.date, 12);
    if (zip64) {
      h.writeUInt32LE(0xffffffff, 18);
      h.writeUInt32LE(0xffffffff, 22);
    }
    h.writeUInt16LE(nameBuf.length, 26);
    h.writeUInt16LE(zip64 ? 20 : 0, 28);
    nameBuf.copy(h, 30);
    if (zip64) {
      h.writeUInt16LE(1, 30 + nameBuf.length);
      h.writeUInt16LE(16, 32 + nameBuf.length);
    }
    await this.write(h);

    let crc = 0;
    let usize = 0;
    let csize = 0;
    const count = (chunk: Buffer) => {
      crc = crc32(chunk, crc);
      usize += chunk.length;
    };
    if (deflate) {
      const z = createDeflateRaw({ level: 6 });
      source.on("data", count);
      source.on("error", (err) => z.destroy(err));
      source.pipe(z);
      for await (const chunk of z) {
        csize += (chunk as Buffer).length;
        await this.write(chunk as Buffer);
      }
    } else {
      for await (const chunk of source) {
        count(chunk as Buffer);
        csize += (chunk as Buffer).length;
        await this.write(chunk as Buffer);
      }
    }

    const d = Buffer.alloc(zip64 ? 24 : 16);
    d.writeUInt32LE(0x08074b50, 0);
    d.writeUInt32LE(crc, 4);
    if (zip64) {
      d.writeBigUInt64LE(BigInt(csize), 8);
      d.writeBigUInt64LE(BigInt(usize), 16);
    } else {
      d.writeUInt32LE(csize, 8);
      d.writeUInt32LE(usize, 12);
    }
    await this.write(d);
    this.entries.push({ ...e, crc, csize, usize });
  }

  private write(buf: Buffer): Promise<void> {
    if (this.out.destroyed || this.out.writableEnded) return Promise.reject(new Error("输出已关闭"));
    this.offset += buf.length;
    if (this.out.write(buf)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => {
        this.out.off("error", fail);
        this.out.off("close", fail);
        resolve();
      };
      const fail = (err?: Error) => {
        this.out.off("drain", done);
        reject(err || new Error("输出已关闭"));
      };
      this.out.once("drain", done);
      this.out.once("error", fail);
      this.out.once("close", fail);
    });
  }
}
