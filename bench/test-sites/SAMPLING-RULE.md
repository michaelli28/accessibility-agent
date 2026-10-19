# Test-set live sites: sampling rule (pre-registered)

Committed before any site is drawn or opened. The draw script must implement exactly this. Any deviation gets a new commit that says why.

## Frame

- **List:** Tranco list `V3YPN`, the daily list created 2026-09-17 from crux, farsight, majestic, radar and umbrella: <https://tranco-list.eu/download/V3YPN/1000000>.
- **Ranks:** 10,001 to 100,000 inclusive, which are mid-size sites like the dev sites.

## Draw

- **Seed:** the ASCII string `at-agent-bench-2026-09-18`.
- **Candidates:** for i = 0, 1, 2, …, candidate rank r_i = 10001 + (U_i mod 90000), where U_i is the first 4 bytes, big-endian unsigned, of SHA-256(`<seed>:<i>`). Skip a rank already drawn.
- **Stop:** walk candidates in order of i until 20 sites are accepted.

## Screen (the only filter, fully automated)

- **Tool:** one headless-shell Chromium load of `https://<domain>/`. If that fails to connect, try `https://www.<domain>/` once. Wait for `load`, then 3 s.
- **Accept only if all hold:**
  1. The final main-document status is 2xx.
  2. The response is HTML.
  3. No bot wall: no `cf-mitigated` header, and the title and body text don't match `captcha|verify you are human|just a moment|access denied|unusual traffic|are you a robot|continue shopping`.
  4. At least 1 focusable element (`a[href]`, `button`, `input:not([type=hidden])`, `select`, `textarea`, `[tabindex]:not([tabindex="-1"])`).
  5. The domain doesn't contain an adult-content keyword (`porn|xxx|sex|adult|escort|nude|hentai`), and the page has no RTA label (`<meta name="rating" content="RTA-5042-1996-1400-1577-RTA">` or `content="adult"`).
  6. It isn't a dev-set site (amazon, mealkeyway, fake-university, cmu, troy-k12, troyroyalpalace) or w3.org.
- **Recorded per candidate:** i, rank, domain, final URL, status, and accept or the rejecting rule number.
- **Not allowed:** screenshots, reading the page, and running any checker (gap detector, Tab walk, axe) during the screen.

## After the draw

- The accepted list and the full candidate log are committed before the first checker run on any test site.
- Every accepted site is used; none is dropped after results are seen. If a site dies later, it's reported as lost, not replaced.

## Amendment 1 (2026-09-18, after the draw stopped at i=10)

**Why:** the draw stopped at i=10 (noticiasdealava.eus, `ERR_CERT_DATE_INVALID`) because the rule did not say whether a TLS error counts as "fails to connect". Its verifier found more gaps that hadn't come up yet. This amendment was written before any candidate at i ≥ 10 was judged, and no accepted site's content has been viewed.

**What stays fixed:** the records for i=0..9 from commit 7440778 are kept exactly as they are. Their verdicts come out the same under every reading below (the draw computed both readings wherever the rule was ambiguous, and its verifier confirmed this). The draw resumes at i=10. Its primary load is attempted again, because the first attempt produced no response and was never judged.

1. **"Fails to connect"** means the main document gets no HTTP response. This covers DNS, TCP, TLS/certificate, connection reset or closed, an empty response, HTTP/2 protocol errors, a 60 s load timeout, and a redirect whose target does any of these. In that case, try `https://www.<domain>/` once (not when the domain already starts with `www.`). If the fallback also gets no response, reject on rule 1.
2. **Rule 2:** HTML means a media type of `text/html` or `application/xhtml+xml`, case-insensitive. A missing content-type, or a download, is a rule-2 reject.
3. **Rule 3:** the body text is `document.body.innerText` (visible text) and the title is `document.title`. The regex is case-insensitive. `cf-mitigated` counts if it appears on any main-frame response during the load.
4. **Rule 4:** count focusable elements in the main document's light DOM only.
5. **Rule 5:** the keyword check is case-insensitive and applies to the candidate domain before any load, and to the final URL's host after the load. A domain that fails before the load is never loaded, so adult-keyword sites are never opened; its finalUrl and status are recorded as null. The RTA meta check is case-insensitive after trimming.
6. **Rule 6:** exclude exactly these registrable domains and their subdomains: amazon.com, mealkeyway.com, fake-university.com, cmu.edu, troy.k12.mi.us, troyroyalpalace.com, w3.org. The check runs on the candidate domain before the load (not loaded, recorded as null) and on the final URL's host after it. Other domains that merely share a name (amazon.eu, cmu.ac.th) are not excluded.
7. **Reject label:** a reject is labelled with the lowest-numbered failing rule among the checks actually run.
8. **Extra fields:** each record also gets `fallbackUsed` (boolean) and `netError` (the Chromium error code, or null).

## Amendment 2 (2026-09-18, after the draw stopped at i=22)

**Why:** the draw stopped at i=22 (dfbocai.net). The main document answered HTTP 200, but `load` never fired within 60 s. Amendment 1 §1 lists "a 60 s load timeout" inside a definition ("the main document gets no HTTP response") that this case contradicts. The draw's verifier also asked for readings that were already in use to be written down explicitly. This amendment was written before any candidate at i ≥ 22 was judged.

**What stays fixed:** the records for i=0..21 from commit b089260 are kept as they are. None of them hit any clause below differently (none timed out after a response, and none had conflicting headers or an unlisted error). i=22 is attempted a second time, and that load is disclosed in the notes.

1. **Response but no `load` within 60 s:** judge the document as it stands at 60 s + 3 s. There is no www fallback, because the host did answer. Amendment 1 §1's "60 s load timeout" now covers only loads that got no response at all.
2. **In-page read timeout:** if the in-page read (title, text, focusable count, meta) does not finish within 10 s, reject on rule 1, because a frozen page can't be Tab-walked. This replaces the draw's earlier "stop" behaviour for that case.
3. **Cloudflare header scope:** for Rule 3, `cf-mitigated` is checked on the main frame's navigation (document) responses only, not on its subresources. This is the reading used for every record so far.
4. **Content type:** "the media type" for Rule 2 is `document.contentType`, the type Chromium actually used for the document. This settles missing or conflicting Content-Type headers.
5. **Other errors:** any other navigation error that leaves no final document (for example `ERR_TOO_MANY_REDIRECTS`, `ERR_ABORTED`, `ERR_QUIC_*`) counts as "no HTTP response" under Amendment 1 §1. That means one www fallback, then a rule-1 reject.
6. **Extra fields:** new records keep both errors (`primaryNetError`, `fallbackNetError`) and the content type even on timeouts. `netError` stays as it was defined (the last error seen).
