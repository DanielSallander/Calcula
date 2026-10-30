// FILENAME: app/extensions/Collaboration/lib/__tests__/designatedRegionsFollowEdits.test.ts
// PURPOSE: rev4A#1 audit -- the regions THIS workbook designated for writeback
//          (the author's own) follow an insert/delete of rows on a sheet the
//          user is NOT looking at, and the undo of an on-screen one.
// CONTEXT: The backend moves a designated region with its cells on every
//          structural route (`shift_writeback_draft_regions`, structure.rs),
//          including the off-sheet one a script's or the command line's
//          `sheetIndex` takes. The writeback snapshot holds EVERY sheet's
//          regions by sheet id and a tab click re-reads nothing, so while only
//          the four on-screen events were heard, a region moved off screen kept
//          its old rows: the frame was painted there and the publisher's
//          Writeback tab answered for the wrong cells.
//          Real modules: @api/lib's insertRows (core/lib/tauri-api.ts: its real
//          off-sheet branch and announcement), @api/events, the shared structural-event
//          list, lib/writebackStore.ts and the wiring under test. Doubled: Tauri's
//          `invoke` (a backend that moves the region as Rust does) and the
//          @api/collaboration reads.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  active: 0,
  designated: [] as Array<{
    id: string;
    selector: { sheetId: string; rowStart: number; rowEnd: number; colStart: number; colEnd: number };
  }>,
  sheetIdByIndex: new Map<number, string>([
    [0, "local-sheet-1"],
    [1, "local-sheet-2"],
  ]),
  gridActive: 0,
  draftReads: 0,
  reconciles: 0,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "get_active_sheet") return Promise.resolve(h.active);
    if (cmd === "insert_rows") {
      // Rust's shift_regions_for_edit on the edited sheet (rows at or below
      // the insertion point move down).
      const sheet = typeof args?.sheetIndex === "number" ? args.sheetIndex : h.active;
      const sheetId = h.sheetIdByIndex.get(sheet);
      const at = args?.row as number;
      const count = args?.count as number;
      for (const d of h.designated) {
        if (d.selector.sheetId === sheetId && d.selector.rowStart >= at) {
          d.selector.rowStart += count;
          d.selector.rowEnd += count;
        }
      }
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@api/collaboration", () => ({
  getWritebackRegions: async () => [],
  getWritebackLayer: async () => ({ formatVersion: 1, drafts: [] }),
  getWritebackDraftRegions: async () => {
    h.draftReads++;
    return h.designated.map((d) => ({ id: d.id, selector: { ...d.selector } }));
  },
  reconcileWriteback: async () => {
    h.reconciles++;
    return {
      layer: { formatVersion: 1, drafts: [] },
      cellsWritten: 0,
      undoHistoryEnded: false,
      replacedCells: [],
      unreadable: [],
    };
  },
}));
vi.mock("@api/grid", () => ({
  getGridStateSnapshot: () => ({
    sheetContext: { activeSheetIndex: h.gridActive, activeSheetName: `S${h.gridActive}` },
    surface: "grid",
  }),
}));
vi.mock("@api/reportPages", () => ({
  startReportPages: () => () => {},
  getReportPagesSnapshot: () => ({ pages: [], sheetIdByIndex: h.sheetIdByIndex, activeIndex: 0, version: 0 }),
  onReportPagesChanged: () => () => {},
  sheetIdAt: (snap: { sheetIdByIndex: Map<number, string> }, index: number | undefined) =>
    typeof index === "number" ? snap.sheetIdByIndex.get(index) ?? null : null,
  reportPageById: () => null,
}));
vi.mock("@api/notifications", () => ({ showToast: vi.fn() }));

import { insertRows } from "@api/lib";
import { AppEvents, emitAppEvent, onAppEvent } from "@api/events";
import {
  refreshWriteback,
  resetWritebackSnapshot,
  getActiveDesignatedRegionAt,
  getActiveSheetFrameRegions,
  getDesignatedRegionCount,
} from "../writebackStore";
import { followStructuralEditsForDesignatedRegions } from "../designatedRegionsFollowEdits";

/** The off-sheet announcement's burst window (core/lib/tauri-api.ts). */
const WINDOW_MS = 50;

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(WINDOW_MS + 1);
  await vi.advanceTimersByTimeAsync(WINDOW_MS + 1);
}

let unwire: (() => void) | null = null;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  resetWritebackSnapshot();
  h.active = 0;
  h.gridActive = 0;
  // "Log" (sheet 1, not on screen) holds the author's region B6:B8.
  h.designated = [{ id: "d1", selector: { sheetId: "local-sheet-2", rowStart: 5, rowEnd: 7, colStart: 1, colEnd: 1 } }];
  unwire = followStructuralEditsForDesignatedRegions((eventName, cb) => onAppEvent(eventName, cb));
  await refreshWriteback();
  await settle();
  h.draftReads = 0;
  h.reconciles = 0;
  expect(getDesignatedRegionCount()).toBe(1);
});

