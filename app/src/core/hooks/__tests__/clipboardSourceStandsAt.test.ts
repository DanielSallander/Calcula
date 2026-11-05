//! FILENAME: app/src/core/hooks/__tests__/clipboardSourceStandsAt.test.ts
// PURPOSE: `clipboardSourceStandsAt` -- whether a copy's recorded source cells
//          still name its source NOW, the question Paste Special asks before it
//          names them on its writes (BUG-0657's remainder, round D lane
//          pastec). True for the pending copy and for a re-read of the same
//          cells; false once the mode ended, for a newer copy of other cells,
//          and for a copy whose positions were lost -- a paste then writes the
//          snapshot it has instead of naming cells that slid into the old
//          address.

import { describe, it, expect, beforeEach, vi } from "vitest";

const model = vi.hoisted(() => ({
  cells: new Map<string, { row: number; col: number; display: string; formula: string | null; styleIndex: number }>(),
}));

vi.mock("../../lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCell: vi.fn(async (r: number, c: number) => model.cells.get(`${r},${c}`) ?? null),
  getViewportCells: vi.fn(async (r0: number, c0: number, r1: number, c1: number) =>
    [...model.cells.values()].filter((x) => x.row >= r0 && x.row <= r1 && x.col >= c0 && x.col <= c1),
  ),
  getComment: vi.fn(async () => null),
  getAllComments: vi.fn(async () => []),
  getDataValidation: vi.fn(async () => null),
  getAllDataValidations: vi.fn(async () => []),
  getCollectionTexts: vi.fn(async (coords: [number, number][]) => coords.map(() => "")),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: vi.fn(async () => null),
  writeText: vi.fn(async () => undefined),
  writeHtml: vi.fn(async () => undefined),
}));
vi.mock("../../lib/dialogs", () => ({
  alertAsync: vi.fn(async () => {}),
  confirmAsync: vi.fn(async () => true),
}));
vi.mock("../../state/GridContext", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" } }),
}));

import { clipboardSourceStandsAt, copyCellRange, endClipboardMode, getInternalClipboard } from "../useClipboard";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  model.cells.clear();
  model.cells.set("0,0", { row: 0, col: 0, display: "5", formula: null, styleIndex: 0 });
  model.cells.set("4,4", { row: 4, col: 4, display: "9", formula: null, styleIndex: 0 });
  endClipboardMode();
});

describe("clipboardSourceStandsAt", () => {
  it("the pending copy, and a re-read of the SAME cells, stand where they were copied", async () => {
    expect(await copyCellRange({ startRow: 0, startCol: 0, endRow: 0, endCol: 0 })).toMatchObject({ copied: true });
    const clip = getInternalClipboard()!;
    expect(clipboardSourceStandsAt(clip)).toBe(true);
    // A re-read replaces the snapshot object but keeps its positions.
    expect(clipboardSourceStandsAt({ ...clip, cells: clip.cells.map((r) => [...r]) })).toBe(true);
  });

  // SABOTAGE (pastec-ts3): `if (clip) return true;` at the top of
  // clipboardSourceStandsAt -> the older copy is named as the source.
  it("a copy whose mode ENDED, and an older copy once a newer one of other cells is pending, do not", async () => {
    await copyCellRange({ startRow: 0, startCol: 0, endRow: 0, endCol: 0 });
    const first = getInternalClipboard()!;
    await copyCellRange({ startRow: 4, startCol: 4, endRow: 4, endCol: 4 });
    expect(clipboardSourceStandsAt(first), "an older copy of other cells named as the source").toBe(false);
    const second = getInternalClipboard()!;
    expect(clipboardSourceStandsAt(second)).toBe(true);
    endClipboardMode();
    expect(clipboardSourceStandsAt(second), "a copy whose mode ended named as the source").toBe(false);
  });
});
