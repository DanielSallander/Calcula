//! FILENAME: app/src/shell/FormulaBar/__tests__/nameBoxChartSelection.test.tsx
// PURPOSE: The Name Box shows the chart selection the `@api/chartSelection`
//          REGISTRY publishes, and derives nothing of its own from it.
// CONTEXT: The shell used to subscribe to the raw `CHART_SELECTION_CHANGED`
//          CustomEvent and pick `chartName` out of the payload by hand — one of
//          the three hand re-derivations the registry was added to retire, and
//          the reason the box printed "Chart 1" however deep the ladder had
//          gone. Selecting a series, a point, an axis or the chart title all
//          looked identical to a reader.
//
//          The registry is REAL here, not doubled: it is a dependency-free
//          store, and doubling it would make this a test of the double. Only the
//          @api barrel, @api/lib, @api/backend and @api/editing are stubbed, the
//          way the sibling Name Box files stub them.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

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
  publishChartSelection,
  resetChartSelectionRegistry,
  chartSelectionDisplayName,
  type ChartSelectionTarget,
} from "../../../api/chartSelection";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

async function paint(): Promise<void> {
  await act(async () => {
    root.render(<NameBox />);
  });
  // The table / named-range effects each await a promise before settling.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Mount, then move the selection — the box syncs its input text on a CHANGE of
 * the displayed value and starts empty, so a component that never saw anything
 * move shows nothing at all. Same shape as nameBoxTables.test.tsx, and the same
 * shape as the app, which mounts on A1 and then lands somewhere.
 */
async function render(): Promise<void> {
  await paint();
  gridState.selection = { startRow: 1, startCol: 1, endRow: 1, endCol: 1 };
  await paint();
}

function boxValue(): string {
  const input = container.querySelector<HTMLInputElement>("input[aria-label='Name Box']");
  if (!input) throw new Error("Name Box input not rendered");
  return input.value;
}

async function publish(target: ChartSelectionTarget | null): Promise<void> {
  await act(async () => {
    publishChartSelection(target);
  });
}

function chart(extra: Partial<ChartSelectionTarget>): ChartSelectionTarget {
  return { chartId: "c1", chartName: "Chart 1", level: "chart", ...extra };
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  dispatch.mockReset();
  resetChartSelectionRegistry();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  resetChartSelectionRegistry();
});

// ---------------------------------------------------------------------------
// The routing
// ---------------------------------------------------------------------------

describe("Name Box follows the published chart selection", () => {
  it("shows the cell address while no chart is selected", async () => {
    await render();
    expect(boxValue()).toBe("B2");
  });

  it("shows the registry's display name for every rung of the ladder", async () => {
    await render();

    // These are the registry's OWN answers, read back from it rather than
    // spelled out here: a literal list would be a second copy of the wording,
    // which is the duplication this whole change removes.
    const rungs: ChartSelectionTarget[] = [
      chart({ level: "chart" }),
      chart({ level: "series", seriesIndex: 0, seriesName: "North" }),
      chart({ level: "dataPoint", seriesIndex: 1, categoryIndex: 2, categoryName: "Q3" }),
      chart({ level: "axis", axisType: "y" }),
      chart({ level: "element", elementId: "title" }),
      chart({ level: "element", elementId: "xAxisTitle" }),
      chart({ level: "element", elementId: "legend" }),
      chart({ level: "element", elementId: "legendEntry", seriesIndex: 1 }),
    ];

    for (const rung of rungs) {
      await publish(rung);
      expect(boxValue()).toBe(chartSelectionDisplayName(rung));
    }
  });

  it("distinguishes the rungs from each other, not just from the address", async () => {
    // The defect this replaces printed the chart NAME at every rung, so a test
    // that only compared against the registry would have passed on it too if
    // the registry were the thing that was wrong. These must all differ.
    await render();
    const seen: string[] = [];
    for (const rung of [
      chart({ level: "series", seriesIndex: 0 }),
      chart({ level: "dataPoint", seriesIndex: 0, categoryIndex: 1 }),
      chart({ level: "axis", axisType: "x" }),
      chart({ level: "element", elementId: "title" }),
      chart({ level: "element", elementId: "legend" }),
    ]) {
      await publish(rung);
      seen.push(boxValue());
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).not.toContain("Chart 1");
  });

  it("goes back to the address when the selection is cleared", async () => {
    await render();
    await publish(chart({ level: "series", seriesIndex: 0 }));
    expect(boxValue()).not.toBe("B2");
    await publish(null);
    expect(boxValue()).toBe("B2");
  });

  it("picks up a selection published BEFORE it mounted", async () => {
    // The Name Box can mount with a chart already selected (a panel toggle, a
    // re-mount after a sheet switch), and nothing will publish again for it.
    // This is why `chartLabel` starts "" and the subscribing effect does the
    // first read: seeding the state from the registry instead would make the
    // label correct at the first render and therefore never sync into the
    // input, which renders a BLANK box.
    await publish(chart({ level: "element", elementId: "title" }));
    await paint();
    expect(boxValue()).toBe("Chart Title");
  });

  it("stops listening when it unmounts", async () => {
    await render();
    await act(async () => {
      root.unmount();
    });
    // No listener left to throw into, and nothing to update.
    expect(() => publishChartSelection(chart({ level: "series", seriesIndex: 0 }))).not.toThrow();
    // Re-mounting for the shared afterEach teardown.
    root = createRoot(container);
  });
});
