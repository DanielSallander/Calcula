//! FILENAME: app/extensions/Charts/components/__tests__/designTabVisuals.test.tsx
// PURPOSE: The Insert/Edit Chart dialog's Design tab for the tile visuals and
//          the stacked combo:
//            - the chart-type picker is the CATALOG's list (Excel's names:
//              "Column" for our bar mark, "Bar" for horizontalBar), with the
//              four visuals in it;
//            - a title-only mark (Card, KPI, ...) is offered no legend, data
//              labels or data table — controls that would write a setting the
//              mark never draws (ChartMarkMeta.furniture);
//            - each visual has its own options, written to markOptions;
//            - one Stacking control, through the one stack-mode writer, for
//              every mark that stacks — the combo gets Grouped / Stacked, and
//              the area no longer has a checkbox that wrote `stacked` alone
//              (survey charts.md §7.1: it could do nothing).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ChartSpec } from "../../types";
import { DesignTab } from "../tabs/DesignTab";
import { CHART_TYPES } from "../chartTypeCatalog";
// The built-in registrations (furniture is a registry answer).
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
    data: "Sheet1!A1:B3",
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "Sales", sourceIndex: 1, color: null }],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: true, position: "bottom" },
    palette: "default",
    ...(markOptions ? { markOptions } : {}),
  } as ChartSpec;
}

function render(s: ChartSpec): void {
  act(() => {
    root.render(<DesignTab spec={s} onSpecChange={(u) => changes.push(u)} previewSeriesNames={["Sales"]} />);
  });
}

function labels(): string[] {
  return [...container.querySelectorAll("label")].map((l) => l.textContent?.trim() ?? "");
}

function selectByTestId(id: string): HTMLSelectElement {
  const el = container.querySelector(`[data-testid="${id}"]`);
  if (!el) throw new Error(`no ${id}`);
  return el as HTMLSelectElement;
}

function choose(el: HTMLSelectElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("chart type picker = the catalog", () => {
  it("lists the catalog's types with the catalog's names, the four visuals included", () => {
    render(spec("bar"));
    const options = [...selectByTestId("chart-dialog-type").querySelectorAll("option")].map((o) => [o.value, o.textContent]);
    const builtin = options.slice(0, CHART_TYPES.length);
    expect(builtin).toEqual(CHART_TYPES.map((t) => [t.value, t.label]));
    expect(builtin).toContainEqual(["bar", "Column"]);
    expect(builtin).toContainEqual(["horizontalBar", "Bar"]);
    for (const v of ["card", "multiRowCard", "kpi", "gauge"]) {
      expect(options.map((o) => o[0])).toContain(v);
    }
  });
});

describe("title-only furniture", () => {
  it("a Card is offered no legend, data labels, data table or axes", () => {
    render(spec("card"));
    const l = labels();
    expect(l).toContain("Chart Title");
    for (const gone of ["Legend", "Data Labels", "Data Table", "X Axis", "Y Axis", "Series Colors"]) {
      expect(l, gone).not.toContain(gone);
    }
  });

  it("a column chart keeps all of them", () => {
    render(spec("bar"));
    const l = labels();
    for (const kept of ["Legend", "Data Labels", "X Axis", "Y Axis"]) expect(l).toContain(kept);
  });
});

describe("visual options", () => {
  it("card: display units and the category label write markOptions", () => {
    render(spec("card"));
    choose(selectByTestId("chart-dialog-display-units"), "millions");
    expect(changes.at(-1)).toEqual({ markOptions: { displayUnits: "millions" } });
  });

  it("kpi: direction writes markOptions.direction", () => {
    render(spec("kpi"));
    choose(selectByTestId("chart-dialog-kpi-direction"), "lowerIsBetter");
    expect(changes.at(-1)).toEqual({ markOptions: { direction: "lowerIsBetter" } });
  });

  it("gauge: a typed maximum is written as a number; clearing it removes it", () => {
    render(spec("gauge", { max: 10 }));
    const input = container.querySelector('[data-testid="chart-dialog-gauge-max"]') as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "250");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(changes.at(-1)).toEqual({ markOptions: { max: 250 } });
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(changes.at(-1)).toEqual({ markOptions: {} });
  });
});

describe("stacking, through the one writer", () => {
  it("combo offers Grouped and Stacked, and Stacked writes stackMode", () => {
    render(spec("combo"));
    const sel = selectByTestId("chart-dialog-stacking");
    expect([...sel.querySelectorAll("option")].map((o) => o.value)).toEqual(["none", "stacked"]);
    choose(sel, "stacked");
    expect(changes.at(-1)).toEqual({ markOptions: { stackMode: "stacked" } });
  });

  it("area: 'Stacked' writes stackMode AND the legacy flag, so the painter's stackMode-first rule cannot ignore it", () => {
    render(spec("area", { stackMode: "none" }));
    choose(selectByTestId("chart-dialog-stacking"), "stacked");
    expect(changes.at(-1)).toEqual({ markOptions: { stackMode: "stacked", stacked: true } });
  });

  it("column: 100% stacked is offered at insert time", () => {
    render(spec("bar"));
    choose(selectByTestId("chart-dialog-stacking"), "percentStacked");
    expect(changes.at(-1)).toEqual({ markOptions: { stackMode: "percentStacked" } });
  });

  it("a mark that cannot stack shows no stacking control", () => {
    render(spec("scatter"));
    expect(container.querySelector('[data-testid="chart-dialog-stacking"]')).toBeNull();
  });
});
