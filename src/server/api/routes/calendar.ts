import type { Hono } from "hono";
import { z } from "zod";
import type { App } from "../../app.ts";
import type { ClassCalendar } from "../../../shared/types.ts";
import { classEvents, readLink, refreshMembers, syncClassCalendar } from "../../calendar/index.ts";
import { ownCanvasUrl } from "../../calendar/canvas.ts";
import { randomToken } from "../../util/text.ts";

const DAY = 86_400_000;

/** One classmate per line: a name and their link, in either order ("张三 https://…", or the link alone). */
export function parseMembers(text: string): { name: string; url: string }[] {
  const out: { name: string; url: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const url = line.match(/https?:\/\/\S+/)?.[0];
    if (!url) continue;
    const name = line.replace(url, "").replace(/[,，:：\t|]+/g, " ").trim();
    out.push({ name, url: url.replace(/[，。,;；]+$/, "") });
  }
  return out;
}

const PATCH = z.object({
  minCount: z.number().int().min(1).max(50).optional(),
  include: z.enum(["important", "all"]).optional(),
  feishuAppId: z.string().max(100).optional(),
  // empty clears it; leaving it out keeps it
  feishuAppSecret: z.string().max(200).optional(),
  feishuCalendarId: z.string().max(300).optional(),
});

function view(app: App): ClassCalendar {
  const { feishuAppSecret, icsKey: _k, refreshedAt: _r, ...config } = app.calendar.state();
  const now = Date.now();
  return { config: { ...config, feishuSecretSet: !!feishuAppSecret }, members: app.calendar.members(), events: classEvents(app, now - DAY, now + 60 * DAY) };
}

/** 设置 → 班级日历. Classmates' links and the Feishu secret only go in, never come back out. */
export function registerCalendar(r: Hono, app: App): void {
  r.get("/api/class-calendar", (c) => c.json(view(app)));

  r.post("/api/class-calendar/members", async (c) => {
    const { text } = z.object({ text: z.string().max(100_000) }).parse(await c.req.json());
    const wanted = parseMembers(text);
    if (!wanted.length) return c.json({ error: "bad_request", message: "没有找到链接：每行一位同学，名字和 Canvas 日历订阅链接" }, 400);
    const failed: { name: string; error: string }[] = [];
    let added = 0;
    for (const [i, m] of wanted.entries()) {
      const name = m.name || `同学 ${app.calendar.links().length + 1}`;
      try {
        // read once before keeping it: a wrong link is said at once, not at the next refresh
        const events = await readLink(app, m.url);
        app.calendar.addMember(name, m.url);
        const id = app.calendar.links().find((l) => l.url === m.url)!.id;
        app.calendar.setEvents(id, events);
        added++;
      } catch (err) {
        failed.push({ name: m.name || `第 ${i + 1} 行`, error: (err as Error).message });
      }
    }
    return c.json({ added, failed, calendar: view(app) });
  });

  // the owner's own Canvas as a source: its announcements (read by the AI model) and due dates
  r.post("/api/class-calendar/own-canvas", async (c) => {
    const canvas = app.accounts.list().find((a) => a.service === "canvas");
    if (!canvas) return c.json({ error: "no_account", message: "先在 设置 → 账号 里连接 Canvas" }, 409);
    app.calendar.addMember("我的 Canvas（课程公告）", ownCanvasUrl(canvas.id));
    await refreshMembers(app);
    return c.json(view(app));
  });

  r.delete("/api/class-calendar/members/:id", (c) => {
    const ok = app.calendar.removeMember(Number(c.req.param("id")));
    return ok ? c.json(view(app)) : c.json({ error: "not_found", message: "没有这位同学" }, 404);
  });

  r.patch("/api/class-calendar", async (c) => {
    const body = PATCH.parse(await c.req.json());
    const cur = app.calendar.state();
    const patch: Partial<typeof cur> = { ...body };
    if (body.feishuAppSecret === undefined) delete patch.feishuAppSecret;
    // another app cannot write to the old app's calendar: start a new one
    if (body.feishuAppId !== undefined && body.feishuAppId !== cur.feishuAppId && body.feishuCalendarId === undefined) patch.feishuCalendarId = "";
    if (patch.feishuCalendarId !== undefined && patch.feishuCalendarId !== cur.feishuCalendarId) app.calendar.forgetSynced();
    app.calendar.setState(patch);
    return c.json(view(app));
  });

  r.post("/api/class-calendar/sync", async (c) => {
    try {
      const feishu = await syncClassCalendar(app);
      return c.json({ feishu, calendar: view(app) });
    } catch (err) {
      return c.json({ error: "feishu", message: (err as Error).message, calendar: view(app) }, 502);
    }
  });

  // the .ics link: made (or made anew, which turns the old one off) on request, shown once
  r.post("/api/class-calendar/link", (c) => {
    const key = randomToken(24);
    app.calendar.setState({ icsKey: key });
    return c.json({ path: `/out/class-calendar.ics?key=${key}` });
  });
}
