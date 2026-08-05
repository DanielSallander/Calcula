//! FILENAME: app/src/api/scriptHost/__tests__/validators.test.ts
// PURPOSE: Broker-side argument validators (run BEFORE the tier check, no state
//          reads): B8 slice A's vSetState chart-spec shape+size pre-filter,
//          B1's vRangeRef / vRangeWrite bulk-range gates (rectangle sanity plus
//          the 100k-cell ceiling shared with api.updateCellsBatch), B2's
//          formatting / structural / sheet-CRUD / sort / find-replace gates, and
//          B3's object enumeration / creation / cross-instance / pivot-layout
//          gates.
// CONTEXT: The format-object gate is the load-bearing one: it must REJECT an
//          unknown key (a silently-ignored typo is a support ticket) and must
//          never accept the protection attributes the backend's FormattingParams
//          also carries. B3's cross-instance gate is the other one: naming
//          another instance must not become the LAX way into an aspect.

import { describe, it, expect } from "vitest";
import {
  vSetState, vRangeRef, vRangeWrite, MAX_RANGE_CELLS,
  checkFormatObject, SCRIPT_FORMAT_KEYS, vRangeFormat,
  vRowColOp, MAX_STRUCTURAL_COUNT, vDimension, vFreeze,
  vSheetName, vSheetRename, vSheetVisibility,
  vSortRange, vFind, vReplace,
  vRemoveDuplicates, vTextToColumns, vSpecialCells, vGoalSeek,
  vObjectKind, vObjectId, vObjectAspect,
  vCreateChart, vCreateTable, vCreateNamedRange, vNamedRangeName, vCreatePivot,
  checkPivotLayoutAspect, PIVOT_LAYOUT_ASPECTS,
  vDialogMessage, vDialogPrompt, vDialogForm,
} from "../validators";

describe("vSetState chart spec pre-filter", () => {
  it("passes a well-formed chart.updateSpec patch", () => {
    expect(vSetState(["chart.updateSpec", [{ title: "X" }]])).toBe(true);
  });

  it("passes a well-formed chart.replaceSpec full spec", () => {
    expect(vSetState(["chart.replaceSpec", [{ mark: "bar", series: [] }]])).toBe(true);
  });

  it("rejects a non-object spec", () => {
    expect(vSetState(["chart.updateSpec", ["nope"]])).not.toBe(true);
    expect(vSetState(["chart.updateSpec", [42]])).not.toBe(true);
    expect(vSetState(["chart.replaceSpec", [null]])).not.toBe(true);
    expect(vSetState(["chart.updateSpec", [["an", "array"]]])).not.toBe(true);
  });

  it("rejects a missing spec argument", () => {
    expect(vSetState(["chart.updateSpec", []])).not.toBe(true);
    expect(vSetState(["chart.replaceSpec", "notArray"])).not.toBe(true);
  });

  it("rejects an oversized spec (> 2 MB)", () => {
    const huge = { title: "x".repeat(2_100_000) };
    expect(vSetState(["chart.updateSpec", [huge]])).not.toBe(true);
  });

  it("does NOT constrain other setState aspects (slicer/shape/etc.)", () => {
    expect(vSetState(["slicer.setSelectedItems", [["a", "b"]]])).toBe(true);
    expect(vSetState(["shape.setProperty", ["fill", "#fff"]])).toBe(true);
    expect(vSetState(["chart.setStyleProperty", ["bg", "#fff"]])).toBe(true);
  });
});

// ============================================================================
// B1 — bulk range I/O validators
// ============================================================================

describe("vRangeRef (bulk range read args)", () => {
  it("accepts a well-formed rectangle, with or without a sheet index", () => {
    expect(vRangeRef([0, 0, 9, 4])).toBe(true);
    expect(vRangeRef([0, 0, 9, 4, 3])).toBe(true);
    expect(vRangeRef([5, 5, 5, 5])).toBe(true); // single cell
  });

  it("rejects non-integer / negative coordinates", () => {
    expect(vRangeRef([-1, 0, 1, 1])).not.toBe(true);
    expect(vRangeRef([0, 1.5, 1, 1])).not.toBe(true);
    expect(vRangeRef(["0", 0, 1, 1])).not.toBe(true);
    expect(vRangeRef([0, 0, 1])).not.toBe(true);
  });

  it("rejects an inverted rectangle", () => {
    expect(vRangeRef([5, 0, 1, 1])).not.toBe(true);
    expect(vRangeRef([0, 5, 1, 1])).not.toBe(true);
  });

  it("rejects a rectangle over the cell ceiling, accepts one exactly at it", () => {
    expect(vRangeRef([0, 0, MAX_RANGE_CELLS - 1, 0])).toBe(true);
    expect(vRangeRef([0, 0, MAX_RANGE_CELLS, 0])).not.toBe(true);
    expect(vRangeRef([0, 0, 999, 999])).not.toBe(true); // 1,000,000 cells
  });

  it("rejects a bad sheet ref, accepts an index or a name (Wave 1)", () => {
    expect(vRangeRef([0, 0, 1, 1, -2])).not.toBe(true);
    expect(vRangeRef([0, 0, 1, 1, 1.5])).not.toBe(true);
    expect(vRangeRef([0, 0, 1, 1, ""])).not.toBe(true);
    expect(vRangeRef([0, 0, 1, 1, "Bad[Name]"])).not.toBe(true);
    expect(vRangeRef([0, 0, 1, 1, true])).not.toBe(true);
    // A sheet NAME is now a valid ref — resolution happens host-side.
    expect(vRangeRef([0, 0, 1, 1, "Sheet1"])).toBe(true);
  });
});

