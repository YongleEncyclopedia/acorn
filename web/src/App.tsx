import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Route, Switch, Redirect } from "wouter";
import { api } from "./lib/api.ts";
import { useBootstrap } from "./lib/queries.ts";
import { useServerEvents } from "./lib/events.ts";
import { applyTheme } from "./lib/theme.ts";
import { Logo } from "./components/Logo.tsx";
import { SealDefs } from "./components/Seal.tsx";
import { Toasts, Lightbox } from "./components/Toasts.tsx";
import { StreamPage } from "./views/StreamPage.tsx";
import { ArchiveLibrary } from "./views/ArchiveLibrary.tsx";
import { ArchiveReader } from "./views/ArchiveReader.tsx";
import { NotesPage } from "./views/NotesPage.tsx";
import { SourcesPage } from "./views/SourcesPage.tsx";
import { SettingsPage } from "./views/SettingsPage.tsx";
import { SearchPage, SearchPalette } from "./views/Search.tsx";
import { CapturePage } from "./views/CapturePage.tsx";
import { AddSourceHost } from "./views/AddSource.tsx";
import { VerifyBanner } from "./components/VerifyBanner.tsx";
import { useHotkeys } from "./lib/hotkeys.ts";
import { ui } from "./lib/store.ts";
import type { EntryView } from "../../src/shared/types.ts";

function AuthScreen({ setup, canSetup, onDone }: { setup: boolean; canSetup: boolean; onDone: () => void }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState("");
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
  useHotkeys({
    "mod+k": () => ui.set((s) => ({ palette: !s.palette })),
    "/": () => ui.set({ palette: true }),
  });
  if (boot.isLoading) {
    return (
      <div className="auth">
        <div className="spinner" />
      </div>
    );
  }
  return (
    <>
      <Switch>
        <Route path="/s/:view/:entryId?">
          {(p) => (VIEWS.includes(p.view as EntryView) ? <StreamPage stream={{ kind: "view", view: p.view as EntryView }} entryId={p.entryId ? Number(p.entryId) : null} /> : <Redirect to="/s/today" />)}
        </Route>
        <Route path="/feed/:id/:entryId?">{(p) => <StreamPage stream={{ kind: "feed", id: Number(p.id) }} entryId={p.entryId ? Number(p.entryId) : null} />}</Route>
        <Route path="/folder/:id/:entryId?">{(p) => <StreamPage stream={{ kind: "folder", id: Number(p.id) }} entryId={p.entryId ? Number(p.entryId) : null} />}</Route>
        <Route path="/entry/:entryId">{(p) => <StreamPage stream={{ kind: "view", view: "all" }} entryId={Number(p.entryId)} />}</Route>
        <Route path="/archive/:id">{(p) => <ArchiveReader id={Number(p.id)} />}</Route>
        <Route path="/archive" component={ArchiveLibrary} />
        <Route path="/notes" component={NotesPage} />
        <Route path="/sources" component={SourcesPage} />
        <Route path="/settings" component={SettingsPage} />
        <Route path="/search" component={SearchPage} />
        <Route path="/capture" component={CapturePage} />
        <Route>
          <Redirect to="/s/today" />
        </Route>
      </Switch>
      <SearchPalette />
      <AddSourceHost />
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
