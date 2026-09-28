//! FILENAME: app/extensions/ControlsPane/lib/__tests__/filterPaneFilterBridge.test.ts
// PURPOSE: The ribbon filter's bridge names every model column by its
//          "Table.Column" key and lets the Pivot owner add a missing column
//          server-side. It used to rebuild the pivot itself through
//          update_bi_pivot_fields with ONLY its own fields as slicer fields,
//          which dropped a canvas slicer's field -- and that slicer's filter --
//          from the same pivot (P2), and it added the column before a CLEAR
//          (P4). Now: no rebuild, and a clear never applies.
//
//          ONE undo step: every pivot write of one filter change runs inside
//          one "Ribbon filter change" transaction, so the server-side ensures
//          for N missing columns join one step instead of leaving N.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RibbonFilter } from "../filterPaneTypes";

interface Call {
  cmd: string;
  args: Record<string, unknown> | undefined;
  /** The undo transaction the call ran inside (null = none). */
  tx: string | null;
}
const calls: Call[] = [];

/** The open transaction's label, and every label opened. */
let openTx: string | null = null;
const txLabels: string[] = [];
vi.mock("@api/objectGeometry", () => ({
  runInUndoTransaction: async (label: string, fn: () => Promise<unknown>) => {
    txLabels.push(label);
    const outer = openTx;
    openTx = outer ?? label;
    try {
      return await fn();
    } finally {
      openTx = outer;
    }
  },
}));

/** What an apply/clear on a pivot reports it grew over (its response). */
let overwriteById: Record<string, { overwrittenCellCount: number; overwriteToken?: number }> = {};
vi.mock("../filterPaneBackend", () => ({
  filterPaneBackend: {
    invoke: (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args, tx: openTx });
      const pivotId = (args as { request?: { pivotId?: string } })?.request?.pivotId;
      return Promise.resolve({ pivotId, ...(pivotId ? overwriteById[pivotId] ?? {} : {}) });
    },
  },
}));

let filters: RibbonFilter[] = [];
vi.mock("../filterPaneStore", () => ({
  getAllFilters: () => filters,
}));

vi.mock("../filterPaneApi", () => ({
  getPivotsForBiConnection: async () => [
    { id: "p-report", name: "Report pivot", sheetIndex: 2 },
    { id: "p-data", name: "Data pivot", sheetIndex: 0 },
  ],
}));

vi.mock("@api", () => ({
  emitAppEvent: vi.fn(),
  AppEvents: { GRID_REFRESH: "app:grid-refresh" },
}));

vi.mock("@api/pivotNotices", () => ({ surfacePivotNotices: vi.fn() }));

import { applyRibbonFilter, clearModelColumnOnPivots, clearRibbonFilter } from "../filterPaneFilterBridge";
import { createPivotOverwriteTally } from "@api/pivotOverwrite";

function filter(overrides: Partial<RibbonFilter> = {}): RibbonFilter {
  return {
    id: "f1",
    name: "Region",
    connectionId: "c1",
    fieldName: "Geo.Region",
    fieldDataType: "text",
    connectionMode: "bySheet",
    connectedSheets: [2],
    connectedPivots: [],
    selectedItems: ["East"],
    filterLevel: 1,
    ...overrides,
  } as RibbonFilter;
}

const requestOf = (c: Call) => (c.args as { request: Record<string, unknown> }).request;

beforeEach(() => {
  calls.length = 0;
  filters = [];
  openTx = null;
  txLabels.length = 0;
  overwriteById = {};
});

// Fix round 5 (F6): the bridge notes every pivot response of the gesture, so
// the store can ask ONE "will overwrite existing data" question for it.
describe("what a filter change overwrote", () => {
  it("an apply notes each pivot's overwritten cells and step into the gesture's tally", async () => {
    const f = filter({ connectionMode: "workbook" });
    filters = [f];
    overwriteById["p-report"] = { overwrittenCellCount: 2, overwriteToken: 61 };
    overwriteById["p-data"] = { overwrittenCellCount: 3, overwriteToken: 62 };
    const overwrites = createPivotOverwriteTally();

    await applyRibbonFilter(f, undefined, overwrites);

    expect(overwrites.cellCount).toBe(5);
    expect(overwrites.tokens).toEqual([61, 62]);
  });

  it("a clear notes them too", async () => {
    const f = filter({ connectionMode: "workbook", selectedItems: null });
    filters = [f];
    overwriteById["p-data"] = { overwrittenCellCount: 4, overwriteToken: 63 };
    const overwrites = createPivotOverwriteTally();

    await clearRibbonFilter(f, undefined, overwrites);

    expect(overwrites.cellCount).toBe(4);
    expect(overwrites.tokens).toEqual([63]);
  });
});

