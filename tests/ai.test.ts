/**
 * The AI service rules: which reasoning choices a model gets, what each service is sent for them, context windows,
 * presets for old settings, and the models.dev catalog lookups. No network: the flow tests in translate.test.ts
 * run the same rules against fake servers.
 */
import { describe, expect, it } from "vitest";
import type { ReasoningChoice, ReasoningSpec, TranslateProvider } from "../src/shared/types.ts";
import { contextFor, describePlan, formatPrice, formatTokens, keyTarget, parseTokens, planReasoning, presetFor, reasoningChoices } from "../src/shared/ai.ts";
import { reasoningBody, wireFor } from "../src/server/translate/wire.ts";
import { anthropicSpec, ollamaSpec, openRouterSpec } from "../src/server/translate/models.ts";
import { catalogEntry, enrich, providerForUrl, specFromEntry, trimCatalog } from "../src/server/translate/catalog.ts";
import { DEFAULT_SETTINGS, normalizeTranslate } from "../src/server/store/settings.ts";

// How real models describe themselves
const DEEPSEEK: ReasoningSpec = { toggle: true, efforts: ["low", "high", "max"], budget: null }; // thinking switch + levels
const KIMI_K3: ReasoningSpec = { toggle: false, efforts: ["low", "high", "max"], budget: null }; // always reasons
const QWEN3_LOCAL: ReasoningSpec = { toggle: true, efforts: [], budget: null }; // on or off
const QWEN_CLOUD: ReasoningSpec = { toggle: true, efforts: [], budget: { min: 1, max: 38_912 } }; // switch + budget
const GPT: ReasoningSpec = { toggle: false, efforts: ["none", "low", "medium", "high", "xhigh"], budget: null }; // off is a level
const GPT_OSS: ReasoningSpec = { toggle: false, efforts: ["low", "medium", "high"], budget: null };
const CLAUDE: ReasoningSpec = { toggle: true, efforts: ["low", "medium", "high", "max"], budget: null };
const CLAUDE_ALWAYS: ReasoningSpec = { toggle: false, efforts: ["low", "medium", "high", "xhigh", "max"], budget: null };
const CLAUDE_OLD: ReasoningSpec = { toggle: true, efforts: [], budget: { min: 1024 } };

const sent = (preset: string, spec: ReasoningSpec | false | null, choice: ReasoningChoice = "auto", model = "m", provider: TranslateProvider = "openai") =>
  reasoningBody(planReasoning(choice, spec, provider), spec, wireFor({ provider, preset, model }));

