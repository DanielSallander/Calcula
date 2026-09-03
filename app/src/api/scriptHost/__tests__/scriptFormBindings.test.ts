//! FILENAME: app/src/api/scriptHost/__tests__/scriptFormBindings.test.ts
// PURPOSE: The pure half of form data binding — parsing, seeding, the write
//          value, and dirtiness — including the currency trap that makes the
//          built-in DataForm turn numbers into text.

import { describe, it, expect } from "vitest";
import {
  cellWriteFor,
  collectFormBindings,
  collectFormSources,
  dirtyNames,
  isDirty,
  optionsFromCells,
  parseFormBinding,
  parseFormRange,
  rowsFromCells,
  seedFromCell,
  seedFromControlValue,
  serialToIsoDate,
  sheetIdentityRefusal,
} from "../scriptFormBindings";
import { MAX_FORM_OPTIONS, MAX_FORM_TABLE_CELLS, type FormSpec } from "../scriptFormSpec";

describe("collectFormSources / parseFormRange", () => {
  it("finds range-fed choice lists, range-fed tables and media images — only when NAMED", () => {
    const media = "media:" + "a".repeat(64);
    const spec: FormSpec = {
      children: [
        { type: "dropdown", name: "region", options: { range: "Lists!A2:A20" } },
        { type: "listbox", name: "tags", options: ["a", "b"] },
        { type: "table", name: "recent", columns: ["A", "B"], rows: { range: "D2:E9" } },
        { type: "table", columns: ["A"], rows: { range: "D2:D9" } },
        { type: "image", name: "logo", src: media },
        { type: "image", name: "none", src: "" },
      ],
    };
    expect(collectFormSources(spec)).toEqual([
      { name: "region", widgetType: "dropdown", source: { kind: "options", range: "Lists!A2:A20" } },
      { name: "recent", widgetType: "table", source: { kind: "rows", range: "D2:E9" } },
      { name: "logo", widgetType: "image", source: { kind: "image", src: media } },
    ]);
    expect(parseFormRange("Lists!A2:A20")).toEqual({ sheetName: "Lists", startRow: 1, startCol: 0, endRow: 19, endCol: 0 });
    expect(parseFormRange("D2:E9")).toEqual({ sheetName: null, startRow: 1, startCol: 3, endRow: 8, endCol: 4 });
  });

  it("turns read cells into deduplicated choices and typed rows", () => {
    const cells = [
      [{ value: "EMEA", display: "EMEA", type: "text" as const }, { value: 1, display: "1", type: "number" as const }],
      [{ value: "EMEA", display: "EMEA", type: "text" as const }, { value: null, display: "", type: "empty" as const }],
      [{ value: 1234.5, display: "£1,234.50", type: "number" as const }, { value: true, display: "TRUE", type: "boolean" as const }],
    ];
    expect(optionsFromCells(cells)).toEqual([
      { value: "EMEA", label: "EMEA" },
      { value: "1", label: "1" },
      { value: "£1,234.50", label: "£1,234.50" },
      { value: "TRUE", label: "TRUE" },
    ]);
    expect(rowsFromCells(cells)).toEqual([
      ["EMEA", 1],
      ["EMEA", null],
      [1234.5, true],
    ]);
  });

  it("clamps a range-fed list to the same cap an inline list gets", () => {
    // A `{ range }` list is read through the script's range row, bounded by
    // MAX_RANGE_CELLS (100,000) — two hundred times the cap the spec validator
    // puts on a list written out in the layout. Without the clamp,
    // `options: { range: "A1:A100000" }` produced a hundred thousand entries
    // and the host painted every one of them.
    const many = Array.from({ length: MAX_FORM_OPTIONS + 250 }, (_, i) => [
      { value: `v${i}`, display: `v${i}`, type: "text" as const },
    ]);
    expect(optionsFromCells(many)).toHaveLength(MAX_FORM_OPTIONS);
    expect(optionsFromCells(many)[0].value).toBe("v0");

    // Table rows are clamped by CELLS, so a wide table keeps fewer rows.
    const wide = Array.from({ length: 4000 }, () =>
      Array.from({ length: 5 }, (_, c) => ({ value: c, display: String(c), type: "number" as const })),
    );
    const rows = rowsFromCells(wide);
    expect(rows).toHaveLength(Math.floor(MAX_FORM_TABLE_CELLS / 5));
    expect(rows.length * 5).toBeLessThanOrEqual(MAX_FORM_TABLE_CELLS);
  });
});

