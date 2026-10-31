//! FILENAME: app/extensions/Charts/components/__tests__/quickAccessElements.test.tsx
// PURPOSE: The chart quick-access Elements (+) popup offers only the elements
//          the chart HAS (BUG-0446). Excel's Chart Elements button on a pie
//          offers Chart Title, Data Labels and Legend -- no axis titles,
//          gridlines, axis labels or data table (live Excel 16, 2026-10-30: a
//          pie/doughnut has HasAxis False on both axes, refuses the gridlines
//          element and keeps HasDataTable False). An axis chart keeps them all.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ChartSpec } from "../../types";

let currentSpec: ChartSpec | null = null;

vi.mock("../../lib/chartStore", () => ({
  getChartById: () => (currentSpec ? { id: "c1", spec: currentSpec } : undefined),
  updateChartSpec: vi.fn(),
  syncChartRegions: vi.fn(),
}));
vi.mock("../../rendering/chartRenderer", () => ({
  invalidateChartCache: vi.fn(),
  getCachedChartData: () => undefined,
}));
vi.mock("../../rendering/quickAccessButtons", () => ({ closePopup: vi.fn() }));
vi.mock("@api/events", () => ({ emitAppEvent: vi.fn(), AppEvents: { GRID_REFRESH: "grid-refresh" } }));

import { QuickAccessPopup } from "../QuickAccessPopup";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

function spec(mark: string): ChartSpec {
  return {
    mark,
    data: "Sheet1!A1:D4",
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: true, position: "bottom" },
    palette: "default",
  } as ChartSpec;
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  currentSpec = null;
});

function elementLabels(mark: string): string[] {
  currentSpec = spec(mark);
  act(() => {
    root.render(
      <QuickAccessPopup
        onClose={() => {}}
        data={{ chartId: "c1", buttonType: "elements", screenX: 10, screenY: 10 }}
      />,
    );
  });
  return Array.from(host.querySelectorAll("label")).map((l) => l.textContent ?? "");
}

const AXIS_ROWS = ["X Axis Title", "Y Axis Title", "Gridlines", "Axis Labels", "Data Table"];

describe("Chart Elements (+) popup", () => {
  it.each(["pie", "donut", "funnel"])("a %s chart offers Title, Legend and Data Labels only", (mark) => {
    const labels = elementLabels(mark);
    expect(labels).toEqual(["Chart Title", "Legend", "Data Labels"]);
    for (const row of AXIS_ROWS) expect(labels).not.toContain(row);
  });

  it("an axis chart (column) keeps the axis rows (positive control)", () => {
    const labels = elementLabels("bar");
    for (const row of AXIS_ROWS) expect(labels).toContain(row);
  });
});
