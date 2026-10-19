// Dev-corpus seeding: determinism, the --check contract, and that the labels match real behaviour in Chromium.
// Run from the worktree root outside the sandbox (launches Chromium): npx vitest run bench/seed.test.ts
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BaseLabelsFileSchema,
  LiveSitesFileSchema,
  OPERATOR_IDS,
  VariantLabelsFileSchema,
  type BaseLabelsFile,
  type ElementLabel,
  type OperatorId,
  type VariantLabels,
  type VariantLabelsFile,
} from "./corpus/labels-schema.js";
import { startStaticServer, type StaticServer } from "./seed.js";

const BENCH = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(BENCH, "..");
const CORPUS = join(BENCH, "corpus", "dev");
const TSX = join(ROOT, "node_modules", ".bin", "tsx");
const SEED = join(BENCH, "seed.ts");
const LONG = 240_000;

function runSeed(args: string[]): { status: number | null; output: string } {
  const r = spawnSync(TSX, [SEED, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: LONG,
  });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

function readTree(dir: string): Map<string, Buffer> {
  return new Map(
    readdirSync(dir)
      .sort()
      .map((f): [string, Buffer] => [f, readFileSync(join(dir, f))]),
  );
}

let tmp = "";
let outA = "";
let outB = "";
let baseLabels: BaseLabelsFile;
let variantLabels: VariantLabelsFile;
let server: StaticServer;
let browser: Browser;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bench-seed-"));
  outA = join(tmp, "a");
  outB = join(tmp, "b");
  const first = runSeed(["--out", outA]);
  expect(first.status, first.output).toBe(0);
  const second = runSeed(["--out", outB]);
  expect(second.status, second.output).toBe(0);
  baseLabels = BaseLabelsFileSchema.parse(
    JSON.parse(readFileSync(join(CORPUS, "labels.json"), "utf8")),
  );
  variantLabels = VariantLabelsFileSchema.parse(
    JSON.parse(readFileSync(join(outA, "labels.json"), "utf8")),
  );
  server = await startStaticServer({ "/corpus/": CORPUS, "/variants/": outA });
  browser = await chromium.launch();
}, LONG);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function variants(): [string, VariantLabels][] {
  return Object.entries(variantLabels.variants).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
}

// Every variant of an operator: a behaviour test that took only the first would depend on which base sorts first.
function ofOperator(op: OperatorId): [string, VariantLabels][] {
  const found = variants().filter(([, v]) => v.operator === op);
  if (found.length === 0) throw new Error(`no variant for ${op}`);
  return found;
}

const sel = (id: string): string => `[data-bench-id="${id}"]`;

async function open(path: string, ids: string[]): Promise<Page> {
  const page = await browser.newPage();
  await page.goto(`${server.origin}${path}`, { waitUntil: "load" });
  // React pages render after load; static pages pass immediately.
  await page.waitForFunction(
    `${JSON.stringify(ids)}.every(function (id) { return document.querySelector('[data-bench-id="' + id + '"]') !== null; })`,
  );
  return page;
}

async function activeId(page: Page): Promise<string | null> {
  const v: unknown = await page.evaluate(
    'document.activeElement ? document.activeElement.getAttribute("data-bench-id") : null',
  );
  return typeof v === "string" ? v : null;
}

const AxNodeSchema = z.object({
  ignored: z.boolean(),
  role: z.object({ value: z.string() }).optional(),
  name: z.object({ value: z.string() }).optional(),
});

async function axNode(
  page: Page,
  id: string,
): Promise<z.infer<typeof AxNodeSchema>> {
  const cdp = await page.context().newCDPSession(page);
  const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
  const { nodeId } = await cdp.send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector: sel(id),
  });
  const { nodes } = await cdp.send("Accessibility.getPartialAXTree", {
    nodeId,
    fetchRelatives: false,
  });
  await cdp.detach();
  return AxNodeSchema.parse(nodes[0]);
}

