// End-to-end: bench/run.ts in a subprocess on two dev fixtures, then its outputs checked against the results schema.
// Launches Chromium, so run outside the sandbox: npx vitest run bench/run.test.ts
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { chromium } from "playwright";
import { beforeAll, describe, expect, it } from "vitest";
import {
  TabWalkResultSchema,
  runTabWalk,
  type TabWalkResult,
} from "../packages/accessibility/src/tab-walk.js";
import {
  RawPageSchema,
  SummarySchema,
  runDirName,
  type LoadFacts,
  type PageResult,
  type Summary,
} from "./results-schema.js";
import { Refusal, checkHeldOutTree, dirtyPathsFrom } from "./run-inputs.js";
import { legacyFrom, liveBrowser, runTool, walkStats } from "./run.js";

const BENCH = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(BENCH, "..");
const execFileAsync = promisify(execFile);

// `node --import tsx`, not the tsx CLI: its IPC pipe is refused inside the Claude Bash sandbox.
function runBench(
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(
    process.execPath,
    ["--import", "tsx", join(BENCH, "run.ts"), ...args],
    {
      cwd: ROOT,
      env: opts.env ?? process.env,
      timeout: opts.timeout ?? 280_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}

describe("run.ts end-to-end on two dev fixtures", () => {
  let summary: Summary;
  let setDir: string;
  let shaDir: string;
  let runDirs: string[];
  let stdout: string;
  const page = (id: string): PageResult => {
    const p = summary.pages.find((x) => x.pageId === id);
    if (p === undefined) throw new Error(`no page ${id}`);
    return p;
  };

  beforeAll(async () => {
    const out = mkdtempSync(join(tmpdir(), "bench-run-"));
    ({ stdout } = await runBench([
      "dev-fixtures",
      "--pages",
      "three-links,identical-links",
      "--allow-dirty",
      "--out",
      out,
    ]));
    [shaDir] = readdirSync(out);
    runDirs = readdirSync(join(out, shaDir));
    setDir = join(out, shaDir, runDirs[0]);
    summary = SummarySchema.parse(
      JSON.parse(readFileSync(join(setDir, "summary.json"), "utf8")),
    );
  }, 300_000);

  it("writes a --pages run to its own subset directory, never the set's", () => {
    expect(runDirs).toEqual([
      runDirName("dev-fixtures", ["identical-links", "three-links"]),
    ]);
    expect(runDirs[0]).toMatch(/^dev-fixtures--subset-[0-9a-f]{10}$/);
  });

  it("writes a complete, schema-valid summary stamped with the commit, launch facts and page filter", () => {
    expect(summary.set).toBe("dev-fixtures");
    expect(summary.complete).toBe(true);
    expect(shaDir).toBe(
      summary.git.dirty
        ? `${summary.git.shortSha}-dirty`
        : summary.git.shortSha,
    );
    expect(summary.config.pageFilter).toEqual([
      "three-links",
      "identical-links",
    ]);
    expect(summary.pages.map((p) => p.pageId)).toEqual([
      "identical-links",
      "three-links",
    ]);
    expect(summary.launch.mode).toBe("headless-shell");
    expect(summary.launch.userAgent).toContain("HeadlessChrome");
    expect(summary.notes.some((n) => n.includes("3.2.1"))).toBe(true);
    for (const p of summary.pages) {
      for (const tool of Object.values(p.tools)) expect(tool.status).toBe("ok");
      expect(p.tools.walk.load?.blockedRequests).toBe(0);
    }
    expect(stdout).toContain("three-links");
  });

  it("calls the walk's counts stops, not presses, in the progress line and the results legend", () => {
    expect(stdout).toContain("walk F=3 25/25 stops");
    const legend = summary.notes.find((n) =>
      n.startsWith("Walk trap (the new checker)"),
    );
    expect(legend).toContain(
      "the walk's last F+1 stops held more distinct stops than F",
    );
  });

  it("three-links: the legacy trap detector reports the known wrap-around false trap (cycle of 4 at press 20)", () => {
    const p = page("three-links");
    expect(p.tools.walk.findings).toEqual({
      F: 3,
      fIncomplete: false,
      fIncompleteCauses: { crossOriginFrames: 0, closedShadowRoots: 0 },
      plannedPresses: 25,
      presses: 25,
      wraps: 6,
      focusLost: 0,
      deep: { inside: 0, crossOrigin: 0, closedShadowRoot: 0 },
      launch: {
        browserVersion: summary.launch.browserVersion,
        executableBasename: "chrome-headless-shell",
      },
      suspectedTrap: false,
      trap: {
        wcagCriterion: "2.1.2",
        verdict: "pass",
        reason: null,
        keyboardTrap: false,
        trapEscapable: null,
        singleDirection: true,
        directionsWalked: ["forward"],
        launch: {
          browserVersion: summary.launch.browserVersion,
          executableBasename: "chrome-headless-shell",
        },
        directions: [
          {
            direction: "forward",
            verdict: "pass",
            reason: null,
            confined: false,
            endOfPage: { signal: "body-unfocused", atPress: 4 },
            release: "not-probed",
            // The browser assigns backendNodeIds, so the tail's identities are counted below, not pinned here.
            region: expect.any(Array),
            focusableCount: 3,
            stuckOn: null,
            escapeUrlChanged: false,
            documentReplacements: [],
          },
        ],
      },
      contextChange: {
        wcagCriterion: "3.2.1",
        verdict: "pass",
        reason: null,
        fIncomplete: false,
        findings: [],
        unattributed: [],
      },
      escapeReachedAt: null,
      error: null,
    });
    expect(p.tools.walk.findings?.trap.directions[0].region).toHaveLength(3);
    expect(p.tools.legacy.findings?.trap).toMatchObject({
      trapped: true,
      firstTrappedPress: 20,
      cycleLength: 4,
    });
    expect(
      p.tools.legacy.findings?.dynamicViolations.map((v) => v.criterion),
    ).toEqual(["2.4.3"]);
  });

  // The before/after, on one page, in one run, in one browser session: both columns read the SAME
  // walk, so they cannot differ because the page moved between runs.
  it("three-links: the frozen pre-fix checker still cries wolf on the same walk the judge passes", () => {
    const p = page("three-links");
    // BEFORE — the frozen replay of the pre-fix detector: a wrap-around cycle called a trap.
    expect(p.tools.legacy.findings?.trap.trapped).toBe(true);
    expect(p.tools.legacy.findings?.trap.firstTrappedPress).toBe(20);
    // AFTER — the judge on that same walk: the page ends, so 2.1.2 passes.
    expect(p.tools.walk.findings?.trap.verdict).toBe("pass");
    expect(p.tools.walk.findings?.trap.keyboardTrap).toBe(false);
    expect(p.tools.walk.findings?.trap.directions).toHaveLength(1);
    expect(p.tools.walk.findings?.trap.directions[0].endOfPage?.signal).toBe(
      "body-unfocused",
    );
    // And no 3.2.1 on a page where Tab never changes context.
    expect(p.tools.walk.findings?.contextChange.verdict).toBe("pass");
    expect(p.tools.walk.findings?.contextChange.findings).toEqual([]);
  });

  it("identical-links: twelve id-less 'Read more' links collide into a 1-cycle trap at press 5", () => {
    const p = page("identical-links");
    expect(p.tools.walk.findings).toMatchObject({
      F: 12,
      presses: 70,
      wraps: 5,
      suspectedTrap: false,
    });
    expect(p.tools.legacy.findings?.trap).toMatchObject({
      trapped: true,
      firstTrappedPress: 5,
      cycleLength: 1,
      element: 'a "Read more"',
    });
  });

  it("writes a gzipped raw record per page holding the verbatim walk and the per-press legacy replay", () => {
    const p = page("three-links");
    expect(p.rawFile).not.toBeNull();
    const raw = RawPageSchema.parse(
      JSON.parse(
        gunzipSync(readFileSync(join(setDir, p.rawFile ?? ""))).toString(
          "utf8",
        ),
      ),
    );
    const walk = TabWalkResultSchema.parse(raw.walk);
    expect(walk.steps).toHaveLength(25);
    expect(raw.legacy?.identities.slice(0, 4)).toEqual([
      'a "One"',
      'a "Two"',
      'a "Three"',
      "body",
    ]);
    expect(raw.legacy?.trapByPress).toHaveLength(25);
    expect(raw.axe).not.toBeNull();
  });
});

describe("run.ts refusals", () => {
  it("refuses test-live with --allow-dirty outright, whatever the tree or draw state", async () => {
    const run = runBench([
      "test-live",
      "--allow-dirty",
      "--out",
      mkdtempSync(join(tmpdir(), "bench-run-")),
    ]);
    await expect(run).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining(
        "REFUSED test-live: --allow-dirty is never allowed for test-live",
      ),
    });
  }, 60_000);

  it("refuses test-live with --pages: the held-out set runs whole", async () => {
    const run = runBench([
      "test-live",
      "--pages",
      "topjobs.lk",
      "--out",
      mkdtempSync(join(tmpdir(), "bench-run-")),
    ]);
    await expect(run).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining(
        "REFUSED test-live: --pages is never allowed for test-live",
      ),
    });
  }, 60_000);

  it("rejects an empty --pages list", async () => {
    await expect(
      runBench(["dev-fixtures", "--pages", ",", "--allow-dirty"]),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("--pages needs at least one page id"),
    });
  }, 60_000);

  it("rejects an unknown page set", async () => {
    await expect(runBench(["dev-everything"])).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("dev-everything"),
    });
  }, 60_000);
});

