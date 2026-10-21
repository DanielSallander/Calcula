//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/__tests__/formatCellsSelectionOwner.test.tsx
// PURPOSE: Format Cells refuses -- one toast, nothing written -- while a
//          selection owner holds the selection: the command does not open the
//          dialog, and a dialog already open does not apply on OK.
// CONTEXT: BUG-0185. Format Cells formats Core's selection (read at OK), which
//          is a cell HIDDEN under a floating grid while that grid's cell is
//          selected. The owner here is a TEST owner (@api/selectionOwner).

/* eslint-disable @typescript-eslint/naming-convention --
 * The module doubles below stand in for the six tab COMPONENTS. */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  applyFormatting: vi.fn(),
  setCellProtection: vi.fn(),
  getCellProtection: vi.fn(),
  openDialog: vi.fn(),
  getCell: vi.fn(async (..._a: unknown[]) => null),
  readTargetCell: vi.fn(async (..._a: unknown[]) => null),
}));
// The cell-target seam is REAL (P3); only its backend read is doubled.
vi.mock("@api/cellTarget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/cellTarget")>()),
  readTargetCell: (...a: unknown[]) => h.readTargetCell(...a),
}));

vi.mock("@api", () => ({
  useGridState: () => ({ selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 } }),
  cellEvents: { emit: vi.fn() },
}));
vi.mock("@api/lib", () => ({
  getCell: (...a: unknown[]) => h.getCell(...a),
  getStyle: vi.fn(),
  applyFormatting: (...a: unknown[]) => h.applyFormatting(...a),
  applyBorderPreset: vi.fn(),
  beginUndoTransaction: vi.fn(async () => 1),
  commitUndoTransaction: vi.fn(async () => undefined),
  cancelUndoTransaction: vi.fn(async () => undefined),
}));
vi.mock("@api/backend", () => ({
  setCellProtection: (...a: unknown[]) => h.setCellProtection(...a),
  getCellProtection: (...a: unknown[]) => h.getCellProtection(...a),
}));
vi.mock("@api/dialogs", () => ({ alertAsync: vi.fn() }));
vi.mock("@api/ui", () => ({
  DialogExtensions: { registerDialog: vi.fn(), unregisterDialog: vi.fn(), openDialog: (...a: unknown[]) => h.openDialog(...a) },
}));
vi.mock("../tabs/NumberTab", async () => {
  const R = await import("react");
  return { NumberTab: () => R.createElement("input", { "data-testid": "in-dialog" }) };
});
vi.mock("../tabs/AlignmentTab", () => ({ AlignmentTab: () => null }));
vi.mock("../tabs/FontTab", () => ({ FontTab: () => null }));
vi.mock("../tabs/BorderTab", () => ({ BorderTab: () => null }));
vi.mock("../tabs/FillTab", () => ({ FillTab: () => null }));
vi.mock("../tabs/ProtectionTab", () => ({ ProtectionTab: () => null }));

import { FormatCellsDialog } from "../FormatCellsDialog";
import { useFormatCellsStore } from "../hooks/useFormatCellsState";
import extension from "../index";
import { CoreCommands } from "@api/commands";
import { registerSelectionOwner } from "@api/selectionOwner";
import { registerToastSink, type ToastPayload } from "@api/notifications";

let container: HTMLDivElement;
let root: Root;
const toasts: ToastPayload[] = [];
let release: (() => void) | null = null;
const handlers = new Map<string, (...a: unknown[]) => unknown>();

function claim(): void {
  release = registerSelectionOwner({ id: "test-owner", label: "the test object's cells", ownsSelection: () => true });
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  h.applyFormatting.mockReset();
  h.applyFormatting.mockResolvedValue({ cells: [] });
  h.setCellProtection.mockReset();
  h.setCellProtection.mockResolvedValue({ success: true });
  h.getCellProtection.mockReset();
  h.getCellProtection.mockResolvedValue({ locked: true, formulaHidden: false });
  h.openDialog.mockReset();
  toasts.length = 0;
  registerToastSink((t) => toasts.push(t));
  // The store is a module singleton: a refused OK leaves its pending changes in
  // it, and the next case's baseline would then already contain them.
  useFormatCellsStore.getState().reset();
  useFormatCellsStore.getState().setActiveTab("number");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  handlers.clear();
  extension.activate({
    commands: {
      register: (id: string, fn: (...a: unknown[]) => unknown) => handlers.set(id, fn),
      unregister: (id: string) => handlers.delete(id),
    },
  } as never);
});

afterEach(() => {
  extension.deactivate();
  release?.();
  release = null;
  act(() => root.unmount());
  document.body.innerHTML = "";
});

