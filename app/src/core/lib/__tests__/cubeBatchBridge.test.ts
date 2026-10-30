//! FILENAME: app/src/core/lib/__tests__/cubeBatchBridge.test.ts
// PURPOSE: BUG-0476 -- a CUBE formula written through the BATCH door
//          (`updateCellsBatch`: @api CellRange.setValue / setValues, a script,
//          a paste, a fill) or the BACKGROUND door (`updateCellOnSheets`: the
//          same on a sheet that is not active) is served its BI-model value on
//          write, and both doors set the session's cube latch, as the grid
//          editor's `updateCell` always did.
// CONTEXT: Live 2026-10-15 (AdventureWorks connected as 'AWprobe2'):
//          updateCell(=CUBEVALUE(...)) showed 114033992,77; CellRange.setValue
//          of the same formula showed #N/A, and a later plain Calculate Now did
//          not refresh it either (workbookHasCubeFormulas() still false). Only
//          recalcWithCube() brought the value.
//          The first fix ran a FULL workbook cube recalculation after the batch
//          (cube_prefetch_all + calculate_now): under MANUAL calculation that
//          calculated everything the user had deliberately left stale and
//          announced a RECALCULATION_COMPLETED that the user never asked for --
//          and the background door only latched, so a cube cell on another
//          sheet still showed #N/A. Now each door asks `cube_prefetch` (its
//          `edits` shape) for exactly the writes in hand and hands the result
//          to the write command, which serves it -- the multi-edit twin of
//          `updateCell`. The Rust half is pinned in bi/cube.rs's tests.
//          Round 4 (revFU#2): once the session has latched, EVERY batch
//          prefetches, as the grid editor's every edit does -- a paste into a
//          cube ARGUMENT cell re-evaluates the cube cell that reads it. A
//          workbook with no CUBE formula never latches and stays one call.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import {
  calculateNow,
  resetCubeSession,
  setUdfResolveHook,
  updateCell,
  updateCellOnSheets,
  updateCellsBatch,
  workbookHasCubeFormulas,
} from "../tauri-api";
import { CellRange } from "../../../api/range";
import { AppEvents } from "../../../api/events";

const CUBE = '=CUBEVALUE("AWprobe2";"[Revenue]")';
const PREFETCH = { bindings: {}, results: { 'CUBEVALUE|"AWprobe2"|"[Revenue]"': { number: 114033992.77 } } };
const PREFETCH_SHEET_3 = { bindings: {}, results: { 'CUBEVALUE|"AWprobe2"|"[Cost]"': { number: 1 } } };

/** The commands invoked, in order. */
function commands(): string[] {
  return invokeMock.mock.calls.map((c) => c[0] as string);
}

function argsFor(command: string, nth = 0): Record<string, unknown> | undefined {
  const calls = invokeMock.mock.calls.filter((c) => c[0] === command);
  return calls[nth]?.[1] as Record<string, unknown> | undefined;
}

/** Every RECALCULATION_COMPLETED announced while the test ran. */
const recalcAnnouncements: Event[] = [];
const onRecalc = (e: Event) => recalcAnnouncements.push(e);

beforeEach(() => {
  invokeMock.mockReset();
  resetCubeSession();
  setUdfResolveHook(null);
  recalcAnnouncements.length = 0;
  window.addEventListener(AppEvents.RECALCULATION_COMPLETED, onRecalc);
  invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case "cube_prefetch":
        return args?.sheetIndex === 3 ? PREFETCH_SHEET_3 : PREFETCH;
      case "update_cells_batch":
        // The command serves the cube data it was handed.
        return [
          { row: 6, col: 3, display: args?.cubeResults ? "114033992,77" : "#N/A", formula: CUBE, styleIndex: 0 },
          { row: 0, col: 0, display: "plain", styleIndex: 0 },
        ];
      case "get_active_sheet":
        return 0;
      case "update_cell_on_sheets":
        return args?.sheetIndices ?? [];
      case "update_cell":
        return { cells: [], dimensionChanges: [], needsStyleRefresh: false, slicerChanged: false };
      default:
        return [];
    }
  });
});

afterEach(() => {
  window.removeEventListener(AppEvents.RECALCULATION_COMPLETED, onRecalc);
});

