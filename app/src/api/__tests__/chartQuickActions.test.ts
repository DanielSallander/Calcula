//! FILENAME: app/src/api/__tests__/chartQuickActions.test.ts
// PURPOSE: The contributed-button seam: registration, per-chart predicates,
//          ordering, and what happens when a contributor misbehaves.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  registerChartQuickAction,
  chartQuickActionsFor,
  listChartQuickActions,
  onChartQuickActionsChanged,
  resetChartQuickActions,
  type ChartQuickAction,
} from "../chartQuickActions";

function action(overrides: Partial<ChartQuickAction> = {}): ChartQuickAction {
  return {
    id: "x.one",
    icon: "insight",
    order: 10,
    tooltip: () => "One",
    onSelect: () => undefined,
    ...overrides,
  };
}

beforeEach(() => {
  resetChartQuickActions();
});

describe("@api/chartQuickActions", () => {
  it("is empty until something registers, and the unregister really removes it", () => {
    expect(chartQuickActionsFor("c1")).toEqual([]);
    const off = registerChartQuickAction(action());
    expect(chartQuickActionsFor("c1").map((a) => a.id)).toEqual(["x.one"]);
    off();
    expect(chartQuickActionsFor("c1")).toEqual([]);
  });

  it("orders by `order`, then by id so the strip never shuffles between paints", () => {
    registerChartQuickAction(action({ id: "b", order: 20 }));
    registerChartQuickAction(action({ id: "a", order: 20 }));
    registerChartQuickAction(action({ id: "z", order: 5 }));
    expect(chartQuickActionsFor("c1").map((a) => a.id)).toEqual(["z", "a", "b"]);
  });

  // Registering the same id twice is what a hot reload does. Keeping the first
  // would leave a button calling into a module that has been torn down.
  it("replaces an action registered twice under one id", () => {
    registerChartQuickAction(action({ tooltip: () => "old" }));
    registerChartQuickAction(action({ tooltip: () => "new" }));
    const all = chartQuickActionsFor("c1");
    expect(all).toHaveLength(1);
    expect(all[0].tooltip("c1")).toBe("new");
  });

  // The whole point of asking per chart: "points of interest" is a toggle, and
  // two charts on one sheet are in different states.
  it("asks `visible` per chart, so one chart can offer a button another does not", () => {
    registerChartQuickAction(action({ visible: (id) => id === "c1" }));
    expect(chartQuickActionsFor("c1")).toHaveLength(1);
    expect(chartQuickActionsFor("c2")).toHaveLength(0);
    // And `listChartQuickActions` reports it regardless of visibility.
    expect(listChartQuickActions().map((a) => a.id)).toEqual(["x.one"]);
  });

  it("treats a `visible` that throws as a no, and keeps every other action", () => {
    registerChartQuickAction(action({ id: "bad", visible: () => { throw new Error("boom"); } }));
    registerChartQuickAction(action({ id: "good", order: 20 }));
    expect(chartQuickActionsFor("c1").map((a) => a.id)).toEqual(["good"]);
  });

  it("notifies on registration and on removal, so a painter can redraw", () => {
    const seen = vi.fn();
    const stop = onChartQuickActionsChanged(seen);
    const off = registerChartQuickAction(action());
    expect(seen).toHaveBeenCalledTimes(1);
    off();
    expect(seen).toHaveBeenCalledTimes(2);
    off(); // already gone: nothing to announce
    expect(seen).toHaveBeenCalledTimes(2);
    stop();
    registerChartQuickAction(action({ id: "later" }));
    expect(seen).toHaveBeenCalledTimes(2);
  });
});
