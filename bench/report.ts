// Baseline report over the bench/run.ts summaries of one commit: the headline detection / false-alarm table on the
// W3C BAD pages (our old checker vs axe-core, per WCAG criterion), the seeded-variant regression grid, and per-page
// flag counts grouped by component for the dev and live sets. Every interval sits next to its cluster count; McNemar
// is never computed (all BAD pages are one site, so paired pages are not independent). Only full-set runs feed the
// tables; --pages subset runs are listed with a SUBSET warning.
//   npx tsx bench/report.ts <shortSha[-dirty]> [--results <dir>]   writes <results>/<sha>/REPORT-baseline.md
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  BaseLabelsFileSchema,
  GAP_TYPES,
  OPERATOR_IDS,
  VariantLabelsFileSchema,
  acceptedGapTypes,
  type BaseLabelsFile,
  type OperatorId,
  type VariantLabels,
  type VariantLabelsFile,
} from "./corpus/labels-schema.js";
import {
  GAP_WCAG_MAPPING,
  WALK_GATED_GAP_TYPES,
} from "../packages/accessibility/src/gaps/gap-detector.js";
import { ACCESSIBILITY_GAP_TYPES } from "../packages/accessibility/src/gaps/types.js";
import {
  PAGE_SETS,
  PageSetSchema,
  SUBSET_DIR_RE,
  SummarySchema,
  componentKey,
  type KeyboardEvidenceSummary,
  type PageResult,
  type PageSet,
  type Summary,
  type WalkStats,
} from "./results-schema.js";
import { exactZeroUpper, ruleOfThree, wilson } from "./stats.js";

const BENCH = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(BENCH, "..");

export const HEADLINE_CRITERIA = [
  "2.1.1",
  "2.1.2",
  "2.4.3",
  "2.4.7",
  "3.2.1",
  "4.1.2",
] as const;

// Page-level results of bench/corpus/test/bad-labels.json; only `result` is read ("Fail" / "Pass").
export const BadTruthSchema = z
  .object({
    pages: z.record(
      z.string(),
      z
        .object({
          criteria: z.record(
            z.string(),
            z.object({ result: z.string() }).passthrough(),
          ),
        })
        .passthrough(),
    ),
  })
  .passthrough();
export type BadTruth = z.infer<typeof BadTruthSchema>;

// A --pages run, by the directory it was read from.
export type SubsetRun = { dir: string; summary: Summary };

export type ReportInput = {
  sha: string;
  // Read from <sha>/<set>/. One with a pageFilter (written there by an older harness) is treated as a subset.
  summaries: Partial<Record<PageSet, Summary>>;
  // Read from <sha>/<set>--subset-<hash>/: warned about, never scored.
  subsets: SubsetRun[];
  badTruth: BadTruth | null;
  variantLabels: VariantLabelsFile | null;
  baseLabels: BaseLabelsFile | null;
  // sha256 of each input file now (null = missing), to flag drift since the run; paths not listed are not checked.
  currentInputs: Record<string, string | null>;
};

// Success-criterion tags only: wcag412 -> 4.1.2, wcag1411 -> 1.4.11. Level/version tags (wcag2a, wcag21aa) -> null.
export function criterionFromAxeTag(tag: string): string | null {
  const m = /^wcag(\d)(\d)(\d{1,2})$/.exec(tag);
  return m === null ? null : `${m[1]}.${m[2]}.${m[3]}`;
}

function addTo(
  map: Map<string, Set<string>>,
  criterion: string,
  evidence: string,
): void {
  const set = map.get(criterion) ?? new Set<string>();
  set.add(evidence);
  map.set(criterion, set);
}

// Our old checker's criteria on a page -> what flagged them. Gap criteria are each gap's wcag list, which the
// detector fills from GAP_WCAG_MAPPING (packages/accessibility/src/gaps/gap-detector.ts).
// The old agent latched trapDetected on the first checkTrap that fired (packages/agent/src/agent.ts:91-92
// at d9e2cb5, the commit legacy-detectors.ts freezes; the latch is gone from the current agent), and the
// walk replay checks after every press, so "ever trapped" is the old checker's page verdict.
export function legacyTrapFlagged(trap: {
  firstTrappedPress: number | null;
}): boolean {
  return trap.firstTrappedPress !== null;
}

function gapCriteria(page: PageResult): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const gap of page.tools.gaps.findings?.gaps ?? []) {
    for (const criterion of gap.wcag)
      addTo(out, criterion, `gap:${gap.gapType}`);
  }
  return out;
}

export function ourCriteria(page: PageResult): Map<string, Set<string>> {
  const out = gapCriteria(page);
  const legacy = page.tools.legacy.findings;
  if (legacy && legacyTrapFlagged(legacy.trap))
    addTo(out, "2.1.2", "legacy-trap");
  for (const v of legacy?.dynamicViolations ?? [])
    addTo(out, v.criterion, `legacy-dynamic:${v.criterion}`);
  return out;
}

// The AFTER column: the SAME gap detector plus the two walk judges. The gap component is shared
// with ourCriteria above and is byte-for-byte the same criteria — a reader comparing the columns
// would otherwise read the gap fixes into this delta, and they are not in it (they were measured
// separately against cd3b122). Nothing here can emit 2.4.3: the focus-order rule is deleted, not
// replaced (bench/COVERAGE.md).
export function currentCriteria(page: PageResult): Map<string, Set<string>> {
  const out = gapCriteria(page);
  const walk = page.tools.walk.findings;
  if (walk === null) return out;
  if (walk.trap.verdict === "fail") addTo(out, "2.1.2", "judge-trap");
  if (walk.contextChange.verdict === "fail")
    addTo(out, "3.2.1", "judge-context-change");
  return out;
}

// An evaluable page whose judge declined to decide this criterion. It stays in the denominator and
// is never counted as flagged, so refusing to judge can never buy DETECTION. On the false-alarm
// table a refusal scores like a clean pass, so score() prints the worst case beside it.
export function currentUndetermined(
  page: PageResult,
  criterion: string,
): boolean {
  const walk = page.tools.walk.findings;
  if (walk === null) return false;
  if (criterion === "2.1.2") return walk.trap.verdict === "undetermined";
  if (criterion === "3.2.1")
    return walk.contextChange.verdict === "undetermined";
  return false;
}

