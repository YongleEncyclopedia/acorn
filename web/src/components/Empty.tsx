import type { ReactNode } from "react";

const ART: Record<string, ReactNode> = {
  acorn: (
    <svg width="88" height="88" viewBox="0 0 88 88" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M44 20c-.6-5 1.4-8.6 5.6-11" />
      <path d="M20 40c0-13 10.6-21 24-21s24 8 24 21z" />
      <path d="M26 36l14-13M34 39l18-16M46 40l14-13M27 27l20 12M40 21l20 14" opacity=".45" />
      <rect x="17" y="38" width="54" height="7" rx="3.5" />
      <path d="M23.5 45c0 17 9.3 28 20.5 31.6C55.2 73 64.5 62 64.5 45" />
      <path d="M33 52c.8 8 4 14 8.5 18" opacity=".45" />
    </svg>
  ),
  inbox: (
    <svg width="88" height="88" viewBox="0 0 88 88" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 50l8-26a5 5 0 0 1 4.8-3.6h30.4a5 5 0 0 1 4.8 3.6l8 26v14a5 5 0 0 1-5 5H21a5 5 0 0 1-5-5z" />
      <path d="M16 50h17l3 7h16l3-7h17" />
      <path d="M36 34h16M33 41h22" opacity=".45" />
    </svg>
  ),
  notes: (
    <svg width="88" height="88" viewBox="0 0 88 88" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="20" y="14" width="44" height="60" rx="5" />
      <path d="M29 28h26M29 37h26M29 46h16" opacity=".45" />
      <path d="M50 62l14-14 6 6-14 14h-6z" />
    </svg>
  ),
  search: (
    <svg width="88" height="88" viewBox="0 0 88 88" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <circle cx="39" cy="39" r="19" />
      <path d="M53 53l16 16" />
      <path d="M31 36h16M31 43h10" opacity=".45" />
    </svg>
  ),
  vault: (
    <svg width="88" height="88" viewBox="0 0 88 88" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="14" y="20" width="60" height="50" rx="6" />
      <path d="M14 32h60" />
      <rect x="35" y="44" width="18" height="18" rx="3" transform="rotate(-7 44 53)" opacity=".7" />
      <path d="M40.5 50.5h7M44 47v12" opacity=".7" transform="rotate(-7 44 53)" />
    </svg>
  ),
};

export function Empty({ art = "acorn", title, children, action }: { art?: keyof typeof ART | string; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="art">{ART[art] || ART.acorn}</div>
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}
