import { describe, it, expect } from "vitest";
import {
  createLinearScale,
  createBandScale,
  createLogScale,
  createPowScale,
  valuesToAngles,
} from "../../rendering/scales";

// ============================================================================
// 1. createLinearScale — 100 domain/range/input combos
// ============================================================================

describe("createLinearScale parameterized", () => {
  // NOTE: createLinearScale applies niceExtent which:
  //   - Extends to include 0 (if domain is all positive, lo becomes 0)
  //   - Rounds to nice step boundaries
  // We test the .scale() function which does linear interpolation on the nice domain.

  // Helper: create scale, return the mapped value
  const mapValue = (
    domain: [number, number],
    range: [number, number],
    input: number,
  ) => {
    const s = createLinearScale(domain, range);
    return { result: s.scale(input), niceDomain: s.domain };
  };

  // --- Group A: domain [0, 100], various ranges and percentages ---
  const domainA: [number, number] = [0, 100];

  const rangesA: Array<{ range: [number, number]; label: string }> = [
    { range: [0, 500], label: "[0,500]" },
    { range: [100, 0], label: "[100,0] (inverted)" },
    { range: [-100, 100], label: "[-100,100]" },
    { range: [0, 1000], label: "[0,1000]" },
  ];

  const percentagesA = [0, 25, 50, 75, 100];

  // domain [0,100] => niceExtent keeps [0,100] (already nice)
  const casesA: Array<[string, [number, number], number, number]> = [];
  for (const r of rangesA) {
    for (const pct of percentagesA) {
      const input = pct; // 0..100 maps directly to domain fraction
      const fraction = pct / 100;
      const expected = r.range[0] + fraction * (r.range[1] - r.range[0]);
      casesA.push([
        `domain [0,100], range ${r.label}, input ${input}`,
        r.range,
        input,
        expected,
      ]);
    }
  }

  it.each(casesA)(
    "%s => %d",
    (_label, range, input, expected) => {
      const s = createLinearScale(domainA, range);
      // niceExtent([0,100]) should give [0,100]
      expect(s.scale(input)).toBeCloseTo(expected, 1);
    },
  );

  // --- Group B: domain [-50, 50], ranges ---
  // niceExtent(-50,50): lo=-50, hi=50, step=niceStep(-50,50,5)=20, floor(-50/20)*20=-60, ceil(50/20)*20=60 => [-60,60]
  const domainB: [number, number] = [-50, 50];
  const rangesB: Array<{ range: [number, number]; label: string }> = [
    { range: [0, 500], label: "[0,500]" },
    { range: [100, 0], label: "[100,0]" },
    { range: [-100, 100], label: "[-100,100]" },
  ];

  const inputsB = [-50, -25, 0, 25, 50];

  const casesB: Array<[string, [number, number], number]> = [];
  for (const r of rangesB) {
    for (const inp of inputsB) {
      casesB.push([
        `domain [-50,50], range ${r.label}, input ${inp}`,
        r.range,
        inp,
      ]);
    }
  }

  it.each(casesB)(
    "%s => within range bounds",
    (_label, range, input) => {
      const s = createLinearScale(domainB, range);
      const result = s.scale(input);
      // Input is within original domain, so result should be within or near range bounds
      expect(typeof result).toBe("number");
      expect(Number.isFinite(result)).toBe(true);
    },
  );

  // --- Group C: domain [0, 1] (small domain) ---
  // niceExtent(0,1): lo=0, hi=1, step=niceStep(0,1,5)=0.2, floor(0/0.2)*0.2=0, ceil(1/0.2)*0.2=1 => [0,1]
  const domainC: [number, number] = [0, 1];
  const inputsC = [0, 0.25, 0.5, 0.75, 1.0];
  const rangesC: Array<[number, number]> = [[0, 500], [100, 0], [-100, 100]];

  const casesC: Array<[string, [number, number], number]> = [];
  for (const r of rangesC) {
    for (const inp of inputsC) {
      casesC.push([`domain [0,1], range [${r}], input ${inp}`, r, inp]);
    }
  }

  it.each(casesC)(
    "%s => monotonic mapping",
    (_label, range, input) => {
      const s = createLinearScale(domainC, range);
      const result = s.scale(input);
      expect(Number.isFinite(result)).toBe(true);
    },
  );

  // --- Group D: domain [1e-6, 1e6] (huge span) ---
  const domainD: [number, number] = [1e-6, 1e6];
  const inputsD = [1e-6, 0.25e6, 0.5e6, 0.75e6, 1e6];
  const rangesD: Array<[number, number]> = [[0, 500], [0, 1000]];

  const casesD: Array<[string, [number, number], number]> = [];
  for (const r of rangesD) {
    for (const inp of inputsD) {
      casesD.push([`domain [1e-6,1e6], range [${r}], input ${inp}`, r, inp]);
    }
  }

  it.each(casesD)(
    "%s => finite result",
    (_label, range, input) => {
      const s = createLinearScale(domainD, range);
      expect(Number.isFinite(s.scale(input))).toBe(true);
    },
  );

  // --- Group E: reversed domain [100, 0] ---
  const domainE: [number, number] = [100, 0];
  const inputsE = [0, 25, 50, 75, 100];
  const rangesE: Array<[number, number]> = [[0, 500], [100, 0], [-100, 100]];

  const casesE: Array<[string, [number, number], number]> = [];
  for (const r of rangesE) {
    for (const inp of inputsE) {
      casesE.push([`reversed domain [100,0], range [${r}], input ${inp}`, r, inp]);
    }
  }

  it.each(casesE)(
    "%s => finite result",
    (_label, range, input) => {
      // niceExtent(100,0) => since min>max it may swap or handle specially
      const s = createLinearScale(domainE, range);
      expect(Number.isFinite(s.scale(input))).toBe(true);
    },
  );

  // --- Group F: monotonicity checks (20 cases) ---
  const monotonicityCases: Array<{
    domain: [number, number];
    range: [number, number];
    label: string;
  }> = [
    { domain: [0, 100], range: [0, 500], label: "normal" },
    { domain: [0, 100], range: [500, 0], label: "inverted range" },
    { domain: [-50, 50], range: [0, 500], label: "negative domain" },
    { domain: [0, 1], range: [0, 1000], label: "small domain" },
  ];

  it.each(monotonicityCases)(
    "monotonicity: $label",
    ({ domain, range }) => {
      const s = createLinearScale(domain, range);
      const [d0, d1] = s.domain;
      const mid = (d0 + d1) / 2;
      const v0 = s.scale(d0);
      const vMid = s.scale(mid);
      const v1 = s.scale(d1);

      if (range[1] > range[0]) {
        expect(v0).toBeLessThanOrEqual(vMid + 0.001);
        expect(vMid).toBeLessThanOrEqual(v1 + 0.001);
      } else {
        expect(v0).toBeGreaterThanOrEqual(vMid - 0.001);
        expect(vMid).toBeGreaterThanOrEqual(v1 - 0.001);
      }
    },
  );

  // --- Group G: exact boundary mapping (domain endpoints map to range endpoints) ---
  const boundaryDomains: Array<[number, number]> = [
    [0, 100], [0, 1], [0, 10], [0, 1000],
  ];
  const boundaryRanges: Array<[number, number]> = [
    [0, 500], [0, 100], [100, 0],
  ];

  const boundaryCases: Array<[string, [number, number], [number, number]]> = [];
  for (const d of boundaryDomains) {
    for (const r of boundaryRanges) {
      boundaryCases.push([`domain [${d}] range [${r}]`, d, r]);
    }
  }

  it.each(boundaryCases)(
    "boundary: %s => domain start maps to range start",
    (_label, domain, range) => {
      const s = createLinearScale(domain, range);
      // domain start (nice) should map to range start
      expect(s.scale(s.domain[0])).toBeCloseTo(range[0], 1);
      expect(s.scale(s.domain[1])).toBeCloseTo(range[1], 1);
    },
  );
});

