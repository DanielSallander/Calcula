//! FILENAME: app/extensions/Slicer/lib/__tests__/slicerCrossFilterTarget.test.ts
// PURPOSE: The Slicer family in cross-filtering (P4, S8):
//          - a MODEL slicer is a TARGET: the other visuals' selections on its
//            canvas page reach `get_slicer_items` as `visualConstraints`
//            (has-data only), resolved by @api/reportFilters -- a pair set to
//            None drops the source, a selection on another page or model
//            never reaches it, and a table/pivot slicer never sends any;
//          - a report-filter change re-reads exactly the model slicers it can
//            have moved, and the slicer's OWN republish re-reads nobody;
//          - a slicer -> pivot interaction change makes the Slicer extension
//            invoke NOTHING (the pivot's re-fold is Rust's, inside
//            set_canvas_layout's own undo step, DC-9); a slicer -> slicer one
//            re-reads the target slicer's items and writes nothing;
//          - the @api/modelVisuals provider lists every slicer with its role;
//          - only the LATEST of two overlapping items reads lands in the cache.
// CONTEXT: Driven through the real store, the real slicer-api and the real
//          seams; the backend is a double of the Tauri shape (every invoke
//          returns a Promise), the page list a controlled snapshot.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Slicer } from "../slicerTypes";

const h = vi.hoisted(() => ({
  calls: [] as Array<{ cmd: string; args: Record<string, unknown> | undefined }>,
  slicers: [] as Array<Record<string, unknown>>,
  /** Deferred answers for get_slicer_items, in call order (when set). */
  gates: null as Array<{ resolve: (v: unknown) => void }> | null,
  sheetIds: new Map<number, string>([
    [0, "sheet-0"],
    [2, "canvas-2"],
    [3, "canvas-3"],
  ]),
}));

vi.mock("@api/state", () => ({
  getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: 2 } }),
}));

vi.mock("../slicerBackend", () => ({
  slicerBackend: {
    invoke: (cmd: string, args?: Record<string, unknown>) => {
      h.calls.push({ cmd, args });
      switch (cmd) {
        case "get_all_slicers":
          return Promise.resolve(h.slicers);
        case "get_slicer_items": {
          const id = String((args as { slicerId: string }).slicerId);
          const answer = [{ key: `item-of-${id}-${h.calls.length}`, label: "x", selected: true, hasData: true }];
          if (h.gates) {
            return new Promise((resolve) => h.gates!.push({ resolve: () => resolve(answer) }));
          }
          return Promise.resolve(answer);
        }
        default:
          return Promise.resolve(undefined);
      }
    },
  },
}));

vi.mock("@api/reportPages", async (importOriginal) => {
  const real = await importOriginal<typeof import("@api/reportPages")>();
  return {
    ...real,
    getReportPagesSnapshot: () => ({
      pages: [
        { sheetId: "canvas-2", name: "Report", index: 2, visibility: "visible", isTooltipPage: false },
        { sheetId: "canvas-3", name: "Other", index: 3, visibility: "visible", isTooltipPage: false },
      ],
      sheetIdByIndex: h.sheetIds,
      activeIndex: 2,
      version: 1,
    }),
  };
});

import * as store from "../slicerStore";
import {
  installSlicerVisualConstraintRefresh,
  resetVisualConstraintsSent,
  slicerVisualConstraints,
} from "../slicerVisualConstraints";
import { listSlicerModelVisuals, NON_MODEL_SLICER_REASON, registerSlicerModelVisuals } from "../slicerModelVisuals";
import {
  clearCrossFilters,
  publishPageInteractions,
  publishReportFilters,
  setCrossFilter,
  type CrossFilterSelection,
} from "@api/reportFilters";
import { modelVisualOf } from "@api/modelVisuals";

