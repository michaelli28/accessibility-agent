// Legacy (pre-fix) checker replay: the rebuilt identity string must equal what packages/agent/src/tools.ts computes
// in the page, and the trap/dynamic replay must reproduce the known wrap-around and identity-collision artefacts.
// Launches Chromium, so run outside the sandbox: npx vitest run bench/legacy.test.ts
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runTabWalk } from "../packages/accessibility/src/tab-walk.js";
import {
  LEGACY_TRAP_CONFIG,
  legacyIdentity,
  replayLegacy,
  type IdentityFields,
} from "./legacy.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOOLS_TS = join(ROOT, "packages", "agent", "src", "tools.ts");
const LEGACY_TS = join(ROOT, "bench", "legacy.ts");

describe("the freeze", () => {
  // The BEFORE column of the before/after is produced by these replays. If bench ever imports the
  // LIVE checker again, fixing a bug in packages/ silently rewrites results already published under
  // bench/results/cd3b122 — and nothing else in the suite would notice.
  it("is real: bench replays a frozen copy, never the live checker", async () => {
    const source = readFileSync(LEGACY_TS, "utf8");
    expect(source).toContain('from "./legacy-detectors.js"');
    expect(source).not.toMatch(/packages\/accessibility\/src\/(keyboard-trap-detector|dynamic-evaluator)/);

    // The live classes are gone, so the paths bench used to import can no longer resolve. The
    // specifiers are variables on purpose: a literal would make tsc fail on a module that is
    // SUPPOSED to be missing, which is the very thing this test asserts.
    for (const retired of [
      "../packages/accessibility/src/keyboard-trap-detector.js",
      "../packages/accessibility/src/dynamic-evaluator.js",
    ]) {
      await expect(import(/* @vite-ignore */ retired)).rejects.toThrow();
    }
  });
});

// The exact in-page expression executeTab evaluates, read from the source so the test tracks tools.ts.
function toolsIdentityExpression(): string {
  const source = readFileSync(TOOLS_TS, "utf8");
  const match = /playwrightPage\.evaluate<string>\(`([\s\S]*?)`\)/.exec(source);
  if (match === null)
    throw new Error("executeTab identity expression not found in tools.ts");
  if (match[1].includes("${"))
    throw new Error("tools.ts identity expression is no longer a plain string");
  return match[1];
}

type Read = IdentityFields & { hasFocus: boolean };
const read = (fields: Partial<Read>): Read => ({
  tag: "a",
  id: null,
  className: null,
  ariaLabel: null,
  nameProp: null,
  text: null,
  isBody: false,
  hasFocus: true,
  ...fields,
});

describe("legacyIdentity (synthetic reads)", () => {
  it("collapses body and no active element to 'body'", () => {
    expect(legacyIdentity(read({ tag: "body", isBody: true }))).toBe("body");
    expect(
      legacyIdentity(read({ tag: "body", isBody: true, hasFocus: false })),
    ).toBe("body");
    expect(legacyIdentity(read({ tag: null }))).toBe("body");
  });

  it("joins tag, #id, class list and the first name source", () => {
    expect(
      legacyIdentity(
        read({
          tag: "button",
          id: "close",
          className: " x  y ",
          ariaLabel: "Close",
          nameProp: "n",
          text: "X",
        }),
      ),
    ).toBe('button#close.x.y "Close"');
    expect(
      legacyIdentity(
        read({ tag: "input", className: "field", nameProp: "q", text: "" }),
      ),
    ).toBe('input.field "q"');
    expect(legacyIdentity(read({ text: "  Read more  " }))).toBe(
      'a "Read more"',
    );
    expect(
      legacyIdentity(read({ tag: "div", className: "", text: "   " })),
    ).toBe("div");
  });
});

describe("legacyIdentity vs the real tools.ts expression in Chromium", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });

  const FIXTURE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Legacy identity</title></head><body>
