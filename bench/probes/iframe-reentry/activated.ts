// SPIKE: the same fixtures as probe.ts, but with the page ACTIVATED (page.bringToFront()) before
// every key press. bench/probes/wrap/RESULT.md ("Verifier corrections") found the new-headless /
// headed wrap pattern depends on activation, not launch mode, so probe.ts's "only headless shell
// loops" needs this control before it can say anything about a real, focused browser window.
// Also tries Shift+Tab from BOTH halves of a loop: ending on the iframe, and ending outside it.
//
//   npx tsx bench/probes/iframe-reentry/activated.ts    (outside the sandbox: opens headed windows)
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures");
const OUT = path.join(HERE, "out");
const FIXTURE_NAMES = [
  "links-only",
  "empty-iframe-last",
  "button-iframe-last",
] as const;
const PRESSES = [40, 41] as const; // even ends outside a looping page, odd ends on the iframe

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

type Read = {
  tag: string | null;
  text: string;
  isBody: boolean;
  hasFocus: boolean;
};
type Row = {
  mode: string;
  rep: number;
  userAgent: string;
  fixture: string;
  presses: number;
  sequence: string;
  endState: string;
  shiftTab: string;
};

async function read(p: Page): Promise<Read> {
  return p.evaluate(() => {
    const a = document.activeElement;
    return {
      tag: a ? a.tagName.toLowerCase() : null,
      text: a ? (a.textContent ?? "").trim().slice(0, 16) : "",
      isBody: a === document.body,
      hasFocus: document.hasFocus(),
    };
  });
}
// Same encoding as probe.ts: link number, IF = iframe, _ = outside the document, B = focused body.
const code = (r: Read): string =>
  r.isBody
    ? r.hasFocus
      ? "B"
      : "_"
    : r.tag === "iframe"
      ? "IF"
      : r.text.replace(/\D/g, "") || "?";

function serve(): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const name = (req.url ?? "/").replace(/^\//, "");
      try {
        const body = await readFile(path.join(FIXTURES, name), "utf8");
        res
          .writeHead(200, { "content-type": "text/html; charset=utf-8" })
          .end(body);
      } catch {
        res.writeHead(404).end();
      }
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function main(): Promise<void> {
  const server = await serve();
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const rows: Row[] = [];
  for (const [mode, rep] of RUNS) {
    const browser = await MODES[mode]();
    try {
      for (const fixture of FIXTURE_NAMES) {
        for (const presses of PRESSES) {
          const context = await browser.newContext();
          const p = await context.newPage();
          try {
            await p.goto(`${origin}/${fixture}.html`, {
              waitUntil: "domcontentloaded",
            });
            await p.waitForTimeout(300);
            const userAgent = await p.evaluate(() => navigator.userAgent);
            const seq: string[] = [];
            for (let i = 0; i < presses; i++) {
              await p.bringToFront();
              await p.keyboard.press("Tab");
              await p.waitForTimeout(150);
              seq.push(code(await read(p)));
            }
            const back: string[] = [];
            for (let i = 0; i < 3; i++) {
              await p.bringToFront();
              await p.keyboard.press("Shift+Tab");
              await p.waitForTimeout(150);
              back.push(code(await read(p)));
            }
            rows.push({
              mode,
              rep,
              userAgent,
              fixture,
              presses,
              sequence: seq.join(" "),
              endState: seq[seq.length - 1] ?? "",
              shiftTab: back.join(" → "),
            });
          } finally {
            await context.close();
          }
        }
      }
    } finally {
      await browser.close();
    }
  }
  server.close();
  await mkdir(OUT, { recursive: true });
  await writeFile(
    path.join(OUT, "activated.json"),
    `${JSON.stringify(rows, null, 2)}\n`,
  );
  for (const r of rows) {
    console.log(
      `${`${r.mode}#${r.rep}`.padEnd(9)} ${r.fixture.padEnd(20)} n=${r.presses}  end=${r.endState.padEnd(3)} shift+tab: ${r.shiftTab.padEnd(14)} | ${r.sequence}`,
    );
  }
  const uas = [...new Set(rows.map((r) => `${r.mode}: ${r.userAgent}`))];
  console.log(uas.join("\n"));
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