const isWalkGated = (gapType: string): boolean =>
  (WALK_GATED_GAP_TYPES as readonly string[]).includes(gapType);

// The criteria a missing walk leaves UNOBSERVED: those every carrying gap type is walk-gated. A criterion
// some other gap type also carries was still observed, so marking it undetermined would overstate the
// damage. Today it is 2.1.1 and 2.4.7.
// It scans the DETECTOR's own gap-type list, not bench/corpus's mirror of it: a new gap type added
// beside GAP_WCAG_MAPPING but not yet mirrored here would otherwise be skipped, and a criterion that
// type also carries would keep being called unobserved when the detector could still emit it.
const WALK_GATED_CRITERIA = new Set(
  WALK_GATED_GAP_TYPES.flatMap((t) => GAP_WCAG_MAPPING[t]).filter((criterion) =>
    ACCESSIBILITY_GAP_TYPES.filter((t) =>
      GAP_WCAG_MAPPING[t].includes(criterion),
    ).every(isWalkGated),
  ),
);

// A page whose Tab walk never assessed not_focusable did not OBSERVE 2.1.1 or 2.4.7: the flag that carries
// them could not be emitted at all. Counting that page as a clean pass is exactly how a check that could
// not run scores like a check that ran and found nothing -- the failure shipped at 118bb99. It belongs to
// BOTH columns: the gap detector is the same in each, so neither column observed the page.
export function gapUndetermined(page: PageResult, criterion: string): boolean {
  const gaps = page.tools.gaps.findings;
  if (gaps === null) return false;
  return (
    WALK_GATED_CRITERIA.has(criterion) && !gaps.keyboard.notFocusableAssessed
  );
}

// The seeded target's own gap types decide whether the walk gates its cell. Gated only when EVERY gap type
// that could have flagged this target is walk-gated -- if any other type could have, the detector did look.
function walkGatedTarget(
  v: Pick<VariantLabels, "target" | "elements">,
): boolean {
  const label = v.elements[v.target];
  if (label === undefined) return false;
  const types = [
    ...(label.expectedGapType === null ? [] : [label.expectedGapType]),
    ...(label.acceptableGapTypes ?? []),
  ];
  return types.length > 0 && types.every(isWalkGated);
}

// Why not_focusable could not be assessed, printed beside the page's gap count so a zero there is never
// read as a clean page.
function keyboardCell(keyboard: KeyboardEvidenceSummary): string {
  if (keyboard.notFocusableAssessed) return "";
  const why = keyboard.unassessedReasons.join(", ") || "reason not recorded";
  return ` (not_focusable not assessed: ${why})`;
}

export function axeCriteria(page: PageResult): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const v of page.tools.axe.findings ?? []) {
    for (const tag of v.wcagTags) {
      const criterion = criterionFromAxeTag(tag);
      if (criterion !== null) addTo(out, criterion, v.id);
    }
  }
  return out;
}

const oursRan = (p: PageResult): boolean =>
  p.tools.gaps.findings !== null && p.tools.legacy.findings !== null;
const currentRan = (p: PageResult): boolean =>
  p.tools.gaps.findings !== null && p.tools.walk.findings !== null;
const axeRan = (p: PageResult): boolean => p.tools.axe.findings !== null;

// A legacy replay of a walk that stopped early (run.ts records it "partial") never saw the presses after
// the cut, so a trap that had not fired by then was not observed -- the 2.1.2 judge calls the same walk
// short-walk. A trap the replay did see still counts.
function legacyTrapUndetermined(page: PageResult): boolean {
  const legacy = page.tools.legacy;
  return (
    legacy.status === "partial" &&
    legacy.findings !== null &&
    !legacyTrapFlagged(legacy.findings.trap)
  );
}

// One scored column of the headline tables. `undetermined` = the column ran but did not observe the
// criterion on this page: it stays in the denominator and counts as a miss.
type Column = {
  ran: (p: PageResult) => boolean;
  criteria: (p: PageResult) => Map<string, Set<string>>;
  undetermined: (p: PageResult, criterion: string) => boolean;
};
const never = (): boolean => false;
// Both columns inherit gapUndetermined: the frozen legacy detectors never emit 2.1.1 or 2.4.7 either, so
// an unassessed walk leaves those criteria unobserved on the before side exactly as it does on the after
// side. Keeping it out of BEFORE would make the frozen column look more complete than it was.
const BEFORE: Column = {
  ran: oursRan,
  criteria: ourCriteria,
  undetermined: (p, criterion) =>
    (criterion === "2.1.2" && legacyTrapUndetermined(p)) ||
    gapUndetermined(p, criterion),
};
const AFTER: Column = {
  ran: currentRan,
  criteria: currentCriteria,
  undetermined: (p, criterion) =>
    currentUndetermined(p, criterion) || gapUndetermined(p, criterion),
};
const AXE: Column = { ran: axeRan, criteria: axeCriteria, undetermined: never };

const f2 = (x: number): string => x.toFixed(2);
const plural = (n: number, word: string): string =>
  `${n} ${word}${n === 1 ? "" : "s"}`;
const clusterCount = (pages: readonly PageResult[]): number =>
  new Set(pages.map((p) => p.cluster)).size;

