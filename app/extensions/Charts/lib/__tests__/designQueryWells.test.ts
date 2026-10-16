//! FILENAME: app/extensions/Charts/lib/__tests__/designQueryWells.test.ts
// PURPOSE: The design-query chart's field wells (WP-C S9b) are a VIEW over the
//          one stored fact, the DSL: a round trip through the wells gives the
//          same query for every mark; a dotted BI table name is written
//          unquoted (the serializer's own rule); the gauge's Target / Minimum
//          / Maximum are written WITH their series indices; and a query the
//          wells cannot say is never rewritten (read-only, with the reason).

import { describe, it, expect } from "vitest";
import type { BiPivotModelInfo, ZoneField } from "../../../_shared/components/types";
import { sameDesignQuery } from "../../../_shared/dsl/pivotLayout/canonical";
import {
  WELLS_QUERY_HAS_ERRORS,
  WELLS_QUERY_NOT_REPRESENTABLE,
  chartWellKey,
  dropOnWell,
  readWells,
  removeFromWell,
  reorderWell,
  toggleColumn,
  toggleMeasure,
  usedColumnsOf,
  usedMeasuresOf,
  wellsForMark,
  wellsToDsl,
  type WellsModel,
} from "../designQueryWells";
import type { ChartMark, MarkOptions } from "../../types";

const col = (name: string, isNumeric = false) => ({ name, dataType: isNumeric ? "number" : "string", isNumeric });
const MODEL: BiPivotModelInfo = {
  tables: [
    { name: "Geo", columns: [col("Region"), col("City")] },
    { name: "Time", columns: [col("Year"), col("Month")] },
    // Table names may contain dots: written unquoted, split against the model.
    { name: "BI.dim_customer", columns: [col("fullname"), col("segment")] },
  ],
  measures: [
    { name: "Revenue", table: "Sales", sourceColumn: "amount", aggregation: "sum" },
    { name: "Cost", table: "Sales", sourceColumn: "cost", aggregation: "sum" },
    { name: "Target", table: "Sales", sourceColumn: "target", aggregation: "sum" },
    { name: "Floor", table: "Sales", sourceColumn: "floor", aggregation: "min" },
    { name: "Ceiling", table: "Sales", sourceColumn: "ceiling", aggregation: "max" },
  ],
  connectionId: "conn-a",
};

function read(dsl: string, mark: ChartMark, opts?: MarkOptions): WellsModel {
  return readWells(dsl, MODEL, mark, opts);
}

function names(fields: readonly ZoneField[] | undefined): string[] {
  return (fields ?? []).map((f) => f.name);
}

function roundTrip(dsl: string, mark: ChartMark, opts?: MarkOptions): string {
  const model = read(dsl, mark, opts);
  expect(model.reason).toBeNull();
  const out = wellsToDsl(model, model, MODEL);
  if (!out.ok) throw new Error(out.error);
  return out.dslText;
}

describe("wellsForMark: Power BI's wells per visual", () => {
  const ids = (m: ChartMark) => wellsForMark(m).map((w) => `${w.id}=${w.zone}${w.single ? "[1]" : ""}`);

  it("cartesian: Axis=ROWS, Legend=COLUMNS, Values=VALUES, Filters=FILTERS", () => {
    expect(ids("bar")).toEqual(["axis=rows", "legend=columns", "values=values", "filters=filters"]);
    expect(ids("line")).toEqual(ids("bar"));
  });
  it("a non-cartesian visual names its ROWS well Category", () => {
    expect(ids("pie")).toEqual(["category=rows", "legend=columns", "values=values", "filters=filters"]);
  });
  it("card: Fields = VALUES[0]", () => {
    expect(ids("card")).toEqual(["fields=values[1]", "filters=filters"]);
  });
  it("multi-row card: Category = ROWS, Fields = VALUES", () => {
    expect(ids("multiRowCard")).toEqual(["category=rows", "fields=values", "filters=filters"]);
  });
  it("kpi: Indicator = VALUES[0], Trend axis = ROWS, Goal = VALUES[1]", () => {
    expect(ids("kpi")).toEqual(["indicator=values[1]", "trendAxis=rows", "goal=values[1]", "filters=filters"]);
  });
  it("gauge: Value, Target, Minimum, Maximum are single VALUES slots", () => {
    expect(ids("gauge")).toEqual(["value=values[1]", "target=values[1]", "min=values[1]", "max=values[1]", "filters=filters"]);
  });
});

