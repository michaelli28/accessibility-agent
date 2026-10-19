// The review server itself, spawned on a scratch worklist: its endpoints over HTTP, and the page's own
// behaviour in Chromium. spotcheck-ui.test.ts covers the pure helpers; the defects here lived in the
// request handlers and the page script, where no test reached.
// Run from the worktree root outside the sandbox (spawns `node --import tsx` and launches Chromium):
//   npx vitest run bench/spotcheck-ui-server.test.ts
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { itemsKey, parseSpotcheck, type Verdict } from "./spotcheck-ui.js";

const BENCH = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(BENCH, "..");
const LONG = 60_000;

// No open line, so the page renders no preview frame and serves nothing from the corpus mounts.
const item = (n: number, title: string): string =>
  [
    `${n}. [ ] **${title}**`,
    "    - test: press Tab and see.",
    `    - recorded: claims **4.1.2** — something about item ${n}`,
    "    - agree? / note:",
  ].join("\n");

const worklist = (n: number, titles?: string[]): string =>
  [
    "# W",
    "",
    "## Flags",
    "",
    ...Array.from({ length: n }, (_, i) =>
      item(i + 1, titles?.[i] ?? `item ${i + 1}`),
    ),
  ].join("\n") + "\n";

type Ui = { origin: string; md: string; stop: () => Promise<void> };
const running: Ui[] = [];
const scratch: string[] = [];

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

async function startUi(md: string, answers?: object): Promise<Ui> {
  const dir = mkdtempSync(join(tmpdir(), "spotcheck-ui-"));
  scratch.push(dir);
  const mdPath = join(dir, "wl.md");
  writeFileSync(mdPath, md);
  if (answers !== undefined)
    writeFileSync(join(dir, "wl-answers.json"), JSON.stringify(answers));
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      join(BENCH, "spotcheck-ui.ts"),
      "--file",
      mdPath,
      "--port",
      String(port),
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  await new Promise<void>((ready, fail) => {
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      if (output.includes("Ctrl+C to stop")) ready();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) =>
      fail(new Error(`spotcheck-ui.ts exited ${code}:\n${output}`)),
    );
  });
  const ui: Ui = {
    origin: `http://127.0.0.1:${port}`,
    md: mdPath,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((done) => child.once("exit", done));
      child.kill("SIGTERM");
      await exited;
    },
  };
  running.push(ui);
  return ui;
}

