//! FILENAME: app/extensions/Insights/__tests__/cuePlacement.test.ts
// PURPOSE: The fact-to-anchor mapper: an `extremes` fact becomes a ring at its
//          `bestIndex`, the label and value at that index are the CHECK, the
//          polarity comes from the fact's direction provenance, and every way
//          the mapping could lie is a refusal with a named reason.

import { describe, it, expect } from "vitest";
import { extremesFacts, ringsOnBest, bestPolarity } from "../lib/cuePlacement";
import type { InsightBundle, InsightProvenance } from "@api/insightsService";
import type { ChartSeriesSnapshot } from "@api/chartData";

/** A facts document the way `build_facts_json` (core/insights/src/lib.rs) writes it. */
function factsJson(facts: unknown[]): string {
  return JSON.stringify({ engineVersion: 1, localeId: "en-US", source: { label: "the chart" }, facts }, null, 2);
}

const ID = "extremes:c//Sales/A1:A6:";

function extremes(series: string, bestLabel: string, bestIndex: number, best: number): unknown {
  return {
    id: `extremes:c//${series}/A1:A6:`,
    score: 0.6,
    evidenceA1: [],
    kind: {
      fact: "extremes",
      subject: { type: "column", name: series, sheet: "", range: { sheet: "", startRow: 0, startCol: 1, endRow: 0, endCol: 1 } },
      bestLabel,
      bestIndex,
      best,
      worstLabel: "Jan",
      worstIndex: 0,
      worst: 1,
    },
  };
}

function bundle(
  facts: unknown[],
  insights: Array<{ id: string; text?: string; provenance?: InsightProvenance[] }> = [],
): InsightBundle {
  return {
    source: "range",
    insights: insights.map((i) => ({
      id: i.id,
      kind: "extremes",
      score: 0.6,
      text: i.text ?? "",
      evidence: [],
      provenance: i.provenance ?? [],
    })),
    dropped: 0,
    markdown: "",
    factsJson: factsJson(facts),
    notes: [],
  };
}

function snapshot(categories: string[], series: Record<string, (number | null)[]>): ChartSeriesSnapshot {
  return {
    chartId: "chart-1",
    name: "Chart 1",
    title: null,
    sheetIndex: 0,
    mark: "bar",
    categories,
    categoryKind: "nominal",
    series: Object.entries(series).map(([name, values]) => ({ name, values })),
    truncated: false,
  };
}

const direction = (value: string): InsightProvenance => ({ attribute: "direction", value, source: "strategy" });

describe("extremesFacts", () => {
  it("reads the extremes facts, with their index, and nothing else", () => {
    const json = factsJson([
      { id: "trend:x", score: 1, evidenceA1: [], kind: { fact: "trend", subject: { type: "column", name: "Sales" }, slopePerStep: 1 } },
      extremes("Sales", "Mar", 2, 300),
    ]);
    expect(extremesFacts(json)).toEqual([{ id: ID, series: "Sales", bestLabel: "Mar", bestIndex: 2, best: 300 }]);
  });

  it("answers [] for malformed input, including a fact with no index, rather than throwing into a paint path", () => {
    expect(extremesFacts("not json")).toEqual([]);
    expect(extremesFacts("{}")).toEqual([]);
    expect(extremesFacts(JSON.stringify({ facts: [{ id: "x", kind: { fact: "extremes" } }] }))).toEqual([]);
    const noIndex = { ...(extremes("Sales", "Mar", 2, 300) as { kind: Record<string, unknown> }) };
    delete noIndex.kind.bestIndex;
    expect(extremesFacts(factsJson([noIndex]))).toEqual([]);
  });
});

describe("bestPolarity", () => {
  it("follows the declared direction and is neutral for everything else", () => {
    expect(bestPolarity({ provenance: [direction("higherIsBetter")] })).toBe("good");
    expect(bestPolarity({ provenance: [direction("lowerIsBetter")] })).toBe("bad");
    expect(bestPolarity({ provenance: [direction("withheld: covers only some members")] })).toBe("neutral");
    expect(bestPolarity({ provenance: [direction("targetBand")] })).toBe("neutral");
    expect(bestPolarity({ provenance: [direction("neutral")] })).toBe("neutral");
    expect(bestPolarity({ provenance: [] })).toBe("neutral");
    expect(bestPolarity(undefined)).toBe("neutral");
  });
});

