//! FILENAME: app/extensions/Insights/__tests__/sheetOverlay.test.ts
// PURPOSE: The cell overlay: a range's facts land on the sheet rows the facts
//          document names; a pivot's rectangle comes from its grid region; a
//          card can narrow to one fact; a cell change inside the rectangle
//          recomputes once (debounced) and one outside does not; the
//          decoration draws only cells that carry a cue on the active sheet.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  regions: { current: [] as unknown[] },
  activeSheet: { current: 0 },
  emitted: [] as string[],
  decorations: [] as Array<{ id: string; fn: (c: unknown) => void; priority: number; anchor: string }>,
}));

vi.mock("@api/backendCommands", () => ({
  createBackendChannel: () => ({ set: () => undefined, invoke: (...a: unknown[]) => h.invoke(...a), bound: true }),
}));
vi.mock("@api/grid", () => ({
  getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: h.activeSheet.current, activeSheetName: "Sales" } }),
  navigateToRange: vi.fn(),
}));
vi.mock("@api/types", () => ({ columnToLetter: (c: number) => String.fromCharCode(65 + c) }));
vi.mock("@api/gridOverlays", () => ({ getGridRegions: () => h.regions.current }));
vi.mock("@api/cellDecorations", () => ({
  registerCellDecoration: (id: string, fn: (c: unknown) => void, priority: number, anchor: string) => {
    h.decorations.push({ id, fn, priority, anchor });
    return () => { h.decorations.splice(h.decorations.findIndex((d) => d.id === id), 1); };
  },
}));
vi.mock("@api/events", async () => {
  const listeners = new Map<string, Set<(d: unknown) => void>>();
  return {
    AppEvents: { GRID_REFRESH: "app:grid-refresh", CELL_VALUES_CHANGED: "app:cell-values-changed", AFTER_OPEN: "x", AFTER_NEW: "y" },
    emitAppEvent: (name: string, detail?: unknown) => { h.emitted.push(name); for (const l of listeners.get(name) ?? []) l(detail); },
    onAppEvent: (name: string, cb: (d: unknown) => void) => {
      const set = listeners.get(name) ?? new Set();
      set.add(cb); listeners.set(name, set);
      return () => { set.delete(cb); };
    },
  };
});

const sheet = await import("../lib/sheetOverlay");
const cells = await import("@api/cellCues");
const store = await import("../lib/store");

const EXT = "extremes:c/Sales/Revenue/Sales!B4:B15:";
function bundle(bestIndex: number, worstIndex: number, rowOrigins: number[]) {
  return {
    source: "range",
    insights: [{ id: EXT, kind: "extremes", score: 0.6, text: "Revenue is highest at row.", evidence: [], provenance: [] }],
    dropped: 0, markdown: "", notes: [],
    factsJson: JSON.stringify({ engineVersion: 1, localeId: "en-US", source: { label: "Sales!B4:B15", sheet: "Sales" }, rowOrigins,
      facts: [{ id: EXT, score: 0.6, evidenceA1: [], kind: {
        fact: "extremes", subject: { type: "column", name: "Revenue", sheet: "Sales", range: { sheet: "Sales", startRow: 3, startCol: 1, endRow: 14, endCol: 1 } },
        bestLabel: "x", bestIndex, best: 1, worstLabel: "y", worstIndex, worst: 0,
      } }] }),
  };
}
const request = { sheetIndex: 0, startRow: 3, startCol: 0, endRow: 14, endCol: 2 };
const owner = { kind: "range" as const, request };

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  h.invoke.mockReset().mockResolvedValue(bundle(2, 0, [4, 5, 7, 8]));
  h.regions.current = [];
  h.activeSheet.current = 0;
  h.emitted.length = 0;
  h.decorations.length = 0;
  cells.clearAllCellCues();
  sheet.resetSheetOverlays();
  store.reset();
});
afterEach(() => vi.useRealTimers());

describe("showSheetOverlay on a range", () => {
  it("analyses the rectangle (never expanded) and marks the sheet rows the document names", async () => {
    const r = await sheet.showSheetOverlay(owner);
    expect(r.outcome).toBe("shown");
    expect(h.invoke).toHaveBeenCalledWith("insights_analyze_range", { request: { ...request, expandToRegion: false } });
    const id = sheet.ownerId(owner);
    expect(cells.getCellCues(id).map((c) => [c.row, c.col, c.sheetIndex])).toEqual([[7, 1, 0], [4, 1, 0]]);
    expect(cells.cellCuesAt(0, 7, 1)).toHaveLength(1);
    expect(sheet.isSheetOverlayOn(owner)).toBe(true);
    expect(h.emitted).toContain("app:grid-refresh");
    expect(r.outcome === "shown" && r.notice).toContain("1 point of interest");
  });

  it("narrows to one fact when a card asks, and hide clears the owner", async () => {
    await sheet.showSheetOverlay(owner, { onlyFactId: "other" });
    expect(cells.getCellCues(sheet.ownerId(owner))).toEqual([]);
    await sheet.showSheetOverlay(owner, { onlyFactId: EXT });
    expect(cells.getCellCues(sheet.ownerId(owner))).toHaveLength(2);
    sheet.hideSheetOverlay(owner);
    expect(cells.getCellCues(sheet.ownerId(owner))).toEqual([]);
    expect(sheet.isSheetOverlayOn(owner)).toBe(false);
  });

  it("refuses a failed analysis with the reason", async () => {
    h.invoke.mockRejectedValue(new Error("no such sheet"));
    expect(await sheet.showSheetOverlay(owner)).toEqual({ outcome: "refused", ownerId: sheet.ownerId(owner), reason: "no such sheet" });
  });

  it("refreshes the pane's bundle only when the pane is on the same range", async () => {
    const token = store.beginRun("Sales!A4:C15", { kind: "range", request });
    store.completeRun(token, bundle(0, 1, [4, 5]) as never);
    await sheet.showSheetOverlay(owner);
    expect(JSON.parse(store.getState().bundle!.factsJson).rowOrigins).toEqual([4, 5, 7, 8]);
  });
});

