// FILENAME: app/extensions/Collaboration/lib/__tests__/writebackStore.test.ts
// PURPOSE: The shared writeback snapshot: keyed by LOCAL sheet id and resolved
//          against the ACTIVE sheet at check time, per-region summaries, the
//          unsent-draft total, notify + repaint on every refresh, and a failed
//          read that keeps the previous snapshot and reports the error.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  getWritebackRegions: vi.fn(),
  getWritebackLayer: vi.fn(),
  getWritebackDraftRegions: vi.fn(),
  reconcileWriteback: vi.fn(),
  emitAppEvent: vi.fn(),
  gridState: null as null | {
    sheetContext: { activeSheetIndex: number; activeSheetName: string };
    surface: string;
  },
  pages: {
    pages: [] as { sheetId: string; name: string }[],
    sheetIdByIndex: new Map<number, string>(),
    activeIndex: 0,
    version: 0,
  },
  pageListeners: new Set<() => void>(),
}));

vi.mock("@api/collaboration", () => ({
  getWritebackRegions: h.getWritebackRegions,
  getWritebackLayer: h.getWritebackLayer,
  getWritebackDraftRegions: h.getWritebackDraftRegions,
  reconcileWriteback: h.reconcileWriteback,
}));
vi.mock("@api/grid", () => ({
  getGridStateSnapshot: () => h.gridState,
}));
vi.mock("@api/reportPages", () => ({
  startReportPages: () => () => {},
  getReportPagesSnapshot: () => h.pages,
  onReportPagesChanged: (cb: () => void) => {
    h.pageListeners.add(cb);
    return () => h.pageListeners.delete(cb);
  },
  sheetIdAt: (snap: { sheetIdByIndex: Map<number, string> }, index: number | undefined) =>
    typeof index === "number" ? snap.sheetIdByIndex.get(index) ?? null : null,
  reportPageById: (snap: { pages: { sheetId: string; name: string }[] }, id: string) =>
    snap.pages.find((p) => p.sheetId === id) ?? null,
}));
vi.mock("@api/events", () => ({
  emitAppEvent: h.emitAppEvent,
  AppEvents: { GRID_REFRESH: "app:grid-refresh" },
}));

import {
  refreshWriteback,
  resetWritebackSnapshot,
  startWritebackStore,
  subscribeWritebackSnapshot,
  getWritebackSnapshotVersion,
  hasWritebackRegions,
  getRegionAt,
  getActiveSheetId,
  getActiveSheetRegions,
  getActiveRegionAt,
  getActiveCellState,
  getWritebackCellStateAt,
  activeRangeOverlapsWriteback,
  getRegionSummary,
  listRegionSummaries,
  totalUnsentDrafts,
  getWritebackRefreshError,
  getWritebackReconcileError,
  isWritebackSnapshotLoaded,
  regionRangeA1,
  hasWritebackFrames,
  getActiveSheetFrameRegions,
  getDesignatedRegionCount,
} from "../writebackStore";

function region(over: Record<string, unknown> = {}) {
  return {
    sheetId: "local-sheet-2",
    sheetIndex: 1,
    regionId: "r1",
    packageName: "writeback-test",
    registryUrl: "C:/ws",
    rowStart: 2,
    rowEnd: 4,
    colStart: 1,
    colEnd: 1,
    valueType: "number",
    submissionPolicy: "on_submit",
    visibility: "own_plus_aggregate",
    sheetName: "Report",
    ...over,
  };
}

function entry(row: number, state: string, over: Record<string, unknown> = {}) {
  return {
    id: `e-${row}-${state}`,
    regionId: "r1",
    cellRow: row,
    cellCol: 1,
    submitter: { id: "u", name: "U" },
    value: { type: "number", value: row },
    state,
    createdAt: "2026-10-21T00:00:00Z",
    updatedAt: "2026-10-21T00:00:00Z",
    ...over,
  };
}

function activeSheet(index: number, surface = "grid") {
  h.gridState = {
    sheetContext: { activeSheetIndex: index, activeSheetName: `S${index}` },
    surface,
  };
}

