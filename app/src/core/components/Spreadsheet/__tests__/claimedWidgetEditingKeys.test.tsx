//! FILENAME: app/src/core/components/Spreadsheet/__tests__/claimedWidgetEditingKeys.test.tsx
// PURPOSE: The SECOND keyboard door — the React `onKeyDown` on the focus
//          container — must also stand down for a keystroke aimed inside an
//          on-grid surface that claimed the gesture.
//
// CONTEXT: `useGridKeyboard` is a native listener; this is a separate handler on
//          the same ancestor, and it acts on a different set of keys. Both stood
//          down only for INPUT / TEXTAREA / contenteditable, and an on-grid form
//          is made of `<select>` and `<button>`.
//
//          MEASURED through this handler before the fix, with a form's button
//          focused: a printable key opened the CELL EDITOR (useSpreadsheetEditing
//          ~524) so the characters went into the sheet cell hidden under the
//          card, and Enter moved the active cell (~517) instead of activating the
//          button — the button could not be pressed with the keyboard at all.
//
//          Driven through the REAL hook, assembled the way Spreadsheet.tsx
//          assembles it, because a test of `isKeyClaimed` alone stays green when
//          the guard is deleted from this door.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("../../../lib/tauri-api", () => ({
  getMergeInfo: vi.fn(async () => null),
  getCell: vi.fn(async () => null),
  updateCell: vi.fn(async (row: number, col: number, value: string) => ({
    cells: [{ row, col, display: value, formula: null }],
  })),
  updateCellOnSheets: vi.fn(async () => []),
  setActiveSheet: vi.fn(async () => {}),
  getViewportCells: vi.fn(async () => []),
  updateCellsBatch: vi.fn(async () => []),
  beginUndoTransaction: vi.fn(async () => {}),
  commitUndoTransaction: vi.fn(async () => {}),
  cancelUndoTransaction: vi.fn(async () => {}),
  findCtrlArrowTarget: vi.fn(async () => [0, 0] as [number, number]),
  getUsedRange: vi.fn(async () => ({ startRow: 0, startCol: 0, endRow: 9, endCol: 9 })),
}));

vi.mock("../../../../api/formulaAutocomplete", () => ({
  isFormulaAutocompleteVisible: () => false,
  AutocompleteEvents: { INPUT: "ac:input", KEY: "ac:key", ACCEPTED: "ac:accepted" },
}));
vi.mock("../../../../api/columnAutocomplete", () => ({
  isColumnAutocompleteVisible: () => false,
  ColumnAutocompleteEvents: { KEY: "cac:key", ACCEPTED: "cac:accepted" },
}));
vi.mock("../../../../api/cellTypes", () => ({
  handleCellTypeKeyDown: vi.fn(async () => false),
}));

import { useSpreadsheetEditing } from "../useSpreadsheetEditing";
import { GridProvider, useGridContext } from "../../../state/GridContext";
import { getInitialState } from "../../../state/gridReducer";
import { setSelection } from "../../../state/gridActions";
import { setGlobalIsEditing } from "../../../hooks";
import { claimPointer, releasePointerClaim } from "../../../lib/pointerClaims";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Cursor moves the handler asked for, as [deltaRow, deltaCol]. */
let moves: Array<[number, number]> = [];
/** Whether the hook is currently showing an open cell editor. */
let editorOpen = false;

function Harness(): React.ReactElement {
  const { state, dispatch } = useGridContext();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const focusContainerRef = useRef<HTMLDivElement | null>(null);
  const formulaInputRef = useRef<HTMLInputElement | null>(null);

  const { editingState, handlers } = useSpreadsheetEditing({
    containerRef,
    focusContainerRef,
    formulaInputRef,
    state,
    selectedCellContent: "",
    moveActiveCell: (dr, dc) => {
      moves.push([dr + 0, dc + 0]);
    },
    scrollToSelection: () => {},
    selectCell: () => {},
  });

  // Recorded in an effect rather than during render: the assertions run after
  // `act` has flushed, so "after every commit" is the same value and this stays
  // a pure render.
  const open = Boolean(editingState.editing && editingState.isEditing);
  useEffect(() => {
    editorOpen = open;
  }, [open]);

  useEffect(() => {
    dispatch(setSelection({ startRow: 2, startCol: 1, endRow: 2, endCol: 1, type: "cells" }));
  }, [dispatch]);

  // The container Core binds `onKeyDown` to, with the on-grid card inside it —
  // which is the arrangement that made a `<button>` inside the grid possible in
  // the first place.
  return (
    <div
      ref={focusContainerRef}
      data-testid="grid"
      tabIndex={0}
      onKeyDown={handlers.handleContainerKeyDown}
    >
      <canvas data-testid="canvas" />
      <div data-testid="card">
        <select data-testid="dropdown">
          <option>a</option>
        </select>
        <button data-testid="ok">OK</button>
        <input data-testid="field" />
      </div>
    </div>
  );
}