function slicer(id: string, overrides: Partial<Slicer> = {}): Slicer {
  return {
    id,
    name: `Slicer ${id}`,
    headerText: null,
    sheetIndex: 2,
    x: 0,
    y: 0,
    width: 180,
    height: 240,
    sourceType: "biConnection",
    cacheSourceId: "c1",
    fieldName: "Geo.Region",
    selectedItems: null,
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

/** A bar chart's selection on the report canvas (sheet 2), model c1. */
function barSelection(overrides: Partial<CrossFilterSelection> = {}): CrossFilterSelection {
  return {
    source: { kind: "chart", id: "bar" },
    sourceName: "Sales by Year",
    pageSheetId: "canvas-2",
    connectionId: "c1",
    fields: ["Calendar.Year"],
    tuples: [["2024"], ["2025"]],
    ...overrides,
  };
}

const itemReads = () => h.calls.filter((c) => c.cmd === "get_slicer_items");
const nonReads = () => h.calls.filter((c) => c.cmd !== "get_slicer_items" && c.cmd !== "get_all_slicers");

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

beforeEach(async () => {
  clearCrossFilters();
  publishPageInteractions("canvas-2", null);
  publishReportFilters("slicer", []);
  store.resetStore();
  resetVisualConstraintsSent();
  h.gates = null;
  h.slicers = [
    slicer("model-a"),
    slicer("model-b", { name: "Year", fieldName: "Calendar.Year" }),
    slicer("pivot-s", { sourceType: "pivot", cacheSourceId: "pv1", connectedSources: [{ sourceType: "pivot", sourceId: "pv1" }] }),
    slicer("model-other-page", { sheetIndex: 3 }),
  ] as unknown as Array<Record<string, unknown>>;
  await store.refreshCache();
  h.calls.length = 0;
});

afterEach(() => {
  clearCrossFilters();
  publishPageInteractions("canvas-2", null);
  publishReportFilters("slicer", []);
});

// ---------------------------------------------------------------------------
// The argument
// ---------------------------------------------------------------------------

describe("slicerVisualConstraints", () => {
  it("is absent with no selection on the page, and for a table or pivot slicer always", () => {
    expect(slicerVisualConstraints(slicer("model-a"))).toBeUndefined();
    setCrossFilter(barSelection());
    expect(
      slicerVisualConstraints(slicer("pivot-s", { sourceType: "pivot", cacheSourceId: "pv1" })),
    ).toBeUndefined();
    expect(slicerVisualConstraints(slicer("t", { sourceType: "table", cacheSourceId: "t1" }))).toBeUndefined();
  });

  it("a rectangular selection is a one-column tuple filter per field (Rust splits the model's names)", () => {
    setCrossFilter(barSelection());
    expect(slicerVisualConstraints(slicer("model-a"))).toEqual({
      filters: [],
      tuples: [{ fields: ["Calendar.Year"], tuples: [["2024"], ["2025"]] }],
    });
  });

  it("a non-rectangular selection is one OR-of-AND tuple filter, keys as keys (blank = \"\")", () => {
    setCrossFilter(
      barSelection({ fields: ["Calendar.Year", "Geo.Region"], tuples: [["2024", "East"], ["2025", ""]] }),
    );
    expect(slicerVisualConstraints(slicer("model-a"))).toEqual({
      filters: [],
      tuples: [{ fields: ["Calendar.Year", "Geo.Region"], tuples: [["2024", "East"], ["2025", ""]] }],
    });
  });

  it("a selection on another page or another model never reaches it", () => {
    setCrossFilter(barSelection({ pageSheetId: "canvas-3" }));
    expect(slicerVisualConstraints(slicer("model-a"))).toBeUndefined();
    clearCrossFilters();
    setCrossFilter(barSelection({ connectionId: "c2" }));
    expect(slicerVisualConstraints(slicer("model-a"))).toBeUndefined();
  });

  it("a chart -> slicer pair set to None drops that chart's selection; a highlight default is a filter", () => {
    publishPageInteractions("canvas-2", { defaultMode: "highlight", pairs: [] });
    setCrossFilter(barSelection());
    expect(slicerVisualConstraints(slicer("model-a"))?.tuples).toHaveLength(1);
    publishPageInteractions("canvas-2", {
      defaultMode: "highlight",
      pairs: [{ source: { kind: "chart", id: "bar" }, target: { kind: "slicer", id: "model-a" }, mode: "none" }],
    });
    expect(slicerVisualConstraints(slicer("model-a"))).toBeUndefined();
    // The other slicer of the page still follows the bar.
    expect(slicerVisualConstraints(slicer("model-b", { fieldName: "Calendar.Year" }))?.tuples).toHaveLength(1);
  });

  it("other model slicers' and ribbon filters' selections are NOT sent (the backend's sibling path has them)", () => {
    publishReportFilters("slicer", [
      {
        sourceId: "model-b",
        sourceName: "Year",
        sourceRef: { kind: "slicer", id: "model-b" },
        scope: { kind: "page", sheetId: "canvas-2" },
        connectionId: "c1",
        field: "Calendar.Year",
        includedKeys: ["2024"],
      },
    ]);
    expect(slicerVisualConstraints(slicer("model-a"))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The fetch
// ---------------------------------------------------------------------------

describe("a model slicer's items read", () => {
  it("passes the constraints when a selection reaches it, and leaves the argument off the wire otherwise", async () => {
    await store.refreshSlicerItems("model-a");
    expect(itemReads().at(-1)?.args).toEqual({ slicerId: "model-a" });

    setCrossFilter(barSelection());
    h.calls.length = 0;
    await store.refreshSlicerItems("model-a");
    expect(itemReads().at(-1)?.args).toEqual({
      slicerId: "model-a",
      visualConstraints: { filters: [], tuples: [{ fields: ["Calendar.Year"], tuples: [["2024"], ["2025"]] }] },
    });

    // A pivot slicer on the same page never sends any.
    h.calls.length = 0;
    await store.refreshSlicerItems("pivot-s");
    expect(itemReads().at(-1)?.args).toEqual({ slicerId: "pivot-s" });
  });

  it("only the LATEST of two overlapping reads lands in the cache", async () => {
    h.gates = [];
    const first = store.refreshSlicerItems("model-a");
    const second = store.refreshSlicerItems("model-a");
    await settle();
    expect(h.gates).toHaveLength(2);
    const [g1, g2] = h.gates;
    g2.resolve(undefined);
    await second;
    const latest = store.getCachedItems("model-a")?.[0]?.key;
    g1.resolve(undefined);
    await first;
    expect(store.getCachedItems("model-a")?.[0]?.key).toBe(latest);
  });
});

// ---------------------------------------------------------------------------
// The re-read on a change
// ---------------------------------------------------------------------------

describe("re-reading on a report-filter change", () => {
  let stop: () => void = () => undefined;
  beforeEach(async () => {
    // Every slicer's last read sent "nothing" (the harness's refreshCache).
    stop = installSlicerVisualConstraintRefresh({ getSlicers: store.getAllSlicers, refresh: store.refreshSlicerItems });
    h.calls.length = 0;
  });
  afterEach(() => stop());

  it("a selection on the page re-reads that page's model slicers only", async () => {
    setCrossFilter(barSelection());
    await settle();
    expect(itemReads().map((c) => c.args?.slicerId).sort()).toEqual(["model-a", "model-b"]);
    expect(nonReads()).toEqual([]);
  });

  it("the same answer twice re-reads nobody, and a slicer's own republish re-reads nobody", async () => {
    setCrossFilter(barSelection());
    await settle();
    h.calls.length = 0;
    setCrossFilter(barSelection());
    publishReportFilters("slicer", [
      {
        sourceId: "model-a",
        sourceName: "Region",
        sourceRef: { kind: "slicer", id: "model-a" },
        scope: { kind: "page", sheetId: "canvas-2" },
        connectionId: "c1",
        field: "Geo.Region",
        includedKeys: ["East"],
      },
    ]);
    await settle();
    expect(h.calls).toEqual([]);
  });

  it("a slicer -> pivot pair set to None makes the Slicer extension invoke NOTHING (the re-fold is Rust's)", async () => {
    publishReportFilters("slicer", [
      {
        sourceId: "model-a",
        sourceName: "Region",
        sourceRef: { kind: "slicer", id: "model-a" },
        scope: { kind: "page", sheetId: "canvas-2" },
        connectionId: "c1",
        field: "Geo.Region",
        includedKeys: ["East"],
      },
    ]);
    await settle();
    h.calls.length = 0;
    publishPageInteractions("canvas-2", {
      pairs: [{ source: { kind: "slicer", id: "model-a" }, target: { kind: "pivot", id: "pv-box" }, mode: "none" }],
    });
    await settle();
    expect(h.calls).toEqual([]);
  });

  it("a slicer -> slicer pair set to None re-reads the TARGET slicer's items and writes nothing", async () => {
    publishReportFilters("slicer", [
      {
        sourceId: "model-a",
        sourceName: "Region",
        sourceRef: { kind: "slicer", id: "model-a" },
        scope: { kind: "page", sheetId: "canvas-2" },
        connectionId: "c1",
        field: "Geo.Region",
        includedKeys: ["East"],
      },
    ]);
    await settle();
    h.calls.length = 0;
    publishPageInteractions("canvas-2", {
      pairs: [{ source: { kind: "slicer", id: "model-a" }, target: { kind: "slicer", id: "model-b" }, mode: "none" }],
    });
    await settle();
    expect(itemReads().map((c) => c.args?.slicerId)).toEqual(["model-b"]);
    expect(nonReads()).toEqual([]);
  });

  it("stops following once stopped", async () => {
    stop();
    setCrossFilter(barSelection());
    await settle();
    expect(h.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

describe("the Slicer provider on @api/modelVisuals", () => {
  it("lists a model slicer as source + target (never a highlight) and a pivot slicer with its reason", () => {
    const listed = listSlicerModelVisuals();
    const model = listed.find((v) => v.ref.id === "model-a");
    expect(model).toMatchObject({
      ref: { kind: "slicer", id: "model-a" },
      name: "Slicer model-a",
      sheetIndex: 2,
      sheetId: "canvas-2",
      connectionId: "c1",
      label: "Slicer",
      role: { source: true, target: true, canHighlight: false, reason: null },
    });
    const pivot = listed.find((v) => v.ref.id === "pivot-s");
    expect(pivot).toMatchObject({
      connectionId: null,
      role: { source: false, target: false, canHighlight: false, reason: NON_MODEL_SLICER_REASON },
    });
  });

  it("registers and unregisters", () => {
    expect(modelVisualOf({ kind: "slicer", id: "model-a" })).toBeNull();
    const off = registerSlicerModelVisuals();
    expect(modelVisualOf({ kind: "slicer", id: "model-a" })?.connectionId).toBe("c1");
    off();
    expect(modelVisualOf({ kind: "slicer", id: "model-a" })).toBeNull();
  });
});
