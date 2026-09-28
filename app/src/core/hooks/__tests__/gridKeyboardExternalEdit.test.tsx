//! FILENAME: app/src/core/hooks/__tests__/gridKeyboardExternalEdit.test.tsx
// PURPOSE: While an EXTERNAL edit session is live (a floating grid's cell edit,
//          hosted by the formula bar or parked on another sheet), a key that
//          reaches the grid container must not act on the GRID.
// CONTEXT: The session sets no Core editing flag, and `useGridKeyboard` -- a
//          NATIVE listener that runs before React's container handler -- used to
//          gate on that flag alone. So after a reference pick left the keyboard
//          on the container, Delete ran clear-contents over the picked cell, Tab
//          and the arrows moved the grid cursor, all while the user was typing a
//          formula. The container's React handler then routes the key to the
//          session (externalEditContainerKeys.test.tsx).
//
//          IN THE APP, Delete reaches this hook only because the capture-phase
//          keybinding dispatcher stands down for a live session (pinned by
//          api/__tests__/keybindings.externalEdit.test.ts); before it did, the
//          dispatcher cleared the cells itself and this door never saw the key.
//          Backspace (no registry binding) always reached it. This file fires
//          keys straight at the hook, so it proves the door, not the whole path.
//
//          Drives the REAL hook with the harness of gridClaimedWidgetKeyboard.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("../../lib/tauri-api", () => ({
  getMergeInfo: vi.fn(async () => null),
  findCtrlArrowTarget: vi.fn(async () => [0, 0] as [number, number]),
  getUsedRange: vi.fn(async () => ({ startRow: 0, startCol: 0, endRow: 9, endCol: 9 })),
}));

vi.mock("../../../api/cellTypes", () => ({
  handleCellTypeKeyDown: vi.fn(async () => false),
}));

vi.mock("../../../utils/component-logger", () => {
  const noop = () => {};
  return {
    fnLog: { enter: noop, exit: noop },
    stateLog: { action: noop },
    eventLog: { keyboard: noop },
  };
});

import { useGridKeyboard } from "../useGridKeyboard";
import { GridProvider, useGridContext } from "../../state/GridContext";
import { getInitialState } from "../../state/gridReducer";
import { setSelection } from "../../state/gridActions";
import { __resetExternalEditForTests } from "../../lib/formulaEditTarget";
import { createFakeExternalEdit } from "../../lib/__tests__/helpers/fakeExternalEdit";
import type { Selection } from "../../types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let deleteCalls = 0;
let observedSelection: Selection | null = null;
let containerEl: HTMLDivElement;

function Harness(): React.ReactElement {
  const { state, dispatch } = useGridContext();
  const ref = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    observedSelection = state.selection;
  });

  useGridKeyboard({
    containerRef: ref,
    enabled: true,
    isEditing: false,
    onDelete: async () => {
      deleteCalls += 1;
    },
  });

  React.useEffect(() => {
    dispatch(setSelection({ startRow: 4, startCol: 0, endRow: 4, endCol: 0, type: "cells" }));
  }, [dispatch]);

  return (
    <div ref={ref} data-testid="grid" tabIndex={0}>
      <canvas data-testid="canvas" />
    </div>
  );
}

let root: Root;
let host: HTMLDivElement;

async function mount(): Promise<void> {
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
}

async function press(key: string): Promise<void> {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  await act(async () => {
    containerEl.dispatchEvent(event);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function cellOf(sel: Selection | null): string {
  return sel ? `r${sel.endRow}c${sel.endCol}` : "none";
}

describe("the grid keyboard while an external edit session is live", () => {
  beforeEach(() => {
    deleteCalls = 0;
    observedSelection = null;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    __resetExternalEditForTests();
  });

  it("Delete does NOT clear the cells (the picked reference's cell among them)", async () => {
    await mount();
    createFakeExternalEdit({ hostSheetIndex: 2, text: "=Sheet1!E2" }).register();
    await press("Delete");
    await press("Backspace");
    expect(deleteCalls).toBe(0);
  });

  it("Tab and the arrows do not move the grid cursor", async () => {
    await mount();
    createFakeExternalEdit({ hostSheetIndex: 2, text: "=Sheet1!E2" }).register();
    await press("Tab");
    await press("ArrowDown");
    await press("ArrowRight");
    expect(cellOf(observedSelection)).toBe("r4c0");
  });

  it("positive control: with no session the same keys act on the grid", async () => {
    await mount();
    await press("Delete");
    expect(deleteCalls).toBe(1);
    await press("ArrowDown");
    expect(cellOf(observedSelection)).toBe("r5c0");
  });

  it("a pick-only target (the chart text editor) does not take the grid's keys", async () => {
    await mount();
    const { registerExternalFormulaTarget } = await import("../../lib/formulaEditTarget");
    registerExternalFormulaTarget({ isExpectingReference: () => true, insertReference: () => undefined });
    await press("ArrowDown");
    expect(cellOf(observedSelection)).toBe("r5c0");
  });
});
