//! FILENAME: app/src/core/hooks/__tests__/copyCellRange.test.ts
// PURPOSE: `copyCellRange` -- the COPY primitive Core's own Copy runs, hoisted
//          out of the useClipboard hook so an object whose cells live in the
//          active sheet's grid (a canvas pivot box's hidden grid) can copy ITS
//          selected cells the way Copy copies cells.
// CONTEXT: WP-A S7a (canvas owner findings 2026-10-15, F4: copy a range of a
//          canvas pivot's cells). What is pinned here:
//            - it fills the internal clipboard (source sheet = the ACTIVE sheet,
//              read from the grid state snapshot) and the system clipboard;
//            - it never dispatches setClipboard (the marching ants are Core's
//              selection's, and the hook adds them itself);
//            - `skipRows` collapses rows as a filtered copy does;
//            - the cap (default and `maxCells`) refuses as "tooLarge" and leaves
//              the previous clipboard alone; every row skipped is "empty"; a
//              read that throws is "failed" -- answered, never console-only;
//            - `batchRead` reads in `getViewportCells` rectangles of at most
//              10,000 cells, ZERO `getCell` calls, and fills the SAME internal
//              clipboard the per-cell path does for the same cells (gaps,
//              comments and validations included).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/** The sheet the mocked backend serves: "row,col" -> cell. A missing key is an EMPTY cell. */
const model = vi.hoisted(() => ({
  cells: new Map<string, { row: number; col: number; display: string; formula: string | null; styleIndex: number }>(),
  comments: [] as Array<{ id: string; row: number; col: number; sheetIndex: number; content: string }>,
  validations: [] as Array<{ startRow: number; startCol: number; endRow: number; endCol: number; validation: unknown }>,
  failViewport: false,
}));

const sys = vi.hoisted(() => ({ written: [] as string[] }));

const grid = vi.hoisted(() => ({
  snapshot: { sheetContext: { activeSheetIndex: 2, activeSheetName: "Canvas1" } } as unknown,
}));

const api = vi.hoisted(() => ({
  getCell: vi.fn(async (row: number, col: number) => model.cells.get(`${row},${col}`) ?? null),
  getViewportCells: vi.fn(async (r0: number, c0: number, r1: number, c1: number) => {
    if (model.failViewport) throw new Error("backend gone");
    const out: unknown[] = [];
    for (const cell of model.cells.values()) {
      if (cell.row >= r0 && cell.row <= r1 && cell.col >= c0 && cell.col <= c1) out.push(cell);
    }
    return out;
  }),
  getComment: vi.fn(async (row: number, col: number) => model.comments.find((c) => c.row === row && c.col === col) ?? null),
  getAllComments: vi.fn(async () => model.comments),
  getDataValidation: vi.fn(async (row: number, col: number) => {
    const hit = model.validations.find(
      (v) => row >= v.startRow && row <= v.endRow && col >= v.startCol && col <= v.endCol,
    );
    return hit ? hit.validation : null;
  }),
  getAllDataValidations: vi.fn(async () => model.validations),
  getCollectionTexts: vi.fn(async (coords: [number, number][]) => coords.map(() => "")),
}));

vi.mock("../../lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCell: (r: number, c: number) => api.getCell(r, c),
  getViewportCells: (r0: number, c0: number, r1: number, c1: number) => api.getViewportCells(r0, c0, r1, c1),
  getComment: (r: number, c: number) => api.getComment(r, c),
  getAllComments: () => api.getAllComments(),
  getDataValidation: (r: number, c: number) => api.getDataValidation(r, c),
  getAllDataValidations: () => api.getAllDataValidations(),
  getCollectionTexts: (coords: [number, number][]) => api.getCollectionTexts(coords),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: vi.fn(async () => null),
  writeText: vi.fn(async (t: string) => {
    sys.written.push(t);
  }),
  writeHtml: vi.fn(async (_html: string, t: string) => {
    sys.written.push(t);
  }),
}));

vi.mock("../../lib/dialogs", () => ({
  alertAsync: vi.fn(async () => {}),
  confirmAsync: vi.fn(async () => true),
}));

