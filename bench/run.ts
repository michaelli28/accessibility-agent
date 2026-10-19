// Benchmark harness over one page set: the frozen pre-fix checker, the rebuilt judges and axe-core. Per page, every tool
// gets its own fresh browser context and fresh load: the gap detector, runTabWalk with defaults (judged by the new judges,
// and replayed through the legacy trap detector and DynamicEvaluator, bench/legacy.ts), and axe-core. Writes
// <out>/<shortSha>[-dirty]/<set>/summary.json (compact, committable) and raw/<page>.json.gz (full records, gitignored);
// a --pages run writes <set>--subset-<hash>/ instead, which the report never uses for its tables.
//
// Usage (launches Chromium, so outside the sandbox):
//   npx tsx bench/run.ts <dev-fixtures|dev-variants|dev-live|test-bad|test-live>
//     [--pages id,id] [--budget-ms <per-page ms, default 20 min>] [--allow-dirty] [--out <dir, default bench/results>]
// test-live refuses --allow-dirty and any uncommitted change: the held-out set runs once, from a clean commit.
// Exit 0: ran (a tool that throws is recorded per page, never dropped). Exit 2: refused or bad usage. Exit 1: crashed.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { z } from "zod";
import { runAxe, type AxeResult } from "../packages/accessibility/src/axe.js";
import { crawlPageWithGapDetection } from "../packages/accessibility/src/gaps/detect.js";
import { judgeKeyboardTrap } from "../packages/accessibility/src/keyboard-trap.js";
import { judgeContextChange } from "../packages/accessibility/src/context-change.js";
import type {
  AccessibilityGap,
  DualCrawlResult,
} from "../packages/accessibility/src/gaps/types.js";
import {
  groupStops,
  runTabWalk,
  type TabWalkResult,
} from "../packages/accessibility/src/tab-walk.js";
import type { Violation } from "../packages/accessibility/src/types.js";
import { BrowserPage } from "../packages/browser/src/page.js";
import { LEGACY_3_2_1_NOTE, LEGACY_TRAP_NOTE, replayLegacy } from "./legacy.js";
import {
  PAGE_SETS,
  PageSetSchema,
  RESULTS_SCHEMA_VERSION,
  RawPageSchema,
  SummarySchema,
  componentKey,
  runDirName,
  type AxeFinding,
  type GapFinding,
  type GapsFindings,
  type LegacyReplay,
  type LegacyRun,
  type LoadFacts,
  type PageResult,
  type PageSet,
  type RawPage,
  type Summary,
  type ToolStatus,
  type WalkStats,
} from "./results-schema.js";
import {
  Refusal,
  UsageError,
  listPaths,
  prepare,
  readGitState,
  selectPages,
  type ResolvedPage,
} from "./run-inputs.js";
import { startStaticServer } from "./seed.js";
import { MOUNTS, serveUrl } from "./serve.js";

const BENCH = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(BENCH, "..");
const nodeRequire = createRequire(import.meta.url);

const DEFAULT_OUT = join(BENCH, "results");
const DEFAULT_BUDGET_MS = 20 * 60_000;
// The gap detector's own load (packages/accessibility/src/gaps/detect.ts), so all tools see the page alike.
const LOAD_TIMEOUT_MS = 60_000;
const SETTLE_MS = 3_000;
const SECOND_NAVIGATION_TIMEOUT_MS = 15_000;
// After a budget timeout the context is closed; runTabWalk then returns the steps it has within this grace.
const GRACE_MS = 30_000;

const EXECUTABLE_PATH_NOTE =
  "chromium.executablePath() names the full Chromium build even when chromium.launch() runs chrome-headless-shell; browserProcessPath is the launched binary.";
