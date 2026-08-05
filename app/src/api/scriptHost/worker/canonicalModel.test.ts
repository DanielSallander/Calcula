//! FILENAME: app/src/api/scriptHost/worker/canonicalModel.test.ts
// PURPOSE: Tests for the worker-realm canonical Range facet (C3 step 3) — A1
//          parsing/formatting, navigation, and that data ops fan out to the
//          injected transport (which the shim wires to broker aspects) with the
//          right coordinates and clamping. Also covers the B1 bulk/typed paths:
//          ONE round trip per rectangle for getValues/getData/getFormulas and
//          for setValues, with per-cell fallbacks only when the transport has
//          no bulk method.

import { describe, it, expect, vi } from "vitest";
import {
  makeRange,
  rangeFromAddress,
  parseA1,
  parseA1Body,
  splitSheetPrefix,
  resolveSheetName,
  makeWorkbook,
  type RangeTransport,
  type ScriptCell,
  type ScriptFormat,
  type WorkbookTransport,
} from "./canonicalModel";

const box = (sr: number, sc: number, er: number, ec: number) => ({
  startRow: sr,
  startCol: sc,
  endRow: er,
  endCol: ec,
});

/** A cell-at-a-time transport (no bulk methods) — the fallback path. */
function perCellTransport(
  read: (row: number, col: number) => Promise<string> = async () => "",
  write: (row: number, col: number, value: string) => Promise<void> = async () => {},
): RangeTransport {
  return { readCell: read, writeCell: write };
}

const cell = (value: ScriptCell["value"], type: ScriptCell["type"], display?: string, formula?: string): ScriptCell => ({
  value,
  display: display ?? (value === null ? "" : String(value)),
  type,
  ...(formula ? { formula } : {}),
});

describe("parseA1", () => {
  it("parses a single cell", () => {
    expect(parseA1("A1")).toEqual(box(0, 0, 0, 0));
    expect(parseA1("B5")).toEqual(box(4, 1, 4, 1));
  });
  it("parses a range and normalizes order", () => {
    expect(parseA1("A1:C3")).toEqual(box(0, 0, 2, 2));
    expect(parseA1("C3:A1")).toEqual(box(0, 0, 2, 2));
  });
  it("strips $ absolute markers", () => {
    expect(parseA1("$B$2:$C$4")).toEqual(box(1, 1, 3, 2));
  });
  it("REFUSES a sheet name prefix (a pinned range cannot address another sheet)", () => {
    // The old behavior silently dropped the prefix and wrote to the bound
    // sheet — the wrong one. Now it throws with a pointer to the surfaces
    // that CAN rebind.
    expect(() => parseA1("Other!A1:B2")).toThrow(/names sheet "Other"/);
    expect(() => parseA1("Other!A1:B2")).toThrow(/api\.range\("Other!A1:B2"\)/);
  });
  it("handles multi-letter columns", () => {
    expect(parseA1("AA1")).toEqual(box(0, 26, 0, 26));
  });
  it("throws on a malformed ref", () => {
    expect(() => parseA1("notacell")).toThrow(/Invalid cell reference/);
  });
  it("rejects row 0 like Rust parse_ref does (no silent row -1)", () => {
    // "A0" used to parse to row -1, which skipped the named-range fallback in
    // api.range() and failed later with a coordinate error that never named
    // the address. Twin behavior: canonical_model.rs parse_ref rejects row 0.
    expect(() => parseA1("A0")).toThrow(/Invalid cell reference/);
    expect(() => parseA1("A0:B2")).toThrow(/Invalid cell reference/);
  });
});

describe("splitSheetPrefix", () => {
  it("returns null sheetName when there is no prefix", () => {
    expect(splitSheetPrefix("A1:B2")).toEqual({ sheetName: null, rest: "A1:B2" });
  });
  it("splits a bare prefix", () => {
    expect(splitSheetPrefix("Data!A1:B5")).toEqual({ sheetName: "Data", rest: "A1:B5" });
  });
  it("unquotes 'My Sheet' and un-escapes '' to a literal quote", () => {
    expect(splitSheetPrefix("'My Sheet'!A1")).toEqual({ sheetName: "My Sheet", rest: "A1" });
    expect(splitSheetPrefix("'It''s here'!B2")).toEqual({ sheetName: "It's here", rest: "B2" });
  });
});

