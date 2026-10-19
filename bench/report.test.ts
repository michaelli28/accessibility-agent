// report.ts on synthetic summaries: criterion mapping, Wilson / rule-of-three cells, cluster counts, variant grid,
// subset runs kept out of the tables, and the after column the 2.1.2 / 3.2.1 judges feed.
// Every page here is FABRICATED, so deleting a rule turns nothing red by itself: the assertions below
// are the only guard on the after column.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  KeyboardTrapResult,
  TrapDirection,
} from "../packages/accessibility/src/keyboard-trap.js";
import type { ContextChangeResult } from "../packages/accessibility/src/context-change.js";
import {
  VariantLabelsFileSchema,
  type ElementLabel,
} from "./corpus/labels-schema.js";
import {
  BadTruthSchema,
  REPORT_CODE,
  axeCriteria,
  criterionFromAxeTag,
  currentCriteria,
  legacyTrapFlagged,
  ourCriteria,
  renderReport,
  type ReportInput,
} from "./report.js";
import {
  KeyboardEvidenceSummarySchema,
  RESULTS_SCHEMA_VERSION,
  SUBSET_DIR_RE,
  SummarySchema,
  runDirName,
  type AxeFinding,
  type GapFinding,
  type KeyboardEvidenceSummary,
  type PageResult,
  type PageSet,
  type Summary,
  type WalkStats,
} from "./results-schema.js";

const BENCH = dirname(fileURLToPath(import.meta.url));
const badTruth = BadTruthSchema.parse(
  JSON.parse(
    readFileSync(join(BENCH, "corpus", "test", "bad-labels.json"), "utf8"),
  ),
);

type Fake = {
  gaps?: GapFinding[];
  trapped?: boolean;
  dynamic?: string[];
  axe?: AxeFinding[];
  cluster?: string;
  walk?: Partial<WalkStats>;
  keyboard?: Partial<KeyboardEvidenceSummary>;
};

// The default is an ASSESSED walk, because that is what the harness now always produces: bench/run.ts
// passes tabWalk: true on every page (118bb99). A fixture defaulting to unassessed would make most of
// this file assert the not-assessed path by accident. The unassessed path is covered explicitly, by the
// tests that pass `keyboard`.
const ASSESSED_KEYBOARD: KeyboardEvidenceSummary = {
  walkRan: true,
  notFocusableAssessed: true,
  unassessedReasons: [],
  walkError: null,
  reachedCount: 3,
};
// notFocusableAssessed must agree with unassessedReasons (KeyboardEvidenceSummarySchema refines it), so
// callers say WHY and the flag follows.
const keyboardOf = (f: Fake): KeyboardEvidenceSummary => {
  const merged = { ...ASSESSED_KEYBOARD, ...f.keyboard };
  return {
    ...merged,
    notFocusableAssessed: merged.unassessedReasons.length === 0,
  };
};

const launchFacts = {
  browserVersion: "143.0.7499.4",
  executableBasename: "chrome-headless-shell",
};

const direction = (over: Partial<TrapDirection> = {}): TrapDirection => ({
  direction: "forward",
  verdict: "pass",
  reason: null,
  confined: false,
  endOfPage: { signal: "body-unfocused", atPress: 4 },
  release: "not-probed",
  region: [11, 12, 13],
  focusableCount: 3,
  stuckOn: null,
  escapeUrlChanged: false,
  documentReplacements: [],
  ...over,
});

// The 2.1.2 judge's four reportable states. Confinement and a violation are a PAIR: a correct modal
// is confined AND escapable, which is not a 2.1.2 failure.
const trapPass = (): KeyboardTrapResult => ({
  wcagCriterion: "2.1.2",
  verdict: "pass",
  reason: null,
  keyboardTrap: false,
  trapEscapable: null,
  singleDirection: false,
  directionsWalked: ["forward"],
  launch: launchFacts,
  directions: [direction()],
});
const trapEscapable = (): KeyboardTrapResult => ({
  ...trapPass(),
  keyboardTrap: true,
  trapEscapable: true,
  directions: [
    direction({ confined: true, endOfPage: null, release: "escape-key" }),
  ],
});
const trapFail = (): KeyboardTrapResult => ({
  ...trapPass(),
  verdict: "fail",
  keyboardTrap: true,
  trapEscapable: false,
  directions: [
    direction({
      verdict: "fail",
      confined: true,
      endOfPage: null,
      release: "none",
      stuckOn: {
        backendNodeId: 11,
        tag: "A",
        id: "one",
        isBody: false,
        classAttr: null,
      },
    }),
  ],
});
const trapUndetermined = (
  reason: KeyboardTrapResult["reason"] = "focusables-incomplete",
): KeyboardTrapResult => ({
  ...trapPass(),
  verdict: "undetermined",
  reason,
  directions: [direction({ verdict: "undetermined", reason, endOfPage: null })],
});

const contextPass = (): ContextChangeResult => ({
  wcagCriterion: "3.2.1",
  verdict: "pass",
  reason: null,
  fIncomplete: false,
  findings: [],
  unattributed: [],
});
const contextFail = (): ContextChangeResult => ({
  ...contextPass(),
  verdict: "fail",
  findings: [
    {
      kind: "url-changed",
      wcagCriterion: "3.2.1",
      severity: "serious",
      pressIndex: 3,
      key: "Tab",
      arrivedOn: null,
      precedingStop: null,
      fromUrl: "http://127.0.0.1/p",
      toUrl: "http://127.0.0.1/p?changed=1",
      documentReplaced: true,
    },
  ],
});
const contextUndetermined = (): ContextChangeResult => ({
  ...contextPass(),
  verdict: "undetermined",
  reason: "page-navigates-without-input",
});

const cleanWalk: WalkStats = {
  F: 3,
  fIncomplete: false,
  fIncompleteCauses: { crossOriginFrames: 0, closedShadowRoots: 0 },
  plannedPresses: 25,
  presses: 25,
  wraps: 6,
  focusLost: 0,
  deep: { inside: 0, crossOrigin: 0, closedShadowRoot: 0 },
  launch: launchFacts,
  suspectedTrap: false,
  trap: trapPass(),
  contextChange: contextPass(),
  escapeReachedAt: null,
  error: null,
};

const gap = (over: Partial<GapFinding>): GapFinding => ({
  nodeName: "DIV",
  id: null,
  class: null,
  dataBenchId: null,
  gapType: "missing_from_a11y_tree",
  severity: "critical",
  wcag: ["4.1.2"],
  ...over,
});