// x/n · p̂ [Wilson 95%]; a zero count on clean pages also gets the rule-of-three upper bound.
function rateCell(
  x: number,
  n: number,
  withRuleOfThree: boolean,
  undetermined: number,
): string {
  if (n === 0) return "n/a";
  const w = wilson(x, n);
  const cell = `${x}/${n} · ${f2(w.p)} [${f2(w.lower)}, ${f2(w.upper)}]`;
  // The rule of three reads "n observations, zero events". With u refusals only n-u pages were
  // actually observed, so the bound would describe a sample that was never taken.
  // Three bounds that answer different questions and do NOT agree: the Wilson upper above is
  // two-sided and approximate, the rule of three is an approximation of a one-sided bound
  // (-ln(0.05) rounded to 3), and exactZeroUpper is the exact one-sided Clopper-Pearson bound with
  // guaranteed coverage. Exact is not always the smallest: at n=20 it is 13.9% against Wilson's
  // 16.1%, but at n=4 it is 52.7% against 49.0%, because a two-sided approximation is
  // anti-conservative on tiny samples. The exact one is the DEFENSIBLE one-sided claim; picking
  // whichever number is smallest per row would be choosing the bound by its answer.
  return withRuleOfThree && x === 0 && undetermined === 0
    ? `${cell} · rule of 3 ≤ ${f2(ruleOfThree(n))} · exact 1-sided ≤ ${f2(exactZeroUpper(n))}`
    : cell;
}

function tally(labels: Iterable<string>): string {
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  const sorted = [...counts].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
  );
  return sorted.map(([l, n]) => `${l} ×${n}`).join(", ") || "—";
}

type Scored = { cell: string; evidence: string };

function score(
  pages: readonly PageResult[],
  column: Column,
  criterion: string,
  withRuleOfThree: boolean,
): Scored {
  const evaluable = pages.filter(column.ran);
  const flagged = evaluable.filter((p) => column.criteria(p).has(criterion));
  const excluded = pages.length - evaluable.length;
  // Two different things, printed differently: "undetermined" ran and would not decide (it is in the
  // denominator and scored as a miss); "excluded" means the tool never ran at all.
  const undetermined = evaluable.filter((p) =>
    column.undetermined(p, criterion),
  ).length;
  const rate = rateCell(
    flagged.length,
    evaluable.length,
    withRuleOfThree,
    undetermined,
  );
  // Asymmetry worth stating plainly: on a page that SHOULD be flagged, an undetermined verdict
  // scores as a miss and costs detection. On a CLEAN page it scores exactly like a correct pass,
  // so on the false-alarm table -- and only there -- refusing to judge does lower the rate. The
  // worst case (every refusal was in fact a false alarm) is printed so that exposure is visible
  // instead of implied.
  const worstCase =
    withRuleOfThree && undetermined > 0
      ? ` (worst case ${flagged.length + undetermined}/${evaluable.length} · ${f2(wilson(flagged.length + undetermined, evaluable.length).p)})`
      : "";
  const cell =
    undetermined > 0
      ? `${rate} · ${undetermined} undetermined${worstCase}`
      : rate;
  return {
    cell: excluded > 0 ? `${cell} (${excluded} excluded: tool error)` : cell,
    evidence: tally(
      flagged.flatMap((p) => [...(column.criteria(p).get(criterion) ?? [])]),
    ),
  };
}

function truthResult(
  truth: BadTruth,
  pageId: string,
  criterion: string,
): string | null {
  return truth.pages[pageId]?.criteria[criterion]?.result ?? null;
}

function renderTestBad(summary: Summary, truth: BadTruth | null): string[] {
  const out = ["## test-bad — W3C BAD demo pages (headline)", ""];
  if (truth === null)
    return [
      ...out,
      "bench/corpus/test/bad-labels.json is missing; nothing can be scored.",
      "",
    ];
  if (summary.pages.length === 0)
    return [...out, "No pages recorded in this run.", ""];
  const unlabelled = summary.pages
    .filter((p) => truth.pages[p.pageId] === undefined)
    .map((p) => p.pageId);
  const clusters = clusterCount(summary.pages);
  out.push(
    `Truth: page-level results in bench/corpus/test/bad-labels.json (two independent readers of the W3C evaluation reports). ${plural(summary.pages.length, "page")} from ${plural(clusters, "cluster")}: the Wilson intervals treat pages as independent, which pages of one site are not, so they are too narrow.`,
    "",
    "Before is frozen ONLY on 2.1.2, 2.4.3 and 3.2.1. Its other criteria (1.1.1, 2.1.1, 2.4.7, 4.1.2) come from the CURRENT post-fix gap detector and are identical in the after column, so no part of the before/after delta is a gap fix. Before = current gap detector (criteria from each gap's wcag list, i.e. GAP_WCAG_MAPPING) + legacy trap detector (2.1.2) + legacy DynamicEvaluator (by criterion), replayed over THIS run's walk (bench/legacy.ts). After = the same gap detector + the 2.1.2 and 3.2.1 judges reading the same walk. axe = violations through their wcagNNN tags.",
    "",
    "Cells: flagged/pages · rate [Wilson 95%]; a zero false-alarm count adds two 95% upper bounds: the rule of three (3/pages, an approximation) and the exact one-sided Clopper-Pearson bound, which is tighter and is the strongest claim a zero count supports (the Wilson interval beside it is TWO-sided; at 0/20 these are 16.1%, 15.0% and 13.9%). `· N undetermined` counts evaluable pages the judge refused to decide: they stay in the denominator and score as misses, so refusing to judge can never buy detection. On a clean page a refusal scores like a correct pass, so the false-alarm cell also prints `(worst case ...)`, the rate if every refusal had been a false alarm, and drops the rule-of-three bound (which assumes every page was observed). See bench/COVERAGE.md. `(N excluded: tool error)` is a different thing — the tool never ran on those pages at all.",
    "",
    "Each page counts once per criterion: a detection target where its report fails the criterion, a clean page where its report passes it. The page counts (`4 before, 4 after`) are the W3C BAD site's OWN before/after demo pages — not the two checker columns.",
    "",
  );
  if (unlabelled.length > 0)
    out.push(`Not in the truth file (ignored): ${unlabelled.join(", ")}.`, "");

  const table = (result: "Fail" | "Pass"): string[] => {
    const rows = HEADLINE_CRITERIA.map((c) => {
      const pages = summary.pages.filter(
        (p) => truthResult(truth, p.pageId, c) === result,
      );
      const clean = result === "Pass";
      const before = score(pages, BEFORE, c, clean);
      const after = score(pages, AFTER, c, clean);
      const axe = score(pages, AXE, c, clean);
      const sides = (["before", "after"] as const)
        .map(
          (side) =>
            `${pages.filter((p) => p.pageId.startsWith(`${side}/`)).length} ${side}`,
        )
        .join(", ");
      const size =
        pages.length === 0
          ? "0 pages"
          : `${plural(pages.length, "page")} (${sides}) / ${plural(clusterCount(pages), "cluster")}`;
      return `| ${c} | ${size} | ${before.cell} | ${before.evidence} | ${after.cell} | ${after.evidence} | ${axe.cell} | ${axe.evidence} |`;
    });
    return [
      `| SC | report says ${result} | before flagged | before: flagged by (pages) | after flagged | after: flagged by (pages) | axe flagged | axe: rules (pages) |`,
      "|---|---|---|---|---|---|---|---|",
      ...rows,
    ];
  };
  // 2.4.3 is scored at zero rather than dropped: deleting the row would hide what the cut cost.
  const cutNote =
    "2.4.3 has no after-column detector: the focus-order rule was deleted rather than repaired, and nothing replaces it (bench/COVERAGE.md). Its row stays, scored at zero, so the cost of the cut stays visible.";
  out.push(
    "### Detection: pages whose report fails the criterion — flagged?",
    "",
    ...table("Fail"),
    "",
    cutNote,
    "",
  );
  out.push(
    "### False alarms: pages whose report passes the criterion (clean for it) — flagged?",
    "",
    ...table("Pass"),
    "",
  );

  out.push(
    "#### Per page (F/P = report fails/passes the criterion; O = the before column flags it, C = the after column flags it, U = that column did not observe it (undetermined, scored as a miss), A = axe flags it, – = not flagged, E = tool error)",
    "",
    `| page | ${HEADLINE_CRITERIA.join(" | ")} |`,
    `|---|${HEADLINE_CRITERIA.map(() => "---").join("|")}|`,
  );
  for (const p of summary.pages) {
    const ours = ourCriteria(p);
    const current = currentCriteria(p);
    const axe = axeCriteria(p);
    const cells = HEADLINE_CRITERIA.map((c) => {
      const t = truthResult(truth, p.pageId, c);
      // "–" means the column looked and did not flag. A criterion the walk never assessed was not
      // looked at, so it prints "U" here exactly as it scores in the aggregate tables -- otherwise
      // this grid would show a clean dash for a page the totals above count as undetermined.
      const o = !oursRan(p)
        ? "E"
        : ours.has(c)
          ? "O"
          : BEFORE.undetermined(p, c)
            ? "U"
            : "–";
      const n = !currentRan(p)
        ? "E"
        : current.has(c)
          ? "C"
          : currentUndetermined(p, c) || gapUndetermined(p, c)
            ? "U"
            : "–";
      const a = !axeRan(p) ? "E" : axe.has(c) ? "A" : "–";
      return `${t === "Fail" ? "F" : t === "Pass" ? "P" : "?"} ${o}${n}${a}`;
    });
    out.push(`| ${p.pageId} | ${cells.join(" | ")} |`);
  }
  out.push("");
  return out;
}

