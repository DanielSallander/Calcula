//! FILENAME: app/src/core/hooks/__tests__/editFlagSelfHeal.test.tsx
// PURPOSE: Core's "a cell edit is open" flag HEALS when nothing is behind it,
//          so it cannot stand down Ctrl+Z / Ctrl+Y (and every other
//          not-editing and grid-scoped key) for the rest of the session.
// CONTEXT: BUG-0199 (K3). The keybinding dispatcher reads the flag
//          (isCoreCellEditOpen) to refuse workbook keys during an edit. A flag
//          left up with no edit refused them until some key happened to reach
//          the grid container, whose handler was the only thing that noticed.
//          Two ways it was left up, both driven here through the REAL hook:
//            1. an open that never happened: the formula bar raises the flag on
//               focus and asks startEdit to open the cell -- which bails (Format
//               Painter's edit guard, a protected range, a canvas) and left the
//               flag up;
//            2. an edit whose STATE ended without the flag: anything that
//               dispatches stopEditing (the @api re-exports it) or replaces the
//               state instead of going through commit/cancel.
//          The positive controls: a live edit (in-cell, or parked on another
//          sheet) keeps the flag, and so keeps refusing Ctrl+Z.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("../../lib/tauri-api", () => ({
  getMergeInfo: vi.fn(async () => null),
  getCell: vi.fn(async () => null),
  updateCell: vi.fn(async () => ({ cells: [] })),
  updateCellOnSheets: vi.fn(async () => []),
  setActiveSheet: vi.fn(async () => {}),
  findCtrlArrowTarget: vi.fn(async () => [0, 0] as [number, number]),
  getUsedRange: vi.fn(async () => ({ startRow: 0, startCol: 0, endRow: 0, endCol: 0 })),
}));

import { useEditing, setGlobalIsEditing, getGlobalIsEditing } from "../useEditing";
import { GridProvider, useGridContext } from "../../state/GridContext";
import { getInitialState } from "../../state/gridReducer";
import { setSelection, stopEditing } from "../../state/gridActions";
import { registerEditGuard } from "../../lib/editGuards";
import { handleGlobalKeyDown, initKeybindings } from "../../../api/keybindings";
import { CommandRegistry } from "../../../api/commands";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let api: ReturnType<typeof useEditing> | null = null;
let gridDispatch: React.Dispatch<unknown> | null = null;

function Harness(): null {
  api = useEditing();
  const { dispatch } = useGridContext();
  gridDispatch = dispatch as React.Dispatch<unknown>;
  React.useEffect(() => {
    dispatch(setSelection({ startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" }));
  }, [dispatch]);
  return null;
}

let root: Root;
let host: HTMLDivElement;
const undo = vi.fn();
const cleanups: (() => void)[] = [];

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Ctrl+Z with a ribbon button holding the keyboard (not the grid, not a field). */
function ctrlZ(): boolean {
  const button = document.createElement("button");
  document.body.appendChild(button);
  button.focus();
  const e = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
  Object.defineProperty(e, "target", { value: button });
  const handled = handleGlobalKeyDown(e);
  button.remove();
  return handled;
}

beforeAll(() => {
  initKeybindings();
});

beforeEach(async () => {
  undo.mockReset();
  CommandRegistry.register("core.edit.undo", undo);
  setGlobalIsEditing(false);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <GridProvider initialState={getInitialState()}>
        <Harness />
      </GridProvider>,
    );
  });
  await settle();
});

afterEach(async () => {
  while (cleanups.length > 0) cleanups.pop()!();
  CommandRegistry.unregister("core.edit.undo");
  await act(async () => {
    root.unmount();
  });
  host.remove();
  setGlobalIsEditing(false);
});

describe("the edit flag heals when nothing is behind it", () => {
  it("an open that never happened (the formula bar's raise, startEdit refused by an edit guard) does not leave the flag up", async () => {
    cleanups.push(registerEditGuard(async () => ({ blocked: true, message: "Format Painter is active." })));
    // FormulaInput.handleFocus: raise, then ask for the open.
    setGlobalIsEditing(true);
    await act(async () => {
      await api!.startEdit(0, 0);
    });
    await settle();
    expect(getGlobalIsEditing(), "the flag stayed up with no edit behind it").toBe(false);
    ctrlZ();
    expect(undo, "Ctrl+Z stood down for an edit that does not exist").toHaveBeenCalledTimes(1);
  });

  it("an edit whose STATE ended without the flag (a bare stopEditing) does not leave the flag up", async () => {
    await act(async () => {
      await api!.startEdit(0, 0);
    });
    await settle();
    expect(getGlobalIsEditing()).toBe(true);
    await act(async () => {
      gridDispatch!(stopEditing());
    });
    await settle();
    expect(getGlobalIsEditing(), "the flag outlived the edit's state").toBe(false);
    ctrlZ();
    expect(undo).toHaveBeenCalledTimes(1);
  });
});

describe("positive controls: a LIVE edit keeps the flag", () => {
  it("an open edit (its state present) keeps the flag, and Ctrl+Z still stands down", async () => {
    await act(async () => {
      await api!.startEdit(0, 0);
    });
    await settle();
    expect(getGlobalIsEditing()).toBe(true);
    expect(api!.editing).not.toBeNull();
    ctrlZ();
    expect(undo).not.toHaveBeenCalled();
  });

  it("a new edit opened right after one ended is not taken down by the old one's ending", async () => {
    await act(async () => {
      await api!.startEdit(0, 0);
    });
    await settle();
    await act(async () => {
      await api!.cancelEdit();
      await api!.startEdit(0, 0);
    });
    await settle();
    expect(getGlobalIsEditing()).toBe(true);
    expect(api!.editing).not.toBeNull();
  });

  it("a refused open does not take down a DIFFERENT edit that is live", async () => {
    await act(async () => {
      await api!.startEdit(0, 0);
    });
    await settle();
    cleanups.push(registerEditGuard(async () => ({ blocked: true, message: "no" })));
    await act(async () => {
      await api!.startEdit(0, 0);
    });
    await settle();
    expect(getGlobalIsEditing()).toBe(true);
  });
});
