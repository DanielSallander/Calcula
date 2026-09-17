//! FILENAME: app/src/api/__tests__/pivotCues.test.ts
// PURPOSE: The member-based pivot route. A model's facts land on the pivot
//          cells whose header labels the facts name; the cell that IS the fact
//          wins over the cells that merely cover it; polarity is the strategy's
//          (favourability, or a borrowed direction) and never the number's; a
//          fact naming a measure, dimension, member or period the pivot does not
//          show is dropped with that reason, never guessed.

import { describe, it, expect } from "vitest";
import { pivotCuesFor, dimensionToFieldName, stripBrackets, PIVOT_CUE_FACT_KINDS } from "../pivotCues";
import type { InsightBundle } from "../insightsService";
import type { PivotCellData, PivotRowData, PivotViewResponse, PivotCellType, PivotRowType } from "../pivotTypes";

// ============================================================================
// A small pivot-view builder (the engine's shapes, hand-built)
// ============================================================================

type GP = Array<[number, number]>;

function cell(cellType: PivotCellType, value: number | string, groupPath?: GP): PivotCellData {
  return { cellType, value, backgroundStyle: "Normal" as PivotCellData["backgroundStyle"], ...(groupPath ? { groupPath } : {}) };
}

function row(rowType: PivotRowType, depth: number, cells: PivotCellData[], viewRow: number): PivotRowData {
  return { viewRow, rowType, depth, visible: true, cells };
}

function view(rows: PivotRowData[], rowFields: string[], colFields: string[]): PivotViewResponse {
  return {
    pivotId: "p1", version: 1, rowCount: rows.length, colCount: rows[0]?.cells.length ?? 0,
    rowLabelColCount: 1, columnHeaderRowCount: rows.filter((r) => r.rowType === "ColumnHeader").length, filterRowCount: 0, filterRows: [],
    rowFieldSummaries: rowFields.map((fieldName, i) => ({ fieldIndex: i, fieldName, hasActiveFilter: false })),
    columnFieldSummaries: colFields.map((fieldName, i) => ({ fieldIndex: 10 + i, fieldName, hasActiveFilter: false })),
    rows, columns: [],
  };
}

const CAT = 0; // Product.Category, fieldIndex 0
const QTR = 10; // Date.Quarter, fieldIndex 10
const GADGETS = 1, WIDGETS = 2, Q1 = 21, Q2 = 22;

/**
 * Category × Quarter, one value field:
 *
 *              | 2024-Q1 | 2024-Q2 | Grand Total
 *   Gadgets    |   100   |   150   |   250
 *   Widgets    |   200   |   190   |   390
 *   Grand Total|   300   |   340   |   640
 */
function categoryByQuarter(): PivotViewResponse {
  return view([
    row("ColumnHeader", 0, [cell("Corner", ""), cell("ColumnHeader", "2024-Q1", [[QTR, Q1]]), cell("ColumnHeader", "2024-Q2", [[QTR, Q2]]), cell("GrandTotalColumn", "Grand Total")], 0),
    row("Data", 0, [cell("RowHeader", "Gadgets", [[CAT, GADGETS]]), cell("Data", 100, [[CAT, GADGETS], [QTR, Q1]]), cell("Data", 150, [[CAT, GADGETS], [QTR, Q2]]), cell("GrandTotalColumn", 250, [[CAT, GADGETS]])], 1),
    row("Data", 0, [cell("RowHeader", "Widgets", [[CAT, WIDGETS]]), cell("Data", 200, [[CAT, WIDGETS], [QTR, Q1]]), cell("Data", 190, [[CAT, WIDGETS], [QTR, Q2]]), cell("GrandTotalColumn", 390, [[CAT, WIDGETS]])], 2),
    row("GrandTotal", 0, [cell("GrandTotalRow", "Grand Total", []), cell("GrandTotalRow", 300, [[QTR, Q1]]), cell("GrandTotalRow", 340, [[QTR, Q2]]), cell("GrandTotal", 640, [])], 3),
  ], ["Product.Category"], ["Date.Quarter"]);
}

/**
 * Category only, two value fields with a caption row:
 *
 *              | [Total Sales] | [Cost]
 *   Gadgets    |     250       |  80
 *   Widgets    |     390       |  90
 */
