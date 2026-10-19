# Probe: Tab wrap-around in Chromium

Run 2026-09-18 on worktree `bench/detector-eval` @ 6b2f270. Playwright 1.57.0, Chromium 143.0.7499.4 in all three modes.
Nothing under `packages/` was modified; the detector was imported read-only.

## In plain English

**What we checked:** what happens when a keyboard user keeps pressing Tab past the last link on a page, and whether our "keyboard trap" checker mistakes that normal loop for a trap.
**What we found:** in the headless browser the product uses by default, focus leaves the page for one Tab press and then starts again at the top. So every page loops, and the existing checker reports a trap on **all five** test pages, none of which has one.
**Why it matters:** as written, the checker flags almost every small page after five loops. The fix has to recognise "focus reached the end of the page" instead of looking for repetition.

## Answers

1. **Where does focus go after the last element?** It depends on the mode. **Superseded:** it depends on window activation, not the launch mode (see Verifier corrections at the end).
   - **Headless shell** (the default `chromium.launch()`, which is what `BrowserClient` uses, packages/browser/src/client.ts:17-18): the next Tab puts `document.activeElement === document.body` with `document.hasFocus() === false`. The Tab after that goes to the first element. The cycle is F+1, with body on every wrap. This matches the earlier ASSUMED model.
   - **New headless** (`channel: 'chromium'`): wraps alternate. On odd wraps, focus goes **straight from the last element to the first, with no body in between**. On even wraps it passes through body with `hasFocus() === false`. The cycle is 2F+1 and deterministic (identical across 2 runs, and it held for 50 presses).
   - **Headed**: usually the same as new headless, but **not deterministic**. Run and rerun differed, a single walk mixed both wrap types, and 2 of 406 presses coincided with document replacements (see Anomalies).
2. **Does it pass through body?** Shell: every wrap. New headless: every second wrap. Headed: irregular, mostly every second wrap. **Superseded:** with the window activated before every press, every mode passes through body on every wrap (see Verifier corrections).
3. **Is it mode-dependent?** Yes. Shell and new headless differ deterministically, and headed is non-deterministic. Shift+Tab mirrors each mode's pattern. **Refuted in Verifier corrections:** with the window activated before every press, all three modes wrap like the shell.
4. **Does a real recorded sequence make the existing detector report a false trap?** Yes. None of fixtures A–E has a WCAG 2.1.2 trap, so every "trapped" below is a false positive.
   - Headless shell: **all 5 fixtures, both directions, both identity schemes**, trapped at press 5·(F+1) with `cycleLength = F+1`.
   - New headless: **B** (both identity schemes) at press 15 with cycle 3. **D with tools.ts identities** at press 5 with cycle 1, because `a "Read more"` ×6 in a row matches a cycle of length 1. **A, C, D, E** once the walk is long enough: 50-press walks trapped at press 35 (cycle 7) and 45 (C, cycle 9).
   - Headed: B Shift+Tab (cycle 3, press 15), and D with tools.ts identities (cycle 1, press 5 forward / press 9 reverse).
   - Using backendNodeIds instead of tools.ts strings **does not** remove the wrap-around false positive. It only removes D's cycle-1 artefact.

## Per fixture × mode (Tab from a fresh load, `page.goto`)

`!` means `document.hasFocus()` was false. "trap @N" is the first press at which `detectTrap()` returned `trapped: true`, replaying the history press by press. tools = identity strings built by the exact expression in packages/agent/src/tools.ts:221-240 (extracted from the file at run time). node = CDP `backendNodeId`.

| fixture (F) | mode   | observed cycle (one period)                                | period    | body in cycle                        | detector: tools ids                    | detector: backendNodeIds               |
| ----------- | ------ | ---------------------------------------------------------- | --------- | ------------------------------------ | -------------------------------------- | -------------------------------------- |
| A (3)       | shell  | a1 a2 a3 body!                                             | 4         | yes, every wrap                      | trap @20, cyc 4                        | trap @20, cyc 4                        |
| A (3)       | new    | a1 a2 a3 a1 a2 a3 body!                                    | 7         | every 2nd wrap                       | none in 25; trap @35, cyc 7 (50-press) | same                                   |
| A (3)       | headed | run1 aborted at press 12 (page-close); rerun = new pattern | 7 (rerun) | every 2nd wrap                       | none in 25                             | none in 25                             |
| B (1)       | shell  | b1 body!                                                   | 2         | yes                                  | trap @10, cyc 2                        | trap @10, cyc 2                        |
| B (1)       | new    | b1 b1 body!                                                | 3         | every 2nd wrap                       | trap @15, cyc 3                        | trap @15, cyc 3                        |
| B (1)       | headed | irregular (`… b1 b1 body! b1 body! b1 b1 body!`)           | aperiodic | irregular                            | none (fwd); trap @15 cyc 3 (Shift+Tab) | same                                   |
| C (4)       | shell  | c1 c2 c3 c4 body!                                          | 5         | yes                                  | trap @25, cyc 5                        | trap @25, cyc 5                        |
| C (4)       | new    | c1 c2 c3 c4 c1 c2 c3 c4 body!                              | 9         | every 2nd wrap                       | none in 30; trap @45, cyc 9 (50-press) | same                                   |
| C (4)       | headed | same as new                                                | 9         | every 2nd wrap                       | none in 30                             | none in 30                             |
| D (3)       | shell  | r1 r2 r3 body!                                             | 4         | yes                                  | trap @20, cyc 4                        | trap @20, cyc 4                        |
| D (3)       | new    | r1 r2 r3 r1 r2 r3 body!                                    | 7         | every 2nd wrap                       | **trap @5, cyc 1** (`a "Read more"`)   | none in 25; trap @35, cyc 7 (50-press) |
| D (3)       | headed | new pattern, document replaced at press 8                  | aperiodic | every 2nd wrap                       | **trap @5, cyc 1**                     | none                                   |
| E (3)       | shell  | e1 body e3 body!                                           | 4         | yes (post-blur body + wrap body)     | trap @20, cyc 4                        | trap @20, cyc 4                        |
| E (3)       | new    | e1 body e3 e1 body e3 body!                                | 7         | every 2nd wrap (+2 post-blur bodies) | none in 25; trap @35, cyc 7 (50-press) | same                                   |
| E (3)       | headed | new pattern, document replaced at press 13                 | aperiodic | irregular                            | none                                   | none                                   |

- **`page.setContent` vs `page.goto` (fixture A):** identical sequences in shell and new headless, in both directions. In headed mode the setContent Tab walk was irregular (period 11), matching headed's general non-determinism.
- **Shift+Tab from the first element:** in shell, the first Shift+Tab goes to `body!` and then to the last element (period F+1). In new headless it goes **straight to the last element** (period 2F+1). Headed is mixed (run 1 A/goto went to `body!` first; the rerun went straight to a3).
- **Immediate vs 150 ms-settled read:** 0 differences in 1,660 headless presses. In headed there were 2 differences in 406 presses, both at a document replacement.
- **Determinism:** shell and new-headless reruns were byte-identical on every sequence (label + hasFocus). Headed reruns differed on 4 of 6 compared sequences.

## Fixture E (F55: `onfocus="this.blur()"`)

- **Right after the blur:** `activeElement === body`, with `document.hasFocus() === true`, in both the immediate and the settled read. A wrap body has `hasFocus() === false`. In shell and new headless, every body read with `hasFocus === true` was an E post-blur body (shell 12/12, new 14/14, new-long50 28/28), and every wrap body in every fixture had `hasFocus === false`.
- **Next Tab:** focus **continues after the blurred element**, to e3. Chrome keeps its sequential-focus-navigation starting point at the blurred element. Forward instances: shell 12/12 (6 per run × 2 runs), new headless 28/28 (7 + 7 + 14 in the 50-press run), headed 6/7. The one headed exception (`e1 → body → e1`) was a document replacement at that press, not a restart: all backendNodeIds changed (body 14→31, e1 17→34, e3 21→38) with the URL unchanged.
- **Next Shift+Tab** after blurring on the way back from e3: goes to e1 in every mode and every instance.
- **So the F55 page is not a keyboard trap in Chromium**, because focus moves on. The detector still reports 2.1.2 on it in shell mode (cycle 4, press 20). F55 is a failure of 2.1.1/2.4.7/3.2.1, not 2.1.2 (WCAG background knowledge, not something this probe tested).