<a href="#1" id="plain">Plain link</a>
<button class="btn  primary " aria-label="Close dialog">X</button>
<button aria-label="">   Empty aria-label falls back to text that is far longer than thirty characters   </button>
<input name="q" class="field" type="text">
<input type="text" id="noname">
<a href="#2" name="anchor-name">Anchor with a name attribute</a>
<a href="#3"><img alt="logo" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></a>
<svg width="40" height="20"><a href="#4" class="svg-link"><text x="0" y="15">SVG</text></a></svg>
<div tabindex="0" class="card">
    Leading whitespace card
</div>
<form tabindex="0" id="f"><input name="name" value="clobbers form.name"></form>
<textarea name="msg"></textarea>
<select name="pick"><option>One</option></select>
<div contenteditable="true">Editable</div>
<details><summary>More</summary><p>Hidden</p></details>
<x-host></x-host>
<iframe srcdoc="<button>In frame</button>"></iframe>
<a href="#5" onfocus="this.blur()">Blur me</a>
<a href="#6" id="last">Last</a>
<script>
customElements.define('x-host', class extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<button>In shadow</button>' }
})
</script>
</body></html>`;

  it("matches executeTab's string after every press, including wraps, F55 body, SVG, shadow host and iframe", async () => {
    const expression = toolsIdentityExpression();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(FIXTURE);
    await page.waitForFunction(
      "document.querySelector('iframe').contentDocument?.querySelector('button') !== null",
    );

    const pairs: Array<{ rebuilt: string; real: string; read: Read }> = [];
    for (let press = 0; press < 30; press++) {
      const walk = await runTabWalk(page, {
        presses: 1,
        allowFewerPresses: true,
        escapeProbe: false,
        settleMs: 20,
      });
      const { immediate } = walk.steps[0];
      const real = await page.evaluate<string>(expression);
      pairs.push({ rebuilt: legacyIdentity(immediate), real, read: immediate });
    }
    await context.close();

    for (const p of pairs) expect(p.rebuilt).toBe(p.real);
    const reals = pairs.map((p) => p.real);
    // The fixture really exercised the edge cases the rebuild must handle.
    expect(reals).toContain('button.btn.primary "Close dialog"');
    // Sliced to 30 before trimming: 3 leading spaces eat 3 characters.
    expect(reals).toContain('button "Empty aria-label falls back"');
    expect(reals).toContain("a");
    expect(reals).toContain('a "anchor-name"');
    // SVG className is an SVGAnimatedString, which executeTab drops.
    expect(reals).toContain('a "SVG"');
    expect(reals).toContain('form#f "[object HTMLInputElement]"');
    expect(reals).toContain("x-host");
    expect(reals).toContain("iframe");
    expect(pairs.some((p) => p.read.isBody && p.read.hasFocus)).toBe(true);
    expect(pairs.some((p) => p.read.isBody && !p.read.hasFocus)).toBe(true);
  }, 120_000);

  // #redir hands focus to #target 60 ms after gaining it: executeTab's read lands before the move, the walk's
  // settled read (150 ms later) after it.
  const LATE_MOVE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Late focus move</title></head><body>
<a href="#1" id="first">First</a>
<a href="#2" id="redir">Moves focus later</a>
<a href="#3" id="target">Target</a>
<a href="#4" id="last">Last</a>
<script>
document.getElementById('redir').addEventListener('focus', () =>
  setTimeout(() => document.getElementById('target').focus(), 60))
</script>
</body></html>`;

  it("replays what executeTab reads right after each press, not the settled read, when focus moves 60 ms later", async () => {
    const expression = toolsIdentityExpression();
    const walkContext = await browser.newContext();
    const walkPage = await walkContext.newPage();
    await walkPage.setContent(LATE_MOVE);
    const walk = await runTabWalk(walkPage);
    await walkContext.close();

    // tools.ts: press, then evaluate at once; the pause lets the move land before the next press, as the walk's settle does.
    const toolsContext = await browser.newContext();
    const toolsPage = await toolsContext.newPage();
    await toolsPage.setContent(LATE_MOVE);
    const real: string[] = [];
    for (let press = 0; press < walk.steps.length; press++) {
      await toolsPage.keyboard.press("Tab");
      real.push(await toolsPage.evaluate<string>(expression));
      await toolsPage.waitForTimeout(walk.settleMs + 100);
    }
    await toolsContext.close();

    expect(walk.steps).toHaveLength(30);
    expect(replayLegacy(walk.steps).identities).toEqual(real);
    // The fixture separates the two reads: every press that lands on #redir has already settled on #target.
    const redirects = walk.steps.filter((s) => s.immediate.id === "redir");
    expect(redirects.length).toBeGreaterThanOrEqual(5);
    for (const s of redirects) expect(s.settled.id).toBe("target");
    expect(real).toContain('a#redir "Moves focus later"');
    expect(real).not.toContain('a#target "Target"');
  }, 120_000);
});

