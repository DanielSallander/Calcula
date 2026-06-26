//! FILENAME: app/src/core/lib/__tests__/cellEvents.test.ts
// PURPOSE: cellEvents payload normalization — CELL_VALUES_CHANGED carries
//          {changes,source} and CELLS_UPDATED now carries the same {changes}
//          (so subscribers can scope work); both fire from one debounced flush.

import { describe, it, expect } from "vitest";
import { cellEvents, cellToChange } from "../cellEvents";
import { onAppEvent, AppEvents } from "../events";
import type { CellData } from "../../types";

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

describe("cellEvents payload normalization", () => {
  it("emits CELL_VALUES_CHANGED {changes,source} and CELLS_UPDATED {changes} together", async () => {
    const cvc: Array<{ changes: unknown[]; source: string }> = [];
    const cu: Array<{ changes?: unknown[] } | undefined> = [];
    const off1 = onAppEvent<{ changes: unknown[]; source: string }>(AppEvents.CELL_VALUES_CHANGED, (d) => cvc.push(d));
    const off2 = onAppEvent<{ changes?: unknown[] }>(AppEvents.CELLS_UPDATED, (d) => cu.push(d));

    cellEvents.emit({ row: 2, col: 3, newValue: "x", formula: null }, "user");
    await nextFrame();
    off1();
    off2();

    expect(cvc).toHaveLength(1);
    expect(cvc[0]).toMatchObject({ source: "user", changes: [{ row: 2, col: 3, newValue: "x" }] });
    // CELLS_UPDATED now carries the same changes (was payload-less before).
    expect(cu.at(-1)).toMatchObject({ changes: [{ row: 2, col: 3, newValue: "x" }] });
  });

  it("emitBatch (fill path) carries source 'fill' and maps every change", async () => {
    const cvc: Array<{ changes: unknown[]; source: string }> = [];
    const off = onAppEvent<{ changes: unknown[]; source: string }>(AppEvents.CELL_VALUES_CHANGED, (d) => cvc.push(d));

    cellEvents.emitBatch(
      [{ row: 1, col: 1, newValue: "a", formula: null }, { row: 2, col: 1, newValue: "b", formula: null }],
      "fill",
    );
    await nextFrame();
    off();

    expect(cvc.at(-1)?.source).toBe("fill");
    expect(cvc.at(-1)?.changes).toHaveLength(2);
  });

  it("propagates per-change sheetIndex through to the CELL_VALUES_CHANGED payload (ITEM 1)", async () => {
    const cvc: Array<{ changes: Array<{ row: number; col: number; sheetIndex?: number }> }> = [];
    const off = onAppEvent<{ changes: Array<{ row: number; col: number; sheetIndex?: number }> }>(
      AppEvents.CELL_VALUES_CHANGED, (d) => cvc.push(d),
    );

    cellEvents.emitBatch(
      [
        { row: 0, col: 0, sheetIndex: undefined, newValue: "active", formula: null }, // active sheet
        { row: 5, col: 2, sheetIndex: 3, newValue: "off", formula: null },             // cross-sheet
      ],
      "fill",
    );
    await nextFrame();
    off();

    const changes = cvc.at(-1)!.changes;
    expect(changes.find((c) => c.row === 0)?.sheetIndex).toBeUndefined();
    expect(changes.find((c) => c.row === 5)?.sheetIndex).toBe(3);
  });
});

describe("cellToChange (ITEM 1 shared emitter mapper)", () => {
  const base: CellData = {
    row: 4, col: 7, display: "42", formula: "=A1+1", styleIndex: 0,
  };

  it("maps a CellData to a CellChangeEvent (display -> newValue, formula kept)", () => {
    expect(cellToChange(base)).toEqual({
      row: 4, col: 7, sheetIndex: undefined, newValue: "42", formula: "=A1+1",
    });
  });

  it("carries a defined sheetIndex through (cross-sheet cell is NOT dropped)", () => {
    expect(cellToChange({ ...base, sheetIndex: 2 }).sheetIndex).toBe(2);
  });

  it("keeps a null formula as null", () => {
    expect(cellToChange({ ...base, formula: null }).formula).toBeNull();
  });
});