describe("reasoning choices", () => {
  it("offers what each model accepts, and nothing it would reject", () => {
    expect(reasoningChoices(DEEPSEEK)).toEqual(["auto", "off", "low", "high", "max"]);
    expect(reasoningChoices(KIMI_K3)).toEqual(["auto", "low", "high", "max"]);
    expect(reasoningChoices(QWEN3_LOCAL)).toEqual(["auto", "off", "on"]);
    expect(reasoningChoices(QWEN_CLOUD)).toEqual(["auto", "off", "low", "medium", "high"]);
    expect(reasoningChoices(GPT)).toEqual(["auto", "off", "low", "medium", "high", "xhigh"]);
    expect(reasoningChoices(false)).toEqual([]);
    // nobody says: the common levels, sent only when picked
    expect(reasoningChoices(null)).toEqual(["auto", "off", "low", "medium", "high"]);
  });

  it("switches reasoning off by default where it can, and keeps it lowest where it cannot", () => {
    expect(planReasoning("auto", DEEPSEEK)).toEqual({ send: "off" });
    expect(planReasoning("auto", GPT)).toEqual({ send: "off" });
    expect(planReasoning("auto", KIMI_K3)).toEqual({ send: "effort", level: "low" });
    expect(planReasoning("auto", CLAUDE_OLD)).toEqual({ send: "off" });
    expect(planReasoning("auto", null)).toEqual({ send: "nothing" });
    // a local Ollama is asked not to think even when nobody says whether the model can
    expect(planReasoning("auto", null, "ollama")).toEqual({ send: "off" });
    expect(describePlan("auto", null, "ollama")).toMatch(/关掉推理/);
    expect(planReasoning("high", false)).toEqual({ send: "nothing" });
    // a level the model lacks becomes the nearest one it has, the cheaper of two
    expect(planReasoning("medium", DEEPSEEK)).toEqual({ send: "effort", level: "low" });
    expect(planReasoning("xhigh", DEEPSEEK)).toEqual({ send: "effort", level: "high" });
    expect(planReasoning("high", QWEN_CLOUD)).toEqual({ send: "budget", tokens: 16_384 });
    expect(planReasoning("on", QWEN3_LOCAL)).toEqual({ send: "on" });
    expect(describePlan("auto", KIMI_K3)).toMatch(/不能关闭推理.*「低」/);
    expect(describePlan("auto", DEEPSEEK)).toMatch(/关掉推理/);
  });

  it("speaks each service's own parameters", () => {
    // DeepSeek, GLM and Doubao: a `thinking` switch, and a level while it is on
    expect(sent("deepseek", DEEPSEEK)).toEqual({ thinking: { type: "disabled" } });
    expect(sent("deepseek", DEEPSEEK, "max")).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "max" });
    expect(sent("zhipu", DEEPSEEK)).toEqual({ thinking: { type: "disabled" } });
    expect(sent("volcengine", DEEPSEEK, "low")).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "low" });
    // Kimi K3 has no switch: the lowest level, and no `thinking` field it does not know
    expect(sent("moonshot", KIMI_K3)).toEqual({ reasoning_effort: "low" });
    expect(sent("moonshot", QWEN3_LOCAL)).toEqual({ thinking: { type: "disabled" } });
    // Qwen and SiliconFlow
    expect(sent("qwen", QWEN_CLOUD)).toEqual({ enable_thinking: false });
    expect(sent("siliconflow", QWEN_CLOUD, "low")).toEqual({ enable_thinking: true, thinking_budget: 1024 });
    // OpenRouter: one `reasoning` object, the reasoning text left out of the reply
    expect(sent("openrouter", GPT)).toEqual({ reasoning: { effort: "none", exclude: true } });
    expect(sent("openrouter", KIMI_K3, "high")).toEqual({ reasoning: { effort: "high", exclude: true } });
    expect(sent("openrouter", QWEN3_LOCAL)).toEqual({ reasoning: { enabled: false } });
    expect(sent("openrouter", QWEN3_LOCAL, "on")).toEqual({ reasoning: { enabled: true, exclude: true } });
    // OpenAI, Gemini and any other endpoint: the standard `reasoning_effort`
    expect(sent("openai", GPT)).toEqual({ reasoning_effort: "none" });
    expect(sent("custom", GPT_OSS)).toEqual({ reasoning_effort: "low" });
    expect(sent("custom", null)).toEqual({});
    expect(sent("custom", null, "low")).toEqual({ reasoning_effort: "low" });
    expect(sent("custom", false, "high")).toEqual({});
    // Ollama's `think`: a switch for most models, levels for gpt-oss
    expect(sent("ollama", QWEN3_LOCAL, "auto", "qwen3:8b", "ollama")).toEqual({ think: false });
    expect(sent("ollama", GPT_OSS, "auto", "gpt-oss:20b", "ollama")).toEqual({ think: "low" });
    expect(sent("ollama", null, "auto", "llama3", "ollama")).toEqual({ think: false });
  });

  it("steers Claude with adaptive thinking and effort", () => {
    expect(sent("anthropic", CLAUDE, "auto", "claude-haiku-5-5", "anthropic")).toEqual({ thinking: { type: "disabled" } });
    expect(sent("anthropic", CLAUDE, "high", "claude-haiku-5-5", "anthropic")).toEqual({ thinking: { type: "adaptive" }, output_config: { effort: "high" } });
    // Sonnet 5.5 turns thinking off with "between_tools"; Opus 5.5 and Fable always think
    expect(sent("anthropic", CLAUDE, "off", "claude-sonnet-5-5", "anthropic")).toEqual({ thinking: { type: "between_tools" } });
    expect(sent("anthropic", CLAUDE_ALWAYS, "auto", "claude-opus-5-5", "anthropic")).toEqual({ thinking: { type: "adaptive" }, output_config: { effort: "low" } });
    // models from before adaptive thinking take a budget
    expect(sent("anthropic", CLAUDE_OLD, "medium", "claude-haiku-4-5", "anthropic")).toEqual({ thinking: { type: "enabled", budget_tokens: 4096 } });
  });
});