describe("round trip: DSL -> wells -> DSL is the same query, per mark", () => {
  const cases: Array<[ChartMark, string, MarkOptions?]> = [
    ["bar", "ROWS: Geo.Region\nCOLUMNS: Time.Year\nVALUES: [Revenue], [Cost]\nFILTERS: Geo.City NOT IN (\"Oslo\")"],
    ["pie", "ROWS: Geo.Region\nVALUES: [Revenue]"],
    ["card", "VALUES: [Revenue]"],
    ["multiRowCard", "ROWS: Geo.Region\nVALUES: [Revenue], [Cost]"],
    ["kpi", "ROWS: Time.Month\nVALUES: [Revenue], [Target]"],
    ["gauge", "VALUES: [Revenue], [Target], [Floor], [Ceiling]", { targetSeriesIndex: 1, minSeriesIndex: 2, maxSeriesIndex: 3 }],
    ["bar", "ROWS: Geo.Region\nVALUES: [Revenue]\nLAYOUT: tabular"],
  ];
  for (const [mark, dsl, opts] of cases) {
    it(`${mark}: ${dsl.split("\n")[0]}`, () => {
      expect(sameDesignQuery(roundTrip(dsl, mark, opts), dsl)).toBe(true);
    });
  }

  it("a dotted BI table name is written UNQUOTED (serializer.ts quoteIfNeeded)", () => {
    const out = roundTrip("ROWS: BI.dim_customer.fullname\nVALUES: [Revenue]", "bar");
    expect(out).toContain("ROWS:    BI.dim_customer.fullname");
    expect(out).not.toContain('"BI.dim_customer.fullname"');
  });

  it("the wells show what the query says", () => {
    const m = read("ROWS: Geo.Region\nCOLUMNS: Time.Year\nVALUES: [Revenue], [Cost]", "bar");
    expect(names(m.wells.axis)).toEqual(["Geo.Region"]);
    expect(names(m.wells.legend)).toEqual(["Time.Year"]);
    expect(names(m.wells.values)).toEqual(["[Revenue]", "[Cost]"]);
    expect(usedColumnsOf(m, m)).toEqual(new Set(["Geo.Region", "Time.Year"]));
    expect(usedMeasuresOf(m, m)).toEqual(new Set(["Revenue", "Cost"]));
  });
});

describe("nothing is lost: a zone or value no well shows rides along", () => {
  it("a Card whose query also has ROWS keeps them through a wells edit", () => {
    const m = read("ROWS: Geo.Region\nVALUES: [Revenue]", "card");
    expect(m.unshownZones).toEqual(["rows"]);
    const r = toggleMeasure(m.defs, m, "Revenue", false, MODEL);
    if (!r.ok) throw new Error(r.error);
    const dropped = dropOnWell(m.defs, r.state, "fields", { sourceIndex: -1, name: "[Cost]", isNumeric: true }, undefined, MODEL);
    if (!dropped.ok) throw new Error(dropped.error);
    const out = wellsToDsl(m, dropped.state, MODEL);
    expect(out.ok && sameDesignQuery(out.dslText, "ROWS: Geo.Region\nVALUES: [Cost]")).toBe(true);
  });

  it("a KPI's third measure (no well shows it) is kept after the Goal", () => {
    const m = read("ROWS: Time.Month\nVALUES: [Revenue], [Target], [Cost]", "kpi");
    expect(names(m.extraValues)).toEqual(["[Cost]"]);
    const swapped = dropOnWell(m.defs, m, "goal", { sourceIndex: -1, name: "[Floor]", isNumeric: true }, undefined, MODEL);
    if (!swapped.ok) throw new Error(swapped.error);
    const out = wellsToDsl(m, swapped.state, MODEL);
    expect(out.ok && sameDesignQuery(out.dslText, "ROWS: Time.Month\nVALUES: [Revenue], [Floor], [Cost]")).toBe(true);
  });
});

describe("a query the wells cannot say is never rewritten", () => {
  it("SORT / TOP: read-only, with the reason", () => {
    for (const dsl of [
      "ROWS: Geo.Region\nVALUES: [Revenue]\nSORT: Geo.Region DESC",
      "ROWS: Geo.Region\nVALUES: [Revenue]\nTOP 5 BY [Revenue]",
    ]) {
      const m = read(dsl, "bar");
      expect(m.editable).toBe(false);
      expect(m.reason).toBe(WELLS_QUERY_NOT_REPRESENTABLE);
    }
  });

  it("an inclusion filter with no member list to invert: read-only", () => {
    const m = read('ROWS: Geo.Region\nVALUES: [Revenue]\nFILTERS: Geo.City = ("Oslo")', "bar");
    expect(m.editable).toBe(false);
  });

  it("a query with errors: read-only, with the reason", () => {
    const m = read("ROWS: Geo.Nope\nVALUES: [Revenue]", "bar");
    expect(m.editable).toBe(false);
    expect(m.reason).toBe(WELLS_QUERY_HAS_ERRORS);
  });

  it("an empty query is editable (a new chart starts there)", () => {
    expect(read("", "bar").editable).toBe(true);
  });
});