describe("vRangeWrite (bulk range write args)", () => {
  it("accepts a 2D array of typed values, with holes", () => {
    expect(vRangeWrite([0, 0, [["a", "b"], ["c"]]])).toBe(true);
    // undefined = hole (leave the cell), null = CLEAR the cell (Wave 1)
    expect(vRangeWrite([0, 0, [["a", undefined, null]]])).toBe(true);
    // Typed values: numbers and booleans land typed, not as text
    expect(vRangeWrite([0, 0, [[42, -1.5, true, false]]])).toBe(true);
    expect(vRangeWrite([2, 3, [], 1])).toBe(true);
    // A sheet NAME in the sheet slot is valid (resolved host-side)
    expect(vRangeWrite([2, 3, [], "Data"])).toBe(true);
  });

  it("rejects a non-2D values argument", () => {
    expect(vRangeWrite([0, 0, "nope"])).not.toBe(true);
    expect(vRangeWrite([0, 0, ["a", "b"]])).not.toBe(true);
  });

  it("rejects non-writable cell values", () => {
    expect(vRangeWrite([0, 0, [[{ v: 1 }]]])).not.toBe(true);
    expect(vRangeWrite([0, 0, [[[1, 2]]]])).not.toBe(true);
    expect(vRangeWrite([0, 0, [[NaN]]])).not.toBe(true);
    expect(vRangeWrite([0, 0, [[Infinity]]])).not.toBe(true);
  });

  it("rejects bad anchor coordinates and sheet refs", () => {
    expect(vRangeWrite([-1, 0, [["a"]]])).not.toBe(true);
    expect(vRangeWrite([0, 0.5, [["a"]]])).not.toBe(true);
    expect(vRangeWrite([0, 0, [["a"]], -1])).not.toBe(true);
    expect(vRangeWrite([0, 0, [["a"]], "has:colon"])).not.toBe(true);
    expect(vRangeWrite([0, 0, [["a"]], false])).not.toBe(true);
  });

  it("rejects more than the cell ceiling in total", () => {
    const wideRow = new Array(MAX_RANGE_CELLS + 1).fill("x");
    expect(vRangeWrite([0, 0, [wideRow]])).not.toBe(true);
  });
});

// ============================================================================
// B2 — formatting + structural operations
// ============================================================================

describe("checkFormatObject / vRangeFormat (the format-object gate)", () => {
  it("accepts a partial format touching every supported family", () => {
    expect(checkFormatObject({ bold: true, italic: false, strikethrough: true })).toBe(true);
    expect(checkFormatObject({ underline: "singleAccounting" })).toBe(true);
    expect(checkFormatObject({ fontSize: 11, fontFamily: "Calibri" })).toBe(true);
    expect(checkFormatObject({ textColor: "#123456", backgroundColor: "#abcdefff" })).toBe(true);
    expect(checkFormatObject({ textColor: "112233" })).toBe(true); // leading '#' optional
    expect(checkFormatObject({ textAlign: "center", verticalAlign: "bottom" })).toBe(true);
    expect(checkFormatObject({ numberFormat: "#,##0.00" })).toBe(true);
    expect(checkFormatObject({ wrapText: true, shrinkToFit: false, indent: 3 })).toBe(true);
    expect(checkFormatObject({ textRotation: "rotate270" })).toBe(true);
    expect(checkFormatObject({ borderBottom: { style: "thick", color: "#000000" } })).toBe(true);
  });

  it("REJECTS an unknown property instead of ignoring it, and names the allowed set", () => {
    const reason = checkFormatObject({ bgColor: "#ffffff" });
    expect(reason).not.toBe(true);
    expect(String(reason)).toContain("bgColor");
    expect(String(reason)).toContain("backgroundColor");
  });

  it("rejects the protection + cell-control attributes the backend also accepts", () => {
    for (const key of ["locked", "formulaHidden", "checkbox", "button"]) {
      expect(checkFormatObject({ [key]: true }), key).not.toBe(true);
      expect(SCRIPT_FORMAT_KEYS.has(key), key).toBe(false);
    }
    // `fill` joined the vocabulary in Wave 4 — but only with a VALID fill
    // object; `fill: true` still fails with the shape spelled out.
    expect(SCRIPT_FORMAT_KEYS.has("fill")).toBe(true);
    expect(checkFormatObject({ fill: true })).not.toBe(true);
    expect(checkFormatObject({ fill: { type: "solid", color: "#ff0000" } })).toBe(true);
  });

  it("rejects an empty / non-object format", () => {
    expect(checkFormatObject({})).not.toBe(true);
    expect(checkFormatObject(null)).not.toBe(true);
    expect(checkFormatObject([])).not.toBe(true);
    expect(checkFormatObject("bold")).not.toBe(true);
  });

  it("type-checks every value, not just the key", () => {
    expect(checkFormatObject({ bold: "yes" })).not.toBe(true);
    expect(checkFormatObject({ underline: "wavy" })).not.toBe(true);
    expect(checkFormatObject({ textAlign: "justify" })).not.toBe(true);
    expect(checkFormatObject({ verticalAlign: "centre" })).not.toBe(true);
    expect(checkFormatObject({ textRotation: 90 })).not.toBe(true);
    expect(checkFormatObject({ fontSize: 0 })).not.toBe(true);
    expect(checkFormatObject({ fontSize: 410 })).not.toBe(true);
    expect(checkFormatObject({ fontSize: "11" })).not.toBe(true);
    expect(checkFormatObject({ indent: 1.5 })).not.toBe(true);
    expect(checkFormatObject({ indent: -1 })).not.toBe(true);
    expect(checkFormatObject({ fontFamily: "" })).not.toBe(true);
    expect(checkFormatObject({ numberFormat: 0 })).not.toBe(true);
    expect(checkFormatObject({ textColor: "red" })).not.toBe(true);
    expect(checkFormatObject({ textColor: "#12345" })).not.toBe(true);
    expect(checkFormatObject({ backgroundColor: 16777215 })).not.toBe(true);
  });

  it("validates each border side's style, colour and key set", () => {
    // "solid" is NOT a border style the backend understands (thin/medium/thick).
    expect(checkFormatObject({ borderTop: { style: "solid", color: "#000000" } })).not.toBe(true);
    expect(checkFormatObject({ borderTop: { style: "thin", color: "black" } })).not.toBe(true);
    expect(checkFormatObject({ borderTop: { style: "thin" } })).not.toBe(true);
    expect(checkFormatObject({ borderTop: { style: "thin", color: "#000000", width: 2 } })).not.toBe(true);
    expect(checkFormatObject({ borderTop: "thin" })).not.toBe(true);
    for (const side of [
      "borderTop", "borderRight", "borderBottom", "borderLeft",
      "borderDiagonalDown", "borderDiagonalUp",
    ]) {
      expect(checkFormatObject({ [side]: { style: "dotted", color: "#ff0000" } }), side).toBe(true);
    }
  });

  it("vRangeFormat gates the rectangle AND the format object", () => {
    expect(vRangeFormat([0, 0, 9, 4, { bold: true }])).toBe(true);
    expect(vRangeFormat([0, 0, 9, 4, { bold: true }, 2])).toBe(true);
    expect(vRangeFormat([9, 0, 0, 4, { bold: true }])).not.toBe(true); // inverted
    expect(vRangeFormat([0, 0, MAX_RANGE_CELLS, 0, { bold: true }])).not.toBe(true); // too big
    expect(vRangeFormat([0, 0, 1, 1, { nope: true }])).not.toBe(true);
    expect(vRangeFormat([0, 0, 1, 1])).not.toBe(true); // missing format
  });

  it("the own-object table.setRangeFormat aspect gets the SAME gate", () => {
    expect(vSetState(["table.setRangeFormat", [0, 0, 1, 1, { bold: true }]])).toBe(true);
    expect(vSetState(["table.setRangeFormat", [0, 0, 1, 1, { locked: false }]])).not.toBe(true);
    expect(vSetState(["table.setRangeFormat", [0, 0, 1, 1]])).not.toBe(true);
  });
});

