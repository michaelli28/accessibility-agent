// The gap detector against the dev-corpus labels: every base, every seeded variant (generated into a temp dir, as
// seed.test.ts does) and a React stale-no-op page built here. Dev material only: never bench/corpus/test, the vendored
// W3C pages or any test-* results. Launches Chromium, so run outside the sandbox: npx vitest run bench/gaps-dev.test.ts
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { crawlPageWithGapDetection } from "../packages/accessibility/src/gaps/detect.js";
import type { DualCrawlResult } from "../packages/accessibility/src/gaps/types.js";
import { runTabWalk } from "../packages/accessibility/src/tab-walk.js";
import { buildReactBase } from "./corpus/dev/base/react-div-button/build.js";
import {
  BaseLabelsFileSchema,
  VariantLabelsFileSchema,
  acceptedGapTypes,
  type BaseLabelsFile,
  type ElementLabel,
  type PageFlags,
  type VariantLabelsFile,
} from "./corpus/labels-schema.js";
import { startStaticServer, type StaticServer } from "./seed.js";

const BENCH = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(BENCH, "..");
const CORPUS = join(BENCH, "corpus", "dev");
const REACT_MODULES = join(CORPUS, ".deps", "react-18.3.1", "node_modules");
const TSX = join(ROOT, "node_modules", ".bin", "tsx");
const LONG = 600_000;
// A short settle keeps the walks fast; these pages move focus synchronously, except M8, whose 60 ms blur lands after
// this settle and before the harness's default one (both read the target as reached, so both miss it).
const OPTIONS = { tabWalk: { settleMs: 30 } };

// React removes onClick on re-render but leaves the no-op el.onclick it planted (bench/probes/react/RESULT.md).
const STALE_APP = `
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
function App() {
  const [armed, setArmed] = useState(true);
  useEffect(() => { setArmed(false); }, []);
  return (
    <main>
      <h1>Stale handler</h1>
      <div data-bench-id="stale-div" onClick={armed ? () => {} : undefined}>Was clickable</div>
      <div data-bench-id="live-div" onClick={() => {}}>Still clickable</div>
      <p data-bench-id="state">{armed ? "armed" : "disarmed"}</p>
    </main>
  );
}
createRoot(document.getElementById("root")).render(<App />);
`;

let tmp = "";
let server: StaticServer;
let browser: Browser;
let baseLabels: BaseLabelsFile;
let variantLabels: VariantLabelsFile;
// How many variants the seeder reported writing: the count is the seeder's, never a number pinned here.
let seededCount = 0;
const rows: string[] = [];

type Row = { page: string; gaps: string; expected: string; problems: string[] };

async function detect(path: string): Promise<DualCrawlResult> {
  const context = await browser.newContext();
  try {
    return await crawlPageWithGapDetection(
      await context.newPage(),
      `${server.origin}${path}`,
      OPTIONS,
    );
  } finally {
    await context.close();
  }
}

const describeGap = (g: DualCrawlResult["gaps"][number]): string =>
  `${g.gapType}@${g.domElement.attributes["data-bench-id"] ?? `${g.domElement.nodeName}${g.domElement.attributes.class ? `.${g.domElement.attributes.class}` : ""}`}`;

// Every labelled element must get an accepted type (or none); a target must get exactly its expected type; any gap
// on an untagged or unlabelled element is a false alarm.
function checkPage(
  page: string,
  labels: Record<string, ElementLabel>,
  result: DualCrawlResult,
  target?: string,
): Row {
  const problems: string[] = [];
  const byId = new Map<string, string[]>();
  for (const g of result.gaps) {
    const id = g.domElement.attributes["data-bench-id"];
    if (id === undefined || !(id in labels))
      problems.push(`unlabelled ${describeGap(g)}`);
    else byId.set(id, [...(byId.get(id) ?? []), g.gapType]);
  }
  for (const [id, label] of Object.entries(labels)) {
    const got = byId.get(id) ?? [];
    const accepted: string[] = acceptedGapTypes(label);
    if (id === target) {
      const want =
        label.expectedGapType === null ? [] : [label.expectedGapType];
      if (JSON.stringify(got) !== JSON.stringify(want))
        problems.push(`target ${id}: want [${want}] got [${got}]`);
    } else if (
      accepted.length === 0
        ? got.length > 0
        : !got.every((t) => accepted.includes(t)) || got.length === 0
    ) {
      problems.push(`${id}: want [${accepted}] got [${got}]`);
    }
  }
  const expected = Object.entries(labels)
    .filter(([, l]) => l.expectedGapType !== null)
    .map(([id, l]) => `${l.expectedGapType}@${id}`);
  const row = {
    page,
    gaps: result.gaps.map(describeGap).join(", ") || "-",
    expected: expected.join(", ") || "-",
    problems,
  };
  rows.push(
    `| ${row.page} | ${row.gaps} | ${row.expected} | ${problems.length === 0 ? "ok" : "MISMATCH"} |`,
  );
  return row;
}

