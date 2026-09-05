//! FILENAME: app/src/core/hooks/__tests__/gridClaimedWidgetKeyboard.test.tsx
// PURPOSE: A keystroke aimed inside an on-grid surface that CLAIMED the gesture
//          must not reach the grid's keyboard handler — and the grid must still
//          get its keys when focus is genuinely in the grid.
//
// CONTEXT: The pointer claim is what finally lets a widget on the grid hold
//          FOCUS. `useGridKeyboard` was written when nothing inside `S.GridArea`
//          ever could, so it stands down only for INPUT / TEXTAREA /
//          contenteditable. An on-grid form's dropdown is a real `<select>` and
//          its buttons are real `<button>`s — the first of either ever to live
//          inside the grid — and neither is on that list.
//
//          MEASURED against this very hook before the fix: Delete with the
//          `<select>` focused called `onDelete`, which is the grid's CLEAR
//          CONTENTS over the user's selected cells; ArrowDown moved the cell
//          cursor r4c0 -> r5c0 and returned `defaultPrevented`, so the dropdown
//          could not be operated by keyboard at all. The `<input>` in the same
//          card was already safe, by the tag list — which is the control that
//          says the SHAPE of the guard was right and only its reach was wrong.
//
//          Everything below drives the REAL hook. A test of `isKeyClaimed` alone
//          cannot see this class of bug: delete the guard from the door and
//          every assertion in pointerClaims.test.ts stays green.

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
import { claimPointer, releasePointerClaim } from "../../lib/pointerClaims";
import type { GridState, Selection } from "../../types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// ---------------------------------------------------------------------------
// Harness — the real hook, bound to a container that also holds an on-grid card
// ---------------------------------------------------------------------------

/** Every call the grid made to "clear the selected cells". */
let deleteCalls = 0;
/** The selection the grid is showing, as the renderer would read it. */
let observedSelection: Selection | null = null;
let containerEl: HTMLDivElement;

function Harness(): React.ReactElement {
  const { state, dispatch } = useGridContext();
  const ref = React.useRef<HTMLDivElement | null>(null);

  // Recorded in an effect rather than during render: the assertions run after
  // `act` has flushed, so "after every commit" is the same value and this stays
  // a pure render.
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
    dispatch(
      setSelection({ startRow: 4, startCol: 0, endRow: 4, endCol: 0, type: "cells" }),
    );
  }, [dispatch]);

  // The real shape: Core binds keydown to the container, and an on-grid surface
  // stacks its DOM INSIDE that container. `card` is what claims; the three
  // widgets are what a form is actually made of.
  return (
    <div ref={ref} data-testid="grid" tabIndex={0}>
      <canvas data-testid="canvas" />
      <div data-testid="card">
        <select data-testid="dropdown">
          <option>a</option>
          <option>b</option>
        </select>
        <button data-testid="ok">OK</button>
        <input data-testid="field" />
      </div>
    </div>
  );
}

let root: Root;
let host: HTMLDivElement;

async function mount(): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const initial: GridState = getInitialState();
  await act(async () => {
    root.render(
      <GridProvider initialState={initial}>
        <Harness />
      </GridProvider>,
    );
  });
  containerEl = host.querySelector("[data-testid='grid']") as HTMLDivElement;
}

function el(testid: string): HTMLElement {
  return host.querySelector(`[data-testid='${testid}']`) as HTMLElement;
}

function card(): HTMLElement {
  return el("card");
}

/**
 * Press a key AT a specific element, the way the browser does when that element
 * holds focus: the event is dispatched on it and bubbles to the container the
 * hook listens on, carrying that element as its target.
 */
