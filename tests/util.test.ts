import { describe, expect, it } from "vitest";
import { parseLooseDate } from "../src/server/util/dates.ts";
import { canonicalUrl } from "../src/server/util/url.ts";
import { countWords, excerpt, htmlToText, similarity } from "../src/server/util/text.ts";
import { decodeBody, sniffCharset } from "../src/server/util/http.ts";
import { ftsQuery } from "../src/server/db/index.ts";

const NOW = new Date(2026, 9, 13, 15, 0, 0).getTime();
const ymd = (t: number | null) => (t ? new Date(t).toLocaleDateString("sv-SE") : null);

describe("parseLooseDate", () => {
  it("understands Chinese and ISO formats", () => {
    expect(ymd(parseLooseDate("2026-10-08", NOW))).toBe("2026-10-08");
    expect(ymd(parseLooseDate("2026年10月8日", NOW))).toBe("2026-10-08");
    expect(ymd(parseLooseDate("[2026/9/30]", NOW))).toBe("2026-09-30");
    expect(ymd(parseLooseDate("10-09", NOW))).toBe("2026-10-09");
    expect(ymd(parseLooseDate("12-20", NOW))).toBe("2025-12-20");
    expect(parseLooseDate("Tue, 13 Oct 2026 06:27:03 +0000", NOW)).toBe(Date.UTC(2026, 9, 13, 6, 27, 3));
    expect(parseLooseDate("2026-10-08T15:04:46Z", NOW)).toBe(Date.UTC(2026, 9, 8, 15, 4, 46));
  });
  it("handles split widgets and relative times", () => {
    expect(ymd(parseLooseDate("10 2026.10", NOW))).toBe("2026-10-10");
    expect(ymd(parseLooseDate("2026.10 09", NOW))).toBe("2026-10-09");
    expect(parseLooseDate("3小时前", NOW)).toBe(NOW - 3 * 3_600_000);
    expect(parseLooseDate("刚刚", NOW)).toBe(NOW);
    expect(ymd(parseLooseDate("昨天 08:30", NOW))).toBe("2026-10-12");
    expect(parseLooseDate("", NOW)).toBeNull();
    expect(parseLooseDate("没有日期", NOW)).toBeNull();
  });
});

describe("canonicalUrl", () => {
  it("drops tracking parameters and fragments", () => {
    expect(canonicalUrl("https://example.com/a?utm_source=x&id=3#top")).toBe("https://example.com/a?id=3");
  });
  it("keeps only the identity of WeChat articles", () => {
    expect(canonicalUrl("http://mp.weixin.qq.com/s?__biz=AA==&mid=1&idx=1&sn=abc&chksm=zzz&scene=21#wechat_redirect")).toBe("https://mp.weixin.qq.com/s?__biz=AA%3D%3D&idx=1&mid=1&sn=abc");
  });
});

describe("text helpers", () => {
  it("counts CJK characters as words", () => {
    expect(countWords("松果 is great")).toBe(4);
  });
  it("converts HTML to text and makes excerpts", () => {
    expect(htmlToText("<p>a&amp;b</p><script>x</script><p>c</p>")).toBe("a&b\nc");
    expect(excerpt("一".repeat(300), 20).length).toBeLessThanOrEqual(21);
  });
  it("measures similarity", () => {
    expect(similarity("今天天气很好，适合出门散步。", "今天天气很好，适合出门散步。")).toBe(1);
    expect(similarity("今天天气很好，适合出门散步。", "完全不同的另一段文字内容啊。")).toBeLessThan(0.2);
  });
  it("builds safe FTS queries", () => {
    expect(ftsQuery("公众号 存档")).toBeNull();
    expect(ftsQuery("微信公众号")).toBe('"微信公众号"');
    expect(ftsQuery('a"bc')).toBe('"a""bc"');
  });
});

describe("charset handling", () => {
  it("decodes GBK pages declared in meta", () => {
    const gbk = Buffer.from([0x3c, 0x6d, 0x65, 0x74, 0x61, 0x20, 0x63, 0x68, 0x61, 0x72, 0x73, 0x65, 0x74, 0x3d, 0x67, 0x62, 0x32, 0x33, 0x31, 0x32, 0x3e, 0xcb, 0xc9, 0xb9, 0xfb]);
    expect(sniffCharset(gbk, "text/html")).toBe("gbk");
    expect(decodeBody(gbk, "text/html")).toContain("松果");
  });
  it("prefers the header charset", () => {
    expect(sniffCharset(Buffer.from("<meta charset=gbk>"), "text/html; charset=UTF-8")).toBe("utf-8");
  });
});

describe("httpGet retries", () => {
  it("retries a dropped connection, but gives up after a few tries", async () => {
    const http = await import("node:http");
    const { httpGet } = await import("../src/server/util/http.ts");
    let hits = 0;
    let dropFirst = 1;
    const server = http.createServer((req, res) => {
      hits++;
      if (hits <= dropFirst) return req.socket.destroy();
      res.end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    try {
      const res = await httpGet(url);
      expect(res.body.toString()).toBe("ok");
      expect(hits).toBe(2);

      hits = 0;
      dropFirst = 99;
      await expect(httpGet(url)).rejects.toThrow();
      expect(hits).toBe(3);
    } finally {
      server.close();
    }
  });
});

describe("split dates on school sites", () => {
  const now = new Date(2026, 9, 22, 12).getTime();
  const day = (t: number | null) => (t ? new Date(t).toLocaleDateString("en-CA") : null);
  it("reads day, year.month and month.day, year widgets with their own year", () => {
    expect(day(parseLooseDate("21 2026.10", now))).toBe("2026-10-21");
    expect(day(parseLooseDate("09.30 2026", now))).toBe("2026-09-30");
    expect(day(parseLooseDate("09.30 2024", now))).toBe("2024-09-30");
    expect(day(parseLooseDate("2024 09.30", now))).toBe("2024-09-30");
  });
});
