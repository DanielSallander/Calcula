//! FILENAME: app/src/core/hooks/__tests__/gridKeyboardBackspaceParity.test.tsx
// PURPOSE: Excel parity for the two modified Backspaces the grid keyboard now
//          lets through: Ctrl+Backspace SCROLLS to show the active cell (the
//          selection does not change), Shift+Backspace COLLAPSES the selection
//          to the active cell.
// CONTEXT: K4 (keys round 4). Review 2026-09-28 stopped both from clearing the
//          selection (gridKeyboardModifiedDelete.test.tsx) but left them doing
//          nothing at all. The active cell is Core's `endRow/endCol` (the one
//          the renderer draws, typing edits and Space toggles). Drives the REAL
//          hook with the harness of gridKeyboardModifiedDelete.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("../../lib/tauri-api", () => ({
  getMergeInfo: vi.fn(async () => null),
  findCtrlArrowTarget: vi.fn(async () => [0, 0] as [number, number]),
  getUsedRange: vi.fn(async () => ({ startRow: 0, startCol: 0, endRow: 9, endCol: 9 })),
}));
vi.mock("../../../api/cellTypes", () => ({ handleCellTypeKeyDown: vi.fn(async () => false) }));
vi.mock("../../../utils/component-logger", () => {
  const noop = () => {};
  return { fnLog: { enter: noop, exit: noop }, stateLog: { action: noop }, eventLog: { keyboard: noop } };
});

import { useGridKeyboard } from "../useGridKeyboard";
import { GridProvider, useGridContext, getGridStateSnapshot } from "../../state/GridContext";
import { getInitialState } from "../../state/gridReducer";
import { setSelection, scrollToPosition } from "../../state/gridActions";
import type { Selection } from "../../types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let containerEl: HTMLDivElement;
let deleteCalls = 0;
let gridDispatch: ((a: unknown) => void) | null = null;

function Harness(): React.ReactElement {
  const { dispatch } = useGridContext();
  gridDispatch = dispatch as (a: unknown) => void;
  const ref = React.useRef<HTMLDivElement | null>(null);
  useGridKeyboard({
    containerRef: ref,
    enabled: true,
    isEditing: false,
    onDelete: async () => {
      deleteCalls += 1;
    },
  });
  return (
    <div ref={ref} data-testid="grid" tabIndex={0}>
      <canvas />
    </div>
  );
}

let root: Root;
let host: HTMLDivElement;

async function select(sel: Selection): Promise<void> {
  await act(async () => {
    gridDispatch!(setSelection(sel));
  });
}

async function press(key: string, init: KeyboardEventInit = {}): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    containerEl.dispatchEvent(event);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
  return event;
}

beforeEach(async () => {
  deleteCalls = 0;
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
  containerEl = host.querySelector("[data-testid='grid']") as HTMLDivElement;
  containerEl.focus();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

describe("Shift+Backspace collapses the selection to the active cell", () => {
  it("a range (anchor B3, active D6) becomes D6 alone; nothing is cleared", async () => {
    await select({ startRow: 2, startCol: 1, endRow: 5, endCol: 3, type: "cells" });
    const e = await press("Backspace", { shiftKey: true });
    const sel = getGridStateSnapshot()!.selection!;
    expect({ sr: sel.startRow, sc: sel.startCol, er: sel.endRow, ec: sel.endCol }).toEqual({ sr: 5, sc: 3, er: 5, ec: 3 });
    expect(e.defaultPrevented).toBe(true);
    expect(deleteCalls).toBe(0);
  });

  it("a multi-area selection (Ctrl+click ranges) collapses to the active cell too", async () => {
    await select({
      startRow: 0, startCol: 0, endRow: 1, endCol: 1, type: "cells",
      additionalRanges: [{ startRow: 5, startCol: 5, endRow: 6, endCol: 6 }],
    });
    await press("Backspace", { shiftKey: true });
    const sel = getGridStateSnapshot()!.selection!;
    expect({ sr: sel.startRow, sc: sel.startCol, er: sel.endRow, ec: sel.endCol }).toEqual({ sr: 1, sc: 1, er: 1, ec: 1 });
    expect(sel.additionalRanges ?? []).toEqual([]);
  });
});

describe("Ctrl+Backspace scrolls to show the active cell", () => {
  it("scrolls a far active cell into view; the selection is unchanged; nothing is cleared", async () => {
    await select({ startRow: 400, startCol: 2, endRow: 400, endCol: 2, type: "cells" });
    // The user scrolled away from it (the wheel does not move the selection).
    await act(async () => {
      gridDispatch!(scrollToPosition(0, 0));
    });
    const before = getGridStateSnapshot()!.viewport.scrollY;
    expect(before).toBe(0);
    const e = await press("Backspace", { ctrlKey: true });
    const after = getGridStateSnapshot()!;
    expect(after.viewport.scrollY, "the viewport did not move to the active cell").toBeGreaterThan(before);
    expect(after.selection).toMatchObject({ startRow: 400, startCol: 2, endRow: 400, endCol: 2 });
    expect(e.defaultPrevented).toBe(true);
    expect(deleteCalls).toBe(0);
  });
});

describe("positive control", () => {
  it("the bare Backspace still clears", async () => {
    await select({ startRow: 2, startCol: 1, endRow: 2, endCol: 1, type: "cells" });
    await press("Backspace");
    expect(deleteCalls).toBe(1);
  });
});