const axe = (id: string, tags: string[], components = ["DIV"]): AxeFinding => ({
  id,
  impact: "serious",
  wcagTags: tags,
  targets: components.map((_, i) => `#n${i}`),
  components,
});

function fakePage(pageId: string, f: Fake): PageResult {
  const base = {
    error: null,
    budgetExceeded: false,
    durationMs: 1,
    load: null,
  };
  return {
    pageId,
    url: `http://127.0.0.1/${pageId}`,
    cluster: f.cluster ?? "w3c-bad",
    budgetMs: 1_200_000,
    budgetExceeded: false,
    durationMs: 3,
    rawFile: null,
    tools: {
      gaps: {
        ...base,
        status: "ok",
        findings: { gaps: f.gaps ?? [], keyboard: keyboardOf(f) },
      },
      walk: { ...base, status: "ok", findings: { ...cleanWalk, ...f.walk } },
      legacy: {
        ...base,
        status: "ok",
        findings: {
          presses: 25,
          trap: {
            trapped: f.trapped ?? false,
            firstTrappedPress: f.trapped ? 20 : null,
            cycleLength: f.trapped ? 4 : 0,
            element: f.trapped ? 'a "One"' : null,
          },
          dynamicViolations: (f.dynamic ?? []).map((criterion) => ({
            criterion,
            severity: "moderate" as const,
            description: "d",
            evidence: ['a "One"'],
          })),
        },
      },
      axe: { ...base, status: "ok", findings: f.axe ?? [] },
    },
  };
}

// run.ts legacyFrom records the replay of a walk that stopped early as "partial", findings kept.
function cutReplay(page: PageResult): PageResult {
  const cut = structuredClone(page);
  cut.tools.legacy = {
    ...cut.tools.legacy,
    status: "partial",
    error: "walked 10 of 25 planned stops: the walk stopped early",
  };
  return cut;
}

function fakeSummary(
  set: PageSet,
  pages: PageResult[],
  dirty = false,
  pageFilter: string[] | null = null,
): Summary {
  return SummarySchema.parse({
    schemaVersion: RESULTS_SCHEMA_VERSION,
    set,
    complete: true,
    createdAt: "2026-09-18T00:00:00.000Z",
    git: {
      sha: "0467eb6".padEnd(40, "0"),
      shortSha: "0467eb6",
      dirty,
      dirtyPaths: dirty ? ["bench/run.ts"] : [],
    },
    launch: {
      mode: "headless-shell",
      browserVersion: "143.0.7499.4",
      executablePath: "/x/chrome",
      executablePathNote: "n",
      browserProcessPath: "/x/chrome-headless-shell",
      userAgent: "HeadlessChrome/143",
      playwrightVersion: "1.57.0",
    },
    axeCoreVersion: "4.11.0",
    nodeVersion: "v22.0.0",
    config: {
      budgetMs: 1_200_000,
      waitUntil: "domcontentloaded",
      settleMs: 3000,
      loadTimeoutMs: 60_000,
      walkOptions: "runTabWalk defaults",
      localOnly: true,
      pageFilter,
    },
    inputs: [],
    notes: ["3.2.1 note"],
    pages,
  });
}

const tag412 = ["wcag2a", "wcag412"];
const badSummary = fakeSummary(
  "test-bad",
  [
    fakePage("before/home", {
      gaps: [
        gap({}),
        gap({ gapType: "not_focusable", wcag: ["2.1.1", "2.4.7"] }),
      ],
      trapped: true,
      axe: [axe("button-name", tag412)],
    }),
    // Passes 2.4.3, so the legacy 2.4.3 flag here is a false alarm even though it is a before-page.
    fakePage("before/news", {
      gaps: [gap({})],
      trapped: true,
      dynamic: ["2.4.3"],
      axe: [axe("button-name", tag412)],
    }),
    fakePage("before/survey", { trapped: true, dynamic: ["2.4.3"] }),
    fakePage("before/tickets", {
      trapped: true,
      axe: [axe("aria-command-name", tag412)],
    }),
    ...["home", "news", "survey", "tickets"].map((n) =>
      fakePage(`after/${n}`, {
        trapped: true,
        axe: n === "home" ? [axe("button-name", tag412)] : [],
      }),
    ),
  ],
  true,
);

function input(
  summaries: ReportInput["summaries"],
  over: Partial<ReportInput> = {},
): ReportInput {
  return {
    sha: "0467eb6-dirty",
    summaries,
    subsets: [],
    badTruth,
    variantLabels: null,
    baseLabels: null,
    currentInputs: {},
    ...over,
  };
}

function row(md: string, heading: string, sc: string): string {
  const section = md.slice(md.indexOf(heading));
  const line = section.split("\n").find((l) => l.startsWith(`| ${sc} |`));
  if (line === undefined) throw new Error(`no row ${sc} under ${heading}`);
  return line;
}

describe("criterion mapping", () => {
  it("parses axe's success-criterion tags and ignores level and version tags", () => {
    expect(criterionFromAxeTag("wcag412")).toBe("4.1.2");
    expect(criterionFromAxeTag("wcag1411")).toBe("1.4.11");
    expect(criterionFromAxeTag("wcag2a")).toBeNull();
    expect(criterionFromAxeTag("wcag21aa")).toBeNull();
    expect(criterionFromAxeTag("best-practice")).toBeNull();
  });

  it("maps gaps by their wcag list, the legacy trap to 2.1.2 and dynamic violations by criterion", () => {
    const ours = ourCriteria(badSummary.pages[0]);
    expect([...ours.keys()].sort()).toEqual([
      "2.1.1",
      "2.1.2",
      "2.4.7",
      "4.1.2",
    ]);
    expect([...(ours.get("2.1.2") ?? [])]).toEqual(["legacy-trap"]);
    expect([...(ours.get("4.1.2") ?? [])]).toEqual([
      "gap:missing_from_a11y_tree",
    ]);
    expect([...axeCriteria(badSummary.pages[0]).keys()]).toEqual(["4.1.2"]);
  });

  it("counts a legacy trap that fired mid-walk and cleared by the end, as the agent's latch would", () => {
    expect(legacyTrapFlagged({ firstTrappedPress: 19 })).toBe(true);
    expect(legacyTrapFlagged({ firstTrappedPress: null })).toBe(false);
    const page = structuredClone(badSummary.pages[0]);
    const legacy = page.tools.legacy.findings;
    if (legacy === null) throw new Error("fixture page has no legacy findings");
    legacy.trap = { ...legacy.trap, trapped: false, firstTrappedPress: 19 };
    expect([...(ourCriteria(page).get("2.1.2") ?? [])]).toEqual([
      "legacy-trap",
    ]);
  });
});