// The criteria the two columns can differ on at all. Everything else in HEADLINE_CRITERIA comes from
// the shared gap detector, so printing it here would be the same number twice.
const DELTA_CRITERIA: Record<string, string> = {
  "2.1.2": "the keyboard-trap judge replaces the periodicity rule",
  "2.4.3": "SCOPE CUT — rule deleted",
  "3.2.1":
    "the context-change judge replaces the DynamicEvaluator's 3.2.1 — whose before column is 0 BY CONSTRUCTION, not by measurement: it could only fire after a 'navigate' event, which a scripted Tab walk never produces (bench/legacy.ts)",
};

// The headline decomposed per criterion, so a scope cut cannot be read as a fix. Both columns come
// from ONE run: the before column replays the frozen detectors over the SAME walk the judges read.
function renderHeadlineDelta(
  summary: Summary,
  truth: BadTruth | null,
): string[] {
  if (truth === null || summary.pages.length === 0) return [];
  const gapOnly = HEADLINE_CRITERIA.filter(
    (c) => DELTA_CRITERIA[c] === undefined,
  );
  const out = [
    "## Headline: before → after",
    "",
    "One run, one set of pages, one browser session: the before column replays the frozen pre-fix detectors (bench/legacy-detectors.ts) over the same walk the judges read, so neither column can move because a live page changed between runs. The two columns read the same walk but not the same facts: the walk now records an idle baseline, an end-of-walk focusable count and a corrected focusLost that only the judges consume. That IS the fix — the old rule is scored on the signal it was written for, the new rule on the signal the walk now records — but it means this before column is not byte-comparable to the one published at cd3b122.",
    "",
    `The gap detector sits UNCHANGED in both columns, so none of the delta below is a gap fix; those were measured separately against cd3b122. ${gapOnly.join(", ")} come from the gaps alone and are identical in both columns, so they are not repeated here.`,
    "",
  ];
  const tables = [
    { label: "detection", result: "Fail" as const },
    { label: "false alarms", result: "Pass" as const },
  ];
  const failing2_1_2 = summary.pages.filter(
    (p) => truthResult(truth, p.pageId, "2.1.2") === "Fail",
  ).length;
  if (failing2_1_2 === 0) {
    out.push(
      "2.1.2 has no detection row to improve on: no BAD page's report fails 2.1.2, so its detection cell is n/a in both columns and the whole 2.1.2 delta is false alarms.",
      "",
    );
  }
  out.push(
    "| criterion | table | before (frozen legacy + gaps) | after (judges + gaps) | source of the change |",
    "|---|---|---|---|---|",
  );
  for (const [criterion, source] of Object.entries(DELTA_CRITERIA)) {
    for (const { label, result } of tables) {
      const pages = summary.pages.filter(
        (p) => truthResult(truth, p.pageId, criterion) === result,
      );
      const clean = result === "Pass";
      const before = score(pages, BEFORE, criterion, clean);
      const after = score(pages, AFTER, criterion, clean);
      out.push(
        `| ${criterion} | ${label} | ${before.cell} | ${after.cell} | ${source} |`,
      );
    }
  }
  out.push("");
  return out;
}

