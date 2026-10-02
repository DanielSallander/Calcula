//! FILENAME: app/src/shell/FormulaBar/__tests__/nameBoxExternalAddress.test.tsx
// PURPOSE: The Name Box names an EXTERNAL cell (a selected floating-grid cell:
//          "Float1!A1", "Float1!A1:B3") and ACCEPTS that spelling back -- on
//          this sheet or another -- and refuses to define a name over the wrong
//          cells while it shows one.
// CONTEXT: Before this the box could only say "Float1" (the object label) on a
//          canvas, and on a WORKSHEET it showed Core's last active cell, hidden
//          under the floating grid. Typing "Float1!B2" was refused with "There
//          is no sheet named Float1" -- a spelling the box itself would display
//          -- and typing a new name defined it over Core's hidden selection.
//
//          Precedence: multi-object > chart rung > EXTERNAL > object label >
//          defined name > table > address. The external-edit store is REAL (the
//          box reads it through the `api/externalEdit` subpath).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  dispatch: vi.fn(),
  createNamedRange: vi.fn(),
  setActiveSheetApi: vi.fn(),
  primeSheetSwitch: vi.fn(),
  showToast: vi.fn(),
  gridState: {
    selection: { startRow: 1, startCol: 1, endRow: 1, endCol: 1 } as null | {
      startRow: number;
      startCol: number;
      endRow: number;
      endCol: number;
    },
    surface: undefined as undefined | "grid" | "canvas",
    editing: null as null | { row: number; col: number; value: string },
    sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" },
  },
  log: [] as string[],
  /** What the Name Box list offers (getAllNamedRanges). */
  names: [] as { name: string; sheetIndex: number | null; refersTo: string }[],
  resolveCoords: vi.fn(),
}));

const SHEETS = [
  { name: "Sheet1", index: 0 },
  { name: "Report", index: 2, kind: "canvas" },
];

vi.mock("../../../api", () => ({
  useGridContext: () => ({ state: h.gridState, dispatch: h.dispatch }),
  setSelection: (payload: unknown) => ({ type: "SET_SELECTION", payload }),
  scrollToCell: (row: number, col: number) => ({ type: "SCROLL_TO_CELL", row, col }),
  setActiveSheet: (index: number, name: string, surface?: string) => ({ type: "SET_ACTIVE_SHEET", index, name, surface }),
  columnToLetter: (col: number) => String.fromCharCode(65 + col),
  getMergeInfo: () => Promise.resolve(null),
  getNamedRangeForSelection: () => Promise.resolve(null),
  getAllNamedRanges: () => Promise.resolve(h.names),
  createNamedRange: (...args: unknown[]) => h.createNamedRange(...args),
  getNamedRange: () => Promise.resolve(null),
  getSheets: () => Promise.resolve({ sheets: SHEETS, activeIndex: h.gridState.sheetContext.activeSheetIndex }),
  setActiveSheetApi: (...args: unknown[]) => h.setActiveSheetApi(...args),
  primeSheetSwitch: (...args: unknown[]) => h.primeSheetSwitch(...args),
  showToast: (...args: unknown[]) => h.showToast(...args),
  // The key names ARE the @api export names; the naming rule cannot know that.
  // eslint-disable-next-line @typescript-eslint/naming-convention
  AppEvents: {
    NAMED_RANGES_CHANGED: "app:named-ranges-changed",
    CHART_SELECTION_CHANGED: "app:chart-selection-changed",
    NAMEBOX_FOCUS: "app:namebox-focus",
    SHEET_CHANGED: "app:sheet-changed",
    TABLE_DEFINITIONS_UPDATED: "app:table-definitions-updated",
    TABLE_CREATED: "app:table-created",
  },
  emitAppEvent: vi.fn(),
  onAppEvent: () => () => {},
}));

vi.mock("../../../api/lib", () => ({
  resolveNamedRangeCoords: (...args: unknown[]) => h.resolveCoords(...args),
}));

vi.mock("../../../api/backend", () => ({
  getTableAtCell: vi.fn(async () => null),
  getTableByName: vi.fn(async () => null),
  getAllTables: vi.fn(async () => []),
  resolveStructuredReference: vi.fn(async () => ({ success: false, error: "Table not found" })),
}));

vi.mock("../../../api/editing", () => ({
  setGlobalIsEditing: vi.fn(),
}));

import { NameBox } from "../NameBox";
import {
  chartSelectionDisplayName,
  publishChartSelection,
  resetChartSelectionRegistry,
} from "../../../api/chartSelection";
import { publishObjectLabel, resetObjectLabelRegistry } from "../../../api/objectSelectionLabel";
import {
  registerExternalAddressResolver,
  __resetExternalEditForTests,
} from "../../../core/lib/formulaEditTarget";
import { createFakeExternalEdit } from "../../../core/lib/__tests__/helpers/fakeExternalEdit";
import { registerSelectionOwner } from "../../../api/selectionOwner";

let container: HTMLDivElement;
let root: Root;

