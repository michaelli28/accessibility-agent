// SPIKE: end-to-end run of the EXISTING, unmodified taskgen gap detector against the probe builds.
// Part 1 calls ElementCrawler.crawlPageWithGapDetection(url) — the per-page dual crawl the CLI's
// --gap-detection path runs for every page (orchestrator -> crawlSiteWithGapDetection -> this).
// Part 2 calls the real DOMCrawler.getInteractivitySignals + GapDetector on EVERY probe element, so a miss
// can be attributed to "never enumerated by crawlDOM" vs "enumerated but scored < 2".
// Part 3 (counterfactual, no source change) re-runs detectGaps with hasClickHandler OR'd with __reactProps$*.onClick.
import * as path from "path";
import type { Browser, CDPSession, Page } from "playwright";
import { ElementCrawler } from "../../../taskgen/src/element-crawler";
import { DOMCrawler } from "../../../taskgen/src/dom-crawler";
import { GapDetector } from "../../../taskgen/src/gap-detector";
import type {
  DOMElement,
  InteractivitySignals,
  PageElementGraph,
} from "../../../taskgen/src/types";
import { startServer } from "./serve.cjs";

const DIST = path.join(__dirname, "dist");
const BUILDS = [
  "react18-prod",
  "react19-prod",
  "react18-dev",
  "react19-dev",
  "control",
];
const REACT_IDS = ["a", "b", "c", "c-child", "d", "e", "f", "g", "h", "i"];
const CONTROL_IDS = ["ctl-listener", "ctl-inline"];

const REACT_HANDLER_FN = `function () {
  const k = Object.keys(this).find((x) => x.startsWith('__reactProps$'));
  return Boolean(k && this[k] && typeof this[k].onClick === 'function');
}`;

// Mirror of taskgen/src/gap-detector.ts:108-126 to print the numeric score (the real method returns only a boolean).
function scoreOf(s: InteractivitySignals, interactiveRole: boolean): number {
  let score = 0;
  if (s.hasClickHandler) score += 2;
  if (s.isSemanticInteractive) score += 2;
  if (s.hasRoleAttribute && interactiveRole) score += 2;
  if (s.hasCursorPointer) score += 1;
  if (s.hasTabindex && s.tabindexValue !== -1) score += 1;
  if (s.hasAriaExpanded) score += 1;
  if (s.classNameHints.length > 0) score += 0.5;
  return score;
}

const probeIdOf = (e: DOMElement): string =>
  e.attributes["data-probe"] ??
  `${e.localName}${e.attributes["id"] ? `#${e.attributes["id"]}` : ""}`;

type ElementRow = {
  id: string;
  signals: InteractivitySignals;
  score: number;
  likelyInteractive: boolean;
  gapIfEnumerated: string | null;
  reactOnClick: boolean;
  scoreReactAware: number;
  gapReactAware: string | null;
};

async function describeProbe(
  cdp: CDPSession,
  rootNodeId: number,
  id: string,
  url: string,
): Promise<DOMElement> {
  const { nodeId } = await cdp.send("DOM.querySelector", {
    nodeId: rootNodeId,
    selector: `[data-probe="${id}"]`,
  });
  const { node } = await cdp.send("DOM.describeNode", { nodeId, depth: 0 });
  const attributes: Record<string, string> = {};
  const raw = node.attributes ?? [];
  for (let i = 0; i < raw.length; i += 2) attributes[raw[i]] = raw[i + 1];
  return {
    nodeId,
    backendNodeId: node.backendNodeId,
    nodeName: node.nodeName,
    localName: node.localName,
    attributes,
    boundingBox: null,
    pageUrl: url,
  };
}

async function reactOnClickOf(
  cdp: CDPSession,
  backendNodeId: number,
): Promise<boolean> {
  const { object } = await cdp.send("DOM.resolveNode", { backendNodeId });
  const res = await cdp.send("Runtime.callFunctionOn", {
    objectId: object.objectId as string,
    functionDeclaration: REACT_HANDLER_FN,
    returnByValue: true,
  });
  return res.result.value === true;
}