describe("after column: currentCriteria", () => {
  const withWalk = (walk: Partial<WalkStats>): PageResult =>
    fakePage("before/home", { gaps: [gap({})], walk });

  it("maps an inescapable trap verdict to 2.1.2 and an escapable confinement to nothing", () => {
    const inescapable = withWalk({ trap: trapFail() });
    expect([...(currentCriteria(inescapable).get("2.1.2") ?? [])]).toEqual([
      "judge-trap",
    ]);
    const escapable = withWalk({ trap: trapEscapable() });
    expect(currentCriteria(escapable).has("2.1.2")).toBe(false);
    expect(
      currentCriteria(withWalk({ trap: trapUndetermined() })).has("2.1.2"),
    ).toBe(false);
  });

  it("leaves the frozen before column untouched by either walk verdict", () => {
    // The before column reads the legacy trap only; f.trapped is false on both pages.
    expect(ourCriteria(withWalk({ trap: trapFail() })).has("2.1.2")).toBe(
      false,
    );
    expect(ourCriteria(withWalk({ trap: trapEscapable() })).has("2.1.2")).toBe(
      false,
    );
  });

  it("maps a failing context-change verdict to 3.2.1 and never emits the deleted 2.4.3", () => {
    const page = fakePage("before/home", {
      dynamic: ["2.4.3", "3.2.1"],
      walk: { contextChange: contextFail() },
    });
    expect([...(currentCriteria(page).get("3.2.1") ?? [])]).toEqual([
      "judge-context-change",
    ]);
    expect(currentCriteria(page).has("2.4.3")).toBe(false);
    // The before column still carries both legacy dynamic violations.
    expect(ourCriteria(page).has("2.4.3")).toBe(true);
    expect([...(ourCriteria(page).get("3.2.1") ?? [])]).toEqual([
      "legacy-dynamic:3.2.1",
    ]);
  });

  it("shares the gap criteria with the before column, so no gap fix hides in the delta", () => {
    const page = fakePage("before/home", {
      gaps: [gap({}), gap({ gapType: "not_focusable", wcag: ["2.1.1"] })],
    });
    expect([...currentCriteria(page).keys()].sort()).toEqual([
      "2.1.1",
      "4.1.2",
    ]);
    expect([...(currentCriteria(page).get("4.1.2") ?? [])]).toEqual([
      "gap:missing_from_a11y_tree",
    ]);
  });
});

describe("an undetermined verdict counts as a miss", () => {
  // Two pages whose report FAILS 3.2.1 (before/*) and two it PASSES (after/*), one fail and one
  // undetermined on each side.
  const summary = fakeSummary("test-bad", [
    fakePage("before/home", { walk: { contextChange: contextFail() } }),
    fakePage("before/news", { walk: { contextChange: contextUndetermined() } }),
    fakePage("after/home", { walk: { contextChange: contextFail() } }),
    fakePage("after/news", { walk: { contextChange: contextUndetermined() } }),
  ]);
  const md = renderReport(input({ "test-bad": summary }));

  it("keeps the undetermined page in the detection denominator and prints the count", () => {
    const r = row(md, "### Detection", "3.2.1");
    expect(r).toContain("2 pages (2 before, 0 after) / 1 cluster");
    expect(r).toContain("1/2 · 0.50 [0.09, 0.91] · 1 undetermined");
    expect(r).not.toContain("1/1");
  });

  it("mirrors it on the false-alarm table", () => {
    const r = row(md, "### False alarms", "3.2.1");
    expect(r).toContain("2 pages (0 before, 2 after) / 1 cluster");
    expect(r).toContain("1/2 · 0.50 [0.09, 0.91] · 1 undetermined");
    expect(r).not.toContain("1/1");
  });

  it("prints an undetermined 2.1.2 verdict beside its rate too, and marks the page U", () => {
    const traps = fakeSummary("test-bad", [
      fakePage("after/home", { walk: { trap: trapFail() } }),
      fakePage("after/news", { walk: { trap: trapUndetermined() } }),
    ]);
    const out = renderReport(input({ "test-bad": traps }));
    expect(row(out, "### False alarms", "2.1.2")).toContain(
      "1/2 · 0.50 [0.09, 0.91] · 1 undetermined",
    );
    const perPage = out.slice(out.indexOf("#### Per page"));
    // U is no longer an after-column-only mark: a criterion the walk never assessed is unobserved in
    // BOTH columns, so the legend has to say which column a U belongs to rather than assume.
    expect(perPage).toContain("U = that column did not observe it");
    const line = (id: string) =>
      perPage.split("\n").find((l) => l.startsWith(`| ${id} |`)) ?? "";
    // C, not N: N already means "missed" in the variant grid, so reusing it here would mislead.
    expect(line("after/home")).toContain("| P –C– |");
    expect(line("after/news")).toContain("| P –U– |");
  });

  it("prints the false-alarm worst case, because a refusal there scores like a clean pass", () => {
    // The asymmetry this guards: on a page that SHOULD be flagged, an undetermined verdict costs
    // detection. On a CLEAN page it is arithmetically identical to a correct pass, so without the
    // worst case a checker could lower its false-alarm rate purely by refusing to decide.
    const after = row(md, "### False alarms", "3.2.1")
      .split("|")
      .map((c) => c.trim())[5];
    expect(after).toContain("1/2 · 0.50");
    expect(after).toContain("1 undetermined (worst case 2/2 · 1.00)");
  });

  it("drops the rule-of-three bound when a page was never observed", () => {
    // Rule of three reads "n observations, zero events". With a refusal in the denominator only
    // n-1 pages were observed, so the bound would describe a sample that was never taken.
    const clean = fakeSummary("test-bad", [
      fakePage("after/home", {}),
      fakePage("after/news", {
        walk: { contextChange: contextUndetermined() },
      }),
    ]);
    const cells = row(
      renderReport(input({ "test-bad": clean })),
      "### False alarms",
      "3.2.1",
    )
      .split("|")
      .map((c) => c.trim());
    expect(cells[5]).toContain("0/2 · 0.00");
    expect(cells[5]).toContain("1 undetermined (worst case 1/2 · 0.50)");
    expect(cells[5]).not.toContain("rule of 3");
    // The frozen before column has no refusals, so it keeps its bound: the drop is caused by the
    // refusal, not by the table.
    expect(cells[3]).toContain("rule of 3");
  });

  it("calls 2.1.2 undetermined in the before column when the legacy replay was cut before its trap fired", () => {
    // The judge calls the same short walk undetermined; the frozen replay saw only the presses before
    // the cut, so an untripped trap there is unobserved, not a clean pass. A trap it did see still counts.
    const pages = [
      cutReplay(
        fakePage("after/home", { walk: { trap: trapUndetermined("short-walk") } }),
      ),
      cutReplay(
        fakePage("after/news", {
          trapped: true,
          walk: { trap: trapUndetermined("short-walk") },
        }),
      ),
    ];
    const out = renderReport(
      input({ "test-bad": fakeSummary("test-bad", pages) }),
    );
    const cells = row(out, "### False alarms", "2.1.2")
      .split("|")
      .map((c) => c.trim());
    expect(cells[3]).toContain(
      "1/2 · 0.50 [0.09, 0.91] · 1 undetermined (worst case 2/2 · 1.00)",
    );
    const perPage = out.slice(out.indexOf("#### Per page"));
    const line = (id: string) =>
      perPage.split("\n").find((l) => l.startsWith(`| ${id} |`)) ?? "";
    expect(line("after/home")).toContain("| P UU– |");
    expect(line("after/news")).toContain("| P OU– |");
  });

  it("keeps the tool-error exclusion separate from an undetermined verdict", () => {
    const broken = structuredClone(summary.pages[0]);
    broken.tools.walk = {
      status: "error",
      error: "walk died",
      budgetExceeded: false,
      durationMs: 1,
      load: null,
      findings: null,
    };
    const out = renderReport(
      input({
        "test-bad": fakeSummary("test-bad", [broken, summary.pages[1]]),
      }),
    );
    const r = row(out, "### Detection", "3.2.1");
    expect(r).toContain(
      "0/1 · 0.00 [0.00, 0.79] · 1 undetermined (1 excluded: tool error)",
    );
  });
});

