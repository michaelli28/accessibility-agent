// Spawns the real CLI with --port 0 (4173 may be taken, e.g. by `vite preview`) and fetches one file from each mount.
// `node --import tsx`, not the tsx CLI: the CLI's IPC pipe is refused inside the Claude Bash sandbox.
// Runs on a fresh checkout: /variants/ is a temp dir holding one synthetic variant (--variants), and when the
// gitignored bench/vendor/bad is absent the server runs with --no-fetch (vendoring BAD needs the network) and the /bad/
// checks are skipped with a printed reason. Vendor it first to run them: node --import tsx bench/fetch-bad.ts
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { MOUNTS } from "./serve.js";

const BENCH = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(BENCH, "..");
const LONG = 180_000;
const HAS_BAD = existsSync(MOUNTS["/bad/"]);
const VARIANT = "fixture__M2__button.html";

if (!HAS_BAD) {
  console.warn(
    "serve.test.ts: SKIPPING the /bad/ checks: bench/vendor/bad is absent and vendoring it needs the network, so " +
      "serve.ts runs with --no-fetch (vendor it with: node --import tsx bench/fetch-bad.ts)",
  );
}

let child: ChildProcess | undefined;
let origin = "";
let output = "";
let variantsDir = "";

function waitForOrigin(proc: ChildProcess): Promise<string> {
  return new Promise((resolveOrigin, reject) => {
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      const m = /bench server on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      // The banner's last line, so every example URL has been printed too.
      if (m && output.includes("Ctrl+C to stop")) resolveOrigin(m[1]);
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    proc.once("exit", (code) =>
      reject(new Error(`serve.ts exited ${code} before listening:\n${output}`)),
    );
  });
}

beforeAll(async () => {
  variantsDir = mkdtempSync(join(tmpdir(), "bench-serve-"));
  writeFileSync(
    join(variantsDir, VARIANT),
    '<!doctype html><title>fixture</title><div role="button" data-bench-id="button">Go</div>\n',
  );
  child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      join(BENCH, "serve.ts"),
      "--port",
      "0",
      "--variants",
      variantsDir,
      ...(HAS_BAD ? [] : ["--no-fetch"]),
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  origin = await waitForOrigin(child);
}, LONG);

afterAll(async () => {
  const proc = child;
  if (proc && proc.exitCode === null) {
    const exited = new Promise((done) => proc.once("exit", done));
    proc.kill("SIGTERM");
    await exited;
  }
  if (variantsDir) rmSync(variantsDir, { recursive: true, force: true });
});

async function get(
  path: string,
): Promise<{ status: number; type: string; body: string }> {
  const res = await fetch(`${origin}${path}`);
  return {
    status: res.status,
    type: res.headers.get("content-type") ?? "",
    body: await res.text(),
  };
}

describe("bench/serve.ts", () => {
  it("prints an example URL for every mount", () => {
    for (const mount of ["/corpus/", "/variants/", "/bad/"]) {
      expect(output).toContain(`${origin}${mount}`);
    }
  });

  it("serves a dev base page under /corpus/", async () => {
    const r = await get("/corpus/dev/base/navbar.html");
    expect(r.status).toBe(200);
    expect(r.type).toMatch(/^text\/html/);
    expect(r.body).toContain('data-bench-id="brand"');
  });

  it("serves the React base bundle", async () => {
    const r = await get("/corpus/dev/base/react-div-button/app.js");
    expect(r.status).toBe(200);
    expect(r.type).toMatch(/^text\/javascript/);
  });

  it("serves the --variants directory under /variants/ and names a file from it", async () => {
    expect(output).toContain(`${origin}/variants/${VARIANT}`);
    const r = await get(`/variants/${VARIANT}`);
    expect(r.status).toBe(200);
    expect(r.type).toMatch(/^text\/html/);
    expect(r.body).toContain('data-bench-id="button"');
  });

  // A stray `%`, a `%00` or a `//` target threw inside the handler and killed the server, and
  // bench/run.ts runs the same server in its own process.
  it("answers malformed paths with 400 and keeps serving", async () => {
    for (const path of [
      "/corpus/dev/base/100%.png",
      "/corpus/a%00b.html",
      "//",
    ]) {
      expect((await get(path)).status, path).toBe(400);
    }
    expect((await get("/corpus/dev/base/navbar.html")).status).toBe(200);
  });

  // green-guard: allow environment-gated: bench/vendor/bad is gitignored and vendoring it needs the network; the
  // reason is printed above and the no-fetch branch below runs instead.
  it.skipIf(!HAS_BAD)(
    "serves the vendored W3C BAD demo under /bad/, stylesheets included",
    async () => {
      const page = await get("/bad/before/home.html");
      expect(page.status).toBe(200);
      expect(page.type).toMatch(/^text\/html/);
      const manifest = z
        .object({ files: z.record(z.string()) })
        .parse(
          JSON.parse(
            readFileSync(
              join(BENCH, "corpus", "test", "bad-manifest.json"),
              "utf8",
            ),
          ),
        );
      const css = Object.keys(manifest.files)
        .filter((f) => f.endsWith(".css"))
        .sort()[0];
      const sheet = await get(`/bad/${css}`);
      expect(sheet.status).toBe(200);
      expect(sheet.type).toMatch(/^text\/css/);
    },
  );

  it.runIf(!HAS_BAD)(
    "with --no-fetch and no vendored BAD, says /bad/ is not served and 404s it",
    async () => {
      expect(output).toContain(`${origin}/bad/ (not served:`);
      expect((await get("/bad/before/home.html")).status).toBe(404);
    },
  );

  it("404s outside the mounts and on an encoded ../ escape", async () => {
    expect((await get("/package.json")).status).toBe(404);
    expect((await get("/corpus/%2e%2e%2fstats.ts")).status).toBe(404);
  });
});
