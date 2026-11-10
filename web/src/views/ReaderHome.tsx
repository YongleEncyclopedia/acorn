import { useLocation } from "wouter";
import { Logo } from "../components/Logo.tsx";
import { Ring } from "./EntryList.tsx";
import { useBootstrap, useEntries } from "../lib/queries.ts";
import { greeting, timeLeft, todayHeading } from "../lib/format.ts";
import { ui } from "../lib/store.ts";
import type { EntrySummary } from "../../../src/shared/types.ts";

/**
 * What the reading pane shows while no article is open: the day, what is waiting, and the articles left
 * half-read — picking up where you stopped is the likeliest reason to be looking at this page.
 */
export function ReaderHome({ first, onOpen }: { first: EntrySummary | null; onOpen: (e: EntrySummary) => void }) {
  const boot = useBootstrap();
  const [, navigate] = useLocation();
  const reading = useEntries({ view: "progress" });
  const c = boot.data?.counts;
  const feedTitle = (id: number) => boot.data?.feeds.find((f) => f.id === id)?.title || "";
  const resume = reading.data?.pages[0]?.items.slice(0, 3) ?? [];
  const waiting = !c ? "" : c.unread === 0 ? "都读完了" : c.today > 0 ? `今日 ${c.today} 篇未读，一共 ${c.unread} 篇` : `还有 ${c.unread} 篇未读`;
  return (
    <div className="home scroll">
      <div className="home-inner">
        <Logo size={36} />
        <h2>{greeting()}</h2>
        <p className="day">
          {todayHeading()}
          {waiting && <span> · {waiting}</span>}
        </p>
        {first && (
          <button className="btn" onClick={() => onOpen(first)}>
            从第一篇读起
            <kbd>J</kbd>
          </button>
        )}
        {resume.length > 0 && (
          <section className="home-resume">
            <h3>接着读</h3>
            {resume.map((e) => (
              <button key={e.id} className="resume" onClick={() => navigate(`/s/progress/${e.id}`)}>
                <Ring p={e.progress} size={22} />
                <span className="txt">
                  <b>{e.title}</b>
                  <span>{[feedTitle(e.feedId), timeLeft(e.wordCount, e.progress)].filter(Boolean).join(" · ")}</span>
                </span>
              </button>
            ))}
          </section>
        )}
        <p className="keys">
          <kbd>J</kbd>
          <kbd>K</kbd> 上下篇 <kbd>空格</kbd> 翻页 <kbd>S</kbd> 稍后读 <kbd>Z</kbd> 专注
          <button className="link-btn" onClick={() => ui.set({ shortcuts: true })}>
            全部快捷键
          </button>
        </p>
      </div>
    </div>
  );
}