describe("per-page flag table", () => {
  it("prints a walk cut short as stops walked of stops planned", () => {
    const cut = fakeSummary("dev-fixtures", [
      fakePage("three-links", { walk: { presses: 10 } }),
    ]);
    const md = renderReport(input({ "dev-fixtures": cut }));
    expect(md).toContain("| three-links | 3 / 6 (10/25 stops) |");
  });
});

describe("renderReport: test-bad", () => {
  const md = renderReport(input({ "test-bad": badSummary }));
  const DET = "### Detection";
  const FA = "### False alarms";

  it("scores detection on pages the W3C report fails, with Wilson intervals and the cluster count", () => {
    const r412 = row(md, DET, "4.1.2");
    expect(r412).toContain("4 pages (4 before, 0 after) / 1 cluster");
    expect(r412).toContain("2/4 · 0.50 [0.15, 0.85]");
    expect(r412).toContain("3/4 · 0.75 [0.30, 0.95]");
    expect(row(md, DET, "2.1.1")).toContain("1/4 · 0.25 [0.05, 0.70]");
    // Only before/survey fails 2.4.3 in the truth file.
    expect(row(md, DET, "2.4.3")).toContain("1/1 · 1.00 [0.21, 1.00]");
    // No before-page fails 2.1.2, so there is nothing to detect.
    expect(row(md, DET, "2.1.2")).toContain("n/a");
  });

  it("keeps the 2.4.3 row after the cut, at zero, with the COVERAGE.md footnote", () => {
    const r243 = row(md, DET, "2.4.3");
    // before 1/1 (legacy focus-order rule) -> after 0/1: nothing replaces it.
    expect(r243).toContain("1/1 · 1.00 [0.21, 1.00]");
    expect(r243).toContain("0/1 · 0.00");
    // The after column's evidence cell for 2.4.3 is empty.
    const cells = r243.split("|").map((c) => c.trim());
    expect(cells[5]).toContain("0/1 · 0.00");
    expect(cells[6]).toBe("—");
    expect(row(md, FA, "2.4.3")).toContain("0/7 · 0.00 [0.00, 0.35]");
    expect(md).toContain(
      "2.4.3 has no after-column detector: the focus-order rule was deleted rather than repaired, and nothing replaces it (bench/COVERAGE.md).",
    );
  });

  it("scores the after column's 2.1.2 and 3.2.1 from the judge verdicts", () => {
    // Every page's walk passes both judges, and the legacy trap fires on all eight.
    expect(row(md, FA, "2.1.2")).toContain("8/8 · 1.00 [0.68, 1.00]");
    const judged = fakeSummary("test-bad", [
      fakePage("after/home", {
        trapped: true,
        walk: { trap: trapFail(), contextChange: contextFail() },
      }),
    ]);
    const out = renderReport(input({ "test-bad": judged }));
    expect(row(out, FA, "2.1.2")).toContain("judge-trap ×1");
    expect(row(out, FA, "3.2.1")).toContain("judge-context-change ×1");
    expect(row(out, FA, "2.1.2")).toContain("legacy-trap ×1");
  });

  it("scores false alarms on every page the report passes, before or after, adding the rule of three at zero", () => {
    // Every page passes 2.1.2; the legacy trap fires on all eight.
    const r212 = row(md, FA, "2.1.2");
    expect(r212).toContain("8 pages (4 before, 4 after) / 1 cluster");
    expect(r212).toContain("8/8 · 1.00 [0.68, 1.00]");
    expect(r212).toContain("0/8 · 0.00 [0.00, 0.32] · rule of 3 ≤ 0.38");
    // before/survey fails 2.4.3, so its flag is a detection; before/news passes it, so its flag is a false alarm.
    const r243 = row(md, FA, "2.4.3");
    expect(r243).toContain("7 pages (3 before, 4 after) / 1 cluster");
    expect(r243).toContain("1/7 · 0.14 [0.03, 0.51]");
    expect(r243).toContain("legacy-dynamic:2.4.3 ×1");
    const r412 = row(md, FA, "4.1.2");
    expect(r412).toContain("4 pages (0 before, 4 after) / 1 cluster");
    expect(r412).toContain("0/4 · 0.00 [0.00, 0.49] · rule of 3 ≤ 0.75");
    expect(r412).toContain("1/4 · 0.25 [0.05, 0.70]");
  });

  it("keeps the rule of three off detection cells", () => {
    expect(row(md, DET, "2.1.1")).toContain("0/4 · 0.00 [0.00, 0.49] |");
    expect(md.slice(md.indexOf(DET), md.indexOf(FA))).not.toContain(
      "rule of 3",
    );
  });

  it("names the evidence behind our flags, the 3.2.1 limitation and the dirty stamp; never McNemar", () => {
    expect(row(md, DET, "4.1.2")).toContain("gap:missing_from_a11y_tree");
    expect(md).toContain("3.2.1 note");
    expect(md).toMatch(/DIRTY/);
    expect(md).not.toMatch(/mcnemar/i);
  });
});

