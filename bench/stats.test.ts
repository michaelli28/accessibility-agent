import { describe, it, expect } from "vitest";
import { wilson, ruleOfThree, exactZeroUpper, Z_975 } from "./stats.js";

describe("wilson", () => {
  it("0/20 has upper bound 0.1611 and lower bound 0", () => {
    const w = wilson(0, 20);
    expect(w.p).toBe(0);
    expect(w.lower).toBe(0);
    expect(w.upper).toBeCloseTo(0.1611, 4);
  });

  it("10/10 is [0.7225, 1]", () => {
    const w = wilson(10, 10);
    expect(w.p).toBe(1);
    expect(w.lower).toBeCloseTo(0.7225, 4);
    // Exactly 1, not 0.9999999999999999, so `upper === 1` checks hold.
    expect(w.upper).toBe(1);
  });

  it("110/120 is [0.8534, 0.9541]", () => {
    const w = wilson(110, 120);
    expect(w.p).toBeCloseTo(110 / 120, 12);
    expect(w.lower).toBeCloseTo(0.8534, 4);
    expect(w.upper).toBeCloseTo(0.9541, 4);
  });

  it("accepts non-integer counts", () => {
    const w = wilson(110 / 2.5, 120 / 2.5);
    expect(w.p).toBeCloseTo(110 / 120, 12);
    expect(w.upper - w.lower).toBeGreaterThan(0.9541 - 0.8534);
  });

  it("rejects n <= 0 and x outside [0, n]", () => {
    expect(() => wilson(0, 0)).toThrow(RangeError);
    expect(() => wilson(-1, 10)).toThrow(RangeError);
    expect(() => wilson(11, 10)).toThrow(RangeError);
  });
});

describe("zero-event bounds", () => {
  it("ruleOfThree(20) = 0.15", () => {
    expect(ruleOfThree(20)).toBeCloseTo(0.15, 12);
  });

  it("exactZeroUpper(20) = 0.1391", () => {
    expect(exactZeroUpper(20)).toBeCloseTo(0.1391, 4);
  });

  it("reject n <= 0", () => {
    expect(() => ruleOfThree(0)).toThrow(RangeError);
    expect(() => exactZeroUpper(0)).toThrow(RangeError);
  });
});

describe("default z", () => {
  it("is the double nearest the 0.975 normal quantile", () => {
    // ECMAScript rounds a decimal of at most 20 significant digits correctly.
    expect(Z_975).toBe(Number("1.9599639845400542355"));
    expect(Z_975).not.toBe(1.959963984540054);
    expect(wilson(110, 120)).toEqual(wilson(110, 120, Z_975));
    expect(wilson(3, 17)).toEqual(wilson(3, 17, 1.9599639845400543));
  });
});
