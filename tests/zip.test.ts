/** The streaming ZIP writer, checked with an independent reader and, where available, Info-ZIP's unzip -t. */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { ZipWriter } from "../src/server/util/zip.ts";
import { readZip } from "./helpers/zip.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function collect(fn: (zip: ZipWriter) => Promise<void>, opts?: { forceZip64?: boolean }): Promise<Buffer> {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    out.on("end", resolve);
    out.on("error", reject);
  });
  const zip = new ZipWriter(out, opts);
  await fn(zip);
  await zip.finish();
  await done;
  return Buffer.concat(chunks);
}

const hasUnzip = (() => {
  try {
    execFileSync("unzip", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const unzipTest = (buf: Buffer) => {
  const f = path.join(os.tmpdir(), `acorn-zip-${process.pid}-${Date.now()}.zip`);
  writeFileSync(f, buf);
  try {
    execFileSync("unzip", ["-t", f], { stdio: "pipe" });
  } finally {
    rmSync(f, { force: true });
  }
};

describe("zip writer", () => {
  it("writes deflated and stored entries with UTF-8 names that a reader gets back intact", async () => {
    const text = "松鼠把橡果埋进土里。".repeat(500);
    const buf = await collect(async (zip) => {
      await zip.buffer("文章/一篇.md", text);
      await zip.buffer("图/a.png", PNG);
      await zip.buffer("empty.txt", "");
    });
    const files = readZip(buf);
    expect([...files.keys()]).toEqual(["文章/一篇.md", "图/a.png", "empty.txt"]);
    expect(files.get("文章/一篇.md")!.toString("utf8")).toBe(text);
    expect(files.get("图/a.png")!.equals(PNG)).toBe(true);
    expect(buf.length).toBeLessThan(text.length / 4); // the repeated text deflated
    if (hasUnzip) unzipTest(buf);
  });

  it.skipIf(!hasUnzip)("writes ZIP64 records that unzip accepts", async () => {
    const buf = await collect(
      async (zip) => {
        await zip.buffer("big.txt", "x".repeat(10_000));
        await zip.buffer("b.png", PNG);
      },
      { forceZip64: true },
    );
    expect(buf.readUInt32LE(buf.length - 22 - 20 - 56)).toBe(0x06064b50); // zip64 end of central directory
    unzipTest(buf);
  });
});