describe("ringsOnBest", () => {
  it("places a ring at bestIndex, carrying the fact id and the narrated text, neutral with no strategy", () => {
    const b = bundle([extremes("Sales", "Mar", 2, 300)], [{ id: ID, text: "Sales is highest at Mar (300) and lowest at Jan (100)." }]);
    const s = snapshot(["Jan", "Feb", "Mar", "Apr", "May"], { Sales: [100, 200, 300, 150, 250] });
    const { cues, dropped } = ringsOnBest(b, s);
    expect(dropped).toEqual([]);
    expect(cues).toEqual([
      {
        factId: ID,
        kind: "ring",
        polarity: "neutral",
        anchor: { type: "datum", series: "Sales", categoryIndex: 2, categoryLabel: "Mar" },
        label: "Sales is highest at Mar (300) and lowest at Jan (100).",
      },
    ]);
  });

  it("colours the best point by the measure's declared direction: a Cost peak is BAD", () => {
    const b = bundle([extremes("Cost", "Mar", 2, 300)], [{ id: "extremes:c//Cost/A1:A6:", provenance: [direction("lowerIsBetter")] }]);
    const s = snapshot(["Jan", "Feb", "Mar"], { Cost: [100, 200, 300] });
    expect(ringsOnBest(b, s).cues[0].polarity).toBe("bad");

    const good = bundle([extremes("Sales", "Mar", 2, 300)], [{ id: ID, provenance: [direction("higherIsBetter")] }]);
    expect(ringsOnBest(good, snapshot(["Jan", "Feb", "Mar"], { Sales: [100, 200, 300] })).cues[0].polarity).toBe("good");
  });

  it("a withheld direction yields a neutral ring, never a guessed colour", () => {
    const b = bundle([extremes("Sales", "Mar", 2, 300)], [{ id: ID, provenance: [direction("withheld: rule r1 covers only some members")] }]);
    expect(ringsOnBest(b, snapshot(["Jan", "Feb", "Mar"], { Sales: [100, 200, 300] })).cues[0].polarity).toBe("neutral");
  });

  it("uses the index to choose between two identical labels — the Jan..Dec over two years case", () => {
    const b = bundle([extremes("Sales", "Mar", 5, 300)]);
    const s = snapshot(["Jan", "Feb", "Mar", "Jan", "Feb", "Mar"], { Sales: [1, 2, 3, 100, 200, 300] });
    const r = ringsOnBest(b, s);
    expect(r.dropped).toEqual([]);
    expect(r.cues[0].anchor.categoryIndex).toBe(5);
  });

  it("the index counts gaps, so a blank month before the peak does not shift the ring", () => {
    // Rust's Series drops the null and reports the SUPPLIED position (3).
    const b = bundle([extremes("Sales", "Apr", 3, 300)]);
    const s = snapshot(["Jan", "Feb", "Mar", "Apr"], { Sales: [100, null, 200, 300] });
    const r = ringsOnBest(b, s);
    expect(r.dropped).toEqual([]);
    expect(r.cues[0].anchor).toEqual({ type: "datum", series: "Sales", categoryIndex: 3, categoryLabel: "Apr" });
  });

  it("refuses an index whose label is not the fact's label (the data changed under the bundle)", () => {
    const b = bundle([extremes("Sales", "Mar", 2, 300)]);
    const s = snapshot(["Q1", "Q2", "Q3"], { Sales: [100, 200, 300] });
    expect(ringsOnBest(b, s).dropped).toEqual([{ factId: ID, reason: "label-mismatch" }]);
  });

  it("refuses an index past the end of the snapshot", () => {
    const b = bundle([extremes("Sales", "Mar", 9, 300)]);
    expect(ringsOnBest(b, snapshot(["Jan", "Feb", "Mar"], { Sales: [100, 200, 300] })).dropped).toEqual([
      { factId: ID, reason: "index-out-of-range" },
    ]);
  });

  it("refuses when the value at the index is not the fact's number", () => {
    const b = bundle([extremes("Sales", "Mar", 2, 300)]);
    expect(ringsOnBest(b, snapshot(["Jan", "Feb", "Mar"], { Sales: [100, 200, 999] })).dropped).toEqual([
      { factId: ID, reason: "value-mismatch" },
    ]);
  });

  it("refuses a fact about a series the snapshot does not carry", () => {
    const b = bundle([extremes("Profit", "Mar", 2, 300)]);
    expect(ringsOnBest(b, snapshot(["Jan", "Feb", "Mar"], { Sales: [100, 200, 300] })).dropped).toEqual([
      { factId: "extremes:c//Profit/A1:A6:", reason: "series-not-in-snapshot" },
    ]);
  });

  it("never invents a fact: a bundle with no extremes yields no cue", () => {
    const b = bundle([{ id: "trend:x", score: 1, evidenceA1: [], kind: { fact: "trend", subject: { type: "column", name: "Sales" } } }]);
    expect(ringsOnBest(b, snapshot(["Jan", "Feb", "Mar"], { Sales: [100, 200, 300] }))).toEqual({ cues: [], dropped: [] });
  });
});
