//! FILENAME: app/extensions/Charts/components/__tests__/ChartFieldsTab.test.tsx
// PURPOSE: A design-query chart's Fields tab (WP-C S9b): the wells per mark,
//          a measure dragged from the SHARED field list onto a well becomes
//          the new DSL handed to the one write, a checkbox does the same, a
//          gauge's Target is written with its series index, and a read-only
//          pane (or a query the wells cannot say) writes nothing.
// CONTEXT: The drag is the shared mouse-based one (_shared/useDragDrop): a
//          mousedown on the field list's item, then a document mouseup over
//          the well. jsdom has no layout, so the TARGET well's rect is given
//          explicitly; every other element measures 0x0 and is never hit.

import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import type { BiPivotModelInfo } from "../../../_shared/components/types";
import { sameDesignQuery } from "../../../_shared/dsl/pivotLayout/canonical";
import { ChartFieldsTab, type ChartFieldsTabProps } from "../pane/ChartFieldsTab";
import { chartWellKey } from "../../lib/designQueryWells";

const MODEL: BiPivotModelInfo = {
  tables: [{ name: "Geo", columns: [{ name: "Region", dataType: "string", isNumeric: false }] }],
  measures: [
    { name: "Revenue", table: "Sales", sourceColumn: "amount", aggregation: "sum" },
    { name: "Cost", table: "Sales", sourceColumn: "cost", aggregation: "sum" },
  ],
  connectionId: "conn-a",
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function cleanup(): void {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
}

afterEach(() => cleanup());

function mouse(target: EventTarget, type: string, x: number, y: number): void {
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  });
}

/** The field list's element whose own text is `label`. */
function listItem(container: HTMLElement, label: string): HTMLElement {
  const list = container.querySelector("[data-testid='chart-fields-list']")!;
  const hit = Array.from(list.querySelectorAll("span")).find((e) => e.textContent === label);
  expect(hit, label).toBeTruthy();
  return hit as HTMLElement;
}

function renderTab(over: Partial<ChartFieldsTabProps> = {}) {
  const onCommit = vi.fn();
  const onError = vi.fn();
  const props: ChartFieldsTabProps = {
    biModel: MODEL,
    dslText: "ROWS: Geo.Region\nVALUES: [Revenue]",
    mark: "bar",
    markOptions: undefined,
    readOnly: false,
    readOnlyReason: null,
    busy: false,
    onCommit,
    onError,
    ...over,
  };
  cleanup();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<ChartFieldsTab {...props} />));
  return { container: host, onCommit, onError };
}

function wellIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-well-id]")).map((e) => e.getAttribute("data-well-id")!);
}

/** Drag the field-list item whose label is `label` and release it over well `wellId`. */
function dragToWell(container: HTMLElement, label: string, wellId: string): void {
  const zone = container.querySelector(`[data-drop-key="${chartWellKey(wellId)}"]`) as HTMLElement;
  expect(zone, wellId).toBeTruthy();
  zone.getBoundingClientRect = () => ({ left: 10, top: 10, right: 200, bottom: 60, width: 190, height: 50, x: 10, y: 10, toJSON: () => ({}) }) as DOMRect;
  mouse(listItem(container, label), "mousedown", 300, 300);
  mouse(document, "mousemove", 50, 40);
  mouse(document, "mouseup", 50, 40);
}

describe("ChartFieldsTab", () => {
  it("shows the wells of the chart's mark", () => {
    expect(wellIds(renderTab().container)).toEqual(["axis", "legend", "values", "filters"]);
    cleanup();
    expect(wellIds(renderTab({ mark: "card", dslText: "VALUES: [Revenue]" }).container)).toEqual(["fields", "filters"]);
    cleanup();
    expect(wellIds(renderTab({ mark: "gauge", dslText: "VALUES: [Revenue]" }).container)).toEqual([
      "value", "target", "min", "max", "filters",
    ]);
    cleanup();
    expect(wellIds(renderTab({ mark: "kpi", dslText: "VALUES: [Revenue]" }).container)).toEqual([
      "indicator", "trendAxis", "goal", "filters",
    ]);
  });

  it("dropping a measure from the field list on Values commits the new DSL", () => {
    const { container, onCommit, onError } = renderTab();
    dragToWell(container, "Cost", "values");
    expect(onError).not.toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledTimes(1);
    const [dsl, markOptions] = onCommit.mock.calls[0];
    expect(sameDesignQuery(dsl, "ROWS: Geo.Region\nVALUES: [Revenue], [Cost]")).toBe(true);
    expect(markOptions).toBeNull();
  });

  it("dropping a measure on a gauge's Target commits the DSL AND the target index together", () => {
    const { container, onCommit } = renderTab({ mark: "gauge", dslText: "VALUES: [Revenue]" });
    dragToWell(container, "Cost", "target");
    expect(onCommit).toHaveBeenCalledTimes(1);
    const [dsl, markOptions] = onCommit.mock.calls[0];
    expect(sameDesignQuery(dsl, "VALUES: [Revenue], [Cost]")).toBe(true);
    expect(markOptions).toEqual({ targetSeriesIndex: 1, minSeriesIndex: undefined, maxSeriesIndex: undefined });
  });

  it("checking a measure in the field list adds it", () => {
    const { container, onCommit } = renderTab();
    const row = listItem(container, "Cost").parentElement!;
    act(() => (row.querySelector("input[type='checkbox']") as HTMLInputElement).click());
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(sameDesignQuery(onCommit.mock.calls[0][0], "ROWS: Geo.Region\nVALUES: [Revenue], [Cost]")).toBe(true);
    expect(container).toBeTruthy();
  });

  it("a measure dropped on Axis is refused in words and nothing is written", () => {
    const { container, onCommit, onError } = renderTab();
    dragToWell(container, "Cost", "axis");
    expect(onCommit).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/takes a column/));
  });

  it("a read-only pane writes nothing and says why", () => {
    const { container, onCommit, onError } = renderTab({ readOnly: true, readOnlyReason: "This page is subscribed." });
    expect(container.querySelector("[data-testid='chart-fields-locked']")!.textContent).toBe("This page is subscribed.");
    dragToWell(container, "Cost", "values");
    expect(onCommit).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("This page is subscribed.");
  });

  it("a query the wells cannot say (SORT) is shown read-only and never rewritten", () => {
    const { container, onCommit } = renderTab({ dslText: "ROWS: Geo.Region\nVALUES: [Revenue]\nSORT: Geo.Region DESC" });
    expect(container.querySelector("[data-testid='chart-fields-locked']")!.textContent).toMatch(/Design tab/);
    dragToWell(container, "Cost", "values");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("builds from the SHARED components, never Pivot's", () => {
    for (const file of ["../pane/ChartFieldsTab.tsx", "../pane/ChartDesignQueryBuild.tsx", "../../lib/designQueryWells.ts"]) {
      const text = readFileSync(resolve(__dirname, file), "utf8");
      expect(text, file).not.toMatch(/from\s+["'][^"']*\/Pivot\//);
    }
  });
});
