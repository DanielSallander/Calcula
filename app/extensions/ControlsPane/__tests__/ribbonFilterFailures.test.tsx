//! FILENAME: app/extensions/ControlsPane/__tests__/ribbonFilterFailures.test.tsx
// PURPOSE: A ribbon filter that a pivot REFUSES is told to the user -- once
//          per gesture, not once per pivot, and not only in the console
//          (fix2-slicerBackend "Finding 2" follow-up).
//
//          The backend errs when, e.g., the model no longer has the filter's
//          column. The bridge caught that per pivot and `console.warn`ed it,
//          so a filter that reached nothing looked exactly like one that
//          worked. Now one gesture's refusals become ONE error toast saying
//          how many pivots refused and the first reason, and the other pivots
//          still filter. The Report Connections Save -- clears on the
//          disconnected pivots, then an apply on the new ones -- is one gesture.
//
// The real bridge (and, for the Save, the real FilterDropdown) run here; only
// the backend is a double of the Tauri shape (every invoke returns a Promise,
// a refusal rejects with the command's Err string).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SurfaceLayoutProvider, bandLayout } from "@api/layout";
import type { RibbonFilter } from "../lib/filterPaneTypes";

const mocks = vi.hoisted(() => ({
  calls: [] as Array<{ cmd: string; pivotId: string }>,
  /** pivotId -> the Err string its apply/clear rejects with. */
  refusing: {} as Record<string, string>,
  pivots: [] as Array<{ id: string; name: string; sheetIndex: number }>,
  filters: [] as RibbonFilter[],
  updateFilterAsync: vi.fn(),
  toast: vi.fn(),
  /** connectionId -> the error listing its pivots throws with. */
  listingErrors: {} as Record<string, string>,
}));

vi.mock("@api", () => ({
  emitAppEvent: vi.fn(),
  AppEvents: { GRID_REFRESH: "app:grid-refresh" },
  getSheets: async () => ({ sheets: [{ index: 0, name: "Report" }] }),
}));
vi.mock("@api/notifications", () => ({ showToast: (...a: unknown[]) => mocks.toast(...a) }));
vi.mock("@api/pivotNotices", () => ({ surfacePivotNotices: vi.fn() }));
vi.mock("@api/objectGeometry", () => ({
  runInUndoTransaction: async (_label: string, fn: () => Promise<unknown>) => fn(),
  // The Save's own step (nothing else holds one open here, so it opens it).
  openUndoTransaction: (_label: string) => ({
    joined: false,
    run: async (fn: () => Promise<unknown>) => fn(),
    commit: async () => undefined,
    openedBackend: async () => true,
  }),
  // The Save is ONE step asked about through @api/pivotOverwrite (wave B).
  isUndoTransactionOpen: () => false,
  undoCommitsSettled: () => Promise.resolve(),
}));
vi.mock("../lib/filterPaneBackend", () => ({
  filterPaneBackend: {
    invoke: (cmd: string, args?: Record<string, unknown>) => {
      const pivotId = (args as { request?: { pivotId?: string } } | undefined)?.request?.pivotId ?? "";
      mocks.calls.push({ cmd, pivotId });
      if (mocks.refusing[pivotId]) return Promise.reject(mocks.refusing[pivotId]);
      return Promise.resolve({ pivotId });
    },
  },
}));
vi.mock("../lib/filterPaneStore", () => ({
  updateFilterAsync: mocks.updateFilterAsync,
  updateFilterSelectionAsync: vi.fn(),
  getAllFilters: () => mocks.filters,
  getConnectionName: () => "Sales model",
}));
vi.mock("../lib/filterPaneApi", () => ({
  getAllSlicers: async () => [],
  getPivotsForBiConnection: async (connectionId: string) => {
    if (mocks.listingErrors[connectionId]) throw new Error(mocks.listingErrors[connectionId]);
    return mocks.pivots;
  },
}));

import { applyRibbonFilter, clearRibbonFilter, type RibbonFilterFailure } from "../lib/filterPaneFilterBridge";
import { FilterDropdown } from "../components/FilterDropdown";

const LOST = "Column 'Customers.Region' not found in model";

function filter(overrides: Partial<RibbonFilter> = {}): RibbonFilter {
  return {
    id: "f1",
    name: "Region",
    connectionId: "c1",
    fieldName: "Customers.Region",
    fieldDataType: "text",
    connectionMode: "workbook",
    connectedSheets: [],
    connectedPivots: [],
    selectedItems: ["East"],
    filterLevel: 1,
    ...overrides,
  } as RibbonFilter;
}

