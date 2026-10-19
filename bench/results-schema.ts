// Output contract of bench/run.ts: summary.json (committable, compact findings) and raw/<page>.json.gz (full records).
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AccessibilityGapSchema,
  AccessibilityGapTypeSchema,
  KeyboardEvidenceSchema,
  KeyboardUnassessedReasonSchema,
} from "../packages/accessibility/src/gaps/types.js";
import {
  LaunchFactsSchema,
  TabWalkResultSchema,
} from "../packages/accessibility/src/tab-walk.js";
import { KeyboardTrapResultSchema } from "../packages/accessibility/src/keyboard-trap.js";
import { ContextChangeResultSchema } from "../packages/accessibility/src/context-change.js";
import { ImpactSchema } from "../packages/accessibility/src/types.js";
import { LegacyDynamicViolationSchema } from "./legacy-detectors.js";

// One version line for summary.json AND raw/<page>.json.gz. Both files are written from the same run
// and read back by the same report, so a bump that reached only one of them would be a silently
// half-migrated artifact: the summary would parse and the raw record would not. Bumped to 3 when the
// gaps run started carrying its keyboard evidence (see KeyboardEvidenceSummarySchema).
export const RESULTS_SCHEMA_VERSION = 3;

export const PAGE_SETS = [
  "dev-fixtures",
  "dev-variants",
  "dev-live",
  "test-bad",
  "test-live",
] as const;
export const PageSetSchema = z.enum(PAGE_SETS);
export type PageSet = z.infer<typeof PageSetSchema>;

// <sha>/<dir>/summary.json: a full run owns <set>; a --pages run gets <set>--subset-<hash of the sorted ids>, so it
// can never overwrite or stand in for the full set.
export function runDirName(
  set: PageSet,
  pageFilter: readonly string[] | null,
): string {
  if (pageFilter === null) return set;
  const ids = [...new Set(pageFilter)].sort().join("\n");
  const hash = createHash("sha256").update(ids).digest("hex").slice(0, 10);
  return `${set}--subset-${hash}`;
}
export const SUBSET_DIR_RE = /^([a-z-]+)--subset-[0-9a-f]{10}$/;

// ok: findings, no error. partial: findings AND an error (budget hit or walk stopped). error / skipped: no findings.
export const ToolStatusSchema = z.enum(["ok", "partial", "error", "skipped"]);
export type ToolStatus = z.infer<typeof ToolStatusSchema>;

export const GapFindingSchema = z
  .object({
    nodeName: z.string(),
    id: z.string().nullable(),
    class: z.string().nullable(),
    dataBenchId: z.string().nullable(),
    gapType: AccessibilityGapTypeSchema,
    severity: ImpactSchema,
    wcag: z.array(z.string()),
  })
  .strict();
export type GapFinding = z.infer<typeof GapFindingSchema>;

// The gap detector's own keyboard evidence (packages/accessibility/src/gaps/keyboard.ts), carried into
// the summary so the report can tell "not_focusable was not assessed" from "not_focusable was assessed
// and found nothing". Those two read identically in a findings array, which is how a structurally
// disabled check read as a check that ran and found nothing (fixed at 118bb99); recording the evidence
// is what stops that from being invisible a second time.
// Compact by design: reachedBackendNodeIds is the DEDUPLICATED set of elements the walk focused, so it
// grows with the page's focusable count (46-61 on a real page, and every id repeated per page in a
// committable summary). The summary keeps its size; RawPageSchema below carries the list in full,
// which is what a not_focusable miss is actually diagnosed from.
export const KeyboardEvidenceSummarySchema = z
  .object({
    walkRan: z.boolean(),
    notFocusableAssessed: z.boolean(),
    unassessedReasons: z.array(KeyboardUnassessedReasonSchema),
    walkError: z.string().nullable(),
    reachedCount: z.number().int().nonnegative(),
  })
  .strict()
  // keyboard.ts's own rule (notFocusableAssessed = reasons.length === 0). Restated here so a bad
  // projection fails at the write, not silently as an over-confident report cell.
  .refine(
    (k) => k.notFocusableAssessed === (k.unassessedReasons.length === 0),
    {
      message: "notFocusableAssessed must equal unassessedReasons being empty",
    },
  );
