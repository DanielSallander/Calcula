//! FILENAME: app/extensions/Pivot/__tests__/pivotOffSheetView.test.ts
// PURPOSE: Round-3 follow-ups of BUG-0594, through the REAL Pivot extension
//          (activated in jsdom) and the REAL @api facade over an invoke router.
//
//          revD#1 -- a pivot changed while its sheet is NOT active is not shown
//          from its old view on the way back. The region refresh re-reads only
//          the ACTIVE sheet's views, and a return to a sheet reuses the cached
//          view so the sheet shows at once ("nothing changed while we were
//          away"). Doors that did not cache their result (refreshCache,
//          refreshAll), an anonymous "pivot:refresh" (an undo, an MCP edit, a
//          slicer on another page), a locale switch and a replaced document all
//          broke that claim: a canvas box painted pre-change numbers while its
//          hidden-grid cells held the new ones. The instant return is kept when
//          nothing changed (positive control).
//
//          revD#2 -- one logical change is ONE public "pivot:refresh" (Charts,
//          TimelineSlicer, Conditional Formatting and script hooks all run on
//          it), and a loop of doors is one: a door's announcement plus its
//          caller's own dispatch used to be two, and BI Connections > Refresh
//          one per pivot.
//
//          rev3B#10 -- a door's announcement still pending when the document
//          is replaced (File > New / Open) is dropped: it names the previous
//          document's pivot, whose id the new document may reuse.
//
//          The backend is a command router over `invoke`; everything above it
//          -- pivot-api, the announcer, the scheduler, the region publication,
//          the view store, @api/gridOverlays -- is the shipped code.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  activeSheet: 0,
  /** What `get_pivot_regions_for_sheet` answers, per active sheet. */
  regionsBySheet: {} as Record<number, unknown[]>,
  /** What `get_pivot_view` and the pivot-changing commands answer, per pivot. */
  views: {} as Record<number, unknown>,
  /** Pivots that are table-linked (`get_all_pivot_tables`). */
  tableLinked: new Set<number>(),
  /** Milliseconds `refresh_pivot_cache` takes: an IPC crosses macrotasks. */
  ipcDelayMs: 0,
  calls: [] as Array<{ cmd: string; pivotId?: number }>,
  /** The handlers the extension registered on its context's event bus. */
  handlers: new Map<string, Array<(d: unknown) => void>>(),
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    const request = args?.request as { pivotId?: unknown } | undefined;
    const rawId = args?.pivotId ?? request?.pivotId;
    const pivotId = rawId === undefined ? undefined : Number(rawId);
    h.calls.push({ cmd, pivotId });
    const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
    switch (cmd) {
      case "get_pivot_regions_for_sheet":
        return clone(h.regionsBySheet[h.activeSheet] ?? []);
      case "get_pivot_view":
        return clone(h.views[pivotId as number]);
      case "refresh_pivot_cache":
        if (h.ipcDelayMs > 0) await new Promise<void>((r) => setTimeout(r, h.ipcDelayMs));
        return clone(h.views[pivotId as number]);
      case "apply_pivot_filter":
        return clone(h.views[pivotId as number]);
      case "refresh_all_pivot_tables":
        return Object.keys(h.views).map((k) => clone(h.views[Number(k)]));
      case "get_all_pivot_tables":
        return Object.keys(h.views).map((k) => ({
          id: Number(k),
          name: `P${k}`,
          ...(h.tableLinked.has(Number(k)) ? { sourceTableName: "Sales" } : {}),
        }));
      default:
        return null;
    }
  },
}));
vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listen: async () => () => undefined,
}));

import extension, { getCachedPivotView } from "../index";
import { pivot } from "@api/pivot";
import { AppEvents } from "@api";
import { getGridRegions } from "@api/gridOverlays";

