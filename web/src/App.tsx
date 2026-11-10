import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Route, Switch, Redirect, useLocation } from "wouter";
import { api } from "./lib/api.ts";
import { useBootstrap } from "./lib/queries.ts";
import { useServerEvents } from "./lib/events.ts";
import { applyTheme } from "./lib/theme.ts";
import { Logo } from "./components/Logo.tsx";
import { SealDefs } from "./components/Seal.tsx";
import { Toasts } from "./components/Toasts.tsx";
import { Lightbox } from "./components/Lightbox.tsx";
import { ShortcutSheet } from "./components/Shortcuts.tsx";
import { Empty } from "./components/Empty.tsx";
import { Layout } from "./views/Layout.tsx";
import { StreamPage } from "./views/StreamPage.tsx";
import { SearchPage, SearchPalette } from "./views/Search.tsx";
import { VerifyBanner } from "./components/VerifyBanner.tsx";
import { useHotkeys } from "./lib/hotkeys.ts";
import { layerOpen } from "./lib/layers.ts";
import { toast, ui } from "./lib/store.ts";
import type { EntryView } from "../../src/shared/types.ts";

// The reading view is the app; every other page is fetched when first opened (and warmed up while idle, below),
// which roughly halves the script a phone has to parse before it can show today's articles.
const pages = {
  archive: () => import("./views/ArchiveLibrary.tsx"),
  archiveReader: () => import("./views/ArchiveReader.tsx"),
  notes: () => import("./views/NotesPage.tsx"),
  sources: () => import("./views/SourcesPage.tsx"),
  settings: () => import("./views/SettingsPage.tsx"),
  capture: () => import("./views/CapturePage.tsx"),
  addSource: () => import("./views/AddSource.tsx"),
};
const ArchiveLibrary = lazy(() => pages.archive().then((m) => ({ default: m.ArchiveLibrary })));
const ArchiveReader = lazy(() => pages.archiveReader().then((m) => ({ default: m.ArchiveReader })));
const NotesPage = lazy(() => pages.notes().then((m) => ({ default: m.NotesPage })));
const SourcesPage = lazy(() => pages.sources().then((m) => ({ default: m.SourcesPage })));
const SettingsPage = lazy(() => pages.settings().then((m) => ({ default: m.SettingsPage })));
const CapturePage = lazy(() => pages.capture().then((m) => ({ default: m.CapturePage })));
const AddSourceHost = lazy(() => pages.addSource().then((m) => ({ default: m.AddSourceHost })));

/** Fetch the other pages once the reader has settled, so opening them later is instant (and works offline). */
function useWarmPages(): void {
  useEffect(() => {
    if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return;
    const warm = () => void Promise.all(Object.values(pages).map((load) => load().catch(() => undefined)));
    const idle = window.requestIdleCallback ? window.requestIdleCallback(warm, { timeout: 8000 }) : window.setTimeout(warm, 4000);
    return () => (window.cancelIdleCallback ? window.cancelIdleCallback(idle) : window.clearTimeout(idle));
  }, []);
}

/** While a page's code is on its way: the frame stays, only the content area waits. */
function PageLoading() {
  return (
    <Layout mode="wide">
      <main className="pane wide-pane" aria-busy="true" />
    </Layout>
  );
}

/**
 * Code that is fetched on demand can fail to arrive: the connection dropped, or the server was updated while
 * this tab stayed open and the file it asks for no longer exists. Catch that instead of leaving a blank screen.
 * `resetKey` (the path) gives the page another try when the reader goes somewhere else.
 */
