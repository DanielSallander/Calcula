//! FILENAME: app/extensions/Slicer/lib/__tests__/slicerFilterFailures.test.ts
// PURPOSE: A slicer filter that a pivot (or table) REFUSES is told to the
//          user -- once per gesture, not once per pivot, and not only in the
//          console (fix2-slicerBackend "Finding 2" follow-up).
//
//          The backend errs when, e.g., the model no longer has the slicer's
//          column. The bridge caught that per target and `console.warn`ed it,
//          so a click that filtered nothing looked exactly like one that
//          worked. Now every refusal of one gesture goes into ONE error toast
//          that says how many targets refused and the first reason; the other
//          targets still filter.
//
// The backend is a double of the Tauri shape: every invoke returns a Promise.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Slicer } from "../slicerTypes";

/** pivotId -> the error its apply/clear rejects with. */
let refusing: Record<string, string> = {};
let listingError: string | null = null;
let tableError: string | null = null;
/** The sheet's AutoFilter: the table's own, none, or another table's. */
let autoFilterState: "own" | "missing" | "foreign" = "own";
const writes: Array<{ cmd: string; pivotId: string }> = [];

vi.mock("../slicerBackend", () => ({
  slicerBackend: {
    invoke: (cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case "get_pivots_for_bi_connection":
          if (listingError) return Promise.reject(listingError);
          return Promise.resolve([
            { id: "p1", name: "P1", sheetIndex: 2 },
            { id: "p2", name: "P2", sheetIndex: 2 },
            { id: "p3", name: "P3", sheetIndex: 2 },
          ]);
        case "get_pivot_hierarchies":
          return Promise.resolve({ hierarchies: [], biModel: { connectionId: "c1", tables: [] } });
        case "apply_pivot_filter":
        case "clear_pivot_filter": {
          const pivotId = (args as { request: { pivotId: string } }).request.pivotId;
          writes.push({ cmd, pivotId });
          // Tauri rejects with the command's Err STRING.
          return refusing[pivotId] ? Promise.reject(refusing[pivotId]) : Promise.resolve({ pivotId });
        }
        case "get_tables_for_sheet":
          return Promise.resolve([
            {
              id: "t1",
              startCol: 0,
              autoFilterId: "af1",
              columns: [{ name: "Geo.Region" }],
              styleOptions: { headerRow: true, showFilterButton: true },
            },
          ]);
        default:
          return Promise.resolve(undefined);
      }
    },
  },
}));

vi.mock("@api/autoFilterService", () => ({
  requireAutoFilterController: () => ({
    get: async () =>
      autoFilterState === "missing"
        ? null
        : { id: autoFilterState === "own" ? "af1" : "af-other", startRow: 0, startCol: 0, endRow: 9, endCol: 0 },
    setColumn: async () => {
      if (tableError) throw new Error(tableError);
      return null;
    },
    clear: async () => null,
  }),
}));

vi.mock("@api", () => ({
  emitAppEvent: vi.fn(),
  AppEvents: { GRID_REFRESH: "app:grid-refresh" },
}));
vi.mock("@api/pivotNotices", () => ({ surfacePivotNotices: vi.fn() }));

const mockToast = vi.fn();
vi.mock("@api/notifications", () => ({
  showToast: (...a: unknown[]) => mockToast(...a),
}));

import { applySlicerFilter, syncReportConnections, type SlicerFilterFailure } from "../slicerFilterBridge";

function slicer(overrides: Partial<Slicer> = {}): Slicer {
  return {
    id: "s-1",
    name: "Region",
    headerText: null,
    sheetIndex: 2,
    x: 0,
    y: 0,
    width: 180,
    height: 240,
    sourceType: "biConnection",
    cacheSourceId: "c1",
    fieldName: "Geo.Region",
    selectedItems: ["East"],
    showHeader: true,
    columns: 1,
    stylePreset: "slicer-light-1",
    selectionMode: "standard",
    hideNoData: false,
    indicateNoData: true,
    sortNoDataLast: true,
    forceSelection: false,
    showSelectAll: false,
    arrangement: "vertical",
    rows: 0,
    itemGap: 4,
    autogrid: false,
    itemPadding: 4,
    buttonRadius: 2,
    connectedSources: [{ sourceType: "biConnection", sourceId: "c1" }],
    filterLevel: 1,
    ...overrides,
  };
}

const LOST = "Column 'Geo.Region' not found in model";

