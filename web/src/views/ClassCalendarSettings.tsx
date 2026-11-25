/**
 * 设置 → 班级日历: the class's exams, quizzes and labs in one calendar, from the owner's Canvas announcements (read
 * by the AI model) and from calendar links classmates chose to share; as counts without names. Published as an
 * .ics link and, with a Feishu app, a Feishu calendar.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarSync, Copy, RefreshCw, Trash2 } from "lucide-react";
import { api } from "../lib/api.ts";
import { relTime } from "../lib/format.ts";
import { toast, toastError } from "../lib/store.ts";
import { Segmented } from "../components/Controls.tsx";
import type { Bootstrap, ClassCalendar, ClassEvent } from "../../../src/shared/types.ts";

const shanghai = (ms: number, opts: Intl.DateTimeFormatOptions) => new Date(ms).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", ...opts });
const dayKey = (e: ClassEvent) => (e.allDay ? new Date(e.start).toISOString().slice(0, 10) : shanghai(e.start, { year: "numeric", month: "2-digit", day: "2-digit" }));
const dayLabel = (e: ClassEvent) => {
  // an all-day item is a date, not an instant: noon in Shanghai is that date there
  const at = e.allDay ? Date.parse(`${new Date(e.start).toISOString().slice(0, 10)}T12:00:00+08:00`) : e.start;
  return `${shanghai(at, { month: "numeric", day: "numeric" })} ${shanghai(at, { weekday: "short" })}`;
};
const timeOf = (e: ClassEvent) => (e.allDay ? "全天" : e.due ? `${shanghai(e.end, { hour: "2-digit", minute: "2-digit" })} 截止` : `${shanghai(e.start, { hour: "2-digit", minute: "2-digit" })}–${shanghai(e.end, { hour: "2-digit", minute: "2-digit" })}`);

function copy(text: string) {
  void navigator.clipboard?.writeText(text).then(() => toast("已复制"), () => toast(text));
}

export function ClassCalendarSettings({ boot }: { boot: Bootstrap }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["class-calendar"], queryFn: api.classCalendar, staleTime: 30_000 });
  const [busy, setBusy] = useState<"" | "own" | "links" | "sync" | "feishu" | "link">("");
  const [links, setLinks] = useState("");
  const [appId, setAppId] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [icsUrl, setIcsUrl] = useState("");
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: api.accounts, staleTime: 30_000 });
  const data = q.data;
  const set = (c: ClassCalendar): void => {
    qc.setQueryData(["class-calendar"], c);
  };
  const run = async (what: typeof busy, fn: () => Promise<void>) => {
    setBusy(what);
    try {
      await fn();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy("");
    }
  };
  if (!data) return null;
  const cfg = data.config;
  const hasCanvas = !!accounts.data?.accounts.some((a) => a.service === "canvas");
  const own = data.members.filter((m) => m.own);
  const classmates = data.members.filter((m) => !m.own);
  const ai = boot.settings.translate.model;

  const groups: { label: string; items: ClassEvent[] }[] = [];
  for (const e of data.events) {
    const k = dayKey(e);
    const g = groups.at(-1);
    if (g && dayKey(g.items[0]) === k) g.items.push(e);
    else groups.push({ label: dayLabel(e), items: [e] });
  }

  return (
    <section className="settings-section" id="class-calendar">
      <h2>班级日历</h2>
      <div className="settings-card">
        <div className="setting-row stack">
          <div className="txt">
            <b>大家的考试、小测、实验，放进一个日历</b>
            <span>
              用来给班级活动找时间。考试和小测通常发在 Canvas 的公告里：松果用你在「翻译与要点」里设置的 AI 模型{ai ? `（${ai}）` : ""}读出公告里的时间和地点，每条公告只读一次；测验和作业的截止时间直接取自 Canvas。公告是整门课共享的，你和同学共同上的课，你一个人的 Canvas 就够了。
            </span>
          </div>
          {own.length ? null : (
            <div>
              <button type="button" className="btn primary" disabled={!hasCanvas || !!busy} onClick={() => run("own", async () => set(await api.addOwnCanvas()))}>
                {busy === "own" ? <span className="spinner" /> : <CalendarSync size={16} />}
                {busy === "own" ? "正在读公告，第一次要一两分钟…" : "从我的 Canvas 读取"}
              </button>
              {!hasCanvas && <p className="cal-help">先在上面的「账号」里连接 Canvas。</p>}
            </div>
          )}
        </div>

        {[...own, ...classmates].map((m) => (
          <div key={m.id} className="setting-row">
            <div className="txt">
              <b>{m.name}</b>
              <span className={m.error ? "bad-text" : undefined}>
                {m.error || `${m.events} 项${m.checkedAt ? ` · ${relTime(m.checkedAt)}读取` : ""}`}
                {m.own ? "" : ` · ${m.link}`}
              </span>
            </div>
            <button type="button" className="icon-btn sm" title="移除" aria-label={`移除 ${m.name}`} onClick={() => run("links", async () => set(await api.removeClassMember(m.id)))}>
              <Trash2 size={15} />
            </button>
          </div>
        ))}

        <details className="setting-row stack cal-more">
          <summary>同学分享的日历链接（可选）</summary>
          <p className="cal-help">
            给你们没有一起上的课用：同学自愿分享的日历订阅链接（只读，只有日程，不含成绩，也不能做任何操作）。每行一位，名字和链接。只收链接，不收账号和令牌；只有不少于 {cfg.minCount} 人共有的事项才显示课程名，其余只显示类别和人数，任何地方都不出现名字。同学想退出，在这里移除即可，他的日程会随之从班级日历里去掉。
          </p>
          <textarea className="field mono" rows={3} placeholder={"张三 https://…/feeds/calendars/user_….ics\n李四 https://…"} value={links} onChange={(e) => setLinks(e.target.value)} />
          <div>
            <button
              type="button"
              className="btn"
              disabled={!links.trim() || !!busy}
              onClick={() =>
                run("links", async () => {
                  const r = await api.addClassLinks(links);
                  set(r.calendar);
                  setLinks(r.failed.map((f) => f.name).join("\n"));
                  toast(`添加了 ${r.added} 位${r.failed.length ? `；${r.failed.map((f) => `${f.name}：${f.error}`).join("；")}` : ""}`, r.failed.length ? { kind: "error", ms: 8000 } : undefined);
                })
              }
            >
              {busy === "links" ? <span className="spinner" /> : null}
              添加
            </button>
          </div>
        </details>
      </div>

      <div className="settings-card cal-card">
        <div className="setting-row">
          <div className="txt">
            <b>接下来 60 天</b>
            <span>{data.events.length ? `${data.events.length} 项` : own.length ? "暂时没有考试、小测、实验" : "还没有来源"}</span>
          </div>
          <button type="button" className="btn sm" disabled={!!busy || !data.members.length} onClick={() => run("sync", async () => set((await api.syncClassCalendar()).calendar))}>
            {busy === "sync" ? <span className="spinner" /> : <RefreshCw size={14} />}
            现在更新
          </button>
        </div>
        {groups.length > 0 && (
          <div className="setting-row stack">
            <ol className="cal-list">
              {groups.map((g) => (
                <li key={g.label}>
                  <span className="cal-day">{g.label}</span>
                  <ul>
                    {g.items.map((e) => (
                      <li key={e.key}>
                        <span className="cal-time">{timeOf(e)}</span>
                        <span className={`cal-kind k-${e.kind}`}>{e.title}</span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          </div>
        )}
        <div className="setting-row">
          <div className="txt">
            <b>收录</b>
          </div>
          <Segmented value={cfg.include} onChange={(v) => run("sync", async () => set(await api.patchClassCalendar({ include: v })))} options={[{ value: "important", label: "考试、小测、实验" }, { value: "all", label: "也包括作业" }]} />
        </div>
        <div className="setting-row">
          <div className="txt">
            <b>同学共有的事项</b>
            <span>少于这个人数，只显示类别和人数</span>
          </div>
          <Segmented value={cfg.minCount} onChange={(v) => run("sync", async () => set(await api.patchClassCalendar({ minCount: v })))} options={[2, 3, 5].map((n) => ({ value: n, label: `${n} 人` }))} />
        </div>
      </div>

      <div className="settings-card cal-card">
        <div className="setting-row stack">
          <div className="txt">
            <b>订阅链接</b>
            <span>苹果日历、Google 日历、Outlook 都能订阅这个链接。它只打开班级日历，不能访问松果的其他内容；重新生成后，旧链接失效。</span>
          </div>
          {icsUrl ? (
            <div className="cal-link">
              <code>{icsUrl}</code>
              <button type="button" className="icon-btn sm" title="复制" aria-label="复制订阅链接" onClick={() => copy(icsUrl)}>
                <Copy size={15} />
              </button>
            </div>
          ) : null}
          <div>
            <button type="button" className="btn" disabled={!!busy} onClick={() => run("link", async () => setIcsUrl(`${window.location.origin}${(await api.classCalendarLink()).path}`))}>
              {icsUrl ? "重新生成" : "生成链接"}
            </button>
          </div>
        </div>
        <div className="setting-row stack">
          <div className="txt">
            <b>同步到飞书</b>
            <span>
              {cfg.feishuSyncedAt ? `上次同步：${relTime(cfg.feishuSyncedAt)}` : "用一个飞书「企业自建应用」把班级日历写进飞书"}
              {cfg.feishuError ? "" : cfg.feishuCalendarId ? " · 飞书里的日历叫「班级日历」" : ""}
            </span>
            {cfg.feishuError && <span className="bad-text">{cfg.feishuError}</span>}
          </div>
          <details className="cal-steps">
            <summary>怎么建飞书应用</summary>
            <ol>
              <li>打开 open.feishu.cn →「开发者后台」→「创建企业自建应用」，名字可以叫「班级日历」</li>
              <li>「添加应用能力」里添加「机器人」</li>
              <li>「权限管理」里开通日历权限（calendar:calendar，「查看、编辑和管理日历及日程」）</li>
              <li>「版本管理与发布」里创建版本并发布；在学校或团队的飞书里，要等管理员审核通过</li>
              <li>在「凭证与基础信息」里复制 App ID 和 App Secret，填到下面，点「同步到飞书」</li>
            </ol>
          </details>
          <div className="cal-feishu">
            <input className="field mono" placeholder="App ID（cli_…）" value={appId ?? cfg.feishuAppId} onChange={(e) => setAppId(e.target.value.trim())} spellCheck={false} />
            <input className="field mono" type="password" autoComplete="off" placeholder={cfg.feishuSecretSet ? "App Secret 已保存" : "App Secret"} value={secret} onChange={(e) => setSecret(e.target.value.trim())} />
          </div>
          <div className="cal-actions">
            <button
              type="button"
              className="btn primary"
              disabled={!!busy || !(appId ?? cfg.feishuAppId) || !(secret || cfg.feishuSecretSet)}
              onClick={() =>
                run("feishu", async () => {
                  if (appId !== null || secret) set(await api.patchClassCalendar({ ...(appId !== null ? { feishuAppId: appId } : {}), ...(secret ? { feishuAppSecret: secret } : {}) }));
                  setSecret("");
                  setAppId(null);
                  const r = await api.syncClassCalendar();
                  set(r.calendar);
                  if (r.feishu) toast(`已同步到飞书：新增 ${r.feishu.created}，更新 ${r.feishu.updated}，移除 ${r.feishu.removed}`);
                })
              }
            >
              {busy === "feishu" ? <span className="spinner" /> : <CalendarSync size={15} />}
              同步到飞书
            </button>
            <span className="cal-help">之后每 3 小时自动更新一次。</span>
          </div>
        </div>
      </div>
    </section>
  );
}
