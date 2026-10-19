# React click-handler visibility probe

Branch `bench/detector-eval` @ 6b2f270 · Chromium 143.0.7499.4 headless shell · React 18.3.1 / 19.3.0
(versions read from `React.version` at runtime) · run 2026-09-18.
Evidence class: **local e2e against local fixture pages**. No real third-party app was audited.

**Short answer:** the hypothesis is wrong. The CDP listener check does see React `onClick` on a `<div>`,
because React sets a no-op `el.onclick` on every element that has an `onClick` prop. React div-buttons get
missed for a different reason: the crawler never looks at a plain `<div>` in the first place. That is equally
true for a non-React `addEventListener` div. The fix belongs in the crawler's element discovery, not the
listener check.

## Table

Every cell was measured separately in each build. Build order within a cell is
**18-prod / 18-dev / 19-prod / 19-dev**. "Enumerated" means `crawlDOM` returned the element, and "score" is the
real `getInteractivitySignals` output run through the gap-detector.ts:108-126 formula (threshold 2).
The enumerated and score values were identical in all four builds (see `out/e2e-run.txt`).

| id           | element                                                       | CDP listeners on element      | `__reactProps$*.onClick`                                           | enumerated           | score | flagged by detector (e2e)                   |
| ------------ | ------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------ | -------------------- | ----- | ------------------------------------------- |
| a            | `div.btn` + cursor:pointer + onClick                          | click / click / click / click | function ×4 builds                                                 | yes (`[class*=btn]`) | 2.5   | missing_from_a11y_tree / same / same / same |
| b            | `div` + onClick, no cursor, no class                          | click / click / click / click | function ×4                                                        | **no**               | 2     | no / no / no / no                           |
| c            | `div` + onClick wrapping `span`                               | click / click / click / click | function ×4                                                        | **no**               | 2     | no / no / no / no                           |
| c-child      | the `span` inside c                                           | none ×4                       | undefined ×4; nearest ancestor with onClick = **c, 1 level up** ×4 | no                   | 0     | no ×4                                       |
| d            | `div role=button tabIndex=0` + onClick                        | click / click / click / click | function ×4                                                        | yes                  | 5     | no ×4 (correct: it is accessible)           |
| e            | `button` + onClick                                            | click / click / click / click | function ×4                                                        | yes                  | 4     | no ×4 (correct)                             |
| f            | `div.plain`, no handler (negative)                            | none ×4                       | undefined ×4; no ancestor with onClick                             | no                   | 0     | no ×4 (correct)                             |
| g\*          | `div` + onMouseDown only                                      | **none ×4**                   | undefined; `handlerProps=[onMouseDown]` ×4                         | no                   | 0     | no ×4                                       |
| h\*          | `div` + onKeyDown only                                        | **none ×4**                   | undefined; `handlerProps=[onKeyDown]` ×4                           | no                   | 0     | no ×4                                       |
| i\*          | `div` + onPointerDown only                                    | **none ×4**                   | undefined; `handlerProps=[onPointerDown]` ×4                       | no                   | 0     | no ×4                                       |
| ctl-listener | non-React `div`, `addEventListener('click')` + cursor:pointer | click                         | n/a (no React)                                                     | **no**               | 2     | no                                          |
| ctl-inline   | non-React `div onclick="..."`                                 | click                         | n/a                                                                | yes (`[onclick]`)    | 2     | missing_from_a11y_tree                      |

\* g/h/i go beyond the spec. React only sets the no-op for `onClick`, so these test the other handlers.
Every handler really fired when clicked: `clicked->[a]`, `c-child` click → `[c]`, `f` → `[-]`
(`out/probe-run.txt`). `h` did not log on a mouse click, as expected for a key-only handler.

