# What the checker covers, and what was cut

## Retired: Section2Evaluator (decided 2026-09-19)

`evaluation/src/operable/Section2Evaluator.ts` sits untracked in the root checkout and was never committed on any branch. It is not ported, and the root file is left untouched.

- **Its 2.1.2 check** flags five Tab presses whose observation text doesn't change. That is the identical-text collision that the Tab walk (backendNodeId identity) and F4 remove. It is also limited to one-element cycles, and it reads the old agent's trace format.
- **Its other checks** (2.4.1 bypass, 2.4.2 page title, 2.4.4 link purpose, 2.4.5 multiple ways, 2.4.6 headings/labels) are static checks outside the keyboard claim.
  - axe-core already runs `bypass`, `document-title`, `link-name`, `label` and `empty-heading` alongside the checker.
  - 2.4.5 has no axe equivalent and is not covered.

## Retired: the 2.4.3 focus-order rule (decided 2026-09-19)

`DynamicEvaluator.checkFocusOrder` flagged a page when a focus identity repeated inside a four-event window. On a real page that is wrap-around, which every page does (bench/probes/wrap/RESULT.md). It is deleted rather than repaired: WCAG 2.4.3 is about whether the focus ORDER preserves meaning, which a repetition test over a keypress sequence cannot decide. Nothing replaces it.

- **Recall lost — one page.** The pre-fix baseline scores 2.4.3 detection `1/1 · 1.00 [0.21, 1.00]` on a single page (bench/results/cd3b122/REPORT-baseline.md:41), identified by bench/SPOTCHECK.md:113-116 as BAD's `before/survey`, SC 2.4.3 on `#page #ev`, technique F85, reader A only. After the cut that row reads `0/1`. The row stays in the report; it is not deleted.
- **What that recall cost.** The same rule scored `7/7 · 1.00 [0.65, 1.00]` false alarms on clean pages (bench/results/cd3b122/REPORT-baseline.md:52) — seven false positives for one true one.
- **No substitute.** axe contributed `0/1` on 2.4.3 in the baseline (bench/results/cd3b122/REPORT-baseline.md:41). Whether axe-core ships any 2.4.3 rule at all is unverified.
- **The dead `checkFocusIndicator` config flag went with the class.** It was never read. WCAG 2.4.7 has a Tab-walk-driven check in `packages/accessibility/src/focus-indicator.ts`, but nothing calls it yet: not the agent, the CLI or this harness (see below).

## What the 2.1.2 and 3.2.1 verdicts do not establish (decided 2026-09-19)

- **A backward-armed trap is not covered.** A page is judged from one forward Tab walk; no second walk in either direction is judged (the gap detector's own walk, run by `runPage` in bench/run.ts, feeds no judge). A handler that traps only on reverse entry is invisible.
- **A trap needing two Escape presses reads as inescapable.** The probe presses Escape exactly once, in `runEscapeProbe` (packages/accessibility/src/tab-walk.ts).
- **Shift+Tab is never independent evidence.** Escape is pressed before the probe key, so only the conjunction "Escape failed AND the opposite key failed" is meaningful.
- **F55 ships with no recorded dev fixture.** `focusLostOnArrival` is false on all 13 dev bases (bench/corpus/dev/labels.json; 8 when cd3b122 was recorded) and on all 27 variants recorded at cd3b122, because no operator in bench/corpus/dev/operators.ts produced it when they were seeded. The M7 blur-on-focus operator was added at 4d7356a so the rule has dev-corpus evidence, but the variants recorded at cd3b122 predate it. No recorded dev base walk has a focus-removed finding, but every dev-variant run committed since records M7 walks with them (`bench/results/<sha>/dev-variants/summary.json`): all 6 M7 variants at e1eb294, 118bb99 and 7140b7e, 8 of 9 at 0a71e4e and 145b3da (Runs A and B; `one-button__M7__only-button` is the old-checker miss below), and all 9 at c013aa1 and 483fac9 (Runs C and D).
- **A same-document SPA route change is not seen.** The URL rule needs `location.href` to change.
- **One observation, one criterion.** An F55 failure also fails 2.1.1 and 2.4.7; those stay with the gap detector and the focus-indicator check, so 3.2.1 recall is not counted three times.
- **A context change that arrives after the 150 ms settle is refused, not reported** — a timer cannot be told from a focus handler. Those presses are listed as `url-changed-after-settle`. Since round 2 a focus drop first seen at the settled read is refused the same way, as `focus-removed-after-settle` (see the round-2 section).
- **An `undetermined` verdict counts as a miss.** It stays in both denominators and is printed as its own count beside the rate, so the before/after comparison stays like-for-like. A judge that refuses to decide must not be able to buy detection by shrinking the denominator it is scored on. The asymmetry is stated rather than hidden: on a clean page a refusal scores exactly like a correct pass, so the false-alarm cell also prints the worst case (the rate if every refusal had been a false alarm) and drops the rule-of-three bound, which assumes every page was observed.

## What the fix design saw of the held-out set (decided 2026-09-20)

The fixes were designed from the dev corpus and the probes. The places where held-out knowledge
nonetheless touched a decision, stated here rather than left for a reader to find:

- **The F55 rule was chosen knowing how the BAD pages fail.** `packages/accessibility/src/context-change.ts`
  says so in its header: focus removed on arrival is how all four W3C Before-and-After pages fail
  3.2.1. No BAD page was opened to design the rule and no BAD output was read, but the rule was
  prioritised because that failure mode was known to be the one that matters. This is the most
  attackable fact in the project and it is deliberately not buried.
- **The 2.4.3 deletion was decided with held-out numbers in hand.** The retirement above cites BAD's
  `before/survey` and the pre-fix baseline's 1/1 detection and 7/7 false alarms. Those numbers come
  from the test set. The rule's deletion was mandated independently (repetition is 2.1.2's job and a
  keypress-sequence test cannot decide focus ORDER), but the decision is test-informed and is
  labelled as such.
