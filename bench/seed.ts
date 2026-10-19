// Dev-corpus seeder. Loads each static base page in Chromium with page scripts OFF (so the serialized DOM is the
// source DOM, not runtime state), applies one operator to one element, and writes
// <out>/<base>__<op>__<benchId>.html plus <out>/labels.json. Deterministic: same committed inputs, same bytes.
//
// --check re-loads every base and variant with scripts ON and requires that each variant differs from its base in
// EXACTLY one data-bench-id element, comparing per-id outerHTML plus all markup outside tagged elements.
// Inline scripts: M1 and M5-M12 add behaviour a DOM attribute cannot carry (addEventListener), so each appends ONE
// <script data-bench-op data-bench-target> as the last child of <body>. The check accounts for it explicitly: the base
// has none; the variant has exactly the operator's script, byte-equal to what the operator generates for the target,
// last in <body>, and addressing no tagged element but the target; it is then dropped before the rest of the markup is
// compared. M1 also rewrites the target, so its outerHTML must differ. M5-M12 are script-only: every outerHTML must be
// unchanged, and the one-element change is the script bound to the target.
// --check also regenerates everything and fails if the files on disk are stale.
//
// Usage (launches Chromium, so outside the sandbox): npx tsx bench/seed.ts [--check] [--out <dir>]
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFile,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright";
import { z } from "zod";
import { buildReactBase } from "./corpus/dev/base/react-div-button/build.js";
import {
  IN_PAGE_LIB,
  OPERATORS,
  deriveVariantLabels,
  isCleanPage,
  isCleanTarget,
} from "./corpus/dev/operators.js";
import {
  BaseLabelsFileSchema,
  OPERATOR_IDS,
  VariantLabelsFileSchema,
  variantId,
  type BaseLabelsFile,
  type OperatorId,
  type VariantLabels,
  type VariantLabelsFile,
} from "./corpus/labels-schema.js";

const BENCH = dirname(fileURLToPath(import.meta.url));
export const CORPUS_DIR = join(BENCH, "corpus", "dev");
export const DEFAULT_OUT_DIR = join(CORPUS_DIR, "variants");
const VARIANT_FILE = /^[a-z0-9-]+__M(?:[1-9]|1[0-3])__[a-z0-9-]+\.html$/;
const LABELS_FILE = "labels.json";

export type StaticServer = { origin: string; close: () => Promise<void> };

// css and images: bench/serve.ts also serves the vendored W3C BAD pages.
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