async function pressOn(target: HTMLElement, key: string): Promise<boolean> {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  await act(async () => {
    target.dispatchEvent(event);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return event.defaultPrevented;
}

function cellOf(sel: Selection | null): string {
  if (!sel) return "none";
  return `r${sel.endRow}c${sel.endCol}`;
}

// ---------------------------------------------------------------------------

describe("the grid's keyboard door honours a pointer claim", () => {
  beforeEach(() => {
    deleteCalls = 0;
    observedSelection = null;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  // -------------------------------------------------------------------------
  // The data loss
  // -------------------------------------------------------------------------

  it("Delete from a claimed <select> does NOT clear the user's cells", async () => {
    await mount();
    claimPointer(card(), "placement-1");

    await pressOn(el("dropdown"), "Delete");

    // Pre-fix: 1. `onDelete` is the grid's clear-contents over the selection.
    expect(deleteCalls).toBe(0);
  });

  it("Delete from a claimed <button> does NOT clear the user's cells either", async () => {
    await mount();
    claimPointer(card(), "placement-1");

    await pressOn(el("ok"), "Delete");

    expect(deleteCalls).toBe(0);
  });

  it("Backspace from a claimed widget does not clear them either", async () => {
    await mount();
    claimPointer(card(), "placement-1");

    await pressOn(el("dropdown"), "Backspace");

    expect(deleteCalls).toBe(0);
  });

  // -------------------------------------------------------------------------
  // The dropdown could not be operated at all
  // -------------------------------------------------------------------------

  it("ArrowDown in a claimed <select> moves nothing and is left for the widget", async () => {
    await mount();
    claimPointer(card(), "placement-1");
    expect(cellOf(observedSelection)).toBe("r4c0");

    const prevented = await pressOn(el("dropdown"), "ArrowDown");

    // Pre-fix: the cell cursor went r4c0 -> r5c0 and the key came back
    // defaultPrevented, so the browser never changed the dropdown's value.
    expect(cellOf(observedSelection)).toBe("r4c0");
    expect(prevented).toBe(false);
  });

  it("ArrowRight in a claimed <button> moves nothing", async () => {
    await mount();
    claimPointer(card(), "placement-1");

    await pressOn(el("ok"), "ArrowRight");

    expect(cellOf(observedSelection)).toBe("r4c0");
  });

  // -------------------------------------------------------------------------
  // The positive control: an over-broad guard fails HERE
  // -------------------------------------------------------------------------

  it("Delete with focus genuinely in the grid still clears the cells", async () => {
    await mount();
    claimPointer(card(), "placement-1");

    await pressOn(el("canvas"), "Delete");

    expect(deleteCalls).toBe(1);
  });

  it("ArrowDown with focus genuinely in the grid still moves the cursor", async () => {
    await mount();
    claimPointer(card(), "placement-1");

    await pressOn(containerEl, "ArrowDown");

    expect(cellOf(observedSelection)).toBe("r5c0");
  });

  it("with nobody claiming, the same card's widgets are the grid's again", async () => {
    await mount();
    // No claim at all: the card is just DOM, and the grid keeps its keys. This
    // is what says the guard reads the CLAIM and not the card's shape.
    await pressOn(el("ok"), "Delete");

    expect(deleteCalls).toBe(1);
  });

  // -------------------------------------------------------------------------
  // The control that proves the guard's SHAPE was already right
  // -------------------------------------------------------------------------

  it("a plain <input> keeps working whether or not the card claims", async () => {
    await mount();
    // Unclaimed: the tag list already exempted it, and still does.
    await pressOn(el("field"), "Delete");
    expect(deleteCalls).toBe(0);

    claimPointer(card(), "placement-1");
    await pressOn(el("field"), "Delete");
    expect(deleteCalls).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Releasing the claim
  // -------------------------------------------------------------------------

  it("releasing the claim gives the keyboard back to the grid", async () => {
    await mount();
    claimPointer(card(), "placement-1");
    await pressOn(el("ok"), "Delete");
    expect(deleteCalls).toBe(0);

    releasePointerClaim(card());
    await pressOn(el("ok"), "Delete");
    expect(deleteCalls).toBe(1);
  });

  // -------------------------------------------------------------------------
  // A HIDDEN claimant holds nothing
  // -------------------------------------------------------------------------

  it("a claimant hidden with display:none does not hold the keyboard", async () => {
    await mount();
    claimPointer(card(), "placement-1");
    // What the embedded form layer's `hideHost` does to a card that scrolled out
    // of view or whose sheet is not the active one: the element stays, so the
    // ATTRIBUTE stays. The pointer never noticed because a hidden element is not
    // hit-tested; the keyboard has no such filter of its own.
    card().style.display = "none";

    await pressOn(el("ok"), "Delete");

    expect(deleteCalls).toBe(1);
  });

  it("showing the card again restores its hold on the keyboard", async () => {
    await mount();
    claimPointer(card(), "placement-1");
    card().style.display = "none";
    await pressOn(el("ok"), "Delete");
    expect(deleteCalls).toBe(1);

    card().style.display = "block";
    await pressOn(el("ok"), "Delete");

    // Still 1: the second press was refused.
    expect(deleteCalls).toBe(1);
  });
});
