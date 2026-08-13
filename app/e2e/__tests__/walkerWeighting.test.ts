//! FILENAME: app/e2e/__tests__/walkerWeighting.test.ts
// PURPOSE: Unit tier for the walker's family weighting — the knob that lets a
//          run be AIMED at a surface without editing the catalog.
//
// WHY IT EXISTS. The catalog's 59 actions carry flat weights, so a 75-action
// walk spends roughly four actions on any one feature and can miss a surface
// entirely for a dozen walks running. BUG-0031 (chart.create told the backend
// and never the chart store) survived the whole programme partly for that
// reason. `categoryWeights` makes "explore charts hard" a run parameter.
//
// Two properties are load-bearing and neither is obvious:
//   1. The boost must reach `chart.deselect`, whose CATEGORY is the
//      cross-feature "deselect" rather than "chart". A boost that only matched
//      `category` would raise charts without ever clearing the selection,
//      which is precisely the transition the contextual-tab invariant tests.
//   2. The boost must not touch replay. The trace records concrete action ids,
//      so a recorded repro replays identically whatever the weights were.

import { describe, it, expect } from "vitest";
import {
  ACTION_CATALOG,
  actionFamilies,
  createGeneratorSource,
  findAction,
  parseCategoryWeights,
} from "../walker";
import type { StateSnapshot } from "../invariants/stateSnapshot";

/** A snapshot permissive enough that most preconditions hold. */
function snapshot(overrides: Partial<StateSnapshot["logical"]> = {}): StateSnapshot {
  return {
    logical: {
      slicers: [],
      charts: [{ id: "c1" }],
      tables: [{ id: "t1" }],
      timelines: [],
      pivots: [],
      sparklineGroups: [],
      ...overrides,
    },
    visual: { ribbonTabs: [] },
    jsExceptions: [],
    consoleErrors: [],
  } as unknown as StateSnapshot;
}

function drawFamilies(
  seed: number,
  draws: number,
  categoryWeights?: Record<string, number>
): Record<string, number> {
  const source = createGeneratorSource({ seed, rapidFireProbability: 0, categoryWeights });
  const snap = snapshot();
  const counts: Record<string, number> = {};
  for (let i = 0; i < draws; i++) {
    const instance = source.next(snap, i + 1);
    const family = instance!.id.split(".")[0];
    counts[family] = (counts[family] ?? 0) + 1;
  }
  return counts;
}

describe("family weight boosts", () => {
  it("parses the env-var spec", () => {
    expect(parseCategoryWeights("chart:8")).toEqual({ chart: 8 });
    expect(parseCategoryWeights("chart:8, table:2 ")).toEqual({ chart: 8, table: 2 });
    expect(parseCategoryWeights("chart:0")).toEqual({ chart: 0 });
  });

  it("treats absent/empty as no boost at all", () => {
    expect(parseCategoryWeights("")).toBeUndefined();
    expect(parseCategoryWeights(undefined)).toBeUndefined();
    expect(parseCategoryWeights(null)).toBeUndefined();
    expect(parseCategoryWeights(" , ")).toBeUndefined();
  });

  it("refuses a malformed spec instead of silently ignoring it", () => {
    // A typo that parsed to "no boost" would produce an unweighted run
    // reported as a weighted one — the failure mode the replay commands exist
    // to prevent.
    expect(() => parseCategoryWeights("chart")).toThrow(/expected/);
    expect(() => parseCategoryWeights("chart:many")).toThrow(/finite/);
    expect(() => parseCategoryWeights("chart:-1")).toThrow(/finite/);
    expect(() => parseCategoryWeights(":8")).toThrow(/expected/);
  });

  it("reaches chart.deselect even though its category is 'deselect'", () => {
    const deselect = findAction("chart.deselect", ACTION_CATALOG)!;
    expect(deselect.category).toBe("deselect");
    expect(actionFamilies(deselect)).toContain("chart");

    const create = findAction("chart.create", ACTION_CATALOG)!;
    expect(actionFamilies(create)).toEqual(["chart"]);
  });

  it("actually shifts the distribution toward the boosted family", () => {
    const flat = drawFamilies(20260812, 600);
    const boosted = drawFamilies(20260812, 600, { chart: 12 });
    expect(boosted.chart ?? 0).toBeGreaterThan((flat.chart ?? 0) * 3);
    // ...and does not starve the rest of the walk into a single action.
    expect(Object.keys(boosted).length).toBeGreaterThan(5);
  });

  it("is a no-op when the spec is undefined — same walk, same seed", () => {
    expect(drawFamilies(4242, 200)).toEqual(drawFamilies(4242, 200, undefined));
  });

  it("changes the walk for a given seed, which is why replay commands carry it", () => {
    // The detector for the lie this guard prevents: if these were equal, a
    // replay command that dropped the weights would still be correct, and the
    // extra env var in the bundle would be noise. They are not equal.
    expect(drawFamilies(4242, 200)).not.toEqual(drawFamilies(4242, 200, { chart: 12 }));
  });
});