function categoryTwoMeasures(captions: [string, string] = ["[Total Sales]", "[Cost]"]): PivotViewResponse {
  return view([
    row("ColumnHeader", 0, [cell("Corner", ""), cell("ColumnHeader", captions[0]), cell("ColumnHeader", captions[1])], 0),
    row("Data", 0, [cell("RowHeader", "Gadgets", [[CAT, GADGETS]]), cell("Data", 250, [[CAT, GADGETS]]), cell("Data", 80, [[CAT, GADGETS]])], 1),
    row("Data", 0, [cell("RowHeader", "Widgets", [[CAT, WIDGETS]]), cell("Data", 390, [[CAT, WIDGETS]]), cell("Data", 90, [[CAT, WIDGETS]])], 2),
  ], ["Product.Category"], []);
}

const REG = 1; // Geo.Region, fieldIndex 1
const NORTH = 5, SOUTH = 6;

/**
 * Region ▸ Category (compact), one value field, no columns. The parent row is
 * always there (compact layout shows it); with subtotals on it carries the
 * region's number, with them off its value cell is blank:
 *
 *   North        | 300     ← RowSubtotal number, or Blank
 *     Gadgets    | 100
 *     Widgets    | 200
 *   South        | 290
 *     Gadgets    | 150
 *     Widgets    | 140
 */
function regionThenCategory(withSubtotals: boolean): PivotViewResponse {
  const rows: PivotRowData[] = [row("ColumnHeader", 0, [cell("Corner", ""), cell("ColumnHeader", "[Total Sales]")], 0)];
  let i = 1;
  for (const [region, rid, values] of [["North", NORTH, [100, 200]], ["South", SOUTH, [150, 140]]] as const) {
    const parentValue = withSubtotals ? cell("RowSubtotal", values[0] + values[1], [[REG, rid]]) : cell("Blank", "");
    rows.push(row("Data", 0, [cell("RowHeader", region, [[REG, rid]]), parentValue], i++));
    rows.push(row("Data", 1, [cell("RowHeader", "Gadgets", [[REG, rid], [CAT, GADGETS]]), cell("Data", values[0], [[REG, rid], [CAT, GADGETS]])], i++));
    rows.push(row("Data", 1, [cell("RowHeader", "Widgets", [[REG, rid], [CAT, WIDGETS]]), cell("Data", values[1], [[REG, rid], [CAT, WIDGETS]])], i++));
  }
  // Field summaries are by index: Region is 1, Category is 0.
  const v = view(rows, [], []);
  v.rowFieldSummaries = [{ fieldIndex: REG, fieldName: "Geo.Region", hasActiveFilter: false }, { fieldIndex: CAT, fieldName: "Product.Category", hasActiveFilter: false }];
  return v;
}

// ============================================================================
// Facts
// ============================================================================

type Fact = { id: string; kind: Record<string, unknown>; direction?: string; text?: string };

function bundle(facts: Fact[]): InsightBundle {
  return {
    source: "model",
    insights: facts.map((f) => ({
      id: f.id, kind: String(f.kind.fact), score: 0.5, text: f.text ?? `Sentence for ${f.id}.`, evidence: [],
      provenance: f.direction ? [{ attribute: "direction", value: f.direction, source: "strategy", detail: "" }] : [],
    })),
    dropped: 0, markdown: "", notes: [],
    factsJson: JSON.stringify({ modelLabel: "Sales", facts: facts.map((f) => ({ id: f.id, score: 0.5, kind: f.kind })) }),
  } as unknown as InsightBundle;
}

const change = (measure: string, favourability: string | null, extra: Record<string, unknown> = {}): Fact => ({
  id: `change:m/${measure}`, direction: "higherIsBetter",
  kind: { fact: "change", measure, firstLabel: "2024-Q1", lastLabel: "2024-Q2", first: 300, last: 340, delta: 40, pct: 0.133, favourability, band: null, ...extra },
});

const contribution = (measure: string, dimension: string, members: Array<[string, number]>): Fact => ({
  id: `contribution:m/${measure}/${dimension}`,
  kind: { fact: "contribution", measure, dimension, totalDelta: 40, members: members.map(([member, delta]) => ({ member, first: 0, last: 0, delta, share: delta / 40 })), others: null, explained: 1 },
});

const memberMove = (measure: string, dimension: string, member: string, delta: number): Fact => ({
  id: `memberMove:m/${measure}/${dimension}/${member}`,
  kind: { fact: "memberMove", measure, dimension, member, first: 1, last: 1 + delta, delta },
});

const series = (measure: string, inner: Record<string, unknown>, direction?: string): Fact => ({
  id: `${inner.fact}:m/${measure}`, direction,
  kind: { fact: "series", inner: { subject: { type: "measure", name: measure }, ...inner } },
});

const at = (c: { viewRow: number; viewCol: number }) => [c.viewRow, c.viewCol];

