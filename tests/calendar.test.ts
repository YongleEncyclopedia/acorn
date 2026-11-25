/**
 * 班级日历: calendar files in and out, merging everyone's items into counts without names, the AI's findings in
 * announcements checked against the text, and the whole flow against stand-in Canvas, AI and Feishu servers.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/server/config.ts";
import { createApp, ensureCliToken, type App } from "../src/server/app.ts";
import { createHttp } from "../src/server/api/http.ts";
import { parseIcs, writeIcs } from "../src/server/calendar/ics.ts";
import { courseOf, mergeEvents } from "../src/server/calendar/merge.ts";
import { checkFound, dedupe, toEvent } from "../src/server/calendar/canvas.ts";
import { parseMembers } from "../src/server/api/routes/calendar.ts";
import { forgetSecrets } from "../src/server/store/accounts.ts";

process.env.ACORN_SILENT = "1";

const at = (iso: string) => Date.parse(iso);

describe("calendar files", () => {
  it("reads times in UTC, in a zone, floating as the school's, and whole days", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:event-assignment-1",
      "DTSTART:20261120T155900Z",
      "SUMMARY:Lab 4 report [ME2110J]",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:event-calendar-event-2",
      "DTSTART;TZID=America/Los_Angeles:20261121T090000",
      "DTEND;TZID=America/Los_Angeles:20261121T103000",
      "SUMMARY:Midterm\\, room 3 [CS101]",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:event-calendar-event-3",
      "DTSTART:20261122T080000",
      "SUMMARY:Morning quiz [ME2110J]",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:event-calendar-event-4",
      "DTSTART;VALUE=DATE:20261123",
      "SUMMARY:Field trip",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    expect(parseIcs(ics)).toEqual([
      { uid: "event-assignment-1", summary: "Lab 4 report [ME2110J]", start: at("2026-11-20T15:59:00Z"), end: at("2026-11-20T15:59:00Z"), allDay: false },
      { uid: "event-calendar-event-2", summary: "Midterm, room 3 [CS101]", start: at("2026-11-21T17:00:00Z"), end: at("2026-11-21T18:30:00Z"), allDay: false },
      { uid: "event-calendar-event-3", summary: "Morning quiz [ME2110J]", start: at("2026-11-22T00:00:00Z"), end: at("2026-11-22T00:00:00Z"), allDay: false },
      { uid: "event-calendar-event-4", summary: "Field trip", start: at("2026-11-23T00:00:00Z"), end: at("2026-11-23T00:00:00Z"), allDay: true },
    ]);
  });

  it("writes what it reads back, folding long lines without splitting a character", () => {
    const title = `考试｜${"很长的标题，".repeat(20)}; a,b\\c`;
    const text = writeIcs("班级日历", [
      { uid: "x@acorn", summary: title, description: "第一行\n第二行", start: at("2026-11-25T08:00:00Z"), end: at("2026-11-25T09:40:00Z"), allDay: false },
      { uid: "y@acorn", summary: "全天", start: at("2026-12-01T00:00:00Z"), end: at("2026-12-01T00:00:00Z"), allDay: true },
    ]);
    for (const line of text.split("\r\n")) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    expect(text).toContain("DTSTART;VALUE=DATE:20261201\r\nDTEND;VALUE=DATE:20261202");
    expect(parseIcs(text).map((e) => [e.summary, e.start, e.allDay])).toEqual([
      [title, at("2026-11-25T08:00:00Z"), false],
      ["全天", at("2026-12-01T00:00:00Z"), true],
    ]);
  });
});

describe("the class calendar out of everyone's", () => {
  const from = at("2026-11-01T00:00:00Z");
  const to = at("2027-01-01T00:00:00Z");
  const item = (memberId: number, uid: string, summary: string, start = at("2026-11-25T08:00:00Z"), end = start + 6_000_000) => ({ memberId, uid, summary, start, end, allDay: false });

  it("counts shared items once, names them only when enough classmates have them, and drops personal ones", () => {
    const events = [
      ...[1, 2, 3].map((m) => item(m, "event-calendar-event-9", "Exam 3 [ME2110J]")),
      item(2, "event-calendar-event-7", "Quiz 2 [CS101]", at("2026-11-26T02:00:00Z")),
      item(2, "event-calendar-event-8", "看牙医"),
      item(3, "event-assignment-5", "Homework 6 [ME2110J]"),
    ];
    const merged = mergeEvents(events, { minCount: 3, include: "important", from, to });
    expect(merged.map((e) => [e.title, e.course, e.count])).toEqual([
      ["考试｜Exam 3 [ME2110J]（3 人）", "ME2110J", 3],
      ["小测（1 人）", null, 1],
    ]);
    // homework only when asked for; a due date shows as the half hour before it
    const all = mergeEvents([item(3, "event-assignment-5", "Homework 6 [ME2110J]", at("2026-11-26T15:59:00Z"), at("2026-11-26T15:59:00Z"))], { minCount: 3, include: "all", from, to });
    expect(all).toMatchObject([{ kind: "assignment", title: "作业（1 人）", due: true, start: at("2026-11-26T15:29:00Z"), end: at("2026-11-26T15:59:00Z") }]);
  });

  it("names the owner's own items, with no count unless classmates have them too", () => {
    const own = new Set([10]);
    const merged = mergeEvents([item(10, "canvas-exam-abc", "Exam 3 · DXY 102 [Intro to Solid Mechanics]"), item(10, "canvas-quiz-77", "Weekly check [ME2110J]"), item(2, "canvas-quiz-77", "Weekly check [ME2110J]")], { minCount: 3, include: "important", from, to, own });
    expect(merged.map((e) => [e.kind, e.title, e.mine])).toEqual([
      ["exam", "考试｜Exam 3 · DXY 102 [Intro to Solid Mechanics]", true],
      ["quiz", "小测｜Weekly check [ME2110J]（2 人）", true],
    ]);
    expect(courseOf("Quiz 2 [CS101]")).toEqual({ title: "Quiz 2", course: "CS101" });
    expect(courseOf("看牙医")).toBeNull();
  });

  it("takes classmates' links one per line, with or without names", () => {
    expect(parseMembers("张三 https://oc.sjtu.edu.cn/feeds/calendars/user_a.ics\nhttps://oc.sjtu.edu.cn/feeds/calendars/user_b.ics，\n李四：https://x.example/c.ics\n没有链接的一行")).toEqual([
      { name: "张三", url: "https://oc.sjtu.edu.cn/feeds/calendars/user_a.ics" },
      { name: "", url: "https://oc.sjtu.edu.cn/feeds/calendars/user_b.ics" },
      { name: "李四", url: "https://x.example/c.ics" },
    ]);
  });
});

describe("assessments read out of announcements", () => {
  const text = "Exam 3 Arrangement\nTime: 2026/11/25, Wed., 16:00-17:40 Exam room: DongXiaYuan (DXY) 102. Quiz next week.";
  const posted = at("2026-11-17T06:00:00Z");

  it("keeps only what the announcement bears out", () => {
    const reply = `<think>the date…</think>{"events":[
      {"kind":"exam","title":"Exam 3","date":"2026-11-25","start":"16:00","end":"17:40","location":"DongXiaYuan (DXY) 102"},
      {"kind":"quiz","title":"Quiz","date":"2026-11-30","start":null,"end":null,"location":null},
      {"kind":"party","title":"Party","date":"2026-11-25","start":null,"end":null,"location":null},
      {"kind":"exam","title":"Final","date":"2028-01-25","start":"9:00","end":null,"location":null},
      {"kind":"exam","title":"Bad","date":"next week","start":null,"end":null,"location":null}]}`;
    // the quiz's day (30) is not in the text; a party is not an assessment; 2028 is too far from the posting
    expect(checkFound(reply, text, posted)).toEqual([{ kind: "exam", title: "Exam 3", date: "2026-11-25", start: "16:00", end: "17:40", location: "DongXiaYuan (DXY) 102" }]);
    expect(checkFound("没有 JSON", text, posted)).toEqual([]);
  });

  it("turns a finding into a Shanghai-time item, the same exam told twice into one", () => {
    const exam = { kind: "exam" as const, title: "Exam 3", date: "2026-11-25", start: "16:00", end: "17:40", location: "DXY 102" };
    const e = toEvent(exam, "Intro to Solid Mechanics");
    expect(e).toMatchObject({ summary: "Exam 3 · DXY 102 [Intro to Solid Mechanics]", start: at("2026-11-25T08:00:00Z"), end: at("2026-11-25T09:40:00Z"), allDay: false });
    expect(toEvent({ ...exam, title: "Exam 3 reminder", location: null }, "Intro to Solid Mechanics").uid).toBe(e.uid);
    expect(toEvent({ ...exam, end: null }, "X").end).toBe(at("2026-11-25T10:00:00Z")); // an exam without an end: two hours
    const reminder = { ...exam, start: null, end: null, course: "Intro to Solid Mechanics" };
    expect(dedupe([{ ...exam, course: "Intro to Solid Mechanics" }, reminder])).toHaveLength(1);
    expect(dedupe([reminder])).toHaveLength(1);
  });
});

describe("the class calendar from the owner's Canvas to Feishu", () => {
  const DAY = 86_400_000;
  // dates relative to today, so the test never ages out of the calendar's window
  const shanghaiDate = (ms: number) => new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10);
  const examDay = shanghaiDate(Date.now() + 10 * DAY);
  const quizDue = new Date(Date.now() + 5 * DAY).toISOString();
  const icsTime = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  let server: http.Server;
  let base = "";
  let app: App;
  let web: ReturnType<typeof createHttp>;
  let auth = "";
  let dataDir = "";
  const aiCalls: string[] = [];
  const feishu = { calendars: 0, created: [] as Record<string, any>[], patched: 0, deleted: [] as string[], tokens: [] as string[] };

  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url || "/", "http://x");
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      const json = (data: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      // Canvas
      if (url.pathname === "/api/v1/courses") return json([{ id: 11, name: "Intro to Solid Mechanics" }]);
      if (url.pathname === "/api/v1/announcements")
        return json([
          { id: 501, title: "Exam 3 Arrangement", message: `<p>Time: ${examDay.replace(/-/g, "/")}, 16:00-17:40</p><p>Exam room: DXY 102</p>`, posted_at: new Date().toISOString(), context_code: "course_11" },
          { id: 502, title: "Office hours moved", message: "<p>Tuesday afternoon from now on.</p>", posted_at: new Date().toISOString(), context_code: "course_11" },
        ]);
      if (url.pathname === "/api/v1/planner/items")
        return json([
          { plannable_id: 77, plannable_type: "quiz", plannable: { title: "Weekly check", due_at: quizDue }, context_name: "Intro to Solid Mechanics" },
          { plannable_id: 78, plannable_type: "announcement", plannable: { title: "x" }, context_name: "Intro to Solid Mechanics" },
        ]);
      // the AI model
      if (url.pathname === "/v1/chat/completions") {
        aiCalls.push(body.messages[1].content);
        return json({ choices: [{ message: { content: JSON.stringify({ events: [{ kind: "exam", title: "Exam 3", date: examDay, start: "16:00", end: "17:40", location: "DXY 102" }] }) } }] });
      }
      // a classmate's calendar link: a course lab, and something personal
      if (url.pathname === "/ics/a.ics") {
        res.writeHead(200, { "content-type": "text/calendar" });
        const lab = Date.now() + 12 * DAY;
        return res.end(["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:event-calendar-event-900", `DTSTART:${icsTime(lab)}`, `DTEND:${icsTime(lab + 7_200_000)}`, "SUMMARY:Lab 2 [ME2110J]", "END:VEVENT", "BEGIN:VEVENT", "UID:event-calendar-event-901", `DTSTART:${icsTime(lab)}`, "SUMMARY:看牙医", "END:VEVENT", "END:VCALENDAR"].join("\r\n"));
      }
      // Feishu's open platform
      if (url.pathname === "/open-apis/auth/v3/tenant_access_token/internal") {
        return json(body.app_id === "cli_a" && body.app_secret === "s3cret" ? { code: 0, tenant_access_token: "t-1", expire: 7200 } : { code: 10014, msg: "app secret invalid" });
      }
      if (url.pathname.startsWith("/open-apis/calendar/")) {
        feishu.tokens.push(String(req.headers.authorization));
        if (req.method === "POST" && url.pathname === "/open-apis/calendar/v4/calendars") {
          feishu.calendars++;
          return json({ code: 0, data: { calendar: { calendar_id: "cal_1", type: "shared", role: "owner" } } });
        }
        const ev = url.pathname.match(/^\/open-apis\/calendar\/v4\/calendars\/cal_1\/events(?:\/(.+))?$/);
        if (ev && req.method === "POST") {
          feishu.created.push(body);
          return json({ code: 0, data: { event: { event_id: `ev_${feishu.created.length}` } } });
        }
        if (ev && req.method === "PATCH") {
          feishu.patched++;
          return json({ code: 0, data: { event: { event_id: ev[1] } } });
        }
        if (ev && req.method === "DELETE") {
          feishu.deleted.push(ev[1]!);
          return json({ code: 0 });
        }
      }
      json({ error: "not found" }, 404);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dataDir = mkdtempSync(path.join(os.tmpdir(), "acorn-calendar-"));
    app = createApp(loadConfig({ ACORN_DATA_DIR: dataDir, ACORN_EGO_BROWSER: "definitely-not-installed", ACORN_FEISHU_BASE: base }, { scheduler: false }));
    auth = `Bearer ${ensureCliToken(app)}`;
    web = createHttp(app);
    app.accounts.save("canvas", base, "张三", { token: "canvas-token" });
    app.settings.update({ translate: { ...app.settings.all().translate, provider: "openai", baseUrl: `${base}/v1`, model: "m", apiKey: "k" } });
  });

  afterAll(() => {
    server.close();
    app.db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const call = async (p: string, method = "GET", body?: unknown) => {
    const res = await web.request(p, { method, headers: { authorization: auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, text: await res.text() };
  };
  const titles = async () => (JSON.parse((await call("/api/class-calendar")).text).events as { title: string }[]).map((e) => e.title);

  it("reads exams out of the owner's announcements, and quizzes from the planner", async () => {
    const r = await call("/api/class-calendar/own-canvas", "POST");
    expect(r.status).toBe(200);
    expect(await titles()).toEqual(["小测｜Weekly check [Intro to Solid Mechanics]", "考试｜Exam 3 · DXY 102 [Intro to Solid Mechanics]"]);
    // only the announcement that mentions an assessment went to the model, and only once
    expect(aiCalls).toHaveLength(1);
    expect(aiCalls[0]).toMatch(/Course: Intro to Solid Mechanics\nTitle: Exam 3 Arrangement/);
    await call("/api/class-calendar/sync", "POST");
    expect(aiCalls).toHaveLength(1);
  });

  it("adds a classmate's link, keeping personal items out and course items nameless below the threshold", async () => {
    const r = JSON.parse((await call("/api/class-calendar/members", "POST", { text: `王五 ${base}/ics/a.ics\n赵六 ${base}/nothing.ics` })).text);
    expect(r).toMatchObject({ added: 1, failed: [{ name: "赵六" }] });
    expect(await titles()).toContain("实验（1 人）");
    expect((await titles()).some((t) => /看牙医/.test(t))).toBe(false);
    // the link itself never comes back
    expect((await call("/api/class-calendar")).text).not.toContain(`${base}/ics/a.ics`);
  });

  it("publishes an .ics behind a key of its own, without names", async () => {
    expect((await call("/out/class-calendar.ics")).status).toBe(401);
    const { path: link } = JSON.parse((await call("/api/class-calendar/link", "POST")).text);
    const ics = await web.request(link);
    expect(ics.status).toBe(200);
    expect(ics.headers.get("content-type")).toMatch(/text\/calendar/);
    const text = await ics.text();
    expect(text).toContain("SUMMARY:考试｜Exam 3 · DXY 102 [Intro to Solid Mechanics]");
    expect(text).toContain("SUMMARY:实验（1 人）");
    expect(text).not.toMatch(/王五|看牙医/);
    // a new link turns the old one off
    await call("/api/class-calendar/link", "POST");
    expect((await web.request(link)).status).toBe(401);
  });

  it("syncs to a Feishu calendar it creates, then only what changed", async () => {
    await call("/api/class-calendar", "PATCH", { feishuAppId: "cli_a", feishuAppSecret: "wrong" });
    const bad = await call("/api/class-calendar/sync", "POST");
    expect(bad.status).toBe(502);
    expect(JSON.parse(bad.text).message).toMatch(/没能用 App ID 和 App Secret 取得飞书凭证/);
    await call("/api/class-calendar", "PATCH", { feishuAppSecret: "s3cret" });
    const view = (await call("/api/class-calendar")).text;
    expect(view).not.toContain("s3cret");
    expect(JSON.parse(view).config.feishuSecretSet).toBe(true);

    const first = JSON.parse((await call("/api/class-calendar/sync", "POST")).text);
    expect(first.feishu).toMatchObject({ created: 3, updated: 0, removed: 0, calendarId: "cal_1" });
    expect(feishu.calendars).toBe(1);
    expect(feishu.tokens.every((t) => t === "Bearer t-1")).toBe(true);
    const exam = feishu.created.find((e) => /Exam 3/.test(e.summary))!;
    expect(exam).toMatchObject({ need_notification: false, start_time: { timezone: "Asia/Shanghai" } });
    expect(Number(exam.end_time.timestamp) - Number(exam.start_time.timestamp)).toBe(100 * 60);
    // nothing changed: nothing written
    expect(JSON.parse((await call("/api/class-calendar/sync", "POST")).text).feishu).toMatchObject({ created: 0, updated: 0, removed: 0 });
    // the classmate withdraws: their lab leaves the Feishu calendar too
    const member = JSON.parse(view).members.find((m: { name: string }) => m.name === "王五");
    await call(`/api/class-calendar/members/${member.id}`, "DELETE");
    expect(JSON.parse((await call("/api/class-calendar/sync", "POST")).text).feishu).toMatchObject({ created: 0, removed: 1 });
    expect(feishu.calendars).toBe(1);
  });

  it("keeps neither classmates' links nor the Feishu secret in a copy that leaves this computer", async () => {
    await call("/api/class-calendar/members", "POST", { text: `王五 ${base}/ics/a.ics` });
    const copy = path.join(dataDir, "copy.db");
    await backup(app.db.raw, copy);
    forgetSecrets(copy);
    const db = new DatabaseSync(copy);
    expect(db.prepare("select count(*) as n from calendar_members").get()).toEqual({ n: 0 });
    const state = JSON.parse((db.prepare("select value from settings where key = '_classCalendar'").get() as { value: string }).value);
    expect(state).toMatchObject({ feishuAppSecret: "", icsKey: "", feishuAppId: "cli_a" });
    db.close();
  });
});