vi.mock("../../state/GridContext", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGridStateSnapshot: () => grid.snapshot,
}));

const actions = vi.hoisted(() => ({ setClipboard: vi.fn() }));
vi.mock("../../state/gridActions", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    setClipboard: (...args: unknown[]) => {
      actions.setClipboard(...args);
      return (real.setClipboard as (...a: unknown[]) => unknown)(...args);
    },
  };
});

import { copyCellRange, getInternalClipboard, type ClipboardData } from "../useClipboard";

function cell(row: number, col: number, styleIndex = 4) {
  return { row, col, display: `r${row}c${col}`, formula: null, styleIndex };
}

/** Fill a rectangle; a cell whose (row + col) is a multiple of `gapEvery` is left EMPTY. */
function fill(r0: number, c0: number, r1: number, c1: number, gapEvery = 0): void {
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (gapEvery > 0 && (r + c) % gapEvery === 0) continue;
      model.cells.set(`${r},${c}`, cell(r, c, (r * 7 + c) % 5));
    }
  }
}

/** Every viewport read's area, in cells. */
function viewportAreas(): number[] {
  return api.getViewportCells.mock.calls.map(([r0, c0, r1, c1]) => (r1 - r0 + 1) * (c1 - c0 + 1));
}

/** Put a known clipboard in place, so a refusal can be shown to leave it alone. */
async function seedClipboard(): Promise<ClipboardData> {
  model.cells.set("100,100", cell(100, 100));
  const seeded = await copyCellRange({ startRow: 100, startCol: 100, endRow: 100, endCol: 100 });
  expect(seeded).toEqual({ copied: true, rows: 1, cols: 1 });
  return getInternalClipboard()!;
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  model.cells.clear();
  model.comments = [];
  model.validations = [];
  model.failViewport = false;
  sys.written = [];
  grid.snapshot = { sheetContext: { activeSheetIndex: 2, activeSheetName: "Canvas1" } };
  for (const fn of Object.values(api)) fn.mockClear();
  actions.setClipboard.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("copyCellRange fills the clipboards -- and nothing of Core's selection", () => {
  it("the internal clipboard names the ACTIVE sheet (from the grid state snapshot) and holds the cells", async () => {
    fill(3, 1, 4, 2);
    const result = await copyCellRange({ startRow: 3, startCol: 1, endRow: 4, endCol: 2 });
    expect(result).toEqual({ copied: true, rows: 2, cols: 2 });

    const clip = getInternalClipboard();
    expect(clip, "nothing was put on the internal clipboard").not.toBeNull();
    expect(clip!.sourceSheetIndex).toBe(2);
    expect(clip!.sourceSheetName).toBe("Canvas1");
    expect(clip!.isCut).toBe(false);
    expect(clip!.sourceSelection).toEqual({ startRow: 3, startCol: 1, endRow: 4, endCol: 2, type: "cells" });
    expect(clip!.sourceRows).toEqual([3, 4]);
    expect(clip!.cells.map((row) => row.map((c) => c?.display ?? null))).toEqual([
      ["r3c1", "r3c2"],
      ["r4c1", "r4c2"],
    ]);
    expect(clip!.text).toBe("r3c1\tr3c2\nr4c1\tr4c2");
    expect(sys.written.at(-1), "the system clipboard was not written").toBe("r3c1\tr3c2\nr4c1\tr4c2");
  });

  it("never dispatches setClipboard (the marching ants belong to Core's selection)", async () => {
    fill(0, 0, 1, 1);
    await copyCellRange({ startRow: 0, startCol: 0, endRow: 1, endCol: 1 });
    expect(actions.setClipboard).not.toHaveBeenCalled();
  });

  it("a reversed rectangle copies the same cells (anchor below / right of the active end)", async () => {
    fill(0, 0, 1, 1);
    const result = await copyCellRange({ startRow: 1, startCol: 1, endRow: 0, endCol: 0 });
    expect(result).toEqual({ copied: true, rows: 2, cols: 2 });
    expect(getInternalClipboard()!.text).toBe("r0c0\tr0c1\nr1c0\tr1c1");
  });

  it("skipRows collapses the copy: the rows left out slide together, sourceRows keeps where each came from", async () => {
    fill(0, 0, 4, 1);
    const result = await copyCellRange({ startRow: 0, startCol: 0, endRow: 4, endCol: 1, skipRows: new Set([1, 3]) });
    expect(result).toEqual({ copied: true, rows: 3, cols: 2 });
    const clip = getInternalClipboard()!;
    expect(clip.sourceRows).toEqual([0, 2, 4]);
    expect(clip.cells.map((row) => row[0]?.display)).toEqual(["r0c0", "r2c0", "r4c0"]);
    expect(api.getCell.mock.calls.some(([r]) => r === 1 || r === 3), "a skipped row was read").toBe(false);
  });
});

describe("refusals answer WHY and leave the previous clipboard alone", () => {
  it("over the default cap (5,000,000 cells): tooLarge, no cell read", async () => {
    const before = await seedClipboard();
    api.getCell.mockClear();
    const result = await copyCellRange({ startRow: 0, startCol: 0, endRow: 2999, endCol: 1999 });
    expect(result).toEqual({ copied: false, reason: "tooLarge" });
    expect(api.getCell).not.toHaveBeenCalled();
    expect(getInternalClipboard()).toBe(before);
  });

  it("over a maxCells override: tooLarge (the cap counts the rows actually copied)", async () => {
    fill(0, 0, 9, 9);
    const before = await seedClipboard();
    expect(await copyCellRange({ startRow: 0, startCol: 0, endRow: 9, endCol: 9, maxCells: 50 })).toEqual({
      copied: false,
      reason: "tooLarge",
    });
    expect(getInternalClipboard()).toBe(before);
    // Half the rows skipped: 5 x 10 = 50 cells, inside the same cap.
    const skip = new Set([1, 3, 5, 7, 9]);
    expect(await copyCellRange({ startRow: 0, startCol: 0, endRow: 9, endCol: 9, maxCells: 50, skipRows: skip })).toEqual({
      copied: true,
      rows: 5,
      cols: 10,
    });
  });

  it("every row skipped: empty", async () => {
    fill(0, 0, 1, 1);
    const before = await seedClipboard();
    const result = await copyCellRange({ startRow: 0, startCol: 0, endRow: 1, endCol: 1, skipRows: new Set([0, 1]) });
    expect(result).toEqual({ copied: false, reason: "empty" });
    expect(getInternalClipboard()).toBe(before);
  });

  it("a batched read that throws: failed (the caller toasts), the clipboard untouched", async () => {
    fill(0, 0, 3, 3);
    const before = await seedClipboard();
    model.failViewport = true;
    const result = await copyCellRange({ startRow: 0, startCol: 0, endRow: 3, endCol: 3, batchRead: true });
    expect(result).toEqual({ copied: false, reason: "failed" });
    expect(getInternalClipboard()).toBe(before);
  });
});

describe("batchRead: rectangles of at most 10,000 cells, never one IPC per cell", () => {
  it("a 30 x 400 rectangle: at most 2 getViewportCells calls and ZERO getCell calls", async () => {
    fill(0, 0, 29, 399, 3);
    const result = await copyCellRange({ startRow: 0, startCol: 0, endRow: 29, endCol: 399, batchRead: true });
    expect(result).toEqual({ copied: true, rows: 30, cols: 400 });
    expect(api.getViewportCells.mock.calls.length).toBeGreaterThan(0);
    expect(api.getViewportCells.mock.calls.length).toBeLessThanOrEqual(2);
    expect(api.getCell).not.toHaveBeenCalled();
    expect(api.getComment, "comments must be read in one call, not per cell").not.toHaveBeenCalled();
    expect(api.getDataValidation, "validations must be read in one call, not per cell").not.toHaveBeenCalled();
    for (const area of viewportAreas()) expect(area).toBeLessThanOrEqual(10_000);
  });

  it("fills the SAME internal clipboard as the per-cell path for the same cells (gaps, comments, validations)", async () => {
    fill(0, 0, 29, 399, 3);
    model.comments = [
      { id: "c1", row: 2, col: 5, sheetIndex: 2, content: "inside" },
      { id: "c2", row: 50, col: 5, sheetIndex: 2, content: "outside" },
      { id: "c3", row: 4, col: 7, sheetIndex: 2, content: "on a skipped row" },
    ];
    model.validations = [
      { startRow: 0, startCol: 0, endRow: 1, endCol: 1, validation: { rule: "first" } },
      { startRow: 1, startCol: 1, endRow: 2, endCol: 2, validation: { rule: "second" } },
    ];
    const req = { startRow: 0, startCol: 0, endRow: 29, endCol: 399, skipRows: new Set([4, 17]) };

    expect(await copyCellRange(req)).toEqual({ copied: true, rows: 28, cols: 400 });
    const perCell = getInternalClipboard()!;
    expect(api.getViewportCells).not.toHaveBeenCalled();

    expect(await copyCellRange({ ...req, batchRead: true })).toEqual({ copied: true, rows: 28, cols: 400 });
    const batched = getInternalClipboard()!;
    expect(batched).not.toBe(perCell);

    expect(batched.cells).toEqual(perCell.cells);
    expect(batched.sourceRows).toEqual(perCell.sourceRows);
    expect(batched.text).toBe(perCell.text);
    expect(batched.sourceSelection).toEqual(perCell.sourceSelection);
    expect(batched.comments).toEqual(perCell.comments);
    expect(batched.validations).toEqual(perCell.validations);
    // The fixture has gaps, a comment and an OVERLAP where the first range wins.
    expect(perCell.cells[0][0], "the fixture has no gap at (0,0)").toBeNull();
    expect(perCell.comments?.get("2,5")?.content).toBe("inside");
    expect(perCell.validations?.get("1,1")).toEqual({ rule: "first" });
    expect(perCell.validations?.get("2,2")).toEqual({ rule: "second" });
  });

  it("a rectangle wider than 10,000 columns is read in column bands, each read <= 10,000 cells", async () => {
    model.cells.set("0,0", cell(0, 0));
    model.cells.set("1,14999", cell(1, 14999));
    const result = await copyCellRange({ startRow: 0, startCol: 0, endRow: 1, endCol: 14999, batchRead: true });
    expect(result).toEqual({ copied: true, rows: 2, cols: 15000 });
    for (const area of viewportAreas()) expect(area).toBeLessThanOrEqual(10_000);
    const clip = getInternalClipboard()!;
    expect(clip.cells[0][0]?.display).toBe("r0c0");
    expect(clip.cells[1][14999]?.display).toBe("r1c14999");
    expect(api.getCell).not.toHaveBeenCalled();
  });

  it("a long run of skipped rows is not read: the reads stop at the gap and resume after it", async () => {
    fill(0, 0, 99, 199);
    const skip = new Set<number>();
    for (let r = 10; r <= 89; r++) skip.add(r);
    const result = await copyCellRange({ startRow: 0, startCol: 0, endRow: 99, endCol: 199, batchRead: true, skipRows: skip });
    expect(result).toEqual({ copied: true, rows: 20, cols: 200 });
    expect(api.getViewportCells.mock.calls.map(([r0, , r1]) => [r0, r1])).toEqual([
      [0, 9],
      [90, 99],
    ]);
    expect(getInternalClipboard()!.sourceRows).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99]);
  });

  it("the cap is checked BEFORE any read: tooLarge with zero getViewportCells calls", async () => {
    const result = await copyCellRange({
      startRow: 0,
      startCol: 0,
      endRow: 999,
      endCol: 999,
      batchRead: true,
      maxCells: 200_000,
    });
    expect(result).toEqual({ copied: false, reason: "tooLarge" });
    expect(api.getViewportCells).not.toHaveBeenCalled();
    expect(api.getCell).not.toHaveBeenCalled();
  });
});
