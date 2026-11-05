//! FILENAME: app/extensions/BuiltIn/PasteSpecial/__tests__/pasteSpecialNamesSource.test.ts
// PURPOSE: BUG-0657's remainder -- every Paste Special door pastes what its
//          SOURCE holds at the write, not the settled snapshot: each content
//          write names its source cell (`CellUpdateInput.source`, `valuesOnly`
//          for the values attributes) and the backend reads it under the
//          batch's own guards.
// CONTEXT: Round D, lane pastec. Plain Paste, Cut + Paste and the drag moves
//          named their sources in round C (useClipboard.ts `pasteSourceOf`);
//          Paste Values / Formulas / All / No Borders / the number-format
//          variants still wrote the snapshot, which a writer that never stops
//          (an animation, a fast scheduled job) had already outrun. Excel
//          pastes what the source holds at the paste [LIVE, round 19,
//          misc19/probe3.ps1: A1 = B1*2 copied, B1 := 5, Paste Values -> 10].
//          The backend has no rule for an operation, a transposed shift or a
//          skipped blank, so those keep the snapshot.
//
//          THE WRITER here is continuous: every backend call the paste makes
//          moves the source on by one, so whatever the frontend read is stale
//          by the time the batch lands. The fake batch resolves a named source
//          against the LIVE cells at the write, exactly as
//          `resolve_paste_sources` does; an unnamed write lands its `value`.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  /** The source sheet's live cells, "row,col" -> number; the writer moves A1 (0,0) on. */
  live: new Map<string, number>(),
  /** What each destination holds after the batch: "row,col" -> value. */
  landed: new Map<string, string>(),
  batches: [] as Array<{ updates: Array<Record<string, unknown>>; target: unknown; a1AtWrite: number }>,
  stands: vi.fn(),
  sheets: vi.fn(),
  alert: vi.fn(),
}));

/** The continuous writer: one tick per backend call. */
function tick(): void {
  h.live.set("0,0", (h.live.get("0,0") ?? 0) + 1);
}

vi.mock("@api/state", () => ({
  getGridStateSnapshot: () => ({
    selection: { startRow: 2, startCol: 5, endRow: 2, endCol: 5, type: "cells" },
    config: { totalRows: 1000, totalCols: 100 },
    sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" },
  }),
}));
vi.mock("@api/lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/lib")>()),
  clipboardSourceStandsAt: (...a: unknown[]) => h.stands(...a),
  getCell: vi.fn(async () => null),
  getStyle: vi.fn(async () => { tick(); return { numberFormat: "General" }; }),
  updateCell: vi.fn(async () => ({ cells: [] })),
  setCellStyle: vi.fn(async () => { tick(); return null; }),
  setCellStyles: vi.fn(async () => { tick(); return null; }),
  applyFormatting: vi.fn(async () => { tick(); return { cells: [], styles: [] }; }),
  updateCellsBatch: vi.fn(async (updates: Array<Record<string, unknown>>, opts?: { target?: unknown }) => {
    tick();
    h.batches.push({ updates: updates.map((u) => ({ ...u })), target: opts?.target, a1AtWrite: h.live.get("0,0") ?? 0 });
    for (const u of updates) {
      const from = u.source as { row: number; col: number } | undefined;
      // `resolve_paste_sources`: a named source is read NOW; else `value`.
      const value = from ? String(h.live.get(`${from.row},${from.col}`) ?? "") : String(u.value);
      h.landed.set(`${u.row},${u.col}`, value);
    }
    return [];
  }),
  getRangeCellsTyped: vi.fn(async () => { tick(); return []; }),
  getSheets: (...a: unknown[]) => { tick(); return h.sheets(...a); },
  shiftFormulasBatch: vi.fn(async (inputs: Array<{ formula: string }>) => { tick(); return inputs.map((i) => i.formula); }),
  beginUndoTransaction: vi.fn(async () => { tick(); return 5; }),
  commitUndoTransaction: vi.fn(async () => undefined),
  cancelUndoTransaction: vi.fn(async () => undefined),
  getSpillRanges: vi.fn(async () => { tick(); return []; }),
  getMergedRegions: vi.fn(async () => { tick(); return []; }),
  isSheetProtected: vi.fn(async () => { tick(); return false; }),
}));
vi.mock("@api/cellTarget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/cellTarget")>()),
  getCellTargetCellsTyped: vi.fn(async () => []),
  getCellTargetCells: vi.fn(async () => ({ cells: [], merges: [], conditional: [], styles: [], rules: [] })),
}));
vi.mock("@api/floatingRangeSpills", () => ({ getFloatingRangeSpillRanges: vi.fn(async () => []) }));
vi.mock("@api/cellClipboard", () => ({ internalClipboardIsCurrent: vi.fn(async () => true) }));
vi.mock("@api/dialogs", () => ({ alertAsync: (...a: unknown[]) => h.alert(...a) }));

import { executePasteSpecial } from "../pasteSpecialExecute";
import type { PasteAttribute, PasteOperation } from "../types";

const REF = { kind: "floatingRange" as const, id: "fr-1" };
/** The destination F3. */
const F3 = { startRow: 2, startCol: 5, endRow: 2, endCol: 5, type: "cells" } as never;

/** A copy of A1 (sheet 0) as the settle last read it: the number `seen`. */
function copyOfA1(seen: number, formula: string | null = null): never {
  return {
    cells: [[{ row: 0, col: 0, display: String(seen), formula, styleIndex: 3 }]],
    values: [[{ type: "number", value: seen }]],
    sourceSelection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" },
    sourceRows: [0],
    isCut: false,
    sourceSheetIndex: 0,
    sourceSheetName: "Sheet1",
    sourceSheetId: "sheet-a",
    text: String(seen),
  } as never;
}

