// Seeds the variants into a temp dir first (bench/corpus/dev/variants/ is gitignored, so a fresh checkout has none).
// seed.ts launches Chromium: run outside the sandbox, from the worktree root: npx vitest run bench/spotcheck.test.ts
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ElementLabel } from "./corpus/labels-schema.js";
import { MOUNTS, SERVE_ORIGIN, type Mount } from "./serve.js";
import {
  CHECKPOINT1_CORPUS,
  GAP_OPERATORS,
  KEYBOARD_CRITERIA,
  SPOTCHECK_PATH,
  SPOTCHECK_SEED,
  badMappingPool,
  devElementPool,
  devGapTargetPool,
  devPageFlagPool,
  drawSpotcheck,
  loadSources,
  renderSpotcheck,
  type BadLabelsFile,
  type SpotItem,
  type Sources,
  type Spotcheck,
  type Stratum,
} from "./spotcheck.js";

const BENCH = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(BENCH, "..");
const LONG = 240_000;

let tmp = "";
let variantsDir = "";
let sources: Sources;
let drawn: Spotcheck;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "bench-spotcheck-"));
  variantsDir = join(tmp, "variants");
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", join(BENCH, "seed.ts"), "--out", variantsDir],
    { cwd: ROOT, encoding: "utf8", timeout: LONG },
  );
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  sources = loadSources(variantsDir);
  drawn = drawSpotcheck(sources);
}, LONG);

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const keysOf = (stratum: Stratum, items: SpotItem[] = drawn.items): string[] =>
  items.filter((i) => i.stratum === stratum).map((i) => i.key);

const PASS = {
  result: "Pass" as const,
  techniques: ["G21"],
  quoteA: "Technique G21",
  quoteB: null,
  elements: [],
};

// One BAD page: 6 page results (exactly the quota) and one Fail with a B-only mapping listed twice plus 5 shared ones.
function syntheticBad(): BadLabelsFile {
  const shared = ["#s1", "#s2", "#s3", "#s4", "#s5"].map((selector) => ({
    selector,
    readers: ["A" as const, "B" as const],
    snippet: `<a id="${selector.slice(1)}">`,
  }));
  return {
    schemaVersion: 1,
    method: "synthetic",
    sources: [],
    pages: {
      "before/home": {
        report: "before/reports/home.html",
        criteria: {
          ...Object.fromEntries(KEYBOARD_CRITERIA.map((sc) => [sc, PASS])),
          "2.1.1": {
            result: "Fail",
            techniques: ["F54"],
            quoteA: "Failure F54",
            quoteB: "Failure F54",
            elements: [
              {
                selector: "#only-b",
                readers: ["B", "B"],
                snippet: null,
              },
              ...shared,
            ],
          },
        },
      },
    },
  };
}

const withBad = (bad: BadLabelsFile): Sources => ({ ...sources, bad });

