//! FILENAME: app/extensions/Pivot/__tests__/pivotShrinkRegion.test.ts
// PURPOSE: BUG-0594 through the REAL Pivot extension (activated in jsdom) and
//          the REAL @api facade: a pivot that SHRINKS under `pivot.applyFilter`
//          publishes its NEW extent as its grid region, and the Core is told to
//          re-read its cells ("grid:refresh") AFTER that region was published.
// CONTEXT: Found re-recording the insight-overlays-pivot golden (2026-10-29):
//          26 view rows filtered to 8, the backend right (rows 10-26 empty),
//          but `getGridRegions()` still said rows 1-26 and the canvas painted
//          the unfiltered rows into the vacated cells -- numbers that exist
//          nowhere, under a Grand Total that excludes them. The pivot-api doors
//          cached the new view and stopped; the region and the cells followed
//          only when the CALLER also dispatched "pivot:refresh", and the @api
//          route's callers (scripts, other extensions, the journey) did not.
//
//          "grid:refresh" is the Core's one re-read of the visible cells, and it
//          REPLACES the cell map (GridCanvas.fetchCells -> setCells(newCells),
//          pinned by src/core/components/Grid/GridCanvas.documentReplaced.test.tsx),
//          so a vacated cell is no longer served from the cache once it fires.
//
//          The backend is a command router over `invoke`; everything above it
//          -- pivot-api, the scheduler, the region publication, @api/gridOverlays
//          -- is the shipped code.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

type Region = {
  pivotId: number;
  name: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  isEmpty: boolean;
  isModel: boolean;
  hasDesignQueryDrill: boolean;
};

const h = vi.hoisted(() => ({
  /** What `get_pivot_regions_for_sheet` answers. */
  regions: [] as unknown[],
  /** What `get_pivot_view` answers. */
  view: null as unknown,
  /** What the pivot-changing commands answer. */
  mutationView: null as unknown,
  /** Gate on the NEXT `get_pivot_regions_for_sheet`: it answers `answer` -- the
   *  state it read when it was SERVED -- once `until` resolves (the lost-update case). */
  regionsGate: null as { until: Promise<void>; answer: unknown[] } | null,
  calls: [] as string[],
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  invoke: async (cmd: string) => {
    h.calls.push(cmd);
    switch (cmd) {
      case "get_pivot_regions_for_sheet": {
        const gate = h.regionsGate;
        h.regionsGate = null;
        if (gate) {
          await gate.until;
          return JSON.parse(JSON.stringify(gate.answer));
        }
        return JSON.parse(JSON.stringify(h.regions));
      }
      case "get_pivot_view":
        return JSON.parse(JSON.stringify(h.view));
      case "apply_pivot_filter":
      case "clear_pivot_filter":
      case "refresh_pivot_cache":
        return JSON.parse(JSON.stringify(h.mutationView));
      default:
        return null;
    }
  },
}));
vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listen: async () => () => undefined,
}));

import extension from "../index";
import { pivot } from "@api/pivot";
import { getGridRegions, onRegionChange } from "@api/gridOverlays";

const PIVOT_ID = 7;

function region(endRow: number): Region {
  return {
    pivotId: PIVOT_ID,
    name: "OverlayPivot",
    startRow: 1,
    startCol: 1,
    endRow,
    endCol: 7,
    isEmpty: false,
    isModel: true,
    hasDesignQueryDrill: false,
  };
}

function view(rowCount: number): unknown {
  return {
    pivotId: PIVOT_ID,
    version: rowCount,
    rowCount,
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

/** The pivot's published grid region, as `getGridRegions()` reports it. */
function pivotRegion(): { startRow: number; endRow: number; endCol: number } | null {
  const r = getGridRegions().find((g) => g.type === "pivot" && g.data?.pivotId === PIVOT_ID);
  return r ? { startRow: r.startRow, endRow: r.endRow, endCol: r.endCol } : null;
}

/** Let every queued macrotask (the scheduler starts a refresh one task later) and IPC settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await new Promise<void>((r) => setTimeout(r, 0));
    for (let j = 0; j < 10; j++) await Promise.resolve();
  }
}

/** Every door inert: the Pivot extension's registrations go nowhere. */
function stubContext(): never {
  const inert = (): unknown =>
    new Proxy(() => () => {}, {
      get: (_t, prop) => (prop === "then" ? undefined : inert()),
      apply: () => () => {},
    });
  return inert() as never;
}

/** The order of what reached the Core: region publications and cell re-reads. */
let timeline: string[] = [];
const onGridRefresh = () => timeline.push("grid:refresh");
let offRegions: (() => void) | null = null;

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  h.regions = [region(26)];
  h.view = view(26);
  extension.activate(stubContext());
  window.addEventListener("grid:refresh", onGridRefresh);
  offRegions = onRegionChange(() => {
    const r = pivotRegion();
    timeline.push(`region:${r ? r.endRow : "none"}`);
  });
  await settle();
});