function region(pivotId: number, endRow: number, canvas = false): unknown {
  return {
    pivotId,
    name: `Box${pivotId}`,
    startRow: 1,
    startCol: 1 + (pivotId - 7) * 10,
    endRow,
    endCol: 7 + (pivotId - 7) * 10,
    isEmpty: false,
    isModel: true,
    hasDesignQueryDrill: false,
    ...(canvas ? { canvasFrame: { x: 10, y: 10, width: 300, height: 200 } } : {}),
  };
}

/** A pivot view; `version` tells the views apart. */
function view(pivotId: number, version: number): unknown {
  return {
    pivotId,
    version,
    rowCount: 8,
    colCount: 7,
    rowLabelColCount: 1,
    columnHeaderRowCount: 1,
    filterRowCount: 0,
    filterRows: [],
    rowFieldSummaries: [],
    columnFieldSummaries: [],
    rows: [],
    columns: [],
  };
}

/** The version of the view the extension holds for `pivotId` (what a canvas box paints). */
function cachedVersion(pivotId: number): number | undefined {
  return (getCachedPivotView(pivotId as never) as { version?: number } | undefined)?.version;
}

function viewFetches(pivotId?: number): number {
  return h.calls.filter((c) => c.cmd === "get_pivot_view" && (pivotId === undefined || c.pivotId === pivotId)).length;
}

function regionReads(): number {
  return h.calls.filter((c) => c.cmd === "get_pivot_regions_for_sheet").length;
}

/** Let every queued macrotask (the announcer and the scheduler each defer one) and IPC settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((r) => setTimeout(r, 0));
    for (let j = 0; j < 10; j++) await Promise.resolve();
  }
}

/** A context whose event bus records the handlers (SHEET_CHANGED, AFTER_OPEN...); every other door inert. */
function recordingContext(): never {
  const inert = (): unknown =>
    new Proxy(() => () => {}, {
      get: (_t, prop) => (prop === "then" ? undefined : inert()),
      apply: () => () => {},
    });
  const events = {
    on: (name: string, cb: (d: unknown) => void) => {
      const list = h.handlers.get(name) ?? [];
      list.push(cb);
      h.handlers.set(name, list);
      return () => undefined;
    },
    emit: () => undefined,
  };
  return new Proxy({}, {
    get: (_t, prop) => (prop === "events" ? events : prop === "then" ? undefined : inert()),
  }) as never;
}

function fire(name: string, detail: unknown): void {
  for (const cb of h.handlers.get(name) ?? []) cb(detail);
}

/** The user switches to `sheet` (the Shell emits SHEET_CHANGED, then the Core re-reads its cells). */
async function switchTo(sheet: number): Promise<void> {
  h.activeSheet = sheet;
  fire(AppEvents.SHEET_CHANGED, { sheetIndex: sheet });
  window.dispatchEvent(new CustomEvent("grid:refresh"));
  await settle();
}

/** Every "pivot:refresh" that reached the window: the doors' announcements AND callers' own. */
let publicRefreshes: CustomEvent[] = [];
const onPublicRefresh = (e: Event) => publicRefreshes.push(e as CustomEvent);

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  h.regionsBySheet = { 0: [region(7, 26, true)], 1: [] };
  h.views = { 7: view(7, 26) };
  extension.activate(recordingContext());
  window.addEventListener("pivot:refresh", onPublicRefresh);
  await settle();
});

afterAll(() => {
  window.removeEventListener("pivot:refresh", onPublicRefresh);
  extension.deactivate?.();
});

beforeEach(async () => {
  // Every test starts on sheet 0 with canvas pivot 7 cached at version 26.
  h.ipcDelayMs = 0;
  h.tableLinked = new Set();
  h.regionsBySheet = { 0: [region(7, 26, true)], 1: [] };
  h.views = { 7: view(7, 26) };
  h.activeSheet = 0;
  fire(AppEvents.SHEET_CHANGED, { sheetIndex: 0 });
  window.dispatchEvent(new Event("pivot:refresh"));
  await settle();
  expect(cachedVersion(7), "precondition: pivot 7 is cached at version 26").toBe(26);
  h.calls = [];
  publicRefreshes = [];
});