describe("drawSpotcheck", () => {
  it("draws 8 dev element labels, 2 dev page flags, 6 BAD page results and 4 BAD mappings, all distinct", () => {
    expect({
      devElement: keysOf("devElement").length,
      devPageFlags: keysOf("devPageFlags").length,
      badPage: keysOf("badPage").length,
      badElement: keysOf("badElement").length,
    }).toEqual({ devElement: 8, devPageFlags: 2, badPage: 6, badElement: 4 });
    expect(new Set(drawn.items.map((i) => i.key)).size).toBe(20);
  });

  it("is deterministic for the checkpoint1-spotcheck seed, matches the committed SPOTCHECK.md, and changes with the seed", () => {
    expect(SPOTCHECK_SEED).toBe("checkpoint1-spotcheck");
    const fresh = renderSpotcheck(
      drawSpotcheck(loadSources(variantsDir), SPOTCHECK_SEED),
    );
    expect(fresh).toBe(renderSpotcheck(drawn));
    // Stale if the labels, operators or draw changed without rerunning: npx tsx bench/spotcheck.ts.
    // The committed file also carries the reviewer's VERDICTS (ticked boxes, filled "agree? / note:"
    // lines), which are answers layered on top of the draw and are not what this test pins. Both
    // sides are stripped back to the drawn state so the draw stays byte-pinned while the answers are
    // free to change -- stripping anything else would let a changed draw pass unnoticed.
    const drawnStateOnly = (md: string): string =>
      md
        .replace(/^(\d+\. )\[[ xX]\]/gm, "$1[ ]")
        .replace(/^(\s+- agree\? \/ note:).*$/gm, "$1");
    expect(drawnStateOnly(readFileSync(SPOTCHECK_PATH, "utf8"))).toBe(
      drawnStateOnly(fresh),
    );
    // The stripping must not be a blanket normaliser: a real change to the draw still fails.
    expect(drawnStateOnly(fresh.replace("1. [ ]", "1. [ ] CHANGED"))).not.toBe(
      drawnStateOnly(fresh),
    );
    const other = drawSpotcheck(sources, "another-seed");
    expect(other.items.map((i) => i.key)).not.toEqual(
      drawn.items.map((i) => i.key),
    );
  });

  it("keeps every dev pool to the Checkpoint-1 corpus: a later base, element or operator never enters the draw", () => {
    const m1 = Object.values(sources.variants.variants).find(
      (v) => v.operator === "M1",
    );
    if (m1 === undefined) throw new Error("no M1 variant to copy");
    const react = sources.base.pages["react-div-button"];
    const later: ElementLabel = {
      interactive: true,
      keyboardAccessible: false,
      expectedGapType: "wrong_role",
      note: "added after Checkpoint 1",
    };
    // A new base, a new element on a Checkpoint-1 base, and a gap-operator variant on each.
    const grown: Sources = {
      ...sources,
      base: {
        ...sources.base,
        pages: {
          ...sources.base.pages,
          "later-base": sources.base.pages[m1.base],
          "react-div-button": {
            ...react,
            elements: { ...react.elements, "later-element": later },
          },
        },
      },
      variants: {
        ...sources.variants,
        variants: {
          ...sources.variants.variants,
          [`later-base__M1__${m1.target}`]: {
            ...m1,
            base: "later-base",
            file: `later-base__M1__${m1.target}.html`,
          },
          "react-div-button__M1__later-element": {
            ...m1,
            base: "react-div-button",
            target: "later-element",
            file: "react-div-button__M1__later-element.html",
            elements: { ...react.elements, "later-element": later },
          },
        },
      },
    };
    const regrown = drawSpotcheck(grown);
    expect(regrown.items.map((i) => i.key)).toEqual(
      drawn.items.map((i) => i.key),
    );
    expect(regrown.poolSizes).toEqual(drawn.poolSizes);
    const bases = new Set(Object.keys(CHECKPOINT1_CORPUS.elements));
    const elements = new Set<string>(
      Object.entries(CHECKPOINT1_CORPUS.elements).flatMap(([base, ids]) =>
        ids.map((id) => `${base}#${id}`),
      ),
    );
    const ops = new Set<string>(CHECKPOINT1_CORPUS.operators);
    // Keys: `<page>` or `<page>#<element>`, where a variant page is `<base>__<op>__<target>`.
    const inside = (key: string): boolean => {
      const [page, id] = key.split("#");
      const [base, op, target] = page.split("__");
      if (op === undefined)
        return id === undefined
          ? bases.has(base)
          : elements.has(`${base}#${id}`);
      return ops.has(op) && elements.has(`${base}#${target}`);
    };
    for (const pool of [
      devElementPool(grown),
      devPageFlagPool(grown),
      ...GAP_OPERATORS.map((op) => devGapTargetPool(grown, op)),
    ]) {
      for (const item of pool) expect(inside(item.key), item.key).toBe(true);
    }
  });

  it("draws one seeded-variant gap target per gap operator M1-M4 among the dev element labels, served under /variants/", () => {
    const targets = drawn.items.filter(
      (i) => i.stratum === "devElement" && i.open.includes("/variants/"),
    );
    expect(targets.length).toBeGreaterThanOrEqual(3);
    expect(targets.map((i) => i.key.split("__")[1]).sort()).toEqual([
      ...GAP_OPERATORS,
    ]);
    for (const t of targets) {
      expect(t.open, t.key).toMatch(
        new RegExp(`^<${SERVE_ORIGIN}/variants/[^>]+\\.html> `),
      );
      expect(t.recorded, t.key).toMatch(
        /expectedGapType=(wrong_role|not_focusable|hidden_but_interactive|no_accessible_name)[ `]/,
      );
    }
    const gapLabels = drawn.items.filter(
      (i) =>
        i.stratum === "devElement" && !/expectedGapType=null/.test(i.recorded),
    );
    expect(gapLabels.length).toBeGreaterThanOrEqual(3);
  });

  it("draws BAD page results only for SC 2.1.1, 2.1.2, 2.4.3, 2.4.7, 3.2.1, 4.1.2", () => {
    const allowed = new Set<string>(KEYBOARD_CRITERIA);
    for (const key of [...keysOf("badPage"), ...keysOf("badElement")]) {
      expect(allowed.has(key.split(" ")[1]), key).toBe(true);
    }
  });

  it("draws BAD mappings proposed by only one reader when at least 4 exist", () => {
    const { single } = badMappingPool(sources);
    expect(single.length).toBeGreaterThanOrEqual(4);
    const singleKeys = new Set(single.map((i) => i.key));
    for (const key of keysOf("badElement")) {
      expect(singleKeys.has(key), key).toBe(true);
    }
  });

  it("counts a reader listed twice (readers B, B) as one reader", () => {
    const { single, shared } = badMappingPool(withBad(syntheticBad()));
    expect(single.map((i) => i.key)).toEqual(["before/home 2.1.1 #only-b"]);
    expect(shared).toHaveLength(5);
  });

  it("never words a mapping on a criterion the page passes as a failing instance", () => {
    const bad = syntheticBad();
    const page = bad.pages["before/home"];
    const onPass: BadLabelsFile = {
      ...bad,
      pages: {
        "before/home": {
          ...page,
          criteria: {
            ...page.criteria,
            "2.4.7": {
              ...PASS,
              elements: [{ selector: "#pass", readers: ["A"], snippet: null }],
            },
          },
        },
      },
    };
    const { single, shared } = badMappingPool(withBad(onPass));
    const all = [...single, ...shared];
    const recordedFor = (key: string): string =>
      all.find((i) => i.key === key)?.recorded ?? `no item ${key}`;
    expect(recordedFor("before/home 2.4.7 #pass")).not.toMatch(
      /failing instance/,
    );
    expect(recordedFor("before/home 2.4.7 #pass")).toContain(
      "which this page passes (page result Pass",
    );
    expect(recordedFor("before/home 2.1.1 #only-b")).toMatch(
      /^a failing instance of SC 2\.1\.1 /,
    );
  });

  it("words element tests to observe focus, never presume it (mouse-only div, tabindex=0 focus guard)", () => {
    const pool = devElementPool(sources);
    const testFor = (key: string): string =>
      pool.find((i) => i.key === key)?.test ?? `no item ${key}`;
    for (const key of [
      "react-div-button#add-to-cart-div",
      "modal#focus-guard-start",
    ]) {
      expect(testFor(key)).toContain("note whether it ever takes focus");
    }
    for (const item of pool) {
      expect(item.test, item.key).not.toMatch(
        /until it has focus|never takes focus/,
      );
    }
  });

  it("tops up from both-reader mappings when fewer than 4 single-reader ones exist", () => {
    const keys = keysOf(
      "badElement",
      drawSpotcheck(withBad(syntheticBad())).items,
    );
    expect(keys).toHaveLength(4);
    expect(keys).toContain("before/home 2.1.1 #only-b");
  });
});

describe("renderSpotcheck", () => {
  it("is a checklist numbered 1-20, each item with a blank agree/note field", () => {
    const md = renderSpotcheck(drawn);
    const numbers = [...md.matchAll(/^(\d+)\. \[ \] /gm)].map((m) =>
      Number(m[1]),
    );
    expect(numbers).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(md.match(/^ {4}- agree\? \/ note:$/gm)).toHaveLength(20);
  });

  it("links only to files bench/serve.ts serves", () => {
    const md = renderSpotcheck(drawn);
    const manifest = z
      .object({ files: z.record(z.string()) })
      .parse(
        JSON.parse(
          readFileSync(
            join(BENCH, "corpus", "test", "bad-manifest.json"),
            "utf8",
          ),
        ),
      );
    // serve.ts serves the seeded variants dir; the gitignored vendor/bad is pinned by the committed manifest.
    const dirs: Record<Mount, string> = {
      ...MOUNTS,
      "/variants/": variantsDir,
    };
    const urls = [...md.matchAll(/<(http:\/\/[^>]+)>/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThanOrEqual(20);
    for (const url of urls) {
      expect(url.startsWith(`${SERVE_ORIGIN}/`), url).toBe(true);
      const path = decodeURI(url.slice(SERVE_ORIGIN.length));
      const mount = (Object.keys(MOUNTS) as Mount[]).find((m) =>
        path.startsWith(m),
      );
      expect(mount, url).toBeDefined();
      if (mount === undefined) continue;
      const rel = path.slice(mount.length);
      if (mount === "/bad/") expect(rel in manifest.files, url).toBe(true);
      else expect(existsSync(join(dirs[mount], rel)), url).toBe(true);
    }
  });
});
