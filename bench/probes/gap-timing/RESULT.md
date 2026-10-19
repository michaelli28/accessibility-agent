# Probe: the gap detector's timing windows (acc-gaps#1, #6)

Run 2026-09-23 on worktree `round2/gaps-timing`, twice: at 925960f's detector before the fix (the probe file
uncommitted at run time; committed unchanged as 9f057fa), and at c6f061f, the fix. Playwright 1.57.0,
`chrome-headless-shell` 143.0.7499.4. One run per row, except `timer-no-hook` (5 runs each). Every page is ours and
synthetic, except `modal-*`, which loads the dev base `bench/corpus/dev/base/modal.html`. No held-out page was
opened or run.

Commit ids above are from before the branch was rebased onto the B2 and B3 merges. 9f057fa is now a8de747 and
c6f061f is now e02f706. 925960f's detector was B3's, merged as 6ee3b83; the only difference is B2's
contenteditable selector, which no probe page uses. Re-run at e618d9d (e02f706's code plus the guarded crawl
mark) on 2026-09-23: every row matches the fix column. Only `cost` differs, at 169, 139 and 194 ms, measured at
load 4-8.

## In plain English

**What we checked:** the gap checker reads a page three times: the accessibility tree (what a screen reader
sees), the list of page elements, and a Tab-key walk. It assumes all three see the same page. This probe changes
the page between those reads, at a chosen moment, and records what the checker then reports.
**What we found before the fix:** a page that reloads or rebuilds itself between the reads gets every link and
button flagged "can't reach with Tab" or "invisible to screen readers", both critical, on a page with no defect.
Content that arrives while the checker is reading is also flagged "invisible to screen readers" (20 to 23 flags in
5 of 5 runs).
**What we found after it:** none of those alarms. The checker now says it could not judge Tab reach on that page
(`document-replaced` or `crawled-nodes-detached`), and late content gets no flag (0 in 5 of 5 runs).
**What it costs:** a page whose walk is refused is judged as if no walk had run. On a page with a pop-up dialog
that adds milder "hidden from screen readers but clickable" alarms (+2 when the page is reloaded, +3 when the page
removes a notice by itself), and a zero-size control gains one alarm.
**Why it matters:** the old alarms were false and critical, and nothing in the old output said the page changed.

## How a row is made

The probe wraps the CDP sessions `crawlPageWithGapDetection` opens and acts once, just before or just after the
first CDP call that matches. `hookFired` is true on every hooked row in both runs; a hooked row whose hook did not
fire would be void. The walk rows use `tabWalk: { settleMs: 50 }`; `-nowalk` and `timer-no-hook` run no walk.

- `clean`: four controls (two links, a button, a `role=button tabindex=0` div), all reachable and exposed.
- `replace-before-walk` (W2): the page reloads after the crawl, just before the walk marks the document (the walk's
  `window["__atAgentTabWalk"] =` write).
- `replace-in-idle` (W1): the page reloads just after that write, during the walk's idle baseline, which sees it.
- `document-open-before-walk`: `document.open()` and `write()` rewrite the page in the same `Window` before the walk
  marks it.
- `replace-after-ax`, `replace-after-ax-nowalk`: the page reloads just after the accessibility-tree read.
- `timer-no-hook`: no hook. The page appends a named `role=switch` every 5 ms from 2.8 s to 4 s, across the
  detector's 3 s settle.
- `modal-clean`, `modal-replace-before-walk`: the dev modal (the page behind the dialog is aria-hidden, Tab loops in
  the dialog), clean and reloaded as in W2.
- `modal-toast`: a reduced modal whose aria-hidden page holds a toast with an Undo link; the page removes the toast
  by itself on the third keydown. Nothing is replaced.
- `zero-clean`, `zero-replace-before-walk`: a nameless zero-area link Tab reaches and a zero-area div that blurs on
  focus, clean and reloaded as in W2.
- `cost`: the post-walk detach check timed directly over 350 candidates (50 links, 300 clickable divs), 3 times.

## Results

`crit` = critical, `mod` = moderate, `ser` = serious. Reasons are `keyboard.unassessedReasons`; `[]` means
`not_focusable` was assessed. Bold marks a flag the fix adds.

