//! FILENAME: app/extensions/Slicer/lib/__tests__/slicerClickOneStep.test.ts
// PURPOSE: S1 (BUG-0187) and S2 (BUG-0200). A slicer click is ONE backend
//          command -- the selection AND every pivot write -- that records ONE
//          undo step at the end. It used to be a FRONTEND transaction held
//          open across the pivot writes (a model re-query that can take
//          seconds): an unrelated edit made during a slow click joined the
//          click's Ctrl+Z step, and a script's `beginBatch` joined it too.
//
//          - No undo transaction is open while a pivot filter is written.
//          - The click's writes travel in ONE command, and a user click is a
//            step of its OWN ("own"), even while a script batch is open.
//          - A script's own call joins the batch it opened ("join") and the
//            frontend neither begins nor commits anything around it (its
//            commit used to close the script's batch half-way).
//          - A TABLE target is filtered by the click's OWN backend command,
//            inside its one step (W2): the frontend writes nothing, leaves
//            nothing open and commits nothing; it announces the AutoFilter
//            change the way an undo of it does (the `objects` domain) and
//            reports a refused table in the one toast. (It used to filter
//            tables itself after the command, which left the step OPEN for
//            them -- "ownLeftOpen" -- and anything the user did meanwhile
//            joined the click.)
//          - The overwrite question is asked once, after the step landed, and
//            a decline hands back the step's token.
//
// The backend is a double of the Tauri shape: every invoke returns a Promise.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Slicer } from "../slicerTypes";

const h = vi.hoisted(() => ({
  /** The frontend-visible undo transaction (begin/commit through tauri-api). */
  txOpen: false,
  /** A transaction a script opened on the BACKEND directly. */
  scriptBatchOpen: false,
  log: [] as string[],
  /** Every command that WROTE a pivot filter, with the transaction state then. */
  pivotWrites: [] as Array<{ cmd: string; txOpen: boolean; args: Record<string, unknown> | undefined }>,
  gesture: null as null | { step: string; writes: unknown[] },
  answer: {
    responses: [{ pivotId: "p1", overwrittenCellCount: 0 }] as Array<Record<string, unknown>>,
    step: "pushed",
    overwriteToken: null as number | null,
    tableSheets: [] as number[],
    tableFailures: [] as Array<{ tableId: string; clearing: boolean; message: string }>,
  },
  emitted: [] as Array<{ event: string; payload: unknown }>,
  toast: vi.fn(),
  slicers: [] as Slicer[],
  confirm: vi.fn((..._a: unknown[]): Promise<boolean> => Promise.resolve(true)),
  undo: vi.fn((..._a: unknown[]) => Promise.resolve({ stepsUndone: 1, complete: true, refreshDomains: ["slicer"] })),
  autoFilter: [] as string[],
  /** When set, the gesture's backend command lands only once this settles. */
  holdGesture: null as null | Promise<void>,
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
  getUndoState: async () => ({ undoSeqs: [], transactionOpen: h.txOpen || h.scriptBatchOpen }),
}));

vi.mock("../slicerBackend", () => ({
  slicerBackend: {
    invoke: (cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case "get_all_slicers":
          return Promise.resolve(h.slicers.map((s) => ({ ...s })));
        case "get_slicer_items":
          return Promise.resolve([]);
        case "get_pivots_for_bi_connection":
          return Promise.resolve([{ id: "p1", name: "P1", sheetIndex: 2 }]);
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
        case "update_slicer_selection": {
          const gesture = (args as { gesture?: { step: string; writes: unknown[] } }).gesture;
          h.log.push(gesture ? `gesture:${gesture.step}` : "select");
          if (!gesture) return Promise.resolve(null);
          h.gesture = gesture;
          if (gesture.writes.length > 0) {
            h.pivotWrites.push({ cmd, txOpen: h.txOpen, args });
          }
          const step = gesture.step.startsWith("join") && h.scriptBatchOpen ? "joined" : h.answer.step;
          return (h.holdGesture ?? Promise.resolve()).then(() => ({
            responses: h.answer.responses,
            failures: [],
            step,
            stepSeq: step === "pushed" ? 7 : null,
            overwriteToken: h.answer.overwriteToken,
            tableSheets: h.answer.tableSheets,
            tableFailures: h.answer.tableFailures,
          }));
        }
        case "apply_pivot_filter":
        case "clear_pivot_filter":
          h.log.push(cmd);
          h.pivotWrites.push({ cmd, txOpen: h.txOpen, args });
          return Promise.resolve({ pivotId: "p1", overwrittenCellCount: 0 });
        default:
          return Promise.resolve(undefined);
      }
    },
  },
}));