// not_focusable needs a complete walk: none on a page with a trap or a focus-triggered navigation.
function checkKeyboard(
  page: string,
  flags: PageFlags,
  result: DualCrawlResult,
): string[] {
  const expectAssessed = !flags.keyboardTrap && !flags.contextChangeOnFocus;
  const assessed = result.keyboard?.notFocusableAssessed;
  return assessed === expectAssessed
    ? []
    : [
        `${page}: notFocusableAssessed ${String(assessed)}, want ${expectAssessed} (${result.keyboard?.unassessedReasons.join(",") ?? "no keyboard evidence"})`,
      ];
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bench-gaps-dev-"));
  const variantsDir = join(tmp, "variants");
  const seed = spawnSync(TSX, [join(BENCH, "seed.ts"), "--out", variantsDir], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 240_000,
  });
  expect(seed.status, `${seed.stdout}${seed.stderr}`).toBe(0);
  seededCount = Number(/^wrote (\d+) variants/m.exec(seed.stdout)?.[1] ?? 0);
  baseLabels = BaseLabelsFileSchema.parse(
    JSON.parse(readFileSync(join(CORPUS, "labels.json"), "utf8")),
  );
  variantLabels = VariantLabelsFileSchema.parse(
    JSON.parse(readFileSync(join(variantsDir, "labels.json"), "utf8")),
  );

  await buildReactBase();
  const staleDir = join(tmp, "stale");
  mkdirSync(staleDir);
  const bundle = await build({
    stdin: { contents: STALE_APP, loader: "jsx", resolveDir: staleDir },
    bundle: true,
    format: "iife",
    minify: true,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    nodePaths: [REACT_MODULES],
    write: false,
    logLevel: "warning",
  });
  writeFileSync(join(staleDir, "app.js"), bundle.outputFiles[0].text);
  writeFileSync(
    join(staleDir, "index.html"),
    '<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><title>Stale React handler</title></head><body><div id="root"></div><script src="app.js"></script></body></html>',
  );

  server = await startStaticServer({
    "/corpus/": CORPUS,
    "/variants/": variantsDir,
    "/stale/": staleDir,
  });
  browser = await chromium.launch();
}, LONG);