const NOTES = [
  LEGACY_3_2_1_NOTE,
  "Per page the tools run in the order gaps, axe, walk (the legacy replay reuses that walk), each in its own fresh context and load: goto domcontentloaded + 3000 ms settle, the gap detector's own load.",
  "Legacy trap: detectTrap() is replayed after every walk press; trapped is its verdict after the last press, and firstTrappedPress is the first press where it said trapped (report.ts scores a page flagged if it ever did, as the agent latches trapDetected).",
  LEGACY_TRAP_NOTE,
  "The legacy identity is rebuilt from each press's immediate read (the walk's step.immediate: top-level document.activeElement as soon as keyboard.press resolves, with no settle), which is when executeTab reads it; focus a page script moves later is not seen, and focus inside frames or shadow roots shows as the container.",
  "Walk trap (the new checker): judgeKeyboardTrap over this walk. pass = focus reached the end of the page, or it was confined but Escape or the opposite Tab key got out (a correct modal). fail = confined with neither key escaping. undetermined = the walk errored, F is only a lower bound, the focusable count changed mid-walk, the walk's last F+1 stops held more distinct stops than F and the release was read through node identity (focusables-exceeded), or no release probe ran; an undetermined verdict is never counted as flagged: a miss on a detection count, and on a false-alarm count it scores like a clean pass, with the worst case printed beside it. contextChange is judgeContextChange (3.2.1 incl. F55) over the same walk. The legacy detector's verdicts are reported as-is, unchanged, from the frozen copy in bench/legacy-detectors.ts.",
  "Gaps run their own Tab walk on their own load (tabWalk: true). F3 needs it: without a walk the detector never emits not_focusable at all, so a run without it reports 0 not_focusable whatever the page does. That is a SECOND walk per page, separate from the one the judges read, and it roughly doubles the per-page keyboard cost.",
  "Each page's gaps run records the detector's own keyboard evidence (tools.gaps.findings.keyboard): whether the walk ran, whether not_focusable was assessed, and the reasons if it was not. A page where it was NOT assessed is scored undetermined for 2.1.1 and 2.4.7 in BOTH columns -- never counted as flagged: a miss on a detection count, a clean-looking pass on a false-alarm count, whose worst case is printed beside it -- and drops the rule-of-three bound there, because the only gap type carrying those criteria could not be emitted at all. Without this record a check that could not run is indistinguishable in the report from a check that ran and found nothing.",
  "Gaps come from the CURRENT post-fix detector (F1/F2/F3/F9 landed at 6b7abff and c1f94b2: hidden elements are filtered, reachability comes from the Tab walk). The same gap findings feed both the before and the after column, so the before/after delta isolates the keyboard rules and takes no credit for the gap fixes; those were measured separately against cd3b122.",
];

type Args = {
  set: PageSet;
  pages: string[] | null;
  budgetMs: number;
  allowDirty: boolean;
  out: string;
};

function parseArgs(argv: readonly string[]): Args {
  const [set, ...rest] = argv;
  const parsedSet = PageSetSchema.safeParse(set);
  if (!parsedSet.success) {
    throw new UsageError(
      `unknown page set ${JSON.stringify(set ?? "")}; expected one of ${PAGE_SETS.join(", ")}`,
    );
  }
  const args: Args = {
    set: parsedSet.data,
    pages: null,
    budgetMs: DEFAULT_BUDGET_MS,
    allowDirty: false,
    out: DEFAULT_OUT,
  };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (flag === "--allow-dirty") {
      args.allowDirty = true;
      continue;
    }
    if (value === undefined) throw new UsageError(`${flag} needs a value`);
    if (flag === "--pages") {
      args.pages = value.split(",").filter(Boolean);
      if (args.pages.length === 0)
        throw new UsageError("--pages needs at least one page id");
    } else if (flag === "--out") args.out = resolve(value);
    else if (flag === "--budget-ms") {
      const ms = z.coerce.number().int().positive().safeParse(value);
      if (!ms.success)
        throw new UsageError(
          `--budget-ms must be a positive integer, got ${value}`,
        );
      args.budgetMs = ms.data;
    } else throw new UsageError(`unknown argument ${flag}`);
    i++;
  }
  return args;
}