beforeEach(() => {
  resetWritebackSnapshot();
  h.getWritebackRegions.mockReset();
  h.getWritebackLayer.mockReset();
  h.reconcileWriteback.mockReset();
  h.getWritebackDraftRegions.mockReset();
  h.getWritebackDraftRegions.mockResolvedValue([]);
  h.emitAppEvent.mockReset();
  h.pages.sheetIdByIndex = new Map([
    [0, "local-sheet-1"],
    [1, "local-sheet-2"],
  ]);
  h.pages.pages = [];
  activeSheet(1);
});

describe("refresh", () => {
  it("loads regions and layer, notifies subscribers and requests a repaint", async () => {
    h.getWritebackRegions.mockResolvedValue([region()]);
    h.reconcileWriteback.mockResolvedValue({ formatVersion: 1, drafts: [entry(2, "draft")] });
    const cb = vi.fn();
    const off = subscribeWritebackSnapshot(cb);
    const before = getWritebackSnapshotVersion();
    await refreshWriteback();
    off();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(getWritebackSnapshotVersion()).toBe(before + 1);
    expect(hasWritebackRegions()).toBe(true);
    expect(isWritebackSnapshotLoaded()).toBe(true);
    expect(h.emitAppEvent).toHaveBeenCalledWith("app:grid-refresh");
  });

  it("falls back to the local layer when reconcile fails (offline) without an error", async () => {
    h.getWritebackRegions.mockResolvedValue([region()]);
    h.reconcileWriteback.mockRejectedValue(new Error("offline"));
    h.getWritebackLayer.mockResolvedValue({ formatVersion: 1, drafts: [entry(3, "draft")] });
    await refreshWriteback();
    expect(getWritebackRefreshError()).toBeNull();
    expect(getActiveCellState(3, 1)).toBe("draft");
    // ...but WHY it could not reconcile is kept for Check Status, which must
    // not ask the workspace a second time.
    expect(getWritebackReconcileError()).toContain("offline");
    h.reconcileWriteback.mockResolvedValue({ formatVersion: 1, drafts: [] });
    await refreshWriteback();
    expect(getWritebackReconcileError()).toBeNull();
    expect(h.reconcileWriteback).toHaveBeenCalledTimes(2);
  });

  it("a failed region read keeps the previous snapshot and reports the error", async () => {
    h.getWritebackRegions.mockResolvedValueOnce([region()]);
    h.reconcileWriteback.mockResolvedValue({ formatVersion: 1, drafts: [] });
    await refreshWriteback();
    h.getWritebackRegions.mockRejectedValueOnce(new Error("ipc down"));
    await refreshWriteback();
    expect(hasWritebackRegions()).toBe(true);
    expect(getWritebackRefreshError()).toContain("ipc down");
    // ...and the next good read clears it.
    h.getWritebackRegions.mockResolvedValueOnce([region()]);
    await refreshWriteback();
    expect(getWritebackRefreshError()).toBeNull();
  });

  it("requests made together share one read", async () => {
    h.getWritebackRegions.mockResolvedValue([region()]);
    h.reconcileWriteback.mockResolvedValue({ formatVersion: 1, drafts: [] });
    await Promise.all([refreshWriteback(), refreshWriteback(), refreshWriteback()]);
    expect(h.getWritebackRegions).toHaveBeenCalledTimes(1);
  });
});

