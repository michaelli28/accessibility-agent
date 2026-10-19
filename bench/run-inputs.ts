// What a bench/run.ts run reads before it launches a browser: the page sets (with their preflight checks and
// refusals) and the git state the results are stamped with.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  REACT_BUNDLE,
  buildReactBase,
} from "./corpus/dev/base/react-div-button/build.js";
import {
  BaseLabelsFileSchema,
  LiveSitesFileSchema,
  VariantLabelsFileSchema,
} from "./corpus/labels-schema.js";
import type { PageSet, Summary } from "./results-schema.js";
import { MOUNTS, type Mount } from "./serve.js";

const BENCH = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(BENCH, "..");

const DEV_DIR = join(BENCH, "corpus", "dev");
// Scripts dev bases load from a file (the React bundle aside): an edit to one changes the page without touching it.
const DEV_BASE_SCRIPTS = ["native-dialog.js", "remount-on-keydown.js"].map(
  (f) => join(DEV_DIR, "base", f),
);
const VARIANTS_DIR = MOUNTS["/variants/"];
const BAD_LABELS = join(BENCH, "corpus", "test", "bad-labels.json");
const BAD_MANIFEST = join(BENCH, "corpus", "test", "bad-manifest.json");
const CANDIDATES = join(BENCH, "test-sites", "candidates.json");
const ACCEPTED = join(BENCH, "test-sites", "accepted.json");
const BAD_PAGES = (["before", "after"] as const).flatMap((side) =>
  (["home", "news", "tickets", "survey"] as const).map(
    (name) => `${side}/${name}`,
  ),
);

export class UsageError extends Error {}
export class Refusal extends Error {}

export type Target =
  | { kind: "local"; mount: Mount; rel: string }
  | { kind: "live"; url: string };
export type PageSpec = {
  pageId: string;
  cluster: string;
  target: Target;
  // The first response is a placeholder; the page only exists after the next main-frame navigation.
  secondNavigation: boolean;
};
export type ResolvedPage = PageSpec & { url: string };
export type Prepared = {
  pages: PageSpec[];
  inputs: string[];
  localOnly: boolean;
};

function git(args: readonly string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

// `git status --porcelain` lines; renames keep the new path. The results tree is output, not code.
export function dirtyPathsFrom(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => {
      const path = line.slice(3);
      const arrow = path.indexOf(" -> ");
      return arrow === -1 ? path : path.slice(arrow + 4);
    })
    .filter((path) => !path.startsWith("bench/results/"));
}

