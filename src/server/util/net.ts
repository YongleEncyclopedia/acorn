import os from "node:os";

export interface Origin {
  label: string;
  origin: string;
}

const isTailscale = (ip: string) => {
  const [a, b] = ip.split(".").map(Number);
  return a === 100 && b >= 64 && b <= 127;
};
const isLan = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);

/** Addresses another device could use to reach this server: the configured public URL, Tailscale, then the LAN. */
export function reachableOrigins(port: number, publicUrl: string, host: string): Origin[] {
  const out: Origin[] = [];
  if (publicUrl && !/\/\/(localhost|127\.)/.test(publicUrl)) out.push({ label: "公开地址", origin: publicUrl.replace(/\/+$/, "") });
  if (host === "127.0.0.1" || host === "localhost") return out; // only listening on this machine
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter((n): n is os.NetworkInterfaceInfo => !!n && n.family === "IPv4" && !n.internal)
    .map((n) => n.address);
  const lan = ips.filter(isLan);
  for (const ip of ips.filter(isTailscale)) out.push({ label: "Tailscale", origin: `http://${ip}:${port}` });
  for (const ip of lan) out.push({ label: lan.length > 1 ? `局域网 ${ip}` : "局域网", origin: `http://${ip}:${port}` });
  return out;
}
