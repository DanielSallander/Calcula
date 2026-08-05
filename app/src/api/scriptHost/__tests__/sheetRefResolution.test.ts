//! FILENAME: app/src/api/scriptHost/__tests__/sheetRefResolution.test.ts
// PURPOSE: Wave 1 addressing foundation — sheet refs (index OR name) and typed
//          cell writes.
// COVERS:  (1) the vSheetRef validator's acceptance matrix (shape only),
//          (2) resolveSheetRefIn: exact name, unique case-insensitive fallback,
//              ambiguity, miss — with errors that LIST the actual sheet names,
//          (3) scriptCellInput: the typed-value -> invariant-input conversion
//              every write path shares (42 lands numeric, true lands boolean,
//              null clears),
//          (4) the exported clipboard helpers accepting a sheet NAME where they
//              accepted an index (assertActiveSheet resolves it).

import { describe, expect, it, vi } from "vitest";
import { vSheetRef, vCellSet, vBatch, vRangeWrite } from "../validators";
import {
  resolveSheetRefIn,
  scriptCellInput,
  copyRangeToScriptClipboard,
  clearScriptClipboard,
} from "../host";

// ============================================================================
// (1) vSheetRef: the shape gate (resolution is host-side, never here)
// ============================================================================

describe("vSheetRef accepts an index or a name, and nothing else", () => {
  it("accepts a non-negative integer index", () => {
    expect(vSheetRef([0])).toBe(true);
    expect(vSheetRef([3])).toBe(true);
    expect(vSheetRef([100])).toBe(true);
  });

  it("accepts a plausible sheet name (the rename validator's character rules)", () => {
    expect(vSheetRef(["Sheet1"])).toBe(true);
    expect(vSheetRef(["Q1 Budget"])).toBe(true);
    expect(vSheetRef(["Försäljning 2026"])).toBe(true);
    expect(vSheetRef(["x".repeat(255)])).toBe(true);
  });

  it("rejects a negative, fractional or non-finite index", () => {
    expect(vSheetRef([-1])).not.toBe(true);
    expect(vSheetRef([1.5])).not.toBe(true);
    expect(vSheetRef([NaN])).not.toBe(true);
    expect(vSheetRef([Infinity])).not.toBe(true);
  });

  it("rejects a name that could never be a sheet name", () => {
    expect(vSheetRef([""])).not.toBe(true);
    expect(vSheetRef(["   "])).not.toBe(true);
    expect(vSheetRef(["x".repeat(256)])).not.toBe(true);
    for (const ch of [":", "\\", "/", "?", "*", "[", "]"]) {
      expect(vSheetRef([`Bad${ch}Name`]), `illegal char ${ch}`).not.toBe(true);
    }
  });

  it("rejects every other type", () => {
    expect(vSheetRef([true])).not.toBe(true);
    expect(vSheetRef([null])).not.toBe(true);
    expect(vSheetRef([undefined])).not.toBe(true);
    expect(vSheetRef([{ index: 0 }])).not.toBe(true);
    expect(vSheetRef([[0]])).not.toBe(true);
  });
});

// ============================================================================
// (2) resolveSheetRefIn: live-state resolution
// ============================================================================

const SHEETS = [
  { index: 0, name: "Sheet1" },
  { index: 1, name: "Data" },
  { index: 3, name: "data" }, // deliberate case-clash with "Data"
  { index: 4, name: "Summary" },
];

