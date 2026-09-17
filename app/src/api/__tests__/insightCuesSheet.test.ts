//! FILENAME: app/src/api/__tests__/insightCuesSheet.test.ts
// PURPOSE: IO-4's cell rules: a fact's dataset row becomes the SHEET row the
//          facts document names in `rowOrigins` (header and hidden rows
//          already accounted for), on the subject's column, on the analysed
//          sheet and no other; polarity from provenance; every refusal named.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { cuesForSheet, parseFactsDocument, CELL_CUE_FACT_KINDS } from "../insightCues";
import type { InsightBundle, InsightProvenance } from "../insightsService";

const FIXTURE = path.resolve(__dirname, "../../../../core/insights/fixtures/every-fact-kind-facts.json");
const pinned = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as { facts: unknown[]; source: { sheet: string } };

/** The pinned facts (indices up to 7) over a 12-row dataset whose rows start at sheet row 4, with row 6 hidden. */
const ROW_ORIGINS = [4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

function bundleOf(facts: unknown[], provenance: InsightProvenance[] = [], sheet = "Sales"): InsightBundle {
  return {
    source: "range",
    insights: (facts as Array<{ id: string; kind: { fact: string } }>).map((f) => ({ id: f.id, kind: f.kind.fact, score: 0.5, text: `about ${f.id}`, evidence: [], provenance })),
    dropped: 0, markdown: "", notes: [],
    factsJson: JSON.stringify({ engineVersion: 1, localeId: "en-US", source: { label: "x", sheet }, rowOrigins: ROW_ORIGINS, facts }),
  };
}

const onSales = (name: string): number | null => (name === "Sales" ? 3 : null);
const factOf = (kind: string) => pinned.facts.find((f) => (f as { kind: { fact: string } }).kind.fact === kind)!;

describe("parseFactsDocument", () => {
  it("reads rowOrigins and the source sheet from the pinned document", () => {
    const doc = parseFactsDocument(fs.readFileSync(FIXTURE, "utf8"));
    expect(doc.rowOrigins).toEqual([1, 2, 3]);
    expect(doc.sourceSheet).toBe("Sheet1");
    expect(doc.facts.length).toBeGreaterThan(19);
    expect(parseFactsDocument("nope")).toEqual({ facts: [], rowOrigins: [], sourceSheet: null });
  });
});

describe("cuesForSheet", () => {
  it("maps extremes to the best and worst rows' SHEET rows on the subject column", () => {
    const f = factOf("extremes") as { kind: { bestIndex: number; worstIndex: number; subject: { range: { startCol: number } } } };
    const { cues, dropped } = cuesForSheet(bundleOf([f]), onSales);
    expect(dropped).toEqual([]);
    expect(cues.map((c) => [c.row, c.col, c.sheetIndex, c.description])).toEqual([
      [ROW_ORIGINS[f.kind.bestIndex], f.kind.subject.range.startCol, 3, "Highest Revenue"],
      [ROW_ORIGINS[f.kind.worstIndex], f.kind.subject.range.startCol, 3, "Lowest Revenue"],
    ]);
    expect(cues[0].label).toBe(`about ${(f as { id: string }).id}`);
  });

  it("covers every cell-cue kind in the fixture and drops the ones that carry no row", () => {
    for (const kind of CELL_CUE_FACT_KINDS) {
      const f = factOf(kind);
      const { cues, dropped } = cuesForSheet(bundleOf([f]), onSales);
      expect(cues.length, kind).toBeGreaterThan(0);
      expect(dropped, kind).toEqual([]);
      for (const c of cues) {
        expect(ROW_ORIGINS, `${kind} row ${c.row} must be a sheet row the document named`).toContain(c.row);
        expect(c.sheetIndex).toBe(3);
      }
    }
    for (const kind of ["pareto", "dominance"]) {
      const r = cuesForSheet(bundleOf([factOf(kind)]), onSales);
      expect(r.cues).toEqual([]);
      expect(r.dropped[0]?.reason, kind).toBe("no-position-in-fact");
    }
    for (const kind of ["shape", "columnSummary", "trend", "change", "seasonality", "correlation", "leader", "errors", "mixedTypes", "blankRows", "duplicates", "textSummary", "booleanShare"]) {
      const r = cuesForSheet(bundleOf([factOf(kind)]), onSales);
      expect(r.cues, kind).toEqual([]);
      expect(r.dropped, kind).toEqual([]);
    }
  });

  it("a crossover marks the row on BOTH columns", () => {
    const f = factOf("crossover") as { kind: { atIndex: number; a: { range: { startCol: number } }; b: { range: { startCol: number } } } };
    const { cues } = cuesForSheet(bundleOf([f]), onSales);
    expect(cues.map((c) => [c.row, c.col])).toEqual([
      [ROW_ORIGINS[f.kind.atIndex], f.kind.a.range.startCol],
      [ROW_ORIGINS[f.kind.atIndex], f.kind.b.range.startCol],
    ]);
  });

  it("polarity follows the direction and is neutral when withheld; outliers are attention", () => {
    const f = factOf("extremes");
    const lower = cuesForSheet(bundleOf([f], [{ attribute: "direction", value: "lowerIsBetter", source: "strategy" }]), onSales);
    expect(lower.cues.map((c) => c.polarity)).toEqual(["bad", "good"]);
    const held = cuesForSheet(bundleOf([f], [{ attribute: "direction", value: "withheld: r1", source: "rule:r1" }]), onSales);
    expect(held.cues.map((c) => c.polarity)).toEqual(["neutral", "neutral"]);
    const o = cuesForSheet(bundleOf([factOf("outliers")]), onSales);
    for (const c of o.cues) expect(c.polarity).toBe("attention");
  });

  it("refuses a sheet that is not the analysed one, and a row the document does not name", () => {
    const f = factOf("extremes");
    expect(cuesForSheet(bundleOf([f]), () => null).dropped).toEqual([{ factId: (f as { id: string }).id, reason: "sheet-not-open" }]);
    // One dataset row: neither the best (7) nor the worst (1) has a sheet row.
    const short = bundleOf([f]);
    short.factsJson = JSON.stringify({ ...JSON.parse(short.factsJson), rowOrigins: [4] });
    const r = cuesForSheet(short, onSales);
    expect(r.cues).toEqual([]);
    expect(r.dropped).toEqual([{ factId: (f as { id: string }).id, reason: "row-not-in-dataset" }]);
    // With two rows the worst (index 1) still lands and nothing is dropped: a
    // partial placement is a placement, not a refusal.
    const two = bundleOf([f]);
    two.factsJson = JSON.stringify({ ...JSON.parse(two.factsJson), rowOrigins: [4, 5] });
    expect(cuesForSheet(two, onSales).cues.map((c) => c.row)).toEqual([5]);
  });

  it("is deterministic", () => {
    const facts = CELL_CUE_FACT_KINDS.map(factOf);
    const first = JSON.stringify(cuesForSheet(bundleOf(facts), onSales));
    for (let i = 0; i < 10; i++) expect(JSON.stringify(cuesForSheet(bundleOf(facts), onSales))).toBe(first);
  });
});