// The static server starts before the browser; a failed launch left its socket open and the
// process hung forever instead of exiting 1.
describe("run.ts when Chromium cannot launch", () => {
  it("exits 1 instead of hanging", async () => {
    const run = runBench(
      [
        "dev-fixtures",
        "--pages",
        "three-links",
        "--allow-dirty",
        "--out",
        mkdtempSync(join(tmpdir(), "bench-run-")),
      ],
      {
        env: {
          ...process.env,
          PLAYWRIGHT_BROWSERS_PATH: mkdtempSync(join(tmpdir(), "no-browsers-")),
        },
        timeout: 30_000,
      },
    );
    await expect(run).rejects.toMatchObject({
      code: 1,
      killed: false,
      stderr: expect.stringContaining("Executable doesn't exist"),
    });
  }, 60_000);
});

describe("runTool budget", () => {
  it("keeps a walk cut short by the page budget as a partial result with the budget error", async () => {
    const browser = await chromium.launch();
    try {
      const links = Array.from(
        { length: 40 },
        (_, i) => `<a href="#${i}">L${i}</a>`,
      ).join("");
      // 40 links plan 210 presses (~35 s); a 1.5 s budget stops the walk after a few.
      const out = await runTool(
        browser,
        { localOnly: true, deadline: Date.now() + 1_500, budgetMs: 1_500 },
        async (page) => {
          await page.setContent(`<!doctype html><title>t</title>${links}`);
          return runTabWalk(page);
        },
      );
      expect(out.budgetExceeded).toBe(true);
      expect(out.error).toContain("page budget of 1500 ms exceeded");
      expect(out.value).not.toBeNull();
      const walk = TabWalkResultSchema.parse(out.value);
      expect(walk.presses).toBe(210);
      expect(walk.steps.length).toBeGreaterThan(0);
      expect(walk.steps.length).toBeLessThan(210);
      expect(walk.error?.phase).toBe("walk");
      expect(walk.suspectedTrap).toBeNull();
    } finally {
      await browser.close();
    }
  }, 120_000);

  it("skips a tool whose page budget is already spent, without opening a context", async () => {
    const out = await runTool(
      // Never touched: the budget check comes first.
      null as unknown as Parameters<typeof runTool>[0],
      { localOnly: true, deadline: Date.now() - 1, budgetMs: 10 },
      async () => "unreachable",
    );
    expect(out).toMatchObject({
      value: null,
      budgetExceeded: true,
      error: "page budget of 10 ms exhausted before this tool started",
    });
  });
});

