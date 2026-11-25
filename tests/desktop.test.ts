/**
 * The desktop app's own logic that needs no Electron (desktop/lib.ts), and the lock that keeps a library from
 * being served twice (src/server/lock.ts) — the app relies on it to find a server that already has the data open.
 */
import { afterAll, describe, expect, it } from "vitest";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { DEFAULT_PORT, freePort, lanAddresses, loadSettings, normalizeServerUrl, sameOrigin, saveSettings } from "../desktop/lib.ts";
import { holdLock, lockHolder, readLock } from "../src/server/lock.ts";

const dir = mkdtempSync(path.join(os.tmpdir(), "acorn-desktop-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the desktop app's settings", () => {
  it("starts from defaults and keeps what is valid in a damaged file", () => {
    const file = path.join(dir, "shell.json");
    expect(loadSettings(file, "/home/me/Acorn")).toMatchObject({ mode: null, dataDir: path.join("/home/me/Acorn", "data"), port: DEFAULT_PORT, background: true });
    writeFileSync(file, JSON.stringify({ mode: "client", serverUrl: "http://nas.local:7700", port: 99999, dataDir: "relative/path", bounds: { width: 120, height: 900 } }));
    const s = loadSettings(file, "/home/me/Acorn");
    expect(s).toMatchObject({ mode: "client", serverUrl: "http://nas.local:7700", port: DEFAULT_PORT, dataDir: path.join("/home/me/Acorn", "data"), bounds: null });
    writeFileSync(file, "{ not json");
    expect(loadSettings(file, "/home/me/Acorn").mode).toBeNull();
  });

  it("saves and reads back the same settings", () => {
    const file = path.join(dir, "nested", "shell.json");
    const s = { ...loadSettings(file, dir), mode: "host" as const, port: 7710, bounds: { x: 10, y: 20, width: 1200, height: 800, maximized: true } };
    saveSettings(file, s);
    expect(loadSettings(file, dir)).toEqual(s);
  });
});

describe("the address of another Acorn", () => {
  it("accepts what people type and turns it into an origin", () => {
    expect(normalizeServerUrl("192.168.1.20")).toBe("http://192.168.1.20:7700");
    expect(normalizeServerUrl(" 192.168.1.20:8080 ")).toBe("http://192.168.1.20:8080");
    expect(normalizeServerUrl("nas.local")).toBe("http://nas.local:7700");
    expect(normalizeServerUrl("https://acorn.example.com")).toBe("https://acorn.example.com");
    expect(normalizeServerUrl("http://acorn.example.com/s/today?x=1")).toBe("http://acorn.example.com");
    expect(normalizeServerUrl("http://my-mac.tail1234.ts.net:7700/")).toBe("http://my-mac.tail1234.ts.net:7700");
  });

  it("refuses what cannot be an Acorn's address", () => {
    for (const bad of ["", "   ", "ftp://files.example.com", "http://user:secret@nas.local", "not an address", "file:///etc/passwd", "javascript:alert(1)"]) {
      expect(normalizeServerUrl(bad), bad).toBeNull();
    }
  });

  it("tells pages of that Acorn from the rest of the web", () => {
    expect(sameOrigin("http://127.0.0.1:7700/archive/3", "http://127.0.0.1:7700")).toBe(true);
    expect(sameOrigin("http://127.0.0.1:7701/", "http://127.0.0.1:7700")).toBe(false);
    expect(sameOrigin("https://sspai.com/post/1", "http://127.0.0.1:7700")).toBe(false);
    expect(sameOrigin("http://127.0.0.1:7700/", "")).toBe(false);
  });
});

describe("reaching this computer from other devices", () => {
  it("lists addresses on the network, not loopback or self-assigned ones", () => {
    const iface = (address: string, family: "IPv4" | "IPv6" = "IPv4", internal = false) => ({ address, family, internal, netmask: "", mac: "", cidr: null }) as os.NetworkInterfaceInfo;
    const list = lanAddresses(7700, { lo0: [iface("127.0.0.1", "IPv4", true)], en0: [iface("192.168.1.20"), iface("fe80::1", "IPv6")], en5: [iface("169.254.90.174")], utun3: [iface("100.101.102.103"), iface("192.168.1.20")] });
    expect(list).toEqual(["http://192.168.1.20:7700", "http://100.101.102.103:7700"]);
  });

  it("moves to the next port when the preferred one is taken", async () => {
    const taken = http.createServer();
    await new Promise<void>((r) => taken.listen(0, "127.0.0.1", r));
    const port = (taken.address() as AddressInfo).port;
    expect(await freePort(port, "127.0.0.1")).toBeGreaterThan(port);
    taken.close();
  });
});

describe("one library, one server", () => {
  const lockFile = (d: string) => path.join(d, ".lock");

  it("records the server that has a library open, and only that server takes the record away", () => {
    const d = mkdtempSync(path.join(dir, "lib-"));
    const release = holdLock(d, 7700);
    expect(readLock(d)).toMatchObject({ pid: process.pid, port: 7700 });
    // a later server took over in the meantime: its record must survive this one's shutdown
    writeFileSync(lockFile(d), JSON.stringify({ pid: process.pid + 1, port: 7701, startedAt: 1 }));
    release();
    expect(JSON.parse(readFileSync(lockFile(d), "utf8")).port).toBe(7701);
  });

  it("ignores a record left behind by a server that is gone, or that no longer answers", async () => {
    const d = mkdtempSync(path.join(dir, "lib-"));
    writeFileSync(lockFile(d), JSON.stringify({ pid: 2 ** 22 + 12345, port: 7700, startedAt: 1 })); // no such process
    expect(await lockHolder(d)).toBeNull();
    const quiet = http.createServer((_req, res) => res.writeHead(404).end());
    await new Promise<void>((r) => quiet.listen(0, "127.0.0.1", r));
    writeFileSync(lockFile(d), JSON.stringify({ pid: process.ppid, port: (quiet.address() as AddressInfo).port, startedAt: 1 })); // alive, but not an Acorn
    expect(await lockHolder(d)).toBeNull();
    quiet.close();
  });

  it("names the Acorn that answers for a library", async () => {
    const d = mkdtempSync(path.join(dir, "lib-"));
    const acorn = http.createServer((req, res) => (req.url === "/api/health" ? res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}') : res.writeHead(404).end()));
    await new Promise<void>((r) => acorn.listen(0, "127.0.0.1", r));
    const port = (acorn.address() as AddressInfo).port;
    writeFileSync(lockFile(d), JSON.stringify({ pid: process.ppid, port, startedAt: 1 }));
    expect(await lockHolder(d)).toMatchObject({ pid: process.ppid, port });
    // its own record does not stop a server from starting again
    expect(await lockHolder(d, process.ppid)).toBeNull();
    acorn.close();
  });
});
