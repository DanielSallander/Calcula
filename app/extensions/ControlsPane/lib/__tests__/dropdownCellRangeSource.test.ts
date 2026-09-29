//! FILENAME: app/extensions/ControlsPane/lib/__tests__/dropdownCellRangeSource.test.ts
// PURPOSE: A pane dropdown's cell-range source reads the sheet it NAMES -- and
//          nothing at all when that sheet does not exist.
// CONTEXT: X13 (wave D; wave C sheets fix-up). An unknown sheet prefix, and a
//          source the backend rewrote to `#REF!` when its sheet was deleted
//          (W10), fell back to the ACTIVE sheet: the dropdown listed whatever
//          the active sheet held in those cells, a list that looks right and
//          is not. A quoted name with a doubled apostrophe ('Bob''s') was never
//          unescaped, so it matched no sheet and took the same fall-back.
//
//          CellRange is doubled with the real one's PARSING rule (the text up
//          to the FIRST "!" is a sheet prefix; the rest must be A1 or A1:B2,
//          or it throws), so a read the loader asks for is recorded as
//          (sheet index, address) and answered with that sheet's cells.

/* eslint-disable @typescript-eslint/naming-convention --
 * The @api double must export `CellRange` under its real (PascalCase) name,
 * and the class that stands in for it is a class. */

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  /** What each sheet holds in A1:A3 -- `active` is a read with no index. */
  const cells = new Map<number | "active", string[]>([
    ["active", ["active-1", "active-2", "active-3"]],
    [1, ["data-1", "data-2", "data-3"]],
    [2, ["bob-1", "bob-2", "bob-3"]],
    [3, ["bang-1", "bang-2", "bang-3"]],
    [4, ["hash-1", "hash-2", "hash-3"]],
  ]);
  const reads: Array<{ sheetIndex: number | undefined; address: string }> = [];

  function parseCell(ref: string): { row: number; col: number } {
    const m = ref.replace(/\$/g, "").match(/^([A-Za-z]+)(\d+)$/);
    if (!m) throw new Error(`Invalid cell reference: "${ref}"`);
    let col = 0;
    for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
    return { row: parseInt(m[2], 10) - 1, col: col - 1 };
  }

  class FakeCellRange {
    constructor(
      public startRow: number,
      public startCol: number,
      public endRow: number,
      public endCol: number,
      public sheetIndex: number | undefined,
      private address: string,
    ) {}
    static fromAddress(address: string, sheetIndex?: number): FakeCellRange {
      let work = address.trim();
      const bang = work.indexOf("!");
      if (bang !== -1) work = work.substring(bang + 1);
      const parts = work.split(":");
      const a = parseCell(parts[0]);
      const b = parts.length > 1 ? parseCell(parts[1]) : a;
      return new FakeCellRange(
        Math.min(a.row, b.row),
        Math.min(a.col, b.col),
        Math.max(a.row, b.row),
        Math.max(a.col, b.col),
        sheetIndex,
        address,
      );
    }
    get rowCount(): number {
      return this.endRow - this.startRow + 1;
    }
    get colCount(): number {
      return this.endCol - this.startCol + 1;
    }
    get cellCount(): number {
      return this.rowCount * this.colCount;
    }
    resize(rows: number, cols: number): FakeCellRange {
      return new FakeCellRange(this.startRow, this.startCol, this.startRow + rows - 1, this.startCol + cols - 1, this.sheetIndex, this.address);
    }
    async getValues(): Promise<Map<string, { display: string }>> {
      reads.push({ sheetIndex: this.sheetIndex, address: this.address });
      const held = cells.get(this.sheetIndex === undefined ? "active" : this.sheetIndex) ?? [];
      const out = new Map<string, { display: string }>();
      for (let r = this.startRow; r <= this.endRow; r++) {
        const v = held[r];
        if (v !== undefined) out.set(`${r},${this.startCol}`, { display: v });
      }
      return out;
    }
  }

  /** Floating-range reads by id: (id, r0, c0, r1, c1). */
  const frReads: Array<[string, number, number, number, number]> = [];
  const frCells = new Map<string, string[]>([["fr-1", ["f1", "f2", "f3"]]]);

  return { reads, FakeCellRange, frReads, frCells };
});