type Cell = "Y" | "N" | "E" | "U";

// Operators scored by a page-level verdict rather than a gap on the target: 2.1.2 for the traps, 3.2.1 for M6's
// navigation and for M8/M9, which exist to show the 3.2.1 judge's two timing fixes. M7 plants the same focus drop
// but is scored on its target's not_focusable gap. Every other operator reads the shared gap detector.
const TRAP_OPERATORS: readonly OperatorId[] = ["M5", "M10", "M11", "M12"];
const CONTEXT_OPERATORS: readonly OperatorId[] = ["M6", "M8", "M9"];
// A decoy's target is labelled with no gap, so a Y on it is a false alarm.
const DECOY_OPERATORS: readonly OperatorId[] = ["M13"];
const GAP_TARGET_OPERATORS = OPERATOR_IDS.filter(
  (op) => !TRAP_OPERATORS.includes(op) && !CONTEXT_OPERATORS.includes(op),
);

// Did the checker flag the seeded target? The trap and context operators read a different detector per
// column: before = the frozen legacy trap / legacy 3.2.1, after = the judges' verdicts. The gap-target
// operators read the gap detector, which is shared, so their cell is the same in both columns by
// construction.
function flaggedTarget(
  page: PageResult,
  v: Pick<VariantLabels, "operator" | "target" | "elements">,
  column: "before" | "after",
): Cell {
  const trap = TRAP_OPERATORS.includes(v.operator);
  if (trap || CONTEXT_OPERATORS.includes(v.operator)) {
    if (column === "after") {
      const walk = page.tools.walk.findings;
      if (walk === null) return "E";
      const verdict = trap ? walk.trap.verdict : walk.contextChange.verdict;
      return verdict === "fail" ? "Y" : verdict === "undetermined" ? "U" : "N";
    }
    const legacy = page.tools.legacy.findings;
    if (legacy === null) return "E";
    const hit = trap
      ? legacyTrapFlagged(legacy.trap)
      : legacy.dynamicViolations.some((d) => d.criterion === "3.2.1");
    if (hit) return "Y";
    return trap && legacyTrapUndetermined(page) ? "U" : "N";
  }
  const gaps = page.tools.gaps.findings;
  if (gaps === null) return "E";
  if (gaps.gaps.some((g) => g.dataBenchId === v.target)) return "Y";
  // A miss is only a miss if the check could run. not_focusable is the one gap type a Tab walk gates
  // (gaps/gap-detector.ts), so when the walk did not assess it, a target whose expected gap is
  // not_focusable was never examined -- "U", which is already scored as a miss, not "N", which claims
  // the detector looked. Targets expecting any other gap type were examined and keep their "N".
  return walkGatedTarget(v) && !gaps.keyboard.notFocusableAssessed ? "U" : "N";
}

function renderDevVariants(
  summary: Summary,
  labels: VariantLabelsFile | null,
  fixtures: Summary | undefined,
): string[] {
  const out = [
    "## dev-variants — seeded defects (regression only — not a headline number)",
    "",
  ];
  if (labels === null)
    return [
      ...out,
      "bench/corpus/dev/variants/labels.json is missing; run npx tsx bench/seed.ts.",
      "",
    ];
  const rows = summary.pages.flatMap((page) => {
    const label = labels.variants[page.pageId];
    return label === undefined ? [] : [{ page, label }];
  });
  const unlabelled = summary.pages
    .filter((p) => labels.variants[p.pageId] === undefined)
    .map((p) => p.pageId);
  if (unlabelled.length > 0)
    out.push(`Not in the labels file (ignored): ${unlabelled.join(", ")}.`, "");
  if (rows.length === 0)
    return [...out, "No labelled variant pages recorded in this run.", ""];
  const bases = [...new Set(rows.map((r) => r.label.base))].sort();
  const operators = OPERATOR_IDS.filter((op) =>
    rows.some((r) => r.label.operator === op),
  );
  const gapOps = GAP_TARGET_OPERATORS.join(", ");
  out.push(
    `Flagged = a gap on the target's data-bench-id (${gapOps}), the 2.1.2 verdict (${TRAP_OPERATORS.join(", ")}), the 3.2.1 verdict (${CONTEXT_OPERATORS.join(", ")}). Y flagged · N missed · U undetermined (counted as a miss) · E tool error · · no variant. † the unmodified base page (dev-fixtures, same commit) already carries the same flag, so that Y is not evidence the seeded change was seen. ${DECOY_OPERATORS.join(", ")} is a decoy whose target is labelled with no gap: a Y in its row is a false alarm, and its per-operator count below is a false-alarm count.`,
    "",
    `A cell that changed between the columns prints before→after; an unchanged cell prints once. ${gapOps} read the shared gap detector, so they can never change.`,
    "",
    `| operator | ${bases.join(" | ")} |`,
    `|---|${bases.map(() => "---").join("|")}|`,
  );
  for (const op of operators) {
    const cells = bases.map((base) => {
      const hits = rows.filter(
        (r) => r.label.operator === op && r.label.base === base,
      );
      if (hits.length === 0) return "·";
      return hits
        .map(({ page, label }) => {
          const basePage = fixtures?.pages.find((p) => p.pageId === base);
          const mark = (column: "before" | "after"): string => {
            const cell = flaggedTarget(page, label, column);
            const dagger =
              cell === "Y" &&
              basePage !== undefined &&
              flaggedTarget(basePage, label, column) === "Y"
                ? "†"
                : "";
            return `${cell}${dagger}`;
          };
          const [before, after] = [mark("before"), mark("after")];
          return before === after ? before : `${before}→${after}`;
        })
        .join(" ");
    });
    out.push(`| ${op} | ${cells.join(" | ")} |`);
  }
  out.push("");
  const perOp = operators.map((op) => {
    const mine = rows.filter((r) => r.label.operator === op);
    const hits = (column: "before" | "after"): number =>
      mine.filter((r) => flaggedTarget(r.page, r.label, column) === "Y").length;
    return `${op} ${hits("before")}/${mine.length} → ${hits("after")}/${mine.length}`;
  });
  out.push(`Flagged per operator (before → after): ${perOp.join(" · ")}.`, "");
  if (fixtures === undefined)
    out.push(
      "No dev-fixtures summary at this commit, so † could not be checked.",
      "",
    );

  out.push(
    "#### Gap type on the seeded target",
    "",
    "Rows: labelled gap type. Columns: targets whose element got a gap of that type (an element can get several); acceptable = at least one reported type is in acceptableGapTypes.",
    "",
    `| expected | targets | ${GAP_TYPES.join(" | ")} | (no gap) | acceptable |`,
    `|---|---|${GAP_TYPES.map(() => "---").join("|")}|---|---|`,
  );
  for (const expected of GAP_TYPES) {
    const labelled = rows.filter(
      (r) => r.label.elements[r.label.target]?.expectedGapType === expected,
    );
    if (labelled.length === 0) continue;
    // A gaps-tool error has no gap to read; the per-operator line above still counts it as a miss.
    const targets = labelled.filter((r) => r.page.tools.gaps.findings !== null);
    const excluded = labelled.length - targets.length;
    const reported = targets.map(
      (r) =>
        new Set(
          (r.page.tools.gaps.findings?.gaps ?? [])
            .filter((g) => g.dataBenchId === r.label.target)
            .map((g) => g.gapType),
        ),
    );
    const accepted = targets.filter((r, i) => {
      const label = r.label.elements[r.label.target];
      return (
        label !== undefined &&
        acceptedGapTypes(label).some((t) => reported[i].has(t))
      );
    }).length;
    const byType = GAP_TYPES.map(
      (t) => reported.filter((s) => s.has(t)).length,
    );
    const none = reported.filter((s) => s.size === 0).length;
    out.push(
      `| ${expected} | ${targets.length}${excluded > 0 ? ` (${excluded} excluded: tool error)` : ""} | ${byType.join(" | ")} | ${none} | ${accepted}/${targets.length} |`,
    );
  }
  out.push("");
  return out;
}

