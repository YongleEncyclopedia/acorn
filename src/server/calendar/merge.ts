/**
 * The class calendar out of everyone's: course items only (a link also holds its owner's personal events, which
 * are not the class's business), the same item counted once with how many classmates have it, and never a name.
 * An item fewer than `minCount` classmates have shows only its kind and the count, not its course or title.
 */
import type { ClassEvent } from "../../shared/types.ts";
import type { IcsEvent } from "./ics.ts";

const KINDS: [ClassEvent["kind"], RegExp, string][] = [
  ["exam", /\bexams?\b|midterm|final exam|\bfinal\b|考试|期中|期末/i, "考试"],
  ["quiz", /\bquiz(zes)?\b|小测|测验|随堂/i, "小测"],
  ["lab", /\blabs?\b|lab\s*\d|experiment|实验/i, "实验"],
  ["presentation", /presentation|答辩|展示|汇报|\bpre\b/i, "展示"],
];
export const KIND_LABEL: Record<ClassEvent["kind"], string> = { exam: "考试", quiz: "小测", lab: "实验", presentation: "展示", assignment: "作业", event: "日程" };
const IMPORTANT = new Set<ClassEvent["kind"]>(["exam", "quiz", "lab", "presentation"]);

/** Canvas writes the course after the title: "Quiz 3 [ME2110J]". Items without one are personal. */
export function courseOf(summary: string): { title: string; course: string } | null {
  const m = summary.match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
  return m ? { title: m[1].trim(), course: m[2].trim() } : null;
}

export function kindOf(uid: string, title: string): ClassEvent["kind"] {
  for (const [kind, re] of KINDS) if (re.test(title)) return kind;
  // items from the owner's Canvas say what they are in their uid (canvas-quiz-…, canvas-exam-…)
  const said = uid.match(/^canvas-(exam|quiz|lab|presentation|assignment)-/)?.[1] as ClassEvent["kind"] | undefined;
  if (said) return said;
  return /assignment/i.test(uid) ? "assignment" : "event";
}

// a due date is a moment; on a calendar it shows as the half hour before it
const DUE_BLOCK = 30 * 60_000;

export function mergeEvents(events: (IcsEvent & { memberId: number })[], opts: { minCount: number; include: "important" | "all"; from: number; to: number; own?: Set<number> }): ClassEvent[] {
  const own = opts.own || new Set<number>();
  const byUid = new Map<string, { e: IcsEvent; course: { title: string; course: string }; members: Set<number> }>();
  for (const e of events) {
    const course = courseOf(e.summary);
    if (!course || e.end < opts.from || e.start > opts.to) continue;
    const hit = byUid.get(e.uid);
    if (hit) hit.members.add(e.memberId);
    else byUid.set(e.uid, { e, course, members: new Set([e.memberId]) });
  }
  const out: ClassEvent[] = [];
  for (const [uid, { e, course, members }] of byUid) {
    const kind = kindOf(uid, course.title);
    if (opts.include === "important" && !IMPORTANT.has(kind)) continue;
    const count = members.size;
    // the owner's own items are theirs to name; a classmate's only once enough others have the same
    const mine = [...members].some((id) => own.has(id));
    const named = mine || count >= opts.minCount;
    const others = [...members].filter((id) => !own.has(id)).length;
    const point = !e.allDay && e.end === e.start;
    const people = others ? `（${count} 人）` : "";
    out.push({
      key: uid,
      kind,
      title: named ? `${KIND_LABEL[kind]}｜${course.title} [${course.course}]${people}` : `${KIND_LABEL[kind]}${people || `（${count} 人）`}`,
      course: named ? course.course : null,
      count,
      mine,
      start: point ? e.start - DUE_BLOCK : e.start,
      end: e.end,
      allDay: e.allDay,
      due: point,
    });
  }
  return out.sort((a, b) => a.start - b.start || a.key.localeCompare(b.key));
}
