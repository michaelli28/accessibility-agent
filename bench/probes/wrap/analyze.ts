// SPIKE: analyse out/*.json from probe.mjs and replay every recorded Tab sequence
// through the EXISTING KeyboardTrapDetector. Usage: npx tsx analyze.ts
import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KeyboardTrapDetector } from "../../legacy-detectors.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "out");

type Snap = {
  tag: string | null;
  id: string | null;
  label: string;
  isBody: boolean;
  hasFocus: boolean;
  url: string;
  toolsId: string;
  backendNodeId: number | null;
};
type Step = { press: number; key: string; immediate: Snap; settled: Snap };
type Run = {
  fixture: string;
  via: string;
  F: number;
  presses: number;
  initial?: Snap;
  reverseStart?: Snap;
  forward?: Step[];
  reverse?: Step[];
  forwardError?: { press: number; message: string; events: string[] } | null;
  reverseError?: { press: number; message: string; events: string[] } | null;
  runError?: string;
};
type ProbeFile = {
  mode: string;
  version: string;
  toolsLines: [number, number];
  runs: Run[];
};

type Verdict = {
  trapped: boolean;
  cycleLength: number;
  element: string | null;
  // First prefix of the sequence at which detectTrap() says trapped: checkTrap can run at any step.
  firstTrapped: {
    press: number;
    cycleLength: number;
    element: string | null;
  } | null;
};

function replay(
  seq: string[],
  config?: { minCycleCount: number; maxHistorySize: number },
): Verdict {
  const detector = new KeyboardTrapDetector(config);
  let firstTrapped: Verdict["firstTrapped"] = null;
  seq.forEach((el, i) => {
    detector.recordFocus(el);
    const r = detector.detectTrap();
    if (firstTrapped === null && r.trapped)
      firstTrapped = {
        press: i + 1,
        cycleLength: r.cycleLength,
        element: r.element,
      };
  });
  const r = detector.detectTrap();
  return {
    trapped: r.trapped,
    cycleLength: r.cycleLength,
    element: r.element,
    firstTrapped,
  };
}

// First press where a label's backendNodeId differs from the first id seen for it => document replaced.
function docReplacedAt(steps: Step[]): number | null {
  const firstId = new Map<string, number | null>();
  for (const s of steps) {
    const { label, backendNodeId } = s.settled;
    if (!firstId.has(label)) firstId.set(label, backendNodeId);
    else if (firstId.get(label) !== backendNodeId) return s.press;
  }
  return null;
}

// Smallest period p with a transient k < p such that seq[i] === seq[i+p] for all i >= k,
// requiring at least two full periods after the transient.
function period(seq: string[]): { p: number; k: number } | null {
  for (let p = 1; p <= Math.floor(seq.length / 2); p++) {
    for (let k = 0; k < p; k++) {
      if (seq.length - k < 2 * p) continue;
      let ok = true;
      for (let i = k; i + p < seq.length; i++) {
        if (seq[i] !== seq[i + p]) {
          ok = false;
          break;
        }
      }
      if (ok) return { p, k };
    }
  }
  return null;
}

const fmtVerdict = (v: Verdict) => {
  const final = v.trapped ? `**TRAPPED** cyc=${v.cycleLength}` : "no trap";
  const ever = v.firstTrapped
    ? `; first trapped at press ${v.firstTrapped.press} cyc=${v.firstTrapped.cycleLength} el=${JSON.stringify(v.firstTrapped.element)}`
    : "; never trapped";
  return final + ever;
};

function labelWithFocus(s: Snap): string {
  return s.label + (s.hasFocus ? "" : "!");
}

