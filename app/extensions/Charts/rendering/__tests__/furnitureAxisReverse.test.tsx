//! FILENAME: app/extensions/Charts/rendering/__tests__/furnitureAxisReverse.test.tsx
// PURPOSE: "Reverse Axis" in the chart's axis context menu writes the flag the
//          PAINTER reads, and shows its tick from that same flag. (BUG-0123.)
//
// THE DEFECT: the menu wrote a TOP-LEVEL `axis.reverse`. The only reader of a
// reverse flag anywhere in the repository is `createScaleFromSpec`
// (rendering/scales.ts), which reads `axis.scale.reverse`. So the menu item
// dirtied the workbook, redrew the chart unchanged, and left its own tick unlit
// — while ChartFormatPane's "Values in reverse order", which writes
// `scale.reverse`, worked. Two spellings of one fact.
//
// THE TEST IS TWO-ENDED, which is what makes it a guard rather than a
// restatement: it asserts the patch the menu produces AND feeds that patch to
// the real scale factory, so a future edit that invents a third spelling fails
// on the second half even if someone updates the first.
//
// jsdom + react-dom directly: @testing-library/react is not installed in this
// repo, the same reason the sibling component tests drive `act` by hand.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { createScaleFromSpec } from "../scales";
import type { ChartDefinition, ChartSpec } from "../../types";

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

let store: ChartDefinition | null = null;
const patches: Array<Partial<ChartSpec>> = [];

vi.mock("../../lib/chartStore", () => ({
  getChartById: (id: string) => (store && store.chartId === id ? store : undefined),
  updateChartSpec: (id: string, patch: Partial<ChartSpec>) => {
    patches.push(patch);
    if (store && store.chartId === id) store.spec = { ...store.spec, ...patch };
  },
  syncChartRegions: () => undefined,
}));
vi.mock("../chartRenderer", () => ({ invalidateChartCache: () => undefined }));
vi.mock("@api", () => ({
  AppEvents: { GRID_REFRESH: "app:grid-refresh" },
  emitAppEvent: () => undefined,
  showDialog: () => undefined,
}));

import { AxisContextMenu } from "../../components/AxisContextMenu";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// ---------------------------------------------------------------------------
// Fixture + harness
// ---------------------------------------------------------------------------

function chart(yScaleReverse?: boolean): ChartDefinition {
  return {
    chartId: "c1",
    name: "Chart 1",
    sheetIndex: 0,
    x: 0,
    y: 0,
    width: 400,
    height: 300,
    spec: {
      mark: "bar",
      data: "Sheet1!A1:B4",
      hasHeaders: true,
      seriesOrientation: "columns",
      categoryIndex: 0,
      series: [{ name: "Sales", sourceIndex: 1, color: null }],
      title: null,
      xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
      yAxis: {
        title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null,
        ...(yScaleReverse === undefined ? {} : { scale: { reverse: yScaleReverse } }),
      },
      legend: { visible: true, position: "right" },
      palette: "default",
    } as ChartSpec,
  } as ChartDefinition;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  patches.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  store = null;
});

function render() {
  act(() => {
    root.render(
      React.createElement(AxisContextMenu, {
        onClose: () => undefined,
        data: { chartId: "c1", axisType: "y", screenX: 10, screenY: 10 },
      } as never),
    );
  });
}

/** The menu row whose label is exactly `text`. */
function row(text: string): HTMLElement {
  const found = Array.from(container.querySelectorAll("div")).find(
    (el) => el.children.length === 2 && el.textContent?.endsWith(text) && el.lastElementChild?.textContent === text,
  );
  if (!found) throw new Error(`no menu row labelled "${text}"`);
  return found as HTMLElement;
}

/** The check glyph (or "") on that row. */
function tick(text: string): string {
  return row(text).firstElementChild?.textContent ?? "";
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Reverse Axis writes the flag the painter reads", () => {
  it("patches scale.reverse, and NOT a top-level axis.reverse", () => {
    store = chart();
    render();
    act(() => { row("Reverse Axis").dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    expect(patches).toHaveLength(1);
    const yAxis = (patches[0] as { yAxis?: Record<string, unknown> }).yAxis!;
    expect(yAxis.scale).toEqual({ reverse: true });
    // The dead spelling must not come back. `in` rather than a truthiness
    // check: writing `reverse: false` would be just as dead.
    expect("reverse" in yAxis).toBe(false);
  });

  it("the flag it wrote is the one that actually flips the scale", () => {
    store = chart();
    render();
    act(() => { row("Reverse Axis").dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    const written = (patches[0] as { yAxis: ChartSpec["yAxis"] }).yAxis;
    const flipped = createScaleFromSpec(written.scale, [0, 100], [300, 40]);
    const plain = createScaleFromSpec(undefined, [0, 100], [300, 40]);
    expect(flipped.scale(0)).toBeCloseTo(plain.scale(100));
    expect(flipped.scale(100)).toBeCloseTo(plain.scale(0));
  });

  it("shows its tick from the live flag, and toggles back off", () => {
    store = chart(true);
    render();
    expect(tick("Reverse Axis")).toBe("✓");

    act(() => { row("Reverse Axis").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect((patches[0] as { yAxis: { scale: { reverse: boolean } } }).yAxis.scale.reverse).toBe(false);
  });

  it("leaves the rest of the scale alone", () => {
    store = chart();
    store.spec.yAxis.scale = { type: "log", nice: false };
    render();
    act(() => { row("Reverse Axis").dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    expect((patches[0] as { yAxis: { scale: Record<string, unknown> } }).yAxis.scale).toEqual({
      type: "log",
      nice: false,
      reverse: true,
    });
  });
});