describe("renderReport: dev-variants and dev-fixtures", () => {
  const el = (over: Partial<ElementLabel> = {}): ElementLabel => ({
    interactive: true,
    keyboardAccessible: true,
    expectedGapType: null,
    note: "n",
    ...over,
  });
  const flags = {
    keyboardTrap: false,
    trapEscapable: null,
    contextChangeOnFocus: false,
    focusLostOnArrival: false,
  };
  const variant = (
    base: string,
    op: "M1" | "M3" | "M5" | "M6" | "M8" | "M10" | "M13",
    target: string,
    label: ElementLabel,
  ) => [
    `${base}__${op}__${target}`,
    {
      file: `${base}__${op}__${target}.html`,
      page:
        op === "M5" || op === "M10"
          ? { ...flags, keyboardTrap: true, trapEscapable: false }
          : op === "M6"
            ? { ...flags, contextChangeOnFocus: true }
            : op === "M8"
              ? { ...flags, focusLostOnArrival: true }
              : flags,
      elements: { [target]: label },
      base,
      operator: op,
      target,
    },
  ];
  const variantLabels = VariantLabelsFileSchema.parse({
    schemaVersion: 1,
    variants: Object.fromEntries([
      variant(
        "b1",
        "M1",
        "t1",
        el({
          keyboardAccessible: false,
          expectedGapType: "wrong_role",
          acceptableGapTypes: ["wrong_role", "not_focusable"],
        }),
      ),
      variant(
        "b1",
        "M3",
        "t2",
        el({ expectedGapType: "hidden_but_interactive" }),
      ),
      variant("b2", "M5", "t3", el()),
      variant("b2", "M6", "t4", el()),
      // One operator of each kind added in round 2: 3.2.1 (M8), 2.1.2 (M10) and the gap decoy (M13).
      variant(
        "b2",
        "M8",
        "t5",
        el({ keyboardAccessible: false, expectedGapType: "not_focusable" }),
      ),
      variant("b2", "M10", "t6", el()),
      variant(
        "b1",
        "M13",
        "t7",
        el({ interactive: false, keyboardAccessible: false }),
      ),
    ]),
  });
  const variants = fakeSummary("dev-variants", [
    fakePage("b1__M1__t1", {
      cluster: "b1",
      gaps: [
        gap({
          dataBenchId: "t1",
          gapType: "not_focusable",
          wcag: ["2.1.1", "2.4.7"],
        }),
      ],
    }),
    fakePage("b1__M3__t2", {
      cluster: "b1",
      gaps: [gap({ dataBenchId: "other" })],
    }),
    fakePage("b2__M5__t3", {
      cluster: "b2",
      trapped: true,
      walk: { trap: trapFail() },
    }),
    // The legacy DynamicEvaluator never produced 3.2.1 on a scripted walk; the judge does.
    fakePage("b2__M6__t4", {
      cluster: "b2",
      dynamic: ["2.4.3"],
      walk: { contextChange: contextFail() },
    }),
    // M8's target carries a gap, which a gap-read would score Y; its cell is the 3.2.1 judge's pass.
    fakePage("b2__M8__t5", {
      cluster: "b2",
      gaps: [
        gap({
          dataBenchId: "t5",
          gapType: "not_focusable",
          wcag: ["2.1.1", "2.4.7"],
        }),
      ],
    }),
    fakePage("b2__M10__t6", { cluster: "b2", walk: { trap: trapFail() } }),
    // A gap on the decoy's target is a false alarm, and it still reads as Y.
    fakePage("b1__M13__t7", {
      cluster: "b1",
      gaps: [gap({ dataBenchId: "t7" })],
      walk: { trap: trapFail() },
    }),
  ]);
  const fixtures = fakeSummary("dev-fixtures", [
    fakePage("cards", {
      cluster: "cards",
      gaps: [
        gap({ nodeName: "A", class: "btn primary" }),
        gap({ nodeName: "A", class: "primary  btn" }),
        gap({ nodeName: "A", class: "primary btn" }),
        gap({ nodeName: "DIV", class: "card" }),
      ],
      axe: [axe("link-name", ["wcag2a", "wcag244"], ["A.x", "A.x"])],
    }),
  ]);
  const md = renderReport(
    input(
      { "dev-variants": variants, "dev-fixtures": fixtures },
      { variantLabels },
    ),
  );

  const gridLine = (source: string, op: string) =>
    source
      .slice(source.indexOf("| operator |"))
      .split("\n")
      .find((l) => l.startsWith(`| ${op} |`)) ?? "";

  it("labels the variant grid regression-only and marks each seeded target flagged or missed", () => {
    expect(md).toContain("regression only — not a headline number");
    const line = (op: string) => gridLine(md, op);
    // M1-M4 read the shared gap detector, so their cell cannot differ between the columns.
    expect(line("M1")).toMatch(/\| Y \| · \|$/);
    expect(line("M3")).toMatch(/\| N \| · \|$/);
    // M5: the legacy trap and the 2.1.2 judge both flag it, so the cell prints once.
    expect(line("M5")).toMatch(/\| · \| Y \|$/);
    // M6: the frozen column missed it; the 3.2.1 judge flags it.
    expect(line("M6")).toMatch(/\| · \| N→Y \|$/);
    // M8 reads the 3.2.1 verdict (a pass), not the gap on its target; M10 reads the 2.1.2 verdict; M13
    // reads the gap detector, not the page's trap verdict, and the legend calls its Y a false alarm.
    expect(line("M8")).toMatch(/\| · \| N \|$/);
    expect(line("M10")).toMatch(/\| · \| N→Y \|$/);
    expect(line("M13")).toMatch(/\| Y \| · \|$/);
    expect(md).toContain("a Y in its row is a false alarm");
    expect(md).toContain("Flagged per operator (before → after):");
  });

  it("reads the after column's M5 oracle from trap.verdict and M6's from contextChange.verdict", () => {
    const swapped = fakeSummary("dev-variants", [
      // The legacy trap fires, the judge says the confinement is escapable: a correct modal.
      fakePage("b2__M5__t3", {
        cluster: "b2",
        trapped: true,
        walk: { trap: trapEscapable() },
      }),
      fakePage("b2__M6__t4", {
        cluster: "b2",
        walk: { contextChange: contextUndetermined() },
      }),
    ]);
    const out = renderReport(
      input({ "dev-variants": swapped }, { variantLabels }),
    );
    expect(gridLine(out, "M5")).toMatch(/\| Y→N \|$/);
    // An undetermined verdict is its own mark, and the legend says it counts as a miss.
    expect(gridLine(out, "M6")).toMatch(/\| N→U \|$/);
    expect(out).toContain("U undetermined (counted as a miss)");
  });

  it("marks the before M5 cell U when the legacy replay was cut before its trap fired", () => {
    const cut = fakeSummary("dev-variants", [
      cutReplay(
        fakePage("b2__M5__t3", {
          cluster: "b2",
          walk: { trap: trapUndetermined("short-walk") },
        }),
      ),
    ]);
    const out = renderReport(input({ "dev-variants": cut }, { variantLabels }));
    expect(gridLine(out, "M5")).toMatch(/\| U \|$/);
  });

  it("keeps the gap-type confusion matrix separate and counts acceptable types", () => {
    const confusion = md.slice(
      md.indexOf("#### Gap type on the seeded target"),
    );
    const wrongRole =
      confusion.split("\n").find((l) => l.startsWith("| wrong_role |")) ?? "";
    expect(wrongRole).toContain("| 1/1 |");
    expect(wrongRole.split("|").map((c) => c.trim())).toContain("1");
  });

  it("groups fixture flags by component (nodeName + sorted class set): copies vs distinct", () => {
    expect(md).toContain("A.btn.primary ×3");
    expect(md).toMatch(/\| cards \|[^\n]*\| 4 \/ 2 \|/);
  });

  it("marks a Y with † when the unmodified base page already had the same flag", () => {
    // The base page carries the legacy trap flag but not the judge's fail, so only the before mark
    // gets the dagger and the two columns print separately.
    const withBase = fakeSummary("dev-fixtures", [
      fakePage("b2", { cluster: "b2", trapped: true }),
    ]);
    const grid = renderReport(
      input(
        { "dev-variants": variants, "dev-fixtures": withBase },
        { variantLabels },
      ),
    );
    const m5 =
      grid.split("\n").find((l) => l.startsWith("| M5 |")) ?? "no M5 row";
    expect(m5).toMatch(/\| · \| Y†→Y \|$/);
    const m1 =
      grid.split("\n").find((l) => l.startsWith("| M1 |")) ?? "no M1 row";
    expect(m1).toMatch(/\| Y \| · \|$/);
  });

  it("names a recorded page the labels file does not know instead of dropping it silently", () => {
    const extra = fakeSummary("dev-variants", [
      ...variants.pages,
      fakePage("b9__M1__gone", { cluster: "b9" }),
    ]);
    const out = renderReport(
      input({ "dev-variants": extra }, { variantLabels }),
    );
    expect(out).toContain("Not in the labels file (ignored): b9__M1__gone.");
  });

  it("says how many targets the gap-type table left out for a gaps-tool error", () => {
    // The per-operator line keeps an errored page in its denominator as a miss; the gap-type table
    // cannot read a gap off it, so without the count its targets column silently disagrees.
    const broken = structuredClone(variants.pages[0]);
    broken.tools.gaps = {
      status: "error",
      error: "crawl died",
      budgetExceeded: false,
      durationMs: 1,
      load: null,
      findings: null,
    };
    const out = renderReport(
      input(
        {
          "dev-variants": fakeSummary("dev-variants", [
            broken,
            ...variants.pages.slice(1),
          ]),
        },
        { variantLabels },
      ),
    );
    expect(out).toContain("M1 0/1 → 0/1");
    const confusion = out.slice(
      out.indexOf("#### Gap type on the seeded target"),
    );
    const wrongRole =
      confusion.split("\n").find((l) => l.startsWith("| wrong_role |")) ?? "";
    expect(wrongRole).toContain("| wrong_role | 0 (1 excluded: tool error) |");
  });
});