describe("keyed by LOCAL sheet id, resolved against the ACTIVE sheet", () => {
  beforeEach(async () => {
    h.getWritebackRegions.mockResolvedValue([region()]);
    h.reconcileWriteback.mockResolvedValue({
      formatVersion: 1,
      drafts: [entry(2, "draft"), entry(3, "submitted"), entry(4, "rejected")],
    });
    await refreshWriteback();
  });

  it("finds the region by sheet id and cell", () => {
    expect(getRegionAt("local-sheet-2", 3, 1)?.regionId).toBe("r1");
    expect(getRegionAt("local-sheet-2", 5, 1)).toBeNull();
    expect(getRegionAt("local-sheet-1", 3, 1)).toBeNull();
    expect(getWritebackCellStateAt("local-sheet-2", 3, 1)).toBe("submitted");
  });

  it("answers only on the active sheet", () => {
    expect(getActiveSheetId()).toBe("local-sheet-2");
    expect(getActiveRegionAt(2, 1)?.regionId).toBe("r1");
    activeSheet(0);
    expect(getActiveRegionAt(2, 1)).toBeNull();
    expect(getActiveCellState(2, 1)).toBeNull();
    expect(activeRangeOverlapsWriteback(0, 0, 10, 10)).toBeNull();
  });

  it("follows a moved sheet without a refresh (the index is not trusted)", () => {
    // The subscribed sheet moved to index 0; the backend's cached sheetIndex (1) is stale.
    h.pages.sheetIdByIndex = new Map([
      [0, "local-sheet-2"],
      [1, "local-sheet-1"],
    ]);
    activeSheet(1);
    expect(getActiveRegionAt(2, 1)).toBeNull();
    activeSheet(0);
    expect(getActiveRegionAt(2, 1)?.regionId).toBe("r1");
  });

  it("falls back to the backend index only before the sheet list was read", () => {
    h.pages.sheetIdByIndex = new Map();
    activeSheet(1);
    expect(getActiveRegionAt(2, 1)?.regionId).toBe("r1");
    activeSheet(0);
    expect(getActiveRegionAt(2, 1)).toBeNull();
  });

  it("has no regions on a canvas page", () => {
    activeSheet(1, "canvas");
    expect(getActiveSheetRegions()).toHaveLength(0);
  });

  it("reports cell states per region + cell", () => {
    expect(getActiveCellState(2, 1)).toBe("draft");
    expect(getActiveCellState(3, 1)).toBe("submitted");
    expect(getActiveCellState(4, 1)).toBe("rejected");
  });

  it("an unsent draft decides a cell over an older submitted entry", async () => {
    h.reconcileWriteback.mockResolvedValue({
      formatVersion: 1,
      drafts: [
        entry(2, "submitted", { updatedAt: "2026-10-21T02:00:00Z" }),
        entry(2, "draft", { updatedAt: "2026-10-21T01:00:00Z" }),
      ],
    });
    await refreshWriteback();
    expect(getActiveCellState(2, 1)).toBe("draft");
  });

  it("overlap check answers the region a bulk range touches", () => {
    expect(activeRangeOverlapsWriteback(0, 0, 2, 1)?.regionId).toBe("r1");
    expect(activeRangeOverlapsWriteback(0, 0, 1, 5)).toBeNull();
  });
});

describe("summaries", () => {
  it("counts each state, the empty cells, and the unsent total", async () => {
    h.getWritebackRegions.mockResolvedValue([
      region(),
      region({ regionId: "r2", rowStart: 10, rowEnd: 11, colStart: 3, colEnd: 3, sheetName: "" }),
    ]);
    h.reconcileWriteback.mockResolvedValue({
      formatVersion: 1,
      drafts: [
        entry(2, "draft"),
        entry(3, "draft", { value: { type: "empty" } }),
        entry(4, "approved"),
        entry(10, "draft", { regionId: "r2", cellCol: 3 }),
        // An orphan (its region is gone) is not counted anywhere.
        entry(2, "draft", { regionId: "gone" }),
      ],
    });
    await refreshWriteback();
    const s = getRegionSummary("r1")!;
    expect(s).toMatchObject({
      regionId: "r1",
      applicationName: "writeback-test",
      sheetName: "Report",
      rangeA1: "B3:B5",
      draftCount: 2,
      submittedCount: 0,
      approvedCount: 1,
      rejectedCount: 0,
      emptyCount: 0,
      visibility: "own_plus_aggregate",
      submissionPolicy: "on_submit",
    });
    const s2 = getRegionSummary("r2")!;
    expect(s2.emptyCount).toBe(1);
    expect(s2.sheetName).toBeUndefined();
    expect(listRegionSummaries().map((x) => x.regionId)).toEqual(["r1", "r2"]);
    expect(totalUnsentDrafts()).toBe(3);
  });

  it("follows a sheet rename without a re-read (the live page name wins)", async () => {
    h.getWritebackRegions.mockResolvedValue([region()]);
    h.reconcileWriteback.mockResolvedValue({ formatVersion: 1, drafts: [] });
    await refreshWriteback();
    expect(getRegionSummary("r1")!.sheetName).toBe("Report");
    h.pages.pages = [{ sheetId: "local-sheet-2", name: "Answers" }];
    expect(getRegionSummary("r1")!.sheetName).toBe("Answers");
    expect(h.getWritebackRegions).toHaveBeenCalledTimes(1);
  });

  it("A1 of a one-cell region is one cell", () => {
    expect(regionRangeA1({ rowStart: 0, rowEnd: 0, colStart: 27, colEnd: 27 })).toBe("AB1");
  });
});