describe("vRowColOp (insert/delete rows + columns)", () => {
  it("accepts a start + count, with or without a sheet index", () => {
    expect(vRowColOp([0, 1])).toBe(true);
    expect(vRowColOp([10, 5, 2])).toBe(true);
    expect(vRowColOp([10, MAX_STRUCTURAL_COUNT])).toBe(true);
  });

  it("rejects a count below 1, non-integer, or over the ceiling", () => {
    expect(vRowColOp([0, 0])).not.toBe(true);
    expect(vRowColOp([0, -3])).not.toBe(true);
    expect(vRowColOp([0, 1.5])).not.toBe(true);
    expect(vRowColOp([0, "2"])).not.toBe(true);
    expect(vRowColOp([0, MAX_STRUCTURAL_COUNT + 1])).not.toBe(true);
  });

  it("rejects a bad start or sheet ref, accepts a sheet name", () => {
    expect(vRowColOp([-1, 1])).not.toBe(true);
    expect(vRowColOp([0.5, 1])).not.toBe(true);
    expect(vRowColOp([0, 1, -1])).not.toBe(true);
    expect(vRowColOp([0, 1, "Bad/Name"])).not.toBe(true);
    // A sheet NAME is a valid ref (resolved host-side; refused there if the
    // named sheet is not the active one).
    expect(vRowColOp([0, 1, "Sheet1"])).toBe(true);
  });
});

describe("vDimension (row height / column width)", () => {
  it("accepts a size in range, including 0 (restore the default)", () => {
    expect(vDimension([0, 20])).toBe(true);
    expect(vDimension([3, 0])).toBe(true);
    expect(vDimension([3, 18.5, 1])).toBe(true);
  });

  it("rejects a negative / oversized / non-numeric size", () => {
    expect(vDimension([0, -1])).not.toBe(true);
    expect(vDimension([0, 4097])).not.toBe(true);
    expect(vDimension([0, "20"])).not.toBe(true);
    expect(vDimension([0, Number.NaN])).not.toBe(true);
  });

  it("rejects a bad index", () => {
    expect(vDimension([-1, 20])).not.toBe(true);
    expect(vDimension([1.5, 20])).not.toBe(true);
  });
});

describe("vFreeze (freeze panes)", () => {
  it("accepts counts and nulls on either axis", () => {
    expect(vFreeze([1, 1])).toBe(true);
    expect(vFreeze([null, null])).toBe(true);
    expect(vFreeze([2, null])).toBe(true);
    expect(vFreeze([undefined, 3])).toBe(true);
  });

  it("rejects negative or non-integer bounds", () => {
    expect(vFreeze([-1, null])).not.toBe(true);
    expect(vFreeze([1.5, null])).not.toBe(true);
    expect(vFreeze([null, "1"])).not.toBe(true);
  });
});

describe("sheet CRUD validators", () => {
  it("vSheetName accepts an omitted or legal name", () => {
    expect(vSheetName([])).toBe(true);
    expect(vSheetName([undefined])).toBe(true);
    expect(vSheetName([null])).toBe(true);
    expect(vSheetName(["Report 2026"])).toBe(true);
  });

  it("vSheetName rejects blank names and the illegal characters", () => {
    expect(vSheetName([""])).not.toBe(true);
    expect(vSheetName(["   "])).not.toBe(true);
    expect(vSheetName([42])).not.toBe(true);
    for (const bad of ["a:b", "a\\b", "a/b", "a?b", "a*b", "a[b", "a]b"]) {
      expect(vSheetName([bad]), bad).not.toBe(true);
    }
    expect(vSheetName(["x".repeat(256)])).not.toBe(true);
  });

  it("vSheetRename gates the index and the name", () => {
    expect(vSheetRename([0, "Data"])).toBe(true);
    expect(vSheetRename([-1, "Data"])).not.toBe(true);
    expect(vSheetRename([0, "Da/ta"])).not.toBe(true);
    expect(vSheetRename([0, ""])).not.toBe(true);
  });

  it("vSheetVisibility accepts only the three states", () => {
    expect(vSheetVisibility([0, "visible"])).toBe(true);
    expect(vSheetVisibility([0, "hidden"])).toBe(true);
    expect(vSheetVisibility([0, "veryHidden"])).toBe(true);
    expect(vSheetVisibility([0, "gone"])).not.toBe(true);
    expect(vSheetVisibility([0, true])).not.toBe(true);
    expect(vSheetVisibility([-1, "hidden"])).not.toBe(true);
  });
});

