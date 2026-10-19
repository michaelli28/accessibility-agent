// SPIKE: does Chromium re-enter a page at an empty iframe after focus wraps out of it?
// Prompted by vdc.ru at 74c4349 (a held-out page — this probe is test-informed and says so in
// RESULT.md): forward Tab reached a chat-widget iframe, left the document, then re-entered at the
// iframe instead of the first control, forever. Plain-HTML fixtures, NO JavaScript, walked with
// the run's own runTabWalk defaults and judged with judgeKeyboardTrap, in the three launch modes
// bench/probes/wrap/probe.mjs uses.
//
//   npx tsx bench/probes/iframe-reentry/probe.ts        (outside the sandbox: launches Chromium)
import { createServer, type Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import {
  runTabWalk,
  type FocusRead,
  type TabWalkResult,
} from "../../../packages/accessibility/src/tab-walk.js";
import { judgeKeyboardTrap } from "../../../packages/accessibility/src/keyboard-trap.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "out");
const FIXTURES = path.join(HERE, "fixtures");

const links = (from: number, to: number): string =>
  Array.from(
    { length: to - from + 1 },
    (_, i) => `<a href="#l${from + i}">Link ${from + i}</a>`,
  ).join("\n");
const page = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>\n${body}\n</body></html>\n`;

// {XORIGIN} is replaced with the second server's origin at serve time.
const FIXTURE_HTML: Record<string, string> = {
  "links-only": page("links only", links(1, 10)),
  "empty-iframe-last": page(
    "empty iframe last",
    `${links(1, 10)}\n<iframe title="chat" srcdoc="<p>Chat</p>"></iframe>`,
  ),
  "button-iframe-last": page(
    "button iframe last",
    `${links(1, 10)}\n<iframe title="chat" srcdoc="<button>Open chat</button>"></iframe>`,
  ),
  "empty-iframe-middle": page(
    "empty iframe middle",
    `${links(1, 5)}\n<iframe title="chat" srcdoc="<p>Chat</p>"></iframe>\n${links(6, 10)}`,
  ),
  "xorigin-empty-iframe-last": page(
    "cross-origin empty iframe last",
    `${links(1, 10)}\n<iframe title="chat" src="{XORIGIN}/empty.html"></iframe>`,
  ),
};
const EMPTY_FRAME = page("empty frame", "<p>Chat</p>");

const MODES: Record<string, () => Promise<Browser>> = {
  shell: () => chromium.launch(),
  new: () => chromium.launch({ channel: "chromium" }),
  headed: () => chromium.launch({ headless: false }),
};
const RUNS: ReadonlyArray<readonly [mode: string, rep: number]> = [
  ["shell", 1],
  ["new", 1],
  ["headed", 1],
  ["headed", 2],
];

type Snap = {
  tag: string | null;
  id: string | null;
  text: string;
  hasFocus: boolean;
};
type Row = {
  mode: string;
  rep: number;
  fixture: string;
  F: number;
  presses: number;
  wraps: number;
  firstWrapAt: number | null;
  reentryAfterFirstWrap: string | null;
  distinctAfterFirstIframe: number | null;
  loopDetected: boolean;
  verdict: string;
  reason: string | null;
  release: string;
  sequence: string;
  launch: string;
  shiftTab: Snap[];
  error: string | null;
};

function label(r: FocusRead): string {
  if (r.isBody) return r.hasFocus ? "body" : "body(unfocused)";
  const text = (r.text ?? "").trim().slice(0, 16);
  return `${r.tag ?? "?"}${text ? ` "${text}"` : ""}`;
}

function listen(handler: (url: string) => string | null): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const body = handler(req.url ?? "/");
      if (body === null) {
        res.writeHead(404).end();
        return;
      }
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(body);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}
const originOf = (s: Server): string =>
  `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

async function readActive(p: Page): Promise<Snap> {
  return p.evaluate(() => {
    const a = document.activeElement;
    return {
      tag: a ? a.tagName.toLowerCase() : null,
      id: a && a.id ? a.id : null,
      text: a ? (a.textContent ?? "").trim().slice(0, 16) : "",
      hasFocus: document.hasFocus(),
    };
  });
}

function summarise(
  walk: TabWalkResult,
): Omit<
  Row,
  "mode" | "rep" | "fixture" | "shiftTab" | "error" | "sequence" | "launch"
> {
  const steps = walk.steps;
  const firstWrap = steps.find((s) => s.wrapped);
  const firstWrapIdx = firstWrap ? steps.indexOf(firstWrap) : -1;
  const reentry =
    firstWrapIdx >= 0 && firstWrapIdx + 1 < steps.length
      ? label(steps[firstWrapIdx + 1].settled)
      : null;
  const firstIframeIdx = steps.findIndex((s) => s.settled.tag === "iframe");
  const distinct =
    firstIframeIdx < 0
      ? null
      : new Set(
          steps.slice(firstIframeIdx + 1).map((s) => s.settled.backendNodeId),
        ).size;
  const judged = judgeKeyboardTrap([walk]);
  return {
    F: walk.focusableCount,
    presses: steps.length,
    wraps: steps.filter((s) => s.wrapped).length,
    firstWrapAt: firstWrap ? firstWrap.index : null,
    reentryAfterFirstWrap: reentry,
    distinctAfterFirstIframe: distinct,
    // The vdc.ru shape: after the first iframe visit, only the iframe and the unfocused body recur.
    loopDetected:
      distinct !== null &&
      distinct <= 2 &&
      reentry !== null &&
      reentry.startsWith("iframe"),
    verdict: judged.verdict,
    reason: judged.reason,
    release: judged.directions[0]?.release ?? "n/a",
  };
}

async function main(): Promise<void> {
  const xorigin = await listen((url) =>
    url === "/empty.html" ? EMPTY_FRAME : null,
  );
  const XO = originOf(xorigin);
  const html = (name: string): string =>
    FIXTURE_HTML[name].replace("{XORIGIN}", XO);
  const site = await listen((url) => {
    const name = url.replace(/^\//, "").replace(/\.html$/, "");
    return name in FIXTURE_HTML ? html(name) : null;
  });
  const ORIGIN = originOf(site);

  await mkdir(FIXTURES, { recursive: true });
  await mkdir(OUT, { recursive: true });
  for (const name of Object.keys(FIXTURE_HTML)) {
    await writeFile(path.join(FIXTURES, `${name}.html`), FIXTURE_HTML[name]);
  }
  await writeFile(path.join(FIXTURES, "empty.html"), EMPTY_FRAME);

  const rows: Row[] = [];
  for (const [mode, rep] of RUNS) {
    const browser = await MODES[mode]();
    try {
      for (const fixture of Object.keys(FIXTURE_HTML)) {
        const context = await browser.newContext();
        const p = await context.newPage();
        try {
          await p.goto(`${ORIGIN}/${fixture}.html`, {
            waitUntil: "domcontentloaded",
          });
          await p.waitForTimeout(500);
          const walk = await runTabWalk(p);
          const shiftTab: Snap[] = [];
          for (let i = 0; i < 3; i++) {
            await p.keyboard.press("Shift+Tab");
            await p.waitForTimeout(150);
            shiftTab.push(await readActive(p));
          }
          rows.push({
            mode,
            rep,
            fixture,
            ...summarise(walk),
            sequence: walk.steps
              .slice(0, 40)
              .map((st) =>
                st.settled.isBody
                  ? st.settled.hasFocus
                    ? "B"
                    : "_"
                  : st.settled.tag === "iframe"
                    ? "IF"
                    : (st.settled.text ?? "").replace(/\D/g, "") || "?",
              )
              .join(" "),
            launch: JSON.stringify(walk.launchFacts),
            shiftTab,
            error: walk.error ? String(walk.error) : null,
          });
        } catch (e) {
          rows.push({
            mode,
            rep,
            fixture,
            F: -1,
            presses: 0,
            wraps: 0,
            firstWrapAt: null,
            reentryAfterFirstWrap: null,
            distinctAfterFirstIframe: null,
            loopDetected: false,
            verdict: "probe-error",
            reason: null,
            release: "n/a",
            sequence: "",
            launch: "",
            shiftTab: [],
            error: e instanceof Error ? e.message : String(e),
          });
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
  site.close();
  xorigin.close();

  await writeFile(
    path.join(OUT, "rows.json"),
    `${JSON.stringify(rows, null, 2)}\n`,
  );
  for (const r of rows) {
    const st = r.shiftTab
      .map((s) =>
        s.tag === "body"
          ? `body(${s.hasFocus ? "f" : "unf"})`
          : `${s.tag} "${s.text}"`,
      )
      .join(" → ");
    console.log(
      [
        `${r.mode}#${r.rep}`.padEnd(9),
        r.fixture.padEnd(26),
        `F=${r.F}`.padEnd(5),
        `wraps=${r.wraps}`.padEnd(9),
        `reentry=${r.reentryAfterFirstWrap ?? "-"}`.padEnd(26),
        `loop=${r.loopDetected ? "YES" : "no"}`.padEnd(9),
        `judge=${r.verdict}/${r.release}`.padEnd(26),
        `shift+tab: ${st}`,
        r.error ? `ERROR ${r.error}` : "",
      ].join(" "),
    );
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