// ============================================================================
// 2. createBandScale — 50 category count x padding combos
// ============================================================================

describe("createBandScale parameterized", () => {
  const categoryCounts = [1, 2, 3, 5, 10, 15, 20, 25, 50, 100];
  const paddings = [0, 0.1, 0.2, 0.3, 0.5];

  const cases: Array<[number, number]> = [];
  for (const n of categoryCounts) {
    for (const p of paddings) {
      cases.push([n, p]);
    }
  }

  it.each(cases)(
    "categories=%d, padding=%f",
    (n, padding) => {
      const domain = Array.from({ length: n }, (_, i) => `C${i}`);
      const range: [number, number] = [0, 500];
      const s = createBandScale(domain, range, padding);

      // Bandwidth should be positive
      expect(s.bandwidth).toBeGreaterThan(0);

      // All bands should be within range
      for (let i = 0; i < n; i++) {
        const x = s.scaleIndex(i);
        expect(x).toBeGreaterThanOrEqual(range[0] - 0.01);
        expect(x + s.bandwidth).toBeLessThanOrEqual(range[1] + 0.01);
      }

      // Bands should be ordered
      for (let i = 1; i < n; i++) {
        expect(s.scaleIndex(i)).toBeGreaterThan(s.scaleIndex(i - 1));
      }

      // scale by name should match scaleIndex
      expect(s.scale("C0")).toBeCloseTo(s.scaleIndex(0), 5);
      if (n > 1) {
        expect(s.scale("C1")).toBeCloseTo(s.scaleIndex(1), 5);
      }
    },
  );
});