let root: Root;
let host: HTMLDivElement;

function el(testid: string): HTMLElement {
  return host.querySelector(`[data-testid='${testid}']`) as HTMLElement;
}

function card(): HTMLElement {
  return el("card");
}

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
}

/** Drain promises, React work and the setTimeout(0) that focuses the editor. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Press a key at an element, bubbling to the container as the browser does. */
async function pressOn(target: HTMLElement, key: string): Promise<boolean> {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  await act(async () => {
    target.dispatchEvent(event);
    await Promise.resolve();
  });
  await settle();
  return event.defaultPrevented;
}

// ---------------------------------------------------------------------------

describe("the container's key handler honours a pointer claim", () => {
  beforeEach(() => {
    moves = [];
    editorOpen = false;
    setGlobalIsEditing(false);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    setGlobalIsEditing(false);
  });

  // -------------------------------------------------------------------------
  // Typing into a form used to type into the cell under it
  // -------------------------------------------------------------------------

  it("a printable key in a claimed <button> does not open the cell editor", async () => {
    await mount();
    claimPointer(card(), "placement-1");

    const prevented = await pressOn(el("ok"), "x");

    // Pre-fix: the editor opened on the cell hidden UNDER the card, seeded "x",
    // and the key came back defaultPrevented so the widget never saw it.
    expect(editorOpen).toBe(false);
    expect(prevented).toBe(false);
  });

  it("a printable key in a claimed <select> does not open the cell editor", async () => {
    await mount();
    claimPointer(card(), "placement-1");

    await pressOn(el("dropdown"), "a");

    expect(editorOpen).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Enter could not press the button
  // -------------------------------------------------------------------------

  it("Enter in a claimed <button> moves no cell and is left for the widget", async () => {
    await mount();
    claimPointer(card(), "placement-1");

    const prevented = await pressOn(el("ok"), "Enter");

    // Pre-fix: moves == [[1, 0]] and prevented == true, so the active cell moved
    // down and the button was never activated.
    expect(moves).toEqual([]);
    expect(prevented).toBe(false);
  });

  it("F2 in a claimed widget does not open the editor either", async () => {
    await mount();
    claimPointer(card(), "placement-1");

    await pressOn(el("ok"), "F2");

    expect(editorOpen).toBe(false);
  });

  it("Delete in a claimed widget does not start an empty commit on the cell", async () => {
    await mount();
    claimPointer(card(), "placement-1");

    const prevented = await pressOn(el("ok"), "Delete");

    expect(editorOpen).toBe(false);
    expect(prevented).toBe(false);
  });

  // -------------------------------------------------------------------------
  // The positive control: an over-broad guard fails HERE
  // -------------------------------------------------------------------------

  it("a printable key with focus in the grid still opens the cell editor", async () => {
    await mount();
    claimPointer(card(), "placement-1");

    await pressOn(el("canvas"), "x");

    expect(editorOpen).toBe(true);
  });

  it("Enter with focus in the grid still moves the active cell", async () => {
    await mount();
    claimPointer(card(), "placement-1");

    await pressOn(el("canvas"), "Enter");

    expect(moves).toEqual([[1, 0]]);
  });

  it("with nobody claiming, the same button's keys are the grid's again", async () => {
    await mount();

    await pressOn(el("ok"), "Enter");

    expect(moves).toEqual([[1, 0]]);
  });

  // -------------------------------------------------------------------------
  // The control that proves the guard's SHAPE was already right
  // -------------------------------------------------------------------------

  it("a plain <input> keeps its keys, claimed or not", async () => {
    await mount();
    await pressOn(el("field"), "Enter");
    expect(moves).toEqual([]);

    claimPointer(card(), "placement-1");
    await pressOn(el("field"), "Enter");
    expect(moves).toEqual([]);
  });

  it("releasing the claim gives this door back to the grid", async () => {
    await mount();
    claimPointer(card(), "placement-1");
    await pressOn(el("ok"), "Enter");
    expect(moves).toEqual([]);

    releasePointerClaim(card());
    await pressOn(el("ok"), "Enter");
    expect(moves).toEqual([[1, 0]]);
  });

  it("a claimant hidden with display:none does not hold this door either", async () => {
    await mount();
    claimPointer(card(), "placement-1");
    card().style.display = "none";

    await pressOn(el("ok"), "Enter");

    expect(moves).toEqual([[1, 0]]);
  });
});
