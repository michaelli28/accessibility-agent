# Probe: re-entry at an empty iframe after Tab wraps

Run 2026-09-22 on worktree `bench/detector-eval` @ 8eb184f (probe files uncommitted at run time).
Playwright 1.57.0, Chromium 143.0.7499.4 (Playwright's pinned revision 1200). `probe.ts` records
each row's binary: `chrome-headless-shell` for `shell` — the binary the held-out run used — and
Chrome for Testing for `new` and `headed`; `activated.ts` records the user agent, which differs per
mode. Nothing under `packages/` was modified; `runTabWalk` and `judgeKeyboardTrap` were imported
read-only and run with the defaults `bench/run.ts` uses.

**Test-informed.** This probe exists because of `vdc.ru`, a held-out page, and was written after
reading its recorded walk in `bench/results/74c4349/test-live/raw/`. It changes no recorded number
and no detector, but it did change how `bench/REPORT.md` classifies `vdc.ru` (§6 there).

## In plain English

**What we checked:** on `vdc.ru`, pressing Tab past the last link reached a chat widget, left the
page, then came back to the chat widget instead of the top of the page — for the rest of the walk.
Was that a keyboard trap the rebuilt checker missed?
**What we found:** no — but it is not a test-browser quirk either. On two plain test pages with no
JavaScript whose last Tab stop is an empty frame, Chromium does exactly this in every mode, the
visible (headed) browser included, once its window is active. Focus is never stuck: each loop
leaves the page, and Shift+Tab walks back through the page's links.
**Why it matters:** the rebuilt checker's `pass` on `vdc.ru` is the right answer for a keyboard
trap, and the old rule's trap alarm there was a false one. For a keyboard user the loop is still a
real nuisance: forward Tab never gets back to the top of the page.

## Answers

Ten links, then the variant. No fixture has any script. `IF` = the iframe, `_` = focus outside the
document (`isBody && !hasFocus`), numbers = the links.

**With the window activated before every press** (`activated.ts`, 40 and 41 presses per fixture):

| fixture              | shell, new headless, headed #1, headed #2 — identical in all four | Shift+Tab ×3 from the end state        |
| -------------------- | ----------------------------------------------------------------- | -------------------------------------- |
| `links-only`         | `1…10 _ 1…10 _ …` — normal                                        | back through the links                 |
| `empty-iframe-last`  | `1…10 IF _ IF _ IF _ …` — **loops**                               | from `IF`: 10, 9, 8; from `_`: 9, 8, 7 |
| `button-iframe-last` | `1…10 IF _ 1…10 IF _ …` — normal                                  | back through the links                 |

**Without activation** (`probe.ts`, `runTabWalk` exactly as the run calls it): only headless shell
loops on `empty-iframe-last` and on `xorigin-empty-iframe-last` (27 wraps in 65 presses). New
headless and both headed runs re-enter at the iframe once after a wrap and then reach Link 1, and
their first laps differ run to run (headed #1 first wraps at press 12, new headless at 23).
`links-only`, `button-iframe-last` and `empty-iframe-middle` never loop.

1. **Does the loop need page JavaScript?** No. An iframe where Tab reaches nothing inside, as the last
   Tab stop, reproduces it with plain HTML: a same-origin `srcdoc` frame, and (unactivated, headless
   shell) a frame on a second `127.0.0.1` port — cross-origin, but same-site. An iframe holding a
   button, or an empty iframe that is not last, does not loop.
2. **Is it mode-dependent?** No, once the window is active. The unactivated difference is an
   activation artefact — the same one `bench/probes/wrap/RESULT.md` ("Verifier corrections") found
   for plain wrapping. The run's harness never activates the page, but it runs headless shell, which
   behaves here like an active window.
3. **Is it a trap?** No, in any mode. Each forward cycle leaves the document, and Shift+Tab from
   either half of the loop lands back on the links.
4. **What does the rebuilt judge say?** `pass` on every fixture in every mode. It passes through
   clause 1 (a wrap in the last F+1 presses, `keyboard-trap.ts:114-121`, `:173-175` at `8eb184f`), so it would
   pass this walk whatever caused the loop: the verdict is right, but the judge did not tell a loop
   from an ordinary end of page.

## What this means for `vdc.ru`

Its recorded walk has the fixture's shape: 50 stops, then `iframe#__replain_widget_iframe` where Tab
reached only the frame's own `body`, then every later wrap that had a following press re-entered at
that iframe (59; the 60th wrap was press 170, the last). The same shape is in `bench/results/cd3b122/`
two days earlier (73 re-entries), under a different Tab-walk implementation. It is the only page that
re-enters at an iframe after a wrap — of the 18 walked at `74c4349` (`apina.biz` and `topjobs.lk`
have no walk there) and of all 20 at `cd3b122`. The live set also has a natural control:
`hostway.com` ends its Tab order on an iframe that holds a button, and re-enters at its first link
after every wrap. The legacy 2.1.2 rule fired on `vdc.ru`'s alternation (press 60, L=2).

## What this does NOT show

- That `vdc.ru`'s own widget script adds nothing. Its recording matches the script-free fixture, but
  the page itself was not visited.
- Any browser but Chromium 143. Playwright's headed Chrome for Testing, activated before every
  press, stands in for a focused user window; Firefox and Safari were not tried.
- Anything about iframes with focusable controls beyond the one-button case.

## Reproduce

```
npx tsx bench/probes/iframe-reentry/probe.ts       # runTabWalk + judge, unactivated
npx tsx bench/probes/iframe-reentry/activated.ts   # bringToFront before every press
```

Both run outside the sandbox and open headed windows. They write `fixtures/*.html` (tracked) and
`out/*.json` (gitignored, `bench/.gitignore:4`; recheckable only on the machine that ran them).
