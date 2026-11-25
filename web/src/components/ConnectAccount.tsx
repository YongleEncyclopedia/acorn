/**
 * Connecting a 账号 (知识星球, Canvas…): in the user's own browser when the server can open one there (Acorn
 * reads the sign-in from it), or by pasting a token or cookie, with the steps to find it. Used by 设置 → 账号
 * and by 添加订阅 when a plugin needs an account that is not connected yet.
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, LogIn } from "lucide-react";
import { api } from "../lib/api.ts";
import { toast } from "../lib/store.ts";
import type { Account, AccountService } from "../../../src/shared/types.ts";

export const useAccounts = () => useQuery({ queryKey: ["accounts"], queryFn: api.accounts, staleTime: 30_000 });

const host = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

export function ConnectAccount({ service, origin: start, onDone }: { service: AccountService; origin?: string; onDone?: (a: Account) => void }) {
  const qc = useQueryClient();
  const [origin, setOrigin] = useState(start || service.origin);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState<"" | "browser" | "manual">("");
  const [waiting, setWaiting] = useState<{ spaceId: number; message: string } | null>(null);
  const [error, setError] = useState("");

  const finish = (a: Account) => {
    qc.invalidateQueries({ queryKey: ["accounts"] });
    qc.invalidateQueries({ queryKey: ["bootstrap"] });
    setWaiting(null);
    toast(`已连接${service.name}：${a.name}`);
    onDone?.(a);
  };
  const run = async (kind: "browser" | "manual", call: () => Promise<{ account: Account } | { waiting: true; spaceId: number; message: string }>) => {
    setBusy(kind);
    setError("");
    try {
      const r = await call();
      if ("account" in r) finish(r.account);
      else setWaiting({ spaceId: r.spaceId, message: r.message });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const browser = () => run("browser", () => (waiting ? api.browserLoginDone(waiting.spaceId) : api.browserLogin({ service: service.id, origin })));
  const manual = () => run("manual", () => api.connectAccount({ service: service.id, origin, [service.manual.kind]: value.trim() }));
  const m = service.manual;

  return (
    <div className="connect">
      {service.originEditable && (
        <div className="connect-row">
          <label className="lbl" htmlFor={`origin-${service.id}`}>
            地址
          </label>
          <input id={`origin-${service.id}`} className="field mono" value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder={service.origin} spellCheck={false} />
        </div>
      )}
      {service.browserLogin &&
        (waiting ? (
          <div className="callout connect-waiting">
            <span>{waiting.message}</span>
            <span className="connect-actions">
              <button type="button" className="btn sm ghost" onClick={() => setWaiting(null)} disabled={!!busy}>
                取消
              </button>
              <button type="button" className="btn sm primary" onClick={browser} disabled={!!busy}>
                {busy === "browser" ? <span className="spinner" /> : null}
                我已登录
              </button>
            </span>
          </div>
        ) : (
          <div className="connect-browser">
            <button type="button" className="btn primary" onClick={browser} disabled={!!busy}>
              {busy === "browser" ? <span className="spinner" /> : <LogIn size={16} />}
              用浏览器登录
            </button>
            <span className="connect-help">在这台电脑的 ego 浏览器里打开{service.name}，扫码或输入密码登录；已经登录过的话，一下就好。</span>
          </div>
        ))}
      <details className="connect-manual" open={!service.browserLogin}>
        <summary>
          {service.browserLogin ? "也可以手动填写" : "填写"}
          {/^[A-Za-z]/.test(m.label) ? ` ${m.label}` : m.label}
        </summary>
        <ol>
          {m.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        {m.link && (
          <a className="btn sm ghost" href={service.originEditable ? m.link.replace(service.origin, origin.replace(/\/+$/, "")) : m.link} target="_blank" rel="noreferrer">
            <ExternalLink size={13} />
            打开 {host(service.originEditable ? origin : m.link)}
          </a>
        )}
        <div className="connect-row">
          <input
            className="field mono"
            type="password"
            autoComplete="off"
            placeholder={m.placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && value.trim() && !busy && manual()}
          />
          <button type="button" className="btn" onClick={manual} disabled={!value.trim() || !!busy}>
            {busy === "manual" ? <span className="spinner" /> : null}
            连接
          </button>
        </div>
      </details>
      {error && <p className="connect-error">{error}</p>}
    </div>
  );
}

/** For a plugin that reads with an account: which one, or connect one here. */
export function AccountPicker({ service, value, onChange }: { service: string; value: number | null; onChange: (id: number | null) => void }) {
  const q = useAccounts();
  const def = q.data?.services.find((s) => s.id === service);
  const mine = (q.data?.accounts || []).filter((a) => a.service === service);
  const [reconnect, setReconnect] = useState(false);
  const chosen = mine.find((a) => a.id === value) || null;
  // the account in use: the one chosen, else the first connected one
  const first = mine[0]?.id ?? null;
  useEffect(() => {
    if (!chosen && first !== null) onChange(first);
  }, [chosen, first, onChange]);
  if (!def) return null;
  if (!mine.length) {
    return (
      <div className="account-pick">
        <div className="callout plain">要先连接{def.name}账号，松果才能读到你看得到的内容。登录信息只存在运行松果的电脑上。</div>
        <ConnectAccount service={def} onDone={(a) => onChange(a.id)} />
      </div>
    );
  }
  const current = chosen || mine[0];
  return (
    <div className="account-pick">
      <div className="form-row">
        <label className="lbl">账号</label>
        <div className="connect-row">
          {mine.length > 1 ? (
            <select className="field" value={chosen?.id ?? ""} onChange={(e) => onChange(Number(e.target.value))}>
              {mine.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {host(a.origin)}
                </option>
              ))}
            </select>
          ) : (
            <span className="account-name">
              {current.name}
              <span className="muted"> · {host(current.origin)}</span>
            </span>
          )}
          {current.status !== "ok" && (
            <button type="button" className="btn sm primary" onClick={() => setReconnect((r) => !r)}>
              重新登录
            </button>
          )}
        </div>
        {current.status !== "ok" && <p className="connect-error">{current.error || "登录已过期"}</p>}
      </div>
      {reconnect && <ConnectAccount service={def} origin={current.origin} onDone={() => setReconnect(false)} />}
    </div>
  );
}
