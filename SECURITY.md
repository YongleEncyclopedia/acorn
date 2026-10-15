# Security

Acorn is a single-user app meant to run on your own computer or home server.

**Reporting a vulnerability**: please use GitHub's private "Report a vulnerability" (Security → Advisories) instead of a
public issue. Include the version or commit, what an attacker can do, and how to reproduce it.

What Acorn relies on, so you know what counts as a vulnerability:

- Article HTML is untrusted. It is cleaned on the server (`src/server/content/sanitize.ts`) and again in the browser
  (DOMPurify); archived pages are served with a Content-Security-Policy that disables scripts. Any way around that is a bug.
- Every API route and archive file requires the password session or an API token, except the health check, session
  status, login (including the Google Reader `ClientLogin`) and first-run setup. First-run setup is only offered to
  requests from the same machine. The web app's static files are public; they contain no data.
- The RSS outputs under `/out/` are protected by a token in the URL; treat those URLs as secrets.
- Do not expose Acorn to the internet without TLS. A private network such as Tailscale is the recommended way to reach
  it from your phone.