describe("applyRibbonFilter", () => {
  it("filters its target pivots by model key -- the backend adds a missing column; no rebuild, no index lookup", async () => {
    const f = filter();
    filters = [f];
    await applyRibbonFilter(f);

    expect(calls.map((c) => c.cmd)).toEqual(["apply_pivot_filter"]);
    expect(requestOf(calls[0])).toEqual({
      pivotId: "p-report",
      biFieldKey: "Geo.Region",
      filters: { manualFilter: { selectedItems: ["East"] } },
      filterLevel: 1,
    });
  });

  it("re-applies every other active filter on the same pivot, each by its own key", async () => {
    const f = filter();
    const year = filter({ id: "f2", fieldName: "BI.dim_date.Year", selectedItems: ["2024"], filterLevel: 2 });
    filters = [f, year];
    await applyRibbonFilter(f);
    expect(calls.map((c) => [c.cmd, requestOf(c).biFieldKey, requestOf(c).filterLevel])).toEqual([
      ["apply_pivot_filter", "Geo.Region", 1],
      ["apply_pivot_filter", "BI.dim_date.Year", 2],
    ]);
    expect(calls.some((c) => c.cmd === "update_bi_pivot_fields")).toBe(false);
  });

  it("every pivot write of one filter change runs inside ONE undo step (N missing columns: N ensures, one Ctrl+Z)", async () => {
    const f = filter();
    const year = filter({ id: "f2", fieldName: "Cal.Year", selectedItems: ["2024"] });
    const channel = filter({ id: "f3", fieldName: "Sales.Channel", selectedItems: ["Web"] });
    filters = [f, year, channel];
    await applyRibbonFilter(f);
    const applies = calls.filter((c) => c.cmd === "apply_pivot_filter");
    expect(applies).toHaveLength(3);
    expect(applies.every((c) => c.tx === "Ribbon filter change")).toBe(true);
    expect(txLabels).toEqual(["Ribbon filter change"]);
  });
});

// Fix round 5 review, finding 2: after a DECLINED change was taken back, the
// pivots it masked WITHOUT overwriting recorded nothing, so the store
// re-derives them from the restored selection. Those writes are not a user
// gesture: the backend must record nothing (`reconcile: true` on every pivot
// request -- a step recorded here would sit on top of the history the decline
// just put back), no undo step is opened, and the pivots the taken-back step
// restored exactly are left alone.
describe("a reconcile re-derive (after a declined change)", () => {
  it("applies with reconcile: true on EVERY pivot request, opens no undo step, and skips the restored pivots", async () => {
    const f = filter({ connectionMode: "workbook" });
    const year = filter({ id: "f2", fieldName: "Cal.Year", selectedItems: ["2024"] });
    filters = [f, year];

    await applyRibbonFilter(f, undefined, undefined, { skipPivotIds: ["p-data"] });

    expect(calls.map((c) => [c.cmd, requestOf(c).pivotId, requestOf(c).biFieldKey, requestOf(c).reconcile])).toEqual([
      ["apply_pivot_filter", "p-report", "Geo.Region", true],
      ["apply_pivot_filter", "p-report", "Cal.Year", true],
    ]);
    expect(txLabels, "a reconcile opened an undo step").toEqual([]);
    expect(calls.every((c) => c.tx === null)).toBe(true);
  });

  it("a CLEAR re-derive likewise records nothing, opens nothing, and skips the restored pivots", async () => {
    await clearRibbonFilter(filter({ connectionMode: "workbook", selectedItems: null }), undefined, undefined, {
      skipPivotIds: ["p-report"],
    });

    expect(calls.map((c) => [c.cmd, requestOf(c).pivotId, requestOf(c).reconcile])).toEqual([
      ["clear_pivot_filter", "p-data", true],
    ]);
    expect(txLabels, "a reconcile opened an undo step").toEqual([]);
  });

  it("a user gesture's requests never carry the flag", async () => {
    const f = filter({ connectionMode: "workbook" });
    filters = [f];
    await applyRibbonFilter(f);
    await clearRibbonFilter(filter({ connectionMode: "workbook", selectedItems: null }));
    expect(calls.every((c) => !("reconcile" in requestOf(c)))).toBe(true);
  });
});

describe("clearRibbonFilter", () => {
  it("CLEARS by model key and never applies (a clear never adds the column)", async () => {
    await clearRibbonFilter(filter({ selectedItems: null }));
    expect(calls.map((c) => c.cmd)).toEqual(["clear_pivot_filter"]);
    expect(requestOf(calls[0])).toEqual({ pivotId: "p-report", biFieldKey: "Geo.Region" });
    expect(calls[0].tx).toBe("Ribbon filter change");
  });
});

describe("clearModelColumnOnPivots (Report Connections: pivots a filter was disconnected from)", () => {
  it("clears each pivot by the MODEL KEY, never by a field index, in one undo step", async () => {
    await clearModelColumnOnPivots("Customers.Region", ["p1", "p2"]);
    const clears = calls.filter((c) => c.cmd === "clear_pivot_filter");
    expect(clears.map(requestOf)).toEqual([
      { pivotId: "p1", biFieldKey: "Customers.Region" },
      { pivotId: "p2", biFieldKey: "Customers.Region" },
    ]);
    expect(clears.every((c) => !("fieldIndex" in requestOf(c)))).toBe(true);
    // It never looks a field up by name itself (the old bare-name fallback).
    expect(calls.some((c) => c.cmd === "get_pivot_hierarchies")).toBe(false);
    expect(clears.every((c) => c.tx === "Ribbon filter change")).toBe(true);
  });

  it("no pivots: no transaction, no call", async () => {
    await clearModelColumnOnPivots("Customers.Region", []);
    expect(calls).toEqual([]);
    expect(txLabels).toEqual([]);
  });
});
