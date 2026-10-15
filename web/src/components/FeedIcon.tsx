import { useState } from "react";
import type { Feed } from "../../../src/shared/types.ts";

function hue(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)!) % 360;
  return h;
}

export function FeedIcon({ feed, large }: { feed?: Pick<Feed, "id" | "title" | "hasIcon"> | null; large?: boolean }) {
  const [broken, setBroken] = useState(false);
  const title = feed?.title || "?";
  if (feed && feed.hasIcon && !broken) {
    return <img className={`feed-icon ${large ? "lg" : ""}`} src={`/api/icons/${feed.id}`} alt="" loading="lazy" onError={() => setBroken(true)} />;
  }
  const letter = [...title.replace(/^[\s\p{P}]+/u, "")][0] || "?";
  return (
    <span className={`feed-icon letter ${large ? "lg" : ""}`} style={{ background: `hsl(${hue(title)} 32% 52%)` }} aria-hidden="true">
      {letter.toUpperCase()}
    </span>
  );
}