describe("subset runs", () => {
  it("names a --pages run's directory by its sorted page ids, apart from the set's own", () => {
    expect(runDirName("test-bad", null)).toBe("test-bad");
    const dir = runDirName("test-bad", ["before/news", "after/home"]);
    expect(dir).toMatch(SUBSET_DIR_RE);
    expect(SUBSET_DIR_RE.exec(dir)?.[1]).toBe("test-bad");
    expect(runDirName("test-bad", ["after/home", "before/news"])).toBe(dir);
    expect(runDirName("test-bad", ["after/home"])).not.toBe(dir);
  });

  const subset = fakeSummary("test-bad", badSummary.pages.slice(0, 2), true, [
    "before/home",
    "before/news",
  ]);

  it("leaves a subset run out of every table and warns about it", () => {
    const md = renderReport(
      input(
        { "test-bad": badSummary },
        { subsets: [{ dir: "test-bad--subset-0123456789", summary: subset }] },
      ),
    );
    expect(md).toContain(
      "> **SUBSET**: test-bad--subset-0123456789 ran only 2 pages of test-bad (--pages before/home,before/news, dirty); it is left out of every table below.",
    );
    // The headline still scores the full run's eight pages.
    expect(row(md, "### False alarms", "2.1.2")).toContain("8/8");
  });

  it("treats a filtered summary found in the set's own directory as a subset, never as the headline", () => {
    const md = renderReport(input({ "test-bad": subset }));
    expect(md).toContain("> **SUBSET**: test-bad ran only 2 pages of test-bad");
    expect(md).not.toContain("### Detection");
    expect(md).toContain(
      "No full-set run at this commit: dev-fixtures, dev-variants, dev-live, test-bad, test-live.",
    );
  });
});