describe("vSortRange", () => {
  it("accepts a rectangle with one or more well-formed fields", () => {
    expect(vSortRange([0, 0, 9, 3, [{ key: 0 }]])).toBe(true);
    expect(
      vSortRange([0, 0, 9, 3, [{ key: 2, ascending: false, sortOn: "cellColor", color: "#ff0000" }]]),
    ).toBe(true);
    expect(
      vSortRange([
        0, 0, 9, 3,
        [{ key: 0, dataOption: "textAsNumber", customOrder: "months" }],
        { hasHeaders: true, orientation: "rows", matchCase: false },
      ]),
    ).toBe(true);
  });

  it("rejects a bad rectangle, exactly like vRangeRef", () => {
    expect(vSortRange([9, 0, 0, 3, [{ key: 0 }]])).not.toBe(true);
    expect(vSortRange([0, 0, MAX_RANGE_CELLS, 0, [{ key: 0 }]])).not.toBe(true);
  });

  it("rejects an empty / malformed field list", () => {
    expect(vSortRange([0, 0, 9, 3, []])).not.toBe(true);
    expect(vSortRange([0, 0, 9, 3, "col"])).not.toBe(true);
    expect(vSortRange([0, 0, 9, 3, [{}]])).not.toBe(true);
    expect(vSortRange([0, 0, 9, 3, [{ key: -1 }]])).not.toBe(true);
    expect(vSortRange([0, 0, 9, 3, [{ key: 0, ascending: "yes" }]])).not.toBe(true);
    expect(vSortRange([0, 0, 9, 3, [{ key: 0, sortOn: "size" }]])).not.toBe(true);
    expect(vSortRange([0, 0, 9, 3, [{ key: 0, color: "red" }]])).not.toBe(true);
    expect(vSortRange([0, 0, 9, 3, [{ key: 0, direction: "desc" }]])).not.toBe(true);
  });

  it("rejects unknown or mistyped sort options", () => {
    expect(vSortRange([0, 0, 9, 3, [{ key: 0 }], { headers: true }])).not.toBe(true);
    expect(vSortRange([0, 0, 9, 3, [{ key: 0 }], { hasHeaders: "yes" }])).not.toBe(true);
    expect(vSortRange([0, 0, 9, 3, [{ key: 0 }], { orientation: "diagonal" }])).not.toBe(true);
  });
});

describe("vFind / vReplace", () => {
  it("accept a non-empty query with the documented options", () => {
    expect(vFind(["TODO"])).toBe(true);
    expect(vFind(["TODO", { caseSensitive: true, matchEntireCell: false, searchFormulas: true }])).toBe(true);
    expect(vReplace(["a", "b"])).toBe(true);
    expect(vReplace(["a", "", { caseSensitive: true, matchEntireCell: true }])).toBe(true);
  });

  it("reject an empty query and a non-string replacement", () => {
    expect(vFind([""])).not.toBe(true);
    expect(vFind([42])).not.toBe(true);
    expect(vReplace(["", "b"])).not.toBe(true);
    expect(vReplace(["a", 42])).not.toBe(true);
  });

  it("reject unknown search options (searchFormulas is find-only)", () => {
    expect(vFind(["a", { regex: true }])).not.toBe(true);
    expect(vFind(["a", { caseSensitive: "yes" }])).not.toBe(true);
    expect(vReplace(["a", "b", { searchFormulas: true }])).not.toBe(true);
  });

  it("accept the Wave-4 range option as a Box or an A1 string, on both", () => {
    const box = { startRow: 1, startCol: 0, endRow: 9, endCol: 3 };
    expect(vFind(["a", { range: box }])).toBe(true);
    expect(vFind(["a", { range: "B2:D10" }])).toBe(true);
    expect(vReplace(["a", "b", { range: box }])).toBe(true);
    expect(vReplace(["a", "b", { range: "B2:D10", sheetIndex: "Data" }])).toBe(true);
  });

  it("reject a malformed range option", () => {
    expect(vFind(["a", { range: 42 }])).not.toBe(true);
    expect(vFind(["a", { range: "" }])).not.toBe(true);
    expect(vFind(["a", { range: { startRow: 0, startCol: 0, endRow: 5 } }])).not.toBe(true);
    expect(vFind(["a", { range: { startRow: 5, startCol: 0, endRow: 0, endCol: 0 } }])).not.toBe(true);
    expect(vFind(["a", { range: { startRow: 0, startCol: 0, endRow: 1, endCol: 1, extra: 1 } }])).not.toBe(true);
    expect(vReplace(["a", "b", { range: -1 }])).not.toBe(true);
  });
});

describe("vRemoveDuplicates", () => {
  it("accepts a rectangle with and without options", () => {
    expect(vRemoveDuplicates([0, 0, 9, 3])).toBe(true);
    expect(vRemoveDuplicates([0, 0, 9, 3, { columns: [0, 2], hasHeaders: true }])).toBe(true);
    expect(vRemoveDuplicates([0, 0, 9, 3, null, "Data"])).toBe(true);
  });

  it("rejects bad geometry, bad options and out-of-range column offsets", () => {
    expect(vRemoveDuplicates([9, 0, 0, 3])).not.toBe(true); // end before start
    expect(vRemoveDuplicates([0, 0, 9, 3, { columns: [] }])).not.toBe(true);
    expect(vRemoveDuplicates([0, 0, 9, 3, { columns: [4] }])).not.toBe(true); // width is 4 -> max offset 3
    expect(vRemoveDuplicates([0, 0, 9, 3, { columns: [-1] }])).not.toBe(true);
    expect(vRemoveDuplicates([0, 0, 9, 3, { columns: [1.5] }])).not.toBe(true);
    expect(vRemoveDuplicates([0, 0, 9, 3, { hasHeaders: "yes" }])).not.toBe(true);
    expect(vRemoveDuplicates([0, 0, 9, 3, { keyColumns: [0] }])).not.toBe(true); // unknown key
  });
});

