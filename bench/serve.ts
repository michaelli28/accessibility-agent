// Serves the bench corpora for hand-testing on a FIXED port, so the links in bench/SPOTCHECK.md stay valid.
// Before listening it vendors + verifies W3C BAD (bench/fetch-bad.ts) and builds the React base if its bundle is missing.
//   npx tsx bench/serve.ts [--port <n>] [--variants <dir>] [--no-fetch]
//     --port 0         picks a free port (the test uses it)
//     --variants <dir> serves <dir> as /variants/ instead of bench/corpus/dev/variants (e.g. a seed.ts --out dir)
//     --no-fetch       never downloads BAD: /bad/ is served only if bench/vendor/bad is already vendored
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  REACT_BUNDLE,
  buildReactBase,
} from "./corpus/dev/base/react-div-button/build.js";
import { startStaticServer } from "./seed.js";

const BENCH = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(BENCH, "..");

export const SERVE_PORT = 4173;
export const SERVE_ORIGIN = `http://127.0.0.1:${SERVE_PORT}`;

export const MOUNTS = {
  "/corpus/": join(BENCH, "corpus"),
  "/variants/": join(BENCH, "corpus", "dev", "variants"),
  "/bad/": join(BENCH, "vendor", "bad"),
} as const;
export type Mount = keyof typeof MOUNTS;

export const serveUrl = (
  mount: Mount,
  rel: string,
  origin = SERVE_ORIGIN,
): string => `${origin}${mount}${encodeURI(rel)}`;

// fetch-bad runs on import, so it gets its own process; `node --import tsx` because the tsx CLI's IPC pipe is refused
// inside the Claude Bash sandbox.
function runFetchBad(flag: "--fetch-if-missing" | "--verify"): void {
  execFileSync(
    process.execPath,
    ["--import", "tsx", join(BENCH, "fetch-bad.ts"), flag],
    { cwd: ROOT, stdio: "inherit" },
  );
}

function exampleUrls(
  origin: string,
  served: Map<Mount, string>,
): [Mount, string][] {
  const variantsDir = served.get("/variants/");
  const variant =
    variantsDir !== undefined && existsSync(variantsDir)
      ? readdirSync(variantsDir)
          .filter((f) => f.endsWith(".html"))
          .sort()[0]
      : undefined;
  return [
    ["/corpus/", serveUrl("/corpus/", "dev/base/navbar.html", origin)],
    [
      "/variants/",
      variant === undefined
        ? `${origin}/variants/ (empty: run npx tsx bench/seed.ts)`
        : serveUrl("/variants/", variant, origin),
    ],
    [
      "/bad/",
      served.has("/bad/")
        ? serveUrl("/bad/", "before/home.html", origin)
        : `${origin}/bad/ (not served: bench/vendor/bad is absent and --no-fetch was given)`,
    ],
  ];
}

const ArgsSchema = z.object({
  port: z.coerce.number().int().min(0).max(65535).default(SERVE_PORT),
  variants: z.string().min(1).default(MOUNTS["/variants/"]),
  "no-fetch": z.boolean().default(false),
});
type Args = z.infer<typeof ArgsSchema>;

function readArgs(argv: readonly string[]): Args {
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        port: { type: "string" },
        variants: { type: "string" },
        "no-fetch": { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    });
    return ArgsSchema.parse(values);
  } catch (e: unknown) {
    throw new Error(
      `usage: npx tsx bench/serve.ts [--port <n>] [--variants <dir>] [--no-fetch] (got: ${argv.join(" ")}): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const args = readArgs(argv);
  if (!args["no-fetch"]) runFetchBad("--fetch-if-missing");
  const hasBad = existsSync(MOUNTS["/bad/"]);
  if (hasBad) runFetchBad("--verify");
  if (!existsSync(REACT_BUNDLE)) {
    console.log("building the React base (react-div-button/app.js)");
    await buildReactBase();
  }
  const served = new Map<Mount, string>([
    ["/corpus/", MOUNTS["/corpus/"]],
    ["/variants/", resolve(args.variants)],
    ...(hasBad ? [["/bad/", MOUNTS["/bad/"]] as const] : []),
  ]);
  const server = await startStaticServer(Object.fromEntries(served), args.port);
  console.log(`bench server on ${server.origin}`);
  for (const [mount, url] of exampleUrls(server.origin, served)) {
    const dir = served.get(mount);
    console.log(
      `  ${mount.padEnd(11)} ${(dir === undefined ? "-" : relative(ROOT, dir)).padEnd(26)} ${url}`,
    );
  }
  console.log("checklist: bench/SPOTCHECK.md · Ctrl+C to stop");
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    const inUse = e instanceof Error && "code" in e && e.code === "EADDRINUSE";
    console.error(
      inUse
        ? `port in use: is bench/serve.ts already running? SPOTCHECK.md links assume ${SERVE_ORIGIN}`
        : e,
    );
    process.exitCode = 1;
  });
}