describe("the walk-trap cell reads the 2.1.2 judge", () => {
  const cell = (walk: Partial<WalkStats>): string => {
    const live = fakeSummary("dev-live", [
      fakePage("p.example", { cluster: "p.example", trapped: true, walk }),
    ]);
    const md = renderReport(input({ "dev-live": live }));
    return md.split("\n").find((l) => l.startsWith("| p.example |")) ?? "";
  };

  it("tells no trap, an escapable confinement, an inescapable trap and an undetermined verdict apart", () => {
    expect(cell({})).toContain("| — |");
    // A correct modal: confined AND escapable is NOT a 2.1.2 violation, so it must not read as a trap.
    const modal = cell({ trap: trapEscapable() });
    expect(modal).toContain("| confined, escapable via escape-key |");
    expect(modal).not.toContain("TRAP");
    expect(cell({ trap: trapFail() })).toContain(
      "| TRAP inescapable (stuck on A#one) |",
    );
  });

  it("prints an undetermined verdict with the judge's own reason and no escape outcome", () => {
    const frames = cell({
      F: 14,
      fIncomplete: true,
      fIncompleteCauses: { crossOriginFrames: 1, closedShadowRoots: 0 },
      wraps: 0,
      deep: { inside: 0, crossOrigin: 40, closedShadowRoot: 0 },
      suspectedTrap: true,
      trap: trapUndetermined("focusables-incomplete"),
      escapeReachedAt: null,
    });
    expect(frames).toContain(
      "| ≥14 / 0 | 0 / 0 | Y @20 (cycle 4) | undetermined (focusables-incomplete) |",
    );
    expect(frames).not.toContain("TRAP");
    expect(cell({ trap: trapUndetermined("walk-error") })).toContain(
      "| undetermined (walk-error) |",
    );
  });

  it("documents the four marks in the legend and keeps the ≥F note", () => {
    const md = renderReport(
      input({
        "dev-live": fakeSummary("dev-live", [
          fakePage("p.example", {
            cluster: "p.example",
            walk: { fIncomplete: true },
          }),
        ]),
      }),
    );
    expect(md).toContain(
      'walk trap = the 2.1.2 judge: — no confinement · "confined, escapable" a correct modal, NOT a violation · "TRAP inescapable" the criterion fails · "undetermined (<reason>)" not judged: a miss on a detection count, and scored like a clean pass on a false-alarm count, with the worst case printed beside it.',
    );
    expect(md).toContain("≥F: a cross-origin frame or closed shadow root");
  });
});

describe("Headline: before → after", () => {
  const md = renderReport(input({ "test-bad": badSummary }));
  const block = md.slice(
    md.indexOf("## Headline: before → after"),
    md.indexOf("## test-bad"),
  );
  const hrow = (sc: string, table: string) =>
    block.split("\n").find((l) => l.startsWith(`| ${sc} | ${table} |`)) ?? "";

  it("decomposes the delta so a scope cut cannot read as a fix", () => {
    expect(block).toContain("| criterion | table |");
    expect(hrow("2.4.3", "detection")).toContain("SCOPE CUT — rule deleted");
    expect(hrow("2.4.3", "false alarms")).toContain("SCOPE CUT — rule deleted");
    expect(hrow("2.4.3", "detection")).toContain("1/1 · 1.00 [0.21, 1.00]");
    expect(hrow("2.4.3", "detection")).toContain("0/1 · 0.00");
    expect(hrow("2.1.2", "false alarms")).toContain("8/8 · 1.00 [0.68, 1.00]");
    expect(hrow("2.1.2", "false alarms")).toContain("0/8 · 0.00");
  });

  it("says the gap detector is in both columns, so none of the delta is a gap fix", () => {
    expect(block).toContain(
      "The gap detector sits UNCHANGED in both columns, so none of the delta below is a gap fix",
    );
    // A criterion only the gaps can flag is identical in both columns, so it is not a row here.
    expect(hrow("4.1.2", "detection")).toBe("");
  });

  it("states that 2.1.2 has no detection row to improve on, and only when that is true", () => {
    // Verified against bench/results/cd3b122/REPORT-baseline.md:40 — 2.1.2 detection is "0 pages | n/a".
    expect(block).toContain("no BAD page's report fails 2.1.2");
    // green-guard: allow — new assertion, not a weakened one. The claim is conditional by spec
    // (item 6: "drop the line if it is false"), so a truth file that DOES fail a page on 2.1.2
    // must suppress it. Without this case the line could be a hardcoded string that is never checked.
    const withTarget = renderReport(
      input(
        { "test-bad": badSummary },
        {
          badTruth: BadTruthSchema.parse({
            pages: {
              "before/home": { criteria: { "2.1.2": { result: "Fail" } } },
            },
          }),
        },
      ),
    );
    expect(withTarget).not.toContain("no BAD page's report fails 2.1.2");
  });
});

describe("evidence class", () => {
  it("names the launch these verdicts were produced in, from the recorded walk facts", () => {
    const md = renderReport(input({ "test-bad": badSummary }));
    expect(md).toContain(
      "Evidence class: every walk in these summaries ran in the headless shell (executableBasename chrome-headless-shell, 8 walks); no 2.1.2 or 3.2.1 verdict in this report has ever been observed in an activated browser.",
    );
  });

  it("refuses the headless-only claim when a walk recorded another executable", () => {
    const activated = fakeSummary("test-bad", [
      fakePage("after/home", {
        walk: {
          launch: {
            browserVersion: "143.0.7499.4",
            executableBasename: "Google Chrome for Testing",
          },
        },
      }),
    ]);
    const md = renderReport(input({ "test-bad": activated }));
    expect(md).toContain(
      "Evidence class: of 1 walk in these summaries, Google Chrome for Testing, so the headless-shell-only claim does not hold",
    );
    expect(md).not.toContain(
      "every walk in these summaries ran in the headless shell",
    );
  });
});