async function launchFacts(browser: Browser): Promise<Summary["launch"]> {
  let browserProcessPath: string | null = null;
  try {
    const session = await browser.newBrowserCDPSession();
    browserProcessPath =
      (await session.send("Browser.getBrowserCommandLine")).arguments[0] ??
      null;
    await session.detach();
  } catch {
    // Chromium answers only when started with --enable-automation (Playwright passes it); unknown stays null.
  }
  const context = await browser.newContext();
  const userAgent = z
    .string()
    .parse(await (await context.newPage()).evaluate("navigator.userAgent"));
  await context.close();
  if (
    !userAgent.includes("HeadlessChrome") ||
    (browserProcessPath !== null &&
      !basename(browserProcessPath).includes("headless-shell"))
  ) {
    throw new Error(
      `launch is not the headless shell: ${browserProcessPath ?? "unknown binary"} (${userAgent})`,
    );
  }
  return {
    mode: "headless-shell",
    browserVersion: browser.version(),
    executablePath: chromium.executablePath(),
    executablePathNote: EXECUTABLE_PATH_NOTE,
    browserProcessPath,
    userAgent,
    playwrightVersion: z
      .string()
      .parse(nodeRequire("playwright/package.json").version),
  };
}

type Tracker = {
  navigations: number;
  lastStatus: number | null;
  blocked: string[];
  load: LoadFacts | null;
};

function isLocalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.hostname === "127.0.0.1" ||
      ["data:", "blob:", "about:"].includes(u.protocol)
    );
  } catch {
    return false;
  }
}

async function openPage(
  browser: Browser,
  localOnly: boolean,
): Promise<{ context: BrowserContext; page: Page; tracker: Tracker }> {
  const context = await browser.newContext();
  const tracker: Tracker = {
    navigations: 0,
    lastStatus: null,
    blocked: [],
    load: null,
  };
  let page: Page;
  try {
    if (localOnly) {
      await context.route("**/*", (route) => {
        const url = route.request().url();
        if (isLocalUrl(url)) return route.continue();
        tracker.blocked.push(url);
        return route.abort("blockedbyclient");
      });
    }
    page = await context.newPage();
  } catch (err: unknown) {
    // The caller never gets this context, so nothing else would close it before the browser does.
    await context.close().catch(() => undefined);
    throw err;
  }
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) tracker.navigations++;
  });
  page.on("response", (response) => {
    try {
      if (
        response.request().isNavigationRequest() &&
        response.frame() === page.mainFrame()
      ) {
        tracker.lastStatus = response.status();
      }
    } catch {
      // Service-worker responses have no frame; they are never the main document.
    }
  });
  return { context, page, tracker };
}

async function loadFacts(
  page: Page,
  spec: ResolvedPage,
  tracker: Tracker,
  secondNavigation: LoadFacts["secondNavigation"],
): Promise<LoadFacts> {
  return {
    requestedUrl: spec.url,
    finalUrl: page.url(),
    status: tracker.lastStatus,
    title: await page.title().catch(() => ""),
    mainFrameNavigations: tracker.navigations,
    secondNavigation,
    blockedRequests: tracker.blocked.length,
  };
}

// Polls the navigation count instead of waitForEvent, which misses a navigation that lands before it subscribes.
async function awaitSecondNavigation(
  page: Page,
  tracker: Tracker,
): Promise<"seen" | "missing"> {
  const until = Date.now() + SECOND_NAVIGATION_TIMEOUT_MS;
  while (tracker.navigations < 2) {
    if (Date.now() > until) return "missing";
    await page.waitForTimeout(50);
  }
  await page.waitForLoadState("domcontentloaded", { timeout: LOAD_TIMEOUT_MS });
  return "seen";
}

async function loadPage(
  page: Page,
  spec: ResolvedPage,
  tracker: Tracker,
): Promise<LoadFacts> {
  await page.goto(spec.url, {
    waitUntil: "domcontentloaded",
    timeout: LOAD_TIMEOUT_MS,
  });
  const second = spec.secondNavigation
    ? await awaitSecondNavigation(page, tracker)
    : "not-expected";
  await page.waitForTimeout(SETTLE_MS);
  return loadFacts(page, spec, tracker, second);
}

