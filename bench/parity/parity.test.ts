// Divergence ledger: the UNMODIFIED taskgen dual crawl vs the fixed packages/accessibility port (with its Tab walk),
// same local URL, same Chromium. Every difference must be listed in divergence-ledger.ts with the fix that explains it;
// an unlisted difference fails, and so does a listed one that no longer occurs.
// Run from the worktree root outside the sandbox: npx vitest run bench/parity
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { ElementCrawler } from "../../taskgen/src/element-crawler";
import { DIVERGENCE_LEDGER } from "./divergence-ledger.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const BENCH = resolve(HERE, "..");

// PARITY_GAPS_SRC swaps the port side for a copy of packages/accessibility/src/gaps (mutation testing only); the copy
// must sit in a copy of packages/accessibility/src, since gaps imports ../types.js and ../tab-walk.js.
const GAPS_SRC =
  process.env.PARITY_GAPS_SRC ??
  resolve(BENCH, "..", "packages", "accessibility", "src", "gaps");
const { crawlPageWithGapDetection } = (await import(
  join(GAPS_SRC, "detect.ts")
)) as typeof import("../../packages/accessibility/src/gaps/detect.js");
const REACT_DIR = join(BENCH, "probes", "react");
const REACT_BUILDS = [
  "react18-prod",
  "react18-dev",
  "react19-prod",
  "react19-dev",
  "control",
];
// The port runs as the gaps CLI does, with a Tab walk; a short settle suffices, no fixture moves focus late.
const PORT_OPTIONS = { tabWalk: { settleMs: 20 } };

// URL prefix -> directory served under it.
const ROOTS: Record<string, string> = {
  parity: join(HERE, "fixtures"),
  wrap: join(BENCH, "probes", "wrap", "fixtures"),
  react: join(REACT_DIR, "dist"),
};

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
};

type GapTypeCounts = Partial<Record<string, number>>;

// Gap types the unmodified taskgen detector produces per fixture (recorded at the baseline); pins the original side.
const FIXTURES: Array<{ name: string; path: string; taskgen: GapTypeCounts }> =
  [
    { name: "good-operable", path: "/parity/good-operable.html", taskgen: {} },
    {
      name: "branches-inline",
      path: "/parity/branches-inline.html",
      taskgen: {
        missing_from_a11y_tree: 7,
        no_accessible_name: 3,
        not_focusable: 2,
        wrong_role: 2,
      },
    },
    {
      name: "branches-scripted",
      path: "/parity/branches-scripted.html",
      taskgen: {
        missing_from_a11y_tree: 4,
        not_focusable: 3,
        no_accessible_name: 1,
        wrong_role: 1,
        hidden_but_interactive: 1,
      },
    },
    // T1 verifier's stress page; the fixture comments mark the elements that kill port mutations the older fixtures missed.
    {
      name: "stress",
      path: "/parity/stress.html",
      taskgen: {
        no_accessible_name: 9,
        missing_from_a11y_tree: 17,
        not_focusable: 7,
        wrong_role: 1,
      },
    },
    {
      name: "focused-hidden-named",
      path: "/parity/focused-hidden-named.html",
      taskgen: { not_focusable: 1 },
    },
    ...["a", "b", "c", "d", "e"].map((f) => ({
      name: `wrap-${f}`,
      path: `/wrap/${f}.html`,
      taskgen: {},
    })),
    ...REACT_BUILDS.map((b) => ({
      name: b,
      path: `/react/${b}/index.html`,
      taskgen: { missing_from_a11y_tree: 1 },
    })),
  ];

// Structural views that both taskgen's and the port's result types satisfy.
interface DomLike {
  nodeName: string;
  localName: string;
  attributes: Record<string, string>;
  boundingBox?: { x: number; y: number; width: number; height: number } | null;
}
interface GapLike {
  domElement: DomLike;
  signals: object;
  gapType: string;
  severity: string;
  evidence: string;
}
interface AxLike {
  role: string;
  name: string;
  description?: string;
  value?: unknown;
  typeFlags: object;
  ignoredReasons?: string[];
}
interface ResultLike {
  domElements: DomLike[];
  gaps: GapLike[];
  accessibilityTree: { elements: Map<string, AxLike>; title: string };
}