describe("showSheetOverlay on a pivot", () => {
  it("takes the pivot's rectangle from its grid region, and refuses a pivot that is not on the sheet", async () => {
    h.regions.current = [{ type: "pivot", data: { pivotId: "p1" }, startRow: 10, startCol: 2, endRow: 20, endCol: 6 }];
    const r = await sheet.showSheetOverlay({ kind: "pivot", pivotId: "p1" });
    expect(r.outcome).toBe("shown");
    expect(h.invoke).toHaveBeenCalledWith("insights_analyze_range", { request: { sheetIndex: 0, startRow: 10, startCol: 2, endRow: 20, endCol: 6, expandToRegion: false } });
    expect((await sheet.showSheetOverlay({ kind: "pivot", pivotId: "p9" })).outcome).toBe("refused");
  });
});

describe("following the data", () => {
  it("recomputes once after a burst of changes inside the rectangle, and not for one outside", async () => {
    const events = await import("@api/events");
    await sheet.showSheetOverlay(owner);
    const off = sheet.followSheetData();
    h.invoke.mockResolvedValue(bundle(1, 0, [4, 5, 7, 8]));
    events.emitAppEvent("app:cell-values-changed", { changes: [{ row: 5, col: 1 }, { row: 6, col: 1 }], source: "user" });
    events.emitAppEvent("app:cell-values-changed", { changes: [{ row: 5, col: 1 }], source: "user" });
    expect(h.invoke).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(sheet.SHEET_RECOMPUTE_DEBOUNCE_MS + 10);
    await flush();
    expect(h.invoke).toHaveBeenCalledTimes(2);
    expect(cells.getCellCues(sheet.ownerId(owner)).map((c) => c.row)).toEqual([5, 4]);

    events.emitAppEvent("app:cell-values-changed", { changes: [{ row: 50, col: 50 }], source: "user" });
    await vi.advanceTimersByTimeAsync(sheet.SHEET_RECOMPUTE_DEBOUNCE_MS + 10);
    expect(h.invoke).toHaveBeenCalledTimes(2);
    off();
  });
});

describe("the decoration's colours", () => {
  it("come from the document's style when one is declared", async () => {
    const style = await import("@api/insightStyle");
    const { drawCellCues } = sheet;
    const strokes: string[] = [];
    const ctx = { save: () => {}, restore: () => {}, strokeRect: () => {}, setLineDash: () => {}, beginPath: () => {}, arc: () => {}, fill: () => {}, fillStyle: "", lineWidth: 0, set strokeStyle(v: string) { strokes.push(v); }, get strokeStyle() { return strokes.at(-1) ?? ""; } };
    const cue = { factId: "f", polarity: "attention" as const, description: "d", sheetIndex: 0, row: 1, col: 1 };
    const context = { ctx, row: 1, col: 1, cellLeft: 0, cellTop: 0, cellRight: 40, cellBottom: 20 } as unknown as Parameters<typeof drawCellCues>[0];
    try {
      style.setDocumentOverlayStyle(style.normalizeOverlayStyle({ polarity: { attention: { color: "purple", dash: [] } }, lineWidth: 3 }));
      drawCellCues(context, [cue]);
      expect(strokes.at(-1)).toBe("purple");
      expect(ctx.lineWidth).toBe(3);
    } finally {
      style.setDocumentOverlayStyle(null);
    }
    drawCellCues(context, [cue]);
    expect(strokes.at(-1)).toBe(style.DEFAULT_OVERLAY_STYLE.polarity.attention.color);
  });
});

describe("the decoration", () => {
  it("is registered over the selection and draws only cells that carry a cue on the active sheet", async () => {
    const off = sheet.registerCellCueDecoration();
    expect(h.decorations[0]).toMatchObject({ id: "insights-cell-cues", anchor: "over-selection" });
    await sheet.showSheetOverlay(owner);
    const calls: string[] = [];
    const ctx = { save: () => calls.push("save"), restore: () => calls.push("restore"), strokeRect: () => calls.push("strokeRect"), setLineDash: () => {}, beginPath: () => {}, arc: () => {}, fill: () => {}, strokeStyle: "", fillStyle: "", lineWidth: 0 };
    const draw = (row: number, col: number) => h.decorations[0].fn({ ctx, row, col, cellLeft: 0, cellTop: 0, cellRight: 40, cellBottom: 20 });
    draw(7, 1);
    expect(calls).toContain("strokeRect");
    calls.length = 0;
    draw(7, 2);
    expect(calls).toEqual([]);
    h.activeSheet.current = 1;
    draw(7, 1);
    expect(calls).toEqual([]);
    off();
    expect(h.decorations).toEqual([]);
  });
});
