//! FILENAME: app/src/shell/FormulaBar/__tests__/nameBoxObjectLabel.test.tsx
// PURPOSE: The Name Box shows the OBJECT label the canvas publishes through
//          `@api/objectSelectionLabel` -- a slicer's, a floating range's, a
//          pivot box's or a control's name, and "N objects" for a
//          multi-selection -- with the precedence
//            multi-object label > chart rung > object label > defined name >
//            table > address,
//          and stays blank on a canvas with nothing selected.
// CONTEXT: Both registries are REAL (dependency-free stores); only the @api
//          barrel, @api/lib, @api/backend and @api/editing are stubbed, the way
//          the sibling Name Box files stub them.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const dispatch = vi.fn();

const gridState: {
  selection: { startRow: number; startCol: number; endRow: number; endCol: number } | null;
  surface?: "grid" | "canvas";
  sheetContext: { activeSheetIndex: number; activeSheetName: string };
} = {
  selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
  sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" },
};

let namedRange: { name: string } | null = null;

vi.mock("../../../api", () => ({
  useGridContext: () => ({ state: gridState, dispatch }),
  setSelection: (payload: unknown) => ({ type: "SET_SELECTION", payload }),
  scrollToCell: (row: number, col: number) => ({ type: "SCROLL_TO_CELL", row, col }),
  setActiveSheet: (index: number, name: string) => ({ type: "SET_ACTIVE_SHEET", index, name }),
  columnToLetter: (col: number) => String.fromCharCode(65 + col),
  getMergeInfo: () => Promise.resolve(null),
  getNamedRangeForSelection: () => Promise.resolve(namedRange),
  getAllNamedRanges: () => Promise.resolve([]),
  createNamedRange: () => Promise.resolve({ success: true, error: null }),
  getNamedRange: () => Promise.resolve(null),
  getSheets: () => Promise.resolve({ sheets: [{ name: "Sheet1" }], activeIndex: 0 }),
  setActiveSheetApi: () => Promise.resolve({ sheets: [{ name: "Sheet1" }], activeIndex: 0 }),
  primeSheetSwitch: () => Promise.resolve(undefined),
  showToast: vi.fn(),
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
  resolveNamedRangeCoords: vi.fn(),
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

async function label(text: string | null, count = 1): Promise<void> {
  await act(async () => {
    publishObjectLabel("canvasSheet", text === null ? null : { text, count });
  });
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  dispatch.mockReset();
  namedRange = null;
  gridState.selection = { startRow: 1, startCol: 1, endRow: 1, endCol: 1 };
  gridState.surface = undefined;
  resetChartSelectionRegistry();
  resetObjectLabelRegistry();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  resetChartSelectionRegistry();
  resetObjectLabelRegistry();
});

describe("Name Box follows the published object label", () => {
  it("on a canvas with nothing selected the box is blank", async () => {
    gridState.surface = "canvas";
    gridState.selection = null;
    await paint();
    expect(boxValue()).toBe("");
  });

  it("shows a selected object's name on a canvas, and goes blank again when it is withdrawn", async () => {
    gridState.surface = "canvas";
    gridState.selection = null;
    await paint();
    await label("Slicer_Region");
    expect(boxValue()).toBe("Slicer_Region");
    await label(null);
    expect(boxValue()).toBe("");
  });

  it("shows 'N objects' for a multi-selection", async () => {
    gridState.surface = "canvas";
    gridState.selection = null;
    await paint();
    await label("3 objects", 3);
    expect(boxValue()).toBe("3 objects");
  });

  it("a chart's rung beats a single object's label...", async () => {
    await paint();
    await act(async () => {
      publishChartSelection({ chartId: "c1", chartName: "Chart 1", level: "chart" });
    });
    await label("Chart 1 (object)");
    // The registry's own wording, read back rather than spelled out here.
    expect(boxValue()).toBe(chartSelectionDisplayName({ chartId: "c1", chartName: "Chart 1", level: "chart" }));
  });

  it("...but a MULTI-selection's 'N objects' beats the chart rung", async () => {
    await paint();
    await act(async () => {
      publishChartSelection({ chartId: "c1", chartName: "Chart 1", level: "series", seriesIndex: 0 });
    });
    await label("2 objects", 2);
    expect(boxValue()).toBe("2 objects");
  });

  it("an object label beats a defined name and the address", async () => {
    namedRange = { name: "MyRange" };
    await paint();
    expect(boxValue()).toBe("MyRange");
    await label("Sales");
    expect(boxValue()).toBe("Sales");
    await label(null);
    expect(boxValue()).toBe("MyRange");
  });

  it("with no label a worksheet shows the address exactly as before", async () => {
    await paint();
    expect(boxValue()).toBe("B2");
  });

  it("picks up a label published BEFORE it mounted", async () => {
    gridState.surface = "canvas";
    gridState.selection = null;
    publishObjectLabel("canvasSheet", "Timeline_Date");
    await paint();
    expect(boxValue()).toBe("Timeline_Date");
  });
});
