//! FILENAME: app/src/shell/FormulaBar/__tests__/nameBoxTables.test.tsx
// PURPOSE: The Name Box must know a workbook's TABLES, in both directions.
// CONTEXT: It knew none of them. The display fell back chart name -> named
//          range -> address, both off `state.named_ranges`; the Enter handler
//          resolved an address or a defined name and nothing else; and the
//          dropdown listed `getAllNamedRanges()` alone. So with the cursor on a
//          table the box showed A6:C9, typing "Sales" DEFINED A NEW NAME over
//          whatever happened to be selected instead of going to the table, and
//          the table was absent from the list of things you could go to.
//
//          None of that produced an error, which is the point of these cases.
//          "Sales" typed into the box came back looking like a success — a name
//          really was created — and the user got a name they did not ask for
//          instead of the navigation they did.
//
//          Tables and defined names deliberately share ONE namespace
//          (`tables.rs` refuses a name that shadows a table), which is why a
//          table name in this box is meaningful at all.
//
//          Mocked: the @api barrel, @api/lib, @api/backend and @api/editing.
//          The address/structured-reference parser and the dropdown are real.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

const dispatch = vi.fn();
const getMergeInfoMock = vi.fn();
const getNamedRangeMock = vi.fn();
const getAllNamedRangesMock = vi.fn();
const resolveNamedRangeCoordsMock = vi.fn();
const createNamedRangeMock = vi.fn();
const setActiveSheetApiMock = vi.fn();
const primeSheetSwitchMock = vi.fn();
const showToastMock = vi.fn();

const getTableAtCellMock = vi.fn();
const getTableByNameMock = vi.fn();
const getAllTablesMock = vi.fn();
const resolveStructuredReferenceMock = vi.fn();

const gridState = {
  selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
  sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" },
};

const SHEETS = [{ name: "Sheet1" }, { name: "Sheet2" }];

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
  getAllNamedRanges: (...args: unknown[]) => getAllNamedRangesMock(...args),
  createNamedRange: (...args: unknown[]) => createNamedRangeMock(...args),
  getNamedRange: (...args: unknown[]) => getNamedRangeMock(...args),
  getSheets: () =>
    Promise.resolve({ sheets: SHEETS, activeIndex: gridState.sheetContext.activeSheetIndex }),
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
    TABLE_CREATED: "app:table-created",
    TABLE_DEFINITIONS_UPDATED: "app:table-definitions-updated",
  },
  emitAppEvent: vi.fn(),
  onAppEvent: () => () => {},
}));

vi.mock("../../../api/lib", () => ({
  resolveNamedRangeCoords: (...args: unknown[]) => resolveNamedRangeCoordsMock(...args),
}));

vi.mock("../../../api/backend", () => ({
  getTableAtCell: (...args: unknown[]) => getTableAtCellMock(...args),
  getTableByName: (...args: unknown[]) => getTableByNameMock(...args),
  getAllTables: (...args: unknown[]) => getAllTablesMock(...args),
  resolveStructuredReference: (...args: unknown[]) => resolveStructuredReferenceMock(...args),
}));

vi.mock("../../../api/editing", () => ({
  setGlobalIsEditing: vi.fn(),
}));

import { NameBox } from "../NameBox";

// ---------------------------------------------------------------------------
// The fixture: "Sales" at A5:C10 on Sheet1, header row + totals row.
// Its data body is therefore A6:C9.
// ---------------------------------------------------------------------------

const SALES = {
  id: "t-1",
  name: "Sales",
  sheetIndex: 0,
  startRow: 4,
  startCol: 0,
  endRow: 9,
  endCol: 2,
  columns: [{ name: "Region" }, { name: "Units" }, { name: "Margin" }],
  styleOptions: { headerRow: true, totalRow: true },
};

const SALES_DATA = { sheetIndex: 0, startRow: 5, startCol: 0, endRow: 8, endCol: 2 };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

