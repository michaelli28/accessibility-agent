// Builds the blind labelling worklist Phase 3 needs (prompts/2-at-agent.md): every flag raised on the
// held-out pages, shuffled, with the SOURCE HIDDEN, so precision can be scored without knowing which
// version -- or which tool -- produced each claim while judging it.
//
//   npx tsx bench/blind-labels.ts <shortSha> [--sets test-bad,test-live] [--seed <text>]
//                                  [--sample <n per source>] [--origin http://127.0.0.1:4175]
//
// Writes bench/BLIND-LABELS.md (spotcheck-shaped, so bench/spotcheck-ui.ts --file drives it) plus
// bench/BLIND-LABELS.key.json, which maps each item back to its source. DO NOT read the key while
// labelling -- it is the thing the blind is hiding, and the report joins on it afterwards.
//
// Grouping: flags are grouped by component (NODENAME + sorted class set) per page, so 210 copies of
// one menu item are ONE judgement, not 210 -- the brief is explicit that copies must not inflate
// precision.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { criterionFromAxeTag } from "./report.js";
import {
  PAGE_SETS,
  SummarySchema,
  componentKey,
  type PageResult,
  type PageSet,
  type Summary,
} from "./results-schema.js";

const BENCH = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(BENCH, "results");
const OUT_MD = join(BENCH, "BLIND-LABELS.md");
const OUT_KEY = join(BENCH, "BLIND-LABELS.key.json");
const DEFAULT_SETS: PageSet[] = ["test-bad", "test-live"];

// What produced a claim. Never rendered into the worklist.
export type FlagSource =
  | "before:legacy-trap"
  | "before:legacy-dynamic"
  | "shared:gaps"
  | "after:judge-trap"
  | "after:judge-context-change"
  | "axe";

export type BlindItem = {
  id: string;
  set: PageSet;
  pageId: string;
  url: string;
  // Component, or null for a page-level claim (the 2.1.2 / 3.2.1 / 2.4.3 verdicts).
  component: string | null;
  selector: string | null;
  criterion: string;
  claim: string;
  copies: number;
  source: FlagSource;
};

const sha256 = (s: string): string =>
  createHash("sha256").update(s).digest("hex");

// Deterministic order from the seed: Math.random would make the draw unreproducible, and the order
// has to be re-derivable to defend the result later.
// The seed is part of the sort key, so ordering with a DIFFERENT seed than the draw used is what
// keeps position from leaking source: selecting each source's k smallest hashes and then sorting the
// union by that same hash lands every source in a contiguous block, ordered by how hard it was
// sampled -- a perfect index of which tool produced what.
function shuffle<T>(
  items: readonly T[],
  seed: string,
  id: (t: T) => string,
): T[] {
  return [...items].sort((a, b) =>
    sha256(seed + id(a)) < sha256(seed + id(b)) ? -1 : 1,
  );
}

// The recorded url carries whatever ephemeral port that run bound, so a local one is dead by the
// time anybody labels it. Re-point local pages at the reviewer's own origin; live urls pass through.
function pageUrl(p: PageResult, origin: string): string {
  const m = /^https?:\/\/(127\.0\.0\.1|localhost):\d+(\/.*)$/.exec(p.url);
  return m === null ? p.url : `${origin}${m[2]}`;
}

// One wording per page-level criterion, whichever detector raised it: these are the only claims the
// two versions both produce, so any difference in phrasing is a direct label for the source.
// Each claim states the success criterion in terms a reviewer can falsify at the keyboard, and
// names what would make it FALSE. The first pass used softer wordings ("an illogical order",
// "focus gets stuck somewhere") that no page can be cleared of, and all 58 items came back "agree".
// Do not quote the detector's own trigger as the claim either: the legacy 2.4.3 rule fires when one
// focus identity recurs within five focus events (bench/legacy-detectors.ts:187, :251) — usually two
// identical-looking controls a few stops apart, not wrapping. It appears below only as a falsifier.
const PAGE_CLAIM: Record<string, string> = {
  "2.1.2":
    "focus reaches a control or group on this page that Tab, Shift+Tab and Escape cannot get out of — escaping it needs the mouse. FALSE if you can Tab onward to the end of the page, or back out to the browser's own toolbar",
  "3.2.1":
    "moving focus onto a control here — with no Enter, no Space, no click — by itself navigates, changes the URL, opens a window, or substantially rewrites the page. FALSE if the control has to be activated before anything happens",
  "2.4.3":
    "Tab visits this page's controls in an order that departs from its reading order in a way that changes meaning or stops you finishing a task. FALSE if the order is merely untidy, if the only oddity is two similar-looking controls a few stops apart, or if it simply wraps back to the top at the end — wrapping is normal",
};