type ToolOutcome<T> = {
  value: T | null;
  error: string | null;
  budgetExceeded: boolean;
  durationMs: number;
  load: LoadFacts | null;
  blocked: string[];
};

function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split("\n")[0];
}

const joinErrors = (...errors: Array<string | null>): string | null =>
  errors.filter((e): e is string => e !== null).join("; ") || null;

const RAN_ON_PLACEHOLDER =
  "second navigation never came: this ran on the placeholder";

// One browser serves the whole set, so a page that crashes it takes every later page with it: each
// one records "could not open a browser context" and is scored as a tool error, which is a page the
// instrument never looked at. Relaunching costs one process start and keeps the remaining pages
// measurable. The relaunch is recorded in the summary's notes, because the launch facts it reports
// then describe the FIRST browser only.
export async function liveBrowser(browser: Browser): Promise<Browser> {
  return browser.isConnected() ? browser : chromium.launch();
}

// One tool, one fresh context. On budget expiry the context is closed (aborting in-flight page calls) and whatever
// the tool still returns within the grace period is kept as a partial result.
export async function runTool<T>(
  browser: Browser,
  env: { localOnly: boolean; deadline: number; budgetMs: number },
  work: (page: Page, tracker: Tracker) => Promise<T>,
): Promise<ToolOutcome<T>> {
  const started = Date.now();
  const remaining = env.deadline - started;
  const failed = (error: string, budgetExceeded: boolean): ToolOutcome<T> => ({
    value: null,
    error,
    budgetExceeded,
    durationMs: Date.now() - started,
    load: null,
    blocked: [],
  });
  if (remaining <= 0) {
    return failed(
      `page budget of ${env.budgetMs} ms exhausted before this tool started`,
      true,
    );
  }
  let opened: Awaited<ReturnType<typeof openPage>>;
  try {
    opened = await openPage(browser, env.localOnly);
  } catch (err: unknown) {
    // A dead browser fails every later tool the same way; each records it rather than aborting the set.
    return failed(`could not open a browser context: ${firstLine(err)}`, false);
  }
  const { context, page, tracker } = opened;
  const settled = work(page, tracker).then(
    (value) => ({ value, error: null }),
    (err: unknown) => ({ value: null, error: firstLine(err) }),
  );
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<null>((done) => {
    timer = setTimeout(() => done(null), remaining);
  });
  try {
    const first = await Promise.race([settled, timedOut]);
    let outcome: { value: T | null; error: string | null };
    if (first === null) {
      await context.close().catch(() => undefined);
      const late = await Promise.race([
        settled,
        sleep(GRACE_MS, null, { ref: false }),
      ]);
      outcome = {
        value: late?.value ?? null,
        error: joinErrors(
          `page budget of ${env.budgetMs} ms exceeded; context closed`,
          late?.error ?? null,
        ),
      };
    } else outcome = first;
    const missed =
      tracker.load?.secondNavigation === "missing" ? RAN_ON_PLACEHOLDER : null;
    return {
      value: outcome.value,
      error: joinErrors(outcome.error, missed),
      budgetExceeded: first === null,
      durationMs: Date.now() - started,
      load: tracker.load,
      blocked: [...tracker.blocked],
    };
  } finally {
    clearTimeout(timer);
    await context.close().catch(() => undefined);
  }
}

function status(hasFindings: boolean, error: string | null): ToolStatus {
  if (hasFindings) return error === null ? "ok" : "partial";
  return "error";
}

// The crawl's flags plus its own account of whether the keyboard-gated flag could be emitted at all.
// reachedBackendNodeIds is the deduplicated set of elements the walk focused, so only its size rides in
// the summary; the full list stays in the raw record.
function toGapsFindings(result: DualCrawlResult): GapsFindings {
  return {
    gaps: result.gaps.map(toGapFinding),
    keyboard: {
      walkRan: result.keyboard.walkRan,
      notFocusableAssessed: result.keyboard.notFocusableAssessed,
      unassessedReasons: result.keyboard.unassessedReasons,
      walkError: result.keyboard.walkError,
      reachedCount: result.keyboard.reachedBackendNodeIds.length,
    },
  };
}

