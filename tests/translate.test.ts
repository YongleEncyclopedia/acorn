/**
 * Translation: block detection (shared by server and web), reply parsing, and the whole flow against fake
 * Ollama, OpenAI-compatible and Anthropic servers on localhost.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { parseHTML } from "linkedom";
import { loadConfig } from "../src/server/config.ts";
import { createApp, ensureCliToken, type App } from "../src/server/app.ts";
import { createHttp } from "../src/server/api/http.ts";
import { blockText, isForeign, needsTranslation, translatableBlocks, TR_ATTR } from "../src/shared/translate.ts";
import { buildPrompt, parseReply } from "../src/server/translate/engine.ts";
import { parsePoints, summarize } from "../src/server/translate/summary.ts";
import type { ModelList, ModelTest, TranslationJob } from "../src/shared/types.ts";

process.env.ACORN_SILENT = "1";

describe("translatable blocks", () => {
  const root = (html: string) => parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body></html>`).document.getElementById("r")!;

  it("picks leaf blocks in order and skips code, Chinese and empty ones", () => {
    const r = root(`
      <h2>Why squirrels forget</h2>
      <p>They bury thousands of acorns every autumn.</p>
      <ul><li>Some are eaten</li><li><p>Some <b>grow</b> into trees</p></li></ul>
      <blockquote><p>Forgetting is a feature.</p></blockquote>
      <pre><code>const x = "do not translate";</code></pre>
      <p>这段已经是中文了，不需要翻译。</p>
      <p>https://example.com/only-a-link</p>
      <div>Loose text in a div</div>
      <figure><img src="a.png"><figcaption>An oak tree</figcaption></figure>`);
    const texts = translatableBlocks(r, "zh-CN").map((el) => blockText(el).trim());
    expect(texts).toEqual(["Why squirrels forget", "They bury thousands of acorns every autumn.", "Some are eaten", "Some grow into trees", "Forgetting is a feature.", "Loose text in a div", "An oak tree"]);
  });

  it("ignores translations already inserted", () => {
    const r = root(`<p>Hello world</p><p ${TR_ATTR}>你好世界</p><ul><li>One item<span ${TR_ATTR}>一项</span></li></ul>`);
    expect(translatableBlocks(r, "zh-CN").map((el) => blockText(el))).toEqual(["Hello world", "One item"]);
  });

  it("knows which language a text is in", () => {
    expect(needsTranslation("The quick brown fox", "zh-CN")).toBe(true);
    expect(needsTranslation("敏捷的棕色狐狸", "zh-CN")).toBe(false);
    expect(needsTranslation("すばやい茶色の狐", "zh-CN")).toBe(true);
    expect(needsTranslation("敏捷的棕色狐狸", "en")).toBe(true);
    expect(needsTranslation("42", "zh-CN")).toBe(false);
    expect(isForeign("An English article. ".repeat(20), "zh-CN")).toBe(true);
    expect(isForeign("一篇中文文章，夹着几个 English words 也没关系。".repeat(10), "zh-CN")).toBe(false);
  });
});

describe("model replies", () => {
  it("reads key points in whatever list style the model picks", () => {
    expect(parsePoints("- 一\n2. 二\n* **三**\n\n• 四\n5、3.5 亿人")).toEqual(["一", "二", "三", "四", "3.5 亿人"]);
  });

  it("numbers segments and reads them back", () => {
    expect(buildPrompt(["a", "b"])).toBe("[[1]] a\n\n[[2]] b");
    expect(parseReply("<think>hmm</think>\n[[1]] 甲\n[[2]] 乙\n", 2)).toEqual(["甲", "乙"]);
    expect(parseReply("[[2]] 乙\n[[1]] 甲", 2)).toEqual(["甲", "乙"]);
    expect(parseReply("[[1]] 甲", 2)).toBeNull();
    expect(parseReply("只有一段，没有编号", 1)).toEqual(["只有一段，没有编号"]);
  });
});

// A slice of models.dev's catalog, in its own format.
const CATALOG = {
  deepseek: {
    api: "https://api.deepseek.com",
    models: {
      "deepseek-flash": { id: "deepseek-flash", name: "DeepSeek V4.1 Flash", reasoning: true, reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }], temperature: true, limit: { context: 1048576, output: 393216 }, cost: { input: 0.15, output: 0.6 }, release_date: "2026-10-17" },
    },
  },
  "moonshotai-cn": {
    api: "https://api.moonshot.cn/v1",
    models: {
      "kimi-k3": { id: "kimi-k3", name: "Kimi K3", reasoning: true, reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }], temperature: false, limit: { context: 1048576, output: 1048576 }, cost: { input: 2.99, output: 14.94 }, release_date: "2026-08-01" },
    },
  },
};

describe("translation flow", () => {
  let server: http.Server;
  let base = "";
  let app: App;
  let web: ReturnType<typeof createHttp>;
  let token = "";
  let dataDir = "";
  const calls: { path: string; auth: string | undefined; body: Record<string, any> }[] = [];

  // Every fake engine "translates" by prefixing 译: and keeps the [[n]] markers.
  const fakeTranslate = (prompt: string) => prompt.replace(/\[\[(\d+)\]\] /g, "[[$1]] 译:");

  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ path: req.url || "", auth: (req.headers.authorization || req.headers["x-api-key"]) as string | undefined, body });
      const json = (status: number, data: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      const user = body.messages?.find((m: { role: string }) => m.role === "user")?.content || "";
      const system = body.messages?.find((m: { role: string }) => m.role === "system")?.content || body.system || "";
      if (req.url === "/api/chat" && /key points/.test(system)) return json(200, { message: { role: "assistant", content: "<think></think>\n- 松鼠埋下的橡果比吃掉的多\n- 2. 被忘掉的橡果长成了森林\n* **存档**：原文没了，副本还在" } });
      if (req.url === "/api/tags") return json(200, { models: [{ name: "qwen3:14b", size: 9_300_000_000, details: { parameter_size: "14.8B", quantization_level: "Q4_K_M" } }] });
      if (req.url === "/api/show") return json(200, { model_info: { "general.architecture": "qwen3", "qwen3.context_length": 40960 }, capabilities: ["completion", "thinking"], thinking: { values: [true, false], default: true } });
      if (req.url === "/catalog.json") return json(200, CATALOG);
      if (req.url === "/api/chat") {
        if (body.model !== "qwen3:14b") return json(404, { error: `model "${body.model}" not found, try pulling it first` });
        return json(200, { message: { role: "assistant", content: fakeTranslate(user) } });
      }
      if (req.url === "/v1/chat/completions") return json(200, { choices: [{ message: { content: fakeTranslate(user) } }] });
      // a DeepSeek-like service (its list holds an embedding model too), a Kimi that always reasons, a model without temperature
      if (req.url === "/v1/models" || req.url === "/other/models") return json(200, { object: "list", data: [{ id: "some-model", object: "model" }] });
      if (req.url === "/ds/models") return json(200, { object: "list", data: [{ id: "deepseek-flash", object: "model", owned_by: "deepseek" }, { id: "deepseek-embed-v2", object: "model", owned_by: "deepseek" }] });
      if (req.url === "/kimi/chat/completions") return json(200, { choices: [{ message: { content: fakeTranslate(user), reasoning_content: "先想一想" }, finish_reason: "stop" }], usage: { completion_tokens_details: { reasoning_tokens: 12 } } });
      if (req.url === "/notemp/chat/completions" && "temperature" in body) return json(400, { error: { message: "Unsupported parameter: 'temperature' is not supported with this model.", type: "invalid_request_error" } });
      if (req.url === "/ds/chat/completions" || req.url === "/notemp/chat/completions") return json(200, { choices: [{ message: { content: fakeTranslate(user) }, finish_reason: "stop" }] });
      if (req.url === "/v1/messages") return json(200, { content: [{ type: "text", text: fakeTranslate(user) }] });
      json(404, { error: "not found" });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dataDir = mkdtempSync(path.join(os.tmpdir(), "acorn-translate-"));
    app = createApp(loadConfig({ ACORN_DATA_DIR: dataDir, ACORN_EGO_BROWSER: "definitely-not-installed", ACORN_MODELS_CATALOG: `${base}/catalog.json` }, { scheduler: false }));
    token = ensureCliToken(app);
    web = createHttp(app);
  });

  afterAll(() => {
    server.close();
    app.db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const api = async <T = Record<string, any>>(p: string, init: RequestInit = {}) => {
    const res = await web.request(p, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
    return (await res.json()) as T;
  };
  const configure = (translate: Record<string, unknown>) => api("/api/settings", { method: "PATCH", body: JSON.stringify({ translate }) });
  const translate = async (texts: string[], fresh = false): Promise<TranslationJob> => {
    let job = await api<TranslationJob>("/api/translate", { method: "POST", body: JSON.stringify({ texts, fresh }) });
    for (let i = 0; i < 100 && !job.error && job.done < job.total; i++) {
      await new Promise((r) => setTimeout(r, 20));
      job = await api<TranslationJob>(`/api/translate/${job.id}`);
    }
    return job;
  };

  it("translates with a local Ollama model, without thinking", async () => {
    await configure({ provider: "ollama", baseUrl: base, model: "qwen3:14b" });
    const job = await translate(["Hello world", "Squirrels  forget\nthings", "Hello world"]);
    expect(job.error).toBeNull();
    expect(job.items).toEqual(["译:Hello world", "译:Squirrels forget things", "译:Hello world"]);
    const chat = calls.filter((c) => c.path === "/api/chat");
    expect(chat).toHaveLength(1);
    expect(chat[0].body.think).toBe(false);
    const listed = await api("/api/translate/models");
    expect(listed.models).toEqual([{ id: "qwen3:14b", context: 40960, reasoning: { toggle: true, efforts: [], budget: null }, detail: "14.8B · Q4_K_M · 9.3 GB", source: "service" }]);
  });

  it("serves repeated texts from the cache, and translates again when asked", async () => {
    const before = calls.length;
    const job = await api<TranslationJob>("/api/translate", { method: "POST", body: JSON.stringify({ texts: ["Hello world"] }) });
    expect(job.items).toEqual(["译:Hello world"]);
    expect(calls.length).toBe(before);
    await translate(["Hello world"], true);
    expect(calls.length).toBe(before + 1);
  });

  it("says how much of an article is translated already, without asking the model", async () => {
    const before = calls.length;
    const known = await api<{ total: number; cached: number }>("/api/translate/known", { method: "POST", body: JSON.stringify({ texts: ["Hello world", "Never translated", "Hello world", ""] }) });
    expect(known).toEqual({ total: 2, cached: 1 });
    expect(calls.length).toBe(before);
  });

  it("explains a missing local model", async () => {
    await configure({ model: "llama-not-pulled" });
    const job = await translate(["Something new"]);
    expect(job.error).toMatch(/ollama pull llama-not-pulled/);
  });

  it("uses OpenAI-compatible APIs and keeps the key away from clients", async () => {
    await configure({ provider: "openai", baseUrl: `${base}/v1`, model: "deepseek-chat", apiKey: "sk-secret-1234" });
    const settings = await api("/api/settings");
    expect(settings.translate.apiKey).not.toContain("secret");
    expect(settings.translate.apiKey).toMatch(/1234$/);
    // saving the form back with the masked key must not overwrite the real one
    await configure({ ...settings.translate, model: "deepseek-chat" });
    const job = await translate(["Another sentence to translate"]);
    expect(job.items).toEqual(["译:Another sentence to translate"]);
    expect(calls.at(-1)!.auth).toBe("Bearer sk-secret-1234");
  });

  it("writes key points once, then serves them from the cache", async () => {
    await configure({ provider: "ollama", baseUrl: base, model: "qwen3:14b", apiKey: "" });
    const text = "松鼠在秋天把橡果一颗颗埋进土里。".repeat(40);
    expect(await summarize(app, "松鼠", text)).toBeNull(); // nothing cached, not asked to generate
    const before = calls.length;
    const first = await summarize(app, "松鼠", text, { generate: true });
    expect(first?.points).toEqual(["松鼠埋下的橡果比吃掉的多", "被忘掉的橡果长成了森林", "存档：原文没了，副本还在"]);
    expect(first?.cached).toBe(false);
    const again = await summarize(app, "松鼠", text, { generate: true });
    expect(again?.cached).toBe(true);
    expect(calls.length).toBe(before + 1);
    await summarize(app, "松鼠", text, { generate: true, fresh: true });
    expect(calls.length).toBe(before + 2);
    await expect(summarize(app, "短", "太短了", { generate: true })).rejects.toThrow(/太短/);
  });

  it("talks to Claude through the Messages API", async () => {
    await configure({ provider: "anthropic", baseUrl: `${base}/v1`, model: "claude-haiku-5-5", apiKey: "sk-ant-5678" });
    const r = await api("/api/translate/test", { method: "POST" });
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/^译:The squirrel/);
    expect(calls.at(-1)!.path).toBe("/v1/messages");
    expect(calls.at(-1)!.auth).toBe("sk-ant-5678");
  });

  const DEEPSEEK = { provider: "openai", preset: "deepseek", apiKey: "sk-draft" };
  const lastCall = (p: string) => calls.filter((c) => c.path === p).at(-1)!;
  const post = <T,>(p: string, body: unknown) => api<T>(p, { method: "POST", body: JSON.stringify(body) });

  it("lists a service's models before anything is saved, filled in from models.dev", async () => {
    const saved = (await api("/api/settings")).translate;
    const list = await post<ModelList>("/api/translate/models", { ...DEEPSEEK, baseUrl: `${base}/ds` });
    expect(list.source).toBe("service");
    // the embedding model is left out; the catalog adds the window, the reasoning controls and the price
    expect(list.models).toEqual([{ id: "deepseek-flash", name: "DeepSeek V4.1 Flash", context: 1_048_576, maxOutput: 393_216, reasoning: { toggle: true, efforts: ["low", "high", "max"], budget: null }, temperature: true, price: { input: 0.15, output: 0.6 }, source: "catalog" }]);
    expect(lastCall("/ds/models").auth).toBe("Bearer sk-draft");
    expect((await api("/api/settings")).translate).toEqual(saved);
  });

  it("tests a draft before it is saved, with reasoning switched off where the model allows it", async () => {
    const draft = { ...DEEPSEEK, baseUrl: `${base}/ds`, model: "deepseek-flash", reasoning: "auto" };
    const r = await post<ModelTest>("/api/translate/test", draft);
    expect(r).toMatchObject({ ok: true, model: "deepseek-flash", reasoned: false, sent: { thinking: { type: "disabled" } }, info: { context: 1_048_576 } });
    expect(r.text).toMatch(/^译:The squirrel/);
    expect(lastCall("/ds/chat/completions")).toMatchObject({ auth: "Bearer sk-draft", body: { model: "deepseek-flash", temperature: 0.2, thinking: { type: "disabled" } } });
    // the deepest level, and a parameter of the service's own
    const deep = await post<ModelTest>("/api/translate/test", { ...draft, reasoning: "max", extraBody: '{"top_p": 0.9}' });
    expect(deep.sent).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "max" });
    expect(lastCall("/ds/chat/completions").body).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "max", top_p: 0.9 });
    expect(await post<ModelTest>("/api/translate/test", { ...draft, extraBody: "[1, 2]" })).toMatchObject({ ok: false, error: expect.stringMatching(/附加请求参数/) });
  });

  it("keeps a model that always reasons at its lowest level, without the temperature it rejects", async () => {
    const r = await post<ModelTest>("/api/translate/test", { provider: "openai", preset: "moonshot", baseUrl: `${base}/kimi`, apiKey: "sk-kimi", model: "kimi-k3" });
    expect(r).toMatchObject({ ok: true, reasoned: true, reasoningTokens: 12, sent: { reasoning_effort: "low" } });
    const body = lastCall("/kimi/chat/completions").body;
    expect(body.reasoning_effort).toBe("low");
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("temperature");
  });

  it("asks again without a temperature when a model rejects one, and remembers that", async () => {
    const draft = { provider: "openai", preset: "custom", baseUrl: `${base}/notemp`, model: "reasoner-x" };
    expect((await post<ModelTest>("/api/translate/test", draft)).ok).toBe(true);
    const tries = () => calls.filter((c) => c.path === "/notemp/chat/completions").map((c) => "temperature" in c.body);
    expect(tries()).toEqual([true, false]);
    await post("/api/translate/test", draft);
    expect(tries()).toEqual([true, false, false]);
  });

  it("sends a saved key only to the address it was saved for", async () => {
    await configure({ provider: "openai", preset: "custom", baseUrl: `${base}/v1`, model: "some-model", apiKey: "sk-saved-9999" });
    const saved = (await api("/api/settings")).translate;
    expect(saved.apiKey).toBe("••••9999");
    const list = (baseUrl: string) => post<ModelList>("/api/translate/models", { provider: "openai", preset: "custom", baseUrl, apiKey: saved.apiKey });
    expect((await list(`${base}/v1`)).models.map((m) => m.id)).toEqual(["some-model"]);
    expect(lastCall("/v1/models").auth).toBe("Bearer sk-saved-9999");
    await list(`${base}/other`);
    expect(lastCall("/other/models").auth).toBeUndefined();
    // saving the form with the masked key under a new address does not carry the key there either
    await configure({ ...saved, baseUrl: `${base}/other` });
    expect((await api("/api/settings")).translate.apiKey).toBe("");
  });
});