vi.mock("@api/autoFilterService", () => ({
  requireAutoFilterController: () => ({
    get: async () => ({ id: "af1", startRow: 0, startCol: 0, endRow: 9, endCol: 1 }),
    setColumn: async () => {
      h.log.push("table:setColumn");
      return null;
    },
    clear: async () => {
      h.log.push("table:clear");
      return null;
    },
  }),
}));
vi.mock("@api/gridOverlays", () => ({
  replaceGridRegionsByType: vi.fn(),
  removeGridRegionsByType: vi.fn(),
  requestOverlayRedraw: vi.fn(),
}));
vi.mock("@api/state", () => ({
  getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: 2 } }),
}));
vi.mock("@api", () => ({
  emitAppEvent: (event: string, payload?: unknown) => {
    h.emitted.push({ event, payload });
  },
  AppEvents: { GRID_REFRESH: "app:grid-refresh", MUTATION_REFRESH: "app:mutation-refresh" },
}));
vi.mock("@api/notifications", () => ({ showToast: (...a: unknown[]) => h.toast(...a) }));
vi.mock("@api/pivotNotices", () => ({ surfacePivotNotices: vi.fn() }));
vi.mock("@api/dialogs", () => ({
  confirmAsync: (...a: unknown[]) => {
    h.log.push("ask");
    return h.confirm(...a);
  },
}));
vi.mock("@api/backend", () => ({ undoPivotOverwrite: (...a: unknown[]) => h.undo(...a) }));

import {
  clickSlicerItem,
  isSlicerGestureLanding,
  refreshCache,
  resetStore,
  updateSlicerSelectionAsync,
} from "../slicerStore";
import { refuseUndoWhileAGestureLands, UNDO_WHILE_A_GESTURE_LANDS } from "@api/objectGeometry";
import { commandRefusalFor } from "@api/keybindings";
import { CoreCommands } from "@api/commands";