function toGapFinding(gap: AccessibilityGap): GapFinding {
  const attrs = gap.domElement.attributes;
  return {
    nodeName: gap.domElement.nodeName,
    id: attrs.id ?? null,
    class: attrs.class ?? null,
    dataBenchId: attrs["data-bench-id"] ?? null,
    gapType: gap.gapType,
    severity: gap.severity,
    wcag: gap.wcagViolations,
  };
}

// axe's node target: one entry per frame, each a selector or (inside shadow DOM) a selector path.
const AxeTargetSchema = z.array(z.union([z.string(), z.array(z.string())]));

// The node's own opening tag in axe's html snippet; an attribute value containing '>' would cut it short.
function componentFromHtml(html: string): string {
  const open = /^\s*<([A-Za-z][\w:-]*)([^>]*)/.exec(html);
  if (open === null) return "?";
  const cls = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(
    open[2],
  );
  return componentKey(
    open[1],
    cls === null ? null : (cls[1] ?? cls[2] ?? cls[3] ?? null),
  );
}

function toAxeFinding(v: Violation): AxeFinding {
  return {
    id: v.id,
    impact: v.impact ?? null,
    wcagTags: v.wcagTags,
    targets: v.nodes.map((n) =>
      AxeTargetSchema.parse(n.target)
        .map((t) => (typeof t === "string" ? t : t.join(" >>> ")))
        .join(" | "),
    ),
    components: v.nodes.map((n) => componentFromHtml(n.html)),
  };
}

export function walkStats(w: TabWalkResult): WalkStats {
  const reads = w.steps.map((s) => s.settled);
  return {
    F: w.focusableCount,
    fIncomplete: w.fIncomplete,
    fIncompleteCauses: w.fIncompleteCauses,
    plannedPresses: w.presses,
    presses: groupStops(w.steps).length,
    wraps: w.steps.filter((s) => s.wrapped).length,
    focusLost: w.steps.filter((s) => s.focusLost).length,
    deep: {
      inside: reads.filter(
        (r) =>
          r.container !== null &&
          r.deep !== null &&
          r.deep.backendNodeId !== r.backendNodeId,
      ).length,
      crossOrigin: reads.filter((r) => r.deepUnavailable === "cross-origin")
        .length,
      closedShadowRoot: reads.filter(
        (r) => r.deepUnavailable === "closed-shadow-root",
      ).length,
    },
    launch: w.launchFacts,
    suspectedTrap: w.suspectedTrap,
    // One forward walk per page, so a trap armed only on reverse entry is not covered (bench/COVERAGE.md).
    trap: judgeKeyboardTrap([w]),
    contextChange: judgeContextChange(w),
    escapeReachedAt: w.escapeProbe?.reachedAt ?? null,
    error: w.error
      ? `${w.error.phase}@${w.error.index}: ${w.error.message}`
      : null,
  };
}

export function legacyFrom(walk: ToolOutcome<TabWalkResult>): {
  run: LegacyRun;
  replay: LegacyReplay | null;
} {
  const base = { budgetExceeded: false, durationMs: 0, load: null };
  if (walk.value === null) {
    return {
      run: {
        ...base,
        status: "skipped",
        error: `no walk to replay: ${walk.error ?? "unknown"}`,
        findings: null,
      },
      replay: null,
    };
  }
  const started = Date.now();
  const w = walk.value;
  const replay = replayLegacy(w.steps);
  // Only a press-loop error cuts the replay. An escape-probe error, or a budget that fires after the
  // last press, happens once every press is in, so the replay itself is complete.
  const cut = w.error?.phase === "walk";
  const error = joinErrors(
    cut
      ? `walked ${groupStops(w.steps).length} of ${w.presses} planned stops: the walk stopped early`
      : null,
    walk.load?.secondNavigation === "missing" ? RAN_ON_PLACEHOLDER : null,
  );
  return {
    run: {
      ...base,
      durationMs: Date.now() - started,
      status: status(true, error),
      error,
      findings: {
        presses: w.steps.length,
        trap: replay.trap,
        dynamicViolations: replay.dynamicViolations.map((v) => ({
          criterion: v.criterion,
          severity: v.severity,
          description: v.description,
          evidence: v.evidence.map((e) => e.element),
        })),
      },
    },
    replay,
  };
}

