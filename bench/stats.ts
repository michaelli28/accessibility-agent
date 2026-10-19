// Interval estimates for the detector benchmark. Pure functions, no dependencies.

export type Interval = { p: number; lower: number; upper: number };

function requireRange(ok: boolean, message: string): void {
  if (!ok) throw new RangeError(message);
}

// The double nearest Φ⁻¹(0.975) = 1.95996398454005423552…; 1.959963984540054 is one ulp below it.
export const Z_975 = 1.9599639845400543;

// Wilson 1927: inverts the score test, solving |p̂-p| = z·sqrt(p(1-p)/n) for p.
// Counts may be non-integer.
export function wilson(x: number, n: number, z = Z_975): Interval {
  requireRange(
    n > 0 && x >= 0 && x <= n && z > 0,
    `wilson: need n > 0, 0 <= x <= n, z > 0 (x=${x}, n=${n}, z=${z})`,
  );
  const p = x / n;
  const z2n = (z * z) / n;
  const center = (p + z2n / 2) / (1 + z2n);
  const half = (z / (1 + z2n)) * Math.sqrt((p * (1 - p)) / n + z2n / (4 * n));
  // The bound at x=0 / x=n is exactly 0 / 1; the closed form lands an ulp off.
  return {
    p,
    lower: x === 0 ? 0 : Math.max(0, center - half),
    upper: x === n ? 1 : Math.min(1, center + half),
  };
}

// Hanley & Lippman-Hand 1983: -ln(0.05) ≈ 3, so ≈95% upper bound when 0 events in n.
export function ruleOfThree(n: number): number {
  requireRange(n > 0, `ruleOfThree: need n > 0 (n=${n})`);
  return 3 / n;
}

// Exact (Clopper-Pearson) one-sided bound at 0 events: solve (1-p)^n = alpha for p.
export function exactZeroUpper(n: number, alpha = 0.05): number {
  requireRange(
    n > 0 && alpha > 0 && alpha < 1,
    `exactZeroUpper: need n > 0, 0 < alpha < 1 (n=${n}, alpha=${alpha})`,
  );
  return 1 - Math.pow(alpha, 1 / n);
}

// FNV-1a 32-bit over String(seed), so 42 and '42' give the same stream.
function hashSeed(seed: string | number): number {
  const s = String(seed);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  }
  return h >>> 0;
}

// mulberry32: 32-bit state, uniform in [0, 1). State kept in uint32 so it never loses precision.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Seeded uniform [0, 1) stream for reproducible draws (bench/spotcheck.ts).
export function seededRandom(seed: string | number): () => number {
  return mulberry32(hashSeed(seed));
}