describe("vTextToColumns", () => {
  it("accepts a single-column source with the documented options", () => {
    expect(vTextToColumns([0, 2, 9, 2])).toBe(true);
    expect(vTextToColumns([0, 2, 9, 2, {
      delimiters: [";", "\t"], consecutiveAsOne: true,
      destination: { row: 0, col: 5 }, sheetIndex: "Data",
    }])).toBe(true);
  });

  it("rejects a multi-column source", () => {
    expect(vTextToColumns([0, 0, 9, 1])).not.toBe(true);
  });

  it("rejects bad delimiters and destinations", () => {
    expect(vTextToColumns([0, 0, 9, 0, { delimiters: [] }])).not.toBe(true);
    expect(vTextToColumns([0, 0, 9, 0, { delimiters: [";;"] }])).not.toBe(true);
    expect(vTextToColumns([0, 0, 9, 0, { delimiters: [7] }])).not.toBe(true);
    expect(vTextToColumns([0, 0, 9, 0, { destination: { row: -1, col: 0 } }])).not.toBe(true);
    expect(vTextToColumns([0, 0, 9, 0, { destination: { row: 0 } }])).not.toBe(true);
    expect(vTextToColumns([0, 0, 9, 0, { qualifier: "'" }])).not.toBe(true); // unknown key
  });
});

describe("vSpecialCells", () => {
  it("accepts each kind, with an optional sheet ref", () => {
    for (const kind of ["constants", "formulas", "blanks", "visible"]) {
      expect(vSpecialCells([0, 0, 99, 9, kind])).toBe(true);
    }
    expect(vSpecialCells([0, 0, 99, 9, "visible", "Data"])).toBe(true);
  });

  it("rejects an unknown kind, listing the accepted ones", () => {
    const verdict = vSpecialCells([0, 0, 99, 9, "comments"]);
    expect(verdict).not.toBe(true);
    expect(String(verdict)).toMatch(/constants.*formulas.*blanks.*visible/);
    expect(vSpecialCells([0, 0, 99, 9, 42])).not.toBe(true);
  });

  it("rejects bad geometry through the shared rectangle gate", () => {
    expect(vSpecialCells([9, 0, 0, 9, "blanks"])).not.toBe(true);
  });
});

describe("vGoalSeek", () => {
  const good = {
    targetRow: 9, targetCol: 1, targetValue: 250000,
    variableRow: 1, variableCol: 1,
  };

  it("accepts the documented parameter object", () => {
    expect(vGoalSeek([good])).toBe(true);
    expect(vGoalSeek([{ ...good, maxIterations: 500, tolerance: 0.01, sheetIndex: 0 }])).toBe(true);
  });

  it("rejects a non-object, missing coordinates and a non-finite target", () => {
    expect(vGoalSeek([undefined])).not.toBe(true);
    expect(vGoalSeek([[]])).not.toBe(true);
    expect(vGoalSeek([{ ...good, targetRow: undefined }])).not.toBe(true);
    expect(vGoalSeek([{ ...good, targetValue: Infinity }])).not.toBe(true);
    expect(vGoalSeek([{ ...good, targetValue: "big" }])).not.toBe(true);
  });

  it("rejects target == variable, bad iteration/tolerance bounds and unknown keys", () => {
    expect(vGoalSeek([{ ...good, variableRow: 9, variableCol: 1 }])).not.toBe(true);
    expect(vGoalSeek([{ ...good, maxIterations: 0 }])).not.toBe(true);
    expect(vGoalSeek([{ ...good, maxIterations: 100000 }])).not.toBe(true);
    expect(vGoalSeek([{ ...good, tolerance: 0 }])).not.toBe(true);
    expect(vGoalSeek([{ ...good, goal: 5 }])).not.toBe(true);
  });
});

// ============================================================================
// B3 — workbook objects: enumeration, creation, cross-instance, pivot layout
// ============================================================================

describe("vObjectKind / vObjectId", () => {
  it("accepts each enumerable kind", () => {
    for (const kind of ["chart", "table", "pivot", "namedRange", "slicer", "shape"]) {
      expect(vObjectKind([kind])).toBe(true);
    }
  });

  it("rejects an unknown kind and lists the accepted ones", () => {
    const verdict = vObjectKind(["sparkline"]);
    expect(verdict).not.toBe(true);
    expect(String(verdict)).toContain("namedRange");
  });

  it("rejects a non-string / missing kind", () => {
    expect(vObjectKind([42])).not.toBe(true);
    expect(vObjectKind([])).not.toBe(true);
  });

  it("requires a non-blank id", () => {
    expect(vObjectId(["c1"])).toBe(true);
    expect(vObjectId([""])).not.toBe(true);
    expect(vObjectId(["   "])).not.toBe(true);
    expect(vObjectId([null])).not.toBe(true);
  });
});

