package io.github.yongleencyclopedia.acorn

/**
 * Runs in 松果's page after each load (MainActivity injects it; it does nothing twice, and nothing in frames or
 * on other sites). It talks to the app through `AcornAndroid`, the message channel WebViewCompat adds for the
 * server's origin only:
 * - the system bars take the page's colour, which the reader's theme writes into <meta name="theme-color">;
 * - files the page builds itself (the notes export is a Blob) are handed over, since a WebView cannot download a
 *   blob: URL, and the page revokes it right after the click anyway;
 * - copying and sharing work: a plain-http address is not a secure context, so there is no Clipboard API, and a
 *   WebView has no Web Share at all. The reader's 分享… item appears once navigator.share exists.
 */
internal val PAGE_SCRIPT = """
(() => {
  if (window.__acornApp || window.top !== window || !window.AcornAndroid) return;
  window.__acornApp = true;
  const post = (message) => AcornAndroid.postMessage(JSON.stringify(message));

  const theme = () => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta && meta.content) post({ type: "theme", color: meta.content });
  };
  theme();
  new MutationObserver(theme).observe(document.head, { subtree: true, childList: true, attributes: true, attributeFilter: ["content"] });

  const blobs = new Map();
  const createURL = URL.createObjectURL;
  const revokeURL = URL.revokeObjectURL;
  URL.createObjectURL = function (object) {
    const url = createURL.call(URL, object);
    if (object instanceof Blob) blobs.set(url, object);
    return url;
  };
  URL.revokeObjectURL = function (url) {
    setTimeout(() => {
      blobs.delete(url);
      revokeURL.call(URL, url);
    }, 60000);
  };
  const save = (href, name) => {
    const blob = blobs.get(href);
    if (!blob && !String(href).startsWith("data:")) return false;
    const send = (data) => post({ type: "save", name: name || "", data });
    if (!blob) {
      send(href);
      return true;
    }
    const reader = new FileReader();
    reader.onload = () => send(reader.result);
    reader.readAsDataURL(blob);
    return true;
  };
  window.__acornSave = save;
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.hasAttribute("download") && save(this.href, this.download)) return;
    return click.call(this);
  };
  document.addEventListener("click", (event) => {
    const a = event.target instanceof Element ? event.target.closest("a[download]") : null;
    if (a && save(a.href, a.download)) event.preventDefault();
  }, true);

  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: (text) => (post({ type: "copy", text: String(text) }), Promise.resolve()) },
  });
  navigator.share = (data) => {
    post({ type: "share", title: (data && data.title) || "", text: (data && data.text) || "", url: (data && data.url) || "" });
    return Promise.resolve();
  };
})();
"""