// Serves each mount (URL prefix -> directory) from 127.0.0.1; port 0 (the default) picks an ephemeral port.
export function startStaticServer(
  mounts: Record<string, string>,
  port = 0,
): Promise<StaticServer> {
  const server = createServer((req, res) => {
    // A stray `%`, a `%00` or a `//` target throws below, and an uncaught throw here kills
    // bench/run.ts too: it runs this server in its own process.
    try {
      serve(req, res);
    } catch {
      res.writeHead(400).end("bad request");
    }
  });
  const serve = (req: IncomingMessage, res: ServerResponse): void => {
    const pathname = decodeURIComponent(
      new URL(req.url ?? "/", "http://local").pathname,
    );
    const prefix = Object.keys(mounts).find((p) => pathname.startsWith(p));
    const root = prefix === undefined ? undefined : resolve(mounts[prefix]);
    const file =
      root === undefined || prefix === undefined
        ? undefined
        : resolve(root, pathname.slice(prefix.length));
    if (
      root === undefined ||
      file === undefined ||
      !file.startsWith(root + sep)
    ) {
      res.writeHead(404).end("not found");
      return;
    }
    readFile(file, (err, body) => {
      if (err) {
        res.writeHead(404).end("not found");
        return;
      }
      res
        .writeHead(200, {
          "content-type":
            CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
        })
        .end(body);
    });
  };
  return new Promise((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("server has no TCP address"));
        return;
      }
      resolveServer({
        origin: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

const SnapshotSchema = z.object({
  ids: z.array(z.string()),
  html: z.record(z.string(), z.string()),
  scripts: z.array(
    z.object({
      op: z.string().nullable(),
      target: z.string().nullable(),
      text: z.string(),
      lastInBody: z.boolean(),
    }),
  ),
  rest: z.string(),
  hasExternalScript: z.boolean(),
});
type Snapshot = z.infer<typeof SnapshotSchema>;

type Loaded = { page: Page; errors: string[]; missing: string[] };

async function load(
  ctx: BrowserContext,
  url: string,
  ids: string[],
  scripts: boolean,
): Promise<Loaded> {
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url, { waitUntil: "load" });
  const present = `${JSON.stringify(ids)}.filter(function (id) { return document.querySelector('[data-bench-id="' + id + '"]') === null; })`;
  if (scripts && ids.length > 0) {
    // React pages render after load; a timeout is reported through `missing` below.
    await page
      .waitForFunction(`${present}.length === 0`, undefined, {
        timeout: 10_000,
      })
      .catch(() => undefined);
  }
  const missing = z.array(z.string()).parse(await page.evaluate(present));
  await page.evaluate(IN_PAGE_LIB);
  return { page, errors, missing };
}

async function snapshot(page: Page): Promise<Snapshot> {
  return SnapshotSchema.parse(
    await page.evaluate("window.__benchLib.snapshot()"),
  );
}

type Planned = { id: string; html: string; labels: VariantLabels };

// One variant per applicable (base, operator): the first applicable clean element in data-bench-id code-unit order.
async function planVariants(
  ctx: BrowserContext,
  origin: string,
  labels: BaseLabelsFile,
): Promise<Planned[]> {
  const planned: Planned[] = [];
  for (const [baseId, base] of Object.entries(labels.pages)) {
    const probe = await load(ctx, `${origin}/corpus/${base.file}`, [], false);
    const { hasExternalScript } = await snapshot(probe.page);
    const candidates = new Map<OperatorId, string[]>();
    for (const op of OPERATOR_IDS) {
      candidates.set(
        op,
        z
          .array(z.string())
          .parse(
            await probe.page.evaluate(
              `window.__benchLib.candidates(${JSON.stringify(op)})`,
            ),
          ),
      );
    }
    await probe.page.close();
    // A page that loads external scripts (the React fixture) re-renders on load, so a serialized mutation would not survive.
    if (hasExternalScript) continue;
    for (const op of OPERATOR_IDS) {
      const spec = OPERATORS[op];
      if (spec.pageLevel && !isCleanPage(base.page)) continue;
      const target = (candidates.get(op) ?? []).find((id) => {
        const label = base.elements[id];
        return label !== undefined && isCleanTarget(label);
      });
      if (target === undefined) continue;
      const loaded = await load(
        ctx,
        `${origin}/corpus/${base.file}`,
        [],
        false,
      );
      const script = spec.script === null ? null : spec.script(target);
      const html = z
        .string()
        .parse(
          await loaded.page.evaluate(
            `window.__benchLib.apply(${JSON.stringify(op)}, ${JSON.stringify(target)}, ${JSON.stringify(script)})`,
          ),
        );
      await loaded.page.close();
      planned.push({
        id: variantId(baseId, op, target),
        html,
        labels: deriveVariantLabels(baseId, base, op, target),
      });
    }
  }
  return planned;
}

function serializeLabels(planned: Planned[]): string {
  const file: VariantLabelsFile = {
    schemaVersion: 1,
    variants: Object.fromEntries(planned.map((p) => [p.id, p.labels])),
  };
  return `${JSON.stringify(VariantLabelsFileSchema.parse(file), null, 2)}\n`;
}

function readBaseLabels(): BaseLabelsFile {
  return BaseLabelsFileSchema.parse(
    JSON.parse(readFileSync(join(CORPUS_DIR, LABELS_FILE), "utf8")),
  );
}

function writeVariants(outDir: string, planned: Planned[]): void {
  mkdirSync(outDir, { recursive: true });
  for (const f of readdirSync(outDir)) {
    if (f === LABELS_FILE || VARIANT_FILE.test(f)) rmSync(join(outDir, f));
  }
  for (const p of planned) writeFileSync(join(outDir, `${p.id}.html`), p.html);
  writeFileSync(join(outDir, LABELS_FILE), serializeLabels(planned));
}

const sorted = (xs: Iterable<string>): string[] => [...xs].sort();
const sameList = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);
const duplicates = (ids: string[]): string[] =>
  sorted(new Set(ids.filter((id, i) => ids.indexOf(id) !== i)));

function checkPage(
  where: string,
  labelIds: string[],
  snap: Snapshot,
  loaded: Loaded,
): string[] {
  const out: string[] = [];
  const dupes = duplicates(snap.ids);
  if (dupes.length > 0)
    out.push(`${where}: duplicate data-bench-id: ${dupes.join(", ")}`);
  if (loaded.missing.length > 0)
    out.push(
      `${where}: labelled elements never appeared: ${loaded.missing.join(", ")}`,
    );
  if (!sameList(sorted(new Set(snap.ids)), sorted(labelIds)))
    out.push(`${where}: data-bench-id set differs from labels`);
  if (loaded.errors.length > 0)
    out.push(`${where}: page errors: ${loaded.errors.join(" | ")}`);
  return out;
}

function checkVariant(
  id: string,
  v: VariantLabels,
  base: Snapshot,
  variant: Snapshot,
): string[] {
  const out: string[] = [];
  if (!sameList(sorted(new Set(base.ids)), sorted(new Set(variant.ids)))) {
    out.push(`${id}: data-bench-id set differs from base`);
  }
  const spec = OPERATORS[v.operator];
  const changed = sorted(new Set([...base.ids, ...variant.ids])).filter(
    (b) => base.html[b] !== variant.html[b],
  );
  const expectedChanged = spec.changesMarkup ? [v.target] : [];
  if (!sameList(changed, expectedChanged)) {
    out.push(
      `${id}: tagged elements differ from base: ${changed.join(", ") || "(none)"} (expected ${expectedChanged.join(", ") || "none: script-only operator"})`,
    );
  }
  const script = spec.script;
  // A script-only operator's one-element change lives in its script, so the script may address the target alone.
  const refs =
    script === null
      ? [v.target]
      : [...script(v.target).matchAll(/data-bench-id="([^"]*)"/g)].map(
          (m) => m[1],
        );
  if (!sameList(refs, [v.target])) {
    out.push(
      `${id}: operator script must reference only ${v.target}, references ${refs.join(", ") || "(none)"}`,
    );
  }
  const expected =
    script === null
      ? []
      : [
          {
            op: v.operator,
            target: v.target,
            text: script(v.target),
            lastInBody: true,
          },
        ];
  if (base.scripts.length > 0)
    out.push(`${id}: base page carries a data-bench-op script`);
  if (JSON.stringify(variant.scripts) !== JSON.stringify(expected)) {
    out.push(
      `${id}: operator script mismatch: expected ${JSON.stringify(expected)}, found ${JSON.stringify(variant.scripts)}`,
    );
  }
  if (base.rest !== variant.rest)
    out.push(`${id}: markup outside tagged elements differs from base`);
  return out;
}

