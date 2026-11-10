/**
 * What the reader works out from an article's text before setting it (src/shared/article.ts), and the small pure
 * helpers of the web app that decide how keys and reading time are named.
 */
import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { collectOutline, dominantScript, LATIN_ATTR, markScripts } from "../src/shared/article.ts";
import { TR_ATTR } from "../src/shared/translate.ts";
import { comboOf } from "../web/src/lib/hotkeys.ts";
import { readingMinutes, timeLeft } from "../web/src/lib/format.ts";

const dom = (html: string) => parseHTML(`<!doctype html><html><body><div id="a">${html}</div></body></html>`).document.getElementById("a")!;

describe("which script a text is set in", () => {
  it("treats Chinese full of English terms as Chinese", () => {
    expect(dominantScript("苹果发布 MacBook Pro 和 iPhone")).toBe("cjk");
    expect(dominantScript("ATK 在去年完成了品牌重塑，和 VGN 彻底分家")).toBe("cjk");
    expect(dominantScript("日本語のテキストと한국어")).toBe("cjk");
  });

  it("treats Western text that mentions a Chinese name as Western", () => {
    expect(dominantScript("Tencent (腾讯) announced a new model on Tuesday, according to people familiar with the matter.")).toBe("latin");
    expect(dominantScript("Привет, мир — это просто проверка.")).toBe("latin");
  });

  it("has no opinion about text without letters", () => {
    expect(dominantScript("2026-11-10 · 12:30")).toBe("cjk");
    expect(dominantScript("")).toBe("cjk");
  });
});

describe("marking paragraphs for typesetting", () => {
  it("marks only the Latin-script paragraphs, and reports the article's own script", () => {
    const root = dom(`
      <p id="zh">松鼠秋天会把橡果一颗颗埋进土里，留到冬天慢慢吃。</p>
      <p id="en">Squirrels bury acorns one by one in the autumn and eat them slowly through the winter.</p>
      <p id="mixed">松果 Acorn 是一个 self-hosted 的阅读器。</p>
      <p id="empty"> </p>`);
    expect(markScripts(root)).toBe("cjk");
    expect(root.querySelector("#zh")!.hasAttribute(LATIN_ATTR)).toBe(false);
    expect(root.querySelector("#en")!.hasAttribute(LATIN_ATTR)).toBe(true);
    expect(root.querySelector("#mixed")!.hasAttribute(LATIN_ATTR)).toBe(false);
    expect(root.querySelector("#empty")!.hasAttribute(LATIN_ATTR)).toBe(false);
  });

  it("calls an English article Latin and leaves inserted translations alone", () => {
    const root = dom(`
      <p>Over the past year, while Git traffic grew exponentially, most repositories began living in two places at once.</p>
      <p ${TR_ATTR}="" id="tr">The translated paragraph Acorn inserted is not part of the article.</p>`);
    expect(markScripts(root)).toBe("latin");
    expect(root.querySelector("#tr")!.hasAttribute(LATIN_ATTR)).toBe(false);
  });

  it("clears a mark that no longer applies when run again", () => {
    const root = dom(`<p id="p">Just some English words in a row.</p>`);
    markScripts(root);
    root.querySelector("#p")!.textContent = "换成了一段中文内容。";
    markScripts(root);
    expect(root.querySelector("#p")!.hasAttribute(LATIN_ATTR)).toBe(false);
  });
});

describe("an article's outline", () => {
  it("counts depth from the highest heading level the article uses", () => {
    const root = dom(`
      <h3>背景</h3><p>…</p>
      <h4>为什么是现在</h4><p>…</p>
      <h3>方法</h3>
      <h4>数据</h4>
      <h4>模型</h4>`);
    expect(collectOutline(root).map((h) => [h.depth, h.text])).toEqual([
      [0, "背景"],
      [1, "为什么是现在"],
      [0, "方法"],
      [1, "数据"],
      [1, "模型"],
    ]);
  });

  it("folds deep levels into the third and keeps the heading elements", () => {
    const root = dom(`<h1>One</h1><h2>Two</h2><h3>Three</h3><h4>Four</h4>`);
    const outline = collectOutline(root);
    expect(outline.map((h) => h.depth)).toEqual([0, 1, 2, 2]);
    expect(outline[3].el.tagName).toBe("H4");
  });

  it("skips headings that are not sections: quoted, in lists or tables, empty, or inserted translations", () => {
    const root = dom(`
      <h2>正文的一节</h2>
      <blockquote><h2>引用里的标题</h2></blockquote>
      <ul><li><h3>列表里的标题</h3></li></ul>
      <table><tr><td><h3>表格里的标题</h3></td></tr></table>
      <h2> </h2>
      <h2>#</h2>
      <h2 ${TR_ATTR}="">A translated heading</h2>
      <h2>Section <span ${TR_ATTR}="">第二节</span></h2>`);
    expect(collectOutline(root).map((h) => h.text)).toEqual(["正文的一节", "Section"]);
  });

  it("is empty for an article without headings", () => {
    expect(collectOutline(dom("<p>没有小标题的短文。</p>"))).toEqual([]);
  });
});

describe("naming a key press", () => {
  const press = (key: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }> = {}) => comboOf({ key, metaKey: false, ctrlKey: false, shiftKey: false, ...mods }).combo;

  it("names letters, the space bar and symbols", () => {
    expect(press("j")).toBe("j");
    expect(press("J", { shiftKey: true })).toBe("shift+j");
    expect(press(" ")).toBe("space");
    expect(press(" ", { shiftKey: true })).toBe("shift+space");
    // "?" is typed with Shift on most layouts; the symbol already says so
    expect(press("?", { shiftKey: true })).toBe("?");
    expect(press("/")).toBe("/");
  });

  it("names combinations with ⌘ or Ctrl the same way, and named keys with Shift", () => {
    expect(press("k", { metaKey: true })).toBe("mod+k");
    expect(press("k", { ctrlKey: true })).toBe("mod+k");
    expect(press("ArrowDown", { shiftKey: true })).toBe("shift+ArrowDown");
    expect(press("Escape")).toBe("Escape");
  });
});

describe("reading time", () => {
  it("only talks about time left for articles long enough to wonder", () => {
    expect(readingMinutes(0)).toBe(0);
    expect(readingMinutes(200)).toBe(1);
    expect(timeLeft(600, 0.5)).toBe(""); // a two-minute read
    expect(timeLeft(3600, 0)).toBe(""); // not started
    expect(timeLeft(3600, 0.5)).toBe("还剩 5 分钟");
    expect(timeLeft(3600, 0.97)).toBe("还剩 1 分钟");
    expect(timeLeft(3600, 0.99)).toBe("读完了");
  });
});