describe("generation", () => {
  it("is deterministic: two runs are byte-identical", () => {
    const a = readTree(outA);
    const b = readTree(outB);
    expect([...a.keys()]).toEqual([...b.keys()]);
    expect(a.size).toBeGreaterThan(1);
    for (const [name, bytes] of a)
      expect(bytes.equals(b.get(name) ?? Buffer.alloc(0)), name).toBe(true);
  });

  it("produces at least one variant per operator, and exactly one file per labelled variant", () => {
    for (const op of OPERATOR_IDS) {
      expect(
        variants().filter(([, v]) => v.operator === op).length,
        op,
      ).toBeGreaterThan(0);
    }
    const expected = [
      ...variants().map(([id]) => `${id}.html`),
      "labels.json",
    ].sort();
    expect(readdirSync(outA).sort()).toEqual(expected);
  });

  it("derives variant labels from the base labels: only the target (and what it reveals) changes", () => {
    for (const [id, v] of variants()) {
      const base = baseLabels.pages[v.base];
      expect(base, id).toBeDefined();
      const lostKeyboard = ["M1", "M2", "M8", "M9", "M13"].includes(v.operator);
      const revealedByTarget = (label: ElementLabel): boolean => {
        const seen = new Set<string>();
        let cur = label.revealedBy;
        while (cur && !seen.has(cur)) {
          if (cur === v.target) return true;
          seen.add(cur);
          cur = base.elements[cur]?.revealedBy;
        }
        return false;
      };
      expect(Object.keys(v.elements).sort(), id).toEqual(
        Object.keys(base.elements).sort(),
      );
      for (const [benchId, label] of Object.entries(v.elements)) {
        const before = base.elements[benchId];
        if (benchId === v.target) continue;
        if (lostKeyboard && revealedByTarget(before)) {
          expect(label.keyboardAccessible, `${id} ${benchId}`).toBe(false);
        } else {
          expect(label, `${id} ${benchId}`).toEqual(before);
        }
      }
      const target = v.elements[v.target];
      const expectedGap: Record<OperatorId, string | null> = {
        M1: "wrong_role",
        M2: "not_focusable",
        M3: "hidden_but_interactive",
        M4: "no_accessible_name",
        M5: null,
        M6: null,
        M7: "not_focusable",
        M8: "not_focusable",
        M9: "not_focusable",
        M10: null,
        M11: null,
        M12: null,
        // The decoy: the page switched the target off, so the right answer is no gap.
        M13: null,
      };
      expect(target.expectedGapType, id).toBe(expectedGap[v.operator]);
      expect(target.interactive, id).toBe(v.operator !== "M13");
      if (v.operator === "M1") {
        expect(target.acceptableGapTypes, id).toEqual([
          "wrong_role",
          "not_focusable",
        ]);
      }
      if (v.operator === "M3") {
        expect(target.acceptableGapTypes, id).toEqual([
          "hidden_but_interactive",
          "missing_from_a11y_tree",
        ]);
      }
      const trap = ["M5", "M10", "M11", "M12"].includes(v.operator);
      expect(v.page.keyboardTrap, id).toBe(
        trap ? true : base.page.keyboardTrap,
      );
      expect(v.page.trapEscapable, id).toBe(
        trap ? false : base.page.trapEscapable,
      );
      expect(v.page.contextChangeOnFocus, id).toBe(
        v.operator === "M6" ? true : base.page.contextChangeOnFocus,
      );
      expect(v.page.focusLostOnArrival, id).toBe(
        ["M7", "M8", "M9"].includes(v.operator)
          ? true
          : base.page.focusLostOnArrival,
      );
    }
  });

  it("ships valid live-site metadata", () => {
    const live = LiveSitesFileSchema.parse(
      JSON.parse(readFileSync(join(CORPUS, "live-sites.json"), "utf8")),
    );
    expect(live.sites.map((s) => s.id).sort()).toEqual(
      ["amazon", "cmu", "fake-university", "mealkeyway", "troy-k12"].sort(),
    );
    expect(live.excluded.map((s) => s.id)).toEqual(["troyroyalpalace"]);
  });
});

describe("seed --check", () => {
  it(
    "passes on freshly generated variants",
    () => {
      const r = runSeed(["--check", "--out", outA]);
      expect(r.status, r.output).toBe(0);
    },
    LONG,
  );

  it(
    "fails when a variant changes a second tagged element",
    () => {
      const dir = join(tmp, "tamper-second");
      cpSync(outA, dir, { recursive: true });
      const file = join(dir, "three-links__M3__link-1.html");
      const html = readFileSync(file, "utf8");
      expect(html).toContain(">Two<");
      writeFileSync(file, html.replace(">Two<", ">Tampered<"));
      const r = runSeed(["--check", "--out", dir]);
      expect(r.status).not.toBe(0);
      expect(r.output).toMatch(
        /three-links__M3__link-1: tagged elements differ from base: link-1, link-2/,
      );
    },
    LONG,
  );

  it(
    "fails when a variant changes markup outside every tagged element",
    () => {
      const dir = join(tmp, "tamper-outside");
      cpSync(outA, dir, { recursive: true });
      const file = join(dir, "three-links__M3__link-1.html");
      const html = readFileSync(file, "utf8");
      expect(html).toContain("<h1>Three links</h1>");
      writeFileSync(
        file,
        html.replace("<h1>Three links</h1>", "<h1>Changed</h1>"),
      );
      const r = runSeed(["--check", "--out", dir]);
      expect(r.status).not.toBe(0);
      expect(r.output).toMatch(
        /three-links__M3__link-1: markup outside tagged elements differs from base/,
      );
    },
    LONG,
  );
});