function componentTallies(page: PageResult): {
  gaps: string;
  axe: string;
  gapComponents: number;
  axeComponents: number;
} {
  const gapKeys = (page.tools.gaps.findings?.gaps ?? []).map((g) =>
    componentKey(g.nodeName, g.class),
  );
  const axeKeys = (page.tools.axe.findings ?? []).flatMap((v) => v.components);
  return {
    gaps: tally(gapKeys),
    axe: tally(axeKeys),
    gapComponents: new Set(gapKeys).size,
    axeComponents: new Set(axeKeys).size,
  };
}

// The 2.1.2 judge's verdict. Confinement and a violation are NOT the same cell: a correct modal
// confines focus and releases it on Escape, and printing that as a trap would be a false positive in
// this grid. Four marks, documented in WALK_TRAP_LEGEND below.
function walkTrapCell(w: WalkStats): string {
  const trap = w.trap;
  if (trap.verdict === "undetermined")
    return `undetermined (${trap.reason ?? "reason not recorded"})`;
  if (trap.verdict === "fail") {
    const stuck = trap.directions.find((d) => d.stuckOn !== null)?.stuckOn;
    const where =
      stuck === undefined || stuck === null
        ? ""
        : ` (stuck on ${stuck.tag}${stuck.id === null ? "" : `#${stuck.id}`})`;
    return `TRAP inescapable${where}`;
  }
  if (!trap.keyboardTrap) return "—";
  const release = trap.directions.find(
    (d) => d.confined && d.release !== "none" && d.release !== "not-probed",
  )?.release;
  return `confined, escapable${release === undefined ? "" : ` via ${release}`}`;
}

const WALK_TRAP_LEGEND =
  'walk trap = the 2.1.2 judge: — no confinement · "confined, escapable" a correct modal, NOT a violation · "TRAP inescapable" the criterion fails · "undetermined (<reason>)" not judged: a miss on a detection count, and scored like a clean pass on a false-alarm count, with the worst case printed beside it.';

function trapLabel(labels: BaseLabelsFile | null, pageId: string): string {
  const page = labels?.pages[pageId]?.page;
  if (page === undefined) return "?";
  if (!page.keyboardTrap) return "no trap";
  return page.trapEscapable ? "escapable trap" : "inescapable trap";
}

function renderFlagTable(
  summary: Summary,
  opts: { baseLabels: BaseLabelsFile | null; live: boolean },
): string[] {
  const head = [
    "page",
    "walk: F / wraps",
    "gaps: flags / components",
    "legacy trap",
    "walk trap",
    ...(opts.baseLabels === null ? [] : ["labelled"]),
    "legacy dynamic",
    "axe: nodes / components",
    ...(opts.live ? ["load"] : []),
    "tool errors",
  ];
  const out = [
    `| ${head.join(" | ")} |`,
    `|${head.map(() => "---").join("|")}|`,
  ];
  const details: string[] = [];
  for (const p of summary.pages) {
    const t = componentTallies(p);
    const { gaps, legacy, axe, walk } = p.tools;
    const trap = legacy.findings?.trap;
    const errors = Object.entries(p.tools)
      .filter(([, run]) => run.status !== "ok")
      .map(([tool, run]) => `${tool} ${run.status}: ${run.error}`);
    const load = walk.load ?? gaps.load ?? axe.load;
    const cells = [
      p.pageId,
      walk.findings === null
        ? "E"
        : `${walk.findings.fIncomplete ? "≥" : ""}${walk.findings.F} / ${walk.findings.wraps}${walk.findings.presses < walk.findings.plannedPresses ? ` (${walk.findings.presses}/${walk.findings.plannedPresses} stops)` : ""}`,
      gaps.findings === null
        ? "E"
        : `${gaps.findings.gaps.length} / ${t.gapComponents}${keyboardCell(gaps.findings.keyboard)}`,
      trap === undefined
        ? "E"
        : legacyTrapFlagged(trap)
          ? `Y @${trap.firstTrappedPress}${trap.trapped ? ` (cycle ${trap.cycleLength})` : " (clear at end)"}`
          : "N",
      walk.findings === null ? "E" : walkTrapCell(walk.findings),
      ...(opts.baseLabels === null
        ? []
        : [trapLabel(opts.baseLabels, p.pageId)]),
      legacy.findings === null
        ? "E"
        : legacy.findings.dynamicViolations
            .map((v) => v.criterion)
            .join(", ") || "—",
      axe.findings === null
        ? "E"
        : `${axe.findings.reduce((n, v) => n + v.targets.length, 0)} / ${t.axeComponents}`,
      ...(opts.live
        ? [
            load === null
              ? "—"
              : `${load.status ?? "?"}${load.title === "" ? ", empty title" : ""}${load.secondNavigation === "not-expected" ? "" : `, 2nd nav ${load.secondNavigation}`}`,
          ]
        : []),
      errors.join("; ").replaceAll("|", "/") || "—",
    ];
    out.push(`| ${cells.join(" | ")} |`);
    details.push(`- **${p.pageId}** — gaps: ${t.gaps} · axe: ${t.axe}`);
  }
  const lowerBound = summary.pages.some(
    (p) => p.tools.walk.findings?.fIncomplete,
  )
    ? "≥F: a cross-origin frame or closed shadow root may hide Tab stops, so F is a lower bound. "
    : "";
  return [
    ...out,
    "",
    WALK_TRAP_LEGEND,
    "",
    `${lowerBound}Components (NODENAME + sorted class set, ×copies). Many copies of one component are one defect repeated, not independent findings.`,
    "",
    ...details,
    "",
  ];
}