- **M7 was added to the dev corpus after the labels were frozen** (commit 4d7356a), specifically so
  the F55 rule would not execute for the first time on the test set. It was added before the fix it
  supports was measured, it changes no test-set page, and it is labelled 3.2.1 only. Disclosed in
  the same spirit as the two committed sampling-rule amendments.
- **M8-M13 and five dev bases were added after the labels froze** (round 2, 2026-09-23): operators
  M8-M13, the bases `disclosure-tabs`, `native-dialog`, `one-button`, `scroll-panel` and
  `remount-on-keydown`, and a portal on `react-div-button`. Each was built to show one round-2 checker
  fix, so the old → new dev deltas they produce hold by construction and are not independent evidence
  that the fixes work. They change no test-set page. The spot-check stays pinned to the Checkpoint-1
  corpus (`CHECKPOINT1_CORPUS` in `bench/spotcheck.ts`): its 20 recorded answers stand, and none of
  them covers this material.

## What the harness does NOT measure (decided 2026-09-20)

- **The F7 focus-indicator check is not in the harness.** `bench/run.ts` imports no focus-indicator
  module, so the 2.4.7 row scores only the gap detector's `not_focusable` mapping. No shipped path
  runs `focus-indicator.ts` either (the agent's `checkKeyboard` and `at-agent gaps` do not call it), so
  that check has no number anywhere in this report.
- **One forward walk per page.** A trap armed only on reverse entry is not covered.
- **No aggregate precision is computed.** The report scores per criterion. Any single headline
  X → Y must name which criteria it aggregates and must state that 2.4.3 contributes a before 7/7
  → after 0/7 false-alarm change that comes from DELETING a rule, not from fixing one.
- **A page whose Tab walk did not assess `not_focusable` is not scored for 2.1.1 or 2.4.7.** That
  gap type is the only one carrying those criteria and the detector emits it only after an assessed
  walk, so such a page counts as `undetermined` in BOTH columns — never flagged: a miss on detection, a clean-looking pass on a false-alarm count — and drops
  the rule-of-three bound there. `summary.json` records the reason per page
  (`tools.gaps.findings.keyboard`) and the report prints it beside the page's gap count. Before this
  was recorded, a check that could not run was indistinguishable from one that found nothing; that
  is how the harness shipped `not_focusable 0/7` with the walk structurally disabled (fixed 118bb99).
- **The pre-fix summaries at cd3b122 predate this schema.** `SummarySchema` is now version 3
  (`WalkStats.trap` became a judge verdict in v2; the gaps run gained its keyboard evidence in v3),
  so those files fail to parse on version rather than silently mis-parsing. Re-render them at their
  own commit; they are a frozen artifact. The same now applies to the v2 dev runs at e1eb294 and
  118bb99.

## Round-2 fixes: what they cover and cost (decided 2026-09-23)

The labelling calls the round-2 dev material needed, and the two Run A cross-product cells no design predicted
(the old checker at 0a71e4e, `bench/results/0a71e4e/dev-variants`). What each fix covers and costs is added
with the fix. Run B, the new checker on the same dev pages at 145b3da (`bench/results/145b3da/`), shows the
same dev changes as the bullets below; `bench/REPORT.md` §10 has the Run A → Run B table.

- **M10, a script loop from the last stop the script counts to the first, is labelled a 2.1.2 trap.** Once
  focus is in the loop, Tab and Shift+Tab never take it out. WCAG 2.1.2 is worded per component, and
  where the loop holds several components focus can leave each of them. The label schema's
  "Tab/Shift+Tab alone cannot move focus out of some region" takes the loop as the region, so the M10
  variants carry `keyboardTrap: true, trapEscapable: false`. Read per component, all but one would be
  clean: on `one-button__M10__only-button` the loop is the page's one button, which Tab and Shift+Tab
  never leave, a per-component trap like M5. The loop holds every stop whose `tabIndex` is 0 or more; on
  eight M10 pages that is every Tab stop Chromium reaches from load. On `scroll-panel__M10__agree-button`
  it is not: the two keyboard-focusable scrollers after `agree-button` report `tabIndex` -1 and sit
  outside the loop, so Shift+Tab from a fresh load reaches one and the next Tab leaves the page. On
  `navbar__M10__offcanvas-open` a person who opens the account menu with Enter can Tab past the loop's
  end and out of the page. Both labels stand, because focus in the loop never leaves it by Tab or
  Shift+Tab alone.
- **M11's copy is made with `cloneNode`, which drops listeners added with `addEventListener`.** On
  `js-handlers`, `one-button` and `scroll-panel` the target therefore stops working after the first Tab
  press on it: Enter on the copy does nothing. The label stays `keyboardAccessible: true`, because the
  schema's rule is reachable and operable from a fresh page load, and from a fresh load Tab reaches the
  original, which Enter operates.
- **2.1.2: a complete stop count ends the page only after a recent wrap** (acc-walk#1's residuals).
  Reaching as many distinct stops as F in the last F+1 presses now also needs a wrap within the last
  2·max(F, L)+1 presses, L being the longest lap the walk measured. Without one, the release probe
  decides, so a trap on the page's only stop (`one-button__M5`), a loop over every stop (M10, labelled a
  trap above) and a loop padded with scrollers (M12) now fail. A trap armed too late to leave that many
  trapped presses before the walk ends still passes. Since round 4 (below), both windows and L count
  stops, not presses.
- **2.1.2: a walk's release read through node identity is refused when
  its last F+1 presses reach more stops than F**, as `undetermined / focusables-exceeded`. F then misses
  stops or the page re-creates nodes, so reaching an "unseen" element proves nothing. A wrap or a
  replaced document still releases, and a probe that gets nowhere still fails. Since round 4 (below), the
  last F+1 are stops.
- **2.1.2: a stop re-rendered on every press (M11) is refused, not failed.** Each press lands on a new
  node, which the walk cannot tell from moving on; failing it needs an identity beyond the DOM node, which
  the rebuild removed on purpose. It counts as a miss. A trap where only some stops re-render can still
  pass, and so can a trap whose Escape handler re-creates the focused stop: the new node reads as Escape
  releasing it (`pass [escape-key]`).
- **2.1.2: scrollers are Tab stops F does not count.** Chromium stops on a scrollable box with no
  focusable child, and counting one would re-implement that rule in page JS. F does count every editing
  host (bare `contenteditable`, `true` or `plaintext-only` in any case), and the gap detector's walk
  shares that count. Until round 3 (below) F also missed image-map areas, which Chromium stops on: the
  selector's `a[href]` did not match `area[href]`, and round 2 did not add it. A link and 14 areas (F = 1)
  was refused, where 13 passed (the cost below; measured, not pinned). No dev page has an image map.
- **2.1.2: what the recent-wrap rule and the refusal cost on clean pages** (synthetic pages walked in
  chrome-headless-shell 143). A page with F ≥ 1 loses `all-stops-visited` when no wrap falls in its walk's
  last 2·max(F, L)+1 presses, and the release probe decides. If a Shift+Tab reaches a wrap, or a stop
  outside the last F+1 presses, the page passes, unless it was a stop and those presses reached more stops
  than F: then it is refused (`focusables-exceeded`). If all F+2 Shift+Tabs stay on those presses' stops,
  it fails. With one-press stops and focus starting at the top, the 5(F+1)+5-press walk misses the wrap
  exactly when the page has 4F+10 or more stops F does not count, and the page is refused (pinned in
  `keyboard-trap.test.ts`). Autofocus breaks that bound: a button, 17 scrollers and an autofocused last
  button (F = 2, so 4F+10 = 18) wrap on the first press only and are refused. Until round 4 (below),
  several-press stops needed fewer: one datetime-local then 8 scrollers (F = 1, 7 + 8 = 15 presses) was
  refused, where 7 scrollers passed. Since then such a control is one stop against the same bound: a
  datetime-local then 13 scrollers passes and 14 are refused, and 9 to 12 scrollers then a datetime-local
  pass (the design's prototype of the fix; not pinned). Only the 4F+10 bound is pinned. A page where F is
  0 (only scrollers, say) is refused unless its walk ends on its first stop or on a wrap.
- **2.1.2: stops that take several Tab presses gave wrong verdicts both ways, until round 4 (below).** Tab
  steps through the fields of a date or time input, and through the controls of `<audio controls>`, on one
  element (chrome-headless-shell 143: datetime-local 7 presses, date and time 4, month 3, audio with a
  silent clip 5), and the walk and its probe counted presses as if every stop took one. A clean page with
  two datetime-local inputs failed, and a dialog loop over a date input and a button, a trap, passed. The
  recent-wrap rule added false fails on clean pages whose walk never wrapped and whose probe stayed inside
  such a stop: 8 to 11 scrollers then a datetime-local (the walk ended inside it); 7 scrollers, a
  datetime-local and one more scroller, or with F = 2 a link, 10 scrollers, a datetime-local and 2 more
  (the walk ended just after it); and a link and 10 scrollers then `<audio controls>`. `it.fails` pinned
  five (`tab-walk.test.ts`): the two-datetime page, the date loop, 8 scrollers then a datetime-local, 7
  scrollers with one after the input, and the audio page. Round 4 counts stops, and the five pass; closed
  shadow roots, cross-origin frames, Firefox and WebKit are not covered (below). No dev page has a date,
  time or media input, so no dev number measures this.
- **`native-dialog` is labelled clean.** Its age gate is a `<dialog>` opened with `showModal()` on
  load. The page behind it is inert until Confirm closes the dialog and is then reachable with Tab, so
  the background controls are labelled accessible with no gap. Tab from Confirm leaves the page for the
  browser's own UI, so the page is no trap (`keyboardTrap: false`). Its script is a file, so no operator
  is seeded on it.
- **`remount-on-keydown` is labelled clean.** It re-renders `<main>` on its first keydown, so the gap
  detector's crawl and its Tab walk see different nodes: a hazard for the checker, not a WCAG defect,
  because every control still works from the keyboard. Its script is a file, so no operator is seeded
  on it; an operator's script would bind to nodes the first keydown removes.
- **3.2.1: the settle fix refuses a focus drop first seen at the settled read.** The walk reads focus
  about 1 ms after each Tab press and again after the 150 ms settle. A drop that shows only at the second
  read is listed as `focus-removed-after-settle`, not reported, as a late URL change already was: a page
  timer cannot be told from a focus handler there. The refusal covers any focus removal first seen after
  the first read, whatever deferred it: a timer of 1 ms or more, a CSS animation, or chained
  `requestAnimationFrame` calls. Measured on real `chrome-headless-shell` walks of small local pages (5
  walks, 30 drops each): `setTimeout(blur, 1)`, a blur two `requestAnimationFrame` calls later, and a 60 ms
  CSS animation to `visibility: hidden` with no script were each refused on 30 of 30 drops. A removal
  made in the focus handler (`blur()`) or in the next task or frame (`setTimeout(blur, 0)`, one
  `requestAnimationFrame`) already shows at the first read and is still reported, 30 of 30 each. The
  design's walks found the same for `display: none`, `inert`, `disabled` and removing the element.
  The cost is planted as M8, whose target blurs 60 ms after focus: re-judging Run A's recorded walks, all 9
  M8 variants go from `fail` to `pass`. That is the fix's price, not an improvement.
- **3.2.1: the settle fix still leaks on a timer that drops focus with no URL change.** A tick that lands
  in the ~1 ms between a press and its first read is still reported. A small local page whose timer
  replaced a button every 100 ms (about 30 drops a walk) was walked 10 times in `chrome-headless-shell`
  when the fix was designed: 2 walks still failed, against 10 of 10 before. The mixed-timing refusal that
  would close this was declined. Round 3's arrival fix widens it (below).
- **3.2.1: the idle fix stops a fragment-only change voiding the walk.** Before the first press the walk
  watches the idle page, and a URL change there voids the walk as
  `undetermined / page-navigates-without-input`. A change to the `#fragment` alone no longer does, as every
  other URL comparison in the judge already ignores it, except on a walk that also has a
  `focus-removed-after-settle` refusal: a timer setting `location.hash` clears focus by itself, so that
  walk stays `undetermined`. Re-judged, 8 of the 9 M9 variants go from `undetermined` to `fail` with the
  same findings. `one-button__M9__only-button` goes to `pass` (until round 3, below): the walk never set
  `focusLost` there, the same miss as `one-button__M7__only-button` below, which the void was hiding.
- **3.2.1, M8: focus held for tens of milliseconds counts as reached by the gap detector.** It takes an
  element as reached when either read after a Tab press found focus on it (`gaps/keyboard.ts`). An M8
  target holds focus for 60 ms, so a person cannot operate it and it is labelled `not_focusable`, but the
  detector reports no gap: 9 known misses, pinned in `bench/gaps-dev.test.ts`.
- **`one-button__M7__only-button` reads 3.2.1 `pass` in Runs A and B, an old-checker miss.** The walk
  marked a drop `focusLost` only after focus had been on a real element in the document (`lastRealSeen`,
  `tab-walk.ts`). The page's only stop blurs on arrival, so every read is `body` and all 8 drops were filed
  `no-preceding-stop`; the gap detector does flag it `not_focusable`. B1's settle fix also needs `focusLost`,
  so the cell stays `pass` there. Round 3's arrival fix (below) makes it `fail`.
- **`scroll-panel__M6__agree-button` reads 2.1.2 `undetermined / document-replaced`; the other 8 M6 pages
  pass.** The walk counts 3 stops (not the two scrollers), so the judge wants a wrap in the last 4 presses,
  and a lap here is 6. M6's reload at press 3 puts the wraps at 9, 15 and 21, none in 22-25, and a replaced
  document turns off the all-stops-visited signal. A refusal on a page labelled no trap, not a wrong verdict.
- **gaps: content the page switched off is no candidate once Chromium leaves it unexposed.** Chromium leaves
  out of the accessibility tree anything under the `inert` attribute or CSS `interactivity: inert`, and
  everything outside an open modal `<dialog>`; the detector flagged each such control
  `missing_from_a11y_tree` (critical). It now reads all three from the DOM and drops a disabled or inert
  candidate Chromium does not expose, aria-hidden or not. A disabled control Chromium exposes is still judged.
  The cost: a real defect behind a modal open at load goes unjudged, as one in an aria-hidden page behind a
  modal already did after a walk. The page behind a modal `<dialog>` in a shadow root keeps
  `missing_from_a11y_tree` (pinned in `gaps/detect.test.ts`). With two modals stacked, the page behind both is
  dropped, but the controls inside the lower modal keep `missing_from_a11y_tree` (run on a probe page, not
  pinned). An `aria-modal` element changes no flag (run on a probe page); by the design's probes it removes
  nothing from Chromium 143's tree. A mouse-only control that is only aria-hidden stays critical: Chromium
  prunes every aria-hidden element that cannot take focus, so trusting its aria-hidden reason instead would
  have silenced 12 of 12 such controls on the design's probe.
- **gaps: a React root or portal container no longer owns React's delegated listeners.** React 17+ marks each
  container it delegates events from with `_reactListening<random>` and listens there, so an empty portal host
  was flagged `wrong_role`. A marked element's CDP listeners no longer count as its own; an inline `onclick` or
  a React activation prop still does. A container that is also a real control through its own
  `addEventListener` loses that signal. React 16 sets no marker, and Svelte 5 and Solid delegate without one,
  so they are unchanged (from the design's reading of their source, not run).
- **gaps: a `<details>` is a group, not a control missing its name.** Its `<summary>` is the named control. A
  `<details>` with its own click listener keeps `wrong_role`.
- **gaps: a roving tablist whose container has no box keeps its arrow-key evidence.** A zero-area or
  `display: contents` container's keydown handler credits its own members, never an outer widget around it.
  Arrow keys handled on the document are still not seen, so such members stay `not_focusable`.
- **gaps: on the dev pages the four fixes change exactly 21 of 107 gap cells.** Measured by the live
  `bench/gaps-dev.test.ts` run over every dev page, before and after, in `chrome-headless-shell`: all 10 M13
  targets lose their false `missing_from_a11y_tree`; `native-dialog` goes from 2 flags to 0;
  `react-div-button` loses `wrong_role@portal-host` and keeps `wrong_role@add-to-cart-div`; `disclosure-tabs`
  and its 9 variants lose all 4 of the page's own alarms (2 on the M5, M6, M10 and M11 variants, whose walks
  do not assess `not_focusable`). The other 86 pages are unchanged, the M8 and `form__M9` `not_focusable`
  misses included. These pages were built to show the fixes, so this shows the fixes run, not how much they
  help.
- **gaps timing: a Tab walk counts only if it ran on the nodes the crawl listed.** The detector flags a crawled
  control the walk never reached `not_focusable` (critical). A page reloaded before or during the walk (its idle
  baseline included), re-mounted in the same window, or rewritten with `document.open()` left the walk reaching
  only new nodes, so every crawled control was flagged on a page with no defect. The detector now marks the
  window before the crawl and checks after the walk: a lost mark gives `document-replaced` (a mark the page's own
  script refuses gives `crawl-mark-failed` since round 3, below), and a crawled node the walk never reached that
  has left the document gives `crawled-nodes-detached`. The nodes checked include those
  read as `no-box`, because a node removed before its box is read has none: without them, a re-mount right after
  the crawl left no candidate to check, and a real `not_focusable` was lost with the page scored as an assessed
  pass (CONFIRMED by two tests in `detect-timing.test.ts`: a re-mount just before the box read, and one just
  after the tree read). Either way `not_focusable` is not assessed, so the page's 2.1.1 and 2.4.7 cells are
  undetermined, and the page stays in both columns. Nothing is read before the walk. A navigation that lands
  while the mark is written destroys the write's context: the error is caught, and the new window, which has no
  mark, is refused as `document-replaced` after the walk (CONFIRMED by a test page that reloads from inside the
  write, and on pages that reload themselves around the end of the 3 s settle or carry a 3 s meta refresh: the
  write threw in 8 of 39 runs before, in none of 105 after). A page closed during the walk keeps its
  `walk-error`. What still throws: a page closed while the mark is written, as any read of a closed page did
  before, or while the post-walk check runs, which now throws
  (`Target page, context or browser has been closed`) where it used to return a result, so `bench/run.ts`
  records no gap result for it; and a navigation that lands during the title read after the tree read
  (`Execution context was destroyed`), as before these fixes (1 of those 105 runs; 3 of 31 self-reload runs at
  `6ee3b83`); and since round 3 a renderer crash (below). On the probe (`bench/probes/gap-timing/RESULT.md`)
  the reload, idle-baseline and `document.open()` rows go from 4 × `not_focusable` to no gap.
- **gaps timing: the accessibility tree is read after the DOM crawl.** Every candidate now existed when the tree was
  read, so content the page adds while the detector reads is no longer flagged `missing_from_a11y_tree`
  (critical): on the probe's timer page, 20 to 23 flags in 5 of 5 runs before, none in 5 of 5 after. A page
  replaced or re-mounted right after the tree read gives no gap, because its crawled nodes are gone before their
  boxes are read; with a walk it is refused (`document-replaced`, or `crawled-nodes-detached` for a re-mount in
  the same window). Without a walk nothing says the page changed, but `bench/run.ts` and the CLI always walk.
- **gaps timing: a refused walk falls back to the no-walk result, and that can add flags.** Only a walk shows that
  an aria-hidden control is hidden from the keyboard too; without one the static rule flags it
  `hidden_but_interactive` (moderate). The rule is kept on refused walks (decided 2026-09-23). Pinned in
  `packages/accessibility/src/gaps/detect-timing.test.ts`: a modal page replaced before the walk gains 2 such flags
  on its correct aria-hidden background, and a modal page whose background drops a toast on the third keydown,
  with no replacement at all, gains 3. A zero-area Tab stop the walk never holds can also gain a flag (the probe's
  zero-area row: `wrong_role`, serious). The refusal fires whenever the page's own script removes a crawled node
  the walk never reached, shown or not (a `no-box` one counts too), such as a toast, a carousel re-rendering its
  slides or a React re-key: that page's 2.1.1 and 2.4.7 go undetermined, and a real `not_focusable` on it is
  missed. Withholding aria-hidden flags on a refused walk was declined: real M3-type flags would then read as
  clean, and 4.1.2 has no undetermined path in the bench.
- **gaps timing: what the check cannot see (ASSUMED: reasoned from the code, not measured).** An attribute-only
  change during the walk (`aria-hidden` toggled, `tabindex` removed on focus) keeps the node, so nothing is
  refused and the crawl's reads stay those of crawl time. A node the walk reached and the page then replaced is not
  refused: the reach was real. A crawled node detached and re-attached before the check reads as connected. A node
  detached exactly at the tree read and re-attached before its box is read still reads as missing from the tree. A
  replacement after the walk's last press, before the check, refuses a walk that was sound. The check costs one
  script call before the crawl, one after the walk, and one CDP read per unreached crawled node, `no-box` ones
  included, until the first detached one: 96 to 103 ms for 350 on the probe.
- **gaps timing: on the dev pages the two fixes change the gap result of exactly 1 of 107 pages.** Measured by
  running every dev page through the detector as `bench/gaps-dev.test.ts` does, before the fixes and after each
  of them, in `chrome-headless-shell`:
  `remount-on-keydown`, which re-renders `<main>` on its first keydown, goes from `not_focusable` on `home-link`
  and `about-link` to no gap, with `not_focusable` not assessed (`crawled-nodes-detached`), so its 2.1.1 and 2.4.7
  cells become undetermined on a page labelled clean. The other 106 pages are unchanged in gap list, assessment
  and reasons, the earlier gap fixes' cells included. The page was built to show this hazard, so this shows the
  fix runs, not how much it helps.

## Round-3 fixes: what they cover and cost (decided 2026-09-24)

Five small commits on the checker, f1-f5 below. Run C, the checker at `c013aa1` on the same dev pages as Run B
(`bench/results/c013aa1/`), moves dev cells only through f5; `bench/REPORT.md` §11 has the Run B → Run C table.
No held-out page was run.

- **f1, renderer crash: the gap tool, the Tab walk and the focus check fail instead of hanging.** After a page's
  renderer crashed, a send on a CDP session the check had opened itself never settled, so
  `crawlPageWithGapDetection`, `runTabWalk` and `checkFocusIndicator` waited for ever: with no timeout in the CLI's
  `gaps` command (the first) and the agent's keyboard check (the second), and in the bench (both) until the
  20-minute page budget closed the context, which also starved the page's later tools. The third has no caller. Each
  now rejects with `the page's renderer crashed` when the page's `crash` event fires (pinned in
  `gaps/detect-timing.test.ts`, `tab-walk.test.ts` and `focus-indicator.test.ts`, each crashing the renderer with
  CDP `Page.crash`). The cost: a crash anywhere in the call rejects the whole call. A crash during the gap
  detector's walk drops the crawl gaps already read and the walk's steps, where a page closed during the walk keeps
  its crawl gaps and `walk-error` (above); the bench records the gaps tool as an error, which `bench/report.ts`
  counts as a miss on the per-operator line and excludes ("tool error") from the columns that read the gap tool. Not
  covered: a page whose renderer crashed before the call. The detector still fails there (its `page.goto` rejects),
  but `runTabWalk` and `checkFocusIndicator` would still wait. No committed summary records a crash, and every tool
  ran ok on all 107 Run C pages.
- **f2, gaps timing: a crawl mark the page's own script refuses is labelled `crawl-mark-failed`.** The detector
  writes its mark through the page's own `Reflect.set`. A page that replaced it to throw, or to return `false` for
  the key, had its walk refused as `document-replaced` though nothing was replaced. An exact `false` or a throw now
  gives `crawl-mark-failed` instead, when the walk ran, saw no replacement itself and the page is open (pinned in
  `gaps/detect-timing.test.ts`). Both reasons leave `not_focusable` unassessed, so the fix changes a label, not a
  verdict or a score. Not covered (from the code; not tested): a `Reflect.set` that returns `true` without writing
  still gives `document-replaced`, and one that returns a promise that rejects is read as a navigation. A reload
  during the write still gives `document-replaced`. No dev page mentions `Reflect`, and no Run C gap cell moved.
- **f3, 2.1.2: F counts an image-map area while the first image naming its map is rendered.** The selector gains
  `area[href]`, and an area (with `href` or `tabindex`) counts only while the first image in its document whose
  `usemap`, first character dropped, names its `<map>` by id or name is rendered; the area's and the map's own
  boxes are ignored. Unlike a scroller's, this is a fixed lookup, and `tab-walk.test.ts` pins it against
  Chromium's own Tab stops on a page of mixed maps. A link and 14 areas now has F = 15, wraps and passes (pinned).
  The cost: the end-of-walk re-count uses the same rule, so a page that shows or hides an image-map image during
  the walk can now be refused as `focusables-changed` (from the code; not run). Not covered: F counts an area
  Chromium skips when the area's image is inert or `visibility: hidden`, or the area has `tabindex="-1"` (links
  already share these), and it misjudges a map whose own name starts with `#` (the design's probes on
  chrome-headless-shell 143; not re-run). The DOM crawler's own `focusable` flag (`gaps/dom-crawler.ts`) and the
  sampling rule's selector in `bench/test-sites/draw.ts` are unchanged. F is unchanged on a page with no
  `<area>`: no dev page has one, and F is equal in Runs B and C on all 107 pages.