// Recording the gap detector's keyboard evidence is what keeps "not_focusable was never assessed" apart
// from "not_focusable was assessed and found nothing". At 118bb99 the harness ran the detector with its
// Tab walk structurally disabled and every table here read the result as a clean page.
// The brief asks for the rule of three AND notes that Wilson is two-sided while the exact one-sided
// bound is tighter (0/20: 16.1% vs 13.9%). Printing only the rule of three overstates the bound the
// data supports, so a zero cell must carry the exact bound too.
describe("a zero cell carries the exact one-sided bound, not just the rule of three", () => {
  const clean = (): Summary =>
    fakeSummary("test-bad", [fakePage("after/home", {}), fakePage("after/news", {})]);

  it("prints the exact one-sided bound beside the rule of three", () => {
    const cells = row(
      renderReport(input({ "test-bad": clean() })),
      "### False alarms",
      "4.1.2",
    )
      .split("|")
      .map((c) => c.trim());
    expect(cells[5]).toContain("rule of 3");
    expect(cells[5]).toContain("exact 1-sided");
  });

  it("states a tighter bound than the rule of three", () => {
    // n=2: rule of three gives 1.50 (nonsense above 1); the exact bound is 0.78.
    const cell = row(
      renderReport(input({ "test-bad": clean() })),
      "### False alarms",
      "4.1.2",
    );
    const exact = /exact 1-sided \u2264 ([0-9.]+)/.exec(cell);
    expect(exact).not.toBeNull();
    expect(Number(exact?.[1])).toBeLessThanOrEqual(1);
  });
});

describe("keyboard evidence: a check that could not run is not a check that passed", () => {
  const unassessed: Partial<KeyboardEvidenceSummary> = {
    unassessedReasons: ["walk-error"],
    walkError: "boom",
  };
  const twoPages = (): Summary =>
    fakeSummary("test-bad", [
      fakePage("after/home", {}),
      fakePage("after/news", { keyboard: unassessed }),
    ]);
  const faCells = (sc: string): string[] =>
    row(renderReport(input({ "test-bad": twoPages() })), "### False alarms", sc)
      .split("|")
      .map((c) => c.trim());

  it("refuses a projection whose assessed flag disagrees with its reasons", () => {
    expect(() =>
      KeyboardEvidenceSummarySchema.parse({
        walkRan: true,
        notFocusableAssessed: true,
        unassessedReasons: ["walk-error"],
        walkError: "boom",
        reachedCount: 0,
      }),
    ).toThrow();
  });

  it("names the reason beside the page's gap count instead of printing a bare zero", () => {
    const md = renderReport(
      input({
        "dev-live": fakeSummary("dev-live", [
          fakePage("walked", {}),
          fakePage("unwalked", { keyboard: unassessed }),
        ]),
      }),
    );
    const line = (id: string): string =>
      md.split("\n").find((l) => l.startsWith(`| ${id} |`)) ?? `no row ${id}`;
    expect(line("walked")).not.toContain("not assessed");
    expect(line("unwalked")).toContain("not_focusable not assessed: walk-error");
  });

  it("counts an unassessed page as undetermined for 2.1.1 in BOTH columns", () => {
    // The gap detector is the same in each column, so neither observed the page. Leaving the frozen
    // before column at "clean" would make it look more complete than the run actually was.
    const cells = faCells("2.1.1");
    expect(cells[3]).toContain("1 undetermined");
    expect(cells[5]).toContain("1 undetermined");
  });

  it("drops the rule-of-three bound on a criterion the walk left unobserved", () => {
    const cells = faCells("2.1.1");
    expect(cells[3]).not.toContain("rule of 3");
    expect(cells[5]).not.toContain("rule of 3");
  });

  it("leaves a criterion another gap type can carry fully observed", () => {
    // 4.1.2 rides on missing_from_a11y_tree and others that no walk gates, so an unassessed walk
    // takes nothing away from it. Marking it undetermined would overstate the damage.
    expect(faCells("4.1.2")[5]).not.toContain("undetermined");
  });

  it("marks a walk-gated seeded target undetermined rather than missed", () => {
    const el = (over: Partial<ElementLabel> = {}): ElementLabel => ({
      interactive: true,
      keyboardAccessible: true,
      expectedGapType: null,
      note: "n",
      ...over,
    });
    const flags = {
      keyboardTrap: false,
      trapEscapable: null,
      contextChangeOnFocus: false,
      focusLostOnArrival: false,
    };
    const variant = (op: "M3" | "M7", target: string, label: ElementLabel) => [
      `b1__${op}__${target}`,
      {
        file: `b1__${op}__${target}.html`,
        page: flags,
        elements: { [target]: label },
        base: "b1",
        operator: op,
        target,
      },
    ];
    const variantLabels = VariantLabelsFileSchema.parse({
      schemaVersion: 1,
      variants: Object.fromEntries([
        // M7 blur-on-focus: only a Tab walk can decide it, so an unassessed walk never examined it.
        variant(
          "M7",
          "t1",
          el({ keyboardAccessible: false, expectedGapType: "not_focusable" }),
        ),
        // M3 expects a gap no walk gates, so its miss on the same page is a real miss.
        variant("M3", "t2", el({ expectedGapType: "hidden_but_interactive" })),
      ]),
    });
    const grid = renderReport(
      input(
        {
          "dev-variants": fakeSummary("dev-variants", [
            fakePage("b1__M7__t1", { cluster: "b1", keyboard: unassessed }),
            fakePage("b1__M3__t2", { cluster: "b1", keyboard: unassessed }),
          ]),
        },
        { variantLabels },
      ),
    );
    const line = (op: string): string =>
      grid.split("\n").find((l) => l.startsWith(`| ${op} |`)) ?? `no ${op} row`;
    expect(line("M7")).toContain("U");
    expect(line("M7")).not.toMatch(/\| N \|/);
    expect(line("M3")).toMatch(/\| N \|/);
  });
});

describe("the footer's report-code-uncommitted check", () => {
  // A local edit to any module the report computes its cells from must mark the footer, or a report
  // built from edited mappings (GAP_WCAG_MAPPING, WALK_GATED_GAP_TYPES, ...) reads as clean.
  it("covers report.ts and every local module it imports", () => {
    const source = readFileSync(join(BENCH, "report.ts"), "utf8");
    const imported = [...source.matchAll(/from "(\.{1,2}\/[^"]+)\.js";/g)].map(
      (m) => `${m[1].replace(/^\.\//, "")}.ts`,
    );
    expect(imported.length).toBeGreaterThan(0);
    expect(REPORT_CODE).toContain("report.ts");
    expect(imported.filter((path) => !REPORT_CODE.includes(path))).toEqual([]);
  });
});