function checkFilesAreFresh(outDir: string, planned: Planned[]): string[] {
  const out: string[] = [];
  const expected = new Map<string, string>(
    planned.map((p) => [`${p.id}.html`, p.html]),
  );
  expected.set(LABELS_FILE, serializeLabels(planned));
  const onDisk = existsSync(outDir)
    ? readdirSync(outDir).filter(
        (f) => f === LABELS_FILE || VARIANT_FILE.test(f),
      )
    : [];
  for (const f of onDisk)
    if (!expected.has(f))
      out.push(`${f}: not produced by the current operators (stale)`);
  for (const [f, body] of expected) {
    if (!onDisk.includes(f))
      out.push(`${f}: missing; run npx tsx bench/seed.ts`);
    else if (readFileSync(join(outDir, f), "utf8") !== body) {
      out.push(
        `${f.replace(/\.html$/, "")}: file differs from regenerated output (stale or hand-edited)`,
      );
    }
  }
  return out;
}

async function check(
  ctxNoJs: BrowserContext,
  ctxJs: BrowserContext,
  origin: string,
  outDir: string,
): Promise<number> {
  const labels = readBaseLabels();
  const violations: string[] = [];
  const baseSnaps = new Map<string, Snapshot>();
  for (const [baseId, base] of Object.entries(labels.pages)) {
    const loaded = await load(
      ctxJs,
      `${origin}/corpus/${base.file}`,
      Object.keys(base.elements),
      true,
    );
    const snap = await snapshot(loaded.page);
    await loaded.page.close();
    baseSnaps.set(baseId, snap);
    violations.push(
      ...checkPage(baseId, Object.keys(base.elements), snap, loaded),
    );
    if (snap.scripts.length > 0)
      violations.push(`${baseId}: base page carries a data-bench-op script`);
  }

  violations.push(
    ...checkFilesAreFresh(outDir, await planVariants(ctxNoJs, origin, labels)),
  );

  let variants: VariantLabelsFile = { schemaVersion: 1, variants: {} };
  try {
    variants = VariantLabelsFileSchema.parse(
      JSON.parse(readFileSync(join(outDir, LABELS_FILE), "utf8")),
    );
  } catch (e: unknown) {
    violations.push(
      `${LABELS_FILE}: unreadable or invalid: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  for (const [id, v] of Object.entries(variants.variants)) {
    const baseSnap = baseSnaps.get(v.base);
    if (baseSnap === undefined) {
      violations.push(`${id}: unknown base ${v.base}`);
      continue;
    }
    const loaded = await load(
      ctxJs,
      `${origin}/variants/${v.file}`,
      Object.keys(v.elements),
      true,
    );
    const snap = await snapshot(loaded.page);
    await loaded.page.close();
    violations.push(...checkPage(id, Object.keys(v.elements), snap, loaded));
    violations.push(...checkVariant(id, v, baseSnap, snap));
  }

  for (const v of violations) console.error(`VIOLATION ${v}`);
  const summary = `${Object.keys(labels.pages).length} bases, ${Object.keys(variants.variants).length} variants, ${violations.length} violations`;
  console.log(
    violations.length === 0
      ? `check ok: ${summary}`
      : `check FAILED: ${summary}`,
  );
  return violations.length === 0 ? 0 : 1;
}

function parseArgs(argv: string[]): { check: boolean; out: string } {
  let isCheck = false;
  let out = DEFAULT_OUT_DIR;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--check") isCheck = true;
    else if (arg === "--out" && value !== undefined) {
      out = resolve(value);
      i++;
    } else
      throw new Error(
        `unknown argument: ${arg} (usage: seed.ts [--check] [--out <dir>])`,
      );
  }
  return { check: isCheck, out };
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  await buildReactBase();
  const server = await startStaticServer({
    "/corpus/": CORPUS_DIR,
    "/variants/": args.out,
  });
  // Outside the try below, so close the server here: its open socket would keep the process alive.
  const browser = await chromium.launch().catch(async (err: unknown) => {
    await server.close();
    throw err;
  });
  try {
    const ctxNoJs = await browser.newContext({ javaScriptEnabled: false });
    if (args.check)
      return await check(
        ctxNoJs,
        await browser.newContext(),
        server.origin,
        args.out,
      );
    const planned = await planVariants(
      ctxNoJs,
      server.origin,
      readBaseLabels(),
    );
    writeVariants(args.out, planned);
    for (const p of planned) console.log(p.id);
    console.log(
      `wrote ${planned.length} variants + ${LABELS_FILE} to ${args.out}`,
    );
    return 0;
  } finally {
    await browser.close();
    await server.close();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.error(e);
      process.exitCode = 2;
    },
  );
}
