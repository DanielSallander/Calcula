//! FILENAME: app/extensions/Charts/lib/__tests__/designQueryWellsAliasedMeasure.test.ts
// PURPOSE: BUG-0480 seen from the chart's Fields wells. The wells are editable
//          only when serialize(compile(dsl)) is the same query as the dsl
//          (readWells). While the serializer wrote an aliased measure under
//          its ALIAS, that guard made such a chart read-only; with the
//          serializer fixed an aliased measure round-trips, so the wells
//          become editable -- and an edit must keep the alias on the SAME
//          measure, never re-point it at the measure the alias is spelled like.

import { describe, it, expect } from "vitest";
import type { BiPivotModelInfo } from "../../../_shared/components/types";
import { sameDesignQuery } from "../../../_shared/dsl/pivotLayout/canonical";
import { dropOnWell, readWells, toggleMeasure, usedMeasuresOf, wellsToDsl } from "../designQueryWells";

const col = (name: string, isNumeric = false) => ({ name, dataType: isNumeric ? "number" : "string", isNumeric });
const MODEL: BiPivotModelInfo = {
  tables: [{ name: "Geo", columns: [col("Region"), col("City")] }],
  measures: [
    { name: "Revenue", table: "Sales", sourceColumn: "amount", aggregation: "sum" },
    { name: "Cost", table: "Sales", sourceColumn: "cost", aggregation: "sum" },
    { name: "Sales", table: "Sales", sourceColumn: "units", aggregation: "sum" },
  ],
  connectionId: "conn-a",
};

describe("BUG-0480: an aliased measure in the chart wells", () => {
  it("is editable and a no-op wells write gives back the same query", () => {
    const dsl = 'ROWS: Geo.Region\nVALUES: [Revenue] AS "Sales"';
    const m = readWells(dsl, MODEL, "bar", undefined);
    expect(m.reason).toBeNull();
    expect(m.editable).toBe(true);
    const out = wellsToDsl(m, m, MODEL);
    if (!out.ok) throw new Error(out.error);
    expect(out.dslText).toContain('[Revenue] AS "Sales"');
    expect(sameDesignQuery(out.dslText, dsl)).toBe(true);
  });

  it("the field list ticks the measure itself, not the measure the alias is spelled like", () => {
    const m = readWells('ROWS: Geo.Region\nVALUES: [Revenue] AS "Sales"', MODEL, "bar", undefined);
    expect(usedMeasuresOf(m, m)).toEqual(new Set(["Revenue"]));
  });

  it("an edit beside it keeps the alias on the same measure", () => {
    const m = readWells('ROWS: Geo.Region\nVALUES: [Revenue] AS "Sales"', MODEL, "bar", undefined);
    const added = dropOnWell(m.defs, m, "values", { sourceIndex: -1, name: "[Cost]", isNumeric: true }, undefined, MODEL);
    if (!added.ok) throw new Error(added.error);
    const out = wellsToDsl(m, added.state, MODEL);
    if (!out.ok) throw new Error(out.error);
    expect(sameDesignQuery(out.dslText, 'ROWS: Geo.Region\nVALUES: [Revenue] AS "Sales", [Cost]')).toBe(true);
  });

  it("unticking the aliased measure removes it (and ticking the alias's namesake adds that one)", () => {
    const m = readWells('ROWS: Geo.Region\nVALUES: [Revenue] AS "Sales"', MODEL, "bar", undefined);
    const off = toggleMeasure(m.defs, m, "Revenue", false, MODEL);
    if (!off.ok) throw new Error(off.error);
    const on = toggleMeasure(m.defs, off.state, "Sales", true, MODEL);
    if (!on.ok) throw new Error(on.error);
    const out = wellsToDsl(m, on.state, MODEL);
    if (!out.ok) throw new Error(out.error);
    expect(sameDesignQuery(out.dslText, "ROWS: Geo.Region\nVALUES: [Sales]")).toBe(true);
  });
});