// One wording for a component claim too, so phrasing never separates the gap detector from axe.
const describeGap = (what: string, component: string): string =>
  `${component} — ${what}`;

function flagsOnPage(
  set: PageSet,
  p: PageResult,
  origin: string,
): BlindItem[] {
  const out: BlindItem[] = [];
  const add = (o: Omit<BlindItem, "id" | "set" | "pageId" | "url">): void => {
    out.push({
      ...o,
      set,
      pageId: p.pageId,
      url: pageUrl(p, origin),
      id: sha256(
        [set, p.pageId, o.component ?? "-", o.criterion, o.source].join("|"),
      ).slice(0, 12),
    });
  };

  // Component-level gap flags, collapsed per component + gap type.
  const gaps = p.tools.gaps.findings?.gaps ?? [];
  const byComponent = new Map<
    string,
    { n: number; g: (typeof gaps)[number] }
  >();
  for (const g of gaps) {
    const key = `${componentKey(g.nodeName, g.class)}|${g.gapType}`;
    const seen = byComponent.get(key);
    if (seen) seen.n += 1;
    else byComponent.set(key, { n: 1, g });
  }
  for (const [key, { n, g }] of byComponent) {
    const comp = key.split("|")[0];
    for (const criterion of g.wcag) {
      add({
        component: comp,
        selector:
          g.dataBenchId !== null
            ? `[data-bench-id="${g.dataBenchId}"]`
            : g.id !== null
              ? `#${g.id}`
              : null,
        criterion,
        claim: describeGap(g.gapType.replace(/_/g, " "), comp),
        copies: n,
        source: "shared:gaps",
      });
    }
  }

  // axe, collapsed the same way so it is judged on equal terms -- which means its criterion must be
  // written the way every other source writes one. Its raw tags are slugs (wcag412, wcag2a), and
  // rendering those verbatim named axe on sight in a list whose whole purpose is to hide the source.
  // Rules carrying no success-criterion tag at all (region, landmark-one-main) are dropped: a blank
  // criterion is both a tell and an unanswerable question.
  for (const v of p.tools.axe.findings ?? []) {
    const criteria = [
      ...new Set(
        v.wcagTags
          .map(criterionFromAxeTag)
          .filter((c): c is string => c !== null),
      ),
    ].sort();
    if (criteria.length === 0) continue;
    for (const comp of [...new Set(v.components)]) {
      for (const criterion of criteria) {
        add({
          component: comp,
          selector: null,
          criterion,
          claim: describeGap(v.id.replace(/-/g, " "), comp),
          copies: v.components.filter((c) => c === comp).length,
          source: "axe",
        });
      }
    }
  }

  // Page-level verdicts: the only place the two versions actually differ.
  const legacy = p.tools.legacy.findings;
  if (legacy && legacy.trap.firstTrappedPress !== null)
    add({
      component: null,
      selector: null,
      criterion: "2.1.2",
      claim: PAGE_CLAIM["2.1.2"],
      copies: 1,
      source: "before:legacy-trap",
    });
  for (const v of legacy?.dynamicViolations ?? [])
    add({
      component: null,
      selector: null,
      criterion: v.criterion,
      // The detector's own description is its signature; the criterion already says what is claimed.
      claim: PAGE_CLAIM[v.criterion] ?? `this page fails WCAG ${v.criterion}`,
      copies: 1,
      source: "before:legacy-dynamic",
    });

  const walk = p.tools.walk.findings;
  if (walk?.trap.verdict === "fail")
    add({
      component: null,
      selector: null,
      criterion: "2.1.2",
      claim: PAGE_CLAIM["2.1.2"],
      copies: 1,
      source: "after:judge-trap",
    });
  if (walk?.contextChange.verdict === "fail")
    add({
      component: null,
      selector: null,
      criterion: "3.2.1",
      claim: PAGE_CLAIM["3.2.1"],
      copies: 1,
      source: "after:judge-context-change",
    });

  return out;
}

