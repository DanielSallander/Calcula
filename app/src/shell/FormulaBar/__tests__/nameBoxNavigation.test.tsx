//! FILENAME: app/src/shell/FormulaBar/__tests__/nameBoxNavigation.test.tsx
// PURPOSE: What the Name Box DOES with what the user types.
// CONTEXT: Two silent wrong answers live here, and neither produced an error.
//
//          1. A RANGE DID NOTHING. "A1:A10" missed the single-cell regex, missed
//             the defined-name lookup and missed `isValidName`, so Enter fell
//             out of all three branches and quietly restored the old address —
//             no selection, no scroll, no message. Indistinguishable, from the
//             user's chair, from the app having ignored the keypress.
//          2. A NAME ON ANOTHER SHEET SELECTED THE WRONG CELLS. The old code
//             matched `refersTo` with an inline regex that captured the sheet
//             prefix and then THREW IT AWAY, so a workbook-scoped name pointing
//             at Sheet3 selected those coordinates on whatever sheet happened to
//             be active. Resolution is the backend's now.
//
//          Mocked: the @api barrel, @api/lib and @api/editing. The address
//          parser, the styled-components markup and the dropdown are real.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

const dispatch = vi.fn();
const getMergeInfoMock = vi.fn();
const getNamedRangeMock = vi.fn();
const resolveNamedRangeCoordsMock = vi.fn();
const createNamedRangeMock = vi.fn();
const setActiveSheetApiMock = vi.fn();
const primeSheetSwitchMock = vi.fn();
const showToastMock = vi.fn();

const gridState = {
  selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
  sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" },
};

const SHEETS = [{ name: "Sheet1" }, { name: "Sheet2" }, { name: "My Sheet" }];