describe("collectFormBindings", () => {
  it("lists every bound INPUT widget in tree order with its effective writeOn", () => {
    const spec: FormSpec = {
      writeOn: "change",
      children: [
        { type: "textbox", name: "a", bind: "B2" },
        { type: "label", name: "l", text: "x" },
        { type: "group", children: [{ type: "number", name: "b", bind: { cell: "C3" }, writeOn: "submit" }] },
        { type: "tabs", pages: [{ title: "p", children: [{ type: "checkbox", name: "c", bind: { name: "Flag" } }] }] },
        { type: "button", name: "go", text: "Go" },
        { type: "date", name: "unbound" },
      ],
    };
    expect(collectFormBindings(spec)).toEqual([
      { name: "a", widgetType: "textbox", bind: "B2", writeOn: "change", multi: false },
      { name: "b", widgetType: "number", bind: { cell: "C3" }, writeOn: "submit", multi: false },
      { name: "c", widgetType: "checkbox", bind: { name: "Flag" }, writeOn: "change", multi: false },
    ]);
  });

  it("carries `multi` so the seed has the shape the renderer holds", () => {
    // The shape decides dirtiness. A single-select listbox is one answer, like
    // a dropdown; only a multi listbox is a list. Getting this wrong made an
    // UNTOUCHED widget look edited — see the seed test below.
    const spec: FormSpec = {
      children: [
        { type: "listbox", name: "one", options: ["a", "b"], bind: "B2" },
        { type: "listbox", name: "many", options: ["a", "b"], multi: true, bind: "B3" },
        { type: "dropdown", name: "pick", options: ["a"], bind: "B4" },
      ],
    };
    expect(collectFormBindings(spec).map((d) => [d.name, d.multi])).toEqual([
      ["one", false],
      ["many", true],
      ["pick", false],
    ]);
  });
});

describe("parseFormBinding", () => {
  it("reads a bare cell, a sheet-qualified cell and a quoted sheet", () => {
    expect(parseFormBinding("B2")).toEqual({ kind: "cell", sheetRef: null, row: 1, col: 1 });
    expect(parseFormBinding("Sheet2!$C$10")).toEqual({ kind: "cell", sheetRef: "Sheet2", row: 9, col: 2 });
    expect(parseFormBinding("'My sheet'!A1")).toEqual({ kind: "cell", sheetRef: "My sheet", row: 0, col: 0 });
  });

  it("reads the object forms", () => {
    // A NUMERIC sheet stays a number: resolveSheetRefIn reads a number as an
    // INDEX and a string as a NAME, so stringifying it here (as this test used
    // to require) made the documented `{ cell, sheet: 1 }` resolve as a sheet
    // named "1" — never found, and the widget opened disabled saying so.
    expect(parseFormBinding({ cell: "D4", sheet: 2 })).toEqual({ kind: "cell", sheetRef: 2, row: 3, col: 3 });
    expect(parseFormBinding({ cell: "D4", sheet: "Sheet3" })).toEqual({ kind: "cell", sheetRef: "Sheet3", row: 3, col: 3 });
    expect(parseFormBinding({ cell: "D4" })).toEqual({ kind: "cell", sheetRef: null, row: 3, col: 3 });
    expect(parseFormBinding({ name: "Budget" })).toEqual({ kind: "name", name: "Budget" });
    expect(parseFormBinding({ control: "Region" })).toEqual({ kind: "control", name: "Region" });
  });

  it("treats a bare non-address string as a defined name, and refuses the rest", () => {
    expect(parseFormBinding("TaxRate")).toEqual({ kind: "name", name: "TaxRate" });
    expect(() => parseFormBinding("B2:B6")).toThrow(/neither|single cell/);
    expect(() => parseFormBinding("Sheet1!B2:B6")).toThrow(/single cell/);
    expect(() => parseFormBinding("   ")).toThrow(/empty/);
    expect(() => parseFormBinding("not a name")).toThrow(/neither/);
    // A "!" makes the left part a sheet prefix; what follows must then be a cell.
    expect(() => parseFormBinding("Sheet1!nope")).toThrow(/single cell/);
  });
});