const PAGE_TEST =
  "Open the page fresh and work the keyboard. Decide ONE thing: is this claim TRUE of this page? agree = a real defect, disagree = a false alarm, not sure = you could not tell. The claim names what would make it FALSE — check that first. If you agree, write in the note WHAT YOU SAW (which control, roughly which Tab press): an agreement with no observation behind it cannot be audited. Judge the claim on its own terms; do not think about which tool said it.";
const COMPONENT_TEST =
  "Open the page fresh and find the component. Decide ONE thing: does it really fail this success criterion? agree = a real defect, disagree = a false alarm, not sure = you could not tell. If you agree, write in the note WHAT YOU SAW: an agreement with no observation behind it cannot be audited. Judge the claim on its own terms; do not think about which tool said it.";

function render(
  items: readonly BlindItem[],
  seed: string,
  sha: string,
  total: number,
  caveats: readonly string[],
): string {
  const out = [
    "# Blind labelling — held-out flags",
    "",
    items.length === total
      ? `Every flag raised on the held-out pages at ${sha} (${total}), shuffled with seed \`${seed}\`, **source hidden**.`
      : `A stratified sample of ${items.length} of the ${total} flags raised on the held-out pages at ${sha}, drawn per source with seed \`${seed}\`, **source hidden**. Precision is therefore an estimate per source, with an interval -- not a census.`,
    "Judge each claim on its own merits. Which version (or which tool) produced it is in",
    "`BLIND-LABELS.key.json`; do not open that file until every item is labelled, or the blind is gone.",
    "",
    "Copies are collapsed per component, so many copies of one component count once.",
    ...(caveats.length > 0
      ? ["", "**This list is not complete:**", ...caveats.map((c) => `- ${c}`)]
      : []),
    "",
    `Drive it with: \`npx tsx bench/spotcheck-ui.ts --file bench/BLIND-LABELS.md --port 4175\``,
    "",
    "## Flags",
    "",
  ];
  items.forEach((it, i) => {
    const where =
      it.component === null
        ? "whole page"
        : `${it.component}${it.copies > 1 ? ` ×${it.copies}` : ""}`;
    out.push(
      `${i + 1}. [ ] **${it.pageId} · ${where} · WCAG ${it.criterion}**`,
      `    - open <${it.url}>${it.selector === null ? "" : ` and find \`${it.selector}\``}`,
      `    - test: ${it.component === null ? PAGE_TEST : COMPONENT_TEST}`,
      `    - recorded: claims **${it.criterion}** — ${it.claim}`,
      "    - agree? / note:",
    );
  });
  return `${out.join("\n")}\n`;
}

function readSummary(sha: string, set: PageSet): Summary | null {
  const p = join(RESULTS, sha, set, "summary.json");
  if (!existsSync(p)) return null;
  return SummarySchema.parse(JSON.parse(readFileSync(p, "utf8")));
}

function main(argv: readonly string[]): void {
  const [sha] = argv;
  if (sha === undefined) {
    console.error(
      "usage: npx tsx bench/blind-labels.ts <shortSha> [--sets test-bad,test-live] [--seed <text>]",
    );
    process.exit(2);
  }
  const setsFlag = argv.indexOf("--sets");
  const sets =
    setsFlag === -1
      ? DEFAULT_SETS
      : (argv[setsFlag + 1] ?? "")
          .split(",")
          .filter((s): s is PageSet =>
            (PAGE_SETS as readonly string[]).includes(s),
          );
  // Where the reviewer will serve the corpus. Local page urls are re-pointed here because the ones
  // recorded in the summary carry the ephemeral port that run bound, which is long gone.
  const originFlag = argv.indexOf("--origin");
  const origin = (
    originFlag === -1 ? "http://127.0.0.1:4175" : (argv[originFlag + 1] ?? "")
  ).replace(/\/$/, "");
  if (!/^https?:\/\/[^/]+$/.test(origin)) {
    console.error("--origin must look like http://host:port");
    process.exit(2);
  }
  const seedFlag = argv.indexOf("--seed");
  const seed =
    seedFlag === -1 ? `blind-${sha}` : (argv[seedFlag + 1] ?? `blind-${sha}`);

  const items: BlindItem[] = [];
  const missing: PageSet[] = [];
  const partial: string[] = [];
  for (const set of sets) {
    const s = readSummary(sha, set);
    if (s === null) {
      missing.push(set);
      continue;
    }
    if (!s.complete) partial.push(`${set} (${s.pages.length} pages)`);
    for (const p of s.pages) items.push(...flagsOnPage(set, p, origin));
  }
  // A console warning vanishes with the terminal while the file goes on claiming to be every flag
  // on the held-out pages. Whatever is missing has to travel WITH the artifact.
  const caveats = [
    ...(missing.length > 0 ? [`no summary was found for: ${missing.join(", ")}`] : []),
    ...(partial.length > 0
      ? [`these sets were INCOMPLETE when this was built, so their flags are partial: ${partial.join(", ")}`]
      : []),
  ];
  for (const c of caveats) console.warn(`WARNING: ${c}`);
  if (items.length === 0) {
    console.error(`no flags found for ${sha}`);
    process.exit(2);
  }

  // A worklist nobody finishes measures nothing. --sample draws up to N per SOURCE (a stratified
  // draw, the same shape spotcheck.ts uses), so every source gets its own bounded precision instead
  // of one unbounded pile dominated by whichever tool is noisiest.
  const sampleFlag = argv.indexOf("--sample");
  const perSource =
    sampleFlag === -1 ? null : Number(argv[sampleFlag + 1] ?? NaN);
  if (perSource !== null && (!Number.isInteger(perSource) || perSource <= 0)) {
    console.error("--sample must be a positive integer");
    process.exit(2);
  }
  const drawn =
    perSource === null
      ? items
      : [...new Set(items.map((i) => i.source))].flatMap((src) => {
          const pool = shuffle(
            items.filter((i) => i.source === src),
            seed,
            (i) => i.id,
          );
          if (pool.length > perSource)
            console.log(`  ${src}: drew ${perSource} of ${pool.length}`);
          return pool.slice(0, perSource);
        });
  // ":order" so the final sequence is independent of the per-source draw above.
  const shuffled = shuffle(drawn, `${seed}:order`, (i) => i.id);
  writeFileSync(OUT_MD, render(shuffled, seed, sha, items.length, caveats));
  writeFileSync(
    OUT_KEY,
    `${JSON.stringify(
      {
        sha,
        seed,
        sets,
        caveats,
        // Per-source pool sizes: without them the interval the header promises cannot be computed
        // from the saved artifacts alone.
        pool: Object.fromEntries(
          [...new Set(items.map((i) => i.source))].map((src) => [
            src,
            {
              total: items.filter((i) => i.source === src).length,
              drawn: shuffled.filter((i) => i.source === src).length,
            },
          ]),
        ),
        // Position in the worklist -> what produced it. The join the report needs afterwards.
        key: shuffled.map((it, i) => ({
          n: i + 1,
          id: it.id,
          set: it.set,
          pageId: it.pageId,
          component: it.component,
          criterion: it.criterion,
          copies: it.copies,
          source: it.source,
        })),
      },
      null,
      2,
    )}\n`,
  );

  const bySource = new Map<FlagSource, number>();
  for (const it of shuffled)
    bySource.set(it.source, (bySource.get(it.source) ?? 0) + 1);
  console.log(`wrote ${resolve(OUT_MD)}  (${shuffled.length} flags to label)`);
  console.log(
    `wrote ${resolve(OUT_KEY)}  — do not read until labelling is done`,
  );
  for (const [s, n] of [...bySource].sort())
    console.log(`  ${String(n).padStart(4)}  ${s}`);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main(process.argv.slice(2));