| row                         | 925960f (before the fix)                                      | c6f061f (the fix)                                                                                    |
| --------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `clean`                     | no gap, `[]`                                                  | no gap, `[]`                                                                                         |
| `replace-before-walk`       | 4 × `not_focusable` crit, `[]`                                | no gap, `[document-replaced]`                                                                        |
| `replace-in-idle`           | 4 × `not_focusable` crit, `[]`                                | no gap, `[document-replaced]`                                                                        |
| `document-open-before-walk` | 4 × `not_focusable` crit, `[]`                                | no gap, `[crawled-nodes-detached]`                                                                   |
| `replace-after-ax`          | 4 × `missing_from_a11y_tree` crit, `[]`                       | no gap (4 × `no-box`), `[document-replaced]`                                                         |
| `replace-after-ax-nowalk`   | 4 × `missing_from_a11y_tree` crit, `[walk-not-run]`           | no gap (4 × `no-box`), `[walk-not-run]`                                                              |
| `timer-no-hook` ×5          | 22, 23, 20, 21, 23 × `missing_from_a11y_tree`, all on late-\* | no gap in 5 of 5                                                                                     |
| `modal-clean`               | no gap, `[no-wrap]`                                           | no gap, `[no-wrap]`                                                                                  |
| `modal-replace-before-walk` | no gap, `[no-wrap]`                                           | **`trigger`, `help-link` `hidden_but_interactive` mod**, `[no-wrap, document-replaced]`              |
| `modal-toast`               | no gap, `[no-wrap]`                                           | **`trigger`, `help-link`, `undo` `hidden_but_interactive` mod**, `[no-wrap, crawled-nodes-detached]` |
| `zero-clean`                | `zero-link` `no_accessible_name` ser, `[]`                    | the same                                                                                             |
| `zero-replace-before-walk`  | `home`, `about` `not_focusable` crit, `[]`                    | `zero-link` `no_accessible_name` ser, **`zero-blur` `wrong_role` ser**, `[document-replaced]`        |
| `cost`                      | n/a: no detach check at this commit                           | 97, 96, 103 ms for 350 unreached candidates                                                          |

Reading the rows:

- **W1, W2 and `document.open()`:** the walk reached only new nodes, so every crawled control read as unreachable.
  The fix refuses the walk: a reload loses the window mark the detector sets before the crawl
  (`document-replaced`); `document.open()` keeps the `Window` but every crawled node left the document
  (`crawled-nodes-detached`).
- **`replace-after-ax`:** before, the tree came from the old document and the crawl from the new one. The tree is
  now read after the crawl, so the crawled nodes are gone before their boxes are read (`no-box`) and give no gap.
  Without a walk (`-nowalk`) nothing says the page changed: the result is empty. `bench/run.ts` and the CLI always
  walk.
- **`timer-no-hook`:** late switches were candidates the earlier tree read had not seen. Every candidate now exists
  when the tree is read.
- **Costs (decision Q5: keep the static aria-hidden rule).** A refused walk falls back to the no-walk result. Only
  a walk shows that an aria-hidden control is hidden from the keyboard too, so the modal rows gain
  `hidden_but_interactive`, `modal-toast` with no replacement at all. A zero-area Tab stop the walk never holds is
  kept as a candidate without a complete walk, so `zero-blur` gains `wrong_role`. The same fallback restores the
  real `zero-link` `no_accessible_name` the old code lost on the replaced page. Both modal costs are pinned in
  `packages/accessibility/src/gaps/detect-timing.test.ts`.

## What this does NOT show

- How often a real page lands in these windows. W1 and W2 are CDP-call boundaries inside the instrument, so a page
  can only aim at them by chance; the hook makes them deterministic.
- Anything about the cases the check cannot see: an attribute-only change during the walk, a node the walk reached
  and the page then replaced, a node detached and re-attached before the check. No row plants them.
- A same-window re-mount between the crawl and the box read. No row plants it; two tests in
  `packages/accessibility/src/gaps/detect-timing.test.ts` do (just before the box read, and just after the tree
  read). Before the fix, the first loses a real `not_focusable` with the page assessed, and the second flags every
  control `missing_from_a11y_tree`; after it, both are refused as `crawled-nodes-detached`, with no gap.
- Any browser but Chromium 143 (`chrome-headless-shell`).

## Reproduce

Outside the sandbox (it launches Chromium), from the repository root:

```
npx tsx bench/probes/gap-timing/probe.ts               # every row
npx tsx bench/probes/gap-timing/probe.ts modal-toast   # named rows only
```

The first line printed names the browser and the commit the detector came from. For the "before" column, check
out 9f057fa (the probe on 925960f's detector).