describe("edits", () => {
  it("dropping a measure on Values adds it at the drop position -> DSL", () => {
    const m = read("ROWS: Geo.Region\nVALUES: [Revenue]", "bar");
    const r = dropOnWell(m.defs, m, "values", { sourceIndex: -1, name: "[Cost]", isNumeric: true }, 0, MODEL);
    if (!r.ok) throw new Error(r.error);
    expect(names(r.state.wells.values)).toEqual(["[Cost]", "[Revenue]"]);
    const out = wellsToDsl(m, r.state, MODEL);
    expect(out.ok && out.dslText).toContain("VALUES:  [Cost],\n         [Revenue]");
  });

  it("a measure on a column well (and a column on Values) is refused, never written", () => {
    const m = read("ROWS: Geo.Region\nVALUES: [Revenue]", "bar");
    const a = dropOnWell(m.defs, m, "axis", { sourceIndex: -1, name: "[Cost]", isNumeric: true }, undefined, MODEL);
    const b = dropOnWell(m.defs, m, "values", { sourceIndex: -1, name: "Geo.City", isNumeric: false }, undefined, MODEL);
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
  });

  it("a pill dragged from Axis to Legend MOVES (one axis per column)", () => {
    const m = read("ROWS: Geo.Region\nVALUES: [Revenue]", "bar");
    const r = dropOnWell(
      m.defs, m, "legend",
      { sourceIndex: -1, name: "Geo.Region", isNumeric: false, fromZone: "rows", fromIndex: 0, fromKey: chartWellKey("axis") },
      undefined, MODEL,
    );
    if (!r.ok) throw new Error(r.error);
    expect(names(r.state.wells.axis)).toEqual([]);
    expect(names(r.state.wells.legend)).toEqual(["Geo.Region"]);
  });

  it("checking a column adds it to the first axis well; unchecking removes it everywhere", () => {
    const m = read("VALUES: [Revenue]", "bar");
    const on = toggleColumn(m.defs, m, "Time.Year", false, true);
    if (!on.ok) throw new Error(on.error);
    expect(names(on.state.wells.axis)).toEqual(["Time.Year"]);
    const off = toggleColumn(m.defs, on.state, "Time.Year", false, false);
    expect(off.ok && names(off.state.wells.axis)).toEqual([]);
  });

  it("remove and reorder (insertion index counted before removal)", () => {
    const m = read("ROWS: Geo.Region, Geo.City, Time.Year\nVALUES: [Revenue]", "bar");
    expect(names(reorderWell(m, "axis", 0, 2).wells.axis)).toEqual(["Geo.City", "Geo.Region", "Time.Year"]);
    expect(names(removeFromWell(m, "axis", 1).wells.axis)).toEqual(["Geo.Region", "Time.Year"]);
  });
});

describe("gauge: Target / Minimum / Maximum are written with their series indices", () => {
  it("dropping Target, Minimum, Maximum writes VALUES in order AND the three indices", () => {
    let m = read("VALUES: [Revenue]", "gauge");
    let state = { wells: m.wells, extraValues: m.extraValues };
    for (const [well, measure] of [["max", "[Ceiling]"], ["target", "[Target]"], ["min", "[Floor]"]] as const) {
      const r = dropOnWell(m.defs, state, well, { sourceIndex: -1, name: measure, isNumeric: true }, undefined, MODEL);
      if (!r.ok) throw new Error(r.error);
      state = r.state;
    }
    const out = wellsToDsl(m, state, MODEL);
    if (!out.ok) throw new Error(out.error);
    expect(sameDesignQuery(out.dslText, "VALUES: [Revenue], [Target], [Floor], [Ceiling]")).toBe(true);
    expect(out.markOptions).toEqual({ targetSeriesIndex: 1, minSeriesIndex: 2, maxSeriesIndex: 3 });

    // Read back with those indices: every well shows its own measure.
    m = read(out.dslText, "gauge", out.markOptions as MarkOptions);
    expect(names(m.wells.value)).toEqual(["[Revenue]"]);
    expect(names(m.wells.target)).toEqual(["[Target]"]);
    expect(names(m.wells.min)).toEqual(["[Floor]"]);
    expect(names(m.wells.max)).toEqual(["[Ceiling]"]);
  });

  it("a lone Minimum is NOT read as the target: the target is written as -1", () => {
    const m = read("VALUES: [Revenue]", "gauge");
    const r = dropOnWell(m.defs, m, "min", { sourceIndex: -1, name: "[Floor]", isNumeric: true }, undefined, MODEL);
    if (!r.ok) throw new Error(r.error);
    const out = wellsToDsl(m, r.state, MODEL);
    expect(out.ok && out.markOptions).toEqual({ targetSeriesIndex: -1, minSeriesIndex: 1, maxSeriesIndex: undefined });
  });

  it("the default target (series 1 when there are two) reads as the Target well", () => {
    const m = read("VALUES: [Revenue], [Target]", "gauge");
    expect(names(m.wells.target)).toEqual(["[Target]"]);
    expect(names(m.wells.min)).toEqual([]);
  });

  it("an empty Value under a filled Target is refused (the gauge reads Value first)", () => {
    const m = read("VALUES: [Revenue], [Target]", "gauge");
    const out = wellsToDsl(m, removeFromWell(m, "value", 0), MODEL);
    expect(out.ok).toBe(false);
  });

  it("a non-gauge write carries no indices", () => {
    const m = read("ROWS: Time.Month\nVALUES: [Revenue], [Target]", "kpi");
    const out = wellsToDsl(m, m, MODEL);
    expect(out.ok && out.markOptions).toBeNull();
  });
});
