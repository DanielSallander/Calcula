//! FILENAME: app/src/core/hooks/__tests__/fillHandleLinePlan.test.tsx
// PURPOSE: The fill-handle drag writes exactly what its own per-line loop
//          wrote before that loop moved into core/lib/fillEngine.planFillLine
//          (review finding (j), 2026-10-04) -- in all four directions, with a
//          formula in the source, and from the double-click fill to the edge.
// CONTEXT: The ORACLE below is the handle's old loop, restated with the engine's
//          own detectPattern / generateFillValue: a formula-filtered pattern
//          read in reading order, fill index = distance from the source's near
//          edge, and for up / left the source read from its far end with the
//          values reversed. Driven through the REAL hook (harness of
//          fillUndoOwnership.test.tsx).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";

/** The sheet: "row,col" -> value (a formula starts with "="). */
const sheet = vi.hoisted(() => new Map<string, string>());
const api = vi.hoisted(() => ({
  updateCellsBatch: vi.fn(async (_updates: Array<{ row: number; col: number; value: string }>) => [] as unknown[]),
}));

vi.mock("../../lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  beginUndoTransaction: vi.fn(async () => 1),
  commitUndoTransaction: vi.fn(async () => {}),
  cancelUndoTransaction: vi.fn(async () => {}),
  updateCellsBatch: (u: Array<{ row: number; col: number; value: string }>) => api.updateCellsBatch(u),
  // Column A holds data in rows 0..5: the double-click fills down to row 5.
  getCell: vi.fn(async (row: number, col: number) =>
    col === 0 && row <= 5 ? { row, col, display: "a", formula: null, styleIndex: 0 } : null,
  ),
  getViewportCells: vi.fn(async (r0: number, c0: number, r1: number, c1: number) => {
    const out: unknown[] = [];
    for (const [key, v] of sheet) {
      const [row, col] = key.split(",").map(Number);
      if (row < r0 || row > r1 || col < c0 || col > c1) continue;
      const formula = v.startsWith("=") ? v : null;
      out.push({ row, col, display: formula ? "0" : v, formula, styleIndex: 0 });
    }
    return out;
  }),
  // A shifted formula is spelled "<formula>@<rowDelta>,<colDelta>".
  shiftFormulasBatch: vi.fn(async (inputs: Array<{ formula: string; rowDelta: number; colDelta: number }>) =>
    inputs.map((i) => `${i.formula}@${i.rowDelta},${i.colDelta}`),
  ),
  getMergedRegions: vi.fn(async () => []),
  mergeCells: vi.fn(async () => {}),
}));

vi.mock("../../lib/dialogs", () => ({
  alertAsync: vi.fn(async () => {}),
  confirmAsync: vi.fn(async () => true),
}));

import { useFillHandle, type UseFillHandleReturn } from "../useFillHandle";
import { GridProvider, useGridContext } from "../../state/GridContext";
import { setSelection } from "../../state/gridActions";
import { detectPattern, generateFillValue } from "../../lib/fillEngine";
import type { GridConfig } from "../../types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let hook: UseFillHandleReturn;
let dispatchOut: ReturnType<typeof useGridContext>["dispatch"];
let configOut: GridConfig;

function Harness(): React.ReactElement {
  const { state, dispatch } = useGridContext();
  const containerRef = useRef<HTMLElement | null>(null);
  dispatchOut = dispatch;
  configOut = state.config;
  hook = useFillHandle({ containerRef, config: state.config });
  return <div />;
}

let root: Root;
let host: HTMLDivElement;

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

interface Rect {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

async function select(r: Rect): Promise<void> {
  await act(async () => {
    dispatchOut(setSelection({ ...r, type: "cells" }));
  });
  await settle();
}

/** Drag the selection's fill handle to (row, col), then release. */
async function drag(r: Rect, row: number, col: number): Promise<void> {
  await select(r);
  await act(async () => {
    hook.startFillDrag(0, 0);
  });
  await settle();
  const x = configOut.rowHeaderWidth + configOut.defaultCellWidth * col + 5;
  const y = configOut.colHeaderHeight + configOut.defaultCellHeight * row + 5;
  await act(async () => {
    hook.updateFillDrag(x, y);
  });
  await settle();
  await act(async () => {
    await hook.completeFill();
  });
  await settle();
}

/** Every write of the gesture, "row,col" -> value. */
function writes(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [updates] of api.updateCellsBatch.mock.calls) {
    for (const u of updates) out[`${u.row},${u.col}`] = u.value;
  }
  return out;
}

