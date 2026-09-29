//! FILENAME: app/src/shell/FormulaBar/__tests__/formulaInputEditFlag.test.tsx
// PURPOSE: Focusing the formula bar never raises Core's edit flag by itself:
//          only an edit that actually OPENS raises it (startEdit does, after
//          its guards). E12.
// CONTEXT: FormulaInput's handleFocus raised the flag BEFORE calling startEdit
//          -- and raised it even with no selection to edit. When startEdit then
//          refused (a canvas, a range guard, an edit guard such as Format
//          Painter's), nothing lowered it: Core believed a cell edit was open,
//          and Ctrl+Z / Ctrl+Y stood down (BUG-0199's stuck flag). Wave A added
//          a heal in useEditing; the flag is now simply raised in the right
//          place. Same doubles as formulaInputExternalEdit.test.tsx.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  gridState: {
    selection: null as null | { startRow: number; startCol: number; endRow: number; endCol: number },
    referenceStyle: "A1",
    surface: "grid" as "grid" | "canvas",
  },
  editing: null as null | { row: number; col: number; value: string },
  dispatch: vi.fn(),
  /** A startEdit that REFUSES: it returns without opening anything. */
  startEdit: vi.fn(async () => undefined),
  setGlobalIsEditing: vi.fn(),
}));

vi.mock("../../../api", () => ({
  useGridContext: () => ({ state: h.gridState, dispatch: h.dispatch }),
  getCell: () => Promise.resolve({ formula: "", display: "7" }),
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
  setGlobalIsEditing: h.setGlobalIsEditing,
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

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root;

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

async function focusBar(): Promise<void> {
  const el = container.querySelector("input[data-formula-bar]") as HTMLInputElement;
  await act(async () => {
    el.focus();
  });
  await flush();
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  h.editing = null;
  h.gridState.selection = null;
  h.gridState.surface = "grid";
  h.dispatch.mockClear();
  h.startEdit.mockClear();
  h.setGlobalIsEditing.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  __resetExternalEditForTests();
});

describe("FormulaInput focus and Core's edit flag (E12)", () => {
  it("a REFUSED open raises nothing: the bar asks startEdit, and only startEdit may raise the flag", async () => {
    h.gridState.selection = { startRow: 1, startCol: 1, endRow: 1, endCol: 1 };
    await render();
    await focusBar();
    expect(h.startEdit).toHaveBeenCalledWith(1, 1);
    expect(h.setGlobalIsEditing, "the bar raised Core's edit flag itself").not.toHaveBeenCalledWith(true);
  });

  it("with NO selection to edit on a worksheet, focusing raises nothing and opens nothing", async () => {
    await render();
    await focusBar();
    expect(h.startEdit).not.toHaveBeenCalled();
    expect(h.setGlobalIsEditing).not.toHaveBeenCalledWith(true);
  });
});
