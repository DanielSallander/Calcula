//! FILENAME: app/extensions/Table/handlers/__tests__/formatAsTableCellTarget.test.ts
// PURPOSE: Format as Table on a floating grid's cells is REFUSED with the 1.3
//          sentence (P3 S11, spec 1.3): the door asks the cell-target question
//          with capability "table", which no owner admits -- even an owner that
//          admits every other kind -- so the owner explains why, once, and no
//          dialog opens and no table is restyled.
// CONTEXT: The selection owner is REAL (@api/selectionOwner), shaped like the
//          floating grid's after S8 (actsOn = every kind but table, filter and
//          shiftCells; refusal names the reason per capability).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({ showDialog: vi.fn(), applyTableStyleAsync: vi.fn(), toasts: [] as string[] }));

vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  showDialog: (...a: unknown[]) => h.showDialog(...a),
}));
vi.mock("@api/grid", () => ({
  getGridStateSnapshot: () => ({ selection: { startRow: 2, startCol: 1, endRow: 2, endCol: 1 } }),
}));
vi.mock("../../lib/tableStore", () => ({ getTableAtCell: () => null }));
vi.mock("../../lib/tableStyles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/tableStyles")>()),
  applyTableStyleAsync: (...a: unknown[]) => h.applyTableStyleAsync(...a),
}));

import { formatAsTable } from "../formatAsTable";
import {
  registerSelectionOwner,
  CELL_TARGET_CAPABILITIES,
  type CellTargetCapability,
} from "@api/selectionOwner";
import { registerToastSink } from "@api/notifications";

const TABLE_SENTENCE =
  "Format as Table is not available inside a floating grid: a floating grid is already a table-like object. Nothing was changed.";

let release: () => void = () => {};
let calls: Array<[string, CellTargetCapability | undefined]> = [];

beforeEach(() => {
  h.showDialog.mockReset();
  h.applyTableStyleAsync.mockReset();
  h.toasts = [];
  calls = [];
  registerToastSink((t) => h.toasts.push(t.message));
  release = registerSelectionOwner({
    id: "test-floating-grid",
    label: "a floating grid's cells",
    ownsSelection: () => true,
    actsOn: CELL_TARGET_CAPABILITIES.filter((c) => c !== "table" && c !== "filter" && c !== "shiftCells"),
    refusal: (action, capability) => {
      calls.push([action, capability]);
      return capability === "table"
        ? TABLE_SENTENCE
        : `${action} is not available inside a floating grid yet. Nothing was changed.`;
    },
    cellTarget: () => ({
      ref: { kind: "floatingRange", id: "fr-1" },
      selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells", activeRow: 0, activeCol: 0 },
      bounds: { rows: 5, cols: 5 },
      label: "Float1",
      wholeObject: false,
    }),
  });
});
afterEach(() => release());

describe("Format as Table on a floating grid's cells", () => {
  it("asks for \"table\" and refuses with the 1.3 sentence; no dialog, no restyle", async () => {
    expect(await formatAsTable({ styleId: "table-medium-2" })).toBe(false);
    expect(calls).toEqual([["Format as Table", "table"]]);
    expect(h.toasts).toEqual([TABLE_SENTENCE]);
    expect(h.showDialog).not.toHaveBeenCalled();
    expect(h.applyTableStyleAsync).not.toHaveBeenCalled();
  });
});
