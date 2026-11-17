import type { ReactNode } from "react";
import { Archive, BookOpenCheck, Highlighter, SearchX } from "lucide-react";
import { Glyph } from "./Logo.tsx";

/** One large, quiet symbol per kind of emptiness, the way Apple's apps say "nothing here yet". */
const ART: Record<string, ReactNode> = {
  acorn: <Glyph size={60} />,
  inbox: <BookOpenCheck size={52} strokeWidth={1.3} />,
  notes: <Highlighter size={52} strokeWidth={1.3} />,
  search: <SearchX size={52} strokeWidth={1.3} />,
  vault: <Archive size={52} strokeWidth={1.3} />,
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