describe("what services report about their models", () => {
  it("reads Ollama's thinking values and capabilities", () => {
    expect(ollamaSpec({ thinking: { values: [true, false] } })).toEqual(QWEN3_LOCAL);
    expect(ollamaSpec({ thinking: { values: ["low", "medium", "high"] } })).toEqual(GPT_OSS);
    expect(ollamaSpec({ capabilities: ["completion", "thinking"] })).toEqual(QWEN3_LOCAL);
    expect(ollamaSpec({ capabilities: ["completion"] })).toBe(false);
    expect(ollamaSpec(null)).toBeNull();
  });

  it("reads OpenRouter's reasoning metadata", () => {
    const params = ["include_reasoning", "reasoning", "reasoning_effort", "temperature"];
    expect(openRouterSpec({ id: "moonshotai/kimi-k3", supported_parameters: params, reasoning: { mandatory: false, supported_efforts: ["max", "high", "low", "none"] } })).toEqual({ toggle: false, efforts: ["none", "low", "high", "max"], budget: null });
    expect(openRouterSpec({ id: "x/always", supported_parameters: params, reasoning: { mandatory: true, supported_efforts: ["high", "low", "none"] } })).toEqual({ toggle: false, efforts: ["low", "high"], budget: null });
    expect(openRouterSpec({ id: "x/switch", supported_parameters: params, reasoning: { mandatory: false, supports_max_tokens: true } })).toEqual({ toggle: true, efforts: [], budget: {} });
    expect(openRouterSpec({ id: "x/plain", supported_parameters: ["temperature"] })).toBe(false);
    expect(openRouterSpec({ id: "x/unknown" })).toBeNull();
  });

  it("reads Claude's capabilities from the Models API", () => {
    const thinking = (adaptive: boolean, enabled: boolean) => ({ supported: true, types: { adaptive: { supported: adaptive }, enabled: { supported: enabled } } });
    const effort = { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: false }, max: { supported: true } };
    expect(anthropicSpec({ id: "claude-haiku-5-5", capabilities: { thinking: thinking(true, false), effort } })).toEqual(CLAUDE);
    expect(anthropicSpec({ id: "claude-fable-5-1", capabilities: { thinking: thinking(true, false), effort } })).toMatchObject({ toggle: false });
    expect(anthropicSpec({ id: "claude-haiku-4-5", capabilities: { thinking: thinking(false, true) } })).toEqual(CLAUDE_OLD);
    expect(anthropicSpec({ id: "claude-old", capabilities: { thinking: { supported: false } } })).toBe(false);
    expect(anthropicSpec({ id: "claude-x" })).toBeNull();
  });
});

describe("context windows", () => {
  it("plans for the pinned size, else what the model reports, else 128K", () => {
    expect(contextFor({ contextLength: 32_768, provider: "openai" }, { id: "m", reasoning: null, context: 131_072 })).toEqual({ tokens: 32_768, source: "pinned", max: 131_072 });
    expect(contextFor({ contextLength: 0, provider: "openai" }, { id: "m", reasoning: null, context: 1_048_576, source: "catalog" })).toEqual({ tokens: 1_048_576, source: "catalog", max: 1_048_576 });
    expect(contextFor({ contextLength: 0, provider: "openai" }, null)).toEqual({ tokens: 128_000, source: "default" });
    // a local model runs with 8K unless told otherwise, or less when that is all it has
    expect(contextFor({ contextLength: 0, provider: "ollama" }, { id: "qwen3:8b", reasoning: null, context: 40_960 })).toMatchObject({ tokens: 8192, max: 40_960 });
    expect(contextFor({ contextLength: 0, provider: "ollama" }, { id: "tiny", reasoning: null, context: 4096 })).toMatchObject({ tokens: 4096 });
  });

  it("reads and writes sizes the way people write them", () => {
    expect(["32768", "32k", "32 K", "128K", "1m", "1.5M", "200,000"].map(parseTokens)).toEqual([32_768, 32_768, 32_768, 131_072, 1_048_576, 1_572_864, 200_000]);
    expect(["", "abc", "-5", "12x"].map(parseTokens)).toEqual([0, 0, 0, 0]);
    expect([8192, 131_072, 128_000, 256_000, 200_000, 1_048_576, 1_000_000, 1_050_000, 40_960, 512].map(formatTokens)).toEqual(["8K", "128K", "128K", "256K", "200K", "1M", "1M", "1.05M", "40K", "512"]);
    expect(formatPrice({ input: 0.15, output: 0.6 })).toBe("$0.15 / $0.60");
    expect(formatPrice({ input: 0.028, output: 0.042 })).toBe("$0.028 / $0.042");
    expect(formatPrice({ input: 0, output: 0 })).toBe("免费");
  });
});