async function paste(
  clipboard: never,
  pasteAttribute: PasteAttribute,
  extra: { operation?: PasteOperation; transpose?: boolean; skipBlanks?: boolean; target?: typeof REF } = {},
): Promise<boolean> {
  return executePasteSpecial(
    clipboard,
    F3,
    {
      pasteAttribute,
      operation: extra.operation ?? "none",
      skipBlanks: extra.skipBlanks ?? false,
      transpose: extra.transpose ?? false,
    },
    extra.target ? 10 : 1000,
    extra.target ? 10 : 100,
    "Paste Special",
    extra.target,
  );
}

/** The one content write the paste sent for F3. */
function writeAtF3(): Record<string, unknown> {
  const all = h.batches.flatMap((b) => b.updates).filter((u) => u.row === 2 && u.col === 5);
  expect(all, "the paste sent no content write for F3").toHaveLength(1);
  return all[0];
}

beforeEach(() => {
  h.live.clear();
  h.landed.clear();
  h.batches.length = 0;
  h.stands.mockReset();
  h.stands.mockReturnValue(true);
  h.sheets.mockReset();
  h.sheets.mockResolvedValue({ sheets: [{ index: 0, name: "Sheet1", sheetId: "sheet-a" }], activeIndex: 0 });
  h.alert.mockReset();
  h.alert.mockResolvedValue(undefined);
  h.live.set("0,0", 100);
});

describe("Paste Special names its source, so a continuously written source pastes what it holds at the write", () => {
  // SABOTAGE (pastec-ts1): `pasteSourcePlan` always answers null -> F3 lands
  // the settled 100, while A1 holds more by the write.
  it.each<PasteAttribute>(["values", "valuesAndNumberFormats", "valuesAndSourceFormatting"])(
    "%s: the source named valuesOnly, and F3 lands A1's value AT THE WRITE",
    async (attribute) => {
      expect(await paste(copyOfA1(100), attribute)).toBe(true);
      const write = writeAtF3();
      expect(write.source).toEqual({ sheetIndex: 0, row: 0, col: 0, valuesOnly: true });
      // The writer moved A1 on during the paste's own calls; F3 is what it held
      // when the batch landed, never the 100 the settle read.
      const atWrite = h.batches[0].a1AtWrite;
      expect(atWrite).toBeGreaterThan(100);
      expect(h.landed.get("2,5")).toBe(String(atWrite));
    },
  );

  it.each<PasteAttribute>(["formulas", "all", "allExceptBorders", "formulasAndNumberFormats"])(
    "%s: the source named for its formula (shifted by the backend), not valuesOnly",
    async (attribute) => {
      expect(await paste(copyOfA1(100, "=B1*2"), attribute)).toBe(true);
      expect(writeAtF3().source).toEqual({ sheetIndex: 0, row: 0, col: 0 });
    },
  );

  it("the source sheet is found by its stable id: renamed and moved to index 2, the write names index 2", async () => {
    h.sheets.mockResolvedValue({
      sheets: [
        { index: 0, name: "New", sheetId: "sheet-n" },
        { index: 1, name: "Other", sheetId: "sheet-o" },
        { index: 2, name: "Renamed", sheetId: "sheet-a" },
      ],
      activeIndex: 0,
    });
    await paste(copyOfA1(100), "values");
    expect(writeAtF3().source).toEqual({ sheetIndex: 2, row: 0, col: 0, valuesOnly: true });
  });

  it("onto a floating grid's cells: the targeted batch names the source too", async () => {
    await paste(copyOfA1(100), "values", { target: REF });
    expect(h.batches).toHaveLength(1);
    expect(h.batches[0].target).toEqual(REF);
    expect(writeAtF3().source).toEqual({ sheetIndex: 0, row: 0, col: 0, valuesOnly: true });
    expect(h.landed.get("2,5")).toBe(String(h.batches[0].a1AtWrite));
  });
});

describe("where the backend has no rule, the snapshot is pasted (no source named)", () => {
  it("an operation (Values + Add), Transpose and Skip Blanks keep the snapshot", async () => {
    await paste(copyOfA1(100), "values", { operation: "add" });
    await paste(copyOfA1(100), "values", { transpose: true });
    await paste(copyOfA1(100), "values", { skipBlanks: true });
    const writes = h.batches.flatMap((b) => b.updates);
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) expect(w.source, JSON.stringify(w)).toBeUndefined();
  });

  it("a copy that no longer stands where it was copied (followed a shift, positions lost, mode ended)", async () => {
    h.stands.mockReturnValue(false);
    await paste(copyOfA1(100), "values");
    expect(writeAtF3().source).toBeUndefined();
    expect(h.landed.get("2,5")).toBe("100");
  });

  // SABOTAGE (pastec-ts2): `keepSourcesOnlyWhereTheyStand` returns at once ->
  // the write still names A1, whose copy followed a shift to other cells.
  it("a copy that FOLLOWED a shift while the paste was being prepared: its writes name no source", async () => {
    // Standing when the paste planned its writes; moved by the time it sends them.
    h.stands.mockReturnValueOnce(true).mockReturnValue(false);
    await paste(copyOfA1(100), "values");
    expect(writeAtF3().source).toBeUndefined();
  });

  it("a source sheet that was deleted since the copy", async () => {
    h.sheets.mockResolvedValue({ sheets: [{ index: 0, name: "Other", sheetId: "sheet-o" }], activeIndex: 0 });
    await paste(copyOfA1(100), "values");
    expect(writeAtF3().source).toBeUndefined();
  });
});