async function main() {
  const files = (await readdir(OUT)).filter((f) => f.endsWith(".json")).sort();
  const data: ProbeFile[] = [];
  for (const f of files)
    data.push(
      JSON.parse(await readFile(path.join(OUT, f), "utf8")) as ProbeFile,
    );
  const fileTag = (d: ProbeFile, i: number) => files[i].replace(".json", "");

  const lines: string[] = [];
  const log = (s = "") => {
    lines.push(s);
    console.log(s);
  };

  // Sanity: detector defaults vs the config tools.ts passes ({5,50}) must agree.
  let configMismatch = 0;

  log("## Per fixture x mode x direction (settled reads)");
  log("");
  log(
    "`!` = document.hasFocus() was false. `imm!=set` = presses where the immediate and the 150ms-settled read differed (label or hasFocus).",
  );
  log("");
  log(
    "| file | fixture/via | dir | F | presses | observed sequence (settled) | period | transient | body/period | imm!=set | detector (tools.ts ids) | detector (backendNodeIds) | notes |",
  );
  log("|---|---|---|---|---|---|---|---|---|---|---|---|---|");

  type Key = string;
  const seqByKey = new Map<Key, Map<string, string>>();
  const eTransitions: string[] = [];
  const distinctToolsIds = new Map<string, Set<string>>();

  data.forEach((d, fi) => {
    const tag = fileTag(d, fi);
    for (const run of d.runs) {
      if (run.runError) {
        log(
          `| ${tag} | ${run.fixture}/${run.via} | - | - | - | RUN FAILED | - | - | - | - | - | - | ${run.runError} |`,
        );
        continue;
      }
      for (const dir of ["forward", "reverse"] as const) {
        const steps = run[dir] ?? [];
        const err = dir === "forward" ? run.forwardError : run.reverseError;
        const labels = steps.map((s) => s.settled.label);
        const labelsF = steps.map((s) => labelWithFocus(s.settled));
        const toolsSeq = steps.map((s) => s.settled.toolsId);
        const nodeSeq = steps.map((s) => String(s.settled.backendNodeId));
        const immDiff = steps.filter(
          (s) =>
            s.immediate.label !== s.settled.label ||
            s.immediate.hasFocus !== s.settled.hasFocus ||
            s.immediate.backendNodeId !== s.settled.backendNodeId,
        ).length;
        const per = period(labels);
        const cycle = per ? labels.slice(per.k, per.k + per.p) : [];
        const bodyCount = cycle.filter((l) => l === "body").length;
        const vTools = replay(toolsSeq);
        const vNodes = replay(nodeSeq);
        const vToolsCfg = replay(toolsSeq, {
          minCycleCount: 5,
          maxHistorySize: 50,
        });
        const vNodesCfg = replay(nodeSeq, {
          minCycleCount: 5,
          maxHistorySize: 50,
        });
        if (
          JSON.stringify(vTools) !== JSON.stringify(vToolsCfg) ||
          JSON.stringify(vNodes) !== JSON.stringify(vNodesCfg)
        )
          configMismatch++;

        const ids = distinctToolsIds.get(run.fixture) ?? new Set<string>();
        toolsSeq.forEach((t) => ids.add(t));
        distinctToolsIds.set(run.fixture, ids);

        const key = `${run.fixture}/${run.via}/${dir}`;
        const m = seqByKey.get(key) ?? new Map<string, string>();
        m.set(tag, labelsF.join(" "));
        seqByKey.set(key, m);

        const start =
          dir === "reverse" ? `[from ${run.reverseStart?.label}] ` : "";
        const replaced = docReplacedAt(steps);
        const notes = [
          err
            ? `press ${err.press}: ${err.message} ${JSON.stringify(err.events)}`
            : "",
          replaced !== null
            ? `DOCUMENT REPLACED at press ${replaced} (all backendNodeIds changed, same URL)`
            : "",
        ]
          .filter(Boolean)
          .join("; ");
        log(
          `| ${tag} | ${run.fixture}/${run.via} | ${dir === "forward" ? "Tab" : "Shift+Tab"} | ${run.F} | ${steps.length}/${run.presses} | ${start}${labelsF.join(" ")} | ${per ? per.p : "none"} | ${per ? per.k : "-"} | ${per ? bodyCount : "-"} | ${immDiff} | ${fmtVerdict(vTools)} | ${fmtVerdict(vNodes)} | ${notes} |`,
        );

        if (run.fixture === "e") {
          steps.forEach((s, i) => {
            if (
              s.settled.isBody &&
              s.settled.hasFocus &&
              i + 1 < steps.length
            ) {
              const prev =
                i > 0
                  ? labelWithFocus(steps[i - 1].settled)
                  : `start(${dir === "reverse" ? run.reverseStart?.label : run.initial?.label})`;
              eTransitions.push(
                `${tag} ${dir} press ${s.press}: ${prev} -> [${dir === "forward" ? "Tab" : "Shift+Tab"}] -> body(hasFocus=true, id=${s.settled.backendNodeId}, imm=${labelWithFocus(s.immediate)}) -> next: ${labelWithFocus(steps[i + 1].settled)}${replaced === s.press ? " [NOT a blur: document was replaced at this press]" : ""}`,
              );
            }
          });
        }
      }
    }
  });

  log("");
  log(
    `Detector: default config vs tools.ts config {minCycleCount:5,maxHistorySize:50} mismatches: ${configMismatch}`,
  );
  log("");
  log("## Cycle period per mode (settled labels)");
  log("");
  log(
    "| fixture/via/dir | " +
      files.map((f) => f.replace(".json", "")).join(" | ") +
      " |",
  );
  log("|---|" + files.map(() => "---").join("|") + "|");
  for (const [key, m] of seqByKey) {
    const cells = files.map((f) => {
      const s = m.get(f.replace(".json", ""));
      if (!s) return "-";
      const per = period(s.split(" ").map((x) => x.replace("!", "")));
      return per ? `p=${per.p}` : "aperiodic";
    });
    log(`| ${key} | ${cells.join(" | ")} |`);
  }

  log("");
  log("## Run vs rerun (identical settled label+hasFocus sequence?)");
  log("");
  for (const [key, m] of seqByKey) {
    for (const mode of ["shell", "new", "headed"]) {
      const a = m.get(mode);
      const b = m.get(`${mode}-rerun`);
      if (a && b)
        log(`- ${key} ${mode}: ${a === b ? "IDENTICAL" : "DIFFERENT"}`);
    }
  }

  log("");
  log(
    "## Fixture E: where focus is after the blur, and where the next key goes",
  );
  log("");
  eTransitions.forEach((t) => log(`- ${t}`));

  log("");
  log("## Distinct tools.ts identity strings seen per fixture");
  log("");
  for (const [f, ids] of distinctToolsIds)
    log(`- ${f}: ${[...ids].map((x) => JSON.stringify(x)).join(", ")}`);

  await writeFile(path.join(OUT, "tables.md"), lines.join("\n") + "\n");
  console.log(`\nwrote ${path.join(OUT, "tables.md")}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