const FactsSchema = z.array(
  z.object({
    id: z.string(),
    tabIndex: z.number(),
    disabled: z.boolean(),
    visible: z.boolean(),
    // Inside a composite widget (the roles gaps/dom-crawler.ts COMPOSITE_ROLES lists), counting from the parent.
    widgetMember: z.boolean(),
  }),
);

describe("labels agree with the DOM", () => {
  it(
    "every tagged element is labelled, and focusability matches keyboardAccessible",
    async () => {
      const pages = [
        ...Object.entries(baseLabels.pages).map(([id, p]) => ({
          id,
          path: `/corpus/${p.file}`,
          labels: p,
        })),
        ...variants().map(([id, v]) => ({
          id,
          path: `/variants/${v.file}`,
          labels: v,
        })),
      ];
      const roving = new Set<string>();
      for (const p of pages) {
        const page = await open(p.path, Object.keys(p.labels.elements));
        const facts = FactsSchema.parse(
          await page.evaluate(`Array.prototype.map.call(document.querySelectorAll('[data-bench-id]'), function (el) {
            return { id: el.getAttribute('data-bench-id'), tabIndex: el.tabIndex, disabled: el.disabled === true,
              visible: el.checkVisibility({ visibilityProperty: true, opacityProperty: true }),
              widgetMember: el.parentElement !== null && el.parentElement.closest(
                '[role="radiogroup"], [role="tablist"], [role="menu"], [role="menubar"], [role="listbox"], ' +
                '[role="grid"], [role="treegrid"], [role="tree"], [role="toolbar"]') !== null };
          })`),
        );
        await page.close();
        expect(facts.map((f) => f.id).sort(), p.id).toEqual(
          Object.keys(p.labels.elements).sort(),
        );
        for (const f of facts) {
          const label = p.labels.elements[f.id];
          const where = `${p.id} ${f.id}`;
          if (label.revealedBy) {
            expect(f.visible, `${where} is hidden until revealed`).toBe(false);
          } else if (
            label.interactive &&
            label.keyboardAccessible &&
            f.widgetMember &&
            f.tabIndex === -1
          ) {
            // Roving tabindex: a composite widget's inactive member is out of the Tab order by design and reached
            // with arrow keys. The markup side is asserted here, the arrow keys in "base pages behave as labelled"
            // (disclosure-tabs); the pinned list below keeps a new member from slipping through untested.
            roving.add(`${"base" in p.labels ? p.labels.base : p.id} ${f.id}`);
            expect(
              !f.disabled && f.visible,
              `${where} is a visible roving-tabindex member`,
            ).toBe(true);
          } else if (label.interactive && label.keyboardAccessible) {
            // native-dialog's background controls pass only because el.tabIndex ignores inertness: the modal
            // opened on load blocks them until Confirm closes it ("base pages behave as labelled").
            expect(
              f.tabIndex >= 0 && !f.disabled && f.visible,
              `${where} is focusable`,
            ).toBe(true);
          } else if (
            "target" in p.labels &&
            p.labels.page.focusLostOnArrival &&
            f.id === p.labels.target
          ) {
            // M7-M9 take keyboard access away at run time, not in the markup: a focus handler blurs the
            // element, so it stays focusable in the DOM while a Tab walk can never leave focus on it.
            // Asserting the markup side keeps this case honest instead of exempt.
            expect(
              f.tabIndex >= 0 && !f.disabled && f.visible,
              `${where} is focusable in markup and blurred at run time`,
            ).toBe(true);
          } else if (label.interactive) {
            expect(f.tabIndex, `${where} is not focusable`).toBeLessThan(0);
          }
        }
      }
      expect([...roving].sort()).toEqual([
        "disclosure-tabs contents-tab-2",
        "disclosure-tabs float-tab-2",
      ]);
    },
    LONG,
  );
});