async function paint(): Promise<void> {
  await act(async () => {
    root.render(<NameBox />);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function boxValue(): string {
  const input = container.querySelector<HTMLInputElement>("input[aria-label='Name Box']");
  if (!input) throw new Error("Name Box input not rendered");
  return input.value;
}

async function commit(text: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>("input[aria-label='Name Box']")!;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    input.focus();
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function publishCell(address: string): Promise<() => void> {
  let withdraw: () => void = () => undefined;
  await act(async () => {
    withdraw = createFakeExternalEdit({ hostSheetIndex: 0, address }).publishCell();
  });
  return async () => {
    await act(async () => withdraw());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  h.dispatch.mockReset();
  h.createNamedRange.mockReset().mockResolvedValue({ success: true, error: null });
  h.log = [];
  h.setActiveSheetApi.mockReset().mockImplementation((index: number) => {
    h.log.push(`switch:${index}`);
    return Promise.resolve({ sheets: SHEETS, activeIndex: index });
  });
  h.primeSheetSwitch.mockReset().mockResolvedValue(undefined);
  h.showToast.mockReset();
  h.names = [];
  h.resolveCoords.mockReset().mockResolvedValue({ sheetIndex: 0, startRow: 0, startCol: 0, endRow: 0, endCol: 0 });
  h.gridState.selection = { startRow: 1, startCol: 1, endRow: 1, endCol: 1 };
  h.gridState.surface = undefined;
  h.gridState.editing = null;
  h.gridState.sheetContext = { activeSheetIndex: 0, activeSheetName: "Sheet1" };
  resetChartSelectionRegistry();
  resetObjectLabelRegistry();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  __resetExternalEditForTests();
});

describe("Name Box -- what it SHOWS for an external cell", () => {
  it("on a worksheet: the floating-grid cell, not Core's hidden active cell", async () => {
    await paint();
    expect(boxValue()).toBe("B2");
    await publishCell("Float1!A1");
    expect(boxValue()).toBe("Float1!A1");
  });

  it("on a canvas: the CELL beats the floating grid's own label; withdrawn, the label comes back", async () => {
    h.gridState.selection = null;
    h.gridState.surface = "canvas";
    await paint();
    await act(async () => publishObjectLabel("canvasSheet", { text: "Float1", count: 1 }));
    expect(boxValue()).toBe("Float1");

    const withdraw = await publishCell("Float1!B3");
    expect(boxValue()).toBe("Float1!B3");

    await withdraw();
    expect(boxValue()).toBe("Float1");
  });

  it("a range reads as a range", async () => {
    await paint();
    await publishCell("Float1!A1:B3");
    expect(boxValue()).toBe("Float1!A1:B3");
  });

  it("a chart rung and a multi-object label both beat it", async () => {
    await paint();
    await publishCell("Float1!A1");
    await act(async () => {
      publishChartSelection({ chartId: 7, chartName: "Chart 1", level: "chart" });
    });
    expect(boxValue()).toBe(chartSelectionDisplayName({ chartId: 7, chartName: "Chart 1", level: "chart" }));
    await act(async () => resetChartSelectionRegistry());
    await act(async () => publishObjectLabel("canvasSheet", { text: "3 objects", count: 3 }));
    expect(boxValue()).toBe("3 objects");
  });

  it("a CORE edit wins: the box names the cell actually being edited", async () => {
    await paint();
    await publishCell("Float1!A1");
    expect(boxValue()).toBe("Float1!A1");
    h.gridState.editing = { row: 1, col: 1, value: "=1" };
    await paint();
    expect(boxValue()).toBe("B2");
  });
});

describe("Name Box -- what it ACCEPTS", () => {
  it("'Float1!B2' goes to the floating-grid cell -- never the 'no such sheet' refusal", async () => {
    const go = vi.fn(async () => null);
    registerExternalAddressResolver((text) => (text === "Float1!B2" ? { hostSheetIndex: 0, go } : null));
    await paint();

    await commit("Float1!B2");

    expect(go).toHaveBeenCalledTimes(1);
    expect(h.showToast).not.toHaveBeenCalled();
    expect(h.setActiveSheetApi).not.toHaveBeenCalled();
  });

  it("an address on ANOTHER sheet switches there first, THEN selects", async () => {
    const go = vi.fn(async () => {
      h.log.push("go");
      return null;
    });
    registerExternalAddressResolver(() => ({ hostSheetIndex: 2, go }));
    await paint();

    await commit("Float1!A1");

    expect(h.log).toEqual(["switch:2", "go"]);
    // The canvas host's surface travels with the switch.
    expect(h.dispatch).toHaveBeenCalledWith({ type: "SET_ACTIVE_SHEET", index: 2, name: "Report", surface: "canvas" });
  });

  it("the owner's refusal is shown, and the typed text kept", async () => {
    registerExternalAddressResolver(() => ({
      hostSheetIndex: 0,
      go: async () => '"Float1!Z99" is outside the floating grid "Float1" (A1:C5).',
    }));
    await paint();
    await commit("Float1!Z99");
    expect(h.showToast).toHaveBeenCalledWith(
      '"Float1!Z99" is outside the floating grid "Float1" (A1:C5).',
      { variant: "error" },
    );
  });

  it("a new name is NOT defined over Core's hidden selection while the box shows an external cell", async () => {
    await paint();
    await publishCell("Float1!A1");

    await commit("Totals");

    expect(h.createNamedRange).not.toHaveBeenCalled();
    expect(h.showToast).toHaveBeenCalledTimes(1);
    expect(String(h.showToast.mock.calls[0][0])).toContain("floating-grid cell");
  });

  it("positive control: with no external cell a new name is defined over the selection", async () => {
    await paint();
    await commit("Totals");
    expect(h.createNamedRange).toHaveBeenCalledWith("Totals", null, "=Sheet1!$B$2");
  });
});

describe("Name Box -- a new name is NOT defined over the cell hidden behind a selected OBJECT (BUG-0270 review)", () => {
  // With a slicer, a chart or a shape selected on a worksheet (the generic
  // "an object is selected" claim, @api/selectionOwner), Core's selection is
  // the active cell hidden behind the object. Typing a new name defined it
  // over THAT cell; only the floating-grid cell case was refused.
  const SENTENCE = (action: string) => `${action} is not available while an object is selected.`;
  let owned = false;
  let release: (() => void) | null = null;
  beforeEach(() => {
    owned = false;
    release = registerSelectionOwner({
      id: "test.selectedObject",
      label: "the selected object",
      fallback: true,
      ownsSelection: () => owned,
      refusal: SENTENCE,
    });
  });
  afterEach(() => {
    release?.();
    release = null;
  });

  it("refuses with the owner's sentence and defines nothing", async () => {
    owned = true;
    await paint();
    await commit("Totals");
    expect(h.createNamedRange, "a name was defined over the cell behind the selected object").not.toHaveBeenCalled();
    expect(h.showToast).toHaveBeenCalledTimes(1);
    expect(String(h.showToast.mock.calls[0][0])).toBe(SENTENCE("Define Name"));
  });

  it("control: an ADDRESS still navigates while an object is selected (going to a cell is the way back, not a write)", async () => {
    owned = true;
    await paint();
    await commit("C3");
    expect(h.createNamedRange).not.toHaveBeenCalled();
    expect(h.showToast).not.toHaveBeenCalled();
  });

  it("control: once the object let go, the same entry defines the name over the selection", async () => {
    await paint();
    await commit("Totals");
    expect(h.createNamedRange).toHaveBeenCalledWith("Totals", null, "=Sheet1!$B$2");
  });
});

describe("Name Box -- the NAME LIST asks the external owner first, as a typed entry does", () => {
  const FINISH = "Finish the formula you are editing (Enter) or cancel it (Esc) before going to another address.";

  async function pickFromList(name: string): Promise<void> {
    const arrow = container.querySelector<HTMLElement>("[aria-label='Show named ranges']");
    if (!arrow) throw new Error("the list arrow did not render");
    await act(async () => {
      arrow.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // The row's NAME label; the press bubbles to the row's own handler.
    const item = [...container.querySelectorAll<HTMLElement>("*")].find(
      (el) => el.children.length === 0 && el.textContent === name,
    );
    if (!item) throw new Error(`the list offers no "${name}"`);
    await act(async () => {
      item.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("while the owner refuses every navigation (a floating grid's formula picks a reference), a picked name goes nowhere and says why", async () => {
    // Review 2026-09-27 (FR finding 13, remaining door). The floating-range
    // resolver claims EVERY entry while its edit picks or is parked; the list
    // used to skip it and navigate -- `sheet:beforeSwitch` then ended the edit
    // without returning to its sheet.
    h.names = [{ name: "Totals", sheetIndex: null, refersTo: "=Sheet3!$A$1" }];
    const go = vi.fn(async () => FINISH);
    registerExternalAddressResolver(() => ({ hostSheetIndex: 0, go }));
    const beforeSwitch = vi.fn();
    window.addEventListener("sheet:beforeSwitch", beforeSwitch);
    try {
      await paint();
      await pickFromList("Totals");
      expect(go).toHaveBeenCalledTimes(1);
      expect(h.showToast).toHaveBeenCalledWith(FINISH, { variant: "error" });
      expect(h.resolveCoords).not.toHaveBeenCalled();
      expect(h.setActiveSheetApi).not.toHaveBeenCalled();
      expect(beforeSwitch).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("sheet:beforeSwitch", beforeSwitch);
    }
  });

  it("positive control: a resolver that declines leaves the pick to the box's own name route", async () => {
    h.names = [{ name: "Totals", sheetIndex: null, refersTo: "=Sheet1!$A$1" }];
    registerExternalAddressResolver(() => null);
    await paint();
    await pickFromList("Totals");
    expect(h.resolveCoords).toHaveBeenCalledWith("Totals");
    expect(h.showToast).not.toHaveBeenCalled();
  });
});
