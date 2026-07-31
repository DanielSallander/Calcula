//! FILENAME: app/src/api/scriptHost/__tests__/objectInventory.test.ts
// PURPOSE: The pure store-row -> safe-descriptor mappers behind api.listObjects
//          (B3 enumeration).
// CONTEXT: The load-bearing properties are (1) the descriptor NEVER leaks an
//          object's contents, (2) a chart with an unparseable spec still
//          enumerates (one bad chart must not blank the whole inventory), and
//          (3) the shape id is byte-identical to the instanceId a shape script
//          mounts with — that identity is what makes api.shape(ref.id) reach
//          the very instance the script host knows.

import { describe, it, expect } from "vitest";
import {
  SCRIPT_OBJECT_KINDS,
  a1Rect,
  chartToRef,
  colLetters,
  controlInstanceId,
  namedRangeToRef,
  pivotToRef,
  shapeToRef,
  slicerToRef,
  tableToRef,
} from "../objectInventory";

describe("A1 helpers", () => {
  it("maps 0-based column indices to Excel letters", () => {
    expect(colLetters(0)).toBe("A");
    expect(colLetters(25)).toBe("Z");
    expect(colLetters(26)).toBe("AA");
    expect(colLetters(701)).toBe("ZZ");
    expect(colLetters(702)).toBe("AAA");
  });

  it("collapses a 1x1 rectangle to a single address", () => {
    expect(a1Rect(0, 0, 0, 0)).toBe("A1");
    expect(a1Rect(4, 2, 4, 2)).toBe("C5");
  });

  it("renders a multi-cell rectangle as first:last", () => {
    expect(a1Rect(0, 0, 9, 3)).toBe("A1:D10");
  });
});

describe("chartToRef", () => {
  const definition = (spec: unknown) =>
    JSON.stringify({ chartId: "c1", name: "Revenue", sheetIndex: 2, spec });

  it("extracts id, name, sheet, mark and a STRING data range", () => {
    const ref = chartToRef({
      chartId: "c1",
      name: "Revenue",
      sheetIndex: 2,
      specJson: definition({ mark: "bar", data: "Sheet1!A1:D13", series: [] }),
    });
    expect(ref).toEqual({
      kind: "chart",
      id: "c1",
      name: "Revenue",
      sheetIndex: 2,
      kindDetail: "bar",
      range: "Sheet1!A1:D13",
    });
  });

  it("never carries the spec body itself", () => {
    const ref = chartToRef({
      chartId: "c1",
      name: "Revenue",
      sheetIndex: 0,
      specJson: definition({ mark: "line", data: "A1:B2", series: [{ secret: "payload" }] }),
    });
    expect(JSON.stringify(ref)).not.toContain("payload");
  });

  it("omits `range` for a STRUCTURED data source rather than faking an address", () => {
    const ref = chartToRef({
      chartId: "c1",
      name: "Q",
      sheetIndex: 0,
      specJson: definition({ mark: "bar", data: { designQuery: "ROWS Region" }, series: [] }),
    });
    expect(ref.range).toBeUndefined();
    expect(ref.kindDetail).toBe("bar");
  });

  it("still enumerates a chart whose stored spec is unparseable", () => {
    const ref = chartToRef({ chartId: "c9", name: "Broken", sheetIndex: 1, specJson: "{not json" });
    expect(ref).toEqual({ kind: "chart", id: "c9", name: "Broken", sheetIndex: 1 });
  });
});

describe("tableToRef", () => {
  const base = {
    id: "t1",
    name: "Sales",
    sheetIndex: 0,
    startRow: 0,
    startCol: 0,
    endRow: 10,
    endCol: 2,
    columns: [{}, {}, {}],
  };

  it("reports the A1 range, the column count and DATA rows (header excluded)", () => {
    expect(tableToRef(base)).toEqual({
      kind: "table",
      id: "t1",
      name: "Sales",
      sheetIndex: 0,
      range: "A1:C11",
      rowCount: 10,
      columnCount: 3,
    });
  });

  it("counts every row when the table has no header row", () => {
    expect(tableToRef({ ...base, styleOptions: { headerRow: false } }).rowCount).toBe(11);
  });
});

describe("pivotToRef / namedRangeToRef / slicerToRef", () => {
  it("keeps a pivot's destination AND source range apart", () => {
    expect(
      pivotToRef({ id: "p1", name: "By region", sourceRange: "A1:D100", destination: "Sheet2!F1" }),
    ).toEqual({
      kind: "pivot",
      id: "p1",
      name: "By region",
      sheetIndex: null,
      range: "Sheet2!F1",
      sourceRange: "A1:D100",
    });
  });

  it("uses the NAME as a named range's id and null sheetIndex for workbook scope", () => {
    expect(namedRangeToRef({ name: "TaxRate", sheetIndex: null, refersTo: "=0.25" })).toEqual({
      kind: "namedRange",
      id: "TaxRate",
      name: "TaxRate",
      sheetIndex: null,
      refersTo: "=0.25",
    });
  });

  it("reports a sheet-scoped name's sheet", () => {
    expect(namedRangeToRef({ name: "Local", sheetIndex: 3, refersTo: "=Sheet4!$A$1" }).sheetIndex).toBe(3);
  });

  it("reports a slicer's field without its selection", () => {
    const ref = slicerToRef({
      id: "s1",
      name: "Region",
      sheetIndex: 1,
      fieldName: "Region",
      sourceType: "pivot",
    });
    expect(ref).toEqual({
      kind: "slicer",
      id: "s1",
      name: "Region",
      sheetIndex: 1,
      fieldName: "Region",
      kindDetail: "pivot",
    });
    expect(Object.keys(ref)).not.toContain("selectedItems");
  });
});

describe("shapeToRef", () => {
  it("derives the SAME id the script host mounts a shape script with", () => {
    const ref = shapeToRef({ sheetIndex: 0, row: 5, col: 10, controlType: "button", name: "Run" });
    expect(ref.id).toBe("control-0-5-10");
    expect(ref.id).toBe(controlInstanceId(0, 5, 10));
    expect(ref.range).toBe("K6");
    expect(ref.kindDetail).toBe("button");
  });

  it("tolerates a control with no name", () => {
    expect(shapeToRef({ sheetIndex: 1, row: 0, col: 0, controlType: "checkbox" }).name).toBe("");
  });
});

describe("SCRIPT_OBJECT_KINDS", () => {
  it("is exactly the six enumerable kinds", () => {
    expect([...SCRIPT_OBJECT_KINDS].sort()).toEqual(
      ["chart", "namedRange", "pivot", "shape", "slicer", "table"],
    );
  });
});