describe("resolveSheetName (twin of resolve_sheet_name in core/script-engine/src/ops/mod.rs)", () => {
  const names = ["Alpha", "Beta"];
  it("resolves an exact match", () => {
    expect(resolveSheetName(names, "Beta")).toBe(1);
  });
  it("resolves a UNIQUE case-insensitive match", () => {
    expect(resolveSheetName(names, "beta")).toBe(1);
  });
  it("prefers the exact match when case-insensitive would be ambiguous", () => {
    expect(resolveSheetName(["Data", "DATA"], "DATA")).toBe(1);
  });
  it("throws on a miss, listing the workbook's sheets", () => {
    expect(() => resolveSheetName(names, "Nope")).toThrow(
      'No sheet named "Nope". Sheets in this workbook: "Alpha", "Beta"',
    );
  });
  it("throws on an ambiguous case-insensitive match", () => {
    expect(() => resolveSheetName(["Data", "DATA"], "data")).toThrow(
      /ambiguous: it case-insensitively matches more than one sheet/,
    );
  });
});

describe("ScriptRange geometry + navigation", () => {
  it("reports address, counts, single-cell", () => {
    const r = rangeFromAddress(perCellTransport(), "B2:D5");
    expect(r.address).toBe("B2:D5");
    expect(r.rowCount).toBe(4);
    expect(r.colCount).toBe(3);
    expect(r.isSingleCell).toBe(false);
    const single = rangeFromAddress(perCellTransport(), "B2");
    expect(single.isSingleCell).toBe(true);
    expect(single.address).toBe("B2");
  });

  it("offset/resize/getCell return new ranges", () => {
    const r = rangeFromAddress(perCellTransport(), "B2:C3");
    expect(r.offset(1, 1).address).toBe("C3:D4");
    expect(r.resize(1, 1).address).toBe("B2");
    expect(r.getCell(0, 0).address).toBe("B2");
    expect(r.getCell(1, 1).address).toBe("C3");
  });

  it("getCell out of range throws", () => {
    const r = rangeFromAddress(perCellTransport(), "B2:C3");
    expect(() => r.getCell(5, 5)).toThrow(/outside range/);
  });

  it("a navigated range keeps the bulk transport", async () => {
    const readRange = vi.fn(async () => [[cell(1, "number")]]);
    const t: RangeTransport = { ...perCellTransport(), readRange };
    await rangeFromAddress(t, "A1:C3").offset(1, 1).resize(1, 1).getData();
    expect(readRange).toHaveBeenCalledWith(1, 1, 1, 1);
  });
});

