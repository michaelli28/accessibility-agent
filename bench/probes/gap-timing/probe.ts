// SPIKE: the gap detector's timing windows (acc-gaps#1, #6). Each row loads a small page of ours, changes it at one
// chosen point inside crawlPageWithGapDetection, or lets the page change itself, and prints what the detector
// reports. A chosen point is a CDP call: the probe wraps the CDP sessions the detector opens and acts just before or
// just after the first matching call. Run it on the commit before the fix and on the fix; RESULT.md has both columns.
// Only what a dev page cannot plant is here: a page that re-mounts itself on a keydown is the dev base
// remount-on-keydown, which bench/gaps-dev.test.ts runs.
//
//   npx tsx bench/probes/gap-timing/probe.ts [scenario ...]   (outside the sandbox: launches Chromium)
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type CDPSession, type Page } from "playwright";
import { crawlPageWithGapDetection } from "../../../packages/accessibility/src/gaps/detect.js";
import * as crawler from "../../../packages/accessibility/src/gaps/dom-crawler.js";
import type {
  DOMElement,
  DualCrawlResult,
} from "../../../packages/accessibility/src/gaps/types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const URL_ = "http://fixture.test/timing.html";

const doc = (body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Timing</title></head><body>${body}</body></html>`;

// Every control is exposed and reachable with Tab: a clean load has no gap.
const CONTROLS =
  doc(`<main><a href="#a" data-bench-id="home">Home</a> <a href="#b" data-bench-id="about">About</a>
<button type="button" data-bench-id="buy" onclick="void 0">Buy</button>
<div role="button" tabindex="0" data-bench-id="cart" onclick="void 0">Cart</div></main>`);

// Zero-area Tab stops (G1c): a nameless link Tab reaches, and a div that blurs itself on focus, so Tab never holds it.
const ZERO =
  doc(`<main><a href="#a" data-bench-id="home">Home</a> <a href="#b" data-bench-id="about">About</a>
<a href="#z" data-bench-id="zero-link" style="display:inline-block;width:0;height:0;overflow:hidden"></a>
<div data-bench-id="zero-blur" tabindex="0" onclick="void 0" onfocus="this.blur()" style="width:0;height:0;overflow:hidden">Z</div></main>`);

// The dev modal: the page behind the dialog is aria-hidden, and Tab loops inside the dialog.
const MODAL = readFileSync(
  path.join(ROOT, "bench", "corpus", "dev", "base", "modal.html"),
  "utf8",
);

// A reduced modal whose aria-hidden page holds a toast the page removes by itself on the third keydown (a notice
// dismissed on interaction). No document is replaced.
const MODAL_TOAST = doc(`<div id="page" aria-hidden="true"><h1>Account</h1>
<button type="button" data-bench-id="trigger">Edit profile</button> <a href="#help" data-bench-id="help-link">Help</a>
<div id="toast" role="status">Saved. <a href="#undo" data-bench-id="undo">Undo</a></div></div>
<div role="dialog" id="dialog" aria-label="Edit profile"><label>Name <input data-bench-id="name"></label>
<button type="button" data-bench-id="save">Save</button></div>
<script>
var dialog = document.getElementById('dialog')
var items = function () { return dialog.querySelectorAll('input, button') }
document.addEventListener('keydown', function (e) {
  var all = items()
  if (e.key === 'Tab' && !e.shiftKey && document.activeElement === all[all.length - 1]) { e.preventDefault(); all[0].focus() }
})
document.addEventListener('focusin', function (e) { if (!dialog.contains(e.target)) items()[0].focus() })
items()[0].focus()
var presses = 0
document.addEventListener('keydown', function () { if (++presses === 3) { var t = document.getElementById('toast'); if (t) t.remove() } })
</script>`);

// No hook: the page appends a named switch every 5 ms from 2.8 s to 4.0 s, across the detector's 3 s settle.
const links = Array.from(
  { length: 100 },
  (_, i) => `<a href="#l${i}">Link ${i}</a>`,
).join(" ");
const TIMER = doc(`<main><nav>${links}</nav><section id="late"></section></main>
<script>
var n = 0, start = performance.now();
setTimeout(function () {
  var t = setInterval(function () {
    if (performance.now() - start > 4000) { clearInterval(t); return; }
    var d = document.createElement('div');
    d.setAttribute('role', 'switch'); d.setAttribute('aria-checked', 'false'); d.tabIndex = 0;
    d.setAttribute('onclick', 'void 0'); d.setAttribute('data-bench-id', 'late-' + (n++)); d.textContent = 'Option ' + n;
    document.getElementById('late').appendChild(d);
  }, 5);
}, 2800);
</script>`);

// 350 candidates for the cost row: 50 links and 300 clickable divs.
const COST = doc(
  `<main>${Array.from({ length: 50 }, (_, i) => `<a href="#c${i}">Link ${i}</a>`).join(" ")}${Array.from({ length: 300 }, (_, i) => `<div onclick="void 0">Item ${i}</div>`).join("")}</main>`,
);

type Params = Record<string, unknown>;
type Hook = {
  when: "before" | "after";
  match: (method: string, params: Params) => boolean;
  act: (page: Page) => Promise<void>;
};

// The tab walk's own marker write (tab-walk.ts injectMarker). Only the first match fires, at the walk's start.
const WALK_MARKER_WRITE = 'window["__atAgentTabWalk"] =';
const isWalkMarkerWrite = (method: string, params: Params): boolean =>
  method === "Runtime.evaluate" &&
  String(params.expression).startsWith(WALK_MARKER_WRITE);
const isAxRead = (method: string): boolean =>
  method === "Accessibility.getFullAXTree";

const reload = async (page: Page): Promise<void> => {
  await page.reload({ waitUntil: "domcontentloaded" });
};
// The same Window (and so the same window properties), every node new.
const reopen = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    const html = "<!doctype html>" + document.documentElement.outerHTML;
    document.open();
    document.write(html);
    document.close();
  });
};

type Scenario = {
  html: string;
  hook: Hook | null;
  tabWalk: false | { settleMs: number };
  runs: number;
};
const WALK = { settleMs: 50 };
const SCENARIOS: Record<string, Scenario> = {
  clean: { html: CONTROLS, hook: null, tabWalk: WALK, runs: 1 },
  // acc-gaps#1, W2: after the crawl, before the walk marks the document.
  "replace-before-walk": {
    html: CONTROLS,
    hook: { when: "before", match: isWalkMarkerWrite, act: reload },
    tabWalk: WALK,
    runs: 1,
  },
  // acc-gaps#1, W1: during the walk's idle baseline, which sees the replacement.
  "replace-in-idle": {
    html: CONTROLS,
    hook: { when: "after", match: isWalkMarkerWrite, act: reload },
    tabWalk: WALK,
    runs: 1,
  },
  "document-open-before-walk": {
    html: CONTROLS,
    hook: { when: "before", match: isWalkMarkerWrite, act: reopen },
    tabWalk: WALK,
    runs: 1,
  },
  // acc-gaps#6: the document replaced right after the accessibility-tree read, with a walk and without one.
  "replace-after-ax": {
    html: CONTROLS,
    hook: { when: "after", match: isAxRead, act: reload },
    tabWalk: WALK,
    runs: 1,
  },
  "replace-after-ax-nowalk": {
    html: CONTROLS,
    hook: { when: "after", match: isAxRead, act: reload },
    tabWalk: false,
    runs: 1,
  },
  // acc-gaps#6 with no hook: late content lands between the reads on its own.
  "timer-no-hook": { html: TIMER, hook: null, tabWalk: false, runs: 5 },
  "modal-clean": { html: MODAL, hook: null, tabWalk: WALK, runs: 1 },
  "modal-replace-before-walk": {
    html: MODAL,
    hook: { when: "before", match: isWalkMarkerWrite, act: reload },
    tabWalk: WALK,
    runs: 1,
  },
  "modal-toast": { html: MODAL_TOAST, hook: null, tabWalk: WALK, runs: 1 },
  "zero-clean": { html: ZERO, hook: null, tabWalk: WALK, runs: 1 },
  "zero-replace-before-walk": {
    html: ZERO,
    hook: { when: "before", match: isWalkMarkerWrite, act: reload },
    tabWalk: WALK,
    runs: 1,
  },
};

// Wraps every CDP session the detector opens on this context; the hook acts once, at its first match.
function hookSessions(page: Page, hook: Hook | null): () => boolean {
  const context = page.context();
  const open = context.newCDPSession.bind(context);
  let fired = false;
  context.newCDPSession = async (target) => {
    const session: CDPSession = await open(target);
    if (hook === null) return session;
    const send = session.send.bind(session) as (
      method: string,
      params?: Params,
    ) => Promise<unknown>;
    Object.assign(session, {
      send: async (method: string, params: Params = {}) => {
        const hit = !fired && hook.match(method, params);
        if (hit && hook.when === "before") {
          fired = true;
          await hook.act(page);
        }
        const result = await send(method, params);
        if (hit && hook.when === "after") {
          fired = true;
          await hook.act(page);
        }
        return result;
      },
    });
    return session;
  };
  return () => fired;
}

const benchId = (e: {
  attributes: Record<string, string>;
  localName: string;
}): string => e.attributes["data-bench-id"] ?? e.localName;

function summarise(r: DualCrawlResult): Params {
  const late = r.gaps.filter((g) =>
    benchId(g.domElement).startsWith("late-"),
  ).length;
  return {
    gaps:
      r.gaps.length > 12
        ? `${r.gaps.length} gaps (${late} on late-*)`
        : r.gaps.map(
            (g) => `${benchId(g.domElement)}:${g.gapType}:${g.severity}`,
          ),
    assessed: r.keyboard.notFocusableAssessed,
    reasons: r.keyboard.unassessedReasons,
    reached: r.keyboard.reachedBackendNodeIds.length,
    hidden:
      r.hidden.length > 6
        ? r.hidden.length
        : r.hidden.map((h) => {
            const e = r.domElements.find(
              (d) => d.backendNodeId === h.backendNodeId,
            );
            return `${e ? benchId(e) : "?"}:${h.reason}`;
          }),
    errors: r.errors.length,
  };
}

const firstLine = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).split("\n")[0];

function commit(): string {
  const git = (...args: string[]): string =>
    spawnSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).stdout.trim();
  const dirty = git(
    "status",
    "--porcelain",
    "--",
    "packages/accessibility/src",
  );
  return `${git("rev-parse", "--short", "HEAD")}${dirty ? " (packages/accessibility/src modified)" : ""}`;
}

async function main(): Promise<void> {
  const only = new Set(process.argv.slice(2));
  const browser = await chromium.launch();
  console.log(JSON.stringify({ browser: browser.version(), code: commit() }));
  try {
    for (const [name, sc] of Object.entries(SCENARIOS)) {
      if (only.size > 0 && !only.has(name)) continue;
      for (let run = 1; run <= sc.runs; run++) {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.route(URL_, (route) =>
          route.fulfill({ contentType: "text/html", body: sc.html }),
        );
        const fired = hookSessions(page, sc.hook);
        const head = {
          scenario: name,
          ...(sc.runs > 1 ? { run } : {}),
        };
        const t0 = Date.now();
        try {
          const r = await crawlPageWithGapDetection(page, URL_, {
            tabWalk: sc.tabWalk,
          });
          console.log(
            JSON.stringify({
              ...head,
              ms: Date.now() - t0,
              hookFired: sc.hook ? fired() : null,
              ...summarise(r),
            }),
          );
        } catch (err) {
          console.log(
            JSON.stringify({
              ...head,
              ms: Date.now() - t0,
              hookFired: sc.hook ? fired() : null,
              threw: firstLine(err),
            }),
          );
        } finally {
          await context.close().catch(() => undefined);
        }
      }
    }
    if (only.size === 0 || only.has("cost")) await cost(browser);
  } finally {
    await browser.close();
  }
}

// The post-walk detach check reads every unreached crawled candidate once; timed directly where the check exists.
async function cost(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
): Promise<void> {
  const anyDetached: unknown = Reflect.get(crawler, "anyDetached");
  if (typeof anyDetached !== "function") {
    console.log(
      JSON.stringify({
        scenario: "cost",
        anyDetachedMs: "n/a: no detach check at this commit",
      }),
    );
    return;
  }
  const check = anyDetached as (
    page: Page,
    elements: readonly DOMElement[],
  ) => Promise<boolean>;
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.route(URL_, (route) =>
      route.fulfill({ contentType: "text/html", body: COST }),
    );
    await page.goto(URL_);
    const { elements } = await crawler.crawlDOM(page, URL_);
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      if (await check(page, elements))
        throw new Error("a clean page read as detached");
      times.push(Math.round(performance.now() - t0));
    }
    console.log(
      JSON.stringify({
        scenario: "cost",
        candidates: elements.length,
        anyDetachedMs: times,
      }),
    );
  } finally {
    await context.close();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