describe("resolveSheetRefIn resolves indexes and names against the live list", () => {
  it("passes a known index through", () => {
    expect(resolveSheetRefIn(SHEETS, 0, "test")).toBe(0);
    expect(resolveSheetRefIn(SHEETS, 4, "test")).toBe(4);
  });

  it("bounds-checks an index against the ACTUAL list (index 2 was deleted)", () => {
    expect(() => resolveSheetRefIn(SHEETS, 2, "test")).toThrow(/no sheet with index 2/);
    expect(() => resolveSheetRefIn(SHEETS, 99, "test")).toThrow(/no sheet with index 99/);
  });

  it("resolves an exact name", () => {
    expect(resolveSheetRefIn(SHEETS, "Sheet1", "test")).toBe(0);
    expect(resolveSheetRefIn(SHEETS, "Summary", "test")).toBe(4);
  });

  it("exact match WINS over the case-insensitive fallback", () => {
    // "Data" and "data" both exist; each exact spelling gets its own sheet.
    expect(resolveSheetRefIn(SHEETS, "Data", "test")).toBe(1);
    expect(resolveSheetRefIn(SHEETS, "data", "test")).toBe(3);
  });

  it("falls back case-insensitively when that is unambiguous", () => {
    expect(resolveSheetRefIn(SHEETS, "SHEET1", "test")).toBe(0);
    expect(resolveSheetRefIn(SHEETS, "summary", "test")).toBe(4);
  });

  it("refuses an AMBIGUOUS case-insensitive match, naming the candidates", () => {
    expect(() => resolveSheetRefIn(SHEETS, "DATA", "test")).toThrow(
      /ambiguous ignoring case.*"Data" \(1\).*"data" \(3\)/,
    );
  });

  it("a miss lists the actual sheet names (the 11pm error)", () => {
    let message = "";
    try {
      resolveSheetRefIn(SHEETS, "Sheet2", "setActiveSheet");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('no sheet named "Sheet2"');
    // Every real sheet is named, so the fix is IN the error text.
    expect(message).toContain('"Sheet1" (0)');
    expect(message).toContain('"Data" (1)');
    expect(message).toContain('"data" (3)');
    expect(message).toContain('"Summary" (4)');
    // The method the user called is named too.
    expect(message).toContain("setActiveSheet");
  });
});

// ============================================================================
// (3) scriptCellInput: typed values -> the backend's input form
// ============================================================================

describe("scriptCellInput converts typed values the way a paste does", () => {
  it("numbers become their invariant string, flagged invariant", () => {
    expect(scriptCellInput(42)).toEqual({ value: "42", invariant: true });
    // The whole point of the flag: "42.5" must not be re-parsed under a
    // comma-decimal locale as text (or as 425).
    expect(scriptCellInput(42.5)).toEqual({ value: "42.5", invariant: true });
    expect(scriptCellInput(-0.25)).toEqual({ value: "-0.25", invariant: true });
  });

  it("booleans become TRUE/FALSE, flagged invariant (same as the paste path)", () => {
    expect(scriptCellInput(true)).toEqual({ value: "TRUE", invariant: true });
    expect(scriptCellInput(false)).toEqual({ value: "FALSE", invariant: true });
  });

  it("null clears: the empty input, NOT the text 'null'", () => {
    expect(scriptCellInput(null)).toEqual({ value: "", invariant: false });
  });

  it("strings pass through verbatim as user-entry input (formulas included)", () => {
    expect(scriptCellInput("hello")).toEqual({ value: "hello", invariant: false });
    expect(scriptCellInput("=A1+B1")).toEqual({ value: "=A1+B1", invariant: false });
    // A string that LOOKS numeric stays a user entry — writing "42" as text
    // vs 42 as a number is exactly the distinction the typed API adds.
    expect(scriptCellInput("42")).toEqual({ value: "42", invariant: false });
  });
});

describe("the write validators accept the typed vocabulary", () => {
  it("vCellSet takes string | number | boolean | null", () => {
    expect(vCellSet([0, 0, "text"])).toBe(true);
    expect(vCellSet([0, 0, 42])).toBe(true);
    expect(vCellSet([0, 0, true])).toBe(true);
    expect(vCellSet([0, 0, null])).toBe(true);
    expect(vCellSet([0, 0, NaN])).not.toBe(true);
    expect(vCellSet([0, 0, { v: 1 }])).not.toBe(true);
    expect(vCellSet([0, 0, undefined])).not.toBe(true);
  });

  it("vCellSet still takes the optional sheet ref, index or name", () => {
    expect(vCellSet([0, 0, 42, 1])).toBe(true);
    expect(vCellSet([0, 0, 42, "Data"])).toBe(true);
    expect(vCellSet([0, 0, 42, -1])).not.toBe(true);
  });

  it("vBatch takes typed update values", () => {
    expect(vBatch([[{ row: 0, col: 0, value: 42 }, { row: 0, col: 1, value: null }]])).toBe(true);
    expect(vBatch([[{ row: 0, col: 0, value: false }]])).toBe(true);
    expect(vBatch([[{ row: 0, col: 0, value: Symbol("x") }]])).not.toBe(true);
  });

  it("vRangeWrite: undefined is a hole, null is a CLEAR, both valid", () => {
    expect(vRangeWrite([0, 0, [[undefined, null, 7, false, "x"]]])).toBe(true);
  });
});

// ============================================================================
// (4) an exported host path accepts a NAME where it accepted an index
// ============================================================================

function fakeLib() {
  return {
    getActiveSheet: vi.fn(async () => 0),
    getSheets: vi.fn(async () => ({
      sheets: [
        { index: 0, name: "Main" },
        { index: 1, name: "Archive" },
      ],
      activeIndex: 0,
    })),
    getRangeCellsTyped: vi.fn(async () => []),
    getViewportCells: vi.fn(async () => []),
  };
}
// Only the members the path under test touches — the cast is the test double's.
type LibLike = Parameters<typeof copyRangeToScriptClipboard>[0];

describe("assertActiveSheet resolves names (via copyRange, an exported caller)", () => {
  it("the ACTIVE sheet's own name is accepted", async () => {
    const lib = fakeLib();
    await expect(
      copyRangeToScriptClipboard(lib as unknown as LibLike, "s1", "Main", 0, 0, 1, 1),
    ).resolves.toEqual({ rows: 2, cols: 2 });
    clearScriptClipboard("s1");
  });

  it("the active sheet's name is accepted CASE-INSENSITIVELY", async () => {
    const lib = fakeLib();
    await expect(
      copyRangeToScriptClipboard(lib as unknown as LibLike, "s1", "MAIN", 0, 0, 1, 1),
    ).resolves.toEqual({ rows: 2, cols: 2 });
    clearScriptClipboard("s1");
  });

  it("another sheet's name is refused with the setActiveSheet fix", async () => {
    const lib = fakeLib();
    await expect(
      copyRangeToScriptClipboard(lib as unknown as LibLike, "s1", "Archive", 0, 0, 1, 1),
    ).rejects.toThrow(/can only target the active sheet.*setActiveSheet\("Archive"\)/);
  });

  it("an unknown name is refused with the sheet list", async () => {
    const lib = fakeLib();
    await expect(
      copyRangeToScriptClipboard(lib as unknown as LibLike, "s1", "Sheet1", 0, 0, 1, 1),
    ).rejects.toThrow(/no sheet named "Sheet1".*"Main" \(0\), "Archive" \(1\)/);
  });
});