afterAll(() => {
  window.removeEventListener("grid:refresh", onGridRefresh);
  offRegions?.();
  extension.deactivate?.();
});

beforeEach(async () => {
  // Every test starts from the unfiltered 26-row pivot, published.
  h.regions = [region(26)];
  h.view = view(26);
  window.dispatchEvent(new Event("pivot:refresh"));
  await settle();
  expect(pivotRegion(), "precondition: the unfiltered pivot is published").toEqual({ startRow: 1, endRow: 26, endCol: 7 });
  timeline = [];
  h.calls = [];
});

describe("BUG-0594: a pivot that shrinks under a filter", () => {
  it("@api pivot.applyFilter: the region follows the backend to the new extent, then the cells are re-read", async () => {
    // The backend after the filter: 8 view rows in rows 2-9, rows 10-26 vacated.
    h.mutationView = view(8);
    h.regions = [region(9)];
    h.view = view(8);

    await pivot.applyFilter({ pivotId: PIVOT_ID, fieldIndex: 0, filters: { manualFilter: { selectedItems: ["2024-01"] } } });
    await settle();

    expect(pivotRegion(), "the region kept the pre-filter extent").toEqual({ startRow: 1, endRow: 9, endCol: 7 });
    // The vacated cells: the Core re-reads (and so drops) them only on
    // "grid:refresh", and it must come AFTER the shrunk region was published.
    const shrunkAt = timeline.indexOf("region:9");
    expect(shrunkAt, `no shrunk region was published: ${timeline.join(", ")}`).toBeGreaterThanOrEqual(0);
    expect(timeline.indexOf("grid:refresh", shrunkAt), `the cells were never re-read after the shrink: ${timeline.join(", ")}`).toBeGreaterThan(shrunkAt);
  });

  it("a GROWING pivot (clearFilter back to 26 rows) publishes the larger extent too", async () => {
    h.mutationView = view(8);
    h.regions = [region(9)];
    h.view = view(8);
    await pivot.applyFilter({ pivotId: PIVOT_ID, fieldIndex: 0, filters: { manualFilter: { selectedItems: ["2024-01"] } } });
    await settle();
    expect(pivotRegion()?.endRow).toBe(9);

    timeline = [];
    h.mutationView = view(26);
    h.regions = [region(26)];
    h.view = view(26);
    await pivot.clearFilter({ pivotId: PIVOT_ID, fieldIndex: 0 });
    await settle();
    expect(pivotRegion(), "the grown pivot's region stayed small").toEqual({ startRow: 1, endRow: 26, endCol: 7 });
    expect(timeline.indexOf("grid:refresh", timeline.indexOf("region:26"))).toBeGreaterThan(timeline.indexOf("region:26"));
  });

  it("a door's own announcement and its caller's explicit refresh cost ONE region read", async () => {
    h.mutationView = view(8);
    h.regions = [region(9)];
    h.view = view(8);
    await pivot.applyFilter({ pivotId: PIVOT_ID, fieldIndex: 0, filters: { manualFilter: { selectedItems: ["2024-01"] } } });
    // The Pivot UI's filter menu does this right after the door resolves.
    window.dispatchEvent(new Event("pivot:refresh"));
    window.dispatchEvent(new CustomEvent("grid:refresh"));
    await settle();
    expect(h.calls.filter((c) => c === "get_pivot_regions_for_sheet")).toHaveLength(1);
    expect(pivotRegion()?.endRow).toBe(9);
  });

  it("a change that lands while an earlier refresh is still reading is not lost (the old re-entry guard dropped it)", async () => {
    // A refresh is under way (a sheet event, an undo...) and its region read is
    // slow: the backend serves it AFTER the filter, but it was answered from
    // the pre-filter state -- the gate releases the OLD answer.
    let release!: () => void;
    const until = new Promise<void>((r) => {
      release = r;
    });
    h.regionsGate = { until, answer: [region(26)] };
    window.dispatchEvent(new Event("pivot:refresh"));
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(h.calls.filter((c) => c === "get_pivot_regions_for_sheet"), "precondition: the first read is in flight").toHaveLength(1);

    // The filter lands while that read is in flight; from now on the backend
    // reports the shrunk pivot.
    h.mutationView = view(8);
    h.view = view(8);
    h.regions = [region(9)];
    await pivot.applyFilter({ pivotId: PIVOT_ID, fieldIndex: 0, filters: { manualFilter: { selectedItems: ["2024-01"] } } });
    // The in-flight read answers with what it saw BEFORE the filter.
    release();
    await settle();
    expect(pivotRegion(), "the request made during the in-flight refresh was dropped").toEqual({ startRow: 1, endRow: 9, endCol: 7 });
  });
});
