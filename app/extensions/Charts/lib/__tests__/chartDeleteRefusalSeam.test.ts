//! FILENAME: app/extensions/Charts/lib/__tests__/chartDeleteRefusalSeam.test.ts
// PURPOSE: A canvas-wide Delete (@api/objectSelection `deleteSelectedObjects`)
//          of two charts where the backend REFUSES one: the refused chart
//          stays SELECTED and is the one named in the seam's ONE toast, with
//          the backend's reason; the chart whose delete landed is gone.
// CONTEXT: Wave A review of V1. THE chart delete never rejects -- it puts a
//          refused chart back in the store and resolves -- and Charts'
//          provider resolved with it, so the seam counted the refused chart as
//          deleted and then DESELECTED the chart that came back, while the
//          refusal surfaced as a separate chart dialog. Driven with the real
//          chart selection provider and the real seam; the injected delete is
//          what index.ts `deleteChartsLanded` does (unpublish what landed,
//          report what was refused).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@api", () => ({
  addTaskPaneContextKey: vi.fn(),
  removeTaskPaneContextKey: vi.fn(),
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
}));
vi.mock("../../../../src/core/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  beginUndoTransaction: vi.fn(async () => {}),
  commitUndoTransaction: vi.fn(async () => {}),
}));
const toasts: string[] = [];
vi.mock("@api/notifications", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  showToast: (message: string) => {
    toasts.push(message);
  },
}));

import { getGridRegions, registerGridOverlay, setGridRegions, type GridRegion } from "@api/gridOverlays";
import {
  deleteSelectedObjects,
  getSelectedObjectRegions,
  registerObjectSelectionProvider,
  resetObjectSelectionProviders,
  setObjectSelectionSet,
} from "@api/objectSelection";
import { createChartObjectSelectionProvider, type ChartDeleteRefusal } from "../chartObjectSelection";
import { resetSelectionHandlerState } from "../../handlers/selectionHandler";

const PROTECTED = "Sheet is protected: edit objects is not allowed";

function chart(id: string, name: string, x: number): GridRegion {
  return {
    id: `chart-${id}`, type: "chart", startRow: 0, startCol: 0, endRow: 0, endCol: 0,
    floating: { x, y: 0, width: 100, height: 100 }, data: { chartId: id, name },
  };
}
const c1 = chart("c1", "Sales", 0);
const c2 = chart("c2", "Costs", 200);

/** index.ts `deleteChartsLanded`, with the backend refusing `refuse`. */
function deleteChartsRefusing(refuse: ReadonlySet<string>) {
  return async (ids: readonly string[]): Promise<ChartDeleteRefusal[]> => {
    const refused: ChartDeleteRefusal[] = [];
    for (const id of ids) {
      if (refuse.has(id)) refused.push({ chartId: id, reason: PROTECTED });
      else setGridRegions(getGridRegions().filter((r) => r.data?.chartId !== id));
    }
    return refused;
  };
}

const cleanups: Array<() => void> = [];

function install(refuse: ReadonlySet<string>): void {
  cleanups.push(
    registerObjectSelectionProvider(
      createChartObjectSelectionProvider({
        emitSelection: vi.fn(),
        invalidateChart: vi.fn(),
        refresh: vi.fn(),
        deleteCharts: deleteChartsRefusing(refuse),
      }),
    ),
  );
}

beforeEach(() => {
  toasts.length = 0;
  resetSelectionHandlerState();
  resetObjectSelectionProviders();
  cleanups.push(registerGridOverlay({ type: "chart", render: () => {}, priority: 15 }));
  setGridRegions([c1, c2]);
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  resetObjectSelectionProviders();
  resetSelectionHandlerState();
  setGridRegions([]);
});

describe("a canvas-wide Delete where the backend refuses one chart", () => {
  it("the refused chart stays SELECTED and is the only one named, with the reason", async () => {
    install(new Set(["c2"]));
    setObjectSelectionSet([c1, c2], c1);
    expect(getSelectedObjectRegions().map((r) => r.id)).toEqual(["chart-c1", "chart-c2"]);

    const outcome = await deleteSelectedObjects();

    expect(outcome, "the refused chart was counted as deleted").toEqual({ acted: 1, unsupported: 0, failed: 1 });
    expect(
      getSelectedObjectRegions().map((r) => r.id),
      "the refused chart was DESELECTED although it is still there",
    ).toEqual(["chart-c2"]);
    expect(toasts.length, "the refusal was not named in one toast").toBe(1);
    expect(toasts[0]).toContain("Costs");
    expect(toasts[0], "the chart whose delete landed was named as not deleted").not.toContain("Sales");
    expect(toasts[0]).toContain(PROTECTED);
  });

  it("control: nothing refused -- both deleted, nothing selected, no toast", async () => {
    install(new Set());
    setObjectSelectionSet([c1, c2], c1);
    const outcome = await deleteSelectedObjects();
    expect(outcome).toEqual({ acted: 2, unsupported: 0, failed: 0 });
    expect(getSelectedObjectRegions()).toEqual([]);
    expect(toasts).toEqual([]);
  });
});