## Anomalies (reported verbatim, cause unknown)

- Headed run 1, fixture A goto, forward, press 12: `cdpSession.send: Target page, context or browser has been closed`, page events `["page-close"]`. An earlier headed attempt (before per-press error capture existed) failed with the same message during the first fixture, before any fixture finished. It did not recur in the headed rerun (B then A). Cause ASSUMED to be outside the probe (for example, the window being closed or receiving other input); **not confirmed**.
- Headed fixture D press 8 and fixture E press 13: the **document was replaced** (every backendNodeId changed, same URL, no navigation initiated by the page). Both happened shortly after focus had wrapped out of the page to the browser UI. Cause unknown; **not confirmed**.

## What the detector does (read from packages/accessibility/src/keyboard-trap-detector.ts)

- Defaults `{ minCycleCount: 5, maxHistorySize: 50 }` (lines 3-6). tools.ts `executeCheckTrap` passes the same values (packages/agent/src/tools.ts:266). A replay with both configs gave 0 differences.
- `detectTrap()` (lines 31-57) returns trapped as soon as the last `5·L` entries are five identical repeats of any length L ≤ ⌊history/5⌋. That makes it a pure periodicity test. Every page that wraps is periodic, so every page with a short enough cycle gets flagged. From the code (not tested here), cycles longer than 10 can never be flagged, because history is capped at 50 (lines 26-27).
- The identity string (tools.ts:221-240) returns `'body'` for both a wrap body and a post-blur body. It collapses identical elements with no ids (fixture D → `a "Read more"` for all three). Also, `executeTab` with `count > 1` records only the final element (tools.ts:215-218, 245).

## What Phase-1 and F4 must assume

- **Wrap-around is normal, and in every mode it repeats.** Any repetition-only test flags normal pages. Do not infer a trap from a cycle's length or from how many times it repeats.
- **End of page = `activeElement === body && document.hasFocus() === false`**, or a return to the first-visited element's backendNodeId. Both signals are needed, because in new headless the first wrap skips body entirely.
- **Do not assume body appears on every wrap, or that the cycle is F+1.** That holds only in the headless shell. Pin the launch mode (the product default is the headless shell) and record it with every walk. (Superseded: activation, not the mode, decides it; see Verifier corrections.)
- **`body` with `hasFocus() === true` means focus was dropped inside the page** (F55 signal). It is not the end of the page, and the next Tab continues after the dropped element, so the walk must continue past it.
- **Identify elements by backendNodeId, not the tools.ts string**, and reset history when the document is replaced (all ids change).
- **One read per keypress is enough in headless** (0 of 1,660 presses drifted within 150 ms). Headed mode is not a reliable place for scripted walks.
- **A real trap** means focus cycles through only part of the page's tabbable elements and never reaches the end-of-page state, in either direction.

## Reproduce

```
cd .
node bench/probes/wrap/probe.mjs shell            # -> out/shell.json   (needs sandbox disabled: launches Chromium)
node bench/probes/wrap/probe.mjs new              # -> out/new.json
node bench/probes/wrap/probe.mjs headed           # -> out/headed.json  (opens a window)
node bench/probes/wrap/probe.mjs new -long50 a,c,d,e 50
node --import tsx bench/probes/wrap/analyze.ts    # -> out/tables.md (plain `npx tsx` fails in the sandbox: IPC pipe listen EPERM)
```

Arguments: `probe.mjs <shell|new|headed> [outTag] [fixtures] [presses]`. Reruns used `shell -rerun`, `new -rerun` and `headed -rerun b,a`.

---

# Generated tables (out/tables.md, verbatim)
## Per fixture x mode x direction (settled reads)

`!` = document.hasFocus() was false. `imm!=set` = presses where the immediate and the 150ms-settled read differed (label or hasFocus).

