import type { Hono } from "hono";
import { z } from "zod";
import type { App } from "../../app.ts";
import type { NetworkStatus } from "../../../shared/types.ts";
import { activeProxy, proxySupported, systemProxy } from "../../util/proxy.ts";
import { httpGet } from "../../util/http.ts";

/** 设置 → 网络: what the server does about the proxy, and whether a site can be reached through it. */
export function registerNetwork(r: Hono, app: App): void {
  r.get("/api/network", (c) => c.json({ active: activeProxy(), system: systemProxy(), supported: proxySupported } satisfies NetworkStatus));

  // Google's no-content page: unreachable from mainland China without a proxy, a few hundred bytes otherwise
  r.post("/api/network/test", async (c) => {
    const { url } = z.object({ url: z.string().url().optional() }).parse(await c.req.json().catch(() => ({})));
    const target = url || "https://www.gstatic.com/generate_204";
    const started = Date.now();
    try {
      const res = await httpGet(target, { userAgent: app.cfg.pageUserAgent, timeoutMs: 12_000, maxBytes: 2_000_000 });
      return c.json({ ok: res.status < 500, status: res.status, ms: Date.now() - started, via: activeProxy(), url: target });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message, ms: Date.now() - started, via: activeProxy(), url: target });
    }
  });
}
