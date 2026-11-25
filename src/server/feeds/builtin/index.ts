/** Plugins that come with Acorn, for the platforms it signs in to (设置 → 账号). They list before the user's own. */
import type { AcornPlugin } from "../plugin-api.ts";
import { zsxq } from "./zsxq.ts";
import { canvas } from "./canvas.ts";
import { jwb } from "./jwb.ts";

export const BUILTIN: AcornPlugin[] = [zsxq, canvas, jwb];