describe("seedFromCell — the widget edits the TYPED value and shows the display", () => {
  it("a currency cell seeds a number widget with the number, not the text", () => {
    const seed = seedFromCell("number", { value: 1234.5, display: "£1,234.50", type: "number" });
    expect(seed).toEqual({ value: 1234.5, display: "£1,234.50" });
  });

  it("keeps a formula so the widget is shown, never rewritten unless edited", () => {
    const seed = seedFromCell("textbox", { value: 42, display: "42", formula: "=A1*2", type: "number" });
    expect(seed.formula).toBe("=A1*2");
    expect(seed.value).toBe("42");
  });

  it("dates become the ISO text a date input edits", () => {
    expect(serialToIsoDate(45900)).toBe("2025-08-31");
    expect(seedFromCell("date", { value: 45900, display: "2025-08-31", type: "number" }).value).toBe("2025-08-31");
  });

  it("checkbox and toggle read booleans, numbers and yes/true text", () => {
    expect(seedFromCell("checkbox", { value: true, display: "TRUE", type: "boolean" }).value).toBe(true);
    expect(seedFromCell("toggle", { value: 0, display: "0", type: "number" }).value).toBe(false);
    expect(seedFromCell("checkbox", { value: "yes", display: "yes", type: "text" }).value).toBe(true);
    expect(seedFromCell("checkbox", { value: null, display: "", type: "empty" }).value).toBe(false);
  });

  it("a MULTI listbox splits a comma list; an empty cell is no selection", () => {
    expect(seedFromCell("listbox", { value: "a, b", display: "a, b", type: "text" }, true).value).toEqual(["a", "b"]);
    expect(seedFromCell("listbox", { value: null, display: "", type: "empty" }, true).value).toEqual([]);
  });

  it("a TEXTBOX bound to a number edits the typed value; the display rides along separately", () => {
    // The currency trap. Seeding the editable value with "£1,234.50" meant one
    // keystroke wrote currency TEXT into a number cell — the entry ladder
    // refuses to parse it and stores a string, breaking every formula on it.
    const seed = seedFromCell("textbox", { value: 1234.5, display: "£1,234.50", type: "number" });
    expect(seed.value).toBe("1234.5");
    expect(seed.display).toBe("£1,234.50");
    expect(cellWriteFor("textbox", seed.value)).toBe("1234.5");
    // A text cell is unchanged, and a choice widget still matches option TEXT.
    expect(seedFromCell("textbox", { value: "Ada", display: "Ada", type: "text" }).value).toBe("Ada");
    expect(seedFromCell("dropdown", { value: "EMEA", display: "EMEA", type: "text" }).value).toBe("EMEA");
    // A dropdown fed by a range of numbers keeps the display, because
    // optionsFromCells builds its options from the display too.
    expect(seedFromCell("dropdown", { value: 1234.5, display: "£1,234.50", type: "number" }).value).toBe("£1,234.50");
  });

  it("a single-select listbox seeds like a dropdown, so an untouched one is never dirty", () => {
    // The shape has to match what the renderer holds (coerceValue: one string
    // unless `multi`). Seeded as a list, an untouched single-select listbox
    // bound to a cell reading "EMEA, APAC" compared ["EMEA","APAC"] against
    // "EMEA" — dirty — and the submit wrote "EMEA", truncating the cell.
    const cell = { value: "EMEA, APAC", display: "EMEA, APAC", type: "text" as const };
    const one = seedFromCell("listbox", cell, false);
    expect(one.value).toBe("EMEA, APAC");
    expect(isDirty(one, "EMEA, APAC")).toBe(false);
    const many = seedFromCell("listbox", cell, true);
    expect(many.value).toEqual(["EMEA", "APAC"]);
    expect(isDirty(many, ["EMEA", "APAC"])).toBe(false);
  });
});

describe("seedFromControlValue", () => {
  it("is read-only and says so", () => {
    const seed = seedFromControlValue("number", { kind: "number", value: 3 });
    expect(seed.value).toBe(3);
    expect(seed.readOnly).toBe(true);
    expect(seedFromControlValue("textbox", null).reason).toMatch(/no control/);
    expect(seedFromControlValue("listbox", { kind: "text", value: "x" }, true).value).toEqual(["x"]);
    // Single-select: one string, the shape the renderer holds.
    expect(seedFromControlValue("listbox", { kind: "textList", value: ["a", "b"] }).value).toBe("a, b");
    expect(seedFromControlValue("textbox", { kind: "textList", value: ["a", "b"] }).value).toBe("a, b");
  });
});