- **f4, 2.1.2: the 2F+1 floor on the recent-wrap window is pinned as shipped, not re-decided.** The window is
  2·max(F, L)+1 presses, but no test reached its F floor: with the floor removed every keyboard-trap test passed.
  A new test in `keyboard-trap.test.ts` pins it: F = 3 walks whose longest lap is 2 presses pass 5 and 6 presses
  after their last wrap, even with a probe that gets nowhere, and fail at 7. The floor only makes the rule more
  lenient: a wider window finds a wrap in more walks, and such a walk ends at `all-stops-visited` and passes,
  unless the focusables checks refuse it, before any release probe runs. The source gives no reason for F; the
  test's comment says so. No source, verdict or dev cell changes.
- **f5, 3.2.1: a drop is `focusLost` when a focus event since the last read shows focus arrived.** A page whose only
  stop blurs on arrival filed every drop `no-preceding-stop` and passed (above). The walk now also listens, capture
  phase on `window`, for a trusted `focus` event on an element other than `body`: a step that ends on `body` with
  focus is `focusLost` when such an event landed between the previous read and the press's immediate read. The judge
  is unchanged: the drop is reported as `focus-removed`, `precedingStop` `null`, when the immediate read shows it,
  and refused as `focus-removed-after-settle` when only the settled read does. Press 1 counts, and the listener is
  removed after the walk. The cost: `isTrusted` is true for a page script's `el.focus()`, so a timer that focuses
  and blurs an element between the previous read and a press's immediate read is reported too, the settle leak above
  now also on press 1 and on pages whose stops never hold focus. A drop that moves from `no-preceding-stop` to
  `focus-removed-after-settle` can move a verdict: with a fragment-only change seen while idle the walk becomes
  `undetermined / page-navigates-without-input`, findings or not (from the code; not tested). Not covered: a drop
  first seen after the immediate read stays refused; a `body` that is itself a Tab stop is no arrival; a page that
  blocks the listener (an earlier capture listener calling `stopImmediatePropagation`, or an `addEventListener` that
  throws or does nothing), or a read that is retried, loses the evidence, and the drop is judged as before, never
  newly reported (only the throwing `addEventListener` is tested); a page that deletes the walk's marker itself
  leaves the first listener behind (not guarded).