const toastText = (i = 0) => mocks.toast.mock.calls[i][0] as string;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  mocks.calls.length = 0;
  mocks.refusing = {};
  mocks.pivots = [
    { id: "P", name: "Region pivot", sheetIndex: 0 },
    { id: "Q", name: "Revenue pivot", sheetIndex: 0 },
    { id: "R", name: "Units pivot", sheetIndex: 0 },
  ];
  mocks.filters = [];
  mocks.listingErrors = {};
  mocks.toast.mockClear();
  mocks.updateFilterAsync.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("a ribbon filter change whose pivots refuse", () => {
  it("is told in ONE error toast naming how many refused and why -- and the rest still filter", async () => {
    mocks.refusing = { P: LOST, R: LOST };
    await applyRibbonFilter(filter());

    expect(mocks.calls.filter((c) => c.cmd === "apply_pivot_filter").map((c) => c.pivotId)).toEqual(["P", "Q", "R"]);
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(toastText()).toBe(`Filter "Region" could not filter 2 PivotTables: ${LOST}`);
    expect((mocks.toast.mock.calls[0][1] as { type: string }).type).toBe("error");
  });

  it("says nothing when every pivot took it", async () => {
    await applyRibbonFilter(filter());
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("another active filter re-applied with it and refused is named too -- still ONE toast", async () => {
    const other = filter({ id: "f2", name: "Year", fieldName: "Dates.Year", selectedItems: ["2024"] });
    mocks.filters = [filter(), other];
    mocks.pivots = [{ id: "P", name: "Region pivot", sheetIndex: 0 }];
    mocks.refusing = { P: LOST };

    await applyRibbonFilter(filter());

    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(toastText()).toBe(`Filters "Region", "Year" could not filter 1 PivotTable: ${LOST}`);
  });

  it("a clear that refuses says the filter could not be removed", async () => {
    mocks.refusing = { Q: "Pivot table Q not found" };
    await clearRibbonFilter(filter());
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(toastText()).toBe('Filter "Region" could not be removed from 1 PivotTable: Pivot table Q not found');
  });

  it("with a caller's `failures` list it tells nobody and hands the refusals over", async () => {
    mocks.refusing = { Q: LOST };
    const failures: RibbonFilterFailure[] = [];
    await applyRibbonFilter(filter(), failures);
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(failures).toEqual([{ filter: "Region", pivotId: "Q", clearing: false, message: LOST }]);
  });
});

describe("the Report Connections Save is ONE gesture", () => {
  it("the clear on the pivot it left and the apply on the pivot it joined are reported in ONE toast", async () => {
    mocks.pivots = [
      { id: "P", name: "Region pivot", sheetIndex: 0 },
      { id: "Q", name: "Revenue pivot", sheetIndex: 0 },
    ];
    mocks.refusing = { P: "Pivot table P not found", Q: LOST };
    // After the edit: connected to Q only, with a live selection to re-apply.
    mocks.updateFilterAsync.mockResolvedValue(filter({ connectionMode: "manual", connectedPivots: ["Q"] }));

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    act(() => {
      root.render(
        <SurfaceLayoutProvider value={bandLayout()}>
          <FilterDropdown
            filterId="f1"
            fieldName="Customers.Region"
            items={[{ value: "East", selected: true, hasData: true }]}
            selectedItems={["East"]}
            anchorEl={anchor}
            onApply={() => undefined}
            onClose={() => undefined}
            onDelete={() => undefined}
            connectionId="c1"
            connectionMode="manual"
            crossFilterTargets={[]}
            crossFilterSlicerTargets={[]}
            advancedFilter={null}
            fieldDataType="text"
            connectedPivots={["P"]}
            connectedSheets={[]}
            hideNoData={false}
            indicateNoData={true}
            sortNoDataLast={true}
            showSelectAll={false}
            singleSelect={false}
            filterLevel={1}
          />
        </SurfaceLayoutProvider>,
      );
    });
    const flush = async () => {
      await act(async () => {
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
    };
    const click = async (el: Element) => {
      await act(async () => {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
    };
    const button = (text: string) =>
      Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.trim() === text)!;
    const box = (pivotName: string) =>
      Array.from(document.querySelectorAll("label"))
        .find((l) => l.textContent?.includes(pivotName))!
        .querySelector<HTMLInputElement>('input[type="checkbox"]')!;

    await flush();
    await click(button("Connections"));
    await flush();
    await click(box("Region pivot")); // leave P
    await click(box("Revenue pivot")); // join Q
    await click(button("Save"));
    await flush();

    expect(mocks.calls.map((c) => `${c.cmd}:${c.pivotId}`)).toEqual([
      "clear_pivot_filter:P",
      "apply_pivot_filter:Q",
    ]);
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(toastText()).toBe('Filter "Region" could not update 2 PivotTables: Pivot table P not found');

    act(() => root.unmount());
  });
});

describe("a ribbon filter whose pivots cannot even be listed (review3 finding 7)", () => {
  // The listing failure was swallowed into "no pivots": the filter reached
  // nothing, and looked exactly like a filter with nothing to filter.
  it("an apply is told, and writes nothing", async () => {
    mocks.listingErrors = { c1: "Not connected" };
    await applyRibbonFilter(filter());
    expect(mocks.calls.filter((c) => c.cmd === "apply_pivot_filter")).toEqual([]);
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(toastText()).toBe('Filter "Region" could not filter its PivotTables: Not connected');
  });

  it("a clear is told", async () => {
    mocks.listingErrors = { c1: "Not connected" };
    await clearRibbonFilter(filter());
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(toastText()).toBe('Filter "Region" could not be removed from its PivotTables: Not connected');
  });

  it("another active filter whose pivots cannot be listed is named, and THIS filter still applies -- one toast", async () => {
    const other = filter({ id: "f2", name: "Year", connectionId: "c2", fieldName: "Dates.Year", selectedItems: ["2024"] });
    mocks.filters = [filter(), other];
    mocks.listingErrors = { c2: "Not connected" };
    await applyRibbonFilter(filter());
    expect(mocks.calls.filter((c) => c.cmd === "apply_pivot_filter").map((c) => c.pivotId)).toEqual(["P", "Q", "R"]);
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(toastText()).toBe('Filter "Year" could not filter its PivotTables: Not connected');
  });
});