export type KeyboardEvidenceSummary = z.infer<
  typeof KeyboardEvidenceSummarySchema
>;

// The gaps tool's findings: the flags AND the evidence about whether the keyboard-gated flag could be
// emitted at all. One object so that toolRunSchema's status/findings rule still holds — on a failed
// crawl there is no keyboard evidence either, and findings goes null as a whole.
export const GapsFindingsSchema = z
  .object({
    gaps: z.array(GapFindingSchema),
    keyboard: KeyboardEvidenceSummarySchema,
  })
  .strict();
export type GapsFindings = z.infer<typeof GapsFindingsSchema>;

export const LegacyTrapSchema = z
  .object({
    // detectTrap() after the last walk press.
    trapped: z.boolean(),
    // First press after which detectTrap() said trapped; null if it never did.
    firstTrappedPress: z.number().int().positive().nullable(),
    cycleLength: z.number().int().nonnegative(),
    element: z.string().nullable(),
  })
  .strict();
export type LegacyTrap = z.infer<typeof LegacyTrapSchema>;

// Full per-press replay (raw record); LegacyFindingsSchema below is its compact summary form.
export const LegacyReplaySchema = z
  .object({
    identities: z.array(z.string()),
    trapByPress: z.array(
      z
        .object({
          press: z.number().int().positive(),
          trapped: z.boolean(),
          cycleLength: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    trap: LegacyTrapSchema,
    dynamicViolations: z.array(LegacyDynamicViolationSchema),
  })
  .strict();
export type LegacyReplay = z.infer<typeof LegacyReplaySchema>;

export const DynamicFindingSchema = z
  .object({
    criterion: z.string(),
    severity: ImpactSchema,
    description: z.string(),
    // Identity strings of the evidence events (timestamps dropped so the summary is reproducible).
    evidence: z.array(z.string().nullable()),
  })
  .strict();
export type DynamicFinding = z.infer<typeof DynamicFindingSchema>;

export const LegacyFindingsSchema = z
  .object({
    presses: z.number().int().nonnegative(),
    trap: LegacyTrapSchema,
    dynamicViolations: z.array(DynamicFindingSchema),
  })
  .strict();
export type LegacyFindings = z.infer<typeof LegacyFindingsSchema>;

// Groups flags by component: NODENAME plus the sorted, de-duplicated class set, e.g. "A.btn.primary".
export function componentKey(
  nodeName: string,
  classAttr: string | null,
): string {
  const classes = [...new Set((classAttr ?? "").split(/\s+/).filter(Boolean))];
  return [nodeName.toUpperCase(), ...classes.sort()].join(".");
}

export const AxeFindingSchema = z
  .object({
    id: z.string(),
    impact: ImpactSchema.nullable(),
    wcagTags: z.array(z.string()),
    // One per node: axe's target selector, frames joined by " | ", shadow roots by " >>> ".
    targets: z.array(z.string()),
    // One per node, parallel to targets: NODENAME.sorted.classes from the node's opening tag in axe's html snippet.
    components: z.array(z.string()),
  })
  .strict();
export type AxeFinding = z.infer<typeof AxeFindingSchema>;

export const WalkStatsSchema = z
  .object({
    F: z.number().int().nonnegative(),
    // F is a lower bound: a rendered cross-origin frame or closed shadow root may hide Tab stops.
    fIncomplete: z.boolean(),
    fIncompleteCauses: TabWalkResultSchema.shape.fIncompleteCauses.strict(),
    // Tab stops (groupStops in tab-walk.ts) since the walk recorded part; records before it counted presses,
    // which exceed stops on a page with a date, time or media control (one stop of several presses).
    plannedPresses: z.number().int().positive(),
    presses: z.number().int().nonnegative(),
    wraps: z.number().int().nonnegative(),
    focusLost: z.number().int().nonnegative(),
    // Settled walk reads whose focus sat inside a frame or shadow root and was resolved there, or sat behind a
    // boundary page JS cannot cross.
    deep: z
      .object({
        inside: z.number().int().nonnegative(),
        crossOrigin: z.number().int().nonnegative(),
        closedShadowRoot: z.number().int().nonnegative(),
      })
      .strict(),
    // runTabWalk's own launch facts (the summary's launch block is the harness's).
    launch: LaunchFactsSchema.strict(),
    // The walk's raw fact (no wrapped marker in the whole walk; null on a walk error). A fact, not a
    // verdict: repetition is normal, so only the judges below decide 2.1.2.
    suspectedTrap: z.boolean().nullable(),
    // WCAG 2.1.2 and 3.2.1 as judged from this walk. Three-valued: an undetermined verdict is scored
    // as a miss, never as a pass, so refusing to judge can never buy detection (report.ts prints
    // the false-alarm worst case, where a refusal would otherwise score like a clean pass).
    trap: KeyboardTrapResultSchema,
    contextChange: ContextChangeResultSchema,
    // Raw escape-probe fact; on an fIncomplete page a null is not evidence of a trap.
    escapeReachedAt: z.number().int().positive().nullable(),
    // The walk's own recorded error (phase@index: message); the walk still returned its partial steps.
    error: z.string().nullable(),
  })
  .strict();
export type WalkStats = z.infer<typeof WalkStatsSchema>;

export const LoadFactsSchema = z
  .object({
    requestedUrl: z.string(),
    finalUrl: z.string(),
    status: z.number().int().nullable(),
    title: z.string(),
    mainFrameNavigations: z.number().int().nonnegative(),
    secondNavigation: z.enum(["not-expected", "seen", "missing"]),
    blockedRequests: z.number().int().nonnegative(),
  })
  .strict();
export type LoadFacts = z.infer<typeof LoadFactsSchema>;

function toolRunSchema<T extends z.ZodTypeAny>(findings: T) {
  return z
    .object({
      status: ToolStatusSchema,
      error: z.string().nullable(),
      budgetExceeded: z.boolean(),
      durationMs: z.number().nonnegative(),
      load: LoadFactsSchema.nullable(),
      findings: findings.nullable(),
    })
    .strict()
    .superRefine((r, ctx) => {
      const has = r.findings !== null;
      const err = r.error !== null;
      const consistent =
        r.status === "ok"
          ? has && !err
          : r.status === "partial"
            ? has && err
            : !has && err;
      if (!consistent) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `status ${r.status} with findings=${has} error=${err}`,
        });
      }
    });
}