vi.mock("../../../api", () => ({
  useGridContext: () => ({ state: gridState, dispatch }),
  setSelection: (payload: unknown) => ({ type: "SET_SELECTION", payload }),
  scrollToCell: (row: number, col: number) => ({ type: "SCROLL_TO_CELL", row, col }),
  setActiveSheet: (index: number, name: string) => ({
    type: "SET_ACTIVE_SHEET",
    index,
    name,
  }),
  columnToLetter: (col: number) => {
    let n = col;
    let out = "";
    do {
      out = String.fromCharCode(65 + (n % 26)) + out;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return out;
  },
  getMergeInfo: (...args: unknown[]) => getMergeInfoMock(...args),
  getNamedRangeForSelection: () => Promise.resolve(null),
  getAllNamedRanges: () => Promise.resolve([]),
  createNamedRange: (...args: unknown[]) => createNamedRangeMock(...args),
  getNamedRange: (...args: unknown[]) => getNamedRangeMock(...args),
  getSheets: () => Promise.resolve({ sheets: SHEETS, activeIndex: gridState.sheetContext.activeSheetIndex }),
  setActiveSheetApi: (...args: unknown[]) => setActiveSheetApiMock(...args),
  primeSheetSwitch: (...args: unknown[]) => primeSheetSwitchMock(...args),
  showToast: (...args: unknown[]) => showToastMock(...args),
  // The key names ARE the @api export names; the naming rule cannot know that.
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

vi.mock("../../../api/lib", () => ({
  resolveNamedRangeCoords: (...args: unknown[]) => resolveNamedRangeCoordsMock(...args),
}));

vi.mock("../../../api/editing", () => ({
  setGlobalIsEditing: vi.fn(),
}));

import { NameBox } from "../NameBox";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

async function render(): Promise<void> {
  await act(async () => {
    root.render(<NameBox />);
  });
}

function box(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>("input[aria-label='Name Box']");
  if (!input) throw new Error("Name Box input not rendered");
  return input;
}

/** Type into the box and press Enter, the way a user commits an entry. */
async function commit(text: string): Promise<void> {
  const input = box();
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    input.focus();
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
  });
  // The Enter handler is a CHAIN of awaits (name lookup -> coordinate
  // resolution -> sheet list -> sheet switch -> merge info). A macrotask hop
  // drains the whole microtask queue; counting `await Promise.resolve()` turns
  // would silently under-drain the moment a step is added.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** The payload of the last SET_SELECTION dispatched, or null if there was none. */
function lastSelection(): Record<string, unknown> | null {
  const calls = dispatch.mock.calls.filter((c) => c[0]?.type === "SET_SELECTION");
  return calls.length ? (calls[calls.length - 1][0].payload as Record<string, unknown>) : null;
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  dispatch.mockReset();
  getMergeInfoMock.mockReset().mockResolvedValue(null);
  getNamedRangeMock.mockReset().mockResolvedValue(null);
  resolveNamedRangeCoordsMock.mockReset();
  createNamedRangeMock.mockReset().mockResolvedValue({ success: true, error: null });
  setActiveSheetApiMock
    .mockReset()
    .mockImplementation((index: number) => Promise.resolve({ sheets: SHEETS, activeIndex: index }));
  primeSheetSwitchMock.mockReset().mockResolvedValue(undefined);
  showToastMock.mockReset();
  gridState.selection = { startRow: 0, startCol: 0, endRow: 0, endCol: 0 };
  gridState.sheetContext = { activeSheetIndex: 0, activeSheetName: "Sheet1" };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------------------

describe("Name Box - typing a range", () => {
  it("SELECTS the range and scrolls to it (it used to do nothing at all)", async () => {
    await render();
    await commit("A1:B10");

    expect(lastSelection()).toEqual({
      startRow: 0,
      startCol: 0,
      endRow: 9,
      endCol: 1,
      type: "cells",
    });
    expect(dispatch.mock.calls.some((c) => c[0]?.type === "SCROLL_TO_CELL")).toBe(true);
    // A range is NOT expanded to its top-left cell's merged block.
    expect(getMergeInfoMock).not.toHaveBeenCalled();
    expect(createNamedRangeMock).not.toHaveBeenCalled();
  });

  it("accepts the absolute spelling", async () => {
    await render();
    await commit("$A$1:$B$10");
    expect(lastSelection()).toMatchObject({ startRow: 0, startCol: 0, endRow: 9, endCol: 1 });
  });

  it("selects whole columns for A:B", async () => {
    await render();
    await commit("A:B");
    expect(lastSelection()).toMatchObject({ startCol: 0, endCol: 1, type: "columns" });
  });
});

describe("Name Box - a single cell", () => {
  it("still expands to the merged block it lands in", async () => {
    getMergeInfoMock.mockResolvedValue({ startRow: 1, startCol: 1, endRow: 2, endCol: 3 });
    await render();
    await commit("B2");

    expect(getMergeInfoMock).toHaveBeenCalledWith(1, 1);
    expect(lastSelection()).toMatchObject({ startRow: 1, startCol: 1, endRow: 2, endCol: 3 });
  });
});

describe("Name Box - sheet-qualified entries", () => {
  it("switches sheets for Sheet2!A1", async () => {
    await render();
    await commit("Sheet2!A1");

    expect(setActiveSheetApiMock).toHaveBeenCalledWith(1);
    expect(lastSelection()).toMatchObject({ startRow: 0, startCol: 0 });
  });

  it("accepts a quoted sheet name with a space", async () => {
    await render();
    await commit("'My Sheet'!A1:B2");

    expect(setActiveSheetApiMock).toHaveBeenCalledWith(2);
    expect(lastSelection()).toMatchObject({ startRow: 0, startCol: 0, endRow: 1, endCol: 1 });
  });

  it("says so when the sheet does not exist, and selects nothing", async () => {
    await render();
    await commit("NoSuchSheet!A1");

    expect(setActiveSheetApiMock).not.toHaveBeenCalled();
    expect(lastSelection()).toBeNull();
    expect(showToastMock).toHaveBeenCalledTimes(1);
    expect(String(showToastMock.mock.calls[0][0])).toContain("NoSuchSheet");
  });
});

describe("Name Box - defined names", () => {
  it("goes to the SHEET the name lives on, not the one that happens to be active", async () => {
    getNamedRangeMock.mockResolvedValue({ name: "SalesData", refersTo: "=Sheet2!$C$3:$D$4" });
    resolveNamedRangeCoordsMock.mockResolvedValue({
      sheetIndex: 1,
      startRow: 2,
      startCol: 2,
      endRow: 3,
      endCol: 3,
    });
    await render();
    await commit("SalesData");

    expect(setActiveSheetApiMock).toHaveBeenCalledWith(1);
    expect(lastSelection()).toMatchObject({ startRow: 2, startCol: 2, endRow: 3, endCol: 3 });
  });

  it("reports a name that refers to something unselectable instead of closing in silence", async () => {
    getNamedRangeMock.mockResolvedValue({ name: "Rate", refersTo: "=0.25" });
    resolveNamedRangeCoordsMock.mockRejectedValue(new Error("not a range"));
    await render();
    await commit("Rate");

    expect(lastSelection()).toBeNull();
    expect(showToastMock).toHaveBeenCalledTimes(1);
    expect(String(showToastMock.mock.calls[0][0])).toContain("Rate");
  });
});

describe("Name Box - entries it cannot honour", () => {
  it("TELLS THE USER instead of silently putting the old address back", async () => {
    await render();
    await commit("A1:");

    expect(lastSelection()).toBeNull();
    expect(createNamedRangeMock).not.toHaveBeenCalled();
    expect(showToastMock).toHaveBeenCalledTimes(1);
    expect(showToastMock.mock.calls[0][1]).toMatchObject({ variant: "error" });
    // The text stays put so the user can fix it, rather than being thrown away.
    expect(box().value).toBe("A1:");
  });

  it("reports a refused definition rather than logging it to the console", async () => {
    createNamedRangeMock.mockResolvedValue({
      success: false,
      error: "A table named 'Sales' already exists.",
    });
    await render();
    await commit("Sales");

    expect(createNamedRangeMock).toHaveBeenCalled();
    expect(showToastMock).toHaveBeenCalledTimes(1);
    expect(String(showToastMock.mock.calls[0][0])).toContain("already exists");
  });

  it("still defines a new name over the current selection when the backend accepts it", async () => {
    gridState.selection = { startRow: 0, startCol: 0, endRow: 4, endCol: 0 };
    await render();
    await commit("SalesData");

    expect(createNamedRangeMock).toHaveBeenCalledWith(
      "SalesData",
      null,
      "=Sheet1!$A$1:$A$5",
    );
    expect(showToastMock).not.toHaveBeenCalled();
  });
});
