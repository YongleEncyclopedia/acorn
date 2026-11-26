/**
 * One reasoning setting, every service's own parameters. A plan from planReasoning (src/shared/ai.ts) becomes
 * request-body fields: DeepSeek's `thinking` switch with `reasoning_effort`, Qwen's `enable_thinking` and
 * `thinking_budget`, OpenRouter's `reasoning` object, Ollama's `think`, Claude's `thinking` and `output_config`.
 * Services not listed get the standard top-level `reasoning_effort`, as Hermes Agent sends to custom endpoints.
 */
import type { ReasoningSpec, TranslateSettings } from "../../shared/types.ts";
import type { Effort, ReasoningPlan } from "../../shared/ai.ts";

export type Body = Record<string, unknown>;

interface Wire {
  /** switch reasoning on or off (models with a switch of their own) */
  toggle?: (on: boolean, spec: ReasoningSpec | null) => Body;
  /** a level; "none" where a level is how reasoning is switched off */
  effort?: (level: Effort, spec: ReasoningSpec | null) => Body;
  /** a token budget */
  budget?: (tokens: number) => Body;
}

const thinkingSwitch = (on: boolean): Body => ({ thinking: { type: on ? "enabled" : "disabled" } });

/** `thinking.type` switches reasoning, `reasoning_effort` only applies while it is on (DeepSeek, GLM, Doubao). */
const switchAndEffort: Wire = {
  toggle: thinkingSwitch,
  effort: (level) => (level === "none" ? thinkingSwitch(false) : { ...thinkingSwitch(true), reasoning_effort: level }),
};

/** Alibaba's models switch with `enable_thinking` and cap it with `thinking_budget`; SiliconFlow serves them the same way. */
const enableThinking: Wire = {
  toggle: (on) => ({ enable_thinking: on }),
  effort: (level) => (level === "none" ? { enable_thinking: false } : { enable_thinking: true, reasoning_effort: level }),
  budget: (tokens) => ({ enable_thinking: true, thinking_budget: tokens }),
};

const WIRES: Record<string, Wire> = {
  deepseek: switchAndEffort,
  zhipu: switchAndEffort,
  volcengine: switchAndEffort,
  // Kimi K3 always reasons and takes no `thinking` field; the K2 models have the switch
  moonshot: { toggle: thinkingSwitch, effort: (level) => ({ reasoning_effort: level }) },
  qwen: enableThinking,
  siliconflow: enableThinking,
  // one object for every model behind it; `exclude` keeps the reasoning text out of the reply
  openrouter: {
    toggle: (on) => ({ reasoning: on ? { enabled: true, exclude: true } : { enabled: false } }),
    effort: (level) => ({ reasoning: { effort: level, exclude: true } }),
    budget: (tokens) => ({ reasoning: { max_tokens: tokens, exclude: true } }),
  },
  ollama: { toggle: (on) => ({ think: on }), effort: (level) => ({ think: level }) },
  generic: { effort: (level) => ({ reasoning_effort: level }) },
};

/** Claude: thinking is adaptive on current models, steered by effort; older models take a fixed budget. */
function claudeWire(model: string): Wire {
  return {
    toggle: (on, spec) =>
      on
        ? spec?.budget
          ? { thinking: { type: "enabled", budget_tokens: 4096 } }
          : { thinking: { type: "adaptive" } }
        : // Sonnet 5.5 rejects "disabled" and switches thinking off with "between_tools" instead
          { thinking: { type: /^claude-sonnet-5-5/.test(model) ? "between_tools" : "disabled" } },
    // budget-style models with effort (Opus 4.5) take the level without adaptive thinking
    effort: (level, spec) => ({ ...(spec?.budget ? {} : { thinking: { type: "adaptive" } }), output_config: { effort: level } }),
    budget: (tokens) => ({ thinking: { type: "enabled", budget_tokens: tokens } }),
  };
}

export function wireFor(cfg: Pick<TranslateSettings, "provider" | "preset" | "model">): Wire {
  if (cfg.provider === "anthropic") return claudeWire(cfg.model);
  if (cfg.provider === "ollama") return WIRES.ollama;
  return WIRES[cfg.preset] ?? WIRES.generic;
}

/** The request-body fields that carry the plan to this service. */
export function reasoningBody(plan: ReasoningPlan, spec: ReasoningSpec | false | null, wire: Wire): Body {
  const s = spec || null;
  switch (plan.send) {
    case "nothing":
      return {};
    case "off":
      // a model without a switch is switched off with the level "none"
      if (s?.toggle !== false && wire.toggle) return wire.toggle(false, s);
      return wire.effort ? wire.effort("none", s) : {};
    case "on":
      return wire.toggle ? wire.toggle(true, s) : wire.effort ? wire.effort("medium", s) : {};
    case "effort":
      return wire.effort ? wire.effort(plan.level, s) : wire.toggle ? wire.toggle(true, s) : {};
    case "budget":
      return wire.budget ? wire.budget(plan.tokens) : wire.toggle ? wire.toggle(true, s) : {};
  }
}