async function runPage(
  browser: Browser,
  spec: ResolvedPage,
  opts: {
    localOnly: boolean;
    budgetMs: number;
    set: PageSet;
    gitSha: string;
    rawFile: string;
  },
): Promise<{ result: PageResult; raw: RawPage }> {
  const started = Date.now();
  const env = {
    localOnly: opts.localOnly,
    deadline: started + opts.budgetMs,
    budgetMs: opts.budgetMs,
  };

  const gaps = await runTool<DualCrawlResult>(
    browser,
    env,
    async (page, tracker) => {
      // tabWalk is REQUIRED for F3: without it not_focusable is never emitted
      // (gaps/detect.ts GapDetectionOptionsSchema), so the harness would measure the gap detector
      // in a configuration where one of the shipped fixes is structurally disabled -- and a
      // not-assessed check would read as a missed one. The CLI has always passed it.
      const result = await crawlPageWithGapDetection(page, spec.url, {
        tabWalk: true,
      });
      // The detector loads the page itself; its second-navigation fact can only be read afterwards.
      const second = !spec.secondNavigation
        ? "not-expected"
        : tracker.navigations >= 2
          ? "seen"
          : "missing";
      tracker.load = await loadFacts(page, spec, tracker, second);
      return result;
    },
  );
  const axe = await runTool<AxeResult>(browser, env, async (page, tracker) => {
    tracker.load = await loadPage(page, spec, tracker);
    // runAxe types its argument as the BUILT @at-agent/browser class (a private field makes it nominal), while
    // the harness runs package sources; runAxe only reads the wrapped Playwright page.
    const wrapped = new BrowserPage(page) as unknown as Parameters<
      typeof runAxe
    >[0];
    return runAxe(wrapped);
  });
  const walk = await runTool<TabWalkResult>(
    browser,
    env,
    async (page, tracker) => {
      tracker.load = await loadPage(page, spec, tracker);
      return runTabWalk(page);
    },
  );
  const legacy = legacyFrom(walk);

  const stats = walk.value === null ? null : walkStats(walk.value);
  const walkError = joinErrors(walk.error, stats?.error ?? null);
  const toolRun = <T, F>(
    o: ToolOutcome<T>,
    findings: F | null,
    error: string | null,
  ) => ({
    status: status(findings !== null, error),
    error: findings === null && error === null ? "no result" : error,
    budgetExceeded: o.budgetExceeded,
    durationMs: o.durationMs,
    load: o.load,
    findings,
  });
  const tools = {
    gaps: toolRun(
      gaps,
      gaps.value === null ? null : toGapsFindings(gaps.value),
      gaps.error,
    ),
    walk: toolRun(walk, stats, walkError),
    legacy: legacy.run,
    axe: toolRun(
      axe,
      axe.value?.violations.map(toAxeFinding) ?? null,
      axe.error,
    ),
  };
  const budgetExceeded =
    gaps.budgetExceeded || axe.budgetExceeded || walk.budgetExceeded;
  const result: PageResult = {
    pageId: spec.pageId,
    url: spec.url,
    cluster: spec.cluster,
    budgetMs: opts.budgetMs,
    budgetExceeded,
    durationMs: Date.now() - started,
    rawFile: opts.rawFile,
    tools,
  };
  const raw: RawPage = {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    set: opts.set,
    pageId: spec.pageId,
    url: spec.url,
    gitSha: opts.gitSha,
    gaps:
      gaps.value === null
        ? null
        : {
            pageUrl: gaps.value.pageUrl,
            domElementCount: gaps.value.domElements.length,
            axElementCount: gaps.value.accessibilityTree.elements.size,
            gaps: gaps.value.gaps,
            keyboard: gaps.value.keyboard,
          },
    walk: walk.value,
    legacy: legacy.replay,
    axe: axe.value,
    blockedUrls: [
      ...new Set([...gaps.blocked, ...axe.blocked, ...walk.blocked]),
    ],
  };
  return { result, raw };
}

