// Draws the Checkpoint 1 spot-check: 20 recorded labels a human re-tests by hand, written to bench/SPOTCHECK.md.
// Stratified 8 dev element labels (one seeded-variant gap target per gap operator + 4 base labels) / 2 dev page-flag
// sets / 6 BAD page results / 4 BAD element mappings, drawn from one seeded stream over pools sorted by key, so the
// same label files always give the same bytes.
//   npx tsx bench/spotcheck.ts    (reads bench/corpus/dev/variants/labels.json: run npx tsx bench/seed.ts first)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  BaseLabelsFileSchema,
  VariantLabelsFileSchema,
  type BaseLabelsFile,
  type ElementLabel,
  type OperatorId,
  type PageFlags,
  type VariantLabels,
  type VariantLabelsFile,
} from "./corpus/labels-schema.js";
import { SERVE_ORIGIN, serveUrl } from "./serve.js";
import { seededRandom } from "./stats.js";

const BENCH = dirname(fileURLToPath(import.meta.url));
const DEV = join(BENCH, "corpus", "dev");
const DEFAULT_VARIANTS_DIR = join(DEV, "variants");
export const SPOTCHECK_PATH = join(BENCH, "SPOTCHECK.md");

export const SPOTCHECK_SEED = "checkpoint1-spotcheck";

export const KEYBOARD_CRITERIA = [
  "2.1.1",
  "2.1.2",
  "2.4.3",
  "2.4.7",
  "3.2.1",
  "4.1.2",
] as const;
type KeyboardCriterion = (typeof KEYBOARD_CRITERIA)[number];

// Draw order is fixed: changing it reshuffles every later stratum.
const STRATA = ["devElement", "devPageFlags", "badPage", "badElement"] as const;
export type Stratum = (typeof STRATA)[number];
const QUOTAS: Record<Stratum, number> = {
  devElement: 8,
  devPageFlags: 2,
  badPage: 6,
  badElement: 4,
};

// Base labels are almost all gap-free, so the dev element stratum first draws one seeded-variant target per operator
// whose target carries a gap: M1 wrong_role, M2 not_focusable, M3 hidden_but_interactive, M4 no_accessible_name.
export const GAP_OPERATORS = [
  "M1",
  "M2",
  "M3",
  "M4",
] as const satisfies readonly OperatorId[];
type GapOperator = (typeof GAP_OPERATORS)[number];
const DEV_BASE_ELEMENTS = QUOTAS.devElement - GAP_OPERATORS.length;