class Boundary extends Component<{ resetKey?: string; fallback: ReactNode; onError?: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError?.();
  }
  componentDidUpdate(prev: { resetKey?: string }) {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function PageFailed() {
  return (
    <Layout mode="wide">
      <main className="pane wide-pane">
        <Empty
          art="acorn"
          title="这一页没能加载出来"
          action={
            <button className="btn primary" onClick={() => window.location.reload()}>
              重新加载
            </button>
          }
        >
          可能是网络断了，或者松果刚刚更新过。
        </Empty>
      </main>
    </Layout>
  );
}

function AddSourceGate() {
  const open = ui.use((s) => !!s.addSource);
  if (!open) return null;
  const failed = () => {
    ui.set({ addSource: null });
    toast("没能打开「添加订阅」：可能是网络断了，或者松果刚刚更新过", { kind: "error", action: { label: "重新加载", run: () => window.location.reload() } });
  };
  return (
    <Boundary fallback={null} onError={failed}>
      <Suspense fallback={null}>
        <AddSourceHost />
      </Suspense>
    </Boundary>
  );
}

function AuthScreen({ setup, canSetup, onDone }: { setup: boolean; canSetup: boolean; onDone: () => void }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  // A one-time login link that was already used or expired lands here with ?login=expired.
  const [err, setErr] = useState(() => (new URLSearchParams(window.location.search).get("login") === "expired" ? "这个登录二维码已经用过或过期了，请在电脑上重新生成，或用密码登录" : ""));
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    if (setup && pw !== pw2) return setErr("两次输入的密码不一致");
    setBusy(true);
    try {
      if (setup) await api.setup(pw);
      else await api.login(pw);
      onDone();
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth">
      <div className="auth-card">
        <Logo size={56} />
        <h1>松果</h1>
        {setup && !canSetup ? (
          <p>
            第一次使用需要设置密码。
            <br />
            请在运行松果的那台电脑上打开这个页面。
          </p>
        ) : (
          <>
            <p>{setup ? "完全属于你的信息系统。先设置一个密码，之后手机和其他设备都用它登录。" : "欢迎回来"}</p>
            <form onSubmit={submit}>
              {/* One user, no name to type; password managers still want one to file the password under. */}
              <input className="sr-only" type="text" name="username" autoComplete="username" value="松果" readOnly tabIndex={-1} aria-hidden="true" />
              <input className="field" type="password" placeholder={setup ? "设置密码（至少 6 位）" : "密码"} value={pw} onChange={(e) => setPw(e.target.value)} autoFocus autoComplete={setup ? "new-password" : "current-password"} />
              {setup && <input className="field" type="password" placeholder="再输入一次" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />}
              <button className="btn primary lg" disabled={busy || pw.length < (setup ? 6 : 1)}>
                {busy ? <span className="spinner" /> : setup ? "开始使用" : "进入"}
              </button>
              {err && <div className="error">{err}</div>}
            </form>
          </>
        )}
      </div>
    </div>
  );
}

const VIEWS: EntryView[] = ["all", "unread", "today", "starred", "progress", "archived"];

function Authed() {
  const boot = useBootstrap();
  const [path] = useLocation();
  useServerEvents(true);
  const theme = boot.data?.settings.reader.theme;
  useEffect(() => {
    if (!theme) return;
    applyTheme(theme);
    if (theme !== "auto") return;
    const m = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => applyTheme("auto");
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [theme]);
  // ⌘K also closes the palette, so it has to work while that layer is open — but it does not open the palette
  // underneath a dialog or the image viewer. The other two belong to the page.
  useHotkeys({ "mod+k": () => (ui.get().palette ? ui.set({ palette: false }) : !layerOpen() && ui.set({ palette: true })) }, true, { overlay: true });
  useHotkeys({
    "/": () => ui.set({ palette: true }),
    "?": () => ui.set({ shortcuts: true }),
  });
  useWarmPages();
  if (boot.isLoading) {
    return (
      <div className="auth">
        <div className="spinner" />
      </div>
    );
  }
  return (
    <>
      <Boundary resetKey={path} fallback={<PageFailed />}>
        <Suspense fallback={<PageLoading />}>
          <Switch>
            <Route path="/s/:view/:entryId?">
              {(p) => (VIEWS.includes(p.view as EntryView) ? <StreamPage stream={{ kind: "view", view: p.view as EntryView }} entryId={p.entryId ? Number(p.entryId) : null} /> : <Redirect to="/s/today" />)}
            </Route>
            <Route path="/feed/:id/:entryId?">{(p) => <StreamPage stream={{ kind: "feed", id: Number(p.id) }} entryId={p.entryId ? Number(p.entryId) : null} />}</Route>
            <Route path="/folder/:id/:entryId?">{(p) => <StreamPage stream={{ kind: "folder", id: Number(p.id) }} entryId={p.entryId ? Number(p.entryId) : null} />}</Route>
            <Route path="/entry/:entryId">{(p) => <StreamPage stream={{ kind: "view", view: "all" }} entryId={Number(p.entryId)} />}</Route>
            <Route path="/archive/:id">{(p) => <ArchiveReader id={Number(p.id)} />}</Route>
            <Route path="/archive">{() => <ArchiveLibrary />}</Route>
            <Route path="/notes">{() => <NotesPage />}</Route>
            <Route path="/sources">{() => <SourcesPage />}</Route>
            <Route path="/settings">{() => <SettingsPage />}</Route>
            <Route path="/search">{() => <SearchPage />}</Route>
            <Route path="/capture">{() => <CapturePage />}</Route>
            <Route>
              <Redirect to="/s/today" />
            </Route>
          </Switch>
        </Suspense>
      </Boundary>
      <SearchPalette />
      <ShortcutSheet />
      <AddSourceGate />
      <VerifyBanner />
    </>
  );
}

export function App() {
  const qc = useQueryClient();
  const session = useQuery({
    queryKey: ["session"],
    queryFn: api.session,
    staleTime: Infinity,
    retry: true,
    retryDelay: (n) => Math.min(1000 * 2 ** n, 8000),
  });
  useEffect(() => {
    const on = () => qc.invalidateQueries({ queryKey: ["session"] });
    window.addEventListener("acorn:unauthorized", on);
    return () => window.removeEventListener("acorn:unauthorized", on);
  }, [qc]);
  const done = async () => {
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "session" });
    await qc.refetchQueries({ queryKey: ["session"] });
  };
  return (
    <>
      <SealDefs />
      {session.isLoading || (session.isError && !session.data) ? (
        <div className="auth">
          <div className="auth-card">
            <div className="spinner" />
            {session.failureCount > 0 && <p>正在连接松果…</p>}
          </div>
        </div>
      ) : session.data?.authenticated ? (
        <Authed />
      ) : (
        <AuthScreen setup={!!session.data?.setupRequired} canSetup={!!session.data?.canSetup} onDone={done} />
      )}
      <Toasts />
      <Lightbox />
    </>
  );
}
