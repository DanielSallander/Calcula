//! FILENAME: app/extensions/BuiltIn/StandardMenus/__tests__/selectionDoorsCellTarget.test.ts
// PURPOSE: The selection doors on a floating grid's cells (P3 S11): Go To
//          Special asks the cell-target question ("read") and opens its dialog
//          over the object's cells; Insert > Table keeps refusing (an Insert-
//          tab door, and a floating grid holds no table). An owner that admits
//          no "read" refuses Go To Special too (inert until S8).
// CONTEXT: The selection owner is REAL (@api/selectionOwner).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({ shown: [] as string[], toasts: [] as string[] }));

vi.mock("@api/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/ui")>()),
  showDialog: (id: string) => h.shown.push(id),
}));
vi.mock("@api/notifications", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  showToast: (m: string) => {
    h.toasts.push(m);
  },
}));

import { openGoToSpecialDialog, openInsertTableDialog, GO_TO_SPECIAL_DIALOG_ID } from "../selectionDoors";
import { registerSelectionOwner, type CellTargetCapability } from "@api/selectionOwner";

let actsOn: readonly CellTargetCapability[] = ["read"];
let release: () => void = () => {};

beforeEach(() => {
  h.shown = [];
  h.toasts = [];
  actsOn = ["read", "format", "content"];
  release = registerSelectionOwner({
    id: "test-floating-grid",
    label: "a floating grid's cells",
    ownsSelection: () => true,
    get actsOn() {
      return actsOn;
    },
    refusal: (action) => `${action} is not available inside a floating grid yet. Nothing was changed.`,
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

describe("selection doors on a floating grid's cells", () => {
  it("Go To Special opens over the object's cells", () => {
    openGoToSpecialDialog();
    expect(h.shown).toEqual([GO_TO_SPECIAL_DIALOG_ID]);
    expect(h.toasts).toEqual([]);
  });

  it("Insert Table keeps refusing with the owner's sentence", () => {
    openInsertTableDialog();
    expect(h.shown).toEqual([]);
    expect(h.toasts).toEqual(["Insert Table is not available inside a floating grid yet. Nothing was changed."]);
  });

  it("Go To Special is inert until the owner admits \"read\"", () => {
    actsOn = [];
    openGoToSpecialDialog();
    expect(h.shown).toEqual([]);
    expect(h.toasts).toEqual(["Go To Special is not available inside a floating grid yet. Nothing was changed."]);
  });
});