| file | fixture/via | dir | F | presses | observed sequence (settled) | period | transient | body/period | imm!=set | detector (tools.ts ids) | detector (backendNodeIds) | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| headed-rerun | b/goto | Tab | 1 | 15/15 | b1 b1 body! b1 b1 body! b1 b1 body! b1 b1 body! b1 body! b1 | none | - | - | 0 | no trap; never trapped | no trap; never trapped |  |
| headed-rerun | b/goto | Shift+Tab | 1 | 15/15 | [from b1] b1 body! b1 b1 body! b1 b1 body! b1 b1 body! b1 b1 body! b1 | 3 | 0 | 1 | 0 | **TRAPPED** cyc=3; first trapped at press 15 cyc=3 el="button#b1 \"Only button\"" | **TRAPPED** cyc=3; first trapped at press 15 cyc=3 el="15" |  |
| headed-rerun | a/goto | Tab | 3 | 25/25 | a1 a2 a3 a1 a2 a3 body! a1 a2 a3 a1 a2 a3 body! a1 a2 a3 a1 a2 a3 body! a1 a2 a3 a1 | 7 | 0 | 1 | 0 | no trap; never trapped | no trap; never trapped |  |
| headed-rerun | a/goto | Shift+Tab | 3 | 25/25 | [from a1] a3 a2 a1 body! a3 a2 a1 a3 a2 a1 body! a3 a2 a1 a3 a2 a1 body! a3 a2 a1 a3 a2 a1 body! | 7 | 0 | 1 | 0 | no trap; never trapped | no trap; never trapped |  |
| headed-rerun | a/setContent | Tab | 3 | 25/25 | a1 a2 a3 a1 a2 a3 body! a1 a2 a3 a1 a2 a3 body! a1 a2 a3 a1 a2 a3 body! a1 a2 a3 a1 | 7 | 0 | 1 | 0 | no trap; never trapped | no trap; never trapped |  |
| headed-rerun | a/setContent | Shift+Tab | 3 | 25/25 | [from a1] a3 a2 a1 body! a3 a2 a1 a3 a2 a1 body! a3 a2 a1 a3 a2 a1 body! a3 a2 a1 a3 a2 a1 body! | 7 | 0 | 1 | 0 | no trap; never trapped | no trap; never trapped |  |
| headed | a/goto | Tab | 3 | 11/25 | a1 a2 a3 a1 a2 a3 body! a1 a2 a3 a1 | none | - | - | 0 | no trap; never trapped | no trap; never trapped | press 12: cdpSession.send: Target page, context or browser has been closed ["page-close"] |
| headed | a/goto | Shift+Tab | 3 | 25/25 | [from a1] body! a3 a2 a1 a3 a2 a1 body! a3 a2 a1 a3 a2 a1 body! a3 a2 a1 a3 a2 a1 body! a3 a2 a1 | 7 | 0 | 1 | 0 | no trap; never trapped | no trap; never trapped |  |
| headed | a/setContent | Tab | 3 | 25/25 | a1 a2 a3 a1 a2 a3 body! a1 a2 a3 a1 a2 a3 body! a1 a2 a3 body! a1 a2 a3 a1 a2 a3 body! | 11 | 3 | 2 | 0 | no trap; never trapped | no trap; never trapped |  |
| headed | a/setContent | Shift+Tab | 3 | 25/25 | [from a1] a3 a2 a1 body! a3 a2 a1 a3 a2 a1 body! a3 a2 a1 a3 a2 a1 body! a3 a2 a1 a3 a2 a1 body! | 7 | 0 | 1 | 0 | no trap; never trapped | no trap; never trapped |  |
| headed | b/goto | Tab | 1 | 15/15 | b1 b1 body! b1 b1 body! b1 b1 body! b1 body! b1 b1 body! b1 | 5 | 4 | 2 | 0 | no trap; never trapped | no trap; never trapped |  |
| headed | b/goto | Shift+Tab | 1 | 15/15 | [from b1] b1 body! b1 b1 body! b1 b1 body! b1 b1 body! b1 b1 body! b1 | 3 | 0 | 1 | 0 | **TRAPPED** cyc=3; first trapped at press 15 cyc=3 el="button#b1 \"Only button\"" | **TRAPPED** cyc=3; first trapped at press 15 cyc=3 el="7" |  |
| headed | c/goto | Tab | 4 | 30/30 | c1 c2 c3 c4 body! c1 c2 c3 c4 c1 c2 c3 c4 body! c1 c2 c3 c4 c1 c2 c3 c4 body! c1 c2 c3 c4 c1 c2 c3 | 9 | 0 | 1 | 0 | no trap; never trapped | no trap; never trapped |  |
| headed | c/goto | Shift+Tab | 4 | 30/30 | [from c1] c4 c3 c2 c1 body! c4 c3 c2 c1 c4 c3 c2 c1 body! c4 c3 c2 c1 c4 c3 c2 c1 body! c4 c3 c2 c1 c4 c3 c2 | 9 | 0 | 1 | 0 | no trap; never trapped | no trap; never trapped |  |
| headed | d/goto | Tab | 3 | 25/25 | r1 r2 r3 r1 r2 r3 body r1 r2 r3 body! r1 r2 r3 body! r1 r2 r3 r1 r2 r3 body! r1 r2 r3 | none | - | - | 1 | no trap; first trapped at press 5 cyc=1 el="a \"Read more\"" | no trap; never trapped | DOCUMENT REPLACED at press 8 (all backendNodeIds changed, same URL) |
| headed | d/goto | Shift+Tab | 3 | 25/25 | [from r1] r3 r2 r1 body! r3 r2 r1 r3 r2 r1 body! r3 r2 r1 r3 r2 r1 body! r3 r2 r1 r3 r2 r1 body! | 7 | 0 | 1 | 0 | no trap; first trapped at press 9 cyc=1 el="a \"Read more\"" | no trap; never trapped |  |
| headed | e/goto | Tab | 3 | 25/25 | e1 body e3 body! e1 body e3 e1 body e3 body! e1 body e1 body e3 body! e1 body e3 body! e1 body e3 e1 | none | - | - | 1 | no trap; never trapped | no trap; never trapped | DOCUMENT REPLACED at press 13 (all backendNodeIds changed, same URL) |
| headed | e/goto | Shift+Tab | 3 | 25/25 | [from e1] e3 body e1 body! e3 body e1 e3 body e1 body! e3 body e1 e3 body e1 body! e3 body e1 e3 body e1 body! | 7 | 0 | 3 | 0 | no trap; never trapped | no trap; never trapped |  |
| new-long50 | a/goto | Tab | 3 | 50/50 | a1 a2 a3 a1 a2 a3 body! a1 a2 a3 a1 a2 a3 body! a1 a2 a3 a1 a2 a3 body! a1 a2 a3 a1 a2 a3 body! a1 a2 a3 a1 a2 a3 body! a1 a2 a3 a1 a2 a3 body! a1 a2 a3 a1 a2 a3 body! a1 | 7 | 0 | 1 | 0 | **TRAPPED** cyc=7; first trapped at press 35 cyc=7 el="a#a1 \"One\"" | **TRAPPED** cyc=7; first trapped at press 35 cyc=7 el="4" |  |
| new-long50 | a/goto | Shift+Tab | 3 | 50/50 | [from a1] a3 a2 a1 body! a3 a2 a1 a3 a2 a1 body! a3 a2 a1 a3 a2 a1 body! a3 a2 a1 a3 a2 a1 body! a3 a2 a1 a3 a2 a1 body! a3 a2 a1 a3 a2 a1 body! a3 a2 a1 a3 a2 a1 body! a3 a2 a1 a3 | 7 | 0 | 1 | 0 | **TRAPPED** cyc=7; first trapped at press 35 cyc=7 el="a#a3 \"Three\"" | **TRAPPED** cyc=7; first trapped at press 35 cyc=7 el="5" |  |
| new-long50 | a/setContent | Tab | 3 | 50/50 | a1 a2 a3 a1 a2 a3 body! a1 a2 a3 a1 a2 a3 body! a1 a2 a3 a1 a2 a3 body! a1 a2 a3 a1 a2 a3 body! a1 a2 a3 a1 a2 a3 body! a1 a2 a3 a1 a2 a3 body! a1 a2 a3 a1 a2 a3 body! a1 | 7 | 0 | 1 | 0 | **TRAPPED** cyc=7; first trapped at press 35 cyc=7 el="a#a1 \"One\"" | **TRAPPED** cyc=7; first trapped at press 35 cyc=7 el="3" |  |
| new-long50 | a/setContent | Shift+Tab | 3 | 50/50 | [from a1] a3 a2 a1 body! a3 a2 a1 a3 a2 a1 body! a3 a2 a1 a3 a2 a1 body! a3 a2 a1 a3 a2 a1 body! a3 a2 a1 a3 a2 a1 body! a3 a2 a1 a3 a2 a1 body! a3 a2 a1 a3 a2 a1 body! a3 a2 a1 a3 | 7 | 0 | 1 | 0 | **TRAPPED** cyc=7; first trapped at press 35 cyc=7 el="a#a3 \"Three\"" | **TRAPPED** cyc=7; first trapped at press 35 cyc=7 el="4" |  |
| new-long50 | c/goto | Tab | 4 | 50/50 | c1 c2 c3 c4 c1 c2 c3 c4 body! c1 c2 c3 c4 c1 c2 c3 c4 body! c1 c2 c3 c4 c1 c2 c3 c4 body! c1 c2 c3 c4 c1 c2 c3 c4 body! c1 c2 c3 c4 c1 c2 c3 c4 body! c1 c2 c3 c4 c1 | 9 | 0 | 1 | 0 | **TRAPPED** cyc=9; first trapped at press 45 cyc=9 el="a#c1 \"First link\"" | **TRAPPED** cyc=9; first trapped at press 45 cyc=9 el="5" |  |
| new-long50 | c/goto | Shift+Tab | 4 | 50/50 | [from c1] c4 c3 c2 c1 body! c4 c3 c2 c1 c4 c3 c2 c1 body! c4 c3 c2 c1 c4 c3 c2 c1 body! c4 c3 c2 c1 c4 c3 c2 c1 body! c4 c3 c2 c1 c4 c3 c2 c1 body! c4 c3 c2 c1 c4 c3 c2 c1 body! | 9 | 0 | 1 | 0 | **TRAPPED** cyc=9; first trapped at press 45 cyc=9 el="button#c4 \"Go\"" | **TRAPPED** cyc=9; first trapped at press 45 cyc=9 el="6" |  |
| new-long50 | d/goto | Tab | 3 | 50/50 | r1 r2 r3 r1 r2 r3 body! r1 r2 r3 r1 r2 r3 body! r1 r2 r3 r1 r2 r3 body! r1 r2 r3 r1 r2 r3 body! r1 r2 r3 r1 r2 r3 body! r1 r2 r3 r1 r2 r3 body! r1 r2 r3 r1 r2 r3 body! r1 | 7 | 0 | 1 | 0 | **TRAPPED** cyc=7; first trapped at press 5 cyc=1 el="a \"Read more\"" | **TRAPPED** cyc=7; first trapped at press 35 cyc=7 el="4" |  |
| new-long50 | d/goto | Shift+Tab | 3 | 50/50 | [from r1] r3 r2 r1 body! r3 r2 r1 r3 r2 r1 body! r3 r2 r1 r3 r2 r1 body! r3 r2 r1 r3 r2 r1 body! r3 r2 r1 r3 r2 r1 body! r3 r2 r1 r3 r2 r1 body! r3 r2 r1 r3 r2 r1 body! r3 r2 r1 r3 | 7 | 0 | 1 | 0 | **TRAPPED** cyc=7; first trapped at press 9 cyc=1 el="a \"Read more\"" | **TRAPPED** cyc=7; first trapped at press 35 cyc=7 el="5" |  |
| new-long50 | e/goto | Tab | 3 | 50/50 | e1 body e3 e1 body e3 body! e1 body e3 e1 body e3 body! e1 body e3 e1 body e3 body! e1 body e3 e1 body e3 body! e1 body e3 e1 body e3 body! e1 body e3 e1 body e3 body! e1 body e3 e1 body e3 body! e1 | 7 | 0 | 3 | 0 | **TRAPPED** cyc=7; first trapped at press 35 cyc=7 el="a#e1 \"Before\"" | **TRAPPED** cyc=7; first trapped at press 35 cyc=7 el="4" |  |
| new-long50 | e/goto | Shift+Tab | 3 | 50/50 | [from e1] e3 body e1 body! e3 body e1 e3 body e1 body! e3 body e1 e3 body e1 body! e3 body e1 e3 body e1 body! e3 body e1 e3 body e1 body! e3 body e1 e3 body e1 body! e3 body e1 e3 body e1 body! e3 body e1 e3 | 7 | 0 | 3 | 0 | **TRAPPED** cyc=7; first trapped at press 35 cyc=7 el="a#e3 \"After\"" | **TRAPPED** cyc=7; first trapped at press 35 cyc=7 el="5" |  |
| new-rerun | a/goto | Tab | 3 | 25/25 | a1 a2 a3 a1 a2 a3 body! a1 a2 a3 a1 a2 a3 body! a1 a2 a3 a1 a2 a3 body! a1 a2 a3 a1 | 7 | 0 | 1 | 0 | no trap; never trapped | no trap; never trapped |  |
| new-rerun | a/goto | Shift+Tab | 3 | 25/25 | [from a1] a3 a2 a1 body! a3 a2 a1 a3 a2 a1 body! a3 a2 a1 a3 a2 a1 body! a3 a2 a1 a3 a2 a1 body! | 7 | 0 | 1 | 0 | no trap; never trapped | no trap; never trapped |  |
| new-rerun | a/setContent | Tab | 3 | 25/25 | a1 a2 a3 a1 a2 a3 body! a1 a2 a3 a1 a2 a3 body! a1 a2 a3 a1 a2 a3 body! a1 a2 a3 a1 | 7 | 0 | 1 | 0 | no trap; never trapped | no trap; never trapped |  |
| new-rerun | a/setContent | Shift+Tab | 3 | 25/25 | [from a1] a3 a2 a1 body! a3 a2 a1 a3 a2 a1 body! a3 a2 a1 a3 a2 a1 body! a3 a2 a1 a3 a2 a1 body! | 7 | 0 | 1 | 0 | no trap; never trapped | no trap; never trapped |  |
| new-rerun | b/goto | Tab | 1 | 15/15 | b1 b1 body! b1 b1 body! b1 b1 body! b1 b1 body! b1 b1 body! | 3 | 0 | 1 | 0 | **TRAPPED** cyc=3; first trapped at press 15 cyc=3 el="button#b1 \"Only button\"" | **TRAPPED** cyc=3; first trapped at press 15 cyc=3 el="4" |  |
| new-rerun | b/goto | Shift+Tab | 1 | 15/15 | [from b1] b1 body! b1 b1 body! b1 b1 body! b1 b1 body! b1 b1 body! b1 | 3 | 0 | 1 | 0 | **TRAPPED** cyc=3; first trapped at press 15 cyc=3 el="button#b1 \"Only button\"" | **TRAPPED** cyc=3; first trapped at press 15 cyc=3 el="2" |  |
| new-rerun | c/goto | Tab | 4 | 30/30 | c1 c2 c3 c4 c1 c2 c3 c4 body! c1 c2 c3 c4 c1 c2 c3 c4 body! c1 c2 c3 c4 c1 c2 c3 c4 body! c1 c2 c3 | 9 | 0 | 1 | 0 | no trap; never trapped | no trap; never trapped |  |
| new-rerun | c/goto | Shift+Tab | 4 | 30/30 | [from c1] c4 c3 c2 c1 body! c4 c3 c2 c1 c4 c3 c2 c1 body! c4 c3 c2 c1 c4 c3 c2 c1 body! c4 c3 c2 c1 c4 c3 c2 | 9 | 0 | 1 | 0 | no trap; never trapped | no trap; never trapped |  |
| new-rerun | d/goto | Tab | 3 | 25/25 | r1 r2 r3 r1 r2 r3 body! r1 r2 r3 r1 r2 r3 body! r1 r2 r3 r1 r2 r3 body! r1 r2 r3 r1 | 7 | 0 | 1 | 0 | no trap; first trapped at press 5 cyc=1 el="a \"Read more\"" | no trap; never trapped |  |
| new-rerun | d/goto | Shift+Tab | 3 | 25/25 | [from r1] r3 r2 r1 body! r3 r2 r1 r3 r2 r1 body! r3 r2 r1 r3 r2 r1 body! r3 r2 r1 r3 r2 r1 body! | 7 | 0 | 1 | 0 | no trap; first trapped at press 9 cyc=1 el="a \"Read more\"" | no trap; never trapped |  |
| new-rerun | e/goto | Tab | 3 | 25/25 | e1 body e3 e1 body e3 body! e1 body e3 e1 body e3 body! e1 body e3 e1 body e3 body! e1 body e3 e1 | 7 | 0 | 3 | 0 | no trap; never trapped | no trap; never trapped |  |
| new-rerun | e/goto | Shift+Tab | 3 | 25/25 | [from e1] e3 body e1 body! e3 body e1 e3 body e1 body! e3 body e1 e3 body e1 body! e3 body e1 e3 body e1 body! | 7 | 0 | 3 | 0 | no trap; never trapped | no trap; never trapped |  |
| new | a/goto | Tab | 3 | 25/25 | a1 a2 a3 a1 a2 a3 body! a1 a2 a3 a1 a2 a3 body! a1 a2 a3 a1 a2 a3 body! a1 a2 a3 a1 | 7 | 0 | 1 | 0 | no trap; never trapped | no trap; never trapped |  |
| new | a/goto | Shift+Tab | 3 | 25/25 | [from a1] a3 a2 a1 body! a3 a2 a1 a3 a2 a1 body! a3 a2 a1 a3 a2 a1 body! a3 a2 a1 a3 a2 a1 body! | 7 | 0 | 1 | 0 | no trap; never trapped | no trap; never trapped |  |
| new | a/setContent | Tab | 3 | 25/25 | a1 a2 a3 a1 a2 a3 body! a1 a2 a3 a1 a2 a3 body! a1 a2 a3 a1 a2 a3 body! a1 a2 a3 a1 | 7 | 0 | 1 | 0 | no trap; never trapped | no trap; never trapped |  |
| new | a/setContent | Shift+Tab | 3 | 25/25 | [from a1] a3 a2 a1 body! a3 a2 a1 a3 a2 a1 body! a3 a2 a1 a3 a2 a1 body! a3 a2 a1 a3 a2 a1 body! | 7 | 0 | 1 | 0 | no trap; never trapped | no trap; never trapped |  |
| new | b/goto | Tab | 1 | 15/15 | b1 b1 body! b1 b1 body! b1 b1 body! b1 b1 body! b1 b1 body! | 3 | 0 | 1 | 0 | **TRAPPED** cyc=3; first trapped at press 15 cyc=3 el="button#b1 \"Only button\"" | **TRAPPED** cyc=3; first trapped at press 15 cyc=3 el="4" |  |
| new | b/goto | Shift+Tab | 1 | 15/15 | [from b1] b1 body! b1 b1 body! b1 b1 body! b1 b1 body! b1 b1 body! b1 | 3 | 0 | 1 | 0 | **TRAPPED** cyc=3; first trapped at press 15 cyc=3 el="button#b1 \"Only button\"" | **TRAPPED** cyc=3; first trapped at press 15 cyc=3 el="2" |  |
| new | c/goto | Tab | 4 | 30/30 | c1 c2 c3 c4 c1 c2 c3 c4 body! c1 c2 c3 c4 c1 c2 c3 c4 body! c1 c2 c3 c4 c1 c2 c3 c4 body! c1 c2 c3 | 9 | 0 | 1 | 0 | no trap; never trapped | no trap; never trapped |  |
| new | c/goto | Shift+Tab | 4 | 30/30 | [from c1] c4 c3 c2 c1 body! c4 c3 c2 c1 c4 c3 c2 c1 body! c4 c3 c2 c1 c4 c3 c2 c1 body! c4 c3 c2 c1 c4 c3 c2 | 9 | 0 | 1 | 0 | no trap; never trapped | no trap; never trapped |  |
| new | d/goto | Tab | 3 | 25/25 | r1 r2 r3 r1 r2 r3 body! r1 r2 r3 r1 r2 r3 body! r1 r2 r3 r1 r2 r3 body! r1 r2 r3 r1 | 7 | 0 | 1 | 0 | no trap; first trapped at press 5 cyc=1 el="a \"Read more\"" | no trap; never trapped |  |
| new | d/goto | Shift+Tab | 3 | 25/25 | [from r1] r3 r2 r1 body! r3 r2 r1 r3 r2 r1 body! r3 r2 r1 r3 r2 r1 body! r3 r2 r1 r3 r2 r1 body! | 7 | 0 | 1 | 0 | no trap; first trapped at press 9 cyc=1 el="a \"Read more\"" | no trap; never trapped |  |
| new | e/goto | Tab | 3 | 25/25 | e1 body e3 e1 body e3 body! e1 body e3 e1 body e3 body! e1 body e3 e1 body e3 body! e1 body e3 e1 | 7 | 0 | 3 | 0 | no trap; never trapped | no trap; never trapped |  |
| new | e/goto | Shift+Tab | 3 | 25/25 | [from e1] e3 body e1 body! e3 body e1 e3 body e1 body! e3 body e1 e3 body e1 body! e3 body e1 e3 body e1 body! | 7 | 0 | 3 | 0 | no trap; never trapped | no trap; never trapped |  |
| shell-rerun | a/goto | Tab | 3 | 25/25 | a1 a2 a3 body! a1 a2 a3 body! a1 a2 a3 body! a1 a2 a3 body! a1 a2 a3 body! a1 a2 a3 body! a1 | 4 | 0 | 1 | 0 | **TRAPPED** cyc=4; first trapped at press 20 cyc=4 el="a#a1 \"One\"" | **TRAPPED** cyc=4; first trapped at press 20 cyc=4 el="3" |  |
| shell-rerun | a/goto | Shift+Tab | 3 | 25/25 | [from a1] body! a3 a2 a1 body! a3 a2 a1 body! a3 a2 a1 body! a3 a2 a1 body! a3 a2 a1 body! a3 a2 a1 body! | 4 | 0 | 1 | 0 | **TRAPPED** cyc=4; first trapped at press 20 cyc=4 el="body" | **TRAPPED** cyc=4; first trapped at press 20 cyc=4 el="5" |  |
| shell-rerun | a/setContent | Tab | 3 | 25/25 | a1 a2 a3 body! a1 a2 a3 body! a1 a2 a3 body! a1 a2 a3 body! a1 a2 a3 body! a1 a2 a3 body! a1 | 4 | 0 | 1 | 0 | **TRAPPED** cyc=4; first trapped at press 20 cyc=4 el="a#a1 \"One\"" | **TRAPPED** cyc=4; first trapped at press 20 cyc=4 el="3" |  |
| shell-rerun | a/setContent | Shift+Tab | 3 | 25/25 | [from a1] body! a3 a2 a1 body! a3 a2 a1 body! a3 a2 a1 body! a3 a2 a1 body! a3 a2 a1 body! a3 a2 a1 body! | 4 | 0 | 1 | 0 | **TRAPPED** cyc=4; first trapped at press 20 cyc=4 el="body" | **TRAPPED** cyc=4; first trapped at press 20 cyc=4 el="4" |  |
| shell-rerun | b/goto | Tab | 1 | 15/15 | b1 body! b1 body! b1 body! b1 body! b1 body! b1 body! b1 body! b1 | 2 | 0 | 1 | 0 | **TRAPPED** cyc=2; first trapped at press 10 cyc=2 el="button#b1 \"Only button\"" | **TRAPPED** cyc=2; first trapped at press 10 cyc=2 el="4" |  |
| shell-rerun | b/goto | Shift+Tab | 1 | 15/15 | [from b1] body! b1 body! b1 body! b1 body! b1 body! b1 body! b1 body! b1 body! | 2 | 0 | 1 | 0 | **TRAPPED** cyc=2; first trapped at press 10 cyc=2 el="body" | **TRAPPED** cyc=2; first trapped at press 10 cyc=2 el="5" |  |
| shell-rerun | c/goto | Tab | 4 | 30/30 | c1 c2 c3 c4 body! c1 c2 c3 c4 body! c1 c2 c3 c4 body! c1 c2 c3 c4 body! c1 c2 c3 c4 body! c1 c2 c3 c4 body! | 5 | 0 | 1 | 0 | **TRAPPED** cyc=5; first trapped at press 25 cyc=5 el="a#c1 \"First link\"" | **TRAPPED** cyc=5; first trapped at press 25 cyc=5 el="4" |  |
| shell-rerun | c/goto | Shift+Tab | 4 | 30/30 | [from c1] body! c4 c3 c2 c1 body! c4 c3 c2 c1 body! c4 c3 c2 c1 body! c4 c3 c2 c1 body! c4 c3 c2 c1 body! c4 c3 c2 c1 | 5 | 0 | 1 | 0 | **TRAPPED** cyc=5; first trapped at press 25 cyc=5 el="body" | **TRAPPED** cyc=5; first trapped at press 25 cyc=5 el="5" |  |
| shell-rerun | d/goto | Tab | 3 | 25/25 | r1 r2 r3 body! r1 r2 r3 body! r1 r2 r3 body! r1 r2 r3 body! r1 r2 r3 body! r1 r2 r3 body! r1 | 4 | 0 | 1 | 0 | **TRAPPED** cyc=4; first trapped at press 20 cyc=4 el="a \"Read more\"" | **TRAPPED** cyc=4; first trapped at press 20 cyc=4 el="4" |  |
| shell-rerun | d/goto | Shift+Tab | 3 | 25/25 | [from r1] body! r3 r2 r1 body! r3 r2 r1 body! r3 r2 r1 body! r3 r2 r1 body! r3 r2 r1 body! r3 r2 r1 body! | 4 | 0 | 1 | 0 | **TRAPPED** cyc=4; first trapped at press 20 cyc=4 el="body" | **TRAPPED** cyc=4; first trapped at press 20 cyc=4 el="5" |  |
| shell-rerun | e/goto | Tab | 3 | 25/25 | e1 body e3 body! e1 body e3 body! e1 body e3 body! e1 body e3 body! e1 body e3 body! e1 body e3 body! e1 | 4 | 0 | 2 | 0 | **TRAPPED** cyc=4; first trapped at press 20 cyc=4 el="a#e1 \"Before\"" | **TRAPPED** cyc=4; first trapped at press 20 cyc=4 el="4" |  |
| shell-rerun | e/goto | Shift+Tab | 3 | 25/25 | [from e1] body! e3 body e1 body! e3 body e1 body! e3 body e1 body! e3 body e1 body! e3 body e1 body! e3 body e1 body! | 4 | 0 | 2 | 0 | **TRAPPED** cyc=4; first trapped at press 20 cyc=4 el="body" | **TRAPPED** cyc=4; first trapped at press 20 cyc=4 el="5" |  |
| shell | a/goto | Tab | 3 | 25/25 | a1 a2 a3 body! a1 a2 a3 body! a1 a2 a3 body! a1 a2 a3 body! a1 a2 a3 body! a1 a2 a3 body! a1 | 4 | 0 | 1 | 0 | **TRAPPED** cyc=4; first trapped at press 20 cyc=4 el="a#a1 \"One\"" | **TRAPPED** cyc=4; first trapped at press 20 cyc=4 el="4" |  |
| shell | a/goto | Shift+Tab | 3 | 25/25 | [from a1] body! a3 a2 a1 body! a3 a2 a1 body! a3 a2 a1 body! a3 a2 a1 body! a3 a2 a1 body! a3 a2 a1 body! | 4 | 0 | 1 | 0 | **TRAPPED** cyc=4; first trapped at press 20 cyc=4 el="body" | **TRAPPED** cyc=4; first trapped at press 20 cyc=4 el="5" |  |
| shell | a/setContent | Tab | 3 | 25/25 | a1 a2 a3 body! a1 a2 a3 body! a1 a2 a3 body! a1 a2 a3 body! a1 a2 a3 body! a1 a2 a3 body! a1 | 4 | 0 | 1 | 0 | **TRAPPED** cyc=4; first trapped at press 20 cyc=4 el="a#a1 \"One\"" | **TRAPPED** cyc=4; first trapped at press 20 cyc=4 el="3" |  |
| shell | a/setContent | Shift+Tab | 3 | 25/25 | [from a1] body! a3 a2 a1 body! a3 a2 a1 body! a3 a2 a1 body! a3 a2 a1 body! a3 a2 a1 body! a3 a2 a1 body! | 4 | 0 | 1 | 0 | **TRAPPED** cyc=4; first trapped at press 20 cyc=4 el="body" | **TRAPPED** cyc=4; first trapped at press 20 cyc=4 el="4" |  |
| shell | b/goto | Tab | 1 | 15/15 | b1 body! b1 body! b1 body! b1 body! b1 body! b1 body! b1 body! b1 | 2 | 0 | 1 | 0 | **TRAPPED** cyc=2; first trapped at press 10 cyc=2 el="button#b1 \"Only button\"" | **TRAPPED** cyc=2; first trapped at press 10 cyc=2 el="4" |  |
| shell | b/goto | Shift+Tab | 1 | 15/15 | [from b1] body! b1 body! b1 body! b1 body! b1 body! b1 body! b1 body! b1 body! | 2 | 0 | 1 | 0 | **TRAPPED** cyc=2; first trapped at press 10 cyc=2 el="body" | **TRAPPED** cyc=2; first trapped at press 10 cyc=2 el="5" |  |
| shell | c/goto | Tab | 4 | 30/30 | c1 c2 c3 c4 body! c1 c2 c3 c4 body! c1 c2 c3 c4 body! c1 c2 c3 c4 body! c1 c2 c3 c4 body! c1 c2 c3 c4 body! | 5 | 0 | 1 | 0 | **TRAPPED** cyc=5; first trapped at press 25 cyc=5 el="a#c1 \"First link\"" | **TRAPPED** cyc=5; first trapped at press 25 cyc=5 el="4" |  |
| shell | c/goto | Shift+Tab | 4 | 30/30 | [from c1] body! c4 c3 c2 c1 body! c4 c3 c2 c1 body! c4 c3 c2 c1 body! c4 c3 c2 c1 body! c4 c3 c2 c1 body! c4 c3 c2 c1 | 5 | 0 | 1 | 0 | **TRAPPED** cyc=5; first trapped at press 25 cyc=5 el="body" | **TRAPPED** cyc=5; first trapped at press 25 cyc=5 el="5" |  |
| shell | d/goto | Tab | 3 | 25/25 | r1 r2 r3 body! r1 r2 r3 body! r1 r2 r3 body! r1 r2 r3 body! r1 r2 r3 body! r1 r2 r3 body! r1 | 4 | 0 | 1 | 0 | **TRAPPED** cyc=4; first trapped at press 20 cyc=4 el="a \"Read more\"" | **TRAPPED** cyc=4; first trapped at press 20 cyc=4 el="4" |  |
| shell | d/goto | Shift+Tab | 3 | 25/25 | [from r1] body! r3 r2 r1 body! r3 r2 r1 body! r3 r2 r1 body! r3 r2 r1 body! r3 r2 r1 body! r3 r2 r1 body! | 4 | 0 | 1 | 0 | **TRAPPED** cyc=4; first trapped at press 20 cyc=4 el="body" | **TRAPPED** cyc=4; first trapped at press 20 cyc=4 el="5" |  |
| shell | e/goto | Tab | 3 | 25/25 | e1 body e3 body! e1 body e3 body! e1 body e3 body! e1 body e3 body! e1 body e3 body! e1 body e3 body! e1 | 4 | 0 | 2 | 0 | **TRAPPED** cyc=4; first trapped at press 20 cyc=4 el="a#e1 \"Before\"" | **TRAPPED** cyc=4; first trapped at press 20 cyc=4 el="4" |  |
| shell | e/goto | Shift+Tab | 3 | 25/25 | [from e1] body! e3 body e1 body! e3 body e1 body! e3 body e1 body! e3 body e1 body! e3 body e1 body! e3 body e1 body! | 4 | 0 | 2 | 0 | **TRAPPED** cyc=4; first trapped at press 20 cyc=4 el="body" | **TRAPPED** cyc=4; first trapped at press 20 cyc=4 el="5" |  |