## Round-4 fix: Tab stops that take several presses (decided 2026-09-24)

One fix, `483fac9`, with its tests pinned first in `9cf2aac` (design C, approved 2026-09-24): the Tab walk, its
escape probe, the 2.1.2 judge and the 3.2.1 short-walk check count Tab stops, not Tab presses. Run D, the checker at
`483fac9` on the same dev pages as Run C (`bench/results/483fac9/`), changes no dev cell: no dev page has a date,
time or media control. `bench/REPORT.md` §12 has the comparison and the held-out direction. No held-out page was
run.

- **What it covers.** Each settled read records `part`, the node that has focus inside the element's user-agent
  shadow root (Chromium's own inner tree of a date, time or media control), or `null`. One function, `groupStops`
  (`tab-walk.ts`), groups presses into stops: a press continues the stop while it is on the same element, did not
  replace the document, the stop has fewer than 10 presses, and its `part` is one the stop has not had, `null`
  included, so a button pressed twice is two stops. A read whose node DevTools no longer finds gives `part` null, so
  it joins the current stop only if that stop has had no `null` yet (one `null` per stop), and otherwise begins a
  new stop. The walk's 5(F+1)+5 budget, the probe gate, the probe's seen set (the last F+1 stops) and its F+2 keys,
  the judge (it reads one step per stop, `collapseStops`), `endOfPage` and the 3.2.1 short-walk check count stops.
  So does every window and budget of the walk, its probe and its 2.1.2 judge that this file gives in presses above;
  stops and presses are equal on a page where no read gives a `part`. The summary fields keep their names: `presses`
  and `plannedPresses` count stops from Run D on. In `tab-walk.test.ts` (chrome-headless-shell 143) the five round-2
  `it.fails` pins and 10 more wrong verdicts found in round 4, among them two datetime-local inputs in an open
  shadow root and in a same-origin frame, now pass; 8 guards that were right before stay right; and a tripwire fails
  if Chromium gives either of two controls (a datetime-local with milliseconds, a captioned `<video controls>`) 10
  or more presses. `keyboard-trap.test.ts` pins the grouping, its collapse and `endOfPage` on a raw walk (9 unit
  tests).
- **What it costs.**
  - **The trade, accepted by the owner.** A long clean page with a date or media control, past the 4F+10 bound in
    stops F does not count, is now `undetermined / focusables-exceeded`, as the same page with a text input in place
    of a date input, or a scroller in place of a media control, already was. Where it passed before, it passed only
    because the walk ended inside the control and a Shift+Tab got out. Pinned in `tab-walk.test.ts` for F = 1 (a
    link, 12 scrollers, `<audio controls>`, 5 scrollers) and F = 2 (two links, 16 scrollers, `<audio controls>`, 4
    scrollers).
  - **A change no design predicted.** A page found in review, a link, a date input and a link, whose date input is
    replaced by a clone that takes focus on every other forward Tab, so forward Tab never leaves it and Shift+Tab
    does, went from `pass [opposite-key]` to `undetermined / focusables-exceeded`: its last F+1 = 4 stops are 4
    clones, more than F = 3. It is the round-2 refusal for pages that re-create nodes (above), now read over stops:
    a refusal, not a wrong verdict. Run on chrome-headless-shell 143 in review; round 5 (2026-09-25) pins the
    refusal in `tab-walk.test.ts`, "a date input replaced by a clone on every other Tab, Shift+Tab native:
    undetermined, focusables-exceeded".
  - **Longer walks.** A walk over such controls takes up to 10 times as many presses, the cap per stop; on the
    design's prototype pages it took up to 4.9 times as many (98 presses for 20 stops on a page with two
    datetime-local inputs, 90 for 40 on a mixed form). The gap detector's walk has the same budget, the legacy
    replay reads the longer walk, and the agent's `checkKeyboard` walks longer too. Not timed.
  - **More DevTools calls.** From `readPart`'s calls, a settled read makes no extra call on links, buttons and
    checkboxes, 2 on text, range and file inputs, selects, textareas and a media control itself, and 3 on a part of
    a date, time or media control, plus 1 inside an open shadow root or a same-origin frame. The design's prototype
    took 2.0 to 4.4 ms on average to read the focused element and its part (chrome-headless-shell 143; the whole
    read, the extra time was not measured).
- **What it does not cover.**
  - Firefox and WebKit were not run. Closed shadow roots and cross-origin frames read `part` null, so they keep
    press counting and its wrong verdicts (from the code; not run).
  - A trap on a button that is replaced by a clone on every fourth Tab passes before and after, a false pass (found
    and run in design and review; not pinned). It belongs with the refusal for re-created nodes.
  - Until round 5, no test covered four parts, as `483fac9` says: the catch that gives `part` null when DevTools
    reports the node not found (catching every error, or none, passed the keyboard-trap, tab-walk and context-change
    tests); the probe gate and the 3.2.1 short-walk count, each of which passed those tests when it counted presses
    again; and bench's stop counts (`walkStats.presses` and "walked N of M planned stops"), whose test walks read
    `part` null on every step, where stops equal presses. Round 5 (2026-09-25) adds a test that each of those
    changes fails: four in `tab-walk.test.ts` (the not-found catch for resolveNode's and describeNode's messages,
    any other error, the probe gate), one in `context-change.test.ts` and two in `bench/run.test.ts`.