function slicer(overrides: Partial<Slicer> = {}): Slicer {
  return {
    id: "s1",
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

beforeEach(async () => {
  resetStore();
  h.txOpen = false;
  h.scriptBatchOpen = false;
  h.log.length = 0;
  h.pivotWrites.length = 0;
  h.gesture = null;
  h.answer = {
    responses: [{ pivotId: "p1", overwrittenCellCount: 0 }],
    step: "pushed",
    overwriteToken: null,
    tableSheets: [],
    tableFailures: [],
  };
  h.emitted.length = 0;
  h.toast.mockReset();
  h.confirm.mockReset().mockImplementation(() => Promise.resolve(true));
  h.undo.mockClear();
  h.slicers = [slicer()];
  h.holdGesture = null;
  await refreshCache();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("a keyboard Undo / Redo while a click LANDS (the review of BUG-0187)", () => {
  it("is refused with one sentence until the click's step landed (the backend refuses it too)", async () => {
    let release!: () => void;
    h.holdGesture = new Promise<void>((resolve) => {
      release = resolve;
    });
    const off = refuseUndoWhileAGestureLands(isSlicerGestureLanding);
    try {
      expect(commandRefusalFor(CoreCommands.UNDO), "fixture: nothing lands yet").toBeNull();
      const click = clickSlicerItem("s1", "West", false);
      await vi.waitFor(() => expect(h.gesture, "fixture: the click reached its backend command").not.toBeNull());
      expect(isSlicerGestureLanding(), "the click in flight does not read as landing").toBe(true);
      expect(commandRefusalFor(CoreCommands.UNDO), "Ctrl+Z mid-click was not refused").toBe(UNDO_WHILE_A_GESTURE_LANDS);
      expect(commandRefusalFor(CoreCommands.REDO), "Ctrl+Y mid-click was not refused").toBe(UNDO_WHILE_A_GESTURE_LANDS);
      release();
      await click;
      expect(isSlicerGestureLanding(), "the click landed and still reads as landing").toBe(false);
      expect(commandRefusalFor(CoreCommands.UNDO), "Ctrl+Z after the click landed is still refused").toBeNull();
    } finally {
      off();
    }
  });
});

describe("a slicer click is ONE backend command that records ONE step", () => {
  it("holds NO undo transaction open while its pivot filter is written (BUG-0187)", async () => {
    await clickSlicerItem("s1", "West", false);

    expect(h.pivotWrites.length).toBeGreaterThan(0);
    for (const write of h.pivotWrites) {
      expect(write.txOpen, `${write.cmd} ran inside an open undo transaction`).toBe(false);
    }
    expect(h.log.filter((l) => l.startsWith("begin"))).toEqual([]);
  });

  it("sends the selection and every pivot write in ONE command", async () => {
    await clickSlicerItem("s1", "West", false);

    expect(h.pivotWrites).toHaveLength(1);
    expect(h.pivotWrites[0].cmd).toBe("update_slicer_selection");
    expect(h.gesture?.writes).toEqual([
      {
        apply: {
          pivotId: "p1",
          biFieldKey: "Geo.Region",
          filters: { manualFilter: { selectedItems: ["West"] } },
          filterLevel: 1,
          slicerId: "s1",
        },
      },
    ]);
  });

  it("a USER click is a step of its own, even while a script batch is open (BUG-0200)", async () => {
    h.scriptBatchOpen = true;
    await clickSlicerItem("s1", "West", false);
    expect(h.gesture?.step).toBe("own");
    expect(h.log).not.toContain("commit");
  });

  it("a SCRIPT's call joins the batch it opened: no frontend begin, no commit", async () => {
    h.scriptBatchOpen = true;
    await updateSlicerSelectionAsync("s1", ["West"]);
    expect(h.gesture?.step).toBe("join");
    expect(h.log).toEqual(["gesture:join"]);
  });

  it("a TABLE target is filtered by the click's own command: nothing written, left open or committed here (W2)", async () => {
    h.slicers = [
      slicer({ sourceType: "table", cacheSourceId: "t1", connectedSources: [{ sourceType: "table", sourceId: "t1" }] }),
    ];
    await refreshCache();
    h.answer.responses = [];
    h.answer.tableSheets = [2];
    await clickSlicerItem("s1", "West", false);
    expect(h.gesture?.step, "a click with tables still asked for a step LEFT OPEN").toBe("own");
    expect(h.gesture?.writes, "a table target was sent as a pivot write").toEqual([]);
    expect(h.log, "the frontend filtered the table itself, or committed a step").toEqual(["gesture:own"]);
    // The AutoFilter owner re-reads: the announcement an undo of the same
    // restore makes, with no extension named.
    expect(h.emitted).toContainEqual({
      event: "app:mutation-refresh",
      payload: { domains: ["objects"], source: "commit" },
    });
    expect(h.emitted.map((e) => e.event)).toContain("app:grid-refresh");
  });

  it("a click whose tables did not move announces no AutoFilter re-read", async () => {
    h.slicers = [
      slicer({ sourceType: "table", cacheSourceId: "t1", connectedSources: [{ sourceType: "table", sourceId: "t1" }] }),
    ];
    await refreshCache();
    h.answer.responses = [];
    h.answer.step = "nothing";
    await clickSlicerItem("s1", "West", false);
    expect(h.emitted.map((e) => e.event)).not.toContain("app:mutation-refresh");
  });

  it("a table the backend could not filter is told in the gesture's ONE toast", async () => {
    h.slicers = [
      slicer({ sourceType: "table", cacheSourceId: "t1", connectedSources: [{ sourceType: "table", sourceId: "t1" }] }),
    ];
    await refreshCache();
    h.answer.responses = [];
    h.answer.tableFailures = [{ tableId: "t1", clearing: false, message: "The sheet is protected." }];
    await clickSlicerItem("s1", "West", false);
    expect(h.toast).toHaveBeenCalledTimes(1);
    expect(String(h.toast.mock.calls[0][0])).toContain("1 table");
    expect(String(h.toast.mock.calls[0][0])).toContain("The sheet is protected.");
  });

  it("a SCRIPT's call with table targets joins its batch like any other (never left open)", async () => {
    h.slicers = [
      slicer({ sourceType: "table", cacheSourceId: "t1", connectedSources: [{ sourceType: "table", sourceId: "t1" }] }),
    ];
    await refreshCache();
    h.scriptBatchOpen = true;
    await updateSlicerSelectionAsync("s1", ["West"]);
    expect(h.gesture?.step).toBe("join");
    expect(h.log).toEqual(["gesture:join"]);
  });

  it("asks NOTHING when the backend JOINED a stranger's open transaction", async () => {
    h.answer.step = "joined";
    h.answer.responses = [{ pivotId: "p1", overwrittenCellCount: 3, overwriteToken: 11 }];
    h.answer.overwriteToken = 11;
    await clickSlicerItem("s1", "West", false);
    expect(h.log).toEqual(["gesture:own"]);
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it("asks ONCE after the step landed, and a decline hands back the step's token", async () => {
    h.answer.responses = [{ pivotId: "p1", overwrittenCellCount: 3, overwriteToken: 11 }];
    h.answer.overwriteToken = 11;
    h.confirm.mockImplementation(() => Promise.resolve(false));
    await clickSlicerItem("s1", "West", false);
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.confirm.mock.calls[0][0]).toContain("3 cells");
    expect(h.log.indexOf("ask")).toBeGreaterThan(h.log.indexOf("gesture:own"));
    expect(h.undo).toHaveBeenCalledTimes(1);
    expect(h.undo.mock.calls[0][1]).toEqual([11]);
  });

  it("never asks when its step was not its own (nothing recorded)", async () => {
    h.answer.responses = [{ pivotId: "p1", overwrittenCellCount: 3 }];
    h.answer.step = "nothing";
    await clickSlicerItem("s1", "West", false);
    expect(h.confirm).not.toHaveBeenCalled();
  });
});