async function renderDialog(onClose: () => void): Promise<void> {
  await act(async () => {
    root.render(<FormatCellsDialog isOpen onClose={onClose} />);
  });
  await act(async () => {
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

async function pressEnter(): Promise<void> {
  const el = document.querySelector("[data-testid='in-dialog']")!;
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

describe("Format Cells while a selection owner holds the selection", () => {
  it("the command (Ctrl+1, Format > Format Cells, the ribbon) does not open the dialog; one toast", async () => {
    claim();
    await handlers.get(CoreCommands.FORMAT_CELLS)!();
    expect(h.openDialog, "Format Cells opened over Core's hidden selection").not.toHaveBeenCalled();
    expect(toasts.length).toBe(1);
  });

  it("OK in a dialog that is already open writes nothing -- formatting OR protection; one toast", async () => {
    const onClose = vi.fn();
    await renderDialog(onClose);
    // Pending changes to BOTH halves, so an OK that slipped past the refusal
    // would write them (OK writes only what changed -- survey D5).
    act(() => {
      useFormatCellsStore.getState().setBold(true);
      useFormatCellsStore.getState().setLocked(false);
    });
    claim();
    await pressEnter();
    expect(h.applyFormatting, "OK formatted Core's hidden selection").not.toHaveBeenCalled();
    expect(h.setCellProtection, "OK changed the hidden cell's protection").not.toHaveBeenCalled();
    expect(toasts.length).toBe(1);
  });
});

describe("positive controls: nothing owns the selection", () => {
  it("the command opens the dialog", async () => {
    await handlers.get(CoreCommands.FORMAT_CELLS)!();
    expect(h.openDialog).toHaveBeenCalledWith("format-cells");
    expect(toasts).toEqual([]);
  });

  it("OK applies and closes", async () => {
    const onClose = vi.fn();
    await renderDialog(onClose);
    act(() => useFormatCellsStore.getState().setBold(true));
    await pressEnter();
    expect(h.applyFormatting).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(toasts).toEqual([]);
  });
});

describe("Format Cells on a floating grid's cells (P3)", () => {
  const REF = { kind: "floatingRange" as const, id: "fr-6" };
  const floatingGrid = (actsOn?: readonly "format"[]): void => {
    release = registerSelectionOwner({
      id: "floatingRange",
      label: "a floating grid's cells",
      ownsSelection: () => true,
      cellTarget: () => ({
        ref: REF,
        selection: { startRow: 2, startCol: 1, endRow: 3, endCol: 1, activeRow: 3, activeCol: 1, type: "cells" },
        bounds: { rows: 10, cols: 4 },
        label: "Float1",
        wholeObject: false,
      }),
      ...(actsOn ? { actsOn } : {}),
    });
  };

  beforeEach(() => {
    h.getCell.mockClear();
    h.readTargetCell.mockClear();
  });

  it("the command opens the dialog for a grid that admits the act", async () => {
    floatingGrid(["format"]);
    await handlers.get(CoreCommands.FORMAT_CELLS)!();
    expect(h.openDialog).toHaveBeenCalledWith("format-cells");
    expect(toasts).toEqual([]);
  });

  it("the dialog seeds from the grid's ACTIVE cell through the target, and OK writes ITS cells with { target }", async () => {
    floatingGrid(["format"]);
    const onClose = vi.fn();
    await renderDialog(onClose);
    expect(h.readTargetCell).toHaveBeenCalledWith(REF, 3, 1);
    expect(h.getCell, "the dialog read the active sheet's cell under the grid").not.toHaveBeenCalled();
    act(() => {
      useFormatCellsStore.getState().setBold(true);
      useFormatCellsStore.getState().setLocked(false);
    });
    await pressEnter();
    expect(toasts).toEqual([]);
    expect(h.applyFormatting.mock.calls).toEqual([
      [[2, 3], [1], { bold: true }, { target: REF }],
      [[2, 3], [1], { locked: false, formulaHidden: false }, { target: REF }],
    ]);
    expect(h.setCellProtection, "a floating grid's lock went to the active sheet's protection command").not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("inert until S8: a floating grid that admits nothing -- the command does not open, OK writes nothing", async () => {
    floatingGrid(undefined);
    await handlers.get(CoreCommands.FORMAT_CELLS)!();
    expect(h.openDialog).not.toHaveBeenCalled();
    expect(toasts.length).toBe(1);
    release?.();
    release = null;
    const onClose = vi.fn();
    await renderDialog(onClose);
    act(() => useFormatCellsStore.getState().setBold(true));
    floatingGrid(undefined);
    await pressEnter();
    expect(h.applyFormatting).not.toHaveBeenCalled();
    expect(toasts.length).toBe(2);
  });
});