export function readGitState(): Summary["git"] {
  // Untracked files count: an untracked module run.ts imports is code the commit does not contain.
  const dirtyPaths = dirtyPathsFrom(git(["status", "--porcelain"]));
  return {
    sha: git(["rev-parse", "HEAD"]).trim(),
    shortSha: git(["rev-parse", "--short", "HEAD"]).trim(),
    dirty: dirtyPaths.length > 0,
    dirtyPaths,
  };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

// Helper scripts in their own process: fetch-bad runs on import. `node --import tsx` because the tsx CLI's IPC pipe
// is refused inside the Claude Bash sandbox.
function runScript(script: string, args: readonly string[]): number {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", join(BENCH, script), ...args],
    {
      cwd: ROOT,
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  return r.status ?? 1;
}

export async function prepare(set: PageSet): Promise<Prepared> {
  switch (set) {
    case "dev-fixtures": {
      await buildReactBase();
      const labelsPath = join(DEV_DIR, "labels.json");
      const labels = BaseLabelsFileSchema.parse(readJson(labelsPath));
      const pages = Object.entries(labels.pages).map(([pageId, p]) => ({
        pageId,
        cluster: pageId,
        target: {
          kind: "local" as const,
          mount: "/corpus/" as const,
          rel: `dev/${p.file}`,
        },
        secondNavigation: false,
      }));
      const files = Object.values(labels.pages).map((p) =>
        join(DEV_DIR, p.file),
      );
      return {
        pages,
        inputs: [labelsPath, ...files, ...DEV_BASE_SCRIPTS, REACT_BUNDLE],
        localOnly: true,
      };
    }
    case "dev-variants": {
      const labelsPath = join(VARIANTS_DIR, "labels.json");
      if (!existsSync(labelsPath) && runScript("seed.ts", []) !== 0) {
        throw new Refusal("bench/seed.ts could not generate the variants");
      }
      const check = runScript("seed.ts", ["--check"]);
      if (check !== 0)
        throw new Refusal(
          `bench/seed.ts --check failed (exit ${check}); regenerate or fix the variants`,
        );
      const labels = VariantLabelsFileSchema.parse(readJson(labelsPath));
      const pages = Object.entries(labels.variants).map(([pageId, v]) => ({
        pageId,
        cluster: v.base,
        target: {
          kind: "local" as const,
          mount: "/variants/" as const,
          rel: v.file,
        },
        secondNavigation: false,
      }));
      const files = Object.values(labels.variants).map((v) =>
        join(VARIANTS_DIR, v.file),
      );
      return { pages, inputs: [labelsPath, ...files], localOnly: true };
    }
    case "test-bad": {
      for (const flag of ["--fetch-if-missing", "--verify"]) {
        const code = runScript("fetch-bad.ts", [flag]);
        if (code !== 0)
          throw new Refusal(`bench/fetch-bad.ts ${flag} failed (exit ${code})`);
      }
      const pages = BAD_PAGES.map((pageId) => ({
        pageId,
        // One site: every BAD page shares authors and templates, so the 8 pages are one cluster.
        cluster: "w3c-bad",
        target: {
          kind: "local" as const,
          mount: "/bad/" as const,
          rel: `${pageId}.html`,
        },
        secondNavigation: false,
      }));
      return { pages, inputs: [BAD_LABELS, BAD_MANIFEST], localOnly: true };
    }
    case "dev-live": {
      const sitesPath = join(DEV_DIR, "live-sites.json");
      const sites = LiveSitesFileSchema.parse(readJson(sitesPath)).sites;
      const pages = sites.map((s) => ({
        pageId: s.id,
        cluster: s.id,
        target: { kind: "live" as const, url: s.url },
        secondNavigation: s.flags.includes("second-navigation"),
      }));
      return { pages, inputs: [sitesPath], localOnly: false };
    }
    case "test-live":
      return prepareTestLive();
  }
}

const CandidatesCompleteSchema = z
  .object({ complete: z.boolean() })
  .passthrough();
const AcceptedSitesSchema = z
  .object({
    complete: z.boolean(),
    accepted: z.array(
      z
        .object({ domain: z.string().min(1), finalUrl: z.string().url() })
        .passthrough(),
    ),
  })
  .passthrough();

export function listPaths(paths: readonly string[]): string {
  return `${paths.slice(0, 5).join(", ")}${paths.length > 5 ? ", ..." : ""}`;
}

export type DrawFileState = {
  path: string;
  tracked: boolean;
  unmodified: boolean;
};

// The held-out set is used once, exactly as pre-registered: from a clean commit (so the results name the code that
// produced them), with the draw files committed and unmodified. Pure so the rule is testable on any tree.
export function checkHeldOutTree(
  gitState: Pick<Summary["git"], "dirty" | "dirtyPaths">,
  drawFiles: readonly DrawFileState[],
): void {
  if (gitState.dirty) {
    throw new Refusal(
      `test-live runs only on a clean, committed tree; ${gitState.dirtyPaths.length} uncommitted path(s) outside bench/results/ (${listPaths(gitState.dirtyPaths)})`,
    );
  }
  for (const f of drawFiles) {
    if (!f.tracked || !f.unmodified) {
      throw new Refusal(`${f.path} must be committed and unmodified`);
    }
  }
}

function drawFileState(file: string): DrawFileState {
  const rel = relative(ROOT, file);
  return {
    path: rel,
    tracked:
      spawnSync("git", ["ls-files", "--error-unmatch", rel], { cwd: ROOT })
        .status === 0,
    unmodified: git(["status", "--porcelain", "--", rel]).trim() === "",
  };
}

function prepareTestLive(): Prepared {
  checkHeldOutTree(readGitState(), [CANDIDATES, ACCEPTED].map(drawFileState));
  if (!CandidatesCompleteSchema.parse(readJson(CANDIDATES)).complete) {
    throw new Refusal(
      "bench/test-sites/candidates.json has complete:false (the pre-registered site draw is unfinished)",
    );
  }
  const accepted = AcceptedSitesSchema.parse(readJson(ACCEPTED));
  if (!accepted.complete)
    throw new Refusal("bench/test-sites/accepted.json has complete:false");
  const pages = accepted.accepted.map((s) => ({
    pageId: s.domain,
    cluster: s.domain,
    target: { kind: "live" as const, url: s.finalUrl },
    secondNavigation: false,
  }));
  return { pages, inputs: [CANDIDATES, ACCEPTED], localOnly: false };
}

export function selectPages(
  pages: PageSpec[],
  filter: string[] | null,
): PageSpec[] {
  const sorted = [...pages].sort((a, b) =>
    a.pageId < b.pageId ? -1 : a.pageId > b.pageId ? 1 : 0,
  );
  if (filter === null) return sorted;
  const unknown = filter.filter((id) => !pages.some((p) => p.pageId === id));
  if (unknown.length > 0) {
    throw new UsageError(
      `unknown page id(s) ${unknown.join(", ")}; known: ${sorted.map((p) => p.pageId).join(", ")}`,
    );
  }
  return sorted.filter((p) => filter.includes(p.pageId));
}
