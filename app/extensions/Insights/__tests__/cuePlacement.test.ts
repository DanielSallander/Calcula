//! FILENAME: app/extensions/Insights/__tests__/cuePlacement.test.ts
// PURPOSE: The fact-to-anchor mapper for IO-0: an `extremes` fact becomes a
//          ring on its best label, and every way the mapping could lie is a
//          refusal with a named reason.

import { describe, it, expect } from "vitest";
import { extremesFacts, ringsOnBest } from "../lib/cuePlacement";
import type { InsightBundle } from "@api/insightsService";
import type { ChartSeriesSnapshot } from "@api/chartData";

/** A facts document the way `build_facts_json` (core/insights/src/lib.rs) writes it. */
function factsJson(facts: unknown[]): string {
  return JSON.stringify({ engineVersion: 1, localeId: "en-US", source: { label: "the chart" }, facts }, null, 2);
}

function extremes(series: string, bestLabel: string, best: number, worstLabel = "Jan", worst = 1): unknown {
  return {
    id: `extremes:c//${series}/A1:A6:`,
    score: 0.6,
    evidenceA1: [],
    kind: {
      fact: "extremes",
      subject: { type: "column", name: series, sheet: "", range: { sheet: "", startRow: 0, startCol: 1, endRow: 0, endCol: 1 } },
      bestLabel,
      best,
      worstLabel,
      worst,
    },
  };
}

function bundle(facts: unknown[], texts: Record<string, string> = {}): InsightBundle {
  return {
    source: "range",
    insights: Object.entries(texts).map(([id, text]) => ({ id, kind: "extremes", score: 0.6, text, evidence: [], provenance: [] })),
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

describe("extremesFacts", () => {
  it("reads the extremes facts and nothing else out of the facts document", () => {
    const json = factsJson([
      { id: "trend:x", score: 1, evidenceA1: [], kind: { fact: "trend", subject: { type: "column", name: "Sales" }, slopePerStep: 1 } },
      extremes("Sales", "Mar", 300),
    ]);
    expect(extremesFacts(json)).toEqual([{ id: "extremes:c//Sales/A1:A6:", series: "Sales", bestLabel: "Mar", best: 300 }]);
  });

  it("answers [] for malformed input rather than throwing into a paint path", () => {
    expect(extremesFacts("not json")).toEqual([]);
    expect(extremesFacts("{}")).toEqual([]);
    expect(extremesFacts(JSON.stringify({ facts: [{ id: "x", kind: { fact: "extremes" } }] }))).toEqual([]);
  });
});

describe("ringsOnBest", () => {
  it("places a neutral ring at the best label's index, carrying the fact id and the narrated text", () => {
    const b = bundle([extremes("Sales", "Mar", 300)], { "extremes:c//Sales/A1:A6:": "Sales is highest at Mar (300) and lowest at Jan (100)." });
    const s = snapshot(["Jan", "Feb", "Mar", "Apr", "May"], { Sales: [100, 200, 300, 150, 250] });
    const { cues, dropped } = ringsOnBest(b, s);
    expect(dropped).toEqual([]);
    expect(cues).toEqual([
      {
        factId: "extremes:c//Sales/A1:A6:",
        kind: "ring",
        polarity: "neutral",
        anchor: { type: "datum", series: "Sales", categoryIndex: 2, categoryLabel: "Mar" },
        label: "Sales is highest at Mar (300) and lowest at Jan (100).",
      },
    ]);
  });

  it("maps every series' fact, each onto its own series", () => {
    const b = bundle([extremes("Sales", "Mar", 300), extremes("Cost", "Feb", 120)]);
    const s = snapshot(["Jan", "Feb", "Mar"], { Sales: [100, 200, 300], Cost: [80, 120, 90] });
    const { cues } = ringsOnBest(b, s);
    expect(cues.map((c) => [c.anchor.series, c.anchor.categoryIndex])).toEqual([["Sales", 2], ["Cost", 1]]);
  });

  it("uses the snapshot's (painter-space) index, which is what a filtered chart paints", () => {
    // Jan hidden: the snapshot the fact was computed on starts at Feb.
    const b = bundle([extremes("Sales", "Mar", 300)]);
    const s = snapshot(["Feb", "Mar", "Apr", "May"], { Sales: [200, 300, 150, 250] });
    expect(ringsOnBest(b, s).cues[0].anchor.categoryIndex).toBe(1);
  });

  it("refuses an ambiguous label — the Jan..Dec over two years case — rather than picking the first", () => {
    const b = bundle([extremes("Sales", "Mar", 300)]);
    const s = snapshot(["Jan", "Feb", "Mar", "Jan", "Feb", "Mar"], { Sales: [1, 2, 3, 100, 200, 300] });
    const r = ringsOnBest(b, s);
    expect(r.cues).toEqual([]);
    expect(r.dropped).toEqual([{ factId: "extremes:c//Sales/A1:A6:", reason: "label-ambiguous" }]);
  });

  it("refuses a label the chart no longer has (the data changed under the bundle)", () => {
    const b = bundle([extremes("Sales", "Mar", 300)]);
    const s = snapshot(["Q1", "Q2", "Q3"], { Sales: [100, 300, 200] });
    expect(ringsOnBest(b, s).dropped).toEqual([{ factId: "extremes:c//Sales/A1:A6:", reason: "label-not-found" }]);
  });

  it("refuses when the value at the resolved index is not the fact's number", () => {
    const b = bundle([extremes("Sales", "Mar", 300)]);
    const s = snapshot(["Jan", "Feb", "Mar"], { Sales: [100, 200, 999] });
    expect(ringsOnBest(b, s).dropped).toEqual([{ factId: "extremes:c//Sales/A1:A6:", reason: "value-mismatch" }]);
  });

  it("refuses a fact about a series the snapshot does not carry", () => {
    const b = bundle([extremes("Profit", "Mar", 300)]);
    const s = snapshot(["Jan", "Feb", "Mar"], { Sales: [100, 200, 300] });
    expect(ringsOnBest(b, s).dropped).toEqual([{ factId: "extremes:c//Profit/A1:A6:", reason: "series-not-in-snapshot" }]);
  });

  it("never invents a fact: a bundle with no extremes yields no cue", () => {
    const b = bundle([{ id: "trend:x", score: 1, evidenceA1: [], kind: { fact: "trend", subject: { type: "column", name: "Sales" } } }]);
    const s = snapshot(["Jan", "Feb", "Mar"], { Sales: [100, 200, 300] });
    expect(ringsOnBest(b, s)).toEqual({ cues: [], dropped: [] });
  });
});
