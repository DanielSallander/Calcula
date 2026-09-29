//! FILENAME: app/extensions/ControlsPane/lib/__tests__/ribbonFilterOneStep.test.ts
// PURPOSE: S1 (BUG-0187) and S2 (BUG-0200) for the RIBBON filter. A filter
//          change is ONE backend command -- the selection AND every pivot
//          write (this filter on each target, plus the other active filters
//          that reach the same pivots) -- that records ONE undo step at the
//          end. It used to be the selection as a step of its own (the backend
//          committed it, closing any open transaction) followed by a FRONTEND
//          transaction held open across the pivots' model re-queries, so an
//          unrelated edit made meanwhile joined the change's step.
//
// The real store and bridge run over a Tauri-shaped backend double; the
// frontend transaction is the real one, over a begin/commit double.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  txOpen: false,
  log: [] as string[],
  pivotWrites: [] as Array<{ cmd: string; txOpen: boolean }>,
  gesture: null as null | { step: string; writes: Array<Record<string, unknown>> },
  filters: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../../../src/core/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/core/lib/tauri-api")>()),
  beginUndoTransaction: async (label: string) => {
    h.log.push(`begin:${label}`);
    h.txOpen = true;
  },
  commitUndoTransaction: async () => {
    h.log.push("commit");
    h.txOpen = false;
  },
  getUndoState: async () => ({ undoSeqs: [], transactionOpen: h.txOpen }),
}));

vi.mock("../filterPaneBackend", () => ({
  filterPaneBackend: {
    invoke: (cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case "get_all_ribbon_filters":
          return Promise.resolve(h.filters.map((f) => ({ ...f })));
        case "get_bi_connections":
          return Promise.resolve([]);
        case "get_pivots_for_bi_connection":
          return Promise.resolve([
            { id: "p1", name: "P1", sheetIndex: 0 },
            { id: "p2", name: "P2", sheetIndex: 1 },
          ]);
        case "recalc_control_dependents":
          return Promise.resolve([]);
        case "update_ribbon_filter_selection": {
          const gesture = (args as { gesture?: { step: string; writes: Array<Record<string, unknown>> } }).gesture;
          h.log.push(gesture ? `gesture:${gesture.step}` : "select");
          if (!gesture) return Promise.resolve(null);
          h.gesture = gesture;
          if (gesture.writes.length > 0) h.pivotWrites.push({ cmd, txOpen: h.txOpen });
          return Promise.resolve({ responses: [], failures: [], step: "pushed", stepSeq: 9, overwriteToken: null });
        }
        case "apply_pivot_filter":
        case "clear_pivot_filter":
          h.log.push(cmd);
          h.pivotWrites.push({ cmd, txOpen: h.txOpen });
          return Promise.resolve({ pivotId: "p1", overwrittenCellCount: 0 });
        default:
          return Promise.resolve(undefined);
      }
    },
  },
}));
vi.mock("@api", () => ({
  emitAppEvent: vi.fn(),
  AppEvents: { GRID_REFRESH: "app:grid-refresh", MUTATION_REFRESH: "app:mutation-refresh" },
}));
vi.mock("@api/notifications", () => ({ showToast: vi.fn() }));
vi.mock("@api/pivotNotices", () => ({ surfacePivotNotices: vi.fn() }));
vi.mock("@api/dialogs", () => ({ confirmAsync: () => Promise.resolve(true) }));

import { clearCache, refreshCache, updateFilterSelectionAsync } from "../filterPaneStore";

function filter(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: id,
    connectionId: "c1",
    fieldName: "Products.Category",
    fieldDataType: "text",
    connectionMode: "workbook",
    connectedPivots: [],
    connectedSheets: [],
    displayMode: "checklist",
    selectedItems: null,
    crossFilterTargets: [],
    crossFilterSlicerTargets: [],
    advancedFilter: null,
    hideNoData: false,
    indicateNoData: true,
    sortNoDataLast: false,
    showSelectAll: true,
    singleSelect: false,
    order: 0,
    buttonColumns: 1,
    buttonRows: 1,
    filterLevel: 1,
    ...overrides,
  };
}

beforeEach(async () => {
  clearCache();
  h.txOpen = false;
  h.log.length = 0;
  h.pivotWrites.length = 0;
  h.gesture = null;
  h.filters = [
    filter("f1"),
    // Another ACTIVE filter that reaches p2 only (by sheet 1).
    filter("f2", { fieldName: "Geo.Region", connectionMode: "bySheet", connectedSheets: [1], selectedItems: ["East"] }),
  ];
  await refreshCache();
  h.log.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("a ribbon filter change is ONE backend command that records ONE step", () => {
  it("holds NO undo transaction open while its pivot filters are written (BUG-0187)", async () => {
    await updateFilterSelectionAsync("f1", ["Books"]);

    expect(h.pivotWrites.length).toBeGreaterThan(0);
    for (const write of h.pivotWrites) {
      expect(write.txOpen, `${write.cmd} ran inside an open undo transaction`).toBe(false);
    }
    expect(h.log.filter((l) => l.startsWith("begin"))).toEqual([]);
  });

  it("sends the selection and every pivot write -- the other active filter on its pivot too -- in ONE command", async () => {
    await updateFilterSelectionAsync("f1", ["Books"]);

    expect(h.pivotWrites).toEqual([{ cmd: "update_ribbon_filter_selection", txOpen: false }]);
    expect(h.gesture?.step).toBe("own");
    expect(h.gesture?.writes).toEqual([
      { apply: { pivotId: "p1", biFieldKey: "Products.Category", filters: { manualFilter: { selectedItems: ["Books"] } }, filterLevel: 1 } },
      { apply: { pivotId: "p2", biFieldKey: "Products.Category", filters: { manualFilter: { selectedItems: ["Books"] } }, filterLevel: 1 } },
      { apply: { pivotId: "p2", biFieldKey: "Geo.Region", filters: { manualFilter: { selectedItems: ["East"] } }, filterLevel: 1 } },
    ]);
  });

  it("a CLEAR takes this filter's column off every target in the same one command", async () => {
    h.filters = [filter("f1", { selectedItems: ["Books"] })];
    await refreshCache();
    await updateFilterSelectionAsync("f1", null);
    expect(h.gesture?.writes).toEqual([
      { clear: { pivotId: "p1", biFieldKey: "Products.Category" } },
      { clear: { pivotId: "p2", biFieldKey: "Products.Category" } },
    ]);
  });
});
