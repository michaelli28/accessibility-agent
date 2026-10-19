// Bundles the React fixture against a pinned React in the gitignored bench/corpus/dev/.deps (never the repo's
// package.json), the same approach as bench/probes/react/build.mjs. app.js is gitignored; esbuild output is deterministic.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const HERE = dirname(fileURLToPath(import.meta.url));
const REACT_VERSION = "18.3.1";
// Long enough for a cold `npm install` on a slow network, short enough to fail the suite rather than hang.
const LOCK_WAIT_MS = 180_000;
const PREFIX = resolve(HERE, "..", "..", ".deps", `react-${REACT_VERSION}`);
const NODE_MODULES = join(PREFIX, "node_modules");
export const REACT_BUNDLE = join(HERE, "app.js");

const PackageJsonSchema = z.object({ version: z.string() });

function installedVersion(pkg: string): string | null {
  const file = join(NODE_MODULES, pkg, "package.json");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null; // absent, or moved aside by the installer below while we read
  }
  return PackageJsonSchema.parse(JSON.parse(text)).version;
}

// Written only after npm install succeeded in a private directory. A raced install from before this
// guard left react-dom's package.json without client.js, which read as installed by version alone.
const COMPLETE_MARKER = join(PREFIX, ".complete");

const pinned = (): boolean =>
  existsSync(COMPLETE_MARKER) &&
  installedVersion("react") === REACT_VERSION &&
  installedVersion("react-dom") === REACT_VERSION;

// Waits for whoever holds the lock directory, then re-checks: one process installs, the rest use it.
// Without this, callers read PREFIX while another moved an unmarked install aside, and the read threw.
function waitForInstaller(lock: string): boolean {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    if (pinned()) return true;
    if (!existsSync(lock)) return false; // holder died or finished without installing; take a turn
  }
  // A lock this old belongs to a process that was killed mid-install.
  rmSync(lock, { recursive: true, force: true });
  return false;
}

// Bench test files run in parallel and several build this fixture, so on a fresh checkout their
// installs raced into PREFIX and npm deleted each other's files. One caller at a time installs into a
// private directory and renames it into place; PREFIX only ever appears complete, marker and all.
function ensurePinnedReact(): void {
  if (pinned()) return;
  const lock = `${PREFIX}.lock`;
  mkdirSync(dirname(PREFIX), { recursive: true });
  let holding = false;
  for (let attempt = 0; attempt < 3 && !holding; attempt++) {
    if (pinned()) return;
    try {
      mkdirSync(lock); // fails while another caller holds it
      holding = true;
    } catch {
      if (waitForInstaller(lock)) return; // their install finished; use it
    }
  }
  if (!holding)
    throw new Error(`could not take ${lock} to install react ${REACT_VERSION}`);
  if (pinned()) {
    rmSync(lock, { recursive: true, force: true }); // installed while we waited
    return;
  }
  const staging = `${PREFIX}.staging-${process.pid}`;
  const stale = (n: number): string => `${PREFIX}.stale-${process.pid}-${n}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    execFileSync(
      "npm",
      [
        "install",
        "--prefix",
        staging,
        "--no-audit",
        "--no-fund",
        "--prefer-offline",
        `react@${REACT_VERSION}`,
        `react-dom@${REACT_VERSION}`,
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    writeFileSync(join(staging, ".complete"), REACT_VERSION);
    // The rename lands only on a missing (or empty) PREFIX, so a marked install is never replaced. An
    // unmarked one was left by an older, unguarded install and nothing can land until it is moved.
    for (let n = 0; n < 3 && !pinned(); n++) {
      try {
        renameSync(staging, PREFIX);
      } catch {
        if (pinned()) break; // another caller's install landed first
        try {
          renameSync(PREFIX, stale(n));
        } catch {
          // Another caller moved the unmarked install first; retry the rename.
        }
      }
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
    for (let n = 0; n < 3; n++)
      rmSync(stale(n), { recursive: true, force: true });
    rmSync(lock, { recursive: true, force: true });
  }
  if (!pinned())
    throw new Error(
      `react/react-dom ${REACT_VERSION} missing from ${NODE_MODULES} after npm install`,
    );
}

export async function buildReactBase(): Promise<void> {
  ensurePinnedReact();
  const result = await build({
    entryPoints: [join(HERE, "src", "main.jsx")],
    bundle: true,
    format: "iife",
    minify: true,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    nodePaths: [NODE_MODULES],
    outfile: REACT_BUNDLE,
    metafile: true,
    logLevel: "warning",
  });
  // Bare imports resolve up the directory tree before nodePaths, so prove every package came from the pinned install.
  const foreign = Object.keys(result.metafile.inputs)
    .filter((p) => p.includes("node_modules/"))
    .map((p) => resolve(p))
    .filter((p) => !p.startsWith(NODE_MODULES + sep));
  if (foreign.length > 0)
    throw new Error(
      `React bundle pulled packages from outside ${NODE_MODULES}: ${foreign[0]}`,
    );
}