function describePage(p: PageResult): string {
  const { gaps, walk, legacy, axe } = p.tools;
  const flag = (s: ToolStatus, error: string | null) =>
    s === "ok" ? "" : ` [${s.toUpperCase()}: ${error}]`;
  const trap = legacy.findings?.trap;
  const parts = [
    `gaps ${gaps.findings?.gaps.length ?? "-"}${gaps.findings !== null && !gaps.findings.keyboard.notFocusableAssessed ? ` [not_focusable NOT assessed: ${gaps.findings.keyboard.unassessedReasons.join(",")}]` : ""}${flag(gaps.status, gaps.error)}`,
    `axe ${axe.findings?.length ?? "-"} rules/${axe.findings?.reduce((n, v) => n + v.targets.length, 0) ?? "-"} nodes${flag(axe.status, axe.error)}`,
    walk.findings === null
      ? `walk -${flag(walk.status, walk.error)}`
      : `walk F=${walk.findings.fIncomplete ? "≥" : ""}${walk.findings.F} ${walk.findings.presses}/${walk.findings.plannedPresses} stops, ${walk.findings.wraps} wraps${walk.findings.trap.verdict === "pass" ? "" : `, trap ${walk.findings.trap.verdict}${walk.findings.trap.reason === null ? "" : ` (${walk.findings.trap.reason})`}`}${walk.findings.contextChange.verdict === "pass" ? "" : `, 3.2.1 ${walk.findings.contextChange.verdict}`}${flag(walk.status, walk.error)}`,
    trap === undefined
      ? `legacy -${flag(legacy.status, legacy.error)}`
      : `legacy trap ${trap.trapped ? `YES (first @${trap.firstTrappedPress}, cycle ${trap.cycleLength})` : "no"}, dynamic [${legacy.findings?.dynamicViolations.map((v) => v.criterion).join(",")}]`,
  ];
  return `${p.pageId}  ${parts.join(" · ")}  (${(p.durationMs / 1000).toFixed(1)} s)`;
}

const sha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