// The corpus the 20 recorded answers were drawn from (Checkpoint 1, 722307b): these 8 bases with the elements each had
// then, and operators M1-M7. Every dev pool keeps to it, so a base, element or operator added later never enters a
// draw and the committed draw and its answers stand. Frozen: growing the corpus never edits it.
export const CHECKPOINT1_CORPUS = {
  operators: ["M1", "M2", "M3", "M4", "M5", "M6", "M7"],
  elements: {
    "good-operable": [
      "skip-link",
      "search-input",
      "search-submit",
      "nav-home",
      "nav-about",
      "nav-contact",
      "sitemap-link",
    ],
    "identical-links": [
      "read-more-01",
      "read-more-02",
      "read-more-03",
      "read-more-04",
      "read-more-05",
      "read-more-06",
      "read-more-07",
      "read-more-08",
      "read-more-09",
      "read-more-10",
      "read-more-11",
      "read-more-12",
    ],
    "three-links": ["link-1", "link-2", "link-3"],
    navbar: [
      "brand",
      "toggler",
      "nav-home",
      "nav-features",
      "dropdown-toggle",
      "dropdown-item-1",
      "dropdown-item-2",
      "dropdown-item-3",
      "dropdown-item-4",
      "dropdown-item-5",
      "dropdown-item-6",
      "hidden-csrf",
      "hidden-locale",
      "hidden-ref",
      "search-input",
      "search-submit",
      "offcanvas-open",
      "offcanvas-close",
      "offcanvas-link-1",
      "offcanvas-link-2",
      "offcanvas-link-3",
    ],
    form: [
      "name-input",
      "email-input",
      "topic-select",
      "message-textarea",
      "subscribe-checkbox",
      "submit-button",
    ],
    "js-handlers": ["custom-button", "custom-checkbox", "native-button"],
    modal: [
      "focus-guard-start",
      "trigger",
      "help-link",
      "name-input",
      "username-input",
      "save-button",
      "close-button",
      "focus-guard-end",
    ],
    "react-div-button": ["add-to-cart-div", "wishlist-button", "plain-div"],
  },
} as const satisfies {
  operators: readonly OperatorId[];
  elements: Readonly<Record<string, readonly string[]>>;
};
const CHECKPOINT1_OPERATORS: ReadonlySet<string> = new Set(
  CHECKPOINT1_CORPUS.operators,
);
const CHECKPOINT1_BASES: ReadonlySet<string> = new Set(
  Object.keys(CHECKPOINT1_CORPUS.elements),
);
const CHECKPOINT1_ELEMENTS: ReadonlySet<string> = new Set(
  Object.entries(CHECKPOINT1_CORPUS.elements).flatMap(([base, ids]) =>
    ids.map((id) => `${base}#${id}`),
  ),
);
const inCheckpoint1 = (v: VariantLabels): boolean =>
  CHECKPOINT1_OPERATORS.has(v.operator) &&
  CHECKPOINT1_ELEMENTS.has(`${v.base}#${v.target}`);

const ReaderSchema = z.enum(["A", "B"]);
type Reader = z.infer<typeof ReaderSchema>;