describe("operators behave as labelled", () => {
  it(
    "M1 turns a native button into a mouse-only div",
    async () => {
      for (const [id, v] of ofOperator("M1")) {
        const page = await open(`/variants/${v.file}`, [v.target]);
        expect(
          await page.evaluate(
            `document.querySelector('${sel(v.target)}').tagName`,
          ),
          id,
        ).toBe("DIV");
        expect(
          await page.evaluate(
            `document.querySelector('${sel(v.target)}').tabIndex`,
          ),
          id,
        ).toBe(-1);
        expect((await axNode(page, v.target)).role?.value, id).not.toBe(
          "button",
        );
        await page.click(sel(v.target));
        expect(await page.evaluate("window.__benchClicks"), id).toEqual([
          v.target,
        ]);
        await page.close();
      }
    },
    LONG,
  );

  it(
    "M2 leaves a role=button div out of the tab order",
    async () => {
      for (const [id, v] of ofOperator("M2")) {
        const page = await open(`/variants/${v.file}`, [v.target]);
        expect(
          await page.evaluate(
            `document.querySelector('${sel(v.target)}').tabIndex`,
          ),
          id,
        ).toBe(-1);
        expect((await axNode(page, v.target)).role?.value, id).toBe("button");
        await page.close();
      }
    },
    LONG,
  );

  it(
    "M3 hides a focusable control from assistive technology",
    async () => {
      for (const [id, v] of ofOperator("M3")) {
        const page = await open(`/variants/${v.file}`, [v.target]);
        expect((await axNode(page, v.target)).ignored, id).toBe(true);
        await page.focus(sel(v.target));
        expect(await activeId(page), id).toBe(v.target);
        await page.close();
      }
    },
    LONG,
  );

  it(
    "M4 strips the accessible name from an icon button",
    async () => {
      for (const [id, v] of ofOperator("M4")) {
        const basePage = await open(
          `/corpus/${baseLabels.pages[v.base].file}`,
          [v.target],
        );
        expect(
          (await axNode(basePage, v.target)).name?.value ?? "",
          id,
        ).not.toBe("");
        await basePage.close();
        const page = await open(`/variants/${v.file}`, [v.target]);
        expect((await axNode(page, v.target)).name?.value ?? "", id).toBe("");
        await page.close();
      }
    },
    LONG,
  );

  it(
    "M5 traps Tab and Shift+Tab on one element",
    async () => {
      for (const [id, v] of ofOperator("M5")) {
        const page = await open(`/variants/${v.file}`, [v.target]);
        await page.focus(sel(v.target));
        await page.keyboard.press("Tab");
        expect(await activeId(page), id).toBe(v.target);
        await page.keyboard.press("Shift+Tab");
        expect(await activeId(page), id).toBe(v.target);
        await page.keyboard.press("Escape");
        await page.keyboard.press("Tab");
        expect(await activeId(page), id).toBe(v.target);
        await page.close();
      }
    },
    LONG,
  );

  it(
    "M6 navigates when one element receives focus",
    async () => {
      for (const [id, v] of ofOperator("M6")) {
        const basePage = await open(
          `/corpus/${baseLabels.pages[v.base].file}`,
          [v.target],
        );
        await basePage.focus(sel(v.target));
        expect(basePage.url(), id).not.toContain("changed=1");
        await basePage.close();
        const page = await open(`/variants/${v.file}`, [v.target]);
        await Promise.all([
          page.waitForURL(/\?changed=1$/),
          page.focus(sel(v.target)),
        ]);
        await page.close();
      }
    },
    LONG,
  );

  it(
    "M7 drops focus from its target to body the moment it arrives",
    async () => {
      for (const [id, v] of ofOperator("M7")) {
        const basePage = await open(
          `/corpus/${baseLabels.pages[v.base].file}`,
          [v.target],
        );
        await basePage.focus(sel(v.target));
        expect(await activeId(basePage), `${id}: base holds focus`).toBe(
          v.target,
        );
        await basePage.close();
        const page = await open(`/variants/${v.file}`, [v.target]);
        expect(
          await page.evaluate(`(function () {
            document.querySelector('${sel(v.target)}').focus();
            return document.activeElement === document.body;
          })()`),
          `${id} drops focus on arrival`,
        ).toBe(true);
        await page.close();
      }
    },
    LONG,
  );

  const onBody = async (page: Page): Promise<boolean> =>
    (await page.evaluate(
      "document.activeElement === null || document.activeElement === document.body",
    )) === true;

  it(
    "M8 keeps focus on its target for a moment, then drops it to body, and the next Tab moves on",
    async () => {
      for (const [id, v] of ofOperator("M8")) {
        const page = await open(`/variants/${v.file}`, [v.target]);
        // One evaluate reads focus at once and again after the 60 ms timer, so a slow round trip cannot
        // land the first read after the blur.
        const reads = z.array(z.boolean()).parse(
          await page.evaluate(`new Promise(function (done) {
            var el = document.querySelector('${sel(v.target)}');
            el.focus();
            var held = document.activeElement === el;
            setTimeout(function () { done([held, document.activeElement === document.body]); }, 150);
          })`),
        );
        expect(reads, `${id}: [held at once, on body after 150 ms]`).toEqual([
          true,
          true,
        ]);
        await page.keyboard.press("Tab");
        expect(await activeId(page), id).not.toBe(v.target);
        await page.close();
      }
    },
    LONG,
  );

  it(
    "M9 drops focus from its target at once while a timer rewrites only the URL fragment, in the same document",
    async () => {
      for (const [id, v] of ofOperator("M9")) {
        const page = await open(`/variants/${v.file}`, [v.target]);
        expect(
          await page.evaluate(`(function () {
            window.__benchSameDocument = true;
            document.querySelector('${sel(v.target)}').focus();
            return document.activeElement === document.body;
          })()`),
          `${id} drops focus on arrival`,
        ).toBe(true);
        await page.waitForTimeout(350);
        expect(await page.evaluate("location.hash"), id).toMatch(/^#tick-\d+$/);
        // Still the document the marker was set in: the fragment timer loaded nothing.
        expect(await page.evaluate("window.__benchSameDocument"), id).toBe(
          true,
        );
        expect(await onBody(page), id).toBe(true);
        await page.close();
      }
    },
    LONG,
  );

  it(
    "M10 sends Tab on the last stop to the first and Shift+Tab on the first to the last, so once in the loop Tab and Shift+Tab never leave it",
    async () => {
      // The loop: every element that passes the script's own stop test, in document order.
      const STOPS = `Array.prototype.filter.call(document.querySelectorAll('*'), function (el) {
        return el.tabIndex >= 0 && !el.disabled && el.checkVisibility({ visibilityProperty: true });
      })`;
      const FIRST_STOP = `${STOPS}[0]`;
      const inLoop = async (page: Page): Promise<boolean> =>
        (await page.evaluate(
          `${STOPS}.indexOf(document.activeElement) >= 0`,
        )) === true;
      for (const [id, v] of ofOperator("M10")) {
        const page = await open(`/variants/${v.file}`, [v.target]);
        const presses =
          2 * z.number().parse(await page.evaluate(`${STOPS}.length`)) + 2;
        // Twice round the loop and more, Tab from a fresh load, then Shift+Tab from the target: every press lands in it.
        for (let i = 0; i < presses; i++) {
          await page.keyboard.press("Tab");
          expect(await inLoop(page), `${id} Tab ${i + 1}`).toBe(true);
        }
        await page.focus(sel(v.target));
        for (let i = 0; i < presses; i++) {
          await page.keyboard.press("Shift+Tab");
          expect(await inLoop(page), `${id} Shift+Tab ${i + 1}`).toBe(true);
        }
        await page.focus(sel(v.target));
        await page.keyboard.press("Tab");
        expect(
          await page.evaluate(`document.activeElement === ${FIRST_STOP}`),
          `${id}: Tab on the last stop`,
        ).toBe(true);
        await page.keyboard.press("Shift+Tab");
        expect(await activeId(page), `${id}: Shift+Tab on the first`).toBe(
          v.target,
        );
        await page.keyboard.press("Escape");
        await page.keyboard.press("Tab");
        expect(
          await page.evaluate(`document.activeElement === ${FIRST_STOP}`),
          `${id}: Escape releases nothing`,
        ).toBe(true);
        await page.close();
        // Shift+Tab from a fresh load enters at the page's last Tab stop. With the Tab walk above, this puts every
        // stop Chromium reaches from load in the loop, on every base but scroll-panel (next test).
        if (!id.startsWith("scroll-panel__")) {
          const fresh = await open(`/variants/${v.file}`, [v.target]);
          await fresh.keyboard.press("Shift+Tab");
          expect(await inLoop(fresh), `${id}: Shift+Tab from load`).toBe(true);
          await fresh.close();
        }
      }
    },
    LONG,
  );

  it("scroll-panel__M10: the two scroll regions sit outside the loop, so Shift+Tab from a fresh load reaches one and the next Tab leaves the page", async () => {
    const found = ofOperator("M10").find(([id]) =>
      id.startsWith("scroll-panel__"),
    );
    if (!found) throw new Error("no M10 variant on scroll-panel");
    const [, v] = found;
    const page = await open(`/variants/${v.file}`, [v.target]);
    await page.keyboard.press("Shift+Tab");
    expect(
      await page.evaluate("document.activeElement.getAttribute('aria-label')"),
    ).toBe("Privacy notice text");
    await page.keyboard.press("Tab");
    expect(await onBody(page)).toBe(true);
    expect(await page.evaluate("document.hasFocus()")).toBe(false);
    await page.close();
  });

  it(
    "M11 replaces its target with a copy on Tab and Shift+Tab and focuses the copy, so focus never leaves it",
    async () => {
      for (const [id, v] of ofOperator("M11")) {
        const page = await open(`/variants/${v.file}`, [v.target]);
        await page.focus(sel(v.target));
        await page.evaluate("window.__benchFirst = document.activeElement");
        for (const key of ["Tab", "Shift+Tab", "Escape", "Tab", "Tab"]) {
          await page.keyboard.press(key);
          expect(await activeId(page), `${id} after ${key}`).toBe(v.target);
        }
        expect(
          await page.evaluate("window.__benchFirst.isConnected"),
          `${id}: the focused node is a copy`,
        ).toBe(false);
        await page.close();
      }
    },
    LONG,
  );

  it(
    "M12 loops Tab among its target and the two scroll regions after it, and Shift+Tab the other way",
    async () => {
      for (const [id, v] of ofOperator("M12")) {
        const page = await open(`/variants/${v.file}`, [v.target]);
        // 0 = the target, 1 and 2 = the scroll regions after it, -1 = anywhere else.
        const at = async (): Promise<unknown> =>
          page.evaluate(`(function () {
            var t = document.querySelector('${sel(v.target)}');
            return [t, t.nextElementSibling, t.nextElementSibling.nextElementSibling].indexOf(document.activeElement);
          })()`);
        await page.focus(sel(v.target));
        const path: unknown[] = [];
        for (const key of ["Tab", "Tab", "Tab", "Tab", "Tab", "Tab"]) {
          await page.keyboard.press(key);
          path.push(await at());
        }
        for (const key of ["Shift+Tab", "Shift+Tab", "Shift+Tab", "Escape"]) {
          await page.keyboard.press(key);
          path.push(await at());
        }
        await page.keyboard.press("Tab");
        path.push(await at());
        expect(path, id).toEqual([1, 2, 0, 1, 2, 0, 2, 1, 0, 0, 1]);
        await page.close();
      }
    },
    LONG,
  );

  it(
    "M13 makes one control inert and transparent: it takes no focus and no clicks, and assistive technology ignores it",
    async () => {
      for (const [id, v] of ofOperator("M13")) {
        const page = await open(`/variants/${v.file}`, [v.target]);
        expect(
          await page.evaluate(`(function () {
            var el = document.querySelector('${sel(v.target)}');
            return [el.inert, getComputedStyle(el).opacity];
          })()`),
          id,
        ).toEqual([true, "0"]);
        await page.focus(sel(v.target));
        expect(await activeId(page), id).not.toBe(v.target);
        // A click at its centre reaches whatever lies beneath it, never a tagged element, and navigates nowhere.
        const url = page.url();
        await page.evaluate(`document.addEventListener('click', function (e) {
          var hit = e.target.closest ? e.target.closest('[data-bench-id]') : null;
          window.__benchHit = hit ? hit.getAttribute('data-bench-id') : null;
        }, true)`);
        const box = await page.locator(sel(v.target)).boundingBox();
        if (box === null) throw new Error(`${id}: target has no box`);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        expect(await page.evaluate("window.__benchHit"), id).toBeNull();
        expect(page.url(), id).toBe(url);
        expect((await axNode(page, v.target)).ignored, id).toBe(true);
        await page.close();
      }
    },
    LONG,
  );

  it("M13 on the modal leaves its trap as labelled: focus stays in the dialog and Escape returns it to the trigger", async () => {
    const [id, v] = ofOperator("M13").find(([, x]) => x.base === "modal") ?? [
      "",
      null,
    ];
    if (v === null) throw new Error("no M13 variant on the modal");
    expect(v.page, id).toMatchObject({
      keyboardTrap: true,
      trapEscapable: true,
    });
    const page = await open(`/variants/${v.file}`, Object.keys(v.elements));
    const inside = ["name-input", "username-input", "save-button"];
    expect(await activeId(page), id).toBe("name-input");
    for (const key of ["Tab", "Shift+Tab"]) {
      for (let i = 0; i < 6; i++) {
        await page.keyboard.press(key);
        expect(inside, `${id} ${key} ${i + 1}`).toContain(await activeId(page));
      }
    }
    await page.keyboard.press("Escape");
    expect(await activeId(page), id).toBe("trigger");
    await page.close();
  });
});

describe("base pages behave as labelled", () => {
  it("modal: focus starts inside, Tab and Shift+Tab stay inside, Escape returns focus to the trigger", async () => {
    const labels = baseLabels.pages["modal"];
    expect(labels.page).toMatchObject({
      keyboardTrap: true,
      trapEscapable: true,
    });
    const page = await open(
      `/corpus/${labels.file}`,
      Object.keys(labels.elements),
    );
    const inside = [
      "name-input",
      "username-input",
      "save-button",
      "close-button",
    ];
    expect(await activeId(page)).toBe("name-input");
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      expect(inside).toContain(await activeId(page));
    }
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Shift+Tab");
      expect(inside).toContain(await activeId(page));
    }
    await page.keyboard.press("Escape");
    expect(await activeId(page)).toBe("trigger");
    await page.keyboard.press("Tab");
    expect(await activeId(page)).toBe("help-link");
    await page.close();
  });

  it("js-handlers: custom controls work with Enter and Space", async () => {
    const labels = baseLabels.pages["js-handlers"];
    const page = await open(
      `/corpus/${labels.file}`,
      Object.keys(labels.elements),
    );
    const status = (): Promise<unknown> =>
      page.evaluate('document.getElementById("status").textContent');
    await page.focus(sel("custom-button"));
    await page.keyboard.press("Enter");
    expect(await status()).toBe("Added to cart (1)");
    await page.keyboard.press(" ");
    expect(await status()).toBe("Added to cart (2)");
    await page.focus(sel("custom-checkbox"));
    await page.keyboard.press(" ");
    expect(
      await page.evaluate(
        `document.querySelector('${sel("custom-checkbox")}').getAttribute('aria-checked')`,
      ),
    ).toBe("true");
    await page.focus(sel("native-button"));
    await page.keyboard.press("Enter");
    expect(await status()).toBe("Checkout started");
    await page.close();
  });

  it("navbar: the dropdown and the off-canvas menu open from the keyboard", async () => {
    const labels = baseLabels.pages["navbar"];
    const page = await open(
      `/corpus/${labels.file}`,
      Object.keys(labels.elements),
    );
    await page.focus(sel("dropdown-toggle"));
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    expect(await activeId(page)).toBe("dropdown-item-1");
    await page.keyboard.press("Escape");
    expect(await activeId(page)).toBe("dropdown-toggle");
    await page.focus(sel("offcanvas-open"));
    await page.keyboard.press("Enter");
    expect(await activeId(page)).toBe("offcanvas-close");
    await page.keyboard.press("Tab");
    expect(await activeId(page)).toBe("offcanvas-link-1");
    await page.keyboard.press("Escape");
    expect(await activeId(page)).toBe("offcanvas-open");
    await page.close();
  });

  it("react-div-button: the div handles clicks but is not focusable; the button is", async () => {
    const labels = baseLabels.pages["react-div-button"];
    const page = await open(
      `/corpus/${labels.file}`,
      Object.keys(labels.elements),
    );
    await page.click(sel("add-to-cart-div"));
    expect(
      await page.evaluate('document.getElementById("status").textContent'),
    ).toBe("Added to cart");
    expect(
      await page.evaluate(
        `document.querySelector('${sel("add-to-cart-div")}').tabIndex`,
      ),
    ).toBe(-1);
    await page.focus(sel("wishlist-button"));
    await page.keyboard.press("Enter");
    expect(
      await page.evaluate('document.getElementById("status").textContent'),
    ).toBe("Saved to wishlist");
    // The share button is portalled into the static header's host div, and works from the keyboard there.
    expect(
      await page.evaluate(
        `document.querySelector('${sel("portal-host")}').contains(document.querySelector('${sel("share-button")}'))`,
      ),
    ).toBe(true);
    await page.focus(sel("share-button"));
    await page.keyboard.press("Enter");
    expect(
      await page.evaluate('document.getElementById("status").textContent'),
    ).toBe("Link copied");
    await page.close();
  });

  const tabPath = async (page: Page, presses: number): Promise<unknown[]> => {
    const path: unknown[] = [];
    for (let i = 0; i < presses; i++) {
      await page.keyboard.press("Tab");
      path.push(await activeId(page));
    }
    return path;
  };

  it("native-dialog: focus starts in the dialog, Tab leaves the page instead of reaching the background, and Confirm opens the page", async () => {
    const labels = baseLabels.pages["native-dialog"];
    expect(labels.page).toMatchObject({ keyboardTrap: false });
    const page = await open(
      `/corpus/${labels.file}`,
      Object.keys(labels.elements),
    );
    // null: focus has left the document for the browser's own UI, so the native modal confines nothing.
    expect([await activeId(page), ...(await tabPath(page, 4))]).toEqual([
      "confirm-button",
      null,
      "confirm-button",
      null,
      "confirm-button",
    ]);
    await page.keyboard.press("Enter");
    expect(
      await page.evaluate('document.getElementById("age-gate").open'),
    ).toBe(false);
    expect(await tabPath(page, 2)).toEqual(["shop-link", "join-button"]);
    await page.close();
  });

  it("disclosure-tabs: Tab reaches each tablist's selected tab and each summary, ArrowRight moves to tab 2, Enter opens a details", async () => {
    const labels = baseLabels.pages["disclosure-tabs"];
    const page = await open(
      `/corpus/${labels.file}`,
      Object.keys(labels.elements),
    );
    expect(await tabPath(page, 5)).toEqual([
      "a-skip-link",
      "float-tab-1",
      "contents-tab-1",
      "faq-shipping-summary",
      "faq-returns-summary",
    ]);
    for (const list of ["float", "contents"]) {
      await page.focus(sel(`${list}-tab-1`));
      await page.keyboard.press("ArrowRight");
      expect(await activeId(page), list).toBe(`${list}-tab-2`);
    }
    await page.focus(sel("faq-shipping-summary"));
    await page.keyboard.press("Enter");
    expect(
      await page.evaluate(
        `document.querySelector('${sel("faq-shipping")}').open`,
      ),
    ).toBe(true);
    await page.close();
  });

  it("one-button: Tab reaches the only button, Enter works, and the next Tab leaves the page", async () => {
    const labels = baseLabels.pages["one-button"];
    const page = await open(
      `/corpus/${labels.file}`,
      Object.keys(labels.elements),
    );
    expect(await tabPath(page, 1)).toEqual(["only-button"]);
    await page.keyboard.press("Enter");
    expect(
      await page.evaluate('document.getElementById("status").textContent'),
    ).toBe("Subscribed");
    expect(await tabPath(page, 2)).toEqual([null, "only-button"]);
    await page.close();
  });

  it("scroll-panel: Tab passes the button, then both scroll regions (untagged Tab stops), then leaves the page", async () => {
    const labels = baseLabels.pages["scroll-panel"];
    const page = await open(
      `/corpus/${labels.file}`,
      Object.keys(labels.elements),
    );
    const path: unknown[] = [];
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      path.push(
        await page.evaluate(
          "document.activeElement.getAttribute('data-bench-id') || document.activeElement.getAttribute('aria-label')",
        ),
      );
    }
    expect(path).toEqual([
      "link-1",
      "link-2",
      "agree-button",
      "Terms of service text",
      "Privacy notice text",
      null,
    ]);
    await page.focus(sel("agree-button"));
    await page.keyboard.press("Enter");
    expect(
      await page.evaluate('document.getElementById("status").textContent'),
    ).toBe("Thanks, you have agreed");
    await page.close();
  });

  it("remount-on-keydown: the first keydown re-renders main, and Tab still reaches every control, which still works", async () => {
    const labels = baseLabels.pages["remount-on-keydown"];
    const page = await open(
      `/corpus/${labels.file}`,
      Object.keys(labels.elements),
    );
    await page.evaluate(
      `window.__benchFirst = document.querySelector('${sel("home-link")}')`,
    );
    expect(await tabPath(page, 4)).toEqual([
      "home-link",
      "about-link",
      "buy-button",
      "cart-button",
    ]);
    expect(await page.evaluate("window.__benchFirst.isConnected")).toBe(false);
    const status = (): Promise<unknown> =>
      page.evaluate('document.getElementById("status").textContent');
    await page.keyboard.press("Enter");
    expect(await status()).toBe("Added to cart");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Enter");
    expect(await status()).toBe("Bought");
    await page.close();
  });
});

describe("seed output location", () => {
  it("keeps generated variants out of git", () => {
    const ignore = readFileSync(join(BENCH, ".gitignore"), "utf8").split("\n");
    expect(ignore).toContain("corpus/dev/variants/");
    expect(existsSync(join(CORPUS, "labels.json"))).toBe(true);
  });
});