vi.mock("@api", () => ({
  CellRange: h.FakeCellRange,
  getSheets: vi.fn(async () => ({
    sheets: [
      { index: 0, name: "Sheet1" },
      { index: 1, name: "Data" },
      { index: 2, name: "Bob's" },
      { index: 3, name: "Q1!x" },
      // A sheet may be CALLED "#REF". The parser's rule quotes it
      // ('#REF'!A1), so a BARE "#REF!" is only ever the error the backend
      // wrote for a deleted source -- never this sheet.
      { index: 4, name: "#REF" },
    ],
    activeIndex: 0,
  })),
  // A floating range shares the sheet namespace but is NOT in getSheets().
  listFloatingRanges: vi.fn(async () => [{ id: "fr-1", name: "Float1" }]),
  getFloatingRangeCells: vi.fn(async (id: string, r0: number, c0: number, r1: number, c1: number) => {
    h.frReads.push([id, r0, c0, r1, c1]);
    const held = h.frCells.get(id) ?? [];
    const out: Array<{ row: number; col: number; display: string }> = [];
    for (let r = r0; r <= r1; r++) if (held[r] !== undefined) out.push({ row: r, col: c0, display: held[r] });
    return out;
  }),
}));

import { loadCellRangeItems } from "../dropdownCellRangeSource";

/** The loader's result, a throw read as the card reads it (an empty list). */
async function items(reference: string): Promise<string[]> {
  try {
    return await loadCellRangeItems(reference);
  } catch {
    return [];
  }
}

beforeEach(() => {
  h.reads.length = 0;
  h.frReads.length = 0;
});

// Found live 2026-09-29 (e2e fixall-calp W7): a pane dropdown sourced from a
// floating range listed nothing -- getSheets() never lists a floating range's
// backing sheet, so the prefix named "no sheet".
describe("a source naming a FLOATING RANGE reads that range, by its id", () => {
  it("lists the range's cells, case-insensitively, and never a sheet's", async () => {
    expect(await items("float1!A1:A3")).toEqual(["f1", "f2", "f3"]);
    expect(h.frReads).toEqual([["fr-1", 0, 0, 2, 0]]);
    expect(h.reads, "a floating-range source read a SHEET").toEqual([]);
  });

  it("a name that is neither a sheet nor a floating range still lists nothing", async () => {
    expect(await items("Float9!A1:A3")).toEqual([]);
    expect(h.frReads).toEqual([]);
  });

  it("a sheet of the same name wins (a sheet is looked up first)", async () => {
    expect(await items("Data!A1:A3")).toEqual(["data-1", "data-2", "data-3"]);
    expect(h.frReads).toEqual([]);
  });
});

describe("a source naming no sheet lists NOTHING -- never the active sheet's cells", () => {
  it("an unknown sheet prefix", async () => {
    expect(await items("Nope!A1:A3"), "an unknown sheet listed the ACTIVE sheet's cells").toEqual([]);
    expect(h.reads.filter((r) => r.sheetIndex === undefined), "the active sheet was read").toEqual([]);
  });

  it("a #REF! sheet (the source's sheet was deleted)", async () => {
    expect(await items("#REF!A1:A3"), "a #REF! source listed the ACTIVE sheet's cells").toEqual([]);
    expect(h.reads).toEqual([]);
  });

  it("the whole source rewritten to #REF! (W10)", async () => {
    expect(await items("#REF!")).toEqual([]);
    expect(h.reads).toEqual([]);
  });

  it("a #REF! in the address part", async () => {
    expect(await items("Data!#REF!")).toEqual([]);
    expect(h.reads).toEqual([]);
  });

  it("a bare #REF! never resurrects a deleted source onto a sheet that happens to be CALLED #REF", async () => {
    expect(await items("#REF!A1:A3"), "the deleted source read the sheet named #REF").toEqual([]);
    expect(h.reads).toEqual([]);
    // ...while the parser's own spelling of that sheet still reads it.
    expect(await items("'#REF'!A1:A2")).toEqual(["hash-1", "hash-2"]);
  });
});

describe("a source naming a sheet reads THAT sheet", () => {
  it("a bare name, case-insensitively", async () => {
    expect(await items("data!A1:A3")).toEqual(["data-1", "data-2", "data-3"]);
    expect(h.reads.map((r) => r.sheetIndex)).toEqual([1]);
  });

  it("a quoted name with a doubled apostrophe ('Bob''s')", async () => {
    expect(await items("'Bob''s'!A1:A3"), "'' was not unescaped, so the name matched no sheet").toEqual([
      "bob-1",
      "bob-2",
      "bob-3",
    ]);
    expect(h.reads.map((r) => r.sheetIndex)).toEqual([2]);
  });

  it("a quoted name that itself contains '!'", async () => {
    expect(await items("'Q1!x'!A1:A2")).toEqual(["bang-1", "bang-2"]);
    expect(h.reads.map((r) => r.sheetIndex)).toEqual([3]);
  });

  it("no prefix: the active sheet, as documented", async () => {
    expect(await items("A1:A3")).toEqual(["active-1", "active-2", "active-3"]);
    expect(h.reads.map((r) => r.sheetIndex)).toEqual([undefined]);
  });
});
