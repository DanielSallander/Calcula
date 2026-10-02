//! FILENAME: app/src/shell/FormulaBar/__tests__/formulaInputSelectionOwner.test.tsx
// PURPOSE: While an OBJECT holds the selection on a worksheet (a slicer, a
//          timeline, a chart, a shape, a floating grid selected whole --
//          @api/selectionOwner), the formula bar is not a door to the active
//          cell hidden behind it: it shows nothing, is read-only, and focusing
//          it opens NO edit of that cell (BUG-0270 review, findings 3 and 7).
// CONTEXT: Every keyboard door already refused while the claim held, but the
//          bar resolved no external source ("none"), showed Core's hidden cell
//          and, on focus, called startEdit(selection.endRow, endCol): typing in
//          the bar and pressing Enter wrote the cell behind the slicer. Excel
//          greys the bar out while a slicer or a chart is selected. The claim
//          is the REAL store (a fallback owner registered here, the shape of
//          ObjectPosition's generic claim); the editing hook is the doubles of
//          formulaInputEditFlag.test.tsx.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  gridState: {
    selection: { startRow: 3, startCol: 2, endRow: 3, endCol: 2 } as null | {
      startRow: number;
      startCol: number;
      endRow: number;
      endCol: number;
    },
    referenceStyle: "A1",
    surface: "grid" as "grid" | "canvas",
  },
  editing: null as null | { row: number; col: number; value: string },
  dispatch: vi.fn(),
  startEdit: vi.fn(async () => undefined),
}));

vi.mock("../../../api", () => ({
  useGridContext: () => ({ state: h.gridState, dispatch: h.dispatch }),
  getCell: () => Promise.resolve({ formula: "", display: "Keep me" }),
  getMergeInfo: () => Promise.resolve(null),
  isSheetProtected: () => Promise.resolve(false),
  getCellProtection: () => Promise.resolve({ formulaHidden: false }),
  checkRangeGuards: () => null,
  getSpillRanges: () => Promise.resolve([]),
}));

vi.mock("../../../api/editing", () => ({
  useEditing: () => ({
    editing: h.editing,
    updateValue: vi.fn(),
    commitEdit: vi.fn(async () => ({ success: true })),
    cancelEdit: vi.fn(async () => undefined),
    startEdit: h.startEdit,
  }),
  setGlobalIsEditing: vi.fn(),
  getGlobalEditingValue: () => "",
  setGlobalCursorPosition: vi.fn(),
  getGlobalCursorPosition: () => 0,
  setChartSeriesRefMode: vi.fn(),
}));

vi.mock("../../../api/formulaAutocomplete", () => ({
  isFormulaAutocompleteVisible: () => false,
  AutocompleteEvents: { INPUT: "ac:input", KEY: "ac:key", ACCEPTED: "ac:accepted" },
}));

import { FormulaInput } from "../FormulaInput";
import { __resetExternalEditForTests } from "../../../core/lib/formulaEditTarget";
import { notifySelectionOwnershipChanged, registerSelectionOwner } from "../../../api/selectionOwner";
import { registerToastSink, type ToastPayload } from "../../../api/notifications";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const SENTENCE = (action: string) => `${action} is not available while an object is selected.`;

let container: HTMLDivElement;
let root: Root;
let owned = false;
let releaseOwner: (() => void) | null = null;
const toasts: ToastPayload[] = [];
registerToastSink((t) => toasts.push(t));

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(React.createElement(FormulaInput));
  });
  await flush();
}

const bar = (): HTMLInputElement => container.querySelector("input[data-formula-bar]") as HTMLInputElement;

async function focusBar(): Promise<void> {
  await act(async () => {
    bar().focus();
  });
  await flush();
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  h.editing = null;
  h.gridState.selection = { startRow: 3, startCol: 2, endRow: 3, endCol: 2 };
  h.gridState.surface = "grid";
  h.startEdit.mockClear();
  toasts.length = 0;
  owned = false;
  releaseOwner = registerSelectionOwner({
    id: "test.selectedObject",
    label: "the selected object",
    fallback: true,
    ownsSelection: () => owned,
    refusal: SENTENCE,
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  releaseOwner?.();
  releaseOwner = null;
  __resetExternalEditForTests();
});

describe("the formula bar while an object holds the selection on a worksheet", () => {
  it("focusing it opens NO edit of the hidden cell, refuses ONCE with the owner's sentence, and gives the focus back", async () => {
    owned = true;
    await render();
    await focusBar();
    expect(h.startEdit, "focusing the bar opened an edit of the cell BEHIND the selected object").not.toHaveBeenCalled();
    expect(toasts.map((t) => t.message)).toEqual([SENTENCE("Edit Cell")]);
    expect(document.activeElement, "the bar kept the focus with nothing it may edit").not.toBe(bar());
  });

  it("it shows NOTHING and is read-only -- never the hidden cell's content", async () => {
    owned = true;
    await render();
    expect(bar().readOnly, "the bar is editable over the cell behind the object").toBe(true);
    expect(bar().value, "the bar shows the content of the cell hidden behind the object").toBe("");
  });

  it("follows the claim: it starts and ends while the bar is on screen", async () => {
    await render();
    expect(bar().readOnly, "control: Core's grid holds the selection").toBe(false);
    owned = true;
    notifySelectionOwnershipChanged();
    await flush();
    expect(bar().readOnly, "the bar did not hear the object take the selection").toBe(true);
    owned = false;
    notifySelectionOwnershipChanged();
    await flush();
    expect(bar().readOnly, "the bar stayed read-only after the object let go").toBe(false);
  });

  it("control: with Core's grid holding the selection, focusing opens the active cell's edit and says nothing", async () => {
    await render();
    await focusBar();
    expect(h.startEdit).toHaveBeenCalledWith(3, 2);
    expect(toasts).toEqual([]);
  });
});