async function paint(): Promise<void> {
  await act(async () => {
    root.render(<NameBox />);
  });
  // The table-matching effect is a chain of awaits; a macrotask hop drains it.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Mount, then move the selection — because the box syncs its input text on a
 * CHANGE of the displayed value and starts empty, so a component that never
 * saw the selection move shows nothing at all. Mounting on A1 and then landing
 * on the block under test is also what the app does.
 */
async function render(
  selection?: { startRow: number; startCol: number; endRow: number; endCol: number },
): Promise<void> {
  await paint();
  if (selection) {
    gridState.selection = selection;
    await paint();
  }
}

function box(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>("input[aria-label='Name Box']");
  if (!input) throw new Error("Name Box input not rendered");
  return input;
}

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
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Open the dropdown the way a click on the arrow does. */
async function openDropdown(): Promise<void> {
  const arrow = container.querySelector("[aria-label='Show named ranges']");
  if (!arrow) throw new Error("dropdown arrow not rendered");
  await act(async () => {
    arrow.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function lastSelection(): Record<string, unknown> | null {
  const calls = dispatch.mock.calls.filter((c) => c[0]?.type === "SET_SELECTION");
  return calls.length ? (calls[calls.length - 1][0].payload as Record<string, unknown>) : null;
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  dispatch.mockReset();
  getMergeInfoMock.mockReset().mockResolvedValue(null);
  getNamedRangeMock.mockReset().mockResolvedValue(null);
  getAllNamedRangesMock.mockReset().mockResolvedValue([]);
  resolveNamedRangeCoordsMock.mockReset();
  createNamedRangeMock.mockReset().mockResolvedValue({ success: true, error: null });
  setActiveSheetApiMock
    .mockReset()
    .mockImplementation((index: number) => Promise.resolve({ sheets: SHEETS, activeIndex: index }));
  primeSheetSwitchMock.mockReset().mockResolvedValue(undefined);
  showToastMock.mockReset();

  getTableAtCellMock.mockReset().mockResolvedValue(null);
  getTableByNameMock.mockReset().mockResolvedValue(null);
  getAllTablesMock.mockReset().mockResolvedValue([]);
  resolveStructuredReferenceMock
    .mockReset()
    .mockResolvedValue({ success: false, error: "Table not found" });

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

describe("Name Box - showing a table's name", () => {
  beforeEach(() => {
    getTableAtCellMock.mockResolvedValue(SALES);
    resolveStructuredReferenceMock.mockImplementation(async (ref: string) =>
      ref === "Sales[#Data]" ? { success: true, resolved: SALES_DATA } : { success: false, error: "Table not found" },
    );
  });

  it("shows the bare table name when the DATA body is selected", async () => {
    await render({ startRow: 5, startCol: 0, endRow: 8, endCol: 2 });

    expect(box().value).toBe("Sales");
  });

  it("shows Sales[#All] when the whole table is selected", async () => {
    await render({ startRow: 4, startCol: 0, endRow: 9, endCol: 2 });

    expect(box().value).toBe("Sales[#All]");
  });

  it("shows Sales[Margin] when one column's data is selected", async () => {
    await render({ startRow: 5, startCol: 2, endRow: 8, endCol: 2 });

    expect(box().value).toBe("Sales[Margin]");
  });

  it("shows the ADDRESS for a single cell inside the table, as Excel does", async () => {
    await render({ startRow: 6, startCol: 1, endRow: 6, endCol: 1 });

    expect(box().value).toBe("B7");
    // ...and it does not even ask, so arrow-key navigation stays off IPC.
    expect(getTableAtCellMock).not.toHaveBeenCalled();
  });

  it("shows the address for a block that is not one of the table's own", async () => {
    await render({ startRow: 5, startCol: 0, endRow: 6, endCol: 1 });

    expect(box().value).toBe("A6:B7");
  });
});

describe("Name Box - going to a table by name", () => {
  it("SELECTS the table's data instead of defining a name over the selection", async () => {
    getTableByNameMock.mockResolvedValue(SALES);
    resolveStructuredReferenceMock.mockResolvedValue({ success: true, resolved: SALES_DATA });
    await render();
    await commit("Sales");

    expect(resolveStructuredReferenceMock).toHaveBeenCalledWith("Sales[#Data]");
    expect(lastSelection()).toMatchObject({
      startRow: 5,
      startCol: 0,
      endRow: 8,
      endCol: 2,
    });
    // The defect: this used to create a name called Sales and report success.
    expect(createNamedRangeMock).not.toHaveBeenCalled();
  });

  it("uses the table's own spelling of its name, not the user's casing", async () => {
    getTableByNameMock.mockResolvedValue(SALES);
    resolveStructuredReferenceMock.mockResolvedValue({ success: true, resolved: SALES_DATA });
    await render();
    await commit("sALES");

    expect(resolveStructuredReferenceMock).toHaveBeenCalledWith("Sales[#Data]");
  });

  it("switches to the SHEET the table lives on", async () => {
    getTableByNameMock.mockResolvedValue({ ...SALES, sheetIndex: 1 });
    resolveStructuredReferenceMock.mockResolvedValue({
      success: true,
      resolved: { ...SALES_DATA, sheetIndex: 1 },
    });
    await render();
    await commit("Sales");

    expect(setActiveSheetApiMock).toHaveBeenCalledWith(1);
    expect(lastSelection()).toMatchObject({ startRow: 5, endRow: 8 });
  });

  it("still defines a new name when no table and no name has that spelling", async () => {
    gridState.selection = { startRow: 0, startCol: 0, endRow: 4, endCol: 0 };
    await render();
    await commit("Forecast");

    expect(createNamedRangeMock).toHaveBeenCalledWith("Forecast", null, "=Sheet1!$A$1:$A$5");
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it("lets a DEFINED NAME answer first — the two share one namespace", async () => {
    getNamedRangeMock.mockResolvedValue({ name: "Sales", refersTo: "=Sheet1!$E$1:$E$3" });
    resolveNamedRangeCoordsMock.mockResolvedValue({
      sheetIndex: 0,
      startRow: 0,
      startCol: 4,
      endRow: 2,
      endCol: 4,
    });
    await render();
    await commit("Sales");

    expect(lastSelection()).toMatchObject({ startCol: 4, endCol: 4 });
    expect(getTableByNameMock).not.toHaveBeenCalled();
  });
});

describe("Name Box - structured references", () => {
  it("goes to a column: Sales[Margin]", async () => {
    resolveStructuredReferenceMock.mockResolvedValue({
      success: true,
      resolved: { sheetIndex: 0, startRow: 5, startCol: 2, endRow: 8, endCol: 2 },
    });
    await render();
    await commit("Sales[Margin]");

    expect(resolveStructuredReferenceMock).toHaveBeenCalledWith("Sales[Margin]");
    expect(lastSelection()).toMatchObject({ startCol: 2, endCol: 2, startRow: 5, endRow: 8 });
  });

  it("goes to the whole table: Sales[#All]", async () => {
    resolveStructuredReferenceMock.mockResolvedValue({
      success: true,
      resolved: { sheetIndex: 0, startRow: 4, startCol: 0, endRow: 9, endCol: 2 },
    });
    await render();
    await commit("Sales[#All]");

    expect(lastSelection()).toMatchObject({ startRow: 4, endRow: 9 });
  });

  it("never reaches the create-a-name branch, whatever the backend answers", async () => {
    resolveStructuredReferenceMock.mockResolvedValue({
      success: false,
      error: "Invalid column or specifier",
    });
    await render();
    await commit("Sales[NoSuchColumn]");

    expect(createNamedRangeMock).not.toHaveBeenCalled();
    expect(lastSelection()).toBeNull();
    expect(showToastMock).toHaveBeenCalledTimes(1);
    expect(String(showToastMock.mock.calls[0][0])).toContain("Invalid column or specifier");
  });

  it("says the entry is unreadable BEFORE asking the backend, for a broken bracket", async () => {
    await render();
    await commit("Sales[Margin");

    expect(resolveStructuredReferenceMock).not.toHaveBeenCalled();
    expect(createNamedRangeMock).not.toHaveBeenCalled();
    expect(showToastMock).toHaveBeenCalledTimes(1);
    // The text stays put so the user can fix it.
    expect(box().value).toBe("Sales[Margin");
  });

  it("round-trips what the box DISPLAYS: Sales[#All] typed back goes to the table", async () => {
    // Anything this box shows must be something this box accepts. Before the
    // fix, the displayed spelling was refused with a sentence about cell
    // references — the box arguing with itself.
    resolveStructuredReferenceMock.mockResolvedValue({
      success: true,
      resolved: { sheetIndex: 0, startRow: 4, startCol: 0, endRow: 9, endCol: 2 },
    });
    await render();
    await commit("Sales[#All]");

    expect(showToastMock).not.toHaveBeenCalled();
    expect(lastSelection()).toMatchObject({ startRow: 4, startCol: 0, endRow: 9, endCol: 2 });
  });
});

describe("Name Box - the dropdown lists tables too", () => {
  it("shows the workbook's names AND the sheet's tables, ordered together", async () => {
    getAllNamedRangesMock.mockResolvedValue([
      { name: "Zeta", sheetIndex: null, refersTo: "=Sheet1!$Z$1" },
      { name: "alpha", sheetIndex: null, refersTo: "=Sheet1!$A$1" },
    ]);
    getAllTablesMock.mockResolvedValue([SALES]);
    await render();
    await openDropdown();

    const text = container.textContent ?? "";
    expect(text).toContain("Sales");
    expect(text).toContain("alpha");
    expect(text).toContain("Zeta");
    // Case-insensitive order, tables interleaved: alpha, Sales, Zeta.
    expect(text.indexOf("alpha")).toBeLessThan(text.indexOf("Sales"));
    expect(text.indexOf("Sales")).toBeLessThan(text.indexOf("Zeta"));
  });

  it("shows the table's range next to it", async () => {
    getAllTablesMock.mockResolvedValue([SALES]);
    await render();
    await openDropdown();

    expect(container.textContent ?? "").toContain("=Sheet1!$A$5:$C$10");
  });

  it("opens a picked TABLE through the table route, not the named-range one", async () => {
    getAllTablesMock.mockResolvedValue([SALES]);
    resolveStructuredReferenceMock.mockResolvedValue({ success: true, resolved: SALES_DATA });
    await render();
    await openDropdown();

    // The name cell inside the row; mousedown bubbles up to the row's handler.
    const row = Array.from(container.querySelectorAll("*")).find(
      (el) => el.textContent === "Sales",
    );
    expect(row, "the dropdown should list Sales").toBeTruthy();
    await act(async () => {
      row!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(resolveStructuredReferenceMock).toHaveBeenCalledWith("Sales[#Data]");
    // resolve_named_range_coords knows nothing about tables and would refuse it.
    expect(resolveNamedRangeCoordsMock).not.toHaveBeenCalled();
    expect(lastSelection()).toMatchObject({ startRow: 5, endRow: 8 });
  });
});