async function measurePerElement(
  crawler: ElementCrawler,
  url: string,
  ids: string[],
): Promise<ElementRow[]> {
  await crawler.init();
  const browser = crawler["browser"] as Browser;
  const context = await browser.newContext();
  const page: Page = await context.newPage();
  try {
    // Same load + settle as crawlPageWithGapDetection (element-crawler.ts:688-689).
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000);
    const axNodes = await crawler["getAccessibilityTree"](page);
    const tree: PageElementGraph = crawler["convertToElementGraph"](
      axNodes,
      url,
      await page.title(),
    );

    const cdp = await context.newCDPSession(page);
    await cdp.send("DOM.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
    const domCrawler = new DOMCrawler();
    const detector = new GapDetector();
    const rows: ElementRow[] = [];
    for (const id of ids) {
      const el = await describeProbe(cdp, root.nodeId, id, url);
      const signals = await domCrawler.getInteractivitySignals(page, el);
      const interactiveRole: boolean = detector["isInteractiveRole"](
        signals.roleValue,
      );
      const gap = detector.detectGaps(
        [el],
        tree,
        new Map([[el.backendNodeId, signals]]),
      )[0];
      const reactOnClick = await reactOnClickOf(cdp, el.backendNodeId);
      const aware: InteractivitySignals = {
        ...signals,
        hasClickHandler: signals.hasClickHandler || reactOnClick,
      };
      const gapAware = detector.detectGaps(
        [el],
        tree,
        new Map([[el.backendNodeId, aware]]),
      )[0];
      rows.push({
        id,
        signals,
        score: scoreOf(signals, interactiveRole),
        likelyInteractive: detector["isLikelyInteractive"](signals),
        gapIfEnumerated: gap ? gap.gapType : null,
        reactOnClick,
        scoreReactAware: scoreOf(aware, interactiveRole),
        gapReactAware: gapAware ? gapAware.gapType : null,
      });
    }
    await cdp.detach();
    return rows;
  } finally {
    await context.close();
  }
}

async function main(): Promise<void> {
  const { server, base } = await startServer(DIST);
  const crawler = new ElementCrawler({ headless: true });
  try {
    for (const build of BUILDS) {
      const url = `${base}/${build}/index.html`;
      const ids = build === "control" ? CONTROL_IDS : REACT_IDS;

      const result = await crawler.crawlPageWithGapDetection(url);
      const enumerated = result.domElements.map(probeIdOf);
      console.log(`\n### ${build}  E2E crawlPageWithGapDetection`);
      console.log(
        `E2E enumerated by crawlDOM (${enumerated.length}): ${enumerated.join(", ")}`,
      );
      console.log(
        `E2E gaps (${result.gaps.length}): ${result.gaps.map((g) => `${probeIdOf(g.domElement)}=${g.gapType}`).join(", ") || "none"}`,
      );

      const rows = await measurePerElement(crawler, url, ids);
      console.log(
        "PER-ELEMENT  id | enumerated | hasClickHandler | cursorPtr | classHints | role | tabindex | score | likely | gapIfEnumerated | reactOnClick | scoreReactAware | gapReactAware",
      );
      for (const r of rows) {
        const s = r.signals;
        console.log(
          `PER-ELEMENT  ${r.id} | ${enumerated.includes(r.id)} | ${s.hasClickHandler} | ${s.hasCursorPointer} | ${s.classNameHints.join("+") || "-"} | ` +
            `${s.roleValue ?? "-"} | ${s.tabindexValue ?? "-"} | ${r.score} | ${r.likelyInteractive} | ${r.gapIfEnumerated ?? "-"} | ` +
            `${r.reactOnClick} | ${r.scoreReactAware} | ${r.gapReactAware ?? "-"}`,
        );
      }
    }
  } finally {
    await crawler.close();
    server.close();
  }
}

main().catch((err: unknown) => {
  console.error("E2E FAILED:", err);
  process.exit(1);
});