afterEach(async () => {
  unwire?.();
  unwire = null;
  await vi.runAllTimersAsync();
  vi.useRealTimers();
});

describe("a designated writeback region follows a structural edit wherever it landed", () => {
  // SABOTAGE: subscribe only the four on-screen events in
  // designatedRegionsFollowEdits.ts (drop STRUCTURAL_EDIT_ELSEWHERE) -> no
  // re-read; on Log the region is still framed at B6:B8 and B6 still answers.
  it("api.insertRows(2, 1, 'Log') while Sheet1 is on screen: on Log the frame and the Writeback tab are at B7:B9", async () => {
    await insertRows(2, 1, 1);
    await settle();

    expect(h.draftReads, "the snapshot re-read the author's regions").toBeGreaterThan(0);
    // An edit off screen moved only this workbook's own regions: no workspace round trip.
    expect(h.reconciles, "the off-sheet re-read is local").toBe(0);

    // The user switches to Log.
    h.gridActive = 1;
    expect(getActiveSheetFrameRegions()).toEqual([
      { sheetId: "local-sheet-2", rowStart: 6, rowEnd: 8, colStart: 1, colEnd: 1 },
    ]);
    expect(getActiveDesignatedRegionAt(8, 1)?.id, "B9 is in the moved region").toBe("d1");
    expect(getActiveDesignatedRegionAt(5, 1), "B6 is no longer in it").toBeNull();
  });

  // SABOTAGE: drop STRUCTURAL_UNDO from the wiring (the old four-event list) ->
  // the region an undo put back keeps its moved rows.
  it("the UNDO of an on-screen insert (STRUCTURAL_UNDO) re-reads the regions it put back", async () => {
    h.designated[0].selector.rowStart = 9;
    h.designated[0].selector.rowEnd = 11;
    emitAppEvent(AppEvents.STRUCTURAL_UNDO, { description: "Insert Rows" });
    await settle();
    h.gridActive = 1;
    expect(getActiveSheetFrameRegions()).toEqual([
      { sheetId: "local-sheet-2", rowStart: 9, rowEnd: 11, colStart: 1, colEnd: 1 },
    ]);
  });

  // rev6B#4. A delete that takes a region's every cell drops it, and its undo
  // puts it back (the `obj_writeback_regions` restore). When that was the
  // workbook's LAST region the count read 0 after the delete, and the undo's
  // re-read was skipped: no frame, and the Writeback tab answered null, so
  // the author could designate the same cells twice.
  // SABOTAGE: drop the STRUCTURAL_UNDO subscription that runs at count 0 ->
  // no re-read; the count stays 0 and B6 answers null.
  it("the UNDO of a delete that dropped the workbook's LAST region re-reads it (locally)", async () => {
    // Delete Rows 6:8 on Log: the backend drops the region with its cells.
    const saved = h.designated[0];
    h.designated = [];
    emitAppEvent(AppEvents.ROWS_DELETED, { startRow: 5, count: 3 });
    await settle();
    expect(getDesignatedRegionCount(), "the delete's re-read saw the region go").toBe(0);

    // Ctrl+Z: the backend resurrects it and Core announces STRUCTURAL_UNDO.
    h.designated = [saved];
    h.draftReads = 0;
    h.reconciles = 0;
    emitAppEvent(AppEvents.STRUCTURAL_UNDO, { description: "Delete Rows" });
    await settle();
    expect(h.draftReads, "the undo re-read the author's regions").toBe(1);
    expect(h.reconciles, "an undo puts back this workbook's own regions: no workspace round trip").toBe(0);
    expect(getDesignatedRegionCount()).toBe(1);
    h.gridActive = 1;
    expect(getActiveDesignatedRegionAt(5, 1)?.id, "B6 is in the region again").toBe("d1");
  });

  it("an undo in a workbook WITH regions re-reads once, as before (no second read)", async () => {
    h.draftReads = 0;
    h.reconciles = 0;
    emitAppEvent(AppEvents.STRUCTURAL_UNDO, { description: "Insert Rows" });
    await settle();
    expect(h.draftReads).toBe(1);
    expect(h.reconciles).toBe(1);
  });

  it("an on-screen Insert Rows still re-reads WITH the workspace reconcile, as before", async () => {
    emitAppEvent(AppEvents.ROWS_INSERTED, { startRow: 0, count: 1 });
    await settle();
    expect(h.draftReads).toBeGreaterThan(0);
    expect(h.reconciles).toBe(1);
  });

  it("a workbook that designated no region reads nothing on an off-sheet edit", async () => {
    h.designated = [];
    await refreshWriteback();
    await settle();
    expect(getDesignatedRegionCount()).toBe(0);
    h.draftReads = 0;
    await insertRows(2, 1, 1);
    await settle();
    expect(h.draftReads).toBe(0);
  });
});