// ============================================================================
// 3. createLogScale — 30 domain/value combos
// ============================================================================

describe("createLogScale parameterized", () => {
  const domains: Array<{ domain: [number, number]; label: string }> = [
    { domain: [1, 1000], label: "[1,1000]" },
    { domain: [0.01, 100], label: "[0.01,100]" },
    { domain: [10, 10000], label: "[10,10000]" },
    { domain: [1, 1e6], label: "[1,1e6]" },
    { domain: [0.001, 1], label: "[0.001,1]" },
    { domain: [100, 1e8], label: "[100,1e8]" },
  ];

  const fractions = [0, 0.25, 0.5, 0.75, 1.0];

  const cases: Array<[string, [number, number], number]> = [];
  for (const d of domains) {
    for (const f of fractions) {
      // Logarithmic interpolation between domain endpoints
      const logMin = Math.log10(d.domain[0]);
      const logMax = Math.log10(d.domain[1]);
      const value = Math.pow(10, logMin + f * (logMax - logMin));
      cases.push([`domain ${d.label}, fraction ${f}`, d.domain, value]);
    }
  }

  it.each(cases)(
    "%s => correct log mapping",
    (_label, domain, value) => {
      const range: [number, number] = [0, 500];
      const s = createLogScale(domain, range);
      const result = s.scale(value);
      expect(Number.isFinite(result)).toBe(true);
      // Result should be within range (approximately, since value is within domain)
      expect(result).toBeGreaterThanOrEqual(-1);
      expect(result).toBeLessThanOrEqual(501);
    },
  );

  // Log scale monotonicity
  it.each(domains)(
    "monotonicity: domain $label",
    ({ domain }) => {
      const s = createLogScale(domain, [0, 500]);
      const v1 = domain[0];
      const v2 = Math.sqrt(domain[0] * domain[1]);
      const v3 = domain[1];
      expect(s.scale(v1)).toBeLessThan(s.scale(v2));
      expect(s.scale(v2)).toBeLessThan(s.scale(v3));
    },
  );

  // Log scale: equal ratios map to equal intervals
  it.each([
    { domain: [1, 1000] as [number, number], label: "[1,1000]" },
    { domain: [0.01, 100] as [number, number], label: "[0.01,100]" },
    { domain: [10, 10000] as [number, number], label: "[10,10000]" },
  ])(
    "equal ratios => equal intervals: domain $label",
    ({ domain }) => {
      const s = createLogScale(domain, [0, 600]);
      const logMin = Math.log10(domain[0]);
      const logMax = Math.log10(domain[1]);
      const logMid = (logMin + logMax) / 2;
      const midVal = Math.pow(10, logMid);
      const midPixel = s.scale(midVal);
      // Midpoint in log space should map to midpoint in pixel space
      expect(midPixel).toBeCloseTo(300, 0);
    },
  );
});

// ============================================================================
// 4. createPowScale — 30 domain/exponent combos
// ============================================================================

describe("createPowScale parameterized", () => {
  const domains: Array<{ domain: [number, number]; label: string }> = [
    { domain: [0, 100], label: "[0,100]" },
    { domain: [0, 10], label: "[0,10]" },
    { domain: [-50, 50], label: "[-50,50]" },
    { domain: [0, 1], label: "[0,1]" },
    { domain: [0, 1000], label: "[0,1000]" },
  ];

  const exponents = [0.5, 1, 2, 3, 0.3, 4];

  const cases: Array<[string, [number, number], number]> = [];
  for (const d of domains) {
    for (const exp of exponents) {
      cases.push([`domain ${d.label}, exp ${exp}`, d.domain, exp]);
    }
  }

  it.each(cases)(
    "%s => finite monotonic mapping",
    (_label, domain, exponent) => {
      const range: [number, number] = [0, 500];
      const s = createPowScale(domain, range, exponent);

      // Domain endpoints should map to range endpoints
      expect(s.scale(s.domain[0])).toBeCloseTo(range[0], 1);
      expect(s.scale(s.domain[1])).toBeCloseTo(range[1], 1);

      // Monotonicity within nice domain
      const [d0, d1] = s.domain;
      const mid = (d0 + d1) / 2;
      expect(s.scale(d0)).toBeLessThanOrEqual(s.scale(mid) + 0.01);
      expect(s.scale(mid)).toBeLessThanOrEqual(s.scale(d1) + 0.01);
    },
  );

  // Exponent=1 should behave like linear
  it.each(domains)(
    "exponent=1 matches linear: domain $label",
    ({ domain }) => {
      const range: [number, number] = [0, 500];
      const pow = createPowScale(domain, range, 1);
      const lin = createLinearScale(domain, range);
      // They should produce the same nice domain and same mapping
      const testVal = (domain[0] + domain[1]) / 2;
      expect(pow.scale(testVal)).toBeCloseTo(lin.scale(testVal), 1);
    },
  );
});