describe("vObjectAspect (cross-instance)", () => {
  it("accepts a well-formed target + aspect", () => {
    expect(vObjectAspect(["chart", "c1", "chart.updateSpec", [{ title: "X" }]])).toBe(true);
    expect(vObjectAspect(["slicer", "s1", "slicer.setSelectedItems", [["a"]]])).toBe(true);
  });

  it("requires an objectType, a target id, an aspect and an array of args", () => {
    expect(vObjectAspect(["", "c1", "chart.updateSpec", [{}]])).not.toBe(true);
    expect(vObjectAspect(["chart", "", "chart.updateSpec", [{}]])).not.toBe(true);
    expect(vObjectAspect(["chart", "c1", "", []])).not.toBe(true);
    expect(vObjectAspect(["chart", "c1", "chart.updateSpec", "nope"])).not.toBe(true);
  });

  it("applies the SAME aspect gate as object.setState — no lax cross-instance door", () => {
    // A non-object chart spec is rejected identically through both doors.
    expect(vSetState(["chart.updateSpec", ["oops"]])).not.toBe(true);
    expect(vObjectAspect(["chart", "c1", "chart.updateSpec", ["oops"]])).not.toBe(true);
    // ... as is a bad table format object (an unknown key by name).
    expect(vSetState(["table.setRangeFormat", [0, 0, 1, 1, { bgColor: "#ffffff" }]])).not.toBe(true);
    expect(vObjectAspect(["table", "t1", "table.setRangeFormat", [0, 0, 1, 1, { bgColor: "#ffffff" }]])).not.toBe(true);
    // ... as is a bad pivot area.
    expect(vSetState(["pivot.addField", ["Region", "Rows"]])).not.toBe(true);
    expect(vObjectAspect(["pivot", "p1", "pivot.addField", ["Region", "Rows"]])).not.toBe(true);
  });
});

describe("vCreateChart", () => {
  const spec = { mark: "bar", data: "A1:B10", series: [] };

  it("accepts a spec with and without placement options", () => {
    expect(vCreateChart([spec])).toBe(true);
    expect(vCreateChart([spec, { name: "Q4", sheetIndex: 1, x: 10, y: 20, width: 400, height: 300 }])).toBe(true);
  });

  it("rejects a non-object spec and an oversized one", () => {
    expect(vCreateChart(["bar"])).not.toBe(true);
    expect(vCreateChart([[spec]])).not.toBe(true);
    expect(vCreateChart([{ blob: "x".repeat(2_000_001) }])).not.toBe(true);
  });

  it("rejects unknown placement options by name", () => {
    const verdict = vCreateChart([spec, { zIndex: 3 }]);
    expect(verdict).not.toBe(true);
    expect(String(verdict)).toContain("zIndex");
  });

  it("bounds the placement numbers", () => {
    expect(vCreateChart([spec, { width: 0 }])).not.toBe(true);
    expect(vCreateChart([spec, { height: 99_999 }])).not.toBe(true);
    expect(vCreateChart([spec, { x: 1e9 }])).not.toBe(true);
    expect(vCreateChart([spec, { sheetIndex: -1 }])).not.toBe(true);
  });
});

describe("vCreateTable", () => {
  it("accepts a rectangle with and without options", () => {
    expect(vCreateTable([0, 0, 10, 3])).toBe(true);
    expect(vCreateTable([0, 0, 10, 3, { name: "Sales", hasHeaders: false }])).toBe(true);
  });

  it("inherits the rectangle sanity + cell ceiling from vRangeRef", () => {
    expect(vCreateTable([10, 0, 0, 3])).not.toBe(true);
    expect(vCreateTable([0, 0, MAX_RANGE_CELLS, 3])).not.toBe(true);
  });

  it("rejects unknown table options by name", () => {
    const verdict = vCreateTable([0, 0, 1, 1, { style: "TableStyleDark1" }]);
    expect(verdict).not.toBe(true);
    expect(String(verdict)).toContain("style");
  });
});

describe("vCreateNamedRange / vNamedRangeName", () => {
  it("accepts a valid identifier and refersTo", () => {
    expect(vCreateNamedRange(["TaxRate", "=0.25"])).toBe(true);
    expect(vCreateNamedRange(["Sales_2026", "=Sheet1!$A$1:$B$10", { sheetIndex: 2 }])).toBe(true);
    expect(vCreateNamedRange(["Sales", "=A1", { sheetIndex: null, comment: "yearly" }])).toBe(true);
  });

  it("rejects a name with spaces or punctuation (a defined name is an identifier)", () => {
    expect(vCreateNamedRange(["Tax Rate", "=0.25"])).not.toBe(true);
    expect(vCreateNamedRange(["Tax-Rate", "=0.25"])).not.toBe(true);
    expect(vCreateNamedRange(["Tax(Rate)", "=0.25"])).not.toBe(true);
  });

  it("rejects a name starting with a digit and an empty refersTo", () => {
    expect(vCreateNamedRange(["2026Sales", "=A1"])).not.toBe(true);
    expect(vCreateNamedRange(["Sales", ""])).not.toBe(true);
  });

  it("rejects unknown named-range options by name", () => {
    const verdict = vCreateNamedRange(["Sales", "=A1", { folder: "Reports" }]);
    expect(verdict).not.toBe(true);
    expect(String(verdict)).toContain("folder");
  });

  it("vNamedRangeName requires a non-empty name", () => {
    expect(vNamedRangeName(["Sales"])).toBe(true);
    expect(vNamedRangeName([""])).not.toBe(true);
  });
});

