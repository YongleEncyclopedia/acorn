/** Turning a Wayback Machine capture back into the page it was: no playback scripts, live links, archived images. */
import { describe, expect, it } from "vitest";
import { unwrapWayback } from "../src/server/archive/wayback.ts";

describe("unwrapping a Wayback Machine page", () => {
  it("drops the playback scripts, points links at the live web and images at archived copies", () => {
    const html = `<!doctype html><html><head><script type="text/javascript" src="https://web-static.archive.org/_static/js/bundle-playback.js?v=1"></script>
<script>__wm.init("https://web.archive.org/web");</script>
<link rel="stylesheet" href="https://web-static.archive.org/_static/css/banner-styles.css"/>
<!-- End Wayback Rewrite JS Include -->
<title>T</title></head><body><a href="/web/20200102030405/https://o.example/next">next</a>
<img src="/web/20200102030405im_/https://o.example/a.png"><img src="/b.png" data-src="https://cdn.example/c.png"></body></html>`;
    const out = unwrapWayback(html, "https://o.example/post", "20200102030405", "https://wb.example");
    expect(out).not.toContain("bundle-playback");
    expect(out).not.toContain("banner-styles");
    expect(out).toContain('href="https://o.example/next"');
    expect(out).toContain('src="https://wb.example/web/20200102030405im_/https://o.example/a.png"');
    expect(out).toContain('src="https://wb.example/web/20200102030405im_/https://o.example/b.png"');
    expect(out).toContain('data-src="https://wb.example/web/20200102030405im_/https://cdn.example/c.png"');
  });
});