// ============================================================================
// revD#1
// ============================================================================

describe("revD#1: a pivot changed while its sheet is not active, then the return to it", () => {
  it("positive control -- nothing changed while away: the return reuses the cached view (no fetch)", async () => {
    await switchTo(1);
    await switchTo(0);
    expect(viewFetches(7), "the instant return to a sheet now costs a fetch").toBe(0);
    expect(cachedVersion(7)).toBe(26);
  });

  it("pivot.refreshCache from another sheet (BI Connections > Refresh, a script's pivot.refresh): the refreshed view is shown", async () => {
    await switchTo(1);
    h.views = { 7: view(7, 8) };
    h.regionsBySheet[0] = [region(7, 9, true)];
    await pivot.refreshCache(7 as never);
    await settle();
    await switchTo(0);
    expect(cachedVersion(7), "the canvas box paints the view from BEFORE the refresh").toBe(8);
    const box = getGridRegions().find((g) => g.data?.pivotId === 7);
    expect(box, "the box is published on the return").toBeTruthy();
  });

  it("pivot.refreshAll from another sheet: the refreshed view is shown", async () => {
    await switchTo(1);
    h.views = { 7: view(7, 11) };
    await pivot.refreshAll();
    await settle();
    await switchTo(0);
    expect(cachedVersion(7), "the canvas box paints the view from BEFORE Refresh All").toBe(11);
    expect(viewFetches(7), "Refresh All's own view is shown without another fetch").toBe(0);
  });

  it("an anonymous pivot:refresh while away (an undo, an MCP edit, a slicer on another page): the view is re-read on the return", async () => {
    await switchTo(1);
    h.views = { 7: view(7, 12) };
    window.dispatchEvent(new Event("pivot:refresh"));
    await settle();
    await switchTo(0);
    expect(viewFetches(7), "the return reused a view the change made stale").toBeGreaterThanOrEqual(1);
    expect(cachedVersion(7)).toBe(12);
  });

  it("a locale switch while away: the view (labels written in the old locale) is re-read on the return", async () => {
    await switchTo(1);
    h.views = { 7: view(7, 31) };
    window.dispatchEvent(new CustomEvent(AppEvents.LOCALE_CHANGED, { detail: {} }));
    await settle();
    await switchTo(0);
    expect(cachedVersion(7), "the box keeps the old locale's labels").toBe(31);
  });

  // NEW-locale-listener-seam (round C): a BI pivot's view is a MODEL query,
  // and Rust gives the engines the new DAX FORMAT culture in a walk that ends
  // AFTER `locale:changed`, so the view re-read on LOCALE_CHANGED may carry
  // FORMAT text in the old culture. The walk's end re-reads it again.
  it("the end of the FORMAT-culture walk re-reads the view on screen (FORMAT text in the new culture)", async () => {
    h.views = { 7: view(7, 41) };
    window.dispatchEvent(new CustomEvent(AppEvents.LOCALE_CHANGED, { detail: {} }));
    await settle();
    expect(cachedVersion(7)).toBe(41);
    // The engines now have the new culture: the same pivot answers anew.
    h.views = { 7: view(7, 42) };
    const { simulateBiFormatCultureAppliedForTests } = await import("@api/locale");
    simulateBiFormatCultureAppliedForTests();
    await settle();
    expect(cachedVersion(7), "the view read before the engines had the new FORMAT culture was kept").toBe(42);
  });

  it("a replaced document (File > Open: AFTER_OPEN, then SHEET_CHANGED asking for a cached hit) never paints the previous document's pivot 7", async () => {
    // The new document's pivot 7 is a different pivot that happens to share the id.
    h.views = { 7: view(7, 3) };
    fire(AppEvents.AFTER_OPEN, { path: "other.cala" });
    fire(AppEvents.SHEET_CHANGED, { sheetIndex: 0, sheetName: "" });
    window.dispatchEvent(new CustomEvent("grid:refresh"));
    await settle();
    expect(cachedVersion(7), "the previous document's view was painted under the new document's id").toBe(3);
  });

  it("rev3B#10: a door's announcement still pending at File > New / File > Open is dropped, never sent into the new document", async () => {
    for (const replaced of [AppEvents.AFTER_NEW, AppEvents.AFTER_OPEN]) {
      publicRefreshes = [];
      // A script filters pivot 7: the door's announcement goes out a macrotask later...
      h.views = { 7: view(7, 8) };
      await pivot.applyFilter({ pivotId: 7, fieldIndex: 0, filters: { manualFilter: { selectedItems: ["a"] } } } as never);
      // ...and the document is replaced first. Its pivot 7 is another pivot sharing the id.
      h.views = { 7: view(7, 3) };
      fire(replaced, { path: "other.cala" });
      await settle();
      expect(
        publicRefreshes.map((e) => e.detail),
        `${replaced}: the previous document's door announced its pivot 7 into the new one (its pivot.onRefresh hooks ran)`,
      ).toEqual([]);
    }
  });

  it("a door's view cached while away, then an anonymous change: the return re-reads (a door's fresh flag does not outlive the change)", async () => {
    await switchTo(1);
    // A script filters pivot 7 from another page: the door caches version 8.
    h.views = { 7: view(7, 8) };
    await pivot.applyFilter({ pivotId: 7, fieldIndex: 0, filters: { manualFilter: { selectedItems: ["a"] } } } as never);
    await settle();
    // Later, still away, an undo changes pivot 7 again.
    h.views = { 7: view(7, 9) };
    window.dispatchEvent(new Event("pivot:refresh"));
    await settle();
    await switchTo(0);
    expect(cachedVersion(7), "the return skipped the fetch on the door's view from before the undo").toBe(9);
  });

  it("a door that EMPTIES the pivot (all fields removed), then an undo: the view is fetched again, never skipped as 'fresh' with no view", async () => {
    // The door's result: an empty pivot (its region is the placeholder).
    h.views = { 7: view(7, 70) };
    h.regionsBySheet[0] = [{ ...(region(7, 26, true) as object), isEmpty: true }];
    await pivot.applyFilter({ pivotId: 7, fieldIndex: 0, filters: { manualFilter: { selectedItems: [] } } } as never);
    await settle();
    expect(getCachedPivotView(7 as never), "precondition: an empty pivot has no cached view").toBeUndefined();
    // Undo (the `pivot` mutation domain: an anonymous pivot:refresh) brings the fields back.
    h.views = { 7: view(7, 71) };
    h.regionsBySheet[0] = [region(7, 26, true)];
    window.dispatchEvent(new Event("pivot:refresh"));
    await settle();
    expect(cachedVersion(7), "the door's fresh flag outlived its deleted view: the fetch was skipped and the box stayed blank").toBe(71);
  });

  it("a door's view cached while away and nothing after it: shown on the return without a fetch", async () => {
    await switchTo(1);
    h.views = { 7: view(7, 8) };
    await pivot.applyFilter({ pivotId: 7, fieldIndex: 0, filters: { manualFilter: { selectedItems: ["a"] } } } as never);
    await settle();
    await switchTo(0);
    expect(cachedVersion(7)).toBe(8);
    expect(viewFetches(7)).toBe(0);
  });
});