Containers, all four builds: `#root` had 131 (React 18) / 143 (React 19) listeners, including capture and bubble
`click`/`keydown`/`mousedown`… (React's root-level listeners). `document` had 1 listener. `window` had 13
listeners, and the non-React control page had the same 13, so they are not React's.

## Plain-language answer

**(i) Is the CDP listener check blind to React `onClick` on divs?** No. For every element with an `onClick`
prop (a, b, c, d, e), in React 18 and 19, prod and dev, `DOMDebugger.getEventListeners` returns a `click`
listener. That listener is not your handler. It's an empty function React puts on `el.onclick` as an old Safari
workaround (seen at runtime as `function Zr(){}` in 18-prod, `function noop() { }` in 18-dev,
`function gt(){}` in 19-prod and `function noop$1() { }` in 19-dev). Source: React 18
`react-dom.development.js:9667` `node.onclick = noop`, gated on `typeof props.onClick === 'function'`; React 19
`react-dom-client.development.js:5640, 14222, 21824, 22136` `...onclick = noop$1`; the setProp path at
`21820-21824` is `case "onClick"`.
**The check is blind** to React handlers other than `onClick`: `onMouseDown`, `onKeyDown` and `onPointerDown`
divs (g/h/i) show no listeners at all.

**(ii) Does reading `__reactProps$*.onClick` recover them reliably?** Yes, in all four builds.
A `__reactProps$*` key (plus `__reactFiber$*`) was on every React element, and `typeof onClick === 'function'`
held for exactly a-e. Walking up from `c-child` found `c` one level up. Unlike CDP, the props also expose
g/h/i's handlers. Caveat (ASSUMED, not tested): the `__reactProps$` name is a React internal, used since
React 17; React 16 used a different key.

**(iii) Any false recovery on control f?** None: f had no listeners, `onClick` undefined, and no ancestor with
`onClick`, in all four builds. Two things to watch in a real fix:

- The subtree CDP listing returns `div#root` (React's shared listeners), so root containers must be excluded.
- The ancestor walk assigns c-child's click to `c`. The flag belongs on `c`, not the child.

**Why only `a` was flagged end to end:** `crawlDOM` only visits elements that match its CSS selectors: tags,
`[role]`, `[tabindex]`, the `[onclick]` attribute, and class-name substrings (dom-crawler.ts:19-84, 113-143).
React's no-op is a _property_, not an attribute, so `[onclick]` (dom-crawler.ts:56) never matches. b and c
would pass the threshold (score 2) if they were examined, but they never are. The same happens to the
non-React `ctl-listener`, so this discovery gap affects any JS app, not just React.

**Separate bug found (CONFIRMED):** the cursor:pointer signal is always false. `getInteractivitySignals` opens
a new CDP session and calls `DOM.pushNodesByBackendIdsToFrontend` (dom-crawler.ts:304) without calling
`DOM.getDocument` first. Chromium throws `Document needs to be requested first`, and the empty
`catch {}` at :318 swallows it. After `DOM.getDocument` the same node reads `cursor=pointer`
(`out/cursor-check-run.txt`). That's why `a` scored 2.5 and not 3.5. `isElementVisible` (:362) uses the same
pattern (ASSUMED broken the same way, not tested; it is not on the gap path).

## Fix the detector would need (proposed, not applied)

1. **Find elements by their listeners, not only by selectors.** One call to
   `DOMDebugger.getEventListeners(document, {depth:-1, pierce:true})` returned every element with a click-type
   listener and its node id: a-e plus ctl-listener and ctl-inline, and not f (`out/enumerate-run.txt`).
   Skip React root containers.
2. **Add a React pass**: walk the page for `__reactProps$*` with any `on[A-Z]*` function prop. It found a-e and
   g/h/i and skipped f and c-child. This is the only way to see `onMouseDown`/`onKeyDown`/`onPointerDown`
   handlers.
3. **Fix the cursor signal**: call `DOM.getDocument` in that session before the node push at dom-crawler.ts:304.
4. Consider adding `pointerdown`/`pointerup` to the click-type list (dom-crawler.ts:334). ASSUMED to matter
   for Radix/shadcn-style components, which trigger on pointer events. Not tested here.

## Reproduce

Chromium steps must run outside the Bash sandbox. `build.mjs` installs the pinned React versions into the
gitignored `bench/probes/react/.deps/{react18,react19}` the first time it runs.

```
cd .
node bench/probes/react/build.mjs        # 4 bundles + control page into dist/
node bench/probes/react/probe.mjs        # CDP listeners, __reactProps$, cursor, live clicks -> out/probe-results.json
npx tsx bench/probes/react/e2e.ts        # existing taskgen detector end to end + per-element signals
node bench/probes/react/enumerate.mjs    # the two candidate discovery fixes
node bench/probes/react/cursor-check.mjs # cursor-signal bug
```

## Verifier corrections (2026-09-18, workflow wf_25f6c5c5-8c4)

Two independent verifiers reproduced every headline claim (one with its own scripts and fixture, one with real `vite build`/`vite` dev apps, StrictMode, Tailwind). Corrections:

- **The one hit is React-caused.** `a` is enumerated because of its `btn` class, but its only 2-point signal is React's no-op `el.onclick`. With `el.onclick = null`, `hasClickHandler=false` and `isLikelyInteractive=false`.
- **"1 of 3" depends on the fixture.** On a Vite + Tailwind fixture with no `btn`-style classes, the detector flagged 1 of 8 clickable inaccessible divs. On Tailwind/shadcn apps, expect about 0 from this path.
- **The stale no-op is a false-positive path.** React never removes the no-op `onclick` when `onClick` is removed on re-render, in React 18 and 19 prod. CDP still reports `click`, and the detector scores the element interactive although clicking does nothing. `__reactProps$*` correctly shows it gone, which is one more reason to prefer the props pass over CDP listeners.
- `onClickCapture`-only handlers are also invisible to CDP.
- The build modes are verified directly (`_debugOwner` count in the bundles), not by the `nodeEnv` define.
- **Harness trap:** calling `vite.build()` in-process sets `process.env.NODE_ENV=production` for a later dev server in the same process, and Vite dev `server.port: 0` binds 5173. Run one mode per process.