describe("runTool when a context cannot be set up", () => {
  // runTool gets no context handle back when openPage throws, so nothing else closes it before the
  // browser does at the end of the run: each failed tool on each page would leave one behind.
  it.each(["route", "newPage"] as const)(
    "closes the context it opened when %s() then throws",
    async (method) => {
      const browser = await chromium.launch();
      try {
        const failing = {
          newContext: async () =>
            Object.assign(await browser.newContext(), {
              [method]: () => Promise.reject(new Error(`${method} failed`)),
            }),
        } as unknown as Parameters<typeof runTool>[0];
        const out = await runTool(
          failing,
          { localOnly: true, deadline: Date.now() + 10_000, budgetMs: 10_000 },
          async () => "unreachable",
        );
        expect(out).toMatchObject({
          value: null,
          error: `could not open a browser context: ${method} failed`,
        });
        expect(browser.contexts()).toHaveLength(0);
      } finally {
        await browser.close();
      }
    },
    60_000,
  );
});

// The legacy column replays the walk's presses, so its label must say whether THAT replay was cut
// short or ran on the placeholder -- not merely whether the walk tool hit its budget somewhere.
describe("legacyFrom labels the legacy replay", () => {
  let walk: TabWalkResult;
  const outcome = (
    over: Partial<Parameters<typeof legacyFrom>[0]>,
  ): Parameters<typeof legacyFrom>[0] => ({
    value: walk,
    error: null,
    budgetExceeded: false,
    durationMs: 0,
    load: null,
    blocked: [],
    ...over,
  });
  const load = (
    secondNavigation: LoadFacts["secondNavigation"],
  ): LoadFacts => ({
    requestedUrl: "http://127.0.0.1/p",
    finalUrl: "http://127.0.0.1/p",
    status: 200,
    title: "t",
    mainFrameNavigations: 1,
    secondNavigation,
    blockedRequests: 0,
  });

  beforeAll(async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(
        '<!doctype html><title>t</title><a href="#a">A</a><a href="#b">B</a>',
      );
      walk = await runTabWalk(page);
    } finally {
      await browser.close();
    }
    expect(walk.error).toBeNull();
    expect(walk.steps.length).toBe(walk.presses);
  }, 120_000);

  it("calls a replay complete when the budget fired after the last press (escape probe cut)", () => {
    const { run } = legacyFrom(
      outcome({
        value: {
          ...walk,
          escapeProbe: null,
          error: {
            phase: "escapeProbe",
            index: 1,
            message: "Target page, context or browser has been closed",
          },
        },
        error: "page budget of 1500 ms exceeded; context closed",
        budgetExceeded: true,
      }),
    );
    expect(run).toMatchObject({ status: "ok", error: null });
    expect(run.findings?.presses).toBe(walk.presses);
  });

  it("still marks a walk cut mid-press partial, with how far it got", () => {
    const { run } = legacyFrom(
      outcome({
        value: {
          ...walk,
          steps: walk.steps.slice(0, 3),
          error: { phase: "walk", index: 4, message: "closed" },
        },
        error: "page budget of 1500 ms exceeded; context closed",
        budgetExceeded: true,
      }),
    );
    expect(run).toMatchObject({
      status: "partial",
      error: `walked 3 of ${walk.presses} planned stops: the walk stopped early`,
    });
  });

  it("marks a replay of a walk that ran on the placeholder partial, as the walk itself is", () => {
    const { run } = legacyFrom(
      outcome({
        error: "second navigation never came: this ran on the placeholder",
        load: load("missing"),
      }),
    );
    expect(run.status).toBe("partial");
    expect(run.error).toBe(
      "second navigation never came: this ran on the placeholder",
    );
    expect(run.findings).not.toBeNull();
  });

  it("leaves a complete replay of a page whose second navigation came ok", () => {
    const { run } = legacyFrom(outcome({ load: load("seen") }));
    expect(run).toMatchObject({ status: "ok", error: null });
  });
});