Detector: default config vs tools.ts config {minCycleCount:5,maxHistorySize:50} mismatches: 0

## Cycle period per mode (settled labels)

| fixture/via/dir | headed-rerun | headed | new-long50 | new-rerun | new | shell-rerun | shell |
|---|---|---|---|---|---|---|---|
| b/goto/forward | aperiodic | p=5 | - | p=3 | p=3 | p=2 | p=2 |
| b/goto/reverse | p=3 | p=3 | - | p=3 | p=3 | p=2 | p=2 |
| a/goto/forward | p=7 | aperiodic | p=7 | p=7 | p=7 | p=4 | p=4 |
| a/goto/reverse | p=7 | p=7 | p=7 | p=7 | p=7 | p=4 | p=4 |
| a/setContent/forward | p=7 | p=11 | p=7 | p=7 | p=7 | p=4 | p=4 |
| a/setContent/reverse | p=7 | p=7 | p=7 | p=7 | p=7 | p=4 | p=4 |
| c/goto/forward | - | p=9 | p=9 | p=9 | p=9 | p=5 | p=5 |
| c/goto/reverse | - | p=9 | p=9 | p=9 | p=9 | p=5 | p=5 |
| d/goto/forward | - | aperiodic | p=7 | p=7 | p=7 | p=4 | p=4 |
| d/goto/reverse | - | p=7 | p=7 | p=7 | p=7 | p=4 | p=4 |
| e/goto/forward | - | aperiodic | p=7 | p=7 | p=7 | p=4 | p=4 |
| e/goto/reverse | - | p=7 | p=7 | p=7 | p=7 | p=4 | p=4 |

