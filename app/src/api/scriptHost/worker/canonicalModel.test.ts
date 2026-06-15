//! FILENAME: app/src/api/scriptHost/worker/canonicalModel.test.ts
// PURPOSE: Tests for the worker-realm canonical Range facet (C3 step 3) — A1
//          parsing/formatting, navigation, and that data ops fan out to the
//          injected read/write functions (which the shim wires to broker
//          aspects) with the right coordinates and clamping.

import { describe, it, expect, vi } from "vitest";
import {
  makeRange,
  rangeFromAddress,
  parseA1,
  makeWorkbook,
  type WorkbookTransport,
} from "./canonicalModel";

const box = (sr: number, sc: number, er: number, ec: number) => ({
  startRow: sr,
  startCol: sc,
  endRow: er,
  endCol: ec,
});
const noWrite = vi.fn(async () => {});
const noRead = vi.fn(async () => "");

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
  it("ignores a sheet name prefix (range is bound to the context sheet)", () => {
    expect(parseA1("Other!A1:B2")).toEqual(box(0, 0, 1, 1));
  });
  it("handles multi-letter columns", () => {
    expect(parseA1("AA1")).toEqual(box(0, 26, 0, 26));
  });
  it("throws on a malformed ref", () => {
    expect(() => parseA1("notacell")).toThrow(/Invalid cell reference/);
  });
});

describe("ScriptRange geometry + navigation", () => {
  it("reports address, counts, single-cell", () => {
    const r = rangeFromAddress(noRead, noWrite, "B2:D5");
    expect(r.address).toBe("B2:D5");
    expect(r.rowCount).toBe(4);
    expect(r.colCount).toBe(3);
    expect(r.isSingleCell).toBe(false);
    const single = rangeFromAddress(noRead, noWrite, "B2");
    expect(single.isSingleCell).toBe(true);
    expect(single.address).toBe("B2");
  });

  it("offset/resize/getCell return new ranges", () => {
    const r = rangeFromAddress(noRead, noWrite, "B2:C3");
    expect(r.offset(1, 1).address).toBe("C3:D4");
    expect(r.resize(1, 1).address).toBe("B2");
    expect(r.getCell(0, 0).address).toBe("B2");
    expect(r.getCell(1, 1).address).toBe("C3");
  });

  it("getCell out of range throws", () => {
    const r = rangeFromAddress(noRead, noWrite, "B2:C3");
    expect(() => r.getCell(5, 5)).toThrow(/outside range/);
  });
});

describe("ScriptRange data ops fan out to read/write", () => {
  it("getValue reads the top-left cell", async () => {
    const read = vi.fn(async (r: number, c: number) => `v${r},${c}`);
    const r = rangeFromAddress(read, noWrite, "C2:D3"); // top-left (1,2)
    expect(await r.getValue()).toBe("v1,2");
    expect(read).toHaveBeenCalledWith(1, 2);
  });

  it("getValues reads every cell as a grid of display strings", async () => {
    const read = vi.fn(async (r: number, c: number) => `${r}:${c}`);
    const r = rangeFromAddress(read, noWrite, "A1:B2");
    expect(await r.getValues()).toEqual([
      ["0:0", "0:1"],
      ["1:0", "1:1"],
    ]);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("setValue writes the top-left cell", async () => {
    const write = vi.fn(async () => {});
    const r = makeRange(noRead, write, box(2, 1, 4, 3));
    await r.setValue("x");
    expect(write).toHaveBeenCalledWith(2, 1, "x");
  });

  it("setValues writes each cell, clamped to range dimensions", async () => {
    const write = vi.fn(async () => {});
    const r = rangeFromAddress(noRead, write, "A1:B2");
    // 3x3 input into a 2x2 range -> only the top-left 2x2 is written
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
});

describe("Workbook navigation (unlocked, cross-sheet)", () => {
  const makeTransport = (): WorkbookTransport & {
    reads: [number, number, number][];
    writes: [number, number, number, string][];
  } => {
    const reads: [number, number, number][] = [];
    const writes: [number, number, number, string][] = [];
    return {
      reads,
      writes,
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

  it("a navigated sheet's range reads/writes THAT sheet's index", async () => {
    const t = makeTransport();
    const wb = makeWorkbook(t);
    const hidden = await wb.sheet("Hidden"); // index 2
    await hidden!.range("A1:B1").setValues([["x", "y"]]);
    await hidden!.cell(5, 0).getValue();
    expect(t.writes).toEqual([
      [2, 0, 0, "x"],
      [2, 0, 1, "y"],
    ]);
    expect(t.reads).toEqual([[2, 5, 0]]);
  });

  it("activate() switches to that sheet", async () => {
    const t = makeTransport();
    const wb = makeWorkbook(t);
    const s = await wb.sheet(2);
    await s!.activate();
    expect(t.setActiveSheet).toHaveBeenCalledWith(2);
  });
});