describe("lifecycle", () => {
  it("a sheet-map change re-derives consumers and repaints while regions exist", async () => {
    const stop = startWritebackStore();
    h.getWritebackRegions.mockResolvedValue([region()]);
    h.reconcileWriteback.mockResolvedValue({ formatVersion: 1, drafts: [] });
    await refreshWriteback();
    h.emitAppEvent.mockClear();
    const cb = vi.fn();
    const off = subscribeWritebackSnapshot(cb);
    for (const l of h.pageListeners) l();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(h.emitAppEvent).toHaveBeenCalledWith("app:grid-refresh");
    off();
    stop();
    expect(h.pageListeners.size).toBe(0);
  });

  it("reset empties the snapshot and abandons a read in flight", async () => {
    let resolve!: (v: unknown) => void;
    h.getWritebackRegions.mockReturnValue(new Promise((r) => (resolve = r)));
    h.reconcileWriteback.mockResolvedValue({ formatVersion: 1, drafts: [] });
    const pending = refreshWriteback();
    await Promise.resolve();
    resetWritebackSnapshot();
    resolve([region()]);
    await pending;
    expect(hasWritebackRegions()).toBe(false);
  });
});

describe("the author's own designated regions (frame only)", () => {
  function designated(sheetId: string, id = "d1") {
    return { id, selector: { sheetId, rowStart: 2, rowEnd: 4, colStart: 1, colEnd: 1 } };
  }

  it("frames an author's region on the active sheet with no subscription at all", async () => {
    h.getWritebackRegions.mockResolvedValue([]);
    h.reconcileWriteback.mockResolvedValue({ formatVersion: 1, drafts: [] });
    h.getWritebackDraftRegions.mockResolvedValue([designated("local-sheet-2")]);
    await refreshWriteback();
    expect(hasWritebackRegions()).toBe(false); // no tab, no markers, no guards
    expect(hasWritebackFrames()).toBe(true);
    expect(getDesignatedRegionCount()).toBe(1);
    expect(getActiveSheetFrameRegions()).toEqual([
      { sheetId: "local-sheet-2", rowStart: 2, rowEnd: 4, colStart: 1, colEnd: 1 },
    ]);
    activeSheet(0);
    expect(getActiveSheetFrameRegions()).toEqual([]);
    activeSheet(1, "canvas");
    expect(getActiveSheetFrameRegions()).toEqual([]);
  });

  it("frames subscribed and designated regions side by side", async () => {
    h.getWritebackRegions.mockResolvedValue([region()]);
    h.reconcileWriteback.mockResolvedValue({ formatVersion: 1, drafts: [] });
    h.getWritebackDraftRegions.mockResolvedValue([designated("local-sheet-2")]);
    await refreshWriteback();
    expect(getActiveSheetFrameRegions().length).toBe(2);
  });

  it("a failed read of the author's regions keeps the previous set", async () => {
    h.getWritebackRegions.mockResolvedValue([]);
    h.reconcileWriteback.mockResolvedValue({ formatVersion: 1, drafts: [] });
    h.getWritebackDraftRegions.mockResolvedValue([designated("local-sheet-2")]);
    await refreshWriteback();
    h.getWritebackDraftRegions.mockRejectedValue(new Error("ipc down"));
    await refreshWriteback();
    expect(getDesignatedRegionCount()).toBe(1);
  });

  it("reset forgets them", async () => {
    h.getWritebackRegions.mockResolvedValue([]);
    h.reconcileWriteback.mockResolvedValue({ formatVersion: 1, drafts: [] });
    h.getWritebackDraftRegions.mockResolvedValue([designated("local-sheet-2")]);
    await refreshWriteback();
    resetWritebackSnapshot();
    expect(hasWritebackFrames()).toBe(false);
  });
});