// A date input is one Tab stop the walk takes in several presses (its fields, then its picker button), and the
// walk is budgeted in stops, so the counts the bench records must be stops too.
describe("walkStats and the cut-walk message count a date input's presses as one stop", () => {
  let walk: TabWalkResult;

  beforeAll(async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(
        '<!doctype html><title>t</title><input type="date"><a href="#b">B</a>',
      );
      walk = await runTabWalk(page);
    } finally {
      await browser.close();
    }
    expect(walk.error).toBeNull();
    // More presses than stops, or neither test below could tell the two counts apart.
    expect(walk.steps.length).toBeGreaterThan(walk.presses);
  }, 120_000);

  it("records a complete walk as every planned stop walked, not the presses it took", () => {
    expect(walkStats(walk)).toMatchObject({
      F: 2,
      plannedPresses: 20,
      presses: 20,
    });
  });

  it("says how far a cut walk got in stops, not presses: the date input and the link are 2", () => {
    const cut = walk.steps.slice(
      0,
      walk.steps.findIndex((s) => s.settled.tag === "a") + 1,
    );
    const { run } = legacyFrom({
      value: {
        ...walk,
        steps: cut,
        error: { phase: "walk", index: cut.length + 1, message: "closed" },
      },
      error: "page budget of 1500 ms exceeded; context closed",
      budgetExceeded: true,
      durationMs: 0,
      load: null,
      blocked: [],
    });
    expect(run.error).toBe(
      "walked 2 of 20 planned stops: the walk stopped early",
    );
  });
});