describe("the batch door serves a CUBE formula it writes", () => {
  it("prefetches exactly the batch's writes, hands the result to the batch, and recalculates nothing", async () => {
    const cells = await updateCellsBatch([
      { row: 0, col: 0, value: "plain" },
      { row: 6, col: 3, value: CUBE, invariant: false },
    ]);
    expect(commands(), "a full recalculation ran instead of a targeted prefetch").toEqual([
      "cube_prefetch",
      "update_cells_batch",
    ]);
    expect(argsFor("cube_prefetch")).toEqual({
      edits: [
        { row: 0, col: 0, value: "plain", invariant: undefined },
        { row: 6, col: 3, value: CUBE, invariant: false },
      ],
    });
    expect(argsFor("update_cells_batch")?.cubeResults, "the batch ran without the cube data").toEqual(PREFETCH);
    // The caller paints the SERVED value.
    expect(cells.find((c) => c.row === 6 && c.col === 3)?.display).toBe("114033992,77");
    // Nothing was recalculated, so nothing announces a recalculation: under
    // manual calculation the user's stale cells stay stale.
    expect(recalcAnnouncements, "a cube write announced a recalculation").toHaveLength(0);
  });

  it("sets the session latch, so a LATER plain Calculate Now prefetches cube data again", async () => {
    await updateCellsBatch([{ row: 6, col: 3, value: CUBE }]);
    expect(workbookHasCubeFormulas(), "the batch door never latched the session").toBe(true);
    invokeMock.mockClear();
    await calculateNow();
    expect(commands()).toEqual(["cube_prefetch_all", "calculate_now"]);
  });

  it("@api CellRange.setValue on the active sheet (the ledger's repro door) is served too", async () => {
    await CellRange.fromCell(6, 3, 0).setValue(CUBE);
    expect(commands()).toEqual(["get_active_sheet", "cube_prefetch", "update_cells_batch"]);
    expect(argsFor("update_cells_batch")?.cubeResults).toEqual(PREFETCH);
    expect(workbookHasCubeFormulas()).toBe(true);
  });

  it("a prefetch that fails never fails the write: the batch runs without cube data", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "cube_prefetch") throw new Error("model offline");
      if (command === "update_cells_batch") return [{ row: 6, col: 3, display: "#N/A", styleIndex: 0 }];
      return [];
    });
    const cells = await updateCellsBatch([{ row: 6, col: 3, value: CUBE }]);
    expect(commands()).toEqual(["cube_prefetch", "update_cells_batch"]);
    expect(argsFor("update_cells_batch")).not.toHaveProperty("cubeResults");
    expect(cells).toEqual([{ row: 6, col: 3, display: "#N/A", styleIndex: 0 }]);
  });
});

describe("ordinary values stay ONE IPC call", () => {
  it("a batch with no CUBE formula: one update_cells_batch, no cube data, no latch", async () => {
    await updateCellsBatch([
      { row: 0, col: 0, value: "=SUM(A2:A9)" },
      { row: 1, col: 0, value: "42" },
    ]);
    expect(commands()).toEqual(["update_cells_batch"]);
    expect(argsFor("update_cells_batch")).not.toHaveProperty("cubeResults");
    expect(workbookHasCubeFormulas()).toBe(false);
  });

  it("TEXT that mentions a cube function is not a CUBE formula", async () => {
    await updateCellsBatch([{ row: 0, col: 0, value: "CUBEVALUE(x) is how to read the model" }]);
    expect(commands()).toEqual(["update_cells_batch"]);
    expect(workbookHasCubeFormulas()).toBe(false);
  });

  it("an OBJECT's cells (a floating grid's backing sheet) take the target route, unprefetched", async () => {
    await updateCellsBatch([{ row: 0, col: 0, value: CUBE }], {
      target: { kind: "floatingRange", id: "fr-1" } as never,
    });
    expect(commands()).toEqual(["update_cells_batch"]);
  });
});