describe("presets", () => {
  it("finds the service an address belongs to, for settings saved before presets", () => {
    const id = (provider: TranslateProvider, url: string) => presetFor(provider, url).id;
    expect(id("openai", "https://api.deepseek.com")).toBe("deepseek");
    expect(id("openai", "https://api.deepseek.com/v1/")).toBe("deepseek");
    expect(id("openai", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1")).toBe("qwen");
    expect(id("openai", "https://openrouter.ai/api/v1")).toBe("openrouter");
    expect(id("openai", "http://127.0.0.1:1234/v1")).toBe("lmstudio");
    expect(id("openai", "http://localhost:8000/v1")).toBe("custom");
    expect(id("openai", "")).toBe("openai");
    expect(id("anthropic", "")).toBe("anthropic");
    expect(id("ollama", "http://gpu-box:11434")).toBe("ollama");
  });

  it("makes old and odd settings whole", () => {
    const t = (patch: Record<string, unknown>) => normalizeTranslate({ ...DEFAULT_SETTINGS.translate, ...patch });
    expect(t({ provider: "openai", preset: "", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" })).toMatchObject({ preset: "deepseek", reasoning: "auto", contextLength: 0, extraBody: "" });
    // a preset of another protocol is worked out again
    expect(t({ provider: "anthropic", preset: "deepseek" }).preset).toBe("anthropic");
    expect(t({ reasoning: "turbo", contextLength: -5, extraBody: '  {"top_p": 0.9}\n' })).toMatchObject({ reasoning: "auto", contextLength: 0, extraBody: '{"top_p": 0.9}' });
    expect(t({ contextLength: 32_768.4 }).contextLength).toBe(32_768);
  });

  it("ties a saved key to the service and address it was entered for", () => {
    const at = (preset: string, baseUrl: string, provider: TranslateProvider = "openai") => keyTarget({ provider, preset, baseUrl });
    expect(at("deepseek", "")).toBe(at("deepseek", "https://api.deepseek.com/"));
    expect(at("custom", "https://relay.example/v1")).toBe(at("custom", "https://RELAY.example/v1/"));
    expect(at("custom", "https://relay.example/v1")).not.toBe(at("custom", "https://elsewhere.example/v1"));
    expect(at("openai", "")).not.toBe(at("deepseek", ""));
  });
});

// models.dev's format, as downloaded
const RAW = {
  deepseek: {
    api: "https://api.deepseek.com",
    models: {
      "deepseek-flash": { id: "deepseek-flash", name: "DeepSeek V4.1 Flash", reasoning: true, reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["max", "low", "high"] }], temperature: true, limit: { context: 1_048_576, output: 393_216 }, cost: { input: 0.15, output: 0.6 }, release_date: "2026-10-17" },
      "deepseek-chat": { id: "deepseek-chat", status: "deprecated", reasoning: false },
    },
  },
  alibaba: {
    api: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    models: { "qwen-plus": { id: "qwen-plus", reasoning: true, reasoning_options: [{ type: "toggle" }, { type: "budget_tokens", min: 0, max: 38_912 }], limit: { context: 1_000_000, output: 32_768 } } },
  },
  openai: { models: { "gpt-6-luna": { id: "gpt-6-luna", reasoning: true, reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }], temperature: false, limit: { context: 1_050_000 } } } },
};

describe("the models.dev catalog", () => {
  const cat = trimCatalog(RAW);

  it("keeps what Acorn reads and drops deprecated models", () => {
    expect(Object.keys(cat.deepseek.models)).toEqual(["deepseek-flash"]);
    expect(cat.deepseek.models["deepseek-flash"]).toMatchObject({ context: 1_048_576, output: 393_216, temperature: true, cost: { input: 0.15, output: 0.6 }, released: "2026-10-17" });
  });

  it("turns reasoning options into Acorn's terms", () => {
    expect(specFromEntry(cat.deepseek.models["deepseek-flash"])).toEqual(DEEPSEEK);
    expect(specFromEntry(cat.alibaba.models["qwen-plus"])).toEqual({ toggle: true, efforts: [], budget: { min: undefined, max: 38_912 } });
    expect(specFromEntry(cat.openai.models["gpt-6-luna"])).toEqual(GPT);
    expect(specFromEntry({ reasoning: false })).toBe(false);
    expect(specFromEntry({})).toBeNull();
  });

  it("finds a model under a relay's prefix or suffix, and the service behind an address", () => {
    const flash = cat.deepseek.models["deepseek-flash"];
    expect(catalogEntry(cat, ["deepseek"], "deepseek-flash")).toBe(flash);
    expect(catalogEntry(cat, ["openrouter"], "deepseek/deepseek-flash")).toBe(flash);
    expect(catalogEntry(cat, [null], "DeepSeek-Flash:free")).toBe(flash);
    expect(catalogEntry(cat, [], "llama-local")).toBeNull();
    expect(providerForUrl(cat, "https://api.deepseek.com/v1")).toBe("deepseek");
    expect(providerForUrl(cat, "http://localhost:8000/v1")).toBeNull();
  });

  it("lets the service's own figures win over the catalog's", () => {
    const own = { id: "deepseek-flash", context: 131_072, reasoning: null, source: "service" as const };
    expect(enrich(own, cat.deepseek.models["deepseek-flash"])).toMatchObject({ context: 131_072, reasoning: DEEPSEEK, price: { input: 0.15, output: 0.6 }, source: "service" });
    expect(enrich({ id: "x", reasoning: null }, cat.deepseek.models["deepseek-flash"]).source).toBe("catalog");
  });
});
