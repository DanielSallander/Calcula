//! FILENAME: app/src/shell/FormulaBar/__tests__/nameBoxEditFlag.test.tsx
// PURPOSE: Typing in the Name Box never raises Core's CELL-edit flag (E12).
// CONTEXT: The Name Box raised `setGlobalIsEditing(true)` on focus and lowered
//          it on blur, Escape, a finished entry and a press elsewhere. That flag
//          means "Core's own cell edit is open" (core/lib/cellEditFlag.ts): no
//          cell edit stood behind it, every door that asks it (Undo/Redo, the
//          grid's commit-before-select, the keybinding dispatcher's live-edit
//          rule) answered as if one did, and a Name Box unmounted while focused
//          (a layout change, the formula bar hidden) left it up for good. The
//          Name Box is a text field: the dispatcher already treats keys typed
//          into it as typing. Same doubles as nameBoxNavigation.test.tsx.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({ setGlobalIsEditing: vi.fn() }));
const dispatch = vi.fn();
const gridState = {
  selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
  sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" },
};

vi.mock("../../../api", () => ({
  useGridContext: () => ({ state: gridState, dispatch }),
  setSelection: (payload: unknown) => ({ type: "SET_SELECTION", payload }),
  scrollToCell: (row: number, col: number) => ({ type: "SCROLL_TO_CELL", row, col }),
  setActiveSheet: (index: number, name: string) => ({ type: "SET_ACTIVE_SHEET", index, name }),
  columnToLetter: (col: number) => String.fromCharCode(65 + col),
  getMergeInfo: () => Promise.resolve(null),
  getNamedRangeForSelection: () => Promise.resolve(null),
  getAllNamedRanges: () => Promise.resolve([]),
  createNamedRange: vi.fn(),
  getNamedRange: () => Promise.resolve(null),
  getSheets: () => Promise.resolve({ sheets: [{ name: "Sheet1", index: 0 }], activeIndex: 0 }),
  setActiveSheetApi: vi.fn(),
  primeSheetSwitch: vi.fn(),
  showToast: vi.fn(),
  // eslint-disable-next-line @typescript-eslint/naming-convention
  AppEvents: {
    NAMED_RANGES_CHANGED: "app:named-ranges-changed",
    CHART_SELECTION_CHANGED: "app:chart-selection-changed",
    NAMEBOX_FOCUS: "app:namebox-focus",
    SHEET_CHANGED: "app:sheet-changed",
  },
  emitAppEvent: vi.fn(),
  onAppEvent: () => () => {},
}));
vi.mock("../../../api/lib", () => ({ resolveNamedRangeCoords: vi.fn() }));
vi.mock("../../../api/backend", () => ({
  getTableAtCell: vi.fn(async () => null),
  getTableByName: vi.fn(async () => null),
  getAllTables: vi.fn(async () => []),
  resolveStructuredReference: vi.fn(async () => ({ success: false, error: "Table not found" })),
}));
vi.mock("../../../api/editing", () => ({ setGlobalIsEditing: h.setGlobalIsEditing }));

import { NameBox } from "../NameBox";

let container: HTMLDivElement;
let root: Root;

function box(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>("input[aria-label='Name Box']");
  if (!input) throw new Error("Name Box input not rendered");
  return input;
}

beforeEach(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  h.setGlobalIsEditing.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<NameBox />);
  });
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("the Name Box and Core's cell-edit flag (E12)", () => {
  it("focusing and typing in the box raise nothing -- no cell edit stands behind them", async () => {
    const input = box();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      input.focus();
      setter.call(input, "B7");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(h.setGlobalIsEditing, "the Name Box raised Core's cell-edit flag").not.toHaveBeenCalledWith(true);
  });

  it("an unmount while the box is focused leaves nothing raised", async () => {
    await act(async () => {
      box().focus();
    });
    act(() => root.unmount());
    root = createRoot(container);
    expect(h.setGlobalIsEditing).not.toHaveBeenCalledWith(true);
  });
});
