//! FILENAME: app/src/shell/FormulaBar/__tests__/formulaBarFxSelectionOwner.test.tsx
// PURPOSE: The fx button is not a door to the active cell hidden behind a
//          selected OBJECT (BUG-0270 review, finding 7): while an object holds
//          the selection on a worksheet (@api/selectionOwner), fx refuses with
//          the owner's sentence, opens no edit and no Insert Function dialog.
// CONTEXT: fx called startEditing("=") on Core's selection whenever no
//          floating-grid cell was the subject, so with a slicer or a chart
//          selected it opened an edit of the cell behind the object and the
//          function then chosen was written there. The claim is the REAL store;
//          the editing hook and the dialog are doubles (the
//          formulaBarBuiltFormula.test.tsx shape).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FORMULA_BAR_DEFAULT_EXPANDED_HEIGHT } from "../../../core/types";

const h = vi.hoisted(() => ({ startEditing: vi.fn(async () => undefined) }));

vi.mock("../../../api/editing", () => ({
  useEditing: () => ({
    editing: null,
    isEditing: false,
    updateValue: vi.fn(),
    commitEdit: vi.fn(async () => null),
    cancelEdit: vi.fn(async () => undefined),
    startEdit: vi.fn(),
    startEditing: h.startEditing,
  }),
  setGlobalIsEditing: vi.fn(),
  getGlobalEditingValue: () => "",
  setGlobalCursorPosition: vi.fn(),
  getGlobalCursorPosition: () => 0,
  setChartSeriesRefMode: vi.fn(),
}));

const gridState = {
  selection: { startRow: 7, startCol: 3, endRow: 7, endCol: 3 },
  referenceStyle: "A1",
  formulaBarExpanded: false,
  formulaBarHeight: FORMULA_BAR_DEFAULT_EXPANDED_HEIGHT,
};

vi.mock("../../../api", () => ({
  useGridContext: () => ({ state: gridState, dispatch: vi.fn() }),
}));

vi.mock("../NameBox", () => ({ NameBox: () => null }));
vi.mock("../FormulaInput", () => ({ FormulaInput: () => null }));
vi.mock("../InsertFunctionDialog", () => ({
  InsertFunctionDialog: () => React.createElement("div", { "data-testid": "insert-function-dialog" }),
}));

import { FormulaBar } from "../FormulaBar";
import { registerSelectionOwner } from "../../../api/selectionOwner";
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
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
}

function clickFx(): void {
  const el = [...container.querySelectorAll("button")].find((b) => b.getAttribute("title") === "Insert Function");
  if (!el) throw new Error("the fx button did not render");
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

const dialogShown = (): boolean => container.querySelector("[data-testid='insert-function-dialog']") !== null;

beforeEach(async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  h.startEditing.mockClear();
  toasts.length = 0;
  owned = false;
  releaseOwner = registerSelectionOwner({
    id: "test.selectedObject",
    label: "the selected object",
    fallback: true,
    ownsSelection: () => owned,
    refusal: SENTENCE,
  });
  await act(async () => {
    root.render(React.createElement(FormulaBar));
  });
  await flush();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  releaseOwner?.();
  releaseOwner = null;
});

describe("fx while an object holds the selection on a worksheet", () => {
  it("refuses ONCE with the owner's sentence: no edit of the hidden cell, no Insert Function dialog", async () => {
    owned = true;
    clickFx();
    await flush();
    expect(h.startEditing, "fx opened an edit of the cell BEHIND the selected object").not.toHaveBeenCalled();
    expect(dialogShown(), "the dialog opened with nothing it may write to").toBe(false);
    expect(toasts.map((t) => t.message)).toEqual([SENTENCE("Insert Function")]);
  });

  it("control: with Core's grid holding the selection, fx starts the '=' edit and opens the dialog", async () => {
    clickFx();
    await flush();
    expect(h.startEditing).toHaveBeenCalledWith("=");
    expect(dialogShown()).toBe(true);
    expect(toasts).toEqual([]);
  });
});