beforeEach(() => {
  refusing = {};
  listingError = null;
  tableError = null;
  autoFilterState = "own";
  writes.length = 0;
  mockToast.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

describe("a slicer click whose pivots refuse", () => {
  it("is told in ONE error toast naming how many refused and why -- and the rest still filter", async () => {
    refusing = { p1: LOST, p3: LOST };

    await applySlicerFilter(slicer());

    expect(writes.map((w) => w.pivotId)).toEqual(["p1", "p2", "p3"]);
    expect(mockToast).toHaveBeenCalledTimes(1);
    const [message, options] = mockToast.mock.calls[0] as [string, { type: string }];
    expect(message).toBe(`Slicer "Region" could not filter 2 PivotTables: ${LOST}`);
    expect(options.type).toBe("error");
  });

  it("says nothing when every target took the filter", async () => {
    await applySlicerFilter(slicer());
    expect(writes).toHaveLength(3);
    expect(mockToast).not.toHaveBeenCalled();
  });

  it("a model slicer whose page cannot be listed says so (it filtered nothing at all)", async () => {
    listingError = "Not connected";
    await applySlicerFilter(slicer());
    expect(writes).toHaveLength(0);
    expect(mockToast).toHaveBeenCalledTimes(1);
    expect(mockToast.mock.calls[0][0]).toBe('Slicer "Region" could not filter the PivotTables of its model: Not connected');
  });

  it("a TABLE target that refuses (a protected sheet) is counted as a table", async () => {
    tableError = "The sheet is protected";
    await applySlicerFilter(slicer({ sourceType: "table", connectedSources: [{ sourceType: "table", sourceId: "t1" }] }));
    expect(mockToast).toHaveBeenCalledTimes(1);
    expect(mockToast.mock.calls[0][0]).toBe('Slicer "Region" could not filter 1 table: The sheet is protected');
  });

  it("with a caller's `failures` list it tells nobody and hands the refusals over (the reconcile reports once)", async () => {
    refusing = { p2: LOST };
    const failures: SlicerFilterFailure[] = [];
    await applySlicerFilter(slicer(), { masksOnly: true, failures });
    expect(mockToast).not.toHaveBeenCalled();
    expect(failures).toEqual([{ slicer: "Region", target: "pivot", clearing: false, message: LOST }]);
  });
});

describe("a Report Connections save", () => {
  it("reports the clears AND the applies of one Save in ONE toast", async () => {
    refusing = { "p-old": "Pivot table p-old not found", "p-new": LOST };
    await syncReportConnections(
      slicer({ sourceType: "pivot", connectedSources: [] }),
      [{ sourceType: "pivot", sourceId: "p-old" }],
      [{ sourceType: "pivot", sourceId: "p-new" }],
    );
    expect(writes.map((w) => `${w.cmd}:${w.pivotId}`)).toEqual([
      "clear_pivot_filter:p-old",
      "apply_pivot_filter:p-new",
    ]);
    expect(mockToast).toHaveBeenCalledTimes(1);
    expect(mockToast.mock.calls[0][0]).toBe('Slicer "Region" could not update 2 PivotTables: Pivot table p-old not found');
  });
});

describe("a target the bridge itself finds it cannot filter (review3 finding 7)", () => {
  // These never reached the backend, so no Err came back: the click filtered
  // nothing and said so only in the console.
  const rangeSlicer = (overrides: Partial<Slicer> = {}) =>
    slicer({ sourceType: "pivot", fieldName: "Region", connectedSources: [{ sourceType: "pivot", sourceId: "rp" }], ...overrides });
  const tableSlicer = (overrides: Partial<Slicer> = {}) =>
    slicer({ sourceType: "table", connectedSources: [{ sourceType: "table", sourceId: "t1" }], ...overrides });

  it("a Report Connections RANGE pivot without the slicer's field (a renamed source header)", async () => {
    await applySlicerFilter(rangeSlicer());
    expect(writes).toHaveLength(0);
    expect(mockToast).toHaveBeenCalledTimes(1);
    expect(mockToast.mock.calls[0][0]).toBe('Slicer "Region" could not filter 1 PivotTable: the PivotTable has no field "Region"');
  });

  it("a TABLE without the slicer's column", async () => {
    await applySlicerFilter(tableSlicer({ fieldName: "Geo.Country" }));
    expect(mockToast).toHaveBeenCalledTimes(1);
    expect(mockToast.mock.calls[0][0]).toBe('Slicer "Region" could not filter 1 table: the table has no column "Geo.Country"');
  });

  it("a TABLE whose sheet has no AutoFilter, or one that belongs to another table", async () => {
    autoFilterState = "missing";
    await applySlicerFilter(tableSlicer());
    autoFilterState = "foreign";
    await applySlicerFilter(tableSlicer());
    expect(mockToast).toHaveBeenCalledTimes(2);
    expect(mockToast.mock.calls[0][0]).toBe(`Slicer "Region" could not filter 1 table: the table's sheet has no AutoFilter to filter with`);
    expect(mockToast.mock.calls[1][0]).toBe(`Slicer "Region" could not filter 1 table: the sheet's AutoFilter belongs to another table`);
  });

  it("CLEARING such a target is a no-op, not a failure: there is no filter of this slicer on it", async () => {
    await syncReportConnections(
      rangeSlicer({ connectedSources: [] }),
      [{ sourceType: "pivot", sourceId: "rp" }, { sourceType: "table", sourceId: "t1" }],
      [],
    );
    expect(writes).toHaveLength(0);
    expect(mockToast).not.toHaveBeenCalled();
  });
});
