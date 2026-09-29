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
}));

vi.mock("@api", () => ({
  useGridState: () => ({ selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 } }),
  cellEvents: { emit: vi.fn() },
}));
vi.mock("@api/lib", () => ({
  getCell: vi.fn(async () => null),
  getStyle: vi.fn(),
  applyFormatting: (...a: unknown[]) => h.applyFormatting(...a),
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
    await pressEnter();
    expect(h.applyFormatting).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(toasts).toEqual([]);
  });
});