describe("vCreatePivot", () => {
  const values = [{ field: "Revenue", aggregation: "sum" }];

  it("accepts the documented shape", () => {
    expect(vCreatePivot(["A1:D100", "F1", { rows: ["Region"], values }])).toBe(true);
    expect(vCreatePivot(["A1:D100", "F1", { values: ["Revenue"] }])).toBe(true);
    expect(
      vCreatePivot([
        "A1:D100", "F1",
        { rows: ["Region"], columns: ["Q"], filters: ["Year"], values },
        { name: "P", sourceSheet: 0, destinationSheet: 1, hasHeaders: true },
      ]),
    ).toBe(true);
  });

  it("REQUIRES at least one value field (a pivot with none aggregates nothing)", () => {
    const verdict = vCreatePivot(["A1:D100", "F1", { rows: ["Region"], values: [] }]);
    expect(verdict).not.toBe(true);
    expect(String(verdict)).toContain("at least one value field");
    expect(vCreatePivot(["A1:D100", "F1", { rows: ["Region"] }])).not.toBe(true);
  });

  it("rejects an unknown AREA by name (the DSL's four are the whole vocabulary)", () => {
    const verdict = vCreatePivot(["A1:D100", "F1", { pages: ["Year"], values }]);
    expect(verdict).not.toBe(true);
    expect(String(verdict)).toContain("pages");
  });

  it("rejects an unknown aggregation and an unknown value-field property", () => {
    expect(vCreatePivot(["A1:D100", "F1", { values: [{ field: "R", aggregation: "avg" }] }])).not.toBe(true);
    expect(vCreatePivot(["A1:D100", "F1", { values: [{ field: "R", showAs: "percent" }] }])).not.toBe(true);
    expect(vCreatePivot(["A1:D100", "F1", { values: [{ field: "" }] }])).not.toBe(true);
  });

  it("rejects empty ranges and unknown options", () => {
    expect(vCreatePivot(["", "F1", { values }])).not.toBe(true);
    expect(vCreatePivot(["A1:D100", "", { values }])).not.toBe(true);
    expect(vCreatePivot(["A1:D100", "F1", { values }, { layout: "tabular" }])).not.toBe(true);
  });
});

describe("pivot layout aspects", () => {
  it("is the exact set routed through the layout gate", () => {
    expect([...PIVOT_LAYOUT_ASPECTS].sort()).toEqual([
      "pivot.addField",
      "pivot.moveField",
      "pivot.removeField",
      "pivot.setAggregation",
      "pivot.setLayout",
    ]);
  });

  it("accepts addField / moveField in every area", () => {
    for (const area of ["rows", "columns", "values", "filters"]) {
      expect(checkPivotLayoutAspect("pivot.addField", ["Region", area])).toBe(true);
      expect(checkPivotLayoutAspect("pivot.moveField", ["Region", area])).toBe(true);
    }
    expect(checkPivotLayoutAspect("pivot.addField", ["Revenue", "values", 0, "average"])).toBe(true);
  });

  it("rejects a blank field name, a bad area, a bad position and a bad aggregation", () => {
    expect(checkPivotLayoutAspect("pivot.addField", ["  ", "rows"])).not.toBe(true);
    expect(checkPivotLayoutAspect("pivot.addField", ["Region", "row"])).not.toBe(true);
    expect(checkPivotLayoutAspect("pivot.addField", ["Region", "rows", -1])).not.toBe(true);
    expect(checkPivotLayoutAspect("pivot.addField", ["Region", "rows", 1.5])).not.toBe(true);
    expect(checkPivotLayoutAspect("pivot.addField", ["Region", "rows", 0, "avg"])).not.toBe(true);
  });

  it("lets removeField omit the area (search all four) but not the field", () => {
    expect(checkPivotLayoutAspect("pivot.removeField", ["Region"])).toBe(true);
    expect(checkPivotLayoutAspect("pivot.removeField", ["Region", "rows"])).toBe(true);
    expect(checkPivotLayoutAspect("pivot.removeField", ["Region", "pages"])).not.toBe(true);
    expect(checkPivotLayoutAspect("pivot.removeField", [""])).not.toBe(true);
  });

  it("requires a known aggregation on setAggregation", () => {
    expect(checkPivotLayoutAspect("pivot.setAggregation", ["Revenue", "sum"])).toBe(true);
    expect(checkPivotLayoutAspect("pivot.setAggregation", ["Revenue"])).not.toBe(true);
    // "automatic" is a backend AggregationFunction but NOT a DSL word.
    expect(checkPivotLayoutAspect("pivot.setAggregation", ["Revenue", "automatic"])).not.toBe(true);
  });

  it("rejects an unknown layout directive BY NAME (a silent no-op is the bug)", () => {
    expect(checkPivotLayoutAspect("pivot.setLayout", [["tabular", "values-on-rows"]])).toBe(true);
    const verdict = checkPivotLayoutAspect("pivot.setLayout", [["make-it-pretty"]]);
    expect(verdict).not.toBe(true);
    expect(String(verdict)).toContain("make-it-pretty");
  });

  it("rejects an empty / non-array / oversized directive list", () => {
    expect(checkPivotLayoutAspect("pivot.setLayout", [[]])).not.toBe(true);
    expect(checkPivotLayoutAspect("pivot.setLayout", ["tabular"])).not.toBe(true);
    expect(checkPivotLayoutAspect("pivot.setLayout", [new Array(33).fill("tabular")])).not.toBe(true);
  });

  it("routes through vSetState, so the own-object door gets the same gate", () => {
    expect(vSetState(["pivot.addField", ["Region", "rows"]])).toBe(true);
    expect(vSetState(["pivot.setLayout", [["nope"]]])).not.toBe(true);
  });
});

// ============================================================================
// ui.dialog (B4) — the declarative modal spec
// ============================================================================
//
// The load-bearing rules here are (a) a field NAME becomes a key on the object
// the script receives, so it must be an identifier and never a prototype hook,
// and (b) unknown members are REJECTED rather than dropped: a typo'd
// `requred: true` that silently became "optional" is a data-loss bug wearing a
// dialog costume.