// ============================================================================
// Spellings
// ============================================================================

describe("spellings", () => {
  it("turns a strategy column into a pivot field name and strips a value field's brackets", () => {
    expect(dimensionToFieldName("Product[Category]")).toBe("Product.Category");
    expect(dimensionToFieldName("Sales Data[Sub Category]")).toBe("Sales Data.Sub Category");
    expect(dimensionToFieldName("Product.Category")).toBe("Product.Category");
    expect(stripBrackets("[Total Sales]")).toBe("Total Sales");
    expect(stripBrackets("Sum of Sales")).toBe("Sum of Sales");
  });

  it("declares the kinds it places", () => {
    expect([...PIVOT_CUE_FACT_KINDS]).toEqual(["change", "variance", "contribution", "memberMove", "series"]);
  });
});

// ============================================================================
// Placement
// ============================================================================

describe("a change fact", () => {
  it("lands on the measure's cell at the last period — the grand-total row, whose only pair is the period", () => {
    const set = pivotCuesFor(bundle([change("Total Sales", "better")]), categoryByQuarter(), ["[Total Sales]"]);
    expect(set.dropped).toEqual([]);
    expect(set.cues.map(at)).toEqual([[3, 2]]);
    expect(set.cues[0]).toMatchObject({ factId: "change:m/Total Sales", polarity: "good", description: "Total Sales up 13%", label: "Sentence for change:m/Total Sales." });
  });

  it("is coloured by Rust's favourability, so a withheld direction is neutral and 'worse' is bad", () => {
    expect(pivotCuesFor(bundle([change("Total Sales", null)]), categoryByQuarter(), ["[Total Sales]"]).cues[0].polarity).toBe("neutral");
    expect(pivotCuesFor(bundle([change("Total Sales", "worse", { delta: -40, pct: -0.1 })]), categoryByQuarter(), ["[Total Sales]"]).cues[0]).toMatchObject({ polarity: "bad", description: "Total Sales down 10%" });
  });

  it("is dropped when the pivot shows no period axis", () => {
    const set = pivotCuesFor(bundle([change("Total Sales", "better")]), categoryTwoMeasures(), ["[Total Sales]", "[Cost]"]);
    expect(set.cues).toEqual([]);
    expect(set.dropped).toEqual([{ factId: "change:m/Total Sales", reason: "period-not-in-pivot" }]);
  });
});

describe("a contribution fact", () => {
  it("lands each member on its cell at the measure's last period, coloured by the direction that judged the measure", () => {
    const facts = [change("Total Sales", "better"), contribution("Total Sales", "Product[Category]", [["Gadgets", 50], ["Widgets", -10]])];
    const set = pivotCuesFor(bundle(facts), categoryByQuarter(), ["[Total Sales]"]);
    expect(set.dropped).toEqual([]);
    const members = set.cues.filter((c) => c.factId.startsWith("contribution"));
    expect(members.map(at)).toEqual([[1, 2], [2, 2]]);
    expect(members.map((c) => [c.polarity, c.description])).toEqual([["good", "Gadgets: Total Sales up"], ["bad", "Widgets: Total Sales down"]]);
  });

  it("borrows lowerIsBetter the same way, and stays neutral when no direction reached the measure", () => {
    const lower = [{ ...change("Cost", "worse"), direction: "lowerIsBetter" }, contribution("Cost", "Product[Category]", [["Gadgets", 5]])];
    const v = categoryByQuarter();
    expect(pivotCuesFor(bundle(lower), v, ["[Cost]"]).cues.find((c) => c.factId.startsWith("contribution"))?.polarity).toBe("bad");
    const none = [{ ...change("Cost", null), direction: undefined }, contribution("Cost", "Product[Category]", [["Gadgets", 5]])];
    expect(pivotCuesFor(bundle(none), v, ["[Cost]"]).cues.find((c) => c.factId.startsWith("contribution"))?.polarity).toBe("neutral");
  });

  it("without a period axis lands on the member's own cell of the measure's column", () => {
    const set = pivotCuesFor(bundle([contribution("Total Sales", "Product[Category]", [["Widgets", 12]])]), categoryTwoMeasures(), ["[Total Sales]", "[Cost]"]);
    expect(set.cues.map(at)).toEqual([[2, 1]]);
    expect(set.dropped).toEqual([]);
  });

  it("prefers the cell that IS the member (a subtotal) and otherwise marks every cell the member covers", () => {
    const facts = [contribution("Total Sales", "Geo[Region]", [["North", 30]]), contribution("Total Sales", "Product[Category]", [["Gadgets", 30]])];
    const withSub = pivotCuesFor(bundle(facts), regionThenCategory(true), ["[Total Sales]"]);
    expect(withSub.cues.filter((c) => c.factId.includes("Region")).map(at)).toEqual([[1, 1]]);
    // Gadgets has no cell of its own: both Gadgets leaves are marked.
    expect(withSub.cues.filter((c) => c.factId.includes("Category")).map(at)).toEqual([[2, 1], [5, 1]]);
    // Subtotals off: North has no number of its own, so both North leaves are marked.
    const noSub = pivotCuesFor(bundle(facts), regionThenCategory(false), ["[Total Sales]"]);
    expect(noSub.cues.filter((c) => c.factId.includes("Region")).map(at)).toEqual([[2, 1], [3, 1]]);
  });

  it("matches a member on ITS dimension only, never a same-named label on another field", () => {
    // "North" exists on Geo.Region; asking for it on Product.Category must not match.
    const set = pivotCuesFor(bundle([contribution("Total Sales", "Product[Category]", [["North", 30]])]), regionThenCategory(true), ["[Total Sales]"]);
    expect(set.cues).toEqual([]);
    expect(set.dropped).toEqual([{ factId: "contribution:m/Total Sales/Product[Category]", reason: "member-not-in-pivot" }]);
  });
});