// Readable element label for ledger tokens; the diffs themselves are computed on the full records.
function ident(e: DomLike): string {
  const a = e.attributes;
  const label =
    a["data-bench-id"] ??
    a["data-probe"] ??
    a["data-p"] ??
    (a.id ? `#${a.id}` : a.class ? `.${a.class}` : "");
  return `${e.nodeName}[${label}]`;
}

// An element's identity across the two runs, without backendNodeId (process-specific).
const elementKey = (e: DomLike): string =>
  JSON.stringify([
    e.nodeName,
    e.localName,
    e.attributes,
    e.boundingBox ?? null,
  ]);

const gapKey = (g: GapLike): string =>
  JSON.stringify([elementKey(g.domElement), g.gapType, g.severity, g.evidence]);
const gapToken = (g: GapLike): string =>
  `${ident(g.domElement)} ${g.gapType}/${g.severity}: ${g.evidence}`;

// taskgen keeps numeric AX values (slider 30) while the port's axText stringifies them ("30"); the classifier never
// reads value, so both sides compare as strings. taskgen has no ignoredReasons and never keeps an ignored node.
const axKey = (n: AxLike): string =>
  JSON.stringify([
    n.role,
    n.name,
    n.description ?? null,
    n.value === undefined || n.value === null ? null : String(n.value),
    n.typeFlags,
    n.ignoredReasons ?? [],
  ]);
const axToken = (n: AxLike): string =>
  `${n.role} ${JSON.stringify(n.name)}${n.ignoredReasons && n.ignoredReasons.length > 0 ? ` ignored:${n.ignoredReasons.join(",")}` : ""}`;

// Items of `a` not matched one-for-one in `b` (multiset difference).
function minus<T>(a: T[], b: T[], key: (x: T) => string): T[] {
  const left = new Map<string, number>();
  for (const x of b) left.set(key(x), (left.get(key(x)) ?? 0) + 1);
  return a.filter((x) => {
    const n = left.get(key(x)) ?? 0;
    if (n === 0) return true;
    left.set(key(x), n - 1);
    return false;
  });
}

// Elements both sides keep must appear in the same order: the port only appends discoveries and drops nothing.
function commonOrder<T>(a: T[], b: T[], key: (x: T) => string): string[] {
  const inB = new Set(b.map(key));
  return a.map(key).filter((k) => inB.has(k));
}

// Tokens: "gap-"/"gap+" a gap only taskgen / only the port reports; "enum-"/"enum+" a candidate only one side
// enumerated; "ax-"/"ax+" an AX node only one side keeps; "signals~" a field that differs for an element both sides
// flagged. Every token is a difference the ledger must explain.
function diffTokens(original: ResultLike, port: ResultLike): string[] {
  const tokens: string[] = [];
  for (const g of minus(original.gaps, port.gaps, gapKey))
    tokens.push(`gap- ${gapToken(g)}`);
  for (const g of minus(port.gaps, original.gaps, gapKey))
    tokens.push(`gap+ ${gapToken(g)}`);
  for (const e of minus(original.domElements, port.domElements, elementKey))
    tokens.push(`enum- ${ident(e)}`);
  for (const e of minus(port.domElements, original.domElements, elementKey))
    tokens.push(`enum+ ${ident(e)}`);
  const origAx = [...original.accessibilityTree.elements.values()];
  const portAx = [...port.accessibilityTree.elements.values()];
  for (const n of minus(origAx, portAx, axKey))
    tokens.push(`ax- ${axToken(n)}`);
  for (const n of minus(portAx, origAx, axKey))
    tokens.push(`ax+ ${axToken(n)}`);

  const portGapByElement = new Map(
    port.gaps.map((g) => [elementKey(g.domElement), g]),
  );
  for (const g of original.gaps) {
    const other = portGapByElement.get(elementKey(g.domElement));
    if (!other) continue;
    const a = g.signals as Record<string, unknown>;
    const b = other.signals as Record<string, unknown>;
    for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[field]) !== JSON.stringify(b[field])) {
        tokens.push(
          `signals~ ${ident(g.domElement)} ${field}: ${JSON.stringify(a[field])} -> ${JSON.stringify(b[field])}`,
        );
      }
    }
  }
  return tokens.sort();
}