/** The handle's OLD loop for one line, as the oracle (see the header). */
function oracle(
  sourceValues: string[],
  targets: Array<{ key: string; fillIndex: number; sourceIndexFromNear: number; rowDelta: number; colDelta: number }>,
  backward: boolean,
): Record<string, string> {
  const nonFormula = sourceValues.filter((v) => !v.startsWith("="));
  const pattern = detectPattern(nonFormula.length > 0 ? nonFormula : sourceValues);
  const all = backward ? sourceValues.slice().reverse() : sourceValues;
  const out: Record<string, string> = {};
  for (const t of targets) {
    const sourceValue = all[t.fillIndex % sourceValues.length];
    out[t.key] = sourceValue.startsWith("=")
      ? `${sourceValue}@${t.rowDelta},${t.colDelta}`
      : generateFillValue(pattern, all, t.fillIndex);
  }
  return out;
}

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  sheet.clear();
  api.updateCellsBatch.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <GridProvider>
        <Harness />
      </GridProvider>,
    );
  });
  await settle();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("the drag writes what its own loop wrote (now planFillLine)", () => {
  it("DOWN: B2:B3 = 1, 3 dragged to row 6 -> 5, 7, 9, 11", async () => {
    sheet.set("1,1", "1");
    sheet.set("2,1", "3");
    await drag({ startRow: 1, startCol: 1, endRow: 2, endCol: 1 }, 6, 1);
    const expected = oracle(
      ["1", "3"],
      [3, 4, 5, 6].map((r) => ({ key: `${r},1`, fillIndex: r - 1, sourceIndexFromNear: 0, rowDelta: 0, colDelta: 0 })),
      false,
    );
    expect(writes()).toEqual(expected);
    expect(Object.values(expected)).toEqual(["5", "7", "9", "11"]);
  });

  it("UP: B5:B6 = 1, 3 dragged to row 2 -> the old loop's reversed series", async () => {
    sheet.set("4,1", "1");
    sheet.set("5,1", "3");
    await drag({ startRow: 4, startCol: 1, endRow: 5, endCol: 1 }, 2, 1);
    const expected = oracle(
      ["1", "3"],
      [3, 2].map((r) => ({ key: `${r},1`, fillIndex: 5 - r, sourceIndexFromNear: 0, rowDelta: 0, colDelta: 0 })),
      true,
    );
    expect(Object.keys(writes()).sort()).toEqual(["2,1", "3,1"]);
    expect(writes()).toEqual(expected);
  });

  it("RIGHT with a formula in the source: Item 1, =A1 -> the literal increments, the formula shifts", async () => {
    sheet.set("0,1", "Item 1");
    sheet.set("0,2", "=A1");
    await drag({ startRow: 0, startCol: 1, endRow: 0, endCol: 2 }, 0, 5);
    const expected = oracle(
      ["Item 1", "=A1"],
      [3, 4, 5].map((c) => {
        const fillIndex = c - 1;
        const sourceCol = 1 + (fillIndex % 2);
        return { key: `0,${c}`, fillIndex, sourceIndexFromNear: 0, rowDelta: 0, colDelta: c - sourceCol };
      }),
      false,
    );
    expect(writes()).toEqual(expected);
    expect(writes()["0,4"]).toBe("=A1@0,2");
  });

  it("LEFT: E1:F1 = 10, 20 dragged to column B -> the old loop's reversed series", async () => {
    sheet.set("0,4", "10");
    sheet.set("0,5", "20");
    await drag({ startRow: 0, startCol: 4, endRow: 0, endCol: 5 }, 0, 1);
    const expected = oracle(
      ["10", "20"],
      [3, 2, 1].map((c) => ({ key: `0,${c}`, fillIndex: 5 - c, sourceIndexFromNear: 0, rowDelta: 0, colDelta: 0 })),
      true,
    );
    expect(writes()).toEqual(expected);
  });

  it("the double-click fill to the edge: B1:B2 = Mon, Tue down to column A's last row", async () => {
    sheet.set("0,1", "Mon");
    sheet.set("1,1", "Tue");
    await select({ startRow: 0, startCol: 1, endRow: 1, endCol: 1 });
    await act(async () => {
      await hook.autoFillToEdge();
    });
    await settle();
    const expected = oracle(
      ["Mon", "Tue"],
      [2, 3, 4, 5].map((r) => ({ key: `${r},1`, fillIndex: r, sourceIndexFromNear: 0, rowDelta: 0, colDelta: 0 })),
      false,
    );
    expect(writes()).toEqual(expected);
    expect(Object.values(expected)).toEqual(["Wed", "Thu", "Fri", "Sat"]);
  });
});