describe("checkHeldOutTree (test-live preflight)", () => {
  const clean = { dirty: false, dirtyPaths: [] };
  const committed = (path: string) => ({
    path,
    tracked: true,
    unmodified: true,
  });
  const draw = [
    committed("bench/test-sites/candidates.json"),
    committed("bench/test-sites/accepted.json"),
  ];

  it("passes a clean tree whose draw files are committed and unmodified", () => {
    expect(() => checkHeldOutTree(clean, draw)).not.toThrow();
  });

  it("refuses any uncommitted path, naming it", () => {
    const dirty = { dirty: true, dirtyPaths: ["bench/report.ts"] };
    expect(() => checkHeldOutTree(dirty, draw)).toThrow(Refusal);
    expect(() => checkHeldOutTree(dirty, draw)).toThrow(
      "test-live runs only on a clean, committed tree; 1 uncommitted path(s) outside bench/results/ (bench/report.ts)",
    );
  });

  it("refuses an untracked or modified draw file even on an otherwise clean tree", () => {
    const untracked = [
      draw[0],
      { ...draw[1], tracked: false, unmodified: true },
    ];
    expect(() => checkHeldOutTree(clean, untracked)).toThrow(
      "bench/test-sites/accepted.json must be committed and unmodified",
    );
    const modified = [{ ...draw[0], unmodified: false }, draw[1]];
    expect(() => checkHeldOutTree(clean, modified)).toThrow(
      "bench/test-sites/candidates.json must be committed and unmodified",
    );
  });
});

describe("dirtyPathsFrom", () => {
  it("counts tracked and untracked changes but never the results tree itself", () => {
    const porcelain = [
      " M bench/run.ts",
      "?? bench/new.ts",
      "?? bench/results/abc1234/dev-fixtures/summary.json",
      "R  a.ts -> b.ts",
      "",
    ].join("\n");
    expect(dirtyPathsFrom(porcelain)).toEqual([
      "bench/run.ts",
      "bench/new.ts",
      "b.ts",
    ]);
  });
});

// A live page can crash the browser outright. One browser serves the whole set, so without a
// relaunch every REMAINING page fails to open a context and is recorded as a tool error -- on the
// test-live run at 722307b that cost 14 of 20 pages, and the run still reported complete and
// exited 0. Pages the instrument never looked at must not be silently priced in.
describe("a crashed browser does not cost the rest of the set", () => {
  it("hands back the same browser while it is alive", async () => {
    const browser = await chromium.launch();
    try {
      const again = await liveBrowser(browser);
      expect(again).toBe(browser);
      expect(again.isConnected()).toBe(true);
    } finally {
      await browser.close();
    }
  });

  it("relaunches once the browser has died, so later pages can still be measured", async () => {
    const browser = await chromium.launch();
    await browser.close();
    expect(browser.isConnected()).toBe(false);
    const replacement = await liveBrowser(browser);
    try {
      expect(replacement).not.toBe(browser);
      expect(replacement.isConnected()).toBe(true);
      // The point of relaunching: a context opens again.
      const context = await replacement.newContext();
      await context.close();
    } finally {
      await replacement.close();
    }
  }, 60_000);
});
