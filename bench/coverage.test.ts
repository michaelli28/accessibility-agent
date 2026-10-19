import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

// Every shipped .ts under packages/*/src. Test files are excluded on purpose: a suite is allowed to
// name a retired criterion in order to assert its absence, and that is not an emission.
function shippedSources(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
        found.push(full);
    }
  };
  for (const pkg of readdirSync(join(ROOT, "packages"))) {
    const src = join(ROOT, "packages", pkg, "src");
    if (existsSync(src)) walk(src);
  }
  return found;
}

describe("COVERAGE.md", () => {
  // The only executable check on a file nothing else in the repo references. It checks strings; a
  // reviewer still has to read the file.
  it("records the retired rule and its price, and no source still emits 2.4.3", () => {
    const coverage = readFileSync(join(ROOT, "bench", "COVERAGE.md"), "utf8");

    expect(coverage).toContain("## Retired: the 2.4.3 focus-order rule");
    // The one page the cut costs us, named in bench/SPOTCHECK.md:113.
    expect(coverage).toContain("before/survey");
    // The recall lost (REPORT-baseline.md:41) and the false alarms bought back (:52).
    expect(coverage).toContain("0/1");
    expect(coverage).toContain("7/7");

    expect(coverage).toContain(
      "## What the 2.1.2 and 3.2.1 verdicts do not establish",
    );
    // Michael's scoring decision: undetermined is a miss, not an exclusion.
    expect(coverage).toContain(
      "**An `undetermined` verdict counts as a miss.**",
    );

    const emitters = shippedSources().filter((file) =>
      readFileSync(file, "utf8").includes("2.4.3"),
    );
    expect(emitters.map((f) => f.slice(ROOT.length))).toEqual([]);
  });
});