afterAll(async () => {
  console.log(
    [
      "| page | gaps (type@data-bench-id) | labelled | verdict |",
      "|---|---|---|---|",
      ...rows,
    ].join("\n"),
  );
  await browser?.close();
  await server?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("dev bases (F1 navbar hidden elements, F2/F9 React div, F3 walk, 0 gaps on accessible controls)", () => {
  it(
    "every base page matches its labels, with not_focusable assessed only on trap-free pages",
    async () => {
      const problems: string[] = [];
      for (const [pageId, base] of Object.entries(baseLabels.pages)) {
        const result = await detect(`/corpus/${base.file}`);
        problems.push(
          ...checkPage(pageId, base.elements, result).problems.map(
            (p) => `${pageId}: ${p}`,
          ),
        );
        problems.push(...checkKeyboard(pageId, base.page, result));
      }
      // Recorded, not hidden, and pinned both ways, as in the variant test below.
      const known = [
        // <main> is re-rendered on the first keydown, so the walk reaches only new nodes, none the crawl listed. The
        // crawled nodes it never reached have left the document, so the walk is refused and not_focusable is not
        // assessed: no gap, and 2.1.1 and 2.4.7 undetermined, on a page labelled clean.
        "remount-on-keydown: notFocusableAssessed false, want true (crawled-nodes-detached)",
      ];
      expect(problems.filter((p) => known.includes(p)).sort()).toEqual(
        [...known].sort(),
      );
      expect(problems.filter((p) => !known.includes(p))).toEqual([]);
    },
    LONG,
  );
});

describe("dev variants (every seeded target and every other labelled element)", () => {
  it(
    "M1 -> wrong_role, M2/M7/M8/M9 -> not_focusable, M3 -> hidden_but_interactive, M4 -> no_accessible_name, M5/M6/M10-M12 -> none, M13 (decoy) -> none",
    async () => {
      const problems: string[] = [];
      const variants = Object.entries(variantLabels.variants).sort(
        ([a], [b]) => (a < b ? -1 : 1),
      );
      expect(seededCount).toBeGreaterThan(0);
      expect(variants).toHaveLength(seededCount);
      for (const [id, v] of variants) {
        const result = await detect(`/variants/${v.file}`);
        problems.push(
          ...checkPage(id, v.elements, result, v.target).problems.map(
            (p) => `${id}: ${p}`,
          ),
        );
        problems.push(...checkKeyboard(id, v.page, result));
      }
      // Recorded, not hidden, and pinned both ways: the day one is fixed, or another joins them, this test is red.
      const known = [
        // The detector's not_focusable branch needs a click handler or cursor:pointer
        // (packages/accessibility/src/gaps/gap-detector.ts:227-231), which an <input> has neither of, so the F55
        // input's 2.1.1 failure is missed.
        "form__M7__email-input: target email-input: want [not_focusable] got []",
        "form__M9__email-input: target email-input: want [not_focusable] got []",
        // Focus held for tens of milliseconds counts as reached: the detector takes an element as reached when
        // either read after a Tab press found focus on it (gaps/keyboard.ts), and M8 blurs 60 ms after arrival.
        "form__M8__email-input: target email-input: want [not_focusable] got []",
        "good-operable__M8__nav-about: target nav-about: want [not_focusable] got []",
        "identical-links__M8__read-more-01: target read-more-01: want [not_focusable] got []",
        "js-handlers__M8__custom-button: target custom-button: want [not_focusable] got []",
        "navbar__M8__brand: target brand: want [not_focusable] got []",
        "three-links__M8__link-1: target link-1: want [not_focusable] got []",
        "disclosure-tabs__M8__a-skip-link: target a-skip-link: want [not_focusable] got []",
        "one-button__M8__only-button: target only-button: want [not_focusable] got []",
        "scroll-panel__M8__agree-button: target agree-button: want [not_focusable] got []",
      ];
      // Sorted: the list is grouped by cause, the problems come in variant order.
      expect(problems.filter((p) => known.includes(p)).sort()).toEqual(
        [...known].sort(),
      );
      expect(problems.filter((p) => !known.includes(p))).toEqual([]);
    },
    LONG,
  );

  it(
    "an addEventListener div with no class, role or tabindex (good-operable M1) is found and flagged",
    async () => {
      const result = await detect(
        "/variants/good-operable__M1__search-submit.html",
      );
      const target = result.domElements.find(
        (e) => e.attributes["data-bench-id"] === "search-submit",
      );
      expect(target?.attributes).toEqual({
        "data-bench-id": "search-submit",
        style: "cursor: pointer; display: inline-block;",
      });
      expect(result.gaps.map(describeGap)).toEqual([
        "wrong_role@search-submit",
      ]);
    },
    LONG,
  );
});

describe("M7 blur-on-focus (F55: focus removed as soon as it arrives)", () => {
  it("seeds one variant per clean page, flagged focusLostOnArrival and nothing else", () => {
    const m7 = Object.entries(variantLabels.variants)
      .filter(([, v]) => v.operator === "M7")
      .sort(([a], [b]) => (a < b ? -1 : 1));
    expect(m7.map(([id]) => id)).toEqual([
      "disclosure-tabs__M7__a-skip-link",
      "form__M7__email-input",
      "good-operable__M7__nav-about",
      "identical-links__M7__read-more-01",
      "js-handlers__M7__custom-button",
      "navbar__M7__brand",
      "one-button__M7__only-button",
      "scroll-panel__M7__agree-button",
      "three-links__M7__link-1",
    ]);
    // F55 is a focus-lost page, not a trap: bench/probes/wrap/RESULT.md records that the next Tab
    // continues past the blurred element. Its 3.2.1 is the context-change judge's, so the corpus
    // does not also flag contextChangeOnFocus (one observation, one criterion).
    for (const [id, v] of m7) {
      expect(
        [
          v.page.focusLostOnArrival,
          v.page.keyboardTrap,
          v.page.trapEscapable,
          v.page.contextChangeOnFocus,
        ],
        id,
      ).toEqual([true, false, null, false]);
    }
  });

  it(
    "the seeded element really drops focus to body with document.hasFocus() true, and the next Tab continues past it",
    async () => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(`${server.origin}/variants/form__M7__email-input.html`);
        const walk = await runTabWalk(page, { settleMs: 30 });
        expect(walk.error).toBeNull();
        // A wrap body reads hasFocus false; only a post-blur body reads it true (RESULT.md fixture E).
        const dropped = walk.steps.filter(
          (s) => s.settled.isBody && s.settled.hasFocus,
        );
        expect(dropped.map((s) => s.index).length).toBeGreaterThan(0);
        // Still not a trap: the walk reaches the end of the page.
        expect(walk.steps.some((s) => s.wrapped)).toBe(true);
        expect(walk.suspectedTrap).toBe(false);
        // steps[i] is the press after the 1-indexed step i: focus resumes on a real element.
        const next = walk.steps[dropped[0].index];
        expect(next?.settled.isBody, `press ${dropped[0].index + 1}`).toBe(
          false,
        );
      } finally {
        await context.close();
      }
    },
    LONG,
  );
});

describe("React stale no-op onclick (F9: __reactProps$ is the source of truth)", () => {
  it(
    "flags the live onClick div and not the div whose onClick React removed",
    async () => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(`${server.origin}/stale/index.html`);
        await page.waitForSelector("text=disarmed");
        // The premise: the stale div still carries React's no-op el.onclick, but its props have no onClick.
        const premise = z
          .object({ onclick: z.string(), propsOnClick: z.string() })
          .parse(
            await page.evaluate(
              `(function () { var el = document.querySelector('[data-bench-id="stale-div"]'); var k = Object.keys(el).filter(function (x) { return x.indexOf('__reactProps$') === 0; })[0]; return { onclick: typeof el.onclick, propsOnClick: typeof el[k].onClick }; })()`,
            ),
          );
        expect(premise).toEqual({
          onclick: "function",
          propsOnClick: "undefined",
        });
      } finally {
        await context.close();
      }
      const result = await detect("/stale/index.html");
      expect(result.gaps.map(describeGap)).toEqual(["wrong_role@live-div"]);
    },
    LONG,
  );
});