// revFU#2. This block used to pin the OPPOSITE ("even with the session
// latched, a batch of ordinary values is still one call"). That was the defect:
// a paste, a fill or a script's setValue into a cube ARGUMENT cell re-evaluates
// the cube cell that reads it in the batch's cascade, and with no cube data it
// kept the previous member's number beside the new member name. Typing the same
// value (updateCell) prefetched, because the grid editor follows the latch.
describe("once the session has a CUBE formula, every batch prefetches (as updateCell does)", () => {
  it("a latched session prefetches for a batch of ordinary values and hands the batch the result", async () => {
    await updateCellsBatch([{ row: 6, col: 3, value: CUBE }]);
    invokeMock.mockClear();
    await updateCellsBatch([{ row: 1, col: 0, value: "Region[Name]=West" }]);
    expect(commands(), "a latched batch into a cube argument cell ran without cube data").toEqual([
      "cube_prefetch",
      "update_cells_batch",
    ]);
    expect(argsFor("cube_prefetch")?.edits).toEqual([{ row: 1, col: 0, value: "Region[Name]=West" }]);
    expect(argsFor("update_cells_batch")?.cubeResults).toEqual(PREFETCH);
  });

  it("@api CellRange.setValue into a cube argument cell in a latched session is served", async () => {
    await updateCellsBatch([{ row: 6, col: 3, value: CUBE }]);
    invokeMock.mockClear();
    await CellRange.fromCell(1, 0, 0).setValue("Region[Name]=West");
    expect(commands()).toEqual(["get_active_sheet", "cube_prefetch", "update_cells_batch"]);
  });

  it("each write's styleIndex and invariant flag travel to the prefetch, so it parses as the batch stores", async () => {
    await updateCellsBatch([{ row: 0, col: 0, value: "0012", styleIndex: 7, invariant: true }, { row: 0, col: 1, value: CUBE }]);
    expect(argsFor("cube_prefetch")?.edits).toEqual([
      { row: 0, col: 0, value: "0012", styleIndex: 7, invariant: true },
      { row: 0, col: 1, value: CUBE },
    ]);
  });

  it("a PASTE's flag travels to the prefetch: a pasted CUBE formula under an @ style is a formula there too", async () => {
    // The batch keeps a pasted formula a formula in a Text-formatted cell
    // (CellUpdateInput.pasted); a prefetch that did not know would parse it as
    // text and fetch nothing for it (bi/cube.rs parse_pending_write).
    await updateCellsBatch([{ row: 0, col: 1, value: CUBE, styleIndex: 7, pasted: true }]);
    expect(argsFor("cube_prefetch")?.edits).toEqual([{ row: 0, col: 1, value: CUBE, styleIndex: 7, pasted: true }]);
  });

  it("the volatile custom-function cells the UDF pass found ride with the prefetch (batch and single edit)", async () => {
    const volatileCells = [{ row: 2, col: 2 }];
    setUdfResolveHook(async () => ({ results: {}, volatileCells }));
    await updateCellsBatch([{ row: 6, col: 3, value: CUBE }]);
    expect(argsFor("cube_prefetch")?.udfVolatileCells, "the batch's prefetch does not cover its volatile UDF cells").toEqual(
      volatileCells,
    );
    expect(argsFor("update_cells_batch")?.udfVolatileCells).toEqual(volatileCells);
    invokeMock.mockClear();
    await updateCell(4, 0, "7");
    expect(argsFor("cube_prefetch")?.udfVolatileCells, "the single edit's prefetch does not cover its volatile UDF cells").toEqual(
      volatileCells,
    );
  });

  it("the background door still makes ONE call for an ordinary value: its recalculation takes no cube data", async () => {
    await updateCellsBatch([{ row: 6, col: 3, value: CUBE }]);
    invokeMock.mockClear();
    await updateCellOnSheets([2], 1, 0, "Region[Name]=West");
    expect(commands()).toEqual(["update_cell_on_sheets"]);
  });
});

describe("the background door serves a CUBE formula it writes", () => {
  it("prefetches from THAT sheet's cells and hands the command its result", async () => {
    await updateCellOnSheets([2], 6, 3, CUBE, true);
    expect(workbookHasCubeFormulas(), "the background door never latched the session").toBe(true);
    expect(commands(), "the background door wrote a CUBE formula with no cube data").toEqual([
      "cube_prefetch",
      "update_cell_on_sheets",
    ]);
    expect(argsFor("cube_prefetch")).toEqual({
      edits: [{ row: 6, col: 3, value: CUBE, invariant: true }],
      sheetIndex: 2,
    });
    expect(argsFor("update_cell_on_sheets")?.cubeResults).toEqual([PREFETCH]);
    expect(recalcAnnouncements).toHaveLength(0);
  });

  it("a group write gets one prefetch per sheet, aligned with the sheets", async () => {
    await updateCellOnSheets([2, 3], 6, 3, CUBE);
    expect(commands()).toEqual(["cube_prefetch", "cube_prefetch", "update_cell_on_sheets"]);
    expect(argsFor("cube_prefetch", 0)?.sheetIndex).toBe(2);
    expect(argsFor("cube_prefetch", 1)?.sheetIndex).toBe(3);
    expect(argsFor("update_cell_on_sheets")?.cubeResults).toEqual([PREFETCH, PREFETCH_SHEET_3]);
  });

  it("@api CellRange.setValue on a background sheet is served too", async () => {
    await CellRange.fromCell(6, 3, 2).setValue(CUBE);
    expect(commands()).toEqual(["get_active_sheet", "cube_prefetch", "update_cell_on_sheets"]);
    expect(argsFor("update_cell_on_sheets")?.cubeResults).toEqual([PREFETCH]);
  });

  it("a failed prefetch sends no cube data (never a misaligned list) and still writes", async () => {
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "cube_prefetch" && args?.sheetIndex === 3) throw new Error("model offline");
      if (command === "cube_prefetch") return PREFETCH;
      if (command === "update_cell_on_sheets") return args?.sheetIndices ?? [];
      return [];
    });
    const wrote = await updateCellOnSheets([2, 3], 6, 3, CUBE);
    expect(wrote).toEqual([2, 3]);
    expect(argsFor("update_cell_on_sheets")).not.toHaveProperty("cubeResults");
  });

  it("control: an ordinary value written to another sheet is one call and no latch", async () => {
    await updateCellOnSheets([2], 6, 3, "=A1*2");
    expect(commands()).toEqual(["update_cell_on_sheets"]);
    expect(argsFor("update_cell_on_sheets")).not.toHaveProperty("cubeResults");
    expect(workbookHasCubeFormulas()).toBe(false);
  });
});