// What class of evidence the 2.1.2 / 3.2.1 verdicts are, read off the launch facts each walk
// recorded for itself — never asserted from the harness's own config.
function evidenceClass(summaries: readonly Summary[]): string {
  const walks = summaries.flatMap((s) =>
    s.pages.flatMap((p) => {
      const launch = p.tools.walk.findings?.launch;
      return launch === undefined ? [] : [launch.executableBasename];
    }),
  );
  if (walks.length === 0)
    return "Evidence class: no walk recorded its launch facts in these summaries, so nothing can be said about where these verdicts were produced.";
  const named = [
    ...new Set(walks.filter((b): b is string => b !== null)),
  ].sort();
  const headlessOnly =
    walks.every((b) => b !== null) &&
    named.every((b) => b.includes("headless-shell"));
  if (!headlessOnly) {
    const unrecorded = walks.filter((b) => b === null).length;
    const where =
      named.length === 0
        ? "no recorded executable"
        : `${named.join(", ")}${unrecorded > 0 ? `, plus ${plural(unrecorded, "walk")} with no recorded executable` : ""}`;
    return `Evidence class: of ${plural(walks.length, "walk")} in these summaries, ${where}, so the headless-shell-only claim does not hold for this report.`;
  }
  return `Evidence class: every walk in these summaries ran in the headless shell (executableBasename ${named.join(", ")}, ${plural(walks.length, "walk")}); no 2.1.2 or 3.2.1 verdict in this report has ever been observed in an activated browser.`;
}

function renderHeader(
  input: ReportInput,
  full: Partial<Record<PageSet, Summary>>,
  subsets: readonly SubsetRun[],
): string[] {
  const summaries = PAGE_SETS.map((s) => full[s]).filter(
    (s): s is Summary => s !== undefined,
  );
  const out = [
    `# Baseline report — ${input.sha}`,
    "",
    "Two columns over one run. BEFORE is the old checker ONLY where the two can differ (2.1.2, 2.4.3, 3.2.1): the legacy KeyboardTrapDetector and DynamicEvaluator replayed over this run's scripted Tab walk. Its remaining criteria come from the current post-fix gap detector and are identical in both columns. AFTER = the same gap detector plus the 2.1.2 and 3.2.1 judges reading that same walk. axe-core alongside for comparison. Regenerate with `npx tsx bench/report.ts " +
      input.sha +
      "`.",
    "",
  ];
  const dirty = summaries.filter((s) => s.git.dirty);
  if (dirty.length > 0) {
    const paths = Math.max(...dirty.map((s) => s.git.dirtyPaths.length));
    out.push(
      `> **DIRTY**: ${dirty.map((s) => s.set).join(", ")} ran with uncommitted changes (up to ${paths} paths), so no commit reproduces them. Re-run on a clean commit before quoting any number.`,
      "",
    );
  }
  for (const { dir, summary } of subsets) {
    out.push(
      `> **SUBSET**: ${dir} ran only ${plural(summary.pages.length, "page")} of ${summary.set} (--pages ${(summary.config.pageFilter ?? []).join(",")}${summary.git.dirty ? ", dirty" : ""}); it is left out of every table below.`,
      "",
    );
  }
  for (const s of summaries.filter((x) => !x.complete)) {
    out.push(
      `> **INCOMPLETE**: ${s.set} has complete:false (the run died or is still going); its numbers cover ${s.pages.length} pages only.`,
      "",
    );
  }
  const drift = summaries.flatMap((s) =>
    s.inputs
      .filter(
        (i) =>
          i.path in input.currentInputs &&
          input.currentInputs[i.path] !== i.sha256,
      )
      .map(
        (i) =>
          `${s.set}: ${i.path} ${input.currentInputs[i.path] === null ? "is missing now" : "changed since the run"}`,
      ),
  );
  if (drift.length > 0) out.push("> **INPUT DRIFT**: " + drift.join("; "), "");

  out.push(
    "| set | complete | pages | clusters | tools not ok | commit | browser | axe-core | run at |",
    "|---|---|---|---|---|---|---|---|---|",
  );
  for (const s of summaries) {
    const notOk = s.pages.reduce(
      (n, p) =>
        n + Object.values(p.tools).filter((t) => t.status !== "ok").length,
      0,
    );
    out.push(
      `| ${s.set} | ${s.complete ? "yes" : "NO"} | ${s.pages.length} | ${clusterCount(s.pages)} | ${notOk} | ${s.git.shortSha}${s.git.dirty ? " (dirty)" : ""} | ${s.launch.mode} ${s.launch.browserVersion} | ${s.axeCoreVersion} | ${s.createdAt} |`,
    );
  }
  const notes = [...new Set(summaries.flatMap((s) => s.notes))];
  out.push(
    "",
    "Method notes (from the run):",
    "",
    ...notes.map((n) => `- ${n}`),
    "",
    "Scoring (this report):",
    "",
    '- Legacy trap: a page counts as flagged if detectTrap() ever said trapped during the walk (firstTrappedPress), because the old agent latched trapDetected on the first checkTrap that fired (packages/agent/src/agent.ts:91-92 at d9e2cb5). "clear at end" marks pages where it no longer said trapped after the last press.',
    "",
    `- ${evidenceClass(summaries)}`,
    "",
  );
  return out;
}

