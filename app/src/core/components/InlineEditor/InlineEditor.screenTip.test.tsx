//! FILENAME: app/src/core/components/InlineEditor/InlineEditor.screenTip.test.tsx
// PURPOSE: The in-cell editor must announce the CARET, not only the text.
//
// CONTEXT: The function screen tip answers "which argument of which call am I
//          standing in". That answer changes when the caret moves with the
//          formula untouched — arrowing out of `SUM` into a nested `ROUND` — and
//          it has an answer the moment an edit OPENS on a cell that already
//          holds a formula. Neither moment changes the value, and
//          `autocomplete:input` used to be emitted only from onChange, so F2
//          into `=VLOOKUP(...)` produced no tip at all and arrowing between
//          calls never switched it.
//
//          Opening is the case a component test has to be careful with: focus
//          is placed programmatically inside a setTimeout, and a programmatic
//          focus fires no select event — which is exactly why the announcement
//          has to be made explicitly there and cannot be left to onSelect.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("../../lib/tauri-api", () => ({
  getViewportCells: async () => [],
}));
vi.mock("../../../api/formulaAutocomplete", () => ({
  isFormulaAutocompleteVisible: () => false,
  AutocompleteEvents: { INPUT: "ac:input", KEY: "ac:key", ACCEPTED: "ac:accepted" },
}));
vi.mock("../../../api/columnAutocomplete", () => ({
  isColumnAutocompleteVisible: () => false,
  ColumnAutocompleteEvents: { KEY: "cac:key", ACCEPTED: "cac:accepted" },
}));

import { InlineEditor } from "./InlineEditor";
import { GridProvider } from "../../state/GridContext";
import { getInitialState } from "../../state/gridReducer";
import { setGlobalCursorPosition } from "../../hooks/useEditing";
import {
  DEFAULT_GRID_CONFIG,
  createEmptyDimensionOverrides,
  type EditingCell,
  type GridConfig,
  type Viewport,
} from "../../types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const CONFIG: GridConfig = {
  ...DEFAULT_GRID_CONFIG,
  defaultCellWidth: 64,
  defaultCellHeight: 20,
  rowHeaderWidth: 50,
  colHeaderHeight: 24,
  totalRows: 1000,
  totalCols: 100,
};

const VIEWPORT: Viewport = {
  scrollX: 0,
  scrollY: 0,
  startRow: 0,
  startCol: 0,
  rowCount: 30,
  colCount: 20,
};

let host: HTMLDivElement;
let root: Root;
let announced: Array<{ value: string; cursorPosition: number; source: string }>;

function onInput(e: Event): void {
  announced.push((e as CustomEvent).detail);
}

function editorEl(): HTMLTextAreaElement {
  const el = host.querySelector("[data-inline-editor]");
  if (!el) throw new Error("the inline editor did not render");
  return el as HTMLTextAreaElement;
}

/** Open an edit on the cell and let the deferred focus/announce pass run. */
async function openEditor(value: string): Promise<void> {
  const editing: EditingCell = { row: 3, col: 2, value } as EditingCell;
  await act(async () => {
    root.render(
      <GridProvider initialState={getInitialState()}>
        <InlineEditor
          editing={editing}
          config={CONFIG}
          viewport={VIEWPORT}
          dimensions={createEmptyDimensionOverrides()}
          onValueChange={() => {}}
          onCommit={async () => true}
          onCancel={() => {}}
        />
      </GridProvider>,
    );
  });
  // The editor focuses itself from a setTimeout(0), and announces from there.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

/**
 * Open an edit with the caret placement made INVISIBLE to the select machinery,
 * so that an announcement carrying the OPENED caret can only have come from the
 * editor's own deliberate emit.
 *
 * Focusing an element makes jsdom report a selection change that React turns
 * into an onSelect — an announcement no editor code is responsible for. It is
 * free here and must not be relied on: a browser that stays silent for a caret
 * placed programmatically (which is how this editor opens: focus inside a
 * setTimeout, never a user gesture) would leave the tip with nothing at all,
 * which is the defect being fixed. Stubbing setSelectionRange leaves that
 * incidental announcement reporting the caret the element still HAS (0) rather
 * than the one the editor placed, which is what makes the two tellable apart.
 */
async function openEditorWithoutSelectEcho(value: string): Promise<void> {
  const real = HTMLTextAreaElement.prototype.setSelectionRange;
  HTMLTextAreaElement.prototype.setSelectionRange = function noop(): void {};
  try {
    await openEditor(value);
  } finally {
    HTMLTextAreaElement.prototype.setSelectionRange = real;
  }
}

/**
 * Move the caret the way a user does. React derives onSelect from the input
 * events around a selection change (keyup/mouseup), never from a synthetic
 * `select` event — so the keyup is what makes this a real caret move rather
 * than a direct call to the handler.
 */
function moveCaret(pos: number): void {
  const el = editorEl();
  act(() => {
    el.setSelectionRange(pos, pos);
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "ArrowRight" }));
  });
}

describe("InlineEditor announces where the caret is, not only what was typed", () => {
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    announced = [];
    window.addEventListener("ac:input", onInput);
    setGlobalCursorPosition(0);
  });

  afterEach(() => {
    window.removeEventListener("ac:input", onInput);
    act(() => root.unmount());
    host.remove();
  });

  it("announces the formula the edit opened on", async () => {
    // F2 on a cell that already holds a formula, with the caret restored inside
    // the call — the moment the tip is supposed to appear.
    setGlobalCursorPosition(6);
    await openEditorWithoutSelectEcho("=SUM(A1,B1)");

    const opened = announced.filter((a) => a.cursorPosition === 6);
    expect(
      opened,
      "opening an edit on an existing formula announced nothing about the " +
        "caret it opened at, so the tip only ever appeared after the first " +
        "keystroke",
    ).toHaveLength(1);
    expect(opened[0].value).toBe("=SUM(A1,B1)");
    expect(opened[0].source).toBe("inline");
  });

  it("announces a caret move inside the formula", async () => {
    await openEditor("=ROUND(SUM(A1,B1),2)");
    announced = [];

    moveCaret(13);

    expect(
      announced,
      "the caret moved into a nested call and nothing was told about it — the " +
        "tip cannot switch to a call it never hears about",
    ).toHaveLength(1);
    expect(announced[0].value).toBe("=ROUND(SUM(A1,B1),2)");
    expect(announced[0].cursorPosition).toBe(13);
  });

  it("says nothing about a plain value, opened or navigated", async () => {
    await openEditor("Quarterly revenue");
    expect(announced).toHaveLength(0);

    moveCaret(4);
    expect(announced).toHaveLength(0);
  });
});