function countByType(r: ResultLike): GapTypeCounts {
  const counts: Record<string, number> = {};
  for (const g of r.gaps) counts[g.gapType] = (counts[g.gapType] ?? 0) + 1;
  return counts;
}

function startServer(): Promise<{ server: http.Server; base: string }> {
  const server = http.createServer((req, res) => {
    const [, prefix, ...rest] = (req.url ?? "/").split("?")[0].split("/");
    const root = ROOTS[prefix];
    const file = root ? resolve(root, ...rest.map(decodeURIComponent)) : "";
    if (
      !root ||
      !file.startsWith(root + sep) ||
      !existsSync(file) ||
      !statSync(file).isFile()
    ) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      "content-type":
        CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
    });
    res.end(readFileSync(file));
  });
  return new Promise((ok) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      ok({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

async function runPort(browser: Browser, url: string): Promise<ResultLike> {
  // Fresh context per page, as taskgen does.
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    return await crawlPageWithGapDetection(page, url, PORT_OPTIONS);
  } finally {
    await context.close();
  }
}

describe("gap detector divergence ledger: taskgen original vs the fixed port", () => {
  let server: http.Server;
  let base: string;
  let browser: Browser;
  const taskgen = new ElementCrawler({ headless: true });
  const recorded: string[] = [];

  beforeAll(async () => {
    if (
      !REACT_BUILDS.every((b) =>
        existsSync(join(REACT_DIR, "dist", b, "index.html")),
      )
    ) {
      execFileSync(process.execPath, [join(REACT_DIR, "build.mjs")], {
        stdio: "inherit",
      });
    }
    ({ server, base } = await startServer());
    browser = await chromium.launch({ headless: true });
    await taskgen.init();
  }, 180000);

  afterAll(async () => {
    console.log(
      [`Port source: ${GAPS_SRC}`, "Gap types per fixture, taskgen -> port:"]
        .concat(recorded)
        .join("\n"),
    );
    await taskgen.close();
    await browser?.close();
    server?.close();
  });

  it("ledger names only known fixtures", () => {
    const names = new Set(FIXTURES.map((f) => f.name));
    expect(Object.keys(DIVERGENCE_LEDGER).filter((n) => !names.has(n))).toEqual(
      [],
    );
  });

  for (const fixture of FIXTURES) {
    it(`${fixture.name}: every difference is a ledgered fix, nothing else moved`, async () => {
      const url = `${base}${fixture.path}`;
      const [original, port] = await Promise.all([
        taskgen.crawlPageWithGapDetection(url),
        runPort(browser, url),
      ]);

      expect(countByType(original)).toEqual(fixture.taskgen);
      expect(port.accessibilityTree.title).toBe(
        original.accessibilityTree.title,
      );
      expect(
        commonOrder(port.domElements, original.domElements, elementKey),
      ).toEqual(
        commonOrder(original.domElements, port.domElements, elementKey),
      );
      const origAx = [...original.accessibilityTree.elements.values()];
      const portAx = [...port.accessibilityTree.elements.values()];
      expect(commonOrder(portAx, origAx, axKey)).toEqual(
        commonOrder(origAx, portAx, axKey),
      );

      const actual = diffTokens(original, port);
      const ledgered = (DIVERGENCE_LEDGER[fixture.name] ?? [])
        .flatMap((e) => Array<string>(e.count ?? 1).fill(e.diff))
        .sort();
      if (JSON.stringify(actual) !== JSON.stringify(ledgered)) {
        console.log(
          `${fixture.name} actual diffs:\n${JSON.stringify(actual, null, 2)}`,
        );
      }
      expect(actual).toEqual(ledgered);

      recorded.push(
        `  ${fixture.name}: ${JSON.stringify(countByType(original))} -> ${JSON.stringify(countByType(port))}`,
      );
    }, 90000);
  }
});