afterAll(async () => {
  await Promise.all(running.map((ui) => ui.stop()));
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const itemsSha = async (ui: Ui): Promise<string> =>
  (
    (await (await fetch(`${ui.origin}/api/items`)).json()) as {
      itemsSha256: string;
    }
  ).itemsSha256;

async function answer(
  ui: Ui,
  key: string,
  n: number,
  verdict: Verdict | null,
  note = "",
): Promise<void> {
  const r = await fetch(`${ui.origin}/api/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ n, verdict, note, itemsSha256: key }),
  });
  expect(r.status).toBe(200);
}

type WriteResult = { ok: boolean; done?: number; reason?: string };
const writeMd = async (ui: Ui): Promise<WriteResult> =>
  (await (
    await fetch(`${ui.origin}/api/write-md`, { method: "POST" })
  ).json()) as WriteResult;

const answerLine = (ui: Ui, n: number): string | undefined =>
  parseSpotcheck(readFileSync(ui.md, "utf8")).find((i) => i.n === n)
    ?.answerLine;

describe("write-md: its own earlier copy is not a hand edit", () => {
  // The guard compared the file against the CURRENT record only, so once the tool had written a
  // verdict, changing it in the page locked the button for good -- with a reason ("no verdict
  // here") that was false, since the record did have one.
  it(
    "writes again after a verdict is changed in the page",
    async () => {
      const ui = await startUi(worklist(2));
      const key = await itemsSha(ui);
      await answer(ui, key, 1, "agree");
      expect(await writeMd(ui)).toMatchObject({ ok: true, done: 1 });
      await answer(ui, key, 1, "disagree", "focus escaped");
      expect(await writeMd(ui)).toMatchObject({ ok: true, done: 1 });
      expect(answerLine(ui, 1)).toBe("disagree — focus escaped");
    },
    LONG,
  );

  // mergeIntoMd writes a note with no verdict as "— note"; the guard expected "<verdict> — note"
  // and counted a missing verdict as a loss, so it refused the tool's own line even unchanged.
  it(
    "writes a note-only item, again unchanged, and again once it has a verdict",
    async () => {
      const ui = await startUi(worklist(2));
      const key = await itemsSha(ui);
      await answer(ui, key, 1, "agree");
      await answer(ui, key, 2, null, "half done");
      expect(await writeMd(ui)).toMatchObject({ ok: true, done: 1 });
      expect(answerLine(ui, 2)).toBe("— half done");
      expect(await writeMd(ui)).toMatchObject({ ok: true, done: 1 });
      await answer(ui, key, 2, "unsure", "half done");
      expect(await writeMd(ui)).toMatchObject({ ok: true, done: 2 });
      expect(answerLine(ui, 2)).toBe("unsure — half done");
    },
    LONG,
  );

  it(
    "still refuses to overwrite an answer edited into the file by hand, and says which and why",
    async () => {
      const ui = await startUi(worklist(2));
      const key = await itemsSha(ui);
      await answer(ui, key, 1, "agree");
      expect(await writeMd(ui)).toMatchObject({ ok: true });
      const edited = readFileSync(ui.md, "utf8").replace(
        "note: agree",
        "note: disagree — Enter did nothing",
      );
      writeFileSync(ui.md, edited);
      const res = await writeMd(ui);
      expect(res.ok).toBe(false);
      expect(res.reason).toContain("(1)");
      // The record does hold a verdict for item 1; it is just a different one.
      expect(res.reason).not.toContain("no verdict");
      expect(readFileSync(ui.md, "utf8")).toBe(edited);
    },
    LONG,
  );

  it(
    "still refuses to overwrite a verdict written by hand for an item the page never judged",
    async () => {
      const md = worklist(2)
        .replace("1. [ ] **item 1**", "1. [x] **item 1**")
        .replace(
          "    - agree? / note:\n2.",
          "    - agree? / note: disagree — by hand\n2.",
        );
      const ui = await startUi(md);
      await answer(ui, await itemsSha(ui), 2, "agree");
      const res = await writeMd(ui);
      expect(res.ok).toBe(false);
      expect(res.reason).toContain("(1)");
      expect(readFileSync(ui.md, "utf8")).toBe(md);
    },
    LONG,
  );

  // Both real worklists were written before writtenToMd existed, so the guard had no copy to
  // recognise, and the first changed answer locked the button on them too.
  const writtenByEarlierVersion = (): { md: string; answers: object } => {
    const md = worklist(2)
      .replace("1. [ ] **item 1**", "1. [x] **item 1**")
      .replace("    - agree? / note:\n2.", "    - agree? / note: agree\n2.");
    return {
      md,
      answers: {
        itemsSha256: itemsKey(parseSpotcheck(md)),
        answers: { "1": { verdict: "agree", note: "" } },
        superseded: [],
      },
    };
  };

  it.each([
    ["a note added", "agree", "focus escaped", "agree — focus escaped"],
    ["a changed verdict", "disagree", "", "disagree"],
  ] as const)(
    "writes %s into a worklist an earlier version wrote",
    async (_, verdict, note, line) => {
      const { md, answers } = writtenByEarlierVersion();
      const ui = await startUi(md, answers);
      await answer(ui, await itemsSha(ui), 1, verdict, note);
      expect(await writeMd(ui)).toMatchObject({ ok: true, done: 1 });
      expect(answerLine(ui, 1)).toBe(line);
    },
    LONG,
  );

  // Only a file that reads exactly what the saved verdicts would write is the tool's copy. Here
  // item 1 was judged in the page, never written, and then typed in by hand: that line is the
  // reviewer's.
  it(
    "does not take a file out of step with the saved verdicts for its own copy",
    async () => {
      const md = worklist(2);
      const ui = await startUi(md, {
        itemsSha256: itemsKey(parseSpotcheck(md)),
        answers: { "1": { verdict: "agree", note: "" } },
        superseded: [],
      });
      const key = await itemsSha(ui);
      await answer(ui, key, 2, "agree");
      const typed = writtenByEarlierVersion().md;
      writeFileSync(ui.md, typed);
      await answer(ui, key, 1, "disagree");
      const res = await writeMd(ui);
      expect(res.ok).toBe(false);
      expect(res.reason).toContain("(1)");
      expect(readFileSync(ui.md, "utf8")).toBe(typed);
    },
    LONG,
  );
});

describe("the review page", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  }, LONG);
  afterAll(async () => {
    await browser?.close();
  });

  async function open(ui: Ui): Promise<Page> {
    const page = await browser.newPage();
    await page.goto(ui.origin);
    await page.waitForFunction(
      () => document.getElementById("prog")?.textContent !== "loading…",
    );
    return page;
  }

  // The client threw the server's reason away and showed only "Could not write".
  it(
    "shows why a write was refused",
    async () => {
      const md = worklist(2).replace(
        "    - agree? / note:\n2.",
        "    - agree? / note: disagree — by hand\n2.",
      );
      const ui = await startUi(md);
      await answer(ui, await itemsSha(ui), 2, "agree");
      const page = await open(ui);
      await page.click("#writemd");
      await expect
        .poll(() => page.textContent("#writemd"))
        .toContain("refusing");
    },
    LONG,
  );

  it(
    "counts a saved verdict and moves on to the next item",
    async () => {
      const ui = await startUi(worklist(3));
      const page = await open(ui);
      await page.click("button.v.agree");
      await expect.poll(() => page.textContent("h1")).toMatch(/^2\. /);
      expect(await page.textContent("#prog")).toBe("1 of 3 marked");
      expect(await page.locator("nav .dot.agree").count()).toBe(1);
      const saved = JSON.parse(
        readFileSync(ui.md.replace(/\.md$/, "-answers.json"), "utf8"),
      ) as { answers: Record<string, { verdict: string | null }> };
      expect(saved.answers["1"].verdict).toBe("agree");
    },
    LONG,
  );

  // The verdict went into the page's state before the POST and stayed there on a 409, so the dot
  // and the count said "saved"; the one warning was then erased by the auto-advance 180 ms later.
  it(
    "does not show a rejected verdict as saved, and keeps the warning up",
    async () => {
      const ui = await startUi(worklist(3));
      const page = await open(ui);
      // Regenerated while the page is open: its itemsSha256 no longer matches, so the server 409s.
      writeFileSync(ui.md, worklist(3, ["item 1", "REDRAWN", "item 3"]));
      await page.click("button.v.agree");
      await page.waitForTimeout(600); // well past the 180 ms auto-advance
      expect(await page.textContent("#prog")).toBe("0 of 3 marked");
      expect(await page.locator("nav .dot.agree").count()).toBe(0);
      expect(await page.textContent("#saved")).toContain(
        "the worklist changed",
      );
      expect(await page.getAttribute("#saved", "class")).toContain("on");
      // Still there after the page redraws for another item.
      await page.click("#nextbtn");
      expect(await page.textContent("h1")).toMatch(/^2\. /);
      expect(await page.textContent("#saved")).toContain(
        "the worklist changed",
      );
    },
    LONG,
  );

  it(
    "marks the blind list's items held-out",
    async () => {
      const ui = await startUi(
        worklist(2).replace("# W", "# Blind labelling — held-out flags"),
      );
      const page = await open(ui);
      expect(await page.locator("nav .grp.held").count()).toBe(1);
      expect(await page.textContent("#detail")).toContain(
        "held-out item: keep this out of chat",
      );
    },
    LONG,
  );

  // A refused connection threw out of save() unhandled: the verdict looked saved, nothing was said.
  it(
    "says a verdict was not saved when the server is gone",
    async () => {
      const ui = await startUi(worklist(2));
      const page = await open(ui);
      await ui.stop();
      await page.click("button.v.agree");
      await page.waitForTimeout(600);
      expect(await page.textContent("#prog")).toBe("0 of 2 marked");
      expect(await page.locator("nav .dot.agree").count()).toBe(0);
      expect(await page.textContent("#saved")).toContain("not saved");
      expect(await page.getAttribute("#saved", "class")).toContain("on");
    },
    LONG,
  );
});