describe("sheetIdentityRefusal — an index is not an identity while a form is open", () => {
  const SHEETS = [
    { index: 0, name: "Sheet1" },
    { index: 1, name: "Sheet2" },
    { index: 2, name: "Sheet3" },
  ];
  const cell = (name: string, sheetIndex: number, sheetName: string) => ({ name, sheetIndex, sheetName });

  it("says nothing while the workbook still looks the way the form read it", () => {
    expect(sheetIdentityRefusal([cell("qty", 1, "Sheet2")], { index: 0, name: "Sheet1" }, SHEETS)).toBeNull();
    // A binding whose sheet could not be named at show carries no claim to check.
    expect(
      sheetIdentityRefusal([{ name: "q", sheetIndex: 9, sheetName: undefined }], null, SHEETS),
    ).toBeNull();
  });

  it("refuses when a deleted sheet shifts the index the form is holding", () => {
    // Sheet1 deleted while the modal was up: index 1 is now "Sheet3", so the
    // submit would write the user's answers into the wrong sheet.
    const after = [
      { index: 0, name: "Sheet2" },
      { index: 1, name: "Sheet3" },
    ];
    const refusal = sheetIdentityRefusal([cell("qty", 1, "Sheet2")], null, after);
    expect(refusal).toContain('"qty" was read from "Sheet2"');
    expect(refusal).toContain('"Sheet3"');
    expect(refusal).toContain("open it again");
  });

  it("refuses when the sheet is gone entirely, and names that", () => {
    const refusal = sheetIdentityRefusal([cell("qty", 2, "Sheet3")], null, [{ index: 0, name: "Sheet1" }]);
    expect(refusal).toContain("no sheet");
  });

  it("checks the restricted-tier pin too, before any cell", () => {
    // The pin is an index compared against the ACTIVE sheet, so a shifted list
    // can satisfy it while naming a different sheet.
    const after = [{ index: 0, name: "Sheet2" }];
    const refusal = sheetIdentityRefusal([cell("qty", 0, "Sheet2")], { index: 0, name: "Sheet1" }, after);
    expect(refusal).toContain('"Sheet1" is no longer where this form opened');
  });

  it("a renamed sheet is refused as well — the name was the identity", () => {
    const renamed = [{ index: 0, name: "Sheet1" }, { index: 1, name: "Data" }, { index: 2, name: "Sheet3" }];
    expect(sheetIdentityRefusal([cell("qty", 1, "Sheet2")], null, renamed)).toContain('"Data"');
  });
});

describe("cellWriteFor — never the display string", () => {
  it("writes numbers as numbers, booleans as booleans, formulas as text", () => {
    expect(cellWriteFor("number", 1300)).toBe(1300);
    expect(cellWriteFor("number", "1300")).toBe(1300);
    expect(cellWriteFor("number", "")).toBeNull();
    expect(cellWriteFor("number", "abc")).toBe("abc");
    expect(cellWriteFor("checkbox", true)).toBe(true);
    expect(cellWriteFor("toggle", "true")).toBe(true);
    expect(cellWriteFor("textbox", "=A1+1")).toBe("=A1+1");
    expect(cellWriteFor("date", "2026-09-02")).toBe("2026-09-02");
    expect(cellWriteFor("listbox", ["a", "b"])).toBe("a, b");
    expect(cellWriteFor("listbox", [])).toBeNull();
    expect(cellWriteFor("textbox", null)).toBeNull();
  });
});

describe("dirtiness", () => {
  it("an untouched currency cell is NOT dirty and is never written", () => {
    const seeds = { price: seedFromCell("number", { value: 1234.5, display: "£1,234.50", type: "number" }) };
    expect(isDirty(seeds.price, 1234.5)).toBe(false);
    expect(isDirty(seeds.price, "1234.5")).toBe(false);
    expect(dirtyNames({ price: 1234.5 }, seeds, ["price"])).toEqual([]);
  });

  it("an edited value is dirty", () => {
    const seed = seedFromCell("number", { value: 1234.5, display: "£1,234.50", type: "number" });
    expect(isDirty(seed, 1300)).toBe(true);
    expect(dirtyNames({ price: 1300, other: 1 }, { price: seed }, ["price", "other"])).toEqual(["price", "other"]);
  });

  it("empty and null agree; arrays compare by element", () => {
    expect(isDirty({ value: null }, "")).toBe(false);
    expect(isDirty({ value: "" }, null)).toBe(false);
    expect(isDirty({ value: ["a"] }, ["a"])).toBe(false);
    expect(isDirty({ value: ["a"] }, ["a", "b"])).toBe(true);
    expect(isDirty(undefined, "")).toBe(false);
    expect(isDirty(undefined, "x")).toBe(true);
  });
});