## Run vs rerun (identical settled label+hasFocus sequence?)

- b/goto/forward shell: IDENTICAL
- b/goto/forward new: IDENTICAL
- b/goto/forward headed: DIFFERENT
- b/goto/reverse shell: IDENTICAL
- b/goto/reverse new: IDENTICAL
- b/goto/reverse headed: IDENTICAL
- a/goto/forward shell: IDENTICAL
- a/goto/forward new: IDENTICAL
- a/goto/forward headed: DIFFERENT
- a/goto/reverse shell: IDENTICAL
- a/goto/reverse new: IDENTICAL
- a/goto/reverse headed: DIFFERENT
- a/setContent/forward shell: IDENTICAL
- a/setContent/forward new: IDENTICAL
- a/setContent/forward headed: DIFFERENT
- a/setContent/reverse shell: IDENTICAL
- a/setContent/reverse new: IDENTICAL
- a/setContent/reverse headed: IDENTICAL
- c/goto/forward shell: IDENTICAL
- c/goto/forward new: IDENTICAL
- c/goto/reverse shell: IDENTICAL
- c/goto/reverse new: IDENTICAL
- d/goto/forward shell: IDENTICAL
- d/goto/forward new: IDENTICAL
- d/goto/reverse shell: IDENTICAL
- d/goto/reverse new: IDENTICAL
- e/goto/forward shell: IDENTICAL
- e/goto/forward new: IDENTICAL
- e/goto/reverse shell: IDENTICAL
- e/goto/reverse new: IDENTICAL

