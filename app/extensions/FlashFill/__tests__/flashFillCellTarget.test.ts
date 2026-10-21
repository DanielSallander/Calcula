//! FILENAME: app/extensions/FlashFill/__tests__/flashFillCellTarget.test.ts
// PURPOSE: Flash Fill on a floating grid's cells (P3 S11, owner finding G3;
//          DECISIONS2: "support if the engine API allows a target"). The door
//          resolves the grid's cells ("content"), learns from the OBJECT's own
//          cells (the styled read of @api/cellTarget -- never getCell, which
//          reads the active sheet under the object) and writes the filled
//          column with the target in one undo step. An owner that admits no
//          "content" refuses with nothing read or written (inert until S8).
// CONTEXT: The selection owner is REAL (@api/selectionOwner).

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  objectCells: [] as Array<{ row: number; col: number; display: string }>,
  sheetReads: 0,
  objectReads: [] as unknown[][],
  writes: [] as unknown[][],
  toasts: [] as string[],
}));

vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  getCell: async () => {
    h.sheetReads++;
    return null;
  },
  updateCellsBatch: async (...a: unknown[]) => {
    h.writes.push(a);
    return [];
  },
  beginUndoTransaction: async () => 9,
  commitUndoTransaction: async () => {},
  cancelUndoTransaction: async () => {},
  registerMenuItem: () => {},
  unregisterMenuItem: () => {},
  showToast: (m: string) => {
    h.toasts.push(m);
  },
}));
vi.mock("@api/lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/lib")>()),
  getGridBounds: async () => {
    h.sheetReads++;
    return [0, 0];
  },
}));
vi.mock("@api/notifications", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  showToast: (m: string) => {
    h.toasts.push(m);
  },
}));
vi.mock("@api/cellTarget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/cellTarget")>()),
  getCellTargetCells: async (...a: unknown[]) => {
    h.objectReads.push(a);
    return {
      cells: h.objectCells.map((c) => ({ ...c, formula: null, styleIndex: 0, valueKind: "text" })),
      merges: [],
      conditional: [],
      styles: [],
      rules: [],
    };
  },
}));
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => ({ selection: { startRow: 40, startCol: 40, endRow: 40, endCol: 40, type: "cells" } }),
  refreshGridData: () => {},
}));

import extension, { FLASH_FILL_COMMAND } from "../index";
import { CommandRegistry } from "@api/commands";
import { registerSelectionOwner, type CellTargetCapability } from "@api/selectionOwner";
import type { Selection } from "@api/types";

const REF = { kind: "floatingRange" as const, id: "fr-1" };

let frSelection: Selection | null = null;
let actsOn: readonly CellTargetCapability[] = ["content"];
let release: () => void = () => {};

beforeAll(() => {
  extension.activate({
    commands: {
      register: (id: string, fn: (...a: unknown[]) => unknown, o?: unknown) => CommandRegistry.register(id, fn, o as never),
      unregister: (id: string) => CommandRegistry.unregister(id),
    },
  } as never);
});
afterAll(() => extension.deactivate?.());

beforeEach(() => {
  // A: full names; B: the first names typed for row 0 only.
  h.objectCells = [
    { row: 0, col: 0, display: "Ada Lovelace" },
    { row: 1, col: 0, display: "Alan Turing" },
    { row: 2, col: 0, display: "Grace Hopper" },
    { row: 0, col: 1, display: "Ada" },
  ];
  h.sheetReads = 0;
  h.objectReads = [];
  h.writes = [];
  h.toasts = [];
  actsOn = ["content"];
  frSelection = { startRow: 1, startCol: 1, endRow: 1, endCol: 1, type: "cells", activeRow: 1, activeCol: 1 };
  release = registerSelectionOwner({
    id: "test-floating-grid",
    label: "a floating grid's cells",
    ownsSelection: () => frSelection !== null,
    get actsOn() {
      return actsOn;
    },
    refusal: (action) => `${action} is not available inside a floating grid yet. Nothing was changed.`,
    cellTarget: () =>
      frSelection === null
        ? null
        : { ref: REF, selection: frSelection, bounds: { rows: 5, cols: 3 }, label: "Float1", wholeObject: false },
  });
});
afterEach(() => release());

describe("Flash Fill on a floating grid's cells", () => {
  it("learns from the OBJECT's cells and fills its column with the target", async () => {
    await CommandRegistry.execute(FLASH_FILL_COMMAND);
    expect(h.sheetReads, "the active sheet under the object was read").toBe(0);
    expect(h.objectReads).toHaveLength(1);
    expect(h.objectReads[0][0]).toBe(REF);
    expect(h.objectReads[0][1]).toEqual({ startRow: 0, startCol: 0, endRow: 4, endCol: 2 });
    expect(h.writes).toEqual([
      [
        [
          { row: 1, col: 1, value: "Alan" },
          { row: 2, col: 1, value: "Grace" },
        ],
        { target: REF },
      ],
    ]);
  });

  it("inert until the owner admits \"content\": refused once, nothing read or written", async () => {
    actsOn = [];
    await CommandRegistry.execute(FLASH_FILL_COMMAND);
    expect(h.objectReads).toEqual([]);
    expect(h.sheetReads).toBe(0);
    expect(h.writes).toEqual([]);
    expect(h.toasts).toEqual(["Flash Fill is not available inside a floating grid yet. Nothing was changed."]);
  });
});