describe("vDialogMessage / vDialogPrompt", () => {
  it("accepts a bare message and full chrome options", () => {
    expect(vDialogMessage(["Delete 40 rows?"])).toBe(true);
    expect(
      vDialogMessage(["Delete 40 rows?", { title: "Delete", okLabel: "Delete", cancelLabel: "Keep", danger: true }]),
    ).toBe(true);
  });

  it("rejects an empty / whitespace-only / oversized message", () => {
    expect(vDialogMessage([""])).not.toBe(true);
    expect(vDialogMessage(["   \n  "])).not.toBe(true);
    expect(vDialogMessage([42])).not.toBe(true);
    expect(vDialogMessage(["x".repeat(4001)])).not.toBe(true);
  });

  it("rejects an unknown option BY NAME instead of ignoring it", () => {
    const verdict = vDialogMessage(["Q?", { tittle: "typo" }]);
    expect(verdict).not.toBe(true);
    expect(String(verdict)).toContain("tittle");
  });

  it("bounds the chrome strings a modal can carry", () => {
    expect(vDialogMessage(["Q?", { title: "t".repeat(121) }])).not.toBe(true);
    expect(vDialogMessage(["Q?", { okLabel: "o".repeat(41) }])).not.toBe(true);
    expect(vDialogMessage(["Q?", { okLabel: "" }])).not.toBe(true);
    expect(vDialogMessage(["Q?", { danger: "yes" }])).not.toBe(true);
  });

  it("prompt adds its own members and keeps rejecting confirm-only ones", () => {
    expect(vDialogPrompt(["Name?", { defaultValue: "Ada", placeholder: "e.g. Ada", multiline: true, maxLength: 80 }])).toBe(true);
    expect(vDialogPrompt(["Name?", { danger: true }])).not.toBe(true);
    expect(vDialogPrompt(["Name?", { maxLength: 0 }])).not.toBe(true);
    expect(vDialogPrompt(["Name?", { defaultValue: 5 }])).not.toBe(true);
  });
});

describe("vDialogForm", () => {
  const field = (over: Record<string, unknown> = {}) => ({ name: "a", label: "A", type: "text", ...over });

  it("accepts one field of every declared type", () => {
    expect(
      vDialogForm([{
        title: "Monthly close",
        description: "Confirm the parameters",
        submitLabel: "Run",
        cancelLabel: "Not now",
        fields: [
          { name: "note", label: "Note", type: "text", multiline: true, maxLength: 200 },
          { name: "rate", label: "Rate", type: "number", min: 0, max: 10, step: 0.1, default: 1 },
          { name: "period", label: "Period", type: "date", required: true },
          { name: "region", label: "Region", type: "select", options: ["EMEA", { value: "apac", label: "APAC" }] },
          { name: "lock", label: "Lock", type: "checkbox", default: true },
        ],
      }]),
    ).toBe(true);
  });

  it("requires a non-empty, bounded field list", () => {
    expect(vDialogForm([{ fields: [] }])).not.toBe(true);
    expect(vDialogForm([{ fields: "a" }])).not.toBe(true);
    expect(vDialogForm([{ fields: new Array(33).fill(field()) }])).not.toBe(true);
    expect(vDialogForm(["not an object"])).not.toBe(true);
  });

  it("rejects a field name that is not a plain identifier", () => {
    for (const name of ["", "a b", "a.b", "1a", "x".repeat(65)]) {
      expect(vDialogForm([{ fields: [field({ name })] }]), name).not.toBe(true);
    }
  });

  it("rejects prototype-shaped field names — the result object is a plain object", () => {
    for (const name of ["__proto__", "constructor", "prototype", "hasOwnProperty", "toString", "valueOf"]) {
      const verdict = vDialogForm([{ fields: [field({ name })] }]);
      expect(verdict, name).not.toBe(true);
    }
  });

  it("rejects duplicate field names (the second would silently overwrite the first)", () => {
    const verdict = vDialogForm([{ fields: [field({ name: "dup" }), field({ name: "dup", label: "B" })] }]);
    expect(verdict).not.toBe(true);
    expect(String(verdict)).toContain("dup");
  });

  it("rejects an unknown field property BY NAME", () => {
    const verdict = vDialogForm([{ fields: [field({ requred: true })] }]);
    expect(verdict).not.toBe(true);
    expect(String(verdict)).toContain("requred");
  });

  it("rejects an unknown field type and names the accepted ones", () => {
    const verdict = vDialogForm([{ fields: [field({ type: "password" })] }]);
    expect(verdict).not.toBe(true);
    expect(String(verdict)).toContain("checkbox");
  });

  it("requires select fields to carry bounded options, and forbids them elsewhere", () => {
    expect(vDialogForm([{ fields: [field({ type: "select" })] }])).not.toBe(true);
    expect(vDialogForm([{ fields: [field({ type: "select", options: [] })] }])).not.toBe(true);
    expect(
      vDialogForm([{ fields: [field({ type: "select", options: new Array(201).fill("x") })] }]),
    ).not.toBe(true);
    expect(vDialogForm([{ fields: [field({ options: ["a"] })] }])).not.toBe(true);
    expect(vDialogForm([{ fields: [field({ type: "select", options: [{ value: "a", labl: "A" }] })] }])).not.toBe(true);
  });

  it("makes `default` agree with the field's own type", () => {
    expect(vDialogForm([{ fields: [field({ type: "checkbox", default: "yes" })] }])).not.toBe(true);
    expect(vDialogForm([{ fields: [field({ type: "number", default: "5" })] }])).not.toBe(true);
    expect(vDialogForm([{ fields: [field({ type: "text", default: 5 })] }])).not.toBe(true);
    expect(vDialogForm([{ fields: [field({ type: "number", default: Number.NaN })] }])).not.toBe(true);
  });

  it("rejects impossible numeric bounds", () => {
    expect(vDialogForm([{ fields: [field({ type: "number", min: 10, max: 1 })] }])).not.toBe(true);
    expect(vDialogForm([{ fields: [field({ type: "number", step: 0 })] }])).not.toBe(true);
    expect(vDialogForm([{ fields: [field({ type: "number", min: Number.POSITIVE_INFINITY })] }])).not.toBe(true);
  });

  it("has NO regex `pattern` member — a script-supplied regex would run untrusted in the host", () => {
    const verdict = vDialogForm([{ fields: [field({ pattern: "^(a+)+$" })] }]);
    expect(verdict).not.toBe(true);
    expect(String(verdict)).toContain("pattern");
  });
});