## Fixture E: where focus is after the blur, and where the next key goes

- headed forward press 2: e1 -> [Tab] -> body(hasFocus=true, id=14, imm=body) -> next: e3
- headed forward press 6: e1 -> [Tab] -> body(hasFocus=true, id=14, imm=body) -> next: e3
- headed forward press 9: e1 -> [Tab] -> body(hasFocus=true, id=14, imm=body) -> next: e3
- headed forward press 13: e1 -> [Tab] -> body(hasFocus=true, id=31, imm=body) -> next: e1 [NOT a blur: document was replaced at this press]
- headed forward press 15: e1 -> [Tab] -> body(hasFocus=true, id=31, imm=body) -> next: e3
- headed forward press 19: e1 -> [Tab] -> body(hasFocus=true, id=31, imm=body) -> next: e3
- headed forward press 23: e1 -> [Tab] -> body(hasFocus=true, id=31, imm=body) -> next: e3
- headed reverse press 2: e3 -> [Shift+Tab] -> body(hasFocus=true, id=14, imm=body) -> next: e1
- headed reverse press 6: e3 -> [Shift+Tab] -> body(hasFocus=true, id=14, imm=body) -> next: e1
- headed reverse press 9: e3 -> [Shift+Tab] -> body(hasFocus=true, id=14, imm=body) -> next: e1
- headed reverse press 13: e3 -> [Shift+Tab] -> body(hasFocus=true, id=14, imm=body) -> next: e1
- headed reverse press 16: e3 -> [Shift+Tab] -> body(hasFocus=true, id=14, imm=body) -> next: e1
- headed reverse press 20: e3 -> [Shift+Tab] -> body(hasFocus=true, id=14, imm=body) -> next: e1
- headed reverse press 23: e3 -> [Shift+Tab] -> body(hasFocus=true, id=14, imm=body) -> next: e1
- new-long50 forward press 2: e1 -> [Tab] -> body(hasFocus=true, id=2, imm=body) -> next: e3
- new-long50 forward press 5: e1 -> [Tab] -> body(hasFocus=true, id=2, imm=body) -> next: e3
- new-long50 forward press 9: e1 -> [Tab] -> body(hasFocus=true, id=2, imm=body) -> next: e3
- new-long50 forward press 12: e1 -> [Tab] -> body(hasFocus=true, id=2, imm=body) -> next: e3
- new-long50 forward press 16: e1 -> [Tab] -> body(hasFocus=true, id=2, imm=body) -> next: e3
- new-long50 forward press 19: e1 -> [Tab] -> body(hasFocus=true, id=2, imm=body) -> next: e3
- new-long50 forward press 23: e1 -> [Tab] -> body(hasFocus=true, id=2, imm=body) -> next: e3
- new-long50 forward press 26: e1 -> [Tab] -> body(hasFocus=true, id=2, imm=body) -> next: e3
- new-long50 forward press 30: e1 -> [Tab] -> body(hasFocus=true, id=2, imm=body) -> next: e3
- new-long50 forward press 33: e1 -> [Tab] -> body(hasFocus=true, id=2, imm=body) -> next: e3
- new-long50 forward press 37: e1 -> [Tab] -> body(hasFocus=true, id=2, imm=body) -> next: e3
- new-long50 forward press 40: e1 -> [Tab] -> body(hasFocus=true, id=2, imm=body) -> next: e3
- new-long50 forward press 44: e1 -> [Tab] -> body(hasFocus=true, id=2, imm=body) -> next: e3
- new-long50 forward press 47: e1 -> [Tab] -> body(hasFocus=true, id=2, imm=body) -> next: e3
- new-long50 reverse press 2: e3 -> [Shift+Tab] -> body(hasFocus=true, id=6, imm=body) -> next: e1
- new-long50 reverse press 6: e3 -> [Shift+Tab] -> body(hasFocus=true, id=6, imm=body) -> next: e1
- new-long50 reverse press 9: e3 -> [Shift+Tab] -> body(hasFocus=true, id=6, imm=body) -> next: e1
- new-long50 reverse press 13: e3 -> [Shift+Tab] -> body(hasFocus=true, id=6, imm=body) -> next: e1
- new-long50 reverse press 16: e3 -> [Shift+Tab] -> body(hasFocus=true, id=6, imm=body) -> next: e1
- new-long50 reverse press 20: e3 -> [Shift+Tab] -> body(hasFocus=true, id=6, imm=body) -> next: e1
- new-long50 reverse press 23: e3 -> [Shift+Tab] -> body(hasFocus=true, id=6, imm=body) -> next: e1
- new-long50 reverse press 27: e3 -> [Shift+Tab] -> body(hasFocus=true, id=6, imm=body) -> next: e1
- new-long50 reverse press 30: e3 -> [Shift+Tab] -> body(hasFocus=true, id=6, imm=body) -> next: e1
- new-long50 reverse press 34: e3 -> [Shift+Tab] -> body(hasFocus=true, id=6, imm=body) -> next: e1
- new-long50 reverse press 37: e3 -> [Shift+Tab] -> body(hasFocus=true, id=6, imm=body) -> next: e1
- new-long50 reverse press 41: e3 -> [Shift+Tab] -> body(hasFocus=true, id=6, imm=body) -> next: e1
- new-long50 reverse press 44: e3 -> [Shift+Tab] -> body(hasFocus=true, id=6, imm=body) -> next: e1
- new-long50 reverse press 48: e3 -> [Shift+Tab] -> body(hasFocus=true, id=6, imm=body) -> next: e1
- new-rerun forward press 2: e1 -> [Tab] -> body(hasFocus=true, id=2, imm=body) -> next: e3
- new-rerun forward press 5: e1 -> [Tab] -> body(hasFocus=true, id=2, imm=body) -> next: e3
- new-rerun forward press 9: e1 -> [Tab] -> body(hasFocus=true, id=2, imm=body) -> next: e3
- new-rerun forward press 12: e1 -> [Tab] -> body(hasFocus=true, id=2, imm=body) -> next: e3
- new-rerun forward press 16: e1 -> [Tab] -> body(hasFocus=true, id=2, imm=body) -> next: e3
- new-rerun forward press 19: e1 -> [Tab] -> body(hasFocus=true, id=2, imm=body) -> next: e3
- new-rerun forward press 23: e1 -> [Tab] -> body(hasFocus=true, id=2, imm=body) -> next: e3
- new-rerun reverse press 2: e3 -> [Shift+Tab] -> body(hasFocus=true, id=6, imm=body) -> next: e1
- new-rerun reverse press 6: e3 -> [Shift+Tab] -> body(hasFocus=true, id=6, imm=body) -> next: e1
- new-rerun reverse press 9: e3 -> [Shift+Tab] -> body(hasFocus=true, id=6, imm=body) -> next: e1
- new-rerun reverse press 13: e3 -> [Shift+Tab] -> body(hasFocus=true, id=6, imm=body) -> next: e1
- new-rerun reverse press 16: e3 -> [Shift+Tab] -> body(hasFocus=true, id=6, imm=body) -> next: e1
- new-rerun reverse press 20: e3 -> [Shift+Tab] -> body(hasFocus=true, id=6, imm=body) -> next: e1
- new-rerun reverse press 23: e3 -> [Shift+Tab] -> body(hasFocus=true, id=6, imm=body) -> next: e1
- new forward press 2: e1 -> [Tab] -> body(hasFocus=true, id=3, imm=body) -> next: e3
- new forward press 5: e1 -> [Tab] -> body(hasFocus=true, id=3, imm=body) -> next: e3
- new forward press 9: e1 -> [Tab] -> body(hasFocus=true, id=3, imm=body) -> next: e3
- new forward press 12: e1 -> [Tab] -> body(hasFocus=true, id=3, imm=body) -> next: e3
- new forward press 16: e1 -> [Tab] -> body(hasFocus=true, id=3, imm=body) -> next: e3
- new forward press 19: e1 -> [Tab] -> body(hasFocus=true, id=3, imm=body) -> next: e3
- new forward press 23: e1 -> [Tab] -> body(hasFocus=true, id=3, imm=body) -> next: e3
- new reverse press 2: e3 -> [Shift+Tab] -> body(hasFocus=true, id=6, imm=body) -> next: e1
- new reverse press 6: e3 -> [Shift+Tab] -> body(hasFocus=true, id=6, imm=body) -> next: e1
- new reverse press 9: e3 -> [Shift+Tab] -> body(hasFocus=true, id=6, imm=body) -> next: e1
- new reverse press 13: e3 -> [Shift+Tab] -> body(hasFocus=true, id=6, imm=body) -> next: e1
- new reverse press 16: e3 -> [Shift+Tab] -> body(hasFocus=true, id=6, imm=body) -> next: e1
- new reverse press 20: e3 -> [Shift+Tab] -> body(hasFocus=true, id=6, imm=body) -> next: e1
- new reverse press 23: e3 -> [Shift+Tab] -> body(hasFocus=true, id=6, imm=body) -> next: e1
- shell-rerun forward press 2: e1 -> [Tab] -> body(hasFocus=true, id=3, imm=body) -> next: e3
- shell-rerun forward press 6: e1 -> [Tab] -> body(hasFocus=true, id=3, imm=body) -> next: e3
- shell-rerun forward press 10: e1 -> [Tab] -> body(hasFocus=true, id=3, imm=body) -> next: e3
- shell-rerun forward press 14: e1 -> [Tab] -> body(hasFocus=true, id=3, imm=body) -> next: e3
- shell-rerun forward press 18: e1 -> [Tab] -> body(hasFocus=true, id=3, imm=body) -> next: e3
- shell-rerun forward press 22: e1 -> [Tab] -> body(hasFocus=true, id=3, imm=body) -> next: e3
- shell-rerun reverse press 3: e3 -> [Shift+Tab] -> body(hasFocus=true, id=5, imm=body) -> next: e1
- shell-rerun reverse press 7: e3 -> [Shift+Tab] -> body(hasFocus=true, id=5, imm=body) -> next: e1
- shell-rerun reverse press 11: e3 -> [Shift+Tab] -> body(hasFocus=true, id=5, imm=body) -> next: e1
- shell-rerun reverse press 15: e3 -> [Shift+Tab] -> body(hasFocus=true, id=5, imm=body) -> next: e1
- shell-rerun reverse press 19: e3 -> [Shift+Tab] -> body(hasFocus=true, id=5, imm=body) -> next: e1
- shell-rerun reverse press 23: e3 -> [Shift+Tab] -> body(hasFocus=true, id=5, imm=body) -> next: e1
- shell forward press 2: e1 -> [Tab] -> body(hasFocus=true, id=3, imm=body) -> next: e3
- shell forward press 6: e1 -> [Tab] -> body(hasFocus=true, id=3, imm=body) -> next: e3
- shell forward press 10: e1 -> [Tab] -> body(hasFocus=true, id=3, imm=body) -> next: e3
- shell forward press 14: e1 -> [Tab] -> body(hasFocus=true, id=3, imm=body) -> next: e3
- shell forward press 18: e1 -> [Tab] -> body(hasFocus=true, id=3, imm=body) -> next: e3
- shell forward press 22: e1 -> [Tab] -> body(hasFocus=true, id=3, imm=body) -> next: e3
- shell reverse press 3: e3 -> [Shift+Tab] -> body(hasFocus=true, id=5, imm=body) -> next: e1
- shell reverse press 7: e3 -> [Shift+Tab] -> body(hasFocus=true, id=5, imm=body) -> next: e1
- shell reverse press 11: e3 -> [Shift+Tab] -> body(hasFocus=true, id=5, imm=body) -> next: e1
- shell reverse press 15: e3 -> [Shift+Tab] -> body(hasFocus=true, id=5, imm=body) -> next: e1
- shell reverse press 19: e3 -> [Shift+Tab] -> body(hasFocus=true, id=5, imm=body) -> next: e1
- shell reverse press 23: e3 -> [Shift+Tab] -> body(hasFocus=true, id=5, imm=body) -> next: e1