// Steps shaped like a headless-shell forward walk: each element once, then a wrap body (hasFocus false).
function walkSteps(
  cycle: Array<Partial<Read>>,
  presses: number,
): Array<{ index: number; immediate: Read }> {
  return Array.from({ length: presses }, (_, i) => ({
    index: i + 1,
    immediate: read(cycle[i % cycle.length]),
  }));
}

const WRAP: Partial<Read> = {
  tag: "body",
  isBody: true,
  hasFocus: false,
};

describe("replayLegacy", () => {
  it("uses the thresholds executeCheckTrap passed at d9e2cb5", () => {
    expect(LEGACY_TRAP_CONFIG).toEqual({
      minCycleCount: 5,
      maxHistorySize: 50,
    });
  });

  it("flags the wrap-around cycle of a clean 3-link page at press 20 (F+1 = 4, five repeats)", () => {
    const links = ["One", "Two", "Three"].map((text) => ({ text }));
    const r = replayLegacy(walkSteps([...links, WRAP], 25));
    expect(r.identities.slice(0, 4)).toEqual([
      'a "One"',
      'a "Two"',
      'a "Three"',
      "body",
    ]);
    expect(r.trap).toEqual({
      trapped: true,
      firstTrappedPress: 20,
      cycleLength: 4,
      // detectTrap names the element one cycle back from the last press (press 22 of 25).
      element: 'a "Two"',
    });
  });

  it("flags identical id-less links as a 1-cycle once five collide in a row", () => {
    const same = Array.from({ length: 12 }, () => ({ text: "Read more" }));
    const r = replayLegacy(walkSteps([...same, WRAP], 70));
    expect(r.trap.firstTrappedPress).toBe(5);
    expect(r.trap.trapped).toBe(true);
  });

  it("flags a repeating 2-string group on a 20-stop page: the trigger is the string cycle, not F", () => {
    const pairs = Array.from({ length: 20 }, (_, i) => ({
      text: i % 2 === 0 ? "Prev" : "Next",
    }));
    const r = replayLegacy(walkSteps([...pairs, WRAP], 105));
    expect(r.trap.firstTrappedPress).toBe(10);
    expect(r.trapByPress[9]).toEqual({
      press: 10,
      trapped: true,
      cycleLength: 2,
    });
  });

  it("never flags a cycle longer than maxHistorySize / minCycleCount (10)", () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({ text: `L${i}` }));
    const r = replayLegacy(walkSteps([...ten, WRAP], 60));
    expect(r.trap).toEqual({
      trapped: false,
      firstTrappedPress: null,
      cycleLength: 0,
      element: null,
    });
  });

  it("reports 2.4.3 focus cycling from the old evaluator but never 3.2.1 (no navigate events in a walk)", () => {
    const r = replayLegacy(
      walkSteps([{ text: "One" }, { text: "Two" }, WRAP], 9),
    );
    expect(r.dynamicViolations.map((v) => v.criterion)).toEqual(["2.4.3"]);
  });

  it("returns a no-trap result for an empty walk", () => {
    const r = replayLegacy([]);
    expect(r.identities).toEqual([]);
    expect(r.trap.trapped).toBe(false);
    expect(r.dynamicViolations).toEqual([]);
  });
});
