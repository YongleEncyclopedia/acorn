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
import type { TranslationJob } from "../src/shared/types.ts";

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
      if (req.url === "/api/tags") return json(200, { models: [{ name: "qwen3:14b" }] });
      if (req.url === "/api/chat") {
        if (body.model !== "qwen3:14b") return json(404, { error: `model "${body.model}" not found, try pulling it first` });
        return json(200, { message: { role: "assistant", content: fakeTranslate(user) } });
      }
      if (req.url === "/v1/chat/completions") return json(200, { choices: [{ message: { content: fakeTranslate(user) } }] });
      if (req.url === "/v1/messages") return json(200, { content: [{ type: "text", text: fakeTranslate(user) }] });
      json(404, { error: "not found" });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dataDir = mkdtempSync(path.join(os.tmpdir(), "acorn-translate-"));
    app = createApp(loadConfig({ ACORN_DATA_DIR: dataDir, ACORN_EGO_BROWSER: "definitely-not-installed" }, { scheduler: false }));
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
    expect((await api("/api/translate/models")).models).toEqual(["qwen3:14b"]);
  });

  it("serves repeated texts from the cache, and translates again when asked", async () => {
    const before = calls.length;
    const job = await api<TranslationJob>("/api/translate", { method: "POST", body: JSON.stringify({ texts: ["Hello world"] }) });
    expect(job.items).toEqual(["译:Hello world"]);
    expect(calls.length).toBe(before);
    await translate(["Hello world"], true);
    expect(calls.length).toBe(before + 1);
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
});