describe("a blank member", () => {
  it("is never the cell a fact lands on: its leaf carries a subtotal's pairs, and a fact names no blank", () => {
    // Found live: a null product category. The engine skips VALUE_ID_EMPTY, so
    // the blank column's header has no path and its leaf cells carry only the
    // month pair — the same pairs as the month's grand total.
    const v = view([
      row("ColumnHeader", 0, [cell("Corner", ""), cell("ColumnHeader", "", []), cell("ColumnHeader", "Gadgets", [[CAT, GADGETS]]), cell("GrandTotalColumn", "Grand Total")], 0),
      row("Data", 0, [cell("RowHeader", "2024-Q2", [[QTR, Q2]]), cell("Data", 16, [[QTR, Q2]]), cell("Data", 150, [[QTR, Q2], [CAT, GADGETS]]), cell("GrandTotalColumn", 166, [[QTR, Q2]])], 1),
      row("GrandTotal", 0, [cell("GrandTotalRow", "Grand Total", []), cell("GrandTotalRow", 16, []), cell("GrandTotalRow", 150, [[CAT, GADGETS]]), cell("GrandTotal", 166, [])], 2),
    // Field indices are what matter to the mapper: CAT (0) is Product.Category
    // and QTR (10) is Date.Quarter, whichever axis the builder lists them on.
    ], ["Product.Category"], ["Date.Quarter"]);
    const set = pivotCuesFor(bundle([change("Total Sales", "better"), contribution("Total Sales", "Product[Category]", [["Gadgets", 5], ["", 3]])]), v, ["[Total Sales]"]);
    expect(set.cues.map((c) => [c.description, ...at(c)])).toEqual([["Total Sales up 13%", 1, 3], ["Gadgets: Total Sales up", 1, 2]]);
    expect(set.dropped).toEqual([]);
  });
});

describe("a member move and a series fact", () => {
  it("place like a contribution and like a change, respectively", () => {
    const facts = [change("Total Sales", "better"), memberMove("Total Sales", "Product[Category]", "Widgets", -3), series("Total Sales", { fact: "changePoint", atLabel: "2024-Q2", atIndex: 1, before: 1, after: 2 }, "higherIsBetter")];
    const set = pivotCuesFor(bundle(facts), categoryByQuarter(), ["[Total Sales]"]);
    expect(set.dropped).toEqual([]);
    expect(set.cues.map((c) => [c.factId, ...at(c), c.polarity, c.description])).toEqual([
      ["change:m/Total Sales", 3, 2, "good", "Total Sales up 13%"],
      ["memberMove:m/Total Sales/Product[Category]/Widgets", 2, 2, "bad", "Widgets: Total Sales down"],
      ["changePoint:m/Total Sales", 3, 2, "attention", "Level shift in Total Sales"],
    ]);
  });

  it("place extremes and outliers by label and colour them by the fact's own direction", () => {
    const facts = [
      series("Total Sales", { fact: "extremes", bestLabel: "2024-Q2", bestIndex: 1, best: 340, worstLabel: "2024-Q1", worstIndex: 0, worst: 300 }, "lowerIsBetter"),
      series("Total Sales", { fact: "outliers", points: [{ label: "2024-Q1", index: 0, value: 300 }] }),
      series("Total Sales", { fact: "trend", direction: "rising", last: 340 }),
    ];
    const set = pivotCuesFor(bundle(facts), categoryByQuarter(), ["[Total Sales]"]);
    expect(set.cues.map((c) => [...at(c), c.polarity, c.description])).toEqual([
      [3, 2, "bad", "Highest Total Sales"],
      [3, 1, "good", "Lowest Total Sales"],
      [3, 1, "attention", "Outlier in Total Sales"],
    ]);
    expect(set.dropped).toEqual([]); // trend points at no period: neither list
  });
});

