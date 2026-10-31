//! FILENAME: app/extensions/Charts/components/data/__tests__/rangeSourceSeriesNames.test.tsx
// PURPOSE: The Create Chart dialog's series list names each series as the
//          chart's legend will (BUG-0448): it said B, C, D (column letters)
//          while the legend said Q1, Q2, Q3. A plotted series shows its own
//          name; an unplotted one shows its axis label (its header text when the
//          range has headers -- useRangeSource.test.tsx pins that part), and
//          ticking it back on names the new series by that label.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ChartSeries } from "../../../types";
import { RangeSourceEditor } from "../RangeSourceEditor";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

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
});

function render(series: ChartSeries[], axes: Array<{ index: number; label: string }>, onSeriesChange = vi.fn()): void {
  act(() => {
    root.render(
      <RangeSourceEditor
        sourceRange="Sheet1!A1:D4"
        onSourceRangeChange={() => {}}
        hasHeaders
        onHasHeadersChange={() => {}}
        orientation="columns"
        onOrientationChange={() => {}}
        categoryIndex={0}
        onCategoryIndexChange={() => {}}
        series={series}
        onSeriesChange={onSeriesChange}
        spec={null}
        onSpecChange={() => {}}
        availableAxes={axes}
        palette="default"
        testIdPrefix="t"
      />,
    );
  });
}

function shown(idx: number): string {
  return host.querySelector(`[data-testid="t-series-name-${idx}"]`)?.textContent ?? "";
}

describe("series list names", () => {
  it("a plotted series is listed by the name the legend shows, not its column letter", () => {
    render(
      [
        { name: "Q1", sourceIndex: 1, color: null },
        { name: "Q2", sourceIndex: 2, color: null },
        { name: "Q3", sourceIndex: 3, color: null },
      ],
      [
        { index: 0, label: "A" },
        { index: 1, label: "B" },
        { index: 2, label: "C" },
        { index: 3, label: "D" },
      ],
    );
    expect([1, 2, 3].map(shown)).toEqual(["Q1", "Q2", "Q3"]);
  });

  it("an unplotted series shows its header label, and ticking it names the series by it", () => {
    const onSeriesChange = vi.fn();
    render(
      [{ name: "Q1", sourceIndex: 1, color: null }],
      [
        { index: 0, label: "Region" },
        { index: 1, label: "Q1" },
        { index: 2, label: "Q2" },
      ],
      onSeriesChange,
    );
    expect(shown(2)).toBe("Q2");
    act(() => {
      host.querySelector<HTMLInputElement>('[data-testid="t-series-2"]')!.click();
    });
    expect(onSeriesChange).toHaveBeenLastCalledWith([
      { name: "Q1", sourceIndex: 1, color: null },
      { name: "Q2", sourceIndex: 2, color: null },
    ]);
  });
});
