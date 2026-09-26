//! FILENAME: app/extensions/Pivot/lib/__tests__/canvasPivotCreate.test.ts
// PURPOSE: The canvas rules of the Create PivotTable dialog, as pure functions:
//          which placements are accepted, the default frame, how the typed
//          source resolves (never onto a canvas, never without a sheet), and
//          which worksheet the default source comes from.

import { describe, it, expect, vi, beforeEach } from "vitest";

let surface: Record<string, unknown> | null = null;
vi.mock("@api/layoutSurface", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/layoutSurface")>()),
  getLayoutSurface: () => surface,
}));
vi.mock("@api", () => ({
  indexToCol: (i: number) => {
    let s = "";
    let n = i;
    while (n >= 0) {
      s = String.fromCharCode(65 + (n % 26)) + s;
      n = Math.floor(n / 26) - 1;
    }
    return s;
  },
}));

import {
  CANVAS_SOURCE_EMPTY_MESSAGE,
  CANVAS_SOURCE_NEEDS_SHEET_MESSAGE,
  CANVAS_SOURCE_RANGE_FORMAT_MESSAGE,
  canvasFrameOf,
  canvasSourceIsCanvasMessage,
  defaultCanvasPivotPlacement,
  findDefaultCanvasSource,
  qualifySourceRange,
  readCanvasPivotPlacement,
  resolveCanvasPivotSource,
  unknownSourceSheetMessage,
  unknownSourceTableMessage,
  type CanvasSourceRegion,
} from "../canvasPivotCreate";

const SHEETS = [
  { index: 0, name: "Sheet1", kind: "worksheet", visibility: "visible" },
  { index: 1, name: "It's Data", visibility: "visible" },
  { index: 2, name: "Report", kind: "canvas", visibility: "visible" },
  { index: 3, name: "Hidden", kind: "worksheet", visibility: "hidden" },
];
const noTable = async () => null;

beforeEach(() => {
  surface = { snapToGrid: true, gridSize: 16, showGrid: true, page: { width: 1280, height: 720 }, editable: true };
});

describe("readCanvasPivotPlacement", () => {
  it("accepts a complete finite rectangle on a whole sheet index", () => {
    expect(readCanvasPivotPlacement({ sheetIndex: 2, x: 0, y: 16, width: 480, height: 320 })).toEqual({
      sheetIndex: 2,
      x: 0,
      y: 16,
      width: 480,
      height: 320,
    });
  });

  it("ignores partial, non-finite, empty-area and fractional-sheet rectangles", () => {
    for (const raw of [
      undefined,
      null,
      "x",
      { x: 0, y: 0, width: 10, height: 10 },
      { sheetIndex: 1, x: NaN, y: 0, width: 10, height: 10 },
      { sheetIndex: 1, x: 0, y: 0, width: 0, height: 10 },
      { sheetIndex: 1.5, x: 0, y: 0, width: 10, height: 10 },
      { sheetIndex: -1, x: 0, y: 0, width: 10, height: 10 },
    ]) {
      expect(readCanvasPivotPlacement(raw)).toBeNull();
    }
  });
});

describe("the default frame and the wire frame", () => {
  const VIEW = { sheetIndex: 2, scrollX: 0, scrollY: 0, viewWidth: 1000, viewHeight: 600 };

  it("is centred in the view and snapped", () => {
    expect(defaultCanvasPivotPlacement(VIEW)).toEqual({ sheetIndex: 2, x: 256, y: 144, width: 480, height: 320 });
  });

  it("is kept on the page when the view is past it", () => {
    const p = defaultCanvasPivotPlacement({ ...VIEW, scrollX: 4000, scrollY: 4000 });
    expect(p.x + p.width).toBeLessThanOrEqual(1280);
    expect(p.y + p.height).toBeLessThanOrEqual(720);
  });

  it("shrinks to a page smaller than it", () => {
    surface = { ...surface!, page: { width: 300, height: 200 } };
    expect(defaultCanvasPivotPlacement(VIEW)).toEqual({ sheetIndex: 2, x: 0, y: 0, width: 300, height: 200 });
  });

  it("is unsnapped with snap off", () => {
    surface = { ...surface!, snapToGrid: false };
    expect(defaultCanvasPivotPlacement(VIEW)).toMatchObject({ x: 260, y: 140 });
  });

  it("the wire frame keeps the header rows and columns fixed", () => {
    expect(canvasFrameOf({ sheetIndex: 2, x: 1, y: 2, width: 3, height: 4 })).toEqual({
      x: 1,
      y: 2,
      width: 3,
      height: 4,
      frozenHeaders: true,
    });
  });
});