describe("ScriptRange data ops fan out to the transport", () => {
  it("getValue reads the top-left cell", async () => {
    const read = vi.fn(async (r: number, c: number) => `v${r},${c}`);
    const r = rangeFromAddress(perCellTransport(read), "C2:D3"); // top-left (1,2)
    expect(await r.getValue()).toBe("v1,2");
    expect(read).toHaveBeenCalledWith(1, 2);
  });

  it("getValues uses the BULK read — one call for the whole rectangle", async () => {
    const readRange = vi.fn(async () => [
      [cell(1, "number", "1"), cell("x", "text")],
      [cell(true, "boolean", "TRUE"), cell(null, "empty")],
    ]);
    const readCell = vi.fn(async () => "should-not-be-called");
    const r = rangeFromAddress({ readCell, writeCell: async () => {}, readRange }, "A1:B2");
    expect(await r.getValues()).toEqual([
      ["1", "x"],
      ["TRUE", ""],
    ]);
    expect(readRange).toHaveBeenCalledTimes(1);
    expect(readRange).toHaveBeenCalledWith(0, 0, 1, 1);
    expect(readCell).not.toHaveBeenCalled();
  });

  it("getValues falls back to per-cell reads without a bulk transport", async () => {
    const read = vi.fn(async (r: number, c: number) => `${r}:${c}`);
    const r = rangeFromAddress(perCellTransport(read), "A1:B2");
    expect(await r.getValues()).toEqual([
      ["0:0", "0:1"],
      ["1:0", "1:1"],
    ]);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("getData returns typed cells with formulas preserved", async () => {
    const readRange = vi.fn(async () => [[cell(3, "number", "3", "=1+2"), cell("#DIV/0!", "error", "#DIV/0!")]]);
    const r = rangeFromAddress({ ...perCellTransport(), readRange }, "A1:B1");
    const data = await r.getData();
    expect(data[0][0]).toEqual({ value: 3, display: "3", type: "number", formula: "=1+2" });
    expect(data[0][1].type).toBe("error");
    expect(data[0][1].formula).toBeUndefined();
    expect(readRange).toHaveBeenCalledWith(0, 0, 0, 1);
  });

  it("getFormulas maps the typed read, blank where there is none", async () => {
    const readRange = vi.fn(async () => [[cell(3, "number", "3", "=1+2"), cell("x", "text")]]);
    const r = rangeFromAddress({ ...perCellTransport(), readRange }, "A1:B1");
    expect(await r.getFormulas()).toEqual([["=1+2", ""]]);
  });

  it("getData without a bulk transport throws instead of guessing types", async () => {
    const r = rangeFromAddress(perCellTransport(), "A1:B2");
    await expect(r.getData()).rejects.toThrow(/typed reads/);
  });

  it("setValue writes the top-left cell", async () => {
    const write = vi.fn(async () => {});
    const r = makeRange(perCellTransport(undefined, write), box(2, 1, 4, 3));
    await r.setValue("x");
    expect(write).toHaveBeenCalledWith(2, 1, "x");
  });

  it("setValues uses the BULK write, clamped to range dimensions", async () => {
    const writeCells = vi.fn(async () => {});
    const writeCell = vi.fn(async () => {});
    const r = rangeFromAddress({ readCell: async () => "", writeCell, writeCells }, "A1:B2");
    // 3x3 input into a 2x2 range -> only the top-left 2x2 is written
    await r.setValues([
      ["a", "b", "ignored"],
      ["c", "d", "ignored"],
      ["ignored", "ignored", "ignored"],
    ]);
    expect(writeCells).toHaveBeenCalledTimes(1);
    expect(writeCells).toHaveBeenCalledWith(0, 0, [
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(writeCell).not.toHaveBeenCalled();
  });

  it("setValues falls back to per-cell writes without a bulk transport", async () => {
    const write = vi.fn(async () => {});
    const r = rangeFromAddress(perCellTransport(undefined, write), "A1:B2");
    await r.setValues([
      ["a", "b", "ignored"],
      ["c", "d", "ignored"],
      ["ignored", "ignored", "ignored"],
    ]);
    expect(write).toHaveBeenCalledTimes(4);
    expect(write).toHaveBeenCalledWith(0, 0, "a");
    expect(write).toHaveBeenCalledWith(0, 1, "b");
    expect(write).toHaveBeenCalledWith(1, 0, "c");
    expect(write).toHaveBeenCalledWith(1, 1, "d");
  });

  it("setValues skips holes (undefined) in the fallback path", async () => {
    const write = vi.fn(async () => {});
    const r = rangeFromAddress(perCellTransport(undefined, write), "A1:B2");
    await r.setValues([["a", undefined as unknown as string], ["c"]]);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledWith(0, 0, "a");
    expect(write).toHaveBeenCalledWith(1, 0, "c");
  });

  it("format() sends the WHOLE rectangle and the format object in ONE call (B2)", async () => {
    const formatRange = vi.fn(async () => {});
    const t: RangeTransport = { ...perCellTransport(), formatRange };
    await rangeFromAddress(t, "B2:D5").format({ bold: true, numberFormat: "0.00" });
    expect(formatRange).toHaveBeenCalledTimes(1);
    expect(formatRange).toHaveBeenCalledWith(1, 1, 4, 3, { bold: true, numberFormat: "0.00" });
  });

  it("clearFormat() sends the rectangle in ONE call (B2)", async () => {
    const clearFormatRange = vi.fn(async () => {});
    const t: RangeTransport = { ...perCellTransport(), clearFormatRange };
    await rangeFromAddress(t, "A1:B2").clearFormat();
    expect(clearFormatRange).toHaveBeenCalledTimes(1);
    expect(clearFormatRange).toHaveBeenCalledWith(0, 0, 1, 1);
  });

  it("a navigated range keeps the formatting transport", async () => {
    const formatRange = vi.fn(async () => {});
    const t: RangeTransport = { ...perCellTransport(), formatRange };
    await rangeFromAddress(t, "A1:C3").offset(1, 1).resize(1, 1).format({ italic: true });
    expect(formatRange).toHaveBeenCalledWith(1, 1, 1, 1, { italic: true });
  });

  it("format()/clearFormat() THROW (never silently no-op) without a formatting transport", async () => {
    const r = rangeFromAddress(perCellTransport(), "A1:B2");
    await expect(r.format({ bold: true })).rejects.toThrow(/not available for this range/);
    await expect(r.clearFormat()).rejects.toThrow(/not available for this range/);
  });
});

describe("Workbook navigation (unlocked, cross-sheet)", () => {
  const makeTransport = (): WorkbookTransport & {
    reads: [number, number, number][];
    writes: [number, number, number, string][];
    rangeReads: [number, number, number, number, number][];
    blockWrites: Array<[number, number, number, Array<Array<string | undefined>>]>;
    formats: Array<[number, number, number, number, number, ScriptFormat]>;
    formatClears: Array<[number, number, number, number, number]>;
  } => {
    const reads: [number, number, number][] = [];
    const writes: [number, number, number, string][] = [];
    const rangeReads: [number, number, number, number, number][] = [];
    const blockWrites: Array<[number, number, number, Array<Array<string | undefined>>]> = [];
    const formats: Array<[number, number, number, number, number, ScriptFormat]> = [];
    const formatClears: Array<[number, number, number, number, number]> = [];
    return {
      reads,
      writes,
      rangeReads,
      blockWrites,
      formats,
      formatClears,
      formatRange: vi.fn(
        async (s: number, sr: number, sc: number, er: number, ec: number, f: ScriptFormat) => {
          formats.push([s, sr, sc, er, ec, f]);
        },
      ),
      clearFormatRange: vi.fn(async (s: number, sr: number, sc: number, er: number, ec: number) => {
        formatClears.push([s, sr, sc, er, ec]);
      }),
      getSheetNames: vi.fn(async () => ["Intro", "Data", "Hidden"]),
      getActiveSheet: vi.fn(async () => 1),
      setActiveSheet: vi.fn(async () => {}),
      readCell: vi.fn(async (s: number, r: number, c: number) => {
        reads.push([s, r, c]);
        return `${s}:${r}:${c}`;
      }),
      writeCell: vi.fn(async (s: number, r: number, c: number, v: string) => {
        writes.push([s, r, c, v]);
      }),
      readRange: vi.fn(async (s: number, sr: number, sc: number, er: number, ec: number) => {
        rangeReads.push([s, sr, sc, er, ec]);
        const out: ScriptCell[][] = [];
        for (let r = sr; r <= er; r++) {
          const row: ScriptCell[] = [];
          for (let c = sc; c <= ec; c++) row.push(cell(`${s}:${r}:${c}`, "text"));
          out.push(row);
        }
        return out;
      }),
      writeCells: vi.fn(
        async (s: number, sr: number, sc: number, values: Array<Array<string | undefined>>) => {
          blockWrites.push([s, sr, sc, values]);
        },
      ),
    };
  };

  it("sheets() returns every sheet in tab order", async () => {
    const wb = makeWorkbook(makeTransport());
    const sheets = await wb.sheets();
    expect(sheets.map((s) => s.name)).toEqual(["Intro", "Data", "Hidden"]);
    expect(sheets.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  it("activeSheet() resolves the active index", async () => {
    const wb = makeWorkbook(makeTransport());
    const s = await wb.activeSheet();
    expect(s.index).toBe(1);
    expect(s.name).toBe("Data");
  });

  it("sheet() resolves by name and index, null when absent", async () => {
    const wb = makeWorkbook(makeTransport());
    expect((await wb.sheet("Hidden"))?.index).toBe(2);
    expect((await wb.sheet(0))?.name).toBe("Intro");
    expect(await wb.sheet("Nope")).toBeNull();
    expect(await wb.sheet(9)).toBeNull();
  });

  it("a navigated sheet's range reads/writes THAT sheet's index, in bulk", async () => {
    const t = makeTransport();
    const wb = makeWorkbook(t);
    const hidden = await wb.sheet("Hidden"); // index 2
    await hidden!.range("A1:B1").setValues([["x", "y"]]);
    await hidden!.range("A6:A6").getData();
    await hidden!.cell(5, 0).getValue();
    expect(t.blockWrites).toEqual([[2, 0, 0, [["x", "y"]]]]);
    expect(t.rangeReads).toEqual([[2, 5, 0, 5, 0]]);
    expect(t.reads).toEqual([[2, 5, 0]]);
    expect(t.writes).toEqual([]);
  });

  it("activate() switches to that sheet", async () => {
    const t = makeTransport();
    const wb = makeWorkbook(t);
    const s = await wb.sheet(2);
    await s!.activate();
    expect(t.setActiveSheet).toHaveBeenCalledWith(2);
  });

  it("a navigated sheet's range formats THAT sheet (no active-sheet dance)", async () => {
    const t = makeTransport();
    const wb = makeWorkbook(t);
    const hidden = await wb.sheet("Hidden"); // index 2, NOT the active sheet (1)
    await hidden!.range("A1:C1").format({ bold: true });
    await hidden!.range("A1:C1").clearFormat();
    expect(t.formats).toEqual([[2, 0, 0, 0, 2, { bold: true }]]);
    expect(t.formatClears).toEqual([[2, 0, 0, 0, 2]]);
  });

  // The TWIN of this decision table lives in the QuickJS realm:
  // core/script-engine/src/ops/canonical_model.rs (tests
  // range_prefix_naming_the_bound_sheet_stays_bound / _another_sheet_rebinds /
  // _supports_quoted_sheet_names / _naming_no_sheet_throws_listing_names).
  // Both realms MUST agree, case for case — a prefix is resolved, never
  // silently dropped (dropping it sent sheet("Intro").range("Data!A1") writes
  // to Intro, the WRONG sheet).
  describe("sheet.range() with a 'Sheet!' prefix (twin table: canonical_model.rs)", () => {
    it("prefix naming the BOUND sheet stays bound", async () => {
      const t = makeTransport();
      const wb = makeWorkbook(t);
      const intro = await wb.sheet("Intro"); // index 0
      await intro!.range("Intro!A1").setValue("here");
      expect(t.writes).toEqual([[0, 0, 0, "here"]]);
    });

    it("prefix naming ANOTHER existing sheet REBINDS the range to that sheet", async () => {
      const t = makeTransport();
      const wb = makeWorkbook(t);
      const intro = await wb.sheet("Intro"); // bound to 0
      const r = intro!.range("Data!A1:B1"); // names sheet 1
      await r.setValues([["b1", "b2"]]);
      expect(r.address).toBe("A1:B1"); // geometry is unchanged by the rebind
      expect(t.blockWrites).toEqual([[1, 0, 0, [["b1", "b2"]]]]);
      // Nothing landed on the bound sheet.
      expect(t.blockWrites.filter(([s]) => s === 0)).toEqual([]);
    });

    it("supports quoted sheet names ('Data'!B2)", async () => {
      const t = makeTransport();
      const wb = makeWorkbook(t);
      const intro = await wb.sheet("Intro");
      await intro!.range("'Data'!B2").setValue("q");
      expect(t.writes).toEqual([[1, 1, 1, "q"]]);
    });

    it("resolves a UNIQUE case-insensitive prefix (shared resolver rule)", async () => {
      const t = makeTransport();
      const wb = makeWorkbook(t);
      const intro = await wb.sheet("Intro");
      await intro!.range("data!A1").setValue("ci");
      expect(t.writes).toEqual([[1, 0, 0, "ci"]]);
    });

    it("prefix naming NO sheet throws, listing the workbook's sheet names", async () => {
      const t = makeTransport();
      const wb = makeWorkbook(t);
      const intro = await wb.sheet("Intro");
      expect(() => intro!.range("Nope!A1")).toThrow(
        'No sheet named "Nope". Sheets in this workbook: "Intro", "Data", "Hidden"',
      );
      expect(t.writes).toEqual([]);
    });
  });
});

// ============================================================================
// Wave 4 (RANGE-OPS cluster): range-scoped ops delegate with THIS range's box
// ============================================================================

describe("ScriptRange range ops (Wave 4)", () => {
  it("find() forwards the box, the query and the options", async () => {
    const findInRange = vi.fn(async () => ({ matches: [{ row: 2, col: 2 }], totalCount: 1 }));
    const t: RangeTransport = { ...perCellTransport(), findInRange };
    const result = await rangeFromAddress(t, "B2:D10").find("x", { caseSensitive: true });
    expect(result.totalCount).toBe(1);
    expect(findInRange).toHaveBeenCalledWith(1, 1, 9, 3, "x", { caseSensitive: true });
  });

  it("replace() forwards the box and both texts", async () => {
    const replaceInRange = vi.fn(async () => ({ replacementCount: 4 }));
    const t: RangeTransport = { ...perCellTransport(), replaceInRange };
    const result = await rangeFromAddress(t, "A1:B2").replace("a", "b", { matchEntireCell: true });
    expect(result.replacementCount).toBe(4);
    expect(replaceInRange).toHaveBeenCalledWith(0, 0, 1, 1, "a", "b", { matchEntireCell: true });
  });

  it("removeDuplicates()/textToColumns()/specialCells() forward the box", async () => {
    const removeDuplicates = vi.fn(async () => ({ removedCount: 2 }));
    const textToColumns = vi.fn(async () => ({ rowsProcessed: 3, columnsProduced: 2, cellsWritten: 6 }));
    const specialCells = vi.fn(async () => ({ cells: [], truncated: false }));
    const t: RangeTransport = { ...perCellTransport(), removeDuplicates, textToColumns, specialCells };
    const r = rangeFromAddress(t, "A1:C5");
    await r.removeDuplicates({ columns: [1], hasHeaders: true });
    expect(removeDuplicates).toHaveBeenCalledWith(0, 0, 4, 2, { columns: [1], hasHeaders: true });
    await rangeFromAddress(t, "B1:B5").textToColumns({ delimiters: [";"] });
    expect(textToColumns).toHaveBeenCalledWith(0, 1, 4, 1, { delimiters: [";"] });
    await r.specialCells("visible");
    expect(specialCells).toHaveBeenCalledWith(0, 0, 4, 2, "visible");
  });

  it("goalSeek() targets THIS range's top-left and parses the changing cell", async () => {
    const goalSeek = vi.fn(async () => ({ converged: true, solution: 5, iterations: 3 }));
    const t: RangeTransport = { ...perCellTransport(), goalSeek };
    const result = await rangeFromAddress(t, "B10").goalSeek(250000, "B2");
    expect(result).toEqual({ converged: true, solution: 5, iterations: 3 });
    expect(goalSeek).toHaveBeenCalledWith(9, 1, 250000, 1, 1);
  });

  it("goalSeek() accepts a single-cell Range shape and refuses a block", async () => {
    const goalSeek = vi.fn(async () => ({ converged: true, solution: 1, iterations: 1 }));
    const t: RangeTransport = { ...perCellTransport(), goalSeek };
    const changing = rangeFromAddress(t, "C3");
    await rangeFromAddress(t, "A1").goalSeek(7, changing);
    expect(goalSeek).toHaveBeenCalledWith(0, 0, 7, 2, 2);
    await expect(rangeFromAddress(t, "A1").goalSeek(7, rangeFromAddress(t, "C3:D4")))
      .rejects.toThrow(/single cell/);
  });

  it("goalSeek() refuses a sheet-prefixed changing cell (pinned transport)", async () => {
    const goalSeek = vi.fn(async () => ({ converged: true, solution: 1, iterations: 1 }));
    const t: RangeTransport = { ...perCellTransport(), goalSeek };
    await expect(rangeFromAddress(t, "A1").goalSeek(7, "Data!C3")).rejects.toThrow(/another sheet/);
    expect(goalSeek).not.toHaveBeenCalled();
  });

  it("every range op THROWS honestly without its transport op", async () => {
    const r = rangeFromAddress(perCellTransport(), "A1:B2");
    await expect(r.find("x")).rejects.toThrow(/not available for this range/);
    await expect(r.replace("a", "b")).rejects.toThrow(/not available for this range/);
    await expect(r.removeDuplicates()).rejects.toThrow(/not available for this range/);
    await expect(r.textToColumns()).rejects.toThrow(/not available for this range/);
    await expect(r.specialCells("blanks")).rejects.toThrow(/not available for this range/);
    await expect(r.goalSeek(1, "B1")).rejects.toThrow(/not available for this range/);
  });

  it("a navigated range keeps the range-op transport", async () => {
    const specialCells = vi.fn(async () => ({ cells: [], truncated: false }));
    const t: RangeTransport = { ...perCellTransport(), specialCells };
    await rangeFromAddress(t, "A1:C3").offset(1, 1).resize(2, 2).specialCells("formulas");
    expect(specialCells).toHaveBeenCalledWith(1, 1, 2, 2, "formulas");
  });
});
