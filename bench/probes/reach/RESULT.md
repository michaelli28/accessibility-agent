# Probe: live-site reachability (Day 1)

Run 2026-09-18, worktree `bench/detector-eval` @ 6b2f270. Landing URLs only: no accessibility checker, gap detector or axe ran, and nothing was clicked.

## Answer

- **Old dev sites you can use:** mealkeyway, fake-university, cmu and troy-k12 work in both headless modes. amazon is **degraded**: the first load returns a 202 challenge, and one time out of 4 in new-headless it showed a "Continue shopping" bot page instead of the store. troyroyalpalace is **dead**: 404 with Squarespace's "Website Expired" page.
- **BAD:** you can download all of it over plain HTTP (curl and Playwright's request API both get 200 and real pages). Loading it in any headless Chromium hits a Cloudflare check ("Just a moment...", 403) in both modes, and changing the user agent doesn't help. So download it and serve it locally. The official `bad.zip` has every page and report.
- **Headless shell vs new headless:** for sites that load normally or are fully blocked, the verdicts matched. For amazon, only new headless got the bot page, and only 1 time in 4.

## Verdict rules

- **usable**: 2xx response, the real page shows in the screenshot, and there's no real bot wall.
- **degraded**: the real page loads, but something makes repeat runs unreliable: an occasional bot page, a non-200 challenge status, or networkidle that sometimes never settles.
- **blocked**: the real page never shows in the browser, because of a bot wall or a dead site.

`bot-wall (heuristic)` means the task's regex matched the title or body text. `adjudicated` means I checked the screenshot and the matched text.

## 1. Curl from inside the sandbox (`allowed_domains` = that host)

| URL                                         | curl result                                                                                                                                                                                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| https://example.com                         | `200 https://example.com/`                                                                                                                                                                                                                                                            |
| https://www.amazon.com                      | `200 https://www.amazon.com/`                                                                                                                                                                                                                                                         |
| mealkeyway (full URL below)                 | `200 https://order.mealkeyway.com/customer/release/index?mid=…#/main`                                                                                                                                                                                                                 |
| https://www.troyroyalpalace.com             | `404 https://www.troyroyalpalace.com/`                                                                                                                                                                                                                                                |
| https://fake-university.com                 | allowed=`fake-university.com` only: `curl: (56) CONNECT tunnel failed, response 403` / `000 https://www.fake-university.com/` + sandbox `deny network-outbound www.fake-university.com:443`. Rerun with the `www.` redirect host also allowed: `200 https://www.fake-university.com/` |
| https://cmu.edu                             | allowed=`cmu.edu` only: `curl: (56) CONNECT tunnel failed, response 403` / `000 https://www.cmu.edu/` + sandbox `deny network-outbound www.cmu.edu:443`. Rerun with `www.cmu.edu` also allowed: `200 https://www.cmu.edu/`                                                            |
| https://www.troy.k12.mi.us/                 | `200 https://www.troy.k12.mi.us/`                                                                                                                                                                                                                                                     |
| all 17 BAD URLs (index, 8 pages, 8 reports) | all `200` at their own URL, no redirects (see `curl-bad.txt`)                                                                                                                                                                                                                         |

The two 403s came from the sandbox proxy, not the sites. fake-university.com and cmu.edu redirect to `www.`, so the sandbox needs both hosts in `allowed_domains`.

## 2. Playwright outside the sandbox (`probe.mjs`)

Modes (confirmed in `followup-run.txt`):

- `shell` = `chromium.launch()`, which runs `chromium_headless_shell-1200/.../chrome-headless-shell` (Chromium 143.0.7499.4). User agent: `HeadlessChrome/143.0.7499.4`.
- `newheadless` = `chromium.launch({channel:'chromium'})`, which runs `chromium-1200/.../Google Chrome for Testing` (143.0.7499.4). User agent: `HeadlessChrome/143.0.0.0`.

Settings: `goto` waits for `domcontentloaded` (same as `packages/browser/src/page.ts:12`), then networkidle with a 30s timeout. Each URL gets a fresh context, 4 at a time per mode.

### Old dev sites and control

| site            | mode        | status | final URL                        | title                               | focusable | networkidle | bot-wall (heuristic) | adjudicated                                                                   | verdict                                                    |
| --------------- | ----------- | ------ | -------------------------------- | ----------------------------------- | --------- | ----------- | -------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------- |
| example         | shell       | 200    | https://example.com/             | Example Domain                      | 1         | reached     | no                   | no                                                                            | usable (control)                                           |
| example         | newheadless | 200    | https://example.com/             | Example Domain                      | 1         | reached     | no                   | no                                                                            | usable (control)                                           |
| amazon          | shell       | 202    | https://www.amazon.com/          | Amazon.com. Spend less. Smile more. | 316       | reached     | no                   | no                                                                            | degraded (202 challenge, then the real store)              |
| amazon          | newheadless | 200    | https://www.amazon.com/          | Amazon.com                          | 3         | reached     | no                   | **yes**: "Click the button below to continue shopping" page (regex missed it) | blocked this run (intermittent, see follow-up)             |
| mealkeyway      | shell       | 200    | order.mealkeyway.com/…#/main     | Trizest Resturant - Online Order    | 261       | reached     | no                   | no                                                                            | usable ("Start Order" popup covers the page on load)       |
| mealkeyway      | newheadless | 200    | same                             | Trizest Resturant - Online Order    | 261       | reached     | no                   | no                                                                            | usable                                                     |
| troyroyalpalace | shell       | 404    | https://www.troyroyalpalace.com/ | Squarespace - Website Expired       | 1         | reached     | no                   | no                                                                            | blocked (site dead/expired)                                |
| troyroyalpalace | newheadless | 404    | https://www.troyroyalpalace.com/ | Squarespace - Website Expired       | 1         | reached     | no                   | no                                                                            | blocked (site dead/expired)                                |
| fake-university | shell       | 200    | https://www.fake-university.com/ | _(empty `<title>`)_                 | 77        | reached     | no                   | no                                                                            | usable                                                     |
| fake-university | newheadless | 200    | https://www.fake-university.com/ | _(empty `<title>`)_                 | 77        | reached     | no                   | no                                                                            | usable                                                     |
| cmu             | shell       | 200    | https://www.cmu.edu/             | Carnegie Mellon University \| CMU   | 178       | reached     | yes (`Robot`)        | **no**: false positive on "Community Robotics Innovation Center"              | usable (cookie banner covers the page)                     |
| cmu             | newheadless | 200    | https://www.cmu.edu/             | Carnegie Mellon University \| CMU   | 178       | reached     | yes (`Robot`)        | **no**: same false positive                                                   | usable                                                     |
| troy-k12        | shell       | 200    | https://www.troy.k12.mi.us/      | Home - Troy School District         | 631       | reached     | no                   | no                                                                            | usable                                                     |
| troy-k12        | newheadless | 200    | https://www.troy.k12.mi.us/      | Home - Troy School District         | 613       | reached     | no                   | no                                                                            | usable (focusable count changes by about 3% between loads) |

### BAD (all 17 URLs × 2 modes: identical outcome)

| URL group                                     | mode        | status       | title            | focusable | networkidle   | bot-wall                                                                          | verdict |
| --------------------------------------------- | ----------- | ------------ | ---------------- | --------- | ------------- | --------------------------------------------------------------------------------- | ------- |
| index + 4 before + 4 after + 4 before-reports | shell       | 403 (all 13) | Just a moment... | 2         | timeout (all) | yes (`Just a moment`); screenshot shows the Cloudflare "Verify you are human" box | blocked |
| same 13                                       | newheadless | 403 (all 13) | Just a moment... | 2         | timeout (all) | yes                                                                               | blocked |

The Playwright run covered the index, 4 before pages, 4 after pages and 4 before-reports (13 URLs). The 4 after-reports were only checked with curl (all 200).

## 3. Follow-up (`followup.mjs`)

- **Amazon, 3 more loads per mode, one after another:** shell 3/3 `status:202` and the real store (focusable 329/309/308, networkidle reached). newheadless 3/3 `status:202` and the real store (focusable 328/315/306), but networkidle **timed out on 2 of 3**. Across all runs: shell got the real store 4/4, newheadless 3/4. New headless got the "Continue shopping" page once. Main status is 202 every time except that one bot-page load.
- **w3.org, plain HTTP vs browser:** Playwright's request API (no JavaScript) got `200`, title `Before and After Demonstration: Overview` (9301 bytes) for the index and `200` `Welcome to CityLights! [Inaccessible Home Page]` (24068 bytes) for before/home, `server: cloudflare`. Both browser modes still get `403 "Just a moment..."`, with the default user agent and with a normal desktop Chrome one (no "Headless" in it). Cloudflare is blocking the headless browser itself, not the user-agent string.
- **`bad.zip`** (`https://www.w3.org/WAI/demos/bad/bad.zip`): curl got `200 … 590387 application/zip`, 141 files. It contains all 8 pages and all 8 reports (`before|after/{home,news,tickets,survey}.html`, `before|after/reports/*.html`), dated 2012-02-20. Zip `before/home.html` compared with the live copy: 49 changed lines, all cosmetic (trailing spaces, `http://`→`https://` in the W3C header links). I only compared `before/home.html`. That the other pages match too is ASSUMED.

## BAD URLs (for the vendor fetch script)

Found from the BAD index links (`./before/*.html`, `./after/*.html`) and from the "Report" links on each before page (`./reports/<p>.html`, `../after/reports/<p>.html`).

- Index: https://www.w3.org/WAI/demos/bad/
- Before pages:
  - https://www.w3.org/WAI/demos/bad/before/home.html
  - https://www.w3.org/WAI/demos/bad/before/news.html
  - https://www.w3.org/WAI/demos/bad/before/tickets.html
  - https://www.w3.org/WAI/demos/bad/before/survey.html
- After pages:
  - https://www.w3.org/WAI/demos/bad/after/home.html
  - https://www.w3.org/WAI/demos/bad/after/news.html
  - https://www.w3.org/WAI/demos/bad/after/tickets.html
  - https://www.w3.org/WAI/demos/bad/after/survey.html
- Before-page evaluation reports (labelled "Inaccessible … Report" on each before page):
  - https://www.w3.org/WAI/demos/bad/before/reports/home.html
  - https://www.w3.org/WAI/demos/bad/before/reports/news.html
  - https://www.w3.org/WAI/demos/bad/before/reports/tickets.html
  - https://www.w3.org/WAI/demos/bad/before/reports/survey.html
- After-page reports (also linked from each before page):
  - https://www.w3.org/WAI/demos/bad/after/reports/{home,news,tickets,survey}.html
- The index also links `./before/template.html` and `./after/template.html`, which aren't among the 4 named pages. Whole-demo archive: https://www.w3.org/WAI/demos/bad/bad.zip

Full mealkeyway URL: `https://order.mealkeyway.com/customer/release/index?mid=75452b6a42425a6b4f31646a6e4633415168496f75673d3d#/main`

## Notes for the harness

- The task's bot-wall regex had one miss (the Amazon "Click the button below to continue shopping" page) and one false alarm (`robot` matches "Robotics" on cmu.edu). Consider adding `continue shopping` and changing `robot` to `\brobot\b` or `are you a robot`. I haven't made that change.
- On amazon, don't gate on networkidle. It timed out on 2 of 3 new-headless follow-up loads.

## Reproduce

```
bash ./bench/probes/reach/curl-bad.sh      # inside the sandbox, allowed_domains=["www.w3.org"]
node ./bench/probes/reach/probe.mjs        # outside the sandbox (launches Chromium)
node ./bench/probes/reach/followup.mjs     # outside the sandbox (launches Chromium)
```

Raw output: `probe-run.txt`, `results.json`, `followup-run.txt`, `followup.json`, `curl-bad.txt`, `shots/<site>-<shell|newheadless>.png` (40 files).


## Verifier corrections (2026-09-18, workflow wf_25f6c5c5-8c4)

The verifier reviewed all 40 screenshots and agreed with every usable / degraded / dead / blocked verdict. It re-ran each blocked or degraded site once in the shell, and every verdict was stable. Corrections:

- **Amazon doesn't always start with a 202.** One new-headless load was a direct 200 serving the "continue shopping" bot page. The 202 (CloudFront) → 200 two-navigation sequence is now CONFIRMED by the verifier (0.6s apart); this probe had only inferred it.
- **Amazon at domcontentloaded:** `BrowserPage.goto` uses `waitUntil: 'domcontentloaded'` (packages/browser/src/page.ts:12). At that point Amazon's title is "" (the 202 placeholder). A harness has to wait for the second navigation.
- **networkidle on Amazon also timed out in the shell** (20s budget), so don't gate on networkidle in any mode.
- **BAD is blocked on all 17 URLs in the shell,** including the 4 after-reports (307 → 403, `cf-mitigated: challenge`). New headless was verified on 13 of the 17.
- **troy-k12:** 631 vs 613 focusable is two modes, not two loads. It also has a floating overlay panel over the hero.