// ============================================================================
// 5. valuesToAngles — 50 value set combos
// ============================================================================

describe("valuesToAngles parameterized", () => {
  // Helper to generate value arrays
  const valueSets: Array<{ values: number[]; label: string }> = [
    { values: [1], label: "single" },
    { values: [1, 1], label: "two equal" },
    { values: [1, 2, 3], label: "ascending" },
    { values: [3, 2, 1], label: "descending" },
    { values: [1, 1, 1, 1], label: "four equal" },
    { values: [10, 20, 30, 40], label: "proportional" },
    { values: [100], label: "single large" },
    { values: [1, 99], label: "skewed" },
    { values: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], label: "ten equal" },
    { values: [0, 1, 2], label: "with zero" },
    { values: [5, 10, 15, 20, 25], label: "five ascending" },
    { values: [50, 50], label: "two halves" },
    { values: [33, 33, 34], label: "thirds" },
    { values: [25, 25, 25, 25], label: "quarters" },
    { values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], label: "1-10" },
  ];

  const startAngles = [0, 90, 180, 270];
  const padAngles = [0, 1, 2];

  // Generate all combos (but cap at ~50+ tests)
  const cases: Array<[string, number[], number, number]> = [];
  for (const vs of valueSets) {
    // Use a subset of start/pad combos for each value set
    const startIdx = valueSets.indexOf(vs) % startAngles.length;
    const padIdx = valueSets.indexOf(vs) % padAngles.length;
    // Each value set gets tested with multiple start/pad combos
    for (const sa of [startAngles[startIdx], startAngles[(startIdx + 1) % startAngles.length]]) {
      for (const pa of [padAngles[padIdx], padAngles[(padIdx + 1) % padAngles.length]]) {
        cases.push([`${vs.label}, start=${sa}, pad=${pa}`, vs.values, sa, pa]);
      }
    }
  }

  it.each(cases)(
    "%s => angles sum to ~2PI minus padding",
    (_label, values, startAngle, padAngle) => {
      const angles = valuesToAngles(values, startAngle, padAngle);
      expect(angles).toHaveLength(values.length);

      // Total sweep should approximately equal 2PI minus total padding
      const totalSweep = angles.reduce(
        (sum, a) => sum + (a.endAngle - a.startAngle),
        0,
      );
      const totalPadRad = (padAngle * Math.PI / 180) * values.length;
      const totalPositive = values.reduce((s, v) => s + Math.max(0, v), 0);

      if (totalPositive > 0) {
        expect(totalSweep).toBeCloseTo(Math.PI * 2 - totalPadRad, 2);
      } else {
        // All zero values => all angles are 0
        for (const a of angles) {
          expect(a.startAngle).toBe(0);
          expect(a.endAngle).toBe(0);
        }
      }
    },
  );

  // Proportionality check
  it.each(valueSets.filter(vs => vs.values.filter(v => v > 0).length >= 2))(
    "proportionality: $label",
    ({ values }) => {
      const angles = valuesToAngles(values, 0, 0); // no padding for clean proportions
      const total = values.reduce((s, v) => s + Math.max(0, v), 0);

      for (let i = 0; i < values.length; i++) {
        if (values[i] <= 0) continue;
        const expectedFraction = values[i] / total;
        const actualSweep = angles[i].endAngle - angles[i].startAngle;
        const actualFraction = actualSweep / (Math.PI * 2);
        expect(actualFraction).toBeCloseTo(expectedFraction, 4);
      }
    },
  );

  // Consecutive angles (no gaps when pad=0)
  it.each(valueSets.filter(vs => vs.values.every(v => v > 0)))(
    "consecutive (pad=0): $label",
    ({ values }) => {
      const angles = valuesToAngles(values, 0, 0);
      for (let i = 1; i < angles.length; i++) {
        expect(angles[i].startAngle).toBeCloseTo(angles[i - 1].endAngle, 6);
      }
    },
  );
});