describe("resolveCanvasPivotSource", () => {
  it("binds 'Sheet!range' to that sheet, case-insensitively, stripping $ and using the real name", async () => {
    expect(await resolveCanvasPivotSource("sheet1!$a$1:$d$10", SHEETS, noTable)).toEqual({
      ok: true,
      sourceRange: "Sheet1!A1:D10",
      sourceSheet: 0,
    });
  });

  it("understands a quoted name with an escaped quote, and whole columns", async () => {
    expect(await resolveCanvasPivotSource("'It''s Data'!A:D", SHEETS, noTable)).toEqual({
      ok: true,
      sourceRange: "'It''s Data'!A:D",
      sourceSheet: 1,
    });
  });

  it("refuses a canvas, an unknown sheet, an empty prefix and a bad range", async () => {
    expect(await resolveCanvasPivotSource("Report!A1:B2", SHEETS, noTable)).toEqual({
      ok: false,
      message: canvasSourceIsCanvasMessage("Report"),
    });
    expect(await resolveCanvasPivotSource("Nope!A1:B2", SHEETS, noTable)).toEqual({
      ok: false,
      message: unknownSourceSheetMessage("Nope"),
    });
    expect(await resolveCanvasPivotSource("!A1:B2", SHEETS, noTable)).toEqual({
      ok: false,
      message: CANVAS_SOURCE_NEEDS_SHEET_MESSAGE,
    });
    expect(await resolveCanvasPivotSource("Sheet1!A1", SHEETS, noTable)).toEqual({
      ok: false,
      message: CANVAS_SOURCE_RANGE_FORMAT_MESSAGE,
    });
  });

  it("refuses an empty source and a bare range", async () => {
    expect(await resolveCanvasPivotSource("  ", SHEETS, noTable)).toEqual({ ok: false, message: CANVAS_SOURCE_EMPTY_MESSAGE });
    const findTable = vi.fn(noTable);
    expect(await resolveCanvasPivotSource("A1:D10", SHEETS, findTable)).toEqual({
      ok: false,
      message: CANVAS_SOURCE_NEEDS_SHEET_MESSAGE,
    });
    // A bare range is never looked up as a table name.
    expect(findTable).not.toHaveBeenCalled();
  });

  it("resolves a table on its own sheet, linked by name", async () => {
    const findTable = async (name: string) =>
      name === "Orders" ? { name: "Orders", sheetIndex: 1, startRow: 0, startCol: 0, endRow: 9, endCol: 27 } : null;
    expect(await resolveCanvasPivotSource("Orders", SHEETS, findTable)).toEqual({
      ok: true,
      sourceRange: "'It''s Data'!A1:AB10",
      sourceSheet: 1,
      sourceTableName: "Orders",
    });
  });

  it("an unknown table, a failing lookup and a table on a canvas are refused", async () => {
    expect(await resolveCanvasPivotSource("Missing", SHEETS, noTable)).toEqual({
      ok: false,
      message: unknownSourceTableMessage("Missing"),
    });
    const throws = async () => {
      throw new Error("ipc down");
    };
    expect(await resolveCanvasPivotSource("Orders", SHEETS, throws)).toEqual({
      ok: false,
      message: unknownSourceTableMessage("Orders"),
    });
    const onCanvas = async () => ({ name: "T", sheetIndex: 2, startRow: 0, startCol: 0, endRow: 1, endCol: 1 });
    expect(await resolveCanvasPivotSource("T", SHEETS, onCanvas)).toEqual({
      ok: false,
      message: canvasSourceIsCanvasMessage("Report"),
    });
  });
});

describe("findDefaultCanvasSource", () => {
  const empty: CanvasSourceRegion = { startRow: 0, startCol: 0, endRow: 0, endCol: 0, empty: true };

  it("takes the first visible worksheet with data, never a canvas or a hidden sheet", async () => {
    const getUsedRange = vi.fn(async (i: number) =>
      i === 1 ? { startRow: 1, startCol: 1, endRow: 5, endCol: 3, empty: false } : i === 2 || i === 3 ? { ...empty, empty: false } : empty,
    );
    const getCurrentRegion = vi.fn(async () => ({ startRow: 1, startCol: 1, endRow: 5, endCol: 3, empty: false }));
    expect(await findDefaultCanvasSource(SHEETS, { getUsedRange, getCurrentRegion })).toBe("'It''s Data'!B2:D6");
    expect(getUsedRange.mock.calls.map((c) => c[0])).toEqual([0, 1]);
    expect(getCurrentRegion).toHaveBeenCalledWith(1, 1, 1);
  });

  it("falls back to the used range when the first used cell stands alone, and skips a failing read", async () => {
    const getUsedRange = vi.fn(async (i: number) => {
      if (i === 0) throw new Error("boom");
      return { startRow: 0, startCol: 0, endRow: 7, endCol: 2, empty: false };
    });
    const getCurrentRegion = vi.fn(async () => empty);
    expect(await findDefaultCanvasSource(SHEETS, { getUsedRange, getCurrentRegion })).toBe("'It''s Data'!A1:C8");
  });

  it("is null when no worksheet has data", async () => {
    expect(
      await findDefaultCanvasSource(SHEETS, { getUsedRange: async () => empty, getCurrentRegion: async () => empty }),
    ).toBeNull();
  });
});

describe("qualifySourceRange", () => {
  it("quotes only names that need it", () => {
    expect(qualifySourceRange("Sheet1", "A1:B2")).toBe("Sheet1!A1:B2");
    expect(qualifySourceRange("My Sheet", "A1:B2")).toBe("'My Sheet'!A1:B2");
  });
});
