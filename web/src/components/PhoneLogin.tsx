import { useEffect, useMemo, useState } from "react";
import qrcode from "qrcode-generator";
import { Copy, RotateCw } from "lucide-react";
import { Dialog } from "./Dialog.tsx";
import { api } from "../lib/api.ts";
import { toast, toastError } from "../lib/store.ts";

/** Square modules of a QR code as one SVG path (dark modules only). */
function qrPath(text: string): { size: number; d: string } {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
  return { size: n, d };
}

/** Sign in on a phone: a one-time link shown as a QR code, for each address the phone might reach. */
export function PhoneLogin({ onClose }: { onClose: () => void }) {
  const [link, setLink] = useState<{ path: string; expiresAt: number; origins: { label: string; origin: string }[] } | null>(null);
  const [pick, setPick] = useState(0);
  const [now, setNow] = useState(Date.now());
  const make = () =>
    api
      .loginLink()
      .then((l) => {
        setLink(l);
        setPick(0);
      })
      .catch(toastError);
  useEffect(() => {
    void make();
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const origin = link?.origins[pick];
  const url = origin && link ? `${origin.origin}${link.path}` : "";
  const qr = useMemo(() => (url ? qrPath(url) : null), [url]);
  const left = link ? Math.max(0, Math.round((link.expiresAt - now) / 1000)) : 0;
  const expired = !!link && left === 0;
  return (
    <Dialog title="在手机上登录" onClose={onClose} size="sm">
      <div className="phone-login">
        <div className={`qr ${expired ? "expired" : ""}`}>
          {qr ? (
            <svg viewBox={`-3 -3 ${qr.size + 6} ${qr.size + 6}`} shapeRendering="crispEdges" role="img" aria-label="登录二维码">
              <rect x="-3" y="-3" width={qr.size + 6} height={qr.size + 6} fill="#fff" />
              <path d={qr.d} fill="#1d1a16" />
            </svg>
          ) : (
            <span className="spinner" />
          )}
          {expired && (
            <button className="btn" onClick={make}>
              <RotateCw size={15} />
              重新生成
            </button>
          )}
        </div>
        {link && link.origins.length > 1 && (
          <div className="segmented" role="group" style={{ alignSelf: "center" }}>
            {link.origins.map((o, i) => (
              <button key={o.origin} type="button" aria-pressed={i === pick} onClick={() => setPick(i)}>
                {o.label}
              </button>
            ))}
          </div>
        )}
        <p className="lede">
          用手机相机扫一扫，直接进入松果，不用输密码。
          <br />
          {expired ? "二维码已过期。" : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} 内有效，只能用一次。`}
        </p>
        {origin && <code className="addr">{origin.origin}</code>}
        <p className="hint">
          {origin?.label === "Tailscale" ? "手机上也要打开 Tailscale。" : origin?.label === "局域网" ? "手机要和这台电脑连着同一个 Wi-Fi。在外面用，推荐装 Tailscale。" : "如果手机打不开，换一个地址试试。"}
          扫开后在浏览器菜单里选「添加到主屏幕」，松果就是一个 App。
        </p>
        <button
          className="btn ghost sm"
          style={{ alignSelf: "center" }}
          disabled={!url || expired}
          onClick={() => navigator.clipboard?.writeText(url).then(() => toast("登录链接已复制，10 分钟内有效"))}
        >
          <Copy size={14} />
          复制登录链接
        </button>
      </div>
    </Dialog>
  );
}