function writeSummary(setDir: string, summary: Summary): void {
  writeFileSync(
    join(setDir, "summary.json"),
    `${JSON.stringify(SummarySchema.parse(summary), null, 2)}\n`,
  );
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.set === "test-live" && args.allowDirty) {
    throw new Refusal(
      "--allow-dirty is never allowed for test-live: the held-out set runs once, from a clean committed tree.",
    );
  }
  // A subset run would spend held-out pages without them ever entering a headline table.
  if (args.set === "test-live" && args.pages !== null) {
    throw new Refusal(
      "--pages is never allowed for test-live: the held-out set runs whole, once.",
    );
  }
  const gitState = readGitState();
  if (gitState.dirty && !args.allowDirty) {
    throw new Refusal(
      `${gitState.dirtyPaths.length} uncommitted path(s) outside bench/results/ (${listPaths(gitState.dirtyPaths)}); results must name a commit that contains the code. Commit first${args.set === "test-live" ? "" : ", or pass --allow-dirty to stamp the run dirty:true"}.`,
    );
  }
  const prepared = await prepare(args.set);
  const pages = selectPages(prepared.pages, args.pages);
  const setDir = join(
    args.out,
    gitState.dirty ? `${gitState.shortSha}-dirty` : gitState.shortSha,
    runDirName(args.set, args.pages),
  );
  rmSync(join(setDir, "raw"), { recursive: true, force: true });
  mkdirSync(join(setDir, "raw"), { recursive: true });

  const server = prepared.localOnly ? await startStaticServer(MOUNTS) : null;
  // Outside the try below, so close the server here: its open socket would keep the process alive.
  const browser = await chromium.launch().catch(async (err: unknown) => {
    await server?.close();
    throw err;
  });
  // Hoisted: a relaunch replaces this, and the finally must close whichever browser is current or
  // the dead one's replacement outlives the run as an orphaned Chromium process.
  let active = browser;
  try {
    const resolved: ResolvedPage[] = pages.map((p) => ({
      ...p,
      url:
        p.target.kind === "live"
          ? p.target.url
          : serveUrl(p.target.mount, p.target.rel, server?.origin),
    }));
    const base: Summary = {
      schemaVersion: RESULTS_SCHEMA_VERSION,
      set: args.set,
      complete: false,
      createdAt: new Date().toISOString(),
      git: gitState,
      launch: await launchFacts(browser),
      axeCoreVersion: z
        .string()
        .parse(nodeRequire("axe-core/package.json").version),
      nodeVersion: process.version,
      config: {
        budgetMs: args.budgetMs,
        waitUntil: "domcontentloaded",
        settleMs: SETTLE_MS,
        loadTimeoutMs: LOAD_TIMEOUT_MS,
        walkOptions: "runTabWalk defaults",
        localOnly: prepared.localOnly,
        pageFilter: args.pages,
      },
      inputs: prepared.inputs.map((path) => ({
        path: relative(ROOT, path),
        sha256: sha256(path),
      })),
      notes: NOTES,
      pages: [],
    };
    writeSummary(setDir, base);
    const results: PageResult[] = [];
    const relaunched: string[] = [];
    for (const [i, spec] of resolved.entries()) {
      const rawFile = `raw/${spec.pageId.replaceAll("/", "__")}.json.gz`;
      const live = await liveBrowser(active);
      if (live !== active) {
        relaunched.push(spec.pageId);
        console.log(
          `  browser died on the previous page; relaunched before ${spec.pageId}`,
        );
        active = live;
      }
      const { result, raw } = await runPage(active, spec, {
        localOnly: prepared.localOnly,
        budgetMs: args.budgetMs,
        set: args.set,
        gitSha: gitState.sha,
        rawFile,
      });
      writeFileSync(
        join(setDir, rawFile),
        gzipSync(JSON.stringify(RawPageSchema.parse(raw))),
      );
      results.push(result);
      writeSummary(setDir, { ...base, pages: results });
      console.log(`[${i + 1}/${resolved.length}] ${describePage(result)}`);
    }
    const notes =
      relaunched.length === 0
        ? base.notes
        : [
            ...base.notes,
            `The browser died mid-run and was relaunched before ${relaunched.length} page(s): ${relaunched.join(", ")}. The launch block above describes the FIRST browser; a relaunched one is a fresh process of the same build. Pages recorded before a relaunch were measured by a different process than those after it.`,
          ];
    writeSummary(setDir, { ...base, notes, complete: true, pages: results });
    const summaryPath = join(setDir, "summary.json");
    const shown = relative(process.cwd(), summaryPath);
    console.log(
      `wrote ${shown.startsWith("..") ? summaryPath : shown} (${results.length} pages)`,
    );
    return 0;
  } finally {
    await active.close().catch(() => undefined);
    // A replaced browser is already dead, but close it too rather than assume why it died.
    if (active !== browser) await browser.close().catch(() => undefined);
    await server?.close();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  main(argv).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      if (err instanceof Refusal)
        console.error(`REFUSED ${argv[0]}: ${err.message}`);
      else if (err instanceof UsageError) {
        console.error(`usage error: ${err.message}`);
        console.error(
          "usage: npx tsx bench/run.ts <set> [--pages id,id] [--budget-ms n] [--allow-dirty] [--out dir]",
        );
      } else console.error(err);
      process.exitCode =
        err instanceof Refusal || err instanceof UsageError ? 2 : 1;
    },
  );
}