export const GapsRunSchema = toolRunSchema(GapsFindingsSchema);
export const WalkRunSchema = toolRunSchema(WalkStatsSchema);
export const LegacyRunSchema = toolRunSchema(LegacyFindingsSchema);
export const AxeRunSchema = toolRunSchema(z.array(AxeFindingSchema));
export type GapsRun = z.infer<typeof GapsRunSchema>;
export type WalkRun = z.infer<typeof WalkRunSchema>;
export type LegacyRun = z.infer<typeof LegacyRunSchema>;
export type AxeRun = z.infer<typeof AxeRunSchema>;

export const PageResultSchema = z
  .object({
    pageId: z.string().min(1),
    url: z.string(),
    // Pages sharing a cluster (same site, same base page) are not independent; intervals print the cluster count.
    cluster: z.string().min(1),
    budgetMs: z.number().int().positive(),
    budgetExceeded: z.boolean(),
    durationMs: z.number().nonnegative(),
    // Relative to the summary's directory; null when nothing could be recorded.
    rawFile: z.string().nullable(),
    tools: z
      .object({
        gaps: GapsRunSchema,
        walk: WalkRunSchema,
        legacy: LegacyRunSchema,
        axe: AxeRunSchema,
      })
      .strict(),
  })
  .strict();
export type PageResult = z.infer<typeof PageResultSchema>;

