/**
 * 设置 → 账号: the sign-ins already connected (知识星球, Canvas…), checked, renewed when a platform stops accepting
 * them, and removed. They are connected where they are needed, in 添加订阅 → 插件: the platforms are not listed here.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.ts";
import { relTime } from "../lib/format.ts";
import { toast, toastError } from "../lib/store.ts";
import { ConnectAccount, useAccounts } from "../components/ConnectAccount.tsx";
import type { Account } from "../../../src/shared/types.ts";

const host = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

export function AccountsSettings() {
  const qc = useQueryClient();
  const q = useAccounts();
  const [open, setOpen] = useState<{ service: string; origin?: string } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const services = q.data?.services || [];
  const accounts = q.data?.accounts || [];
  const name = (id: string) => services.find((s) => s.id === id)?.name || id;
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["accounts"] });
    qc.invalidateQueries({ queryKey: ["bootstrap"] });
  };

  const check = async (a: Account) => {
    setBusy(a.id);
    try {
      const r = await api.checkAccount(a.id);
      toast(r.account.status === "ok" ? `${name(a.service)}的登录还有效` : `${name(a.service)}的登录已过期，请重新登录`, r.account.status === "ok" ? undefined : { kind: "error" });
      refresh();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };
  const remove = async (a: Account) => {
    const using = a.feeds ? `，用它的 ${a.feeds} 个订阅源会停止更新` : "";
    if (!window.confirm(`删除${name(a.service)}账号「${a.name}」${using}？`)) return;
    try {
      await api.deleteAccount(a.id);
      refresh();
    } catch (e) {
      toastError(e);
    }
  };
  const form = (service: string, origin?: string) => {
    const def = services.find((s) => s.id === service);
    return def ? (
      <div className="setting-row stack">
        <ConnectAccount service={def} origin={origin} onDone={() => setOpen(null)} />
      </div>
    ) : null;
  };

  return (
    <section className="settings-section" id="accounts">
      <h2>账号</h2>
      <div className="settings-card">
        {!accounts.length && (
          <div className="setting-row">
            <div className="txt">
              <b>还没有连接账号</b>
              <span>订阅要登录才能看的内容时，在「添加订阅」里连接。登录信息只存在这台电脑上。</span>
            </div>
          </div>
        )}
        {accounts.map((a) => (
          <div key={a.id}>
            <div className="setting-row">
              <div className="txt">
                <b>
                  {name(a.service)} · {a.name}
                  {a.status !== "ok" && <span className="badge red account-badge">登录已过期</span>}
                </b>
                <span>
                  {host(a.origin)} · {a.feeds ? `${a.feeds} 个订阅源在用` : "还没有订阅源用它"}
                  {a.checkedAt ? ` · ${relTime(a.checkedAt)}确认过` : ""}
                </span>
              </div>
              <div className="row-controls">
                {a.status === "ok" ? (
                  <button type="button" className="btn sm ghost" disabled={busy === a.id} onClick={() => check(a)}>
                    {busy === a.id ? <span className="spinner" /> : null}
                    检查
                  </button>
                ) : (
                  <button type="button" className="btn sm primary" onClick={() => setOpen({ service: a.service, origin: a.origin })}>
                    重新登录
                  </button>
                )}
                <button type="button" className="btn sm ghost danger" onClick={() => remove(a)}>
                  删除
                </button>
              </div>
            </div>
            {open && open.service === a.service && open.origin === a.origin && form(a.service, a.origin)}
          </div>
        ))}
      </div>
    </section>
  );
}