const BadCriterionSchema = z
  .object({
    result: z.enum(["Pass", "Fail"]),
    techniques: z.array(z.string()),
    quoteA: z.string().nullable(),
    quoteB: z.string().nullable(),
    elements: z.array(
      z
        .object({
          selector: z.string().min(1),
          // reconcile-bad.py appends once per listing, so a reader can appear twice.
          readers: z.array(ReaderSchema).min(1),
          snippet: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
type BadCriterion = z.infer<typeof BadCriterionSchema>;

const BadLabelsFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    method: z.string(),
    sources: z.array(z.string()),
    pages: z.record(
      z.string(),
      z
        .object({
          report: z.string().min(1),
          criteria: z.record(z.string(), BadCriterionSchema),
        })
        .strict(),
    ),
  })
  .strict();
export type BadLabelsFile = z.infer<typeof BadLabelsFileSchema>;

export type Sources = {
  base: BaseLabelsFile;
  variants: VariantLabelsFile;
  bad: BadLabelsFile;
};

export type SpotItem = {
  stratum: Stratum;
  key: string;
  title: string;
  open: string;
  test: string;
  recorded: string;
};

export type Spotcheck = {
  seed: string;
  items: SpotItem[];
  poolSizes: Record<Stratum, number>;
  gapTargets: number;
  singleReaderMappings: number;
};

function readJson(path: string, hint: string): unknown {
  if (!existsSync(path))
    throw new Error(`${relative(process.cwd(), path)} missing: ${hint}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

// variantsDir: where seed.ts wrote the variants (its --out); tests seed into a temp dir.
export function loadSources(variantsDir = DEFAULT_VARIANTS_DIR): Sources {
  return {
    base: BaseLabelsFileSchema.parse(
      readJson(join(DEV, "labels.json"), "it is committed"),
    ),
    variants: VariantLabelsFileSchema.parse(
      readJson(
        join(variantsDir, "labels.json"),
        "run npx tsx bench/seed.ts first",
      ),
    ),
    bad: BadLabelsFileSchema.parse(
      readJson(
        join(BENCH, "corpus", "test", "bad-labels.json"),
        "it is committed",
      ),
    ),
  };
}

// Backslash-escapes what would turn label prose into markup (`<label for>` would render as an HTML tag).
const prose = (s: string): string =>
  s.replace(/\s+/g, " ").replace(/[\\`*_<[\]]/g, "\\$&");

// A code span fenced longer than any backtick run inside it.
function code(s: string): string {
  const flat = s.replace(/\s+/g, " ");
  const longest = Math.max(
    0,
    ...(flat.match(/`+/g) ?? []).map((r) => r.length),
  );
  const fence = "`".repeat(longest + 1);
  const pad = flat.startsWith("`") || flat.endsWith("`") ? " " : "";
  return `${fence}${pad}${flat}${pad}${fence}`;
}

const benchSel = (id: string): string => code(`[data-bench-id="${id}"]`);

const FLAG_TEST =
  "From a fresh load, Tab through every stop to the end of the page, then Shift+Tab back to the top, opening any menu " +
  "or dialog on the way with Enter. Trap: focus cycles inside one region and cannot leave (then try Escape). " +
  "Context change: focusing something, without pressing Enter, navigates or changes the URL. Focus lost: the focus " +
  `ring vanishes as soon as Tab lands on an element (console: ${code("document.activeElement === document.body")}).`;

const CRITERIA: Record<
  KeyboardCriterion,
  { name: string; page: string; element: string }
> = {
  "2.1.1": {
    name: "Keyboard",
    page: "Using only Tab, Shift+Tab, Enter, Space and arrow keys, try every link, menu and form control. Fail if any function needs the mouse.",
    element:
      "Tab to it, or to the link or control that contains it, and press Enter (Space for buttons and checkboxes). " +
      "Fail if anything the mouse does to it (click, hover) has no keyboard equivalent.",
  },
  "2.1.2": {
    name: "No Keyboard Trap",
    page: "Tab forward through the whole page, then Shift+Tab back. Fail if focus gets stuck inside any component.",
    element:
      "Tab into it, then out of it forwards and backwards. Fail if focus cannot leave.",
  },
  "2.4.3": {
    name: "Focus Order",
    page: "Tab through the page. Fail if the focus sequence breaks meaning, e.g. a menu or dialog far from the control that opens it.",
    element:
      "Tab onto it from the control before it. Fail if it arrives out of logical sequence.",
  },
  "2.4.7": {
    name: "Focus Visible",
    page: "Tab through the page. Fail if any focused element shows no visible focus indicator.",
    element: "Tab onto it. Fail if you cannot see that it has focus.",
  },
  "3.2.1": {
    name: "On Focus",
    page: "Tab through the page without pressing Enter. Fail if merely focusing something navigates, opens a window, or throws focus away.",
    element:
      "Tab onto it without pressing Enter. Fail if the page navigates, a window opens, or focus is thrown away.",
  },
  "4.1.2": {
    name: "Name, Role, Value",
    page: "Inspect each control in DevTools → Elements → Accessibility. Fail if any lacks a name, the right role, or its state.",
    element:
      "Inspect it in DevTools → Elements → Accessibility. Fail if its name, role or state is missing or wrong.",
  },
};

// Outermost revealer first; the schema guarantees the chain ends and is acyclic.
function revealChain(
  id: string,
  elements: Record<string, ElementLabel>,
): string[] {
  const chain: string[] = [];
  for (
    let cur = elements[id]?.revealedBy;
    cur !== undefined;
    cur = elements[cur]?.revealedBy
  ) {
    chain.unshift(cur);
  }
  return chain;
}

// Worded to observe, not to presume the label: a gap element never takes focus, and a focus guard does but is no control.
function elementTest(
  id: string,
  elements: Record<string, ElementLabel>,
): string {
  if (!elements[id]?.interactive)
    return (
      "Check it is not a control: clicking it and pressing keys on it do nothing. Tab through the page and note " +
      "whether it ever takes focus."
    );
  const chain = revealChain(id, elements);
  const reveal =
    chain.length === 0
      ? ""
      : `Reveal it first: ${chain.map((r) => `Tab to ${benchSel(r)} and press Enter`).join(", then ")}. Then `;
  return (
    `From a fresh load: ${reveal}Tab (Shift+Tab to go back) and note whether it ever takes focus; if it does, press ` +
    "Enter (and Space if it acts as a button) and check it does what a click does. Check its name and role in " +
    "DevTools → Elements → Accessibility."
  );
}

function elementRecorded(l: ElementLabel): string {
  const fields = [
    `interactive=${l.interactive}`,
    `keyboardAccessible=${l.keyboardAccessible}`,
    `expectedGapType=${l.expectedGapType}`,
    ...(l.acceptableGapTypes
      ? [`acceptableGapTypes=${l.acceptableGapTypes.join(",")}`]
      : []),
    ...(l.revealedBy ? [`revealedBy=${l.revealedBy}`] : []),
  ];
  return `${code(fields.join(" "))}: ${prose(l.note)}`;
}

const flagsRecorded = (f: PageFlags): string =>
  code(
    `keyboardTrap=${f.keyboardTrap} trapEscapable=${f.trapEscapable} ` +
      `contextChangeOnFocus=${f.contextChangeOnFocus} focusLostOnArrival=${f.focusLostOnArrival}`,
  );

export function devElementPool(s: Sources): SpotItem[] {
  return Object.entries(s.base.pages).flatMap(([pageId, page]) =>
    Object.entries(page.elements)
      .filter(([id]) => CHECKPOINT1_ELEMENTS.has(`${pageId}#${id}`))
      .map(([id, label]) => ({
        stratum: "devElement" as const,
        key: `${pageId}#${id}`,
        title: `${pageId} · ${code(id)}`,
        open: `<${serveUrl("/corpus/", `dev/${page.file}`)}> and find ${benchSel(id)}`,
        test: elementTest(id, page.elements),
        recorded: elementRecorded(label),
      })),
  );
}

export function devGapTargetPool(s: Sources, op: GapOperator): SpotItem[] {
  return Object.entries(s.variants.variants)
    .filter(([, v]) => v.operator === op && inCheckpoint1(v))
    .map(([id, v]) => {
      const label = v.elements[v.target];
      if (label.expectedGapType === null)
        throw new Error(`${id}: the ${op} target carries no gap`);
      return {
        stratum: "devElement" as const,
        key: `${id}#${v.target}`,
        title: `${id} · ${code(v.target)}`,
        open: `<${serveUrl("/variants/", v.file)}> and find ${benchSel(v.target)}`,
        test: elementTest(v.target, v.elements),
        recorded: elementRecorded(label),
      };
    });
}

export function devPageFlagPool(s: Sources): SpotItem[] {
  const base = Object.entries(s.base.pages)
    .filter(([pageId]) => CHECKPOINT1_BASES.has(pageId))
    .map(([pageId, page]) => ({
      stratum: "devPageFlags" as const,
      key: pageId,
      title: `${pageId} (base page)`,
      open: `<${serveUrl("/corpus/", `dev/${page.file}`)}>`,
      test: FLAG_TEST,
      recorded: flagsRecorded(page.page),
    }));
  const variants = Object.entries(s.variants.variants)
    .filter(([, v]) => inCheckpoint1(v))
    .map(([id, v]) => ({
      stratum: "devPageFlags" as const,
      key: id,
      title: `${id} (${v.operator} applied to ${benchSel(v.target)})`,
      open: `<${serveUrl("/variants/", v.file)}>`,
      test: FLAG_TEST,
      recorded: flagsRecorded(v.page),
    }));
  return [...base, ...variants];
}

function keyboardCriteria(
  s: Sources,
): { page: string; report: string; sc: KeyboardCriterion; c: BadCriterion }[] {
  return Object.entries(s.bad.pages).flatMap(([page, p]) =>
    KEYBOARD_CRITERIA.map((sc) => {
      const c = p.criteria[sc];
      if (c === undefined)
        throw new Error(`bad-labels.json: ${page} has no SC ${sc} result`);
      return { page, report: p.report, sc, c };
    }),
  );
}

function quotes(c: BadCriterion): string {
  if (c.quoteA !== null && c.quoteA === c.quoteB)
    return `both readers quoted "${prose(c.quoteA)}"`;
  const one = (r: Reader, q: string | null): string =>
    q === null
      ? `reader ${r} quoted nothing`
      : `reader ${r} quoted "${prose(q)}"`;
  return `${one("A", c.quoteA)}; ${one("B", c.quoteB)}`;
}

export function badPagePool(s: Sources): SpotItem[] {
  return keyboardCriteria(s).map(({ page, report, sc, c }) => ({
    stratum: "badPage" as const,
    key: `${page} ${sc}`,
    title: `${page} · SC ${sc} ${CRITERIA[sc].name}`,
    open: `<${serveUrl("/bad/", `${page}.html`)}>; the W3C report it was read from is <${serveUrl("/bad/", report)}>`,
    test: CRITERIA[sc].page,
    recorded: `${code(`result=${c.result} techniques=${c.techniques.join(",") || "none"} mappings=${c.elements.length}`)}; ${quotes(c)}`,
  }));
}

// "Proposed by only one reader" means one DISTINCT reader: readers [B, B] is B alone.
export function badMappingPool(s: Sources): {
  single: SpotItem[];
  shared: SpotItem[];
} {
  const all = keyboardCriteria(s).flatMap(({ page, sc, c }) =>
    c.elements.map((el) => {
      const readers = [...new Set(el.readers)].sort();
      const proposedBy =
        readers.length === 1 ? `reader ${readers[0]} only` : "both readers";
      const snippet =
        el.snippet === null
          ? ""
          : ` and it should be the recorded snippet ${code(el.snippet)}`;
      const techniques = c.techniques.join(", ") || "none";
      return {
        single: readers.length === 1,
        item: {
          stratum: "badElement" as const,
          key: `${page} ${sc} ${el.selector}`,
          title: `${page} · SC ${sc} · ${code(el.selector)} (${proposedBy})`,
          open:
            `<${serveUrl("/bad/", `${page}.html`)}>; in the console ` +
            `${code(`document.querySelectorAll(${JSON.stringify(el.selector)}).length`)} should be 1${snippet}`,
          test: CRITERIA[sc].element,
          // A report can cite an element under a criterion the page passes; that is no failing instance.
          recorded:
            c.result === "Fail"
              ? `a failing instance of SC ${sc} on this page (page result Fail, techniques ${techniques})`
              : `cited under SC ${sc}, which this page passes (page result Pass, techniques ${techniques})`,
        },
      };
    }),
  );
  return {
    single: all.filter((m) => m.single).map((m) => m.item),
    shared: all.filter((m) => !m.single).map((m) => m.item),
  };
}

const byKey = (a: SpotItem, b: SpotItem): number =>
  a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

// Partial Fisher-Yates over the key-sorted pool: the first k slots are a uniform k-subset.
function draw(
  pool: readonly SpotItem[],
  k: number,
  rng: () => number,
): SpotItem[] {
  const order = [...pool].sort(byKey);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rng() * (order.length - i));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order.slice(0, k);
}

type SubDraw = { name: string; pool: SpotItem[]; k: number };

// Each stratum is one or more sub-draws, taken in this order from the one stream; their k sum to the stratum quota.
function planDraws(sources: Sources): Record<Stratum, SubDraw[]> {
  const mappings = badMappingPool(sources);
  const singles = Math.min(QUOTAS.badElement, mappings.single.length);
  return {
    devElement: [
      ...GAP_OPERATORS.map((op) => ({
        name: `${op} gap targets`,
        pool: devGapTargetPool(sources, op),
        k: 1,
      })),
      {
        name: "base labels",
        pool: devElementPool(sources),
        k: DEV_BASE_ELEMENTS,
      },
    ],
    devPageFlags: [
      {
        name: "page flags",
        pool: devPageFlagPool(sources),
        k: QUOTAS.devPageFlags,
      },
    ],
    badPage: [
      { name: "page results", pool: badPagePool(sources), k: QUOTAS.badPage },
    ],
    badElement: [
      { name: "single-reader mappings", pool: mappings.single, k: singles },
      {
        name: "both-reader mappings",
        pool: mappings.shared,
        k: QUOTAS.badElement - singles,
      },
    ],
  };
}

export function drawSpotcheck(
  sources: Sources,
  seed: string = SPOTCHECK_SEED,
): Spotcheck {
  const plan = planDraws(sources);
  for (const stratum of STRATA) {
    for (const d of plan[stratum]) {
      if (d.pool.length < d.k)
        throw new Error(
          `${stratum} ${d.name}: need ${d.k} items, pool has ${d.pool.length}`,
        );
    }
  }
  const rng = seededRandom(seed);
  const items = STRATA.flatMap((stratum) =>
    plan[stratum].flatMap((d) => draw(d.pool, d.k, rng).sort(byKey)),
  );
  const poolSize = (stratum: Stratum): number =>
    plan[stratum].reduce((n, d) => n + d.pool.length, 0);
  return {
    seed,
    items,
    poolSizes: {
      devElement: poolSize("devElement"),
      devPageFlags: poolSize("devPageFlags"),
      badPage: poolSize("badPage"),
      badElement: poolSize("badElement"),
    },
    gapTargets: plan.devElement
      .slice(0, GAP_OPERATORS.length)
      .reduce((n, d) => n + d.pool.length, 0),
    singleReaderMappings: plan.badElement[0].pool.length,
  };
}

function heading(s: Spotcheck, stratum: Stratum): string {
  const drawn = `${QUOTAS[stratum]} of ${s.poolSizes[stratum]}`;
  switch (stratum) {
    case "devElement":
      return (
        `Dev element labels (${drawn}: one seeded-variant target per gap operator, ${GAP_OPERATORS.join("/")}, ` +
        `from ${s.gapTargets}; ${DEV_BASE_ELEMENTS} base labels from ${s.poolSizes.devElement - s.gapTargets} in ` +
        "bench/corpus/dev/labels.json)"
      );
    case "devPageFlags":
      return `Dev page flags (${drawn}: base pages + seeded variants)`;
    case "badPage":
      return `BAD page-level results (${drawn}: SC ${KEYBOARD_CRITERIA.join(", ")}, bench/corpus/test/bad-labels.json)`;
    case "badElement":
      return `BAD element mappings (${drawn}; the ${s.singleReaderMappings} proposed by one reader only are drawn first)`;
  }
}

export function renderSpotcheck(s: Spotcheck): string {
  const out = [
    "# Checkpoint 1 spot-check",
    "",
    `${s.items.length} recorded labels drawn by \`npx tsx bench/spotcheck.ts\` with seed \`${s.seed}\`; rerunning overwrites this file.`,
    `Start the pages first: \`npx tsx bench/seed.ts\` (writes the /variants/ pages), then \`npx tsx bench/serve.ts\` (${SERVE_ORIGIN}). Name and role: Chrome DevTools → Elements → Accessibility.`,
    "Find an element by selector: DevTools → Elements, Cmd/Ctrl+F, paste the selector.",
  ];
  let n = 0;
  for (const stratum of STRATA) {
    out.push("", `## ${heading(s, stratum)}`, "");
    for (const item of s.items.filter((i) => i.stratum === stratum)) {
      n += 1;
      out.push(
        `${n}. [ ] **${item.title}**`,
        `    - open ${item.open}`,
        `    - test: ${item.test}`,
        `    - recorded: ${item.recorded}`,
        "    - agree? / note:",
      );
    }
  }
  return `${out.join("\n")}\n`;
}

function main(): void {
  const s = drawSpotcheck(loadSources());
  writeFileSync(SPOTCHECK_PATH, renderSpotcheck(s));
  console.log(
    `wrote ${relative(process.cwd(), SPOTCHECK_PATH)}: ${s.items.length} items (seed ${s.seed})`,
  );
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
