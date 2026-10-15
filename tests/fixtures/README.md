# Test fixtures

Pages and feeds saved from real sites, so parsing and extraction are tested against real-world markup.
Their prose has been replaced with placeholder text (markup, URLs, dates and the few phrases the tests
look for are kept), so no third-party article is redistributed here.

| File | Shape of | Notes |
|---|---|---|
| `sspai-article.html` | an article page on sspai.com | text replaced |
| `edu-article.html`, `edu-list.html` | a university CMS (VSB) notice and notice list | text, names, emails, phone numbers replaced |
| `atom.xml` | a personal blog's Atom feed | trimmed to 3 entries, text replaced |
| `rss.xml` | hnrss.org front page | headlines and links only |
| `feed.json` | the JSON Feed spec's own feed (jsonfeed.org) | as published |
| `example.mhtml` | Chromium snapshot of example.com | as captured |
| `wechat-captcha.html` | the captcha page mp.weixin.qq.com shows instead of an article | hand-written stand-in |

To add one: save the page, keep only what the test needs, and run it through a text scrambler before committing.
