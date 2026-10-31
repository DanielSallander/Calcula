//! FILENAME: app/extensions/Charts/components/__tests__/designTabComboSeries.test.tsx
// PURPOSE: The dialog's Design tab offers Column / Line per series on a combo
//          (Power BI's column-values and line-values wells), so a second series
//          can be made a column without the JSON Spec tab -- canvas-review
//          visuals finding: no UI could reach the stacked variant's stack.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ChartSpec } from "../../types";
import { DesignTab } from "../tabs/DesignTab";
import "../../rendering/chartDispatch";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root;
let changes: Array<Partial<ChartSpec>>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  changes = [];
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function spec(mark: string, markOptions?: Record<string, unknown>): ChartSpec {
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
    ...(markOptions ? { markOptions } : {}),
  } as ChartSpec;
}

const NAMES = ["North", "South", "Margin"];

function render(s: ChartSpec, names: string[] = NAMES): void {
  act(() => {
    root.render(<DesignTab spec={s} onSpecChange={(u) => changes.push(u)} previewSeriesNames={names} />);
  });
}

function select(testId: string): HTMLSelectElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function choose(el: HTMLSelectElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("combo: column or line per series", () => {
  it("shows what the painter draws: stacked -> all but the last are columns", () => {
    render(spec("combo", { stackMode: "stacked" }));
    expect(NAMES.map((_, i) => select(`chart-dialog-combo-series-${i}`)!.value)).toEqual(["bar", "bar", "line"]);
  });

  it("clustered shows the old default: the first is the column", () => {
    render(spec("combo"));
    expect(NAMES.map((_, i) => select(`chart-dialog-combo-series-${i}`)!.value)).toEqual(["bar", "line", "line"]);
  });

  it("making the second series a column writes every row's choice to seriesMarks", () => {
    render(spec("combo", { stackMode: "none" }));
    choose(select("chart-dialog-combo-series-1")!, "bar");
    expect(changes.at(-1)).toEqual({ markOptions: { stackMode: "none", seriesMarks: { 0: "bar", 1: "bar", 2: "line" } } });
  });

  it("Secondary Axis per series (Excel's Combo dialog) puts THAT series on the right-hand axis (BUG-0445)", () => {
    render(spec("combo"));
    const box = container.querySelector<HTMLInputElement>('[data-testid="chart-dialog-combo-secondary-2"]')!;
    expect(box.checked).toBe(false);
    act(() => box.click());
    expect(changes.at(-1)).toEqual({ markOptions: { secondaryYAxis: true, secondaryAxisSeries: [2] } });
  });

  it("unticking the last series on the secondary axis turns the axis off", () => {
    render(spec("combo", { secondaryYAxis: true, secondaryAxisSeries: [1] }));
    const box = container.querySelector<HTMLInputElement>('[data-testid="chart-dialog-combo-secondary-1"]')!;
    expect(box.checked).toBe(true);
    act(() => box.click());
    expect(changes.at(-1)).toEqual({ markOptions: { secondaryYAxis: false, secondaryAxisSeries: [] } });
  });

  // Excel ([LIVE] Excel 16, Series.AxisGroup = xlSecondary): moving the LAST
  // primary series to the secondary axis puts EVERY series back on primary and
  // removes the secondary axis; a one-series chart's only series stays primary.
  // SABOTAGE: drop the "next.size >= count" rule in setComboSeriesSecondary ->
  // the write carries every series on the secondary axis.
  it("ticking the last primary series puts every series back on primary, as Excel does", () => {
    render(spec("combo", { secondaryYAxis: true, secondaryAxisSeries: [1, 2] }));
    const box = container.querySelector<HTMLInputElement>('[data-testid="chart-dialog-combo-secondary-0"]')!;
    expect(box.checked).toBe(false);
    act(() => box.click());
    expect(changes.at(-1)).toEqual({ markOptions: { secondaryYAxis: false, secondaryAxisSeries: [] } });
  });

  it("a one-series combo's only series stays on the primary axis, as Excel does", () => {
    render(spec("combo"), ["Revenue"]);
    const box = container.querySelector<HTMLInputElement>('[data-testid="chart-dialog-combo-secondary-0"]')!;
    act(() => box.click());
    expect(changes.at(-1)).toEqual({ markOptions: { secondaryYAxis: false, secondaryAxisSeries: [] } });
  });

  // SABOTAGE: drop the "out.size >= count" rule in comboSecondarySeries -> a
  // stored all-secondary spec shows every box ticked.
  it("a stored spec with every series on the secondary axis is shown (and drawn) all-primary", () => {
    render(spec("combo", { secondaryYAxis: true, secondaryAxisSeries: [0, 1, 2] }));
    for (const si of [0, 1, 2]) {
      const box = container.querySelector<HTMLInputElement>(`[data-testid="chart-dialog-combo-secondary-${si}"]`)!;
      expect(box.checked, `series ${si}`).toBe(false);
    }
  });

  it("is not offered on other marks", () => {
    render(spec("bar"));
    expect(select("chart-dialog-combo-series-0")).toBeNull();
  });
});