export const GitStateSchema = z
  .object({
    sha: z.string().regex(/^[0-9a-f]{40}$/),
    shortSha: z.string().regex(/^[0-9a-f]{7,40}$/),
    // Uncommitted changes (tracked or untracked, outside bench/results/) when the run started.
    dirty: z.boolean(),
    dirtyPaths: z.array(z.string()),
  })
  .strict()
  .refine((g) => g.dirty === g.dirtyPaths.length > 0, {
    message: "dirty must equal dirtyPaths.length > 0",
  });

export const LaunchSchema = z
  .object({
    mode: z.literal("headless-shell"),
    browserVersion: z.string().min(1),
    // chromium.executablePath(); see executablePathNote.
    executablePath: z.string().min(1),
    executablePathNote: z.string(),
    // argv[0] of the launched browser process (Browser.getBrowserCommandLine); null if the browser would not say.
    browserProcessPath: z.string().nullable(),
    userAgent: z.string(),
    playwrightVersion: z.string().min(1),
  })
  .strict();

export const SummarySchema = z
  .object({
    schemaVersion: z.literal(RESULTS_SCHEMA_VERSION),
    set: PageSetSchema,
    // false while the run is in progress or if it died; the report refuses to present incomplete summaries silently.
    complete: z.boolean(),
    createdAt: z.string(),
    git: GitStateSchema,
    launch: LaunchSchema,
    axeCoreVersion: z.string().min(1),
    nodeVersion: z.string().min(1),
    config: z
      .object({
        budgetMs: z.number().int().positive(),
        waitUntil: z.literal("domcontentloaded"),
        settleMs: z.number().int().nonnegative(),
        loadTimeoutMs: z.number().int().positive(),
        walkOptions: z.literal("runTabWalk defaults"),
        // Non-local requests aborted (local page sets only).
        localOnly: z.boolean(),
        pageFilter: z.array(z.string()).nullable(),
      })
      .strict(),
    // Label and corpus files the run read, hashed so the report can detect drift since the run.
    inputs: z.array(
      z
        .object({
          path: z.string(),
          sha256: z.string().regex(/^[0-9a-f]{64}$/),
        })
        .strict(),
    ),
    notes: z.array(z.string()),
    pages: z.array(PageResultSchema),
  })
  .strict();
export type Summary = z.infer<typeof SummarySchema>;

export const RawPageSchema = z
  .object({
    schemaVersion: z.literal(RESULTS_SCHEMA_VERSION),
    set: PageSetSchema,
    pageId: z.string(),
    url: z.string(),
    gitSha: z.string(),
    gaps: z
      .object({
        pageUrl: z.string(),
        domElementCount: z.number().int().nonnegative(),
        axElementCount: z.number().int().nonnegative(),
        gaps: z.array(AccessibilityGapSchema),
        // The crawl's keyboard evidence in full, reached ids included -- the summary keeps only their
        // count. Which elements the walk actually reached is what a not_focusable miss is diagnosed
        // from, and it cannot be recovered afterwards from the flags alone.
        keyboard: KeyboardEvidenceSchema,
      })
      .strict()
      .nullable(),
    // runTabWalk's result exactly as returned (validated, never re-shaped).
    walk: z
      .unknown()
      .refine((w) => w === null || TabWalkResultSchema.safeParse(w).success, {
        message: "walk is not a TabWalkResult",
      }),
    legacy: LegacyReplaySchema.nullable(),
    // runAxe's AxeResult as returned.
    axe: z
      .object({
        violations: z.array(z.unknown()),
        passes: z.array(z.unknown()),
        incomplete: z.array(z.unknown()),
      })
      .strict()
      .nullable(),
    blockedUrls: z.array(z.string()),
  })
  .strict();
export type RawPage = z.infer<typeof RawPageSchema>;
