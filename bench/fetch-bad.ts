// Vendors the W3C Before-and-After Demonstration (BAD) and pins it with a sha256 manifest.
// Plain HTTP only: Cloudflare blocks headless Chromium on w3.org (bench/probes/reach/RESULT.md).
// `node --import tsx`, not `npx tsx`: the tsx CLI opens an IPC pipe the Claude Bash sandbox refuses.
//   node --import tsx bench/fetch-bad.ts                     download, unzip, rewrite the manifest (re-pin)
//   node --import tsx bench/fetch-bad.ts --fetch-if-missing  fetch only when bench/vendor/bad is absent; keeps an existing pin
//   node --import tsx bench/fetch-bad.ts --verify            re-hash bench/vendor/bad; exit 1 on any missing or changed file
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";

const run = promisify(execFile);

const SOURCE_URL = "https://www.w3.org/WAI/demos/bad/bad.zip";
const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = path.join(BENCH_DIR, "vendor", "bad");
const MANIFEST_PATH = path.join(
  BENCH_DIR,
  "corpus",
  "test",
  "bad-manifest.json",
);

const PAGE_NAMES = ["home", "news", "tickets", "survey"] as const;
// The 8 demo pages and their 8 W3C evaluation reports; a fetch without all 16 is useless to the bench.
const REQUIRED_FILES = (["before", "after"] as const).flatMap((side) =>
  PAGE_NAMES.flatMap((name) => [
    `${side}/${name}.html`,
    `${side}/reports/${name}.html`,
  ]),
);

const SHA256_HEX = z.string().regex(/^[0-9a-f]{64}$/);
const BadManifestSchema = z.object({
  sourceUrl: z.string().url(),
  fetchedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  zipSha256: SHA256_HEX,
  zipBytes: z.number().int().positive(),
  files: z.record(SHA256_HEX),
});
type BadManifest = z.infer<typeof BadManifestSchema>;

type Mode = "fetch" | "fetch-if-missing" | "verify";

function parseMode(args: readonly string[]): Mode {
  if (args.length === 0) return "fetch";
  if (args.length === 1 && args[0] === "--verify") return "verify";
  if (args.length === 1 && args[0] === "--fetch-if-missing")
    return "fetch-if-missing";
  throw new Error(
    `usage: node --import tsx bench/fetch-bad.ts [--verify | --fetch-if-missing] (got: ${args.join(" ")})`,
  );
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(root: string, rel = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, rel), { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return listFiles(root, child);
      return entry.isFile() ? [child] : [];
    }),
  );
  return nested.flat().sort();
}

async function hashTree(root: string): Promise<Record<string, string>> {
  const files = await listFiles(root);
  const hashes = await Promise.all(
    files.map(async (rel) => sha256(await readFile(path.join(root, rel)))),
  );
  return Object.fromEntries(files.map((rel, i) => [rel, hashes[i]]));
}

async function readManifest(): Promise<BadManifest | null> {
  if (!(await exists(MANIFEST_PATH))) return null;
  return BadManifestSchema.parse(
    JSON.parse(await readFile(MANIFEST_PATH, "utf8")),
  );
}

type Download = {
  zipSha256: string;
  zipBytes: number;
  files: Record<string, string>;
};

// Extracts into a sibling staging dir and swaps it in, so a failed fetch never leaves a half-written vendor copy.
async function downloadAndExtract(): Promise<Download> {
  const workDir = await mkdtemp(path.join(tmpdir(), "bad-zip-"));
  await mkdir(path.dirname(VENDOR_DIR), { recursive: true });
  const stagingDir = await mkdtemp(
    path.join(path.dirname(VENDOR_DIR), ".bad-staging-"),
  );
  try {
    const zipPath = path.join(workDir, "bad.zip");
    await run("curl", [
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "--retry",
      "2",
      "-o",
      zipPath,
      SOURCE_URL,
    ]);
    const zip = await readFile(zipPath);
    await run("unzip", ["-q", zipPath, "-d", stagingDir]);
    const files = await hashTree(stagingDir);
    const missing = REQUIRED_FILES.filter((rel) => !(rel in files));
    if (missing.length > 0)
      throw new Error(`bad.zip lacks required files: ${missing.join(", ")}`);
    await rm(VENDOR_DIR, { recursive: true, force: true });
    await rename(stagingDir, VENDOR_DIR);
    return { zipSha256: sha256(zip), zipBytes: zip.length, files };
  } finally {
    await rm(workDir, { recursive: true, force: true });
    await rm(stagingDir, { recursive: true, force: true });
  }
}

async function writeManifest(download: Download): Promise<void> {
  const manifest: BadManifest = {
    sourceUrl: SOURCE_URL,
    fetchedOn: new Date().toISOString().slice(0, 10),
    ...download,
  };
  await mkdir(path.dirname(MANIFEST_PATH), { recursive: true });
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `wrote ${path.relative(process.cwd(), MANIFEST_PATH)}: ${Object.keys(download.files).length} files, zip ${download.zipBytes} bytes sha256 ${download.zipSha256}`,
  );
}

async function verify(manifest: BadManifest): Promise<boolean> {
  const actual = (await exists(VENDOR_DIR)) ? await hashTree(VENDOR_DIR) : {};
  const expected = Object.entries(manifest.files);
  const missing = expected
    .filter(([rel]) => !(rel in actual))
    .map(([rel]) => rel);
  const changed = expected
    .filter(([rel, hash]) => rel in actual && actual[rel] !== hash)
    .map(([rel]) => rel);
  const extra = Object.keys(actual).filter((rel) => !(rel in manifest.files));
  for (const rel of missing) console.error(`MISSING  ${rel}`);
  for (const rel of changed) console.error(`CHANGED  ${rel}`);
  // Extra files are reported but tolerated: they cannot alter a pinned page.
  for (const rel of extra) console.warn(`EXTRA    ${rel} (not in manifest)`);
  const ok = missing.length === 0 && changed.length === 0;
  console.log(
    `verify ${ok ? "OK" : "FAILED"}: ${expected.length - missing.length - changed.length}/${expected.length} files match` +
      ` (missing ${missing.length}, changed ${changed.length}, extra ${extra.length})`,
  );
  return ok;
}

async function main(): Promise<number> {
  const mode = parseMode(process.argv.slice(2));

  if (mode === "verify") {
    const manifest = await readManifest();
    if (!manifest)
      throw new Error(
        `no manifest at ${MANIFEST_PATH}; run without flags to create one`,
      );
    return (await verify(manifest)) ? 0 : 1;
  }

  if (mode === "fetch-if-missing" && (await exists(VENDOR_DIR))) {
    console.log(
      `${path.relative(process.cwd(), VENDOR_DIR)} present; not fetching (run --verify to check it)`,
    );
    return 0;
  }

  const pinned = await readManifest();
  const download = await downloadAndExtract();
  console.log(
    `fetched ${SOURCE_URL} -> ${path.relative(process.cwd(), VENDOR_DIR)}`,
  );

  if (mode === "fetch-if-missing" && pinned) {
    // Keep the committed pin authoritative: a fresh checkout must reproduce it, not silently re-pin.
    if (download.zipSha256 !== pinned.zipSha256) {
      console.error(
        `zip sha256 ${download.zipSha256} differs from pinned ${pinned.zipSha256}; upstream changed`,
      );
    }
    return (await verify(pinned)) ? 0 : 1;
  }

  if (pinned && pinned.zipSha256 !== download.zipSha256) {
    console.warn(
      `re-pinning: zip sha256 changed ${pinned.zipSha256} -> ${download.zipSha256}`,
    );
  }
  await writeManifest(download);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);