export function renderReport(input: ReportInput): string {
  const full: Partial<Record<PageSet, Summary>> = {};
  const subsets = [...input.subsets];
  for (const set of PAGE_SETS) {
    const s = input.summaries[set];
    if (s === undefined) continue;
    if (s.config.pageFilter === null) full[set] = s;
    else subsets.push({ dir: set, summary: s });
  }
  const out = renderHeader(input, full, subsets);
  const bad = full["test-bad"];
  if (bad !== undefined) {
    out.push(...renderHeadlineDelta(bad, input.badTruth));
    out.push(...renderTestBad(bad, input.badTruth));
  }
  const variants = full["dev-variants"];
  if (variants !== undefined) {
    out.push(
      ...renderDevVariants(variants, input.variantLabels, full["dev-fixtures"]),
    );
  }
  const fixtures = full["dev-fixtures"];
  if (fixtures !== undefined) {
    out.push(
      "## dev-fixtures — hand-built base pages (regression only)",
      "",
      ...renderFlagTable(fixtures, {
        baseLabels: input.baseLabels,
        live: false,
      }),
    );
  }
  const devLive = full["dev-live"];
  if (devLive !== undefined) {
    out.push(
      "## dev-live — dev sites (regression only)",
      "",
      ...renderFlagTable(devLive, { baseLabels: null, live: true }),
    );
  }
  const testLive = full["test-live"];
  if (testLive !== undefined) {
    out.push(
      "## test-live — pre-registered site draw",
      "",
      "Counts only: precision needs the Phase-3 hand labels, which do not exist yet.",
      "",
      ...renderFlagTable(testLive, { baseLabels: null, live: true }),
    );
  }
  const missing = PAGE_SETS.filter((s) => full[s] === undefined);
  if (missing.length > 0)
    out.push(`No full-set run at this commit: ${missing.join(", ")}.`, "");
  return `${out.join("\n").trimEnd()}\n`;
}

const sha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const readJson = (path: string): unknown =>
  JSON.parse(readFileSync(path, "utf8"));

// Paths relative to bench/ that the footer checks for uncommitted changes: this file and every local
// module it imports, since each one can change the cells (GAP_WCAG_MAPPING, WALK_GATED_GAP_TYPES, ...).
export const REPORT_CODE: readonly string[] = [
  "report.ts",
  "stats.ts",
  "results-schema.ts",
  "corpus/labels-schema.ts",
  "../packages/accessibility/src/gaps/gap-detector.ts",
  "../packages/accessibility/src/gaps/types.ts",
];

function main(argv: readonly string[]): number {
  const [sha, ...rest] = argv;
  let results = join(BENCH, "results");
  if (rest.length === 2 && rest[0] === "--results") results = resolve(rest[1]);
  else if (rest.length > 0 || sha === undefined || sha.startsWith("-")) {
    console.error(
      "usage: npx tsx bench/report.ts <shortSha[-dirty]> [--results <dir>]",
    );
    return 2;
  }
  const shaDir = join(results, sha);
  const summaries: Partial<Record<PageSet, Summary>> = {};
  const subsets: SubsetRun[] = [];
  const dirs = existsSync(shaDir) ? readdirSync(shaDir).sort() : [];
  for (const dir of dirs) {
    const path = join(shaDir, dir, "summary.json");
    if (!existsSync(path)) continue;
    const set = PageSetSchema.safeParse(dir);
    if (set.success) summaries[set.data] = SummarySchema.parse(readJson(path));
    else if (SUBSET_DIR_RE.test(dir))
      subsets.push({ dir, summary: SummarySchema.parse(readJson(path)) });
  }
  if (Object.keys(summaries).length === 0 && subsets.length === 0) {
    console.error(
      `no summaries under ${shaDir}; run npx tsx bench/run.ts <set> first`,
    );
    return 2;
  }
  const optional = <T>(path: string, schema: z.ZodType<T>): T | null =>
    existsSync(path) ? schema.parse(readJson(path)) : null;
  const currentInputs: Record<string, string | null> = {};
  for (const s of Object.values(summaries)) {
    for (const i of s.inputs) {
      const abs = join(ROOT, i.path);
      currentInputs[i.path] = existsSync(abs) ? sha256(abs) : null;
    }
  }
  const md = renderReport({
    sha,
    summaries,
    subsets,
    badTruth: optional(
      join(BENCH, "corpus", "test", "bad-labels.json"),
      BadTruthSchema,
    ),
    variantLabels: optional(
      join(BENCH, "corpus", "dev", "variants", "labels.json"),
      VariantLabelsFileSchema,
    ),
    baseLabels: optional(
      join(BENCH, "corpus", "dev", "labels.json"),
      BaseLabelsFileSchema,
    ),
    currentInputs,
  });
  const out = join(shaDir, "REPORT-baseline.md");
  // The measurements carry their own commit; the report generator can be a later one.
  const git = (args: string[]): string =>
    execFileSync("git", args, { cwd: BENCH }).toString().trim();
  const generator = `${git(["rev-parse", "--short", "HEAD"])}${git(["status", "--porcelain", "--", ...REPORT_CODE]) ? " (report code uncommitted)" : ""}`;
  writeFileSync(
    out,
    `${md}\nReport generated by bench/report.ts at ${generator}.\n`,
  );
  console.log(`wrote ${relative(process.cwd(), out)}`);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err: unknown) {
    console.error(err);
    process.exitCode = 1;
  }
}
