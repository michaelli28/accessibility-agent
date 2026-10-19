// The seams that write the human verdict record. This file exists because that record has already
// been destroyed three times by this code, each time silently and each time reported as success:
// a byte-hash stamp that invalidated the answers it had just written, two endpoints computing the
// identity key differently, and a redraw pruning the file on the next keystroke.
// bench/.gitignore calls <name>-answers.json "the record worth keeping"; the worklist beside it is
// regenerated on a whim. So the invariant under test is blunt: NOTHING here may ever subtract.
import { describe, expect, it } from "vitest";
import {
  itemsKey,
  mergeIntoMd,
  parseSpotcheck,
  supersede,
  type Verdict,
} from "./spotcheck-ui.js";

const item = (
  n: number,
  title: string,
  url = "http://127.0.0.1:4175/bad/x.html",
): string =>
  [
    `${n}. [ ] **${title}**`,
    `    - open <${url}> and find \`[data-bench-id="t${n}"]\``,
    `    - test: press Tab and see.`,
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

const answer = (
  verdict: Verdict | null,
  note = "",
): { verdict: Verdict | null; note: string } => ({
  verdict,
  note,
});

describe("parseSpotcheck", () => {
  it("recovers every drawn item with its url, selector and recorded text", () => {
    const items = parseSpotcheck(worklist(3));
    expect(items.map((i) => i.n)).toEqual([1, 2, 3]);
    expect(items[1].selector).toBe('[data-bench-id="t2"]');
    expect(items[1].recorded).toContain("something about item 2");
  });

  // spotcheck.ts writes BAD-element items as a url plus a CONSOLE EXPRESSION in backticks
  // (`document.querySelectorAll("...").length`). Taking the first backticked span verbatim handed the
  // UI a JavaScript expression as a CSS selector, so querySelector threw and the preview never
  // outlined anything -- on 4 of the 20 items in the committed SPOTCHECK.md.
  it("recovers a CSS selector from a console-expression open line", () => {
    const md = [
      "## S",
      "",
      "1. [ ] **before/home · SC 1.1.1**",
      '    - open <http://127.0.0.1:4175/bad/before/home.html>; in the console `document.querySelectorAll("#page .story:nth-child(2) a > img").length` should be 1',
      "    - test: inspect it.",
      "    - recorded: claims **1.1.1** — no alt text",
      "    - agree? / note:",
    ].join("\n");
    expect(parseSpotcheck(md)[0].selector).toBe(
      "#page .story:nth-child(2) a > img",
    );
  });

  // Both start-line regexes end `(.*)$`, and in JS `.` does not match \r. A CRLF file parsed to
  // nothing, and the UI rendered "No items found".
  it("parses a worklist with CRLF line endings", () => {
    const items = parseSpotcheck(worklist(2).replace(/\n/g, "\r\n"));
    expect(items.map((i) => i.n)).toEqual([1, 2]);
    expect(items[0].title).not.toMatch(/\r/);
  });

  it("captures a verdict already written into the file by hand", () => {
    const md = worklist(2)
      .replace("1. [ ] **item 1**", "1. [x] **item 1**")
      .replace(
        "    - agree? / note:\n2.",
        "    - agree? / note: disagree — Enter did nothing\n2.",
      );
    const [first] = parseSpotcheck(md);
    expect(first.answered).toBe(true);
    expect(first.answerLine).toContain("Enter did nothing");
  });

  // The page marked an item held-out only when its GROUP said BAD. blind-labels.ts puts every item
  // under a plain "## Flags" and says "held-out" in the title, so none of its items were marked.
  it("marks every item of a list whose title says held-out", () => {
    const md = worklist(2).replace("# W", "# Blind labelling — held-out flags");
    expect(parseSpotcheck(md).map((i) => i.held)).toEqual([true, true]);
  });

  it("marks only the BAD groups of a mixed list", () => {
    const md = [
      "# Checkpoint 1 spot-check",
      "",
      "## Dev page flags (1 of 4)",
      "",
      item(1, "dev"),
      "",
      "## BAD page-level results (1 of 5)",
      "",
      item(2, "bad"),
    ].join("\n");
    expect(parseSpotcheck(md).map((i) => i.held)).toEqual([false, true]);
  });
});

describe("itemsKey", () => {
  it("is stable across the origin the worklist is served from", () => {
    // blind-labels.ts re-points local urls at whatever port the reviewer runs on. That is a serving
    // detail, not part of what an item IS -- keying on it discarded the record on a port change.
    const a = itemsKey(parseSpotcheck(worklist(2)));
    const b = itemsKey(
      parseSpotcheck(
        worklist(2).replaceAll("127.0.0.1:4175", "127.0.0.1:4180"),
      ),
    );
    expect(a).toBe(b);
  });

  it("changes when the draw genuinely changes", () => {
    const a = itemsKey(parseSpotcheck(worklist(2)));
    const b = itemsKey(parseSpotcheck(worklist(2, ["item 1", "DIFFERENT"])));
    expect(a).not.toBe(b);
  });

  it("refuses to key an empty parse rather than collapsing to one shared hash", () => {
    // A worklist that parses to zero items keyed as sha256("") -- every broken file shared one key,
    // so a record could be shown against, and overwritten by, an unrelated broken file.
    expect(() => itemsKey([])).toThrow();
  });
});

describe("supersede: a redraw must never subtract", () => {
  const oldKey = "aaa";
  const file = {
    itemsSha256: oldKey,
    answers: {
      "1": answer("agree", "saw it on the 2nd Tab"),
      "2": answer("disagree", "false alarm"),
    },
    superseded: [],
  };

  it("keeps the previous verdicts when the draw changes", () => {
    const next = supersede(file, "bbb");
    expect(next.itemsSha256).toBe("bbb");
    expect(next.answers).toEqual({});
    expect(next.superseded).toHaveLength(1);
    expect(next.superseded[0].itemsSha256).toBe(oldKey);
    expect(next.superseded[0].answers["2"].note).toBe("false alarm");
  });

  it("is a no-op when the draw is unchanged", () => {
    expect(supersede(file, oldKey)).toBe(file);
  });

  it("keeps every earlier draw, not just the last one", () => {
    const second = supersede(file, "bbb");
    // A generation is only archived if somebody answered in it -- so give bbb a verdict, otherwise
    // this would be asserting the empty-generation case the next test covers.
    const worked = {
      ...second,
      answers: { "1": answer("unsure", "second draw") },
    };
    const next = supersede(worked, "ccc");
    expect(next.superseded.map((s) => s.itemsSha256)).toEqual([oldKey, "bbb"]);
    expect(next.superseded[1].answers["1"].note).toBe("second draw");
  });

  it("drops an empty generation rather than accumulating noise", () => {
    const empty = { itemsSha256: "x", answers: {}, superseded: [] };
    expect(supersede(empty, "y").superseded).toEqual([]);
  });
});

describe("mergeIntoMd", () => {
  it("writes verdicts and ticks only the answered boxes", () => {
    const out = mergeIntoMd(worklist(3), {
      "1": answer("agree", "yes"),
      "3": answer("disagree"),
    });
    expect(out).toContain("1. [x] **item 1**");
    expect(out).toContain("2. [ ] **item 2**");
    expect(out).toContain("    - agree? / note: agree — yes");
    expect(out).toContain("    - agree? / note: disagree");
  });

  it("preserves the line count and is idempotent", () => {
    const md = worklist(4);
    const answers = { "2": answer("unsure", "could not tell") };
    const once = mergeIntoMd(md, answers);
    expect(once.split("\n")).toHaveLength(md.split("\n").length);
    expect(mergeIntoMd(once, answers)).toBe(once);
  });

  it("does not carry a verdict onto the following item when a start line is unrecognised", () => {
    // mergeIntoMd never reset its current-item cursor, so an unparsed start line meant the next
    // "agree? / note:" it met was still attributed to the PREVIOUS item.
    const md = worklist(2).replace("2. [ ] **item 2**", "2. [-] **item 2**");
    const out = mergeIntoMd(md, { "1": answer("agree", "about ITEM ONE") });
    const lines = out.split("\n");
    const second = lines.indexOf("2. [-] **item 2**");
    expect(lines.slice(second).join("\n")).not.toContain("about ITEM ONE");
  });

  it("flattens a multi-line note so it cannot forge a new item", () => {
    const out = mergeIntoMd(worklist(2), {
      "1": answer("agree", "line one\n2. [x] **forged**\nline two"),
    });
    expect(parseSpotcheck(out).map((i) => i.n)).toEqual([1, 2]);
  });
});