// ============================================================================
// revD#2
// ============================================================================

describe("revD#2: one change is ONE public pivot:refresh, a loop of doors is one", () => {
  it("a door followed by its caller's own pivot:refresh (the filter menu): one event, one region read", async () => {
    h.views = { 7: view(7, 8) };
    await pivot.applyFilter({ pivotId: 7, fieldIndex: 0, filters: { manualFilter: { selectedItems: ["a"] } } } as never);
    window.dispatchEvent(new Event("pivot:refresh"));
    await settle();
    expect(publicRefreshes, "Charts, TimelineSlicer, CF and script hooks ran twice for one filter click").toHaveLength(1);
    expect(regionReads()).toBe(1);
  });

  it("a door alone (a script): one event, naming the pivot (a script's pivot.onRefresh of another pivot stays quiet)", async () => {
    h.views = { 7: view(7, 8) };
    await pivot.applyFilter({ pivotId: 7, fieldIndex: 0, filters: { manualFilter: { selectedItems: ["a"] } } } as never);
    await settle();
    expect(publicRefreshes).toHaveLength(1);
    expect(publicRefreshes[0].detail).toMatchObject({ pivotId: "7" });
    expect(cachedVersion(7)).toBe(8);
  });

  it("BI Connections > Refresh -- a loop of pivot.refreshCache over three pivots: one event, one region read, no view fetched again", async () => {
    h.regionsBySheet[0] = [region(7, 9), region(8, 9), region(9, 9)];
    h.views = { 7: view(7, 40), 8: view(8, 40), 9: view(9, 40) };
    window.dispatchEvent(new Event("pivot:refresh"));
    await settle();
    h.calls = [];
    publicRefreshes = [];

    h.ipcDelayMs = 5;
    h.views = { 7: view(7, 41), 8: view(8, 41), 9: view(9, 41) };
    // The shape of ConnectionsPane's refresh (and step 1 of @api/dataAftermath).
    for (const id of [7, 8, 9]) {
      await pivot.refreshCache(id as never);
    }
    await settle();
    expect(publicRefreshes, "one announcement per pivot of the loop").toHaveLength(1);
    expect(publicRefreshes[0].detail).toMatchObject({ pivotIds: ["7", "8", "9"] });
    expect(regionReads(), "one region refresh per pivot of the loop").toBe(1);
    expect(viewFetches(), "a refreshed pivot's view was fetched again").toBe(0);
    expect([7, 8, 9].map(cachedVersion)).toEqual([41, 41, 41]);
  });

  it("the data aftermath -- the loop, then its own pivot:refresh: one event", async () => {
    h.regionsBySheet[0] = [region(7, 9), region(8, 9)];
    h.views = { 7: view(7, 50), 8: view(8, 50) };
    window.dispatchEvent(new Event("pivot:refresh"));
    await settle();
    h.calls = [];
    publicRefreshes = [];

    h.ipcDelayMs = 5;
    for (const id of [7, 8]) {
      await pivot.refreshCache(id as never);
    }
    window.dispatchEvent(new Event("pivot:refresh"));
    await settle();
    expect(publicRefreshes).toHaveLength(1);
    expect(regionReads()).toBe(1);
  });

  it("a table definition change refreshing two table-linked pivots: one event", async () => {
    h.regionsBySheet[0] = [region(7, 9), region(8, 9)];
    h.views = { 7: view(7, 60), 8: view(8, 60) };
    h.tableLinked = new Set([7, 8]);
    window.dispatchEvent(new Event("pivot:refresh"));
    await settle();
    h.calls = [];
    publicRefreshes = [];

    h.ipcDelayMs = 5;
    h.views = { 7: view(7, 61), 8: view(8, 61) };
    window.dispatchEvent(new CustomEvent(AppEvents.TABLE_DEFINITIONS_UPDATED, { detail: {} }));
    // The handler awaits two 5 ms refreshes.
    await new Promise<void>((r) => setTimeout(r, 30));
    await settle();
    expect(h.calls.filter((c) => c.cmd === "refresh_pivot_cache")).toHaveLength(2);
    expect(publicRefreshes, "one announcement per table-linked pivot").toHaveLength(1);
    expect(regionReads()).toBe(1);
    expect([7, 8].map(cachedVersion)).toEqual([61, 61]);
  });
});