// ============================================================================
// Measures and captions
// ============================================================================

describe("measures", () => {
  it("resolves a column's measure from the caption row, so Cost lands in the Cost column", () => {
    const facts = [contribution("Cost", "Product[Category]", [["Gadgets", 4]]), contribution("Total Sales", "Product[Category]", [["Gadgets", 4]])];
    const set = pivotCuesFor(bundle(facts), categoryTwoMeasures(), ["[Total Sales]", "[Cost]"]);
    expect(set.cues.map((c) => [c.factId.split("/")[0], ...at(c)])).toEqual([["contribution:m", 1, 2], ["contribution:m", 1, 1]]);
  });

  it("assumes the pivot's only value field when no caption row names it", () => {
    const set = pivotCuesFor(bundle([change("Total Sales", "better")]), categoryByQuarter(), ["[Total Sales]"]);
    expect(set.cues).toHaveLength(1);
  });

  it("drops a measure the pivot does not carry, and a custom caption that hides one", () => {
    const missing = pivotCuesFor(bundle([change("Margin", "better")]), categoryByQuarter(), ["[Total Sales]"]);
    expect(missing.dropped).toEqual([{ factId: "change:m/Margin", reason: "measure-not-in-pivot" }]);
    const renamed = pivotCuesFor(bundle([contribution("Cost", "Product[Category]", [["Gadgets", 4]])]), categoryTwoMeasures(["[Total Sales]", "Spend"]), ["[Total Sales]", "Spend"]);
    expect(renamed.cues).toEqual([]);
    expect(renamed.dropped).toEqual([{ factId: "contribution:m/Cost/Product[Category]", reason: "measure-not-in-pivot" }]);
  });
});

// ============================================================================
// Refusals
// ============================================================================

describe("refusals", () => {
  it("names the first thing the pivot lacks: dimension, then member", () => {
    const v = categoryByQuarter();
    expect(pivotCuesFor(bundle([contribution("Total Sales", "Geo[Region]", [["North", 1]])]), v, ["[Total Sales]"]).dropped).toEqual([{ factId: "contribution:m/Total Sales/Geo[Region]", reason: "dimension-not-in-pivot" }]);
    expect(pivotCuesFor(bundle([contribution("Total Sales", "Product[Category]", [["Gizmos", 1]])]), v, ["[Total Sales]"]).dropped).toEqual([{ factId: "contribution:m/Total Sales/Product[Category]", reason: "member-not-in-pivot" }]);
  });

  it("drops a malformed fact and a definitional driver, and ignores kinds that point at nothing", () => {
    const facts: Fact[] = [
      { id: "bad", kind: { fact: "change", measure: "Total Sales" } },
      { id: "driver", kind: { fact: "definitionalDriver", measure: "Margin", kind: "ratio", totalDelta: 1, parts: [], residual: 0 } },
      { id: "summary", kind: { fact: "summary", measure: "Total Sales" } },
    ];
    const set = pivotCuesFor(bundle(facts), categoryByQuarter(), ["[Total Sales]"]);
    expect(set.cues).toEqual([]);
    expect(set.dropped).toEqual([{ factId: "bad", reason: "malformed-fact" }, { factId: "driver", reason: "no-position-in-fact" }]);
  });

  it("is deterministic and keeps a fact's cues adjacent in rank order", () => {
    const facts = [contribution("Total Sales", "Product[Category]", [["Gadgets", 1], ["Widgets", 1]]), change("Total Sales", "better")];
    const a = pivotCuesFor(bundle(facts), categoryByQuarter(), ["[Total Sales]"]);
    const b = pivotCuesFor(bundle(facts), categoryByQuarter(), ["[Total Sales]"]);
    expect(a).toEqual(b);
    expect(a.cues.map((c) => c.factId)).toEqual(["contribution:m/Total Sales/Product[Category]", "contribution:m/Total Sales/Product[Category]", "change:m/Total Sales"]);
  });
});