## Distinct tools.ts identity strings seen per fixture

- b: "button#b1 \"Only button\"", "body"
- a: "a#a1 \"One\"", "a#a2 \"Two\"", "a#a3 \"Three\"", "body"
- c: "a#c1 \"First link\"", "a#c2 \"Second link\"", "input#c3 \"q\"", "button#c4 \"Go\"", "body"
- d: "a \"Read more\"", "body"
- e: "a#e1 \"Before\"", "body", "a#e3 \"After\""


## Verifier corrections (2026-09-18, workflow wf_25f6c5c5-8c4)

Two independent verifiers reproduced the shell-mode results and the false-trap verdicts. The artifact verifier re-ran them through the real `BrowserClient` + `executeAction` code: A=20, B=10, C=25, D=20, E=20 presses. Corrections:

- **Refuted: the "mode-dependent" framing.** The new-headless/headed pattern ("odd wraps skip body, cycle 2F+1") depends on tab/window activation, not on the launch mode. With `page.bringToFront()` before every Tab, new headless and headed wrap exactly like the shell: last element → body (`hasFocus()` false) → first element, cycle F+1. Calling it once shifts the phase. The new-headless trap verdicts listed above (B at press 15, D at press 5) depend on the harness; with bringToFront on every press they become B at 10 and D at 20.
- **Headed non-determinism was not reproduced** (2 runs, identical). The likely cause is the same activation effect (ASSUMED).
- **The headless shell is stable** under every artifact tried: settle 0/150/600ms, key delay, goto vs setContent, domcontentloaded vs load, clicking first, bringToFront, raw CDP key events.
- **Now exercised:** `executeTab` with count>1. In the shell, count=4 flags A, D and E as cycle-1 traps after 5 tab actions. This matches the L/gcd(k,L) prediction: L=4, k=4, so the period is 1.
- **Start state:** before any keypress, focus is on body with `hasFocus()` true. The "body and hasFocus true means focus was lost" rule applies only to reads that follow a keypress from a real element.
- **Record the launch mode by channel or executable, not the version string.** Shell and new headless both report 143.0.7499.4.
