//! FILENAME: app/src/api/__tests__/objectBindings.bridge.test.ts
// PURPOSE: The bridge is THE trigger that asks Rust to re-evaluate bindings
//          (D §3.7 / §3.16). Pinned here:
//            * one CellsChanged per FRAME, however many announcements the frame
//              held, cells listed (a missing sheetIndex = the active sheet);
//            * a workbook with NO bindings sends no cell trigger -- but page
//              filters are ALWAYS forwarded, as the FULL snapshot;
//            * a volatile binding costs ONE evaluation per real trigger, and
//              `AppEvents.GRID_REFRESH` (a repaint request) is NOT a trigger --
//              a family that repaints by emitting it cannot start a loop;
//            * filter first, then bind: Set sees the current filters;
//            * the backend's WINDOW event "grid:refresh" IS a trigger;
//            * File > New resets the cache and re-reads in the spec's order;
//            * (P4 S11) the wire names pages by SHEET ID; each page carries
//              its BASE set (resolvePageBase) and an OVERRIDE only for a model
//              visual that resolves differently -- a visuals-scoped ribbon
//              filter, a filter-mode selection, a none pair; highlights never
//              reach the wire; one send per frame; a check trigger (page list,
//              object refresh) re-sends only a changed wire.
// CONTEXT: The real seam over a doubled backend door, a doubled Tauri event
//          listener and a hand-driven animation-frame clock.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ObjectBindingRef, ObjectBindingsRequest, ResolvedBinding } from "../types";

const h = vi.hoisted(() => ({
  requests: [] as unknown[],
  bindings: [] as unknown[],
  active: 0,
  /** What a cellsChanged answers (a volatile binding changes every time). */
  onCellsChanged: null as null | (() => unknown[]),
  frames: [] as Array<() => void>,
  tauri: new Map<string, (payload: unknown) => void>(),
  /** The sheets get_sheets answers: index i has id `sheet-${i}`. */
  sheetCount: 5,
}));

vi.mock("../../core/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../core/lib/tauri-api")>()),
  getSheets: async () => ({
    sheets: Array.from({ length: h.sheetCount }, (_, i) => ({
      index: i,
      name: `Sheet${i}`,
      visibility: "visible",
      sheetId: `sheet-${i}`,
      kind: "worksheet",
    })),
    activeIndex: 0,
  }),
}));

vi.mock("../backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../backend")>()),
  invokeBackend: async (cmd: string, args?: { request: ObjectBindingsRequest }) => {
    if (cmd !== "object_bindings") throw new Error(`unexpected command ${cmd}`);
    const req = args!.request;
    h.requests.push(JSON.parse(JSON.stringify(req)));
    switch (req.op) {
      case "list":
        return { kind: "bindings", bindings: JSON.parse(JSON.stringify(h.bindings)) };
      case "resolveAll":
        return { kind: "resolved", values: [] };
      case "cellsChanged":
        return { kind: "resolved", values: h.onCellsChanged ? h.onCellsChanged() : [] };
      case "setPageFilters":
      case "refreshMeasures":
        return { kind: "ack" };
      case "set":
        return {
          kind: "binding",
          binding: { object: req.object, path: req.path, formula: req.formula, displayFormula: req.formula, model: null, resolved: null },
        };
      default:
        throw new Error(`unexpected op ${req.op}`);
    }
  },
  listenTauriEvent: async (event: string, cb: (payload: unknown) => void) => {
    h.tauri.set(event, cb);
    return () => h.tauri.delete(event);
  },
}));

vi.mock("../../core/state/GridContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../core/state/GridContext")>()),
  getGridStateSnapshot: () => ({ sheetContext: { activeSheetIndex: h.active } }),
}));

let seam: typeof import("../objectBindings");
let events: typeof import("../events");
let reportFilters: typeof import("../reportFilters");
/** What the test's @api/modelVisuals provider lists (read at every call). */
let visuals: import("../modelVisuals").ModelVisualInfo[] = [];
let uninstall: () => void = () => {};

const CHART: ObjectBindingRef = { kind: "chart", id: "c1" };
const BOUND = { object: CHART, path: "/spec/title", formula: "=NOW()", displayFormula: "=NOW()", model: null, resolved: null };

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Run every animation frame requested so far (and the requests they queue). */
async function frame(): Promise<void> {
  const due = h.frames.splice(0);
  for (const cb of due) cb();
  await settle();
}

function sent(op: string): ObjectBindingsRequest[] {
  return (h.requests as ObjectBindingsRequest[]).filter((r) => r.op === op);
}

beforeEach(async () => {
  vi.resetModules();
  h.requests = [];
  h.bindings = [BOUND];
  h.active = 0;
  h.onCellsChanged = null;
  h.frames = [];
  h.tauri.clear();
  h.sheetCount = 5;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    h.frames.push(() => cb(0));
    return h.frames.length;
  });
  seam = await import("../objectBindings");
  events = await import("../events");
  reportFilters = await import("../reportFilters");
  visuals = [];
  const modelVisuals = await import("../modelVisuals");
  modelVisuals.registerModelVisualProvider({ kind: "chart", list: () => visuals });
});

afterEach(() => {
  uninstall();
  vi.unstubAllGlobals();
});

/** A model slicer's filter as the Slicer extension publishes it (page by sheet id). */
function slicerFilter(
  sourceId: string,
  sourceName: string,
  sheetIndex: number,
  connectionId: string,
  field: string,
  includedKeys: string[],
  filterLevel?: number,
): import("../reportFilters").ReportFilterInput {
  return {
    sourceId,
    sourceName,
    sourceRef: { kind: "slicer", id: sourceId },
    scope: { kind: "page", sheetId: `sheet-${sheetIndex}` },
    connectionId,
    field,
    includedKeys,
    ...(filterLevel !== undefined ? { filterLevel } : {}),
  };
}

/** A ribbon filter (no canvas object behind it) on any scope. */
function ribbonFilter(
  sourceId: string,
  sourceName: string,
  scope: import("../reportFilters").ReportFilterScope,
  connectionId: string,
  field: string,
  includedKeys: string[],
): import("../reportFilters").ReportFilterInput {
  return { sourceId, sourceName, sourceRef: null, scope, connectionId, field, includedKeys };
}

/** A model visual on sheet `sheet-${sheetIndex}`, as a family provider lists it. */
function visual(
  kind: "chart" | "pivot" | "slicer",
  id: string,
  sheetIndex: number,
  connectionId: string,
  canHighlight = false,
  target = true,
): import("../modelVisuals").ModelVisualInfo {
  return {
    ref: { kind, id },
    name: id,
    sheetIndex,
    sheetId: `sheet-${sheetIndex}`,
    connectionId,
    role: { source: true, target, canHighlight, reason: target ? null : "Follows nothing" },
    label: "Column chart",
  };
}

/** One page of the wire. */
function page(
  sheetId: string,
  connectionId: string,
  filters: Array<{ field: string; includedItems: string[]; filterLevel: number }>,
  tupleFilters: Array<{ fields: string[]; tuples: string[][] }> = [],
  objects: unknown[] = [],
): Record<string, unknown> {
  return { sheetId, connectionId, filters, tupleFilters, objects };
}

async function install(): Promise<void> {
  uninstall = seam.installObjectBindingsBridge();
  await settle();
  h.requests = [];
}

describe("the binding bridge", () => {
  it("coalesces a frame's cell announcements into ONE CellsChanged, missing sheetIndex = the active sheet", async () => {
    await install();
    h.active = 2;
    events.emitAppEvent(events.AppEvents.CELLS_UPDATED, { changes: [{ row: 1, col: 1, sheetIndex: 0 }] });
    events.emitAppEvent(events.AppEvents.CELLS_UPDATED, { changes: [{ row: 4, col: 3 }, { row: 1, col: 1, sheetIndex: 0 }] });
    expect(sent("cellsChanged"), "nothing is sent before the frame").toHaveLength(0);
    await frame();
    expect(sent("cellsChanged")).toEqual([
      {
        op: "cellsChanged",
        cells: [
          { sheetIndex: 0, row: 1, col: 1 },
          { sheetIndex: 2, row: 4, col: 3 },
        ],
      },
    ]);
  });

  it("a bare CELLS_UPDATED (no change list) asks for a full re-evaluation", async () => {
    await install();
    events.emitAppEvent(events.AppEvents.CELLS_UPDATED);
    await frame();
    expect(sent("cellsChanged")).toEqual([{ op: "cellsChanged", cells: null }]);
  });

  it("a paste past the cap is sent as one FULL re-evaluation, not a cell list", async () => {
    await install();
    const changes = Array.from({ length: 2500 }, (_, i) => ({ row: i, col: 0, sheetIndex: 0 }));
    events.emitAppEvent(events.AppEvents.CELLS_UPDATED, { changes });
    await frame();
    expect(sent("cellsChanged")).toEqual([{ op: "cellsChanged", cells: null }]);
  });

  it("with NO bindings, no cell trigger is sent -- but page filters are always forwarded", async () => {
    h.bindings = [];
    await install();
    events.emitAppEvent(events.AppEvents.CELLS_UPDATED, { changes: [{ row: 0, col: 0, sheetIndex: 0 }] });
    window.dispatchEvent(new Event("grid:refresh"));
    events.emitAppEvent(events.AppEvents.MUTATION_REFRESH, { domains: ["objects"], source: "commit" });
    await frame();
    expect(sent("cellsChanged")).toHaveLength(0);
    expect(sent("setPageFilters"), "a check trigger with an unchanged wire re-sends nothing").toHaveLength(0);

    reportFilters.publishReportFilters("slicer", [slicerFilter("s1", "Slicer_Region", 3, "conn-1", "Geo.Region", ["North"])]);
    await frame();
    expect(sent("setPageFilters")).toEqual([
      {
        op: "setPageFilters",
        pages: [page("sheet-3", "conn-1", [{ field: "Geo.Region", includedItems: ["North"], filterLevel: 1 }])],
      },
    ]);
  });

  it("SetPageFilters carries the FULL snapshot, not only the page that moved -- pages by SHEET ID", async () => {
    await install();
    reportFilters.publishReportFilters("slicer", [
      slicerFilter("s1", "A", 1, "m", "T.A", ["x"]),
      slicerFilter("s2", "B", 4, "m", "T.B", ["y"], 2),
    ]);
    await frame();
    h.requests = [];
    reportFilters.publishReportFilters("slicer", [
      slicerFilter("s1", "A", 1, "m", "T.A", ["x", "z"]),
      slicerFilter("s2", "B", 4, "m", "T.B", ["y"], 2),
    ]);
    await frame();
    expect(sent("setPageFilters")).toEqual([
      {
        op: "setPageFilters",
        pages: [
          page("sheet-1", "m", [{ field: "T.A", includedItems: ["x", "z"], filterLevel: 1 }]),
          page("sheet-4", "m", [{ field: "T.B", includedItems: ["y"], filterLevel: 2 }]),
        ],
      },
    ]);
    const wire = sent("setPageFilters")[0] as unknown as { pages: Array<Record<string, unknown>> };
    for (const p of wire.pages) expect(p, "the wire still names a sheet INDEX").not.toHaveProperty("sheetIndex");
  });

  it("a_volatile_binding_costs_one_evaluation_per_real_trigger (GRID_REFRESH is not a trigger)", async () => {
    await install();
    let tick = 0;
    h.onCellsChanged = () => {
      tick++;
      const v: ResolvedBinding = { object: CHART, path: "/spec/title", value: `t${tick}`, display: `t${tick}`, error: null, pending: false };
      return [v];
    };
    // A badly-behaved family: it answers every change by asking for a repaint
    // the old way. That must not feed back into another evaluation.
    let repaints = 0;
    seam.onBindingsChanged(() => {
      repaints++;
      events.emitAppEvent(events.AppEvents.GRID_REFRESH);
    });
    events.emitAppEvent(events.AppEvents.CELLS_UPDATED, { changes: [{ row: 0, col: 0, sheetIndex: 0 }] });
    for (let i = 0; i < 5; i++) await frame();
    expect(sent("cellsChanged")).toHaveLength(1);
    expect(repaints).toBe(1);
    expect(seam.getResolved(CHART, "/spec/title")?.display).toBe("t1");

    // And GRID_REFRESH on its own sends nothing at all.
    events.emitAppEvent(events.AppEvents.GRID_REFRESH);
    await frame();
    expect(sent("cellsChanged")).toHaveLength(1);

    // A second REAL trigger costs exactly one more.
    events.emitAppEvent(events.AppEvents.CELLS_UPDATED);
    for (let i = 0; i < 5; i++) await frame();
    expect(sent("cellsChanged")).toHaveLength(2);
  });

  it("filter_first_then_bind_uses_the_current_filters", async () => {
    h.bindings = [];
    await install();
    reportFilters.publishReportFilters("slicer", [
      slicerFilter("s1", "Region", 2, "aw", "BI.dim_territory.Region", ["Europe"]),
    ]);
    // The frame has NOT run: the filter change is still queued.
    await seam.setBinding(CHART, "/spec/markOptions/goal", "=[Revenue]*1.1");
    const order = (h.requests as ObjectBindingsRequest[]).map((r) => r.op);
    expect(order.indexOf("setPageFilters")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("setPageFilters")).toBeLessThan(order.indexOf("set"));
    expect(sent("setPageFilters")[0]).toEqual({
      op: "setPageFilters",
      pages: [page("sheet-2", "aw", [{ field: "BI.dim_territory.Region", includedItems: ["Europe"], filterLevel: 1 }])],
    });
  });

  it("an all-pages filter reaches every sheet; a page-scoped id is sent as given (Rust ignores an unknown one)", async () => {
    await install();
    reportFilters.publishReportFilters("ribbon", [
      ribbonFilter("rf", "Year", { kind: "all" }, "m", "T.Y", ["2024"]),
      ribbonFilter("rf-gone", "Gone", { kind: "page", sheetId: "no-such-sheet" }, "m", "T.G", ["g"]),
    ]);
    await frame();
    expect(sent("setPageFilters").at(-1)).toEqual({
      op: "setPageFilters",
      pages: [
        ...[0, 1, 2, 3, 4].map((i) => page(`sheet-${i}`, "m", [{ field: "T.Y", includedItems: ["2024"], filterLevel: 1 }])),
        // Resolver order: publisher, then sourceId ("rf" < "rf-gone").
        page("no-such-sheet", "m", [
          { field: "T.Y", includedItems: ["2024"], filterLevel: 1 },
          { field: "T.G", includedItems: ["g"], filterLevel: 1 },
        ]),
      ],
    });
  });

  it("an all-pages filter re-sends when the page list grows (and an unchanged list sends nothing)", async () => {
    h.sheetCount = 2;
    await install();
    reportFilters.publishReportFilters("ribbon", [ribbonFilter("rf", "Year", { kind: "all" }, "m", "T.Y", ["2024"])]);
    await frame();
    const idsOf = (r: unknown): string[] => (r as { pages: Array<{ sheetId: string }> }).pages.map((p) => p.sheetId);
    expect(idsOf(sent("setPageFilters").at(-1))).toEqual(["sheet-0", "sheet-1"]);

    h.requests = [];
    h.sheetCount = 3;
    window.dispatchEvent(new Event("sheets:refresh"));
    await settle();
    await frame();
    expect(sent("setPageFilters").map(idsOf)).toEqual([["sheet-0", "sheet-1", "sheet-2"]]);

    h.requests = [];
    window.dispatchEvent(new Event("sheets:refresh"));
    await settle();
    await frame();
    expect(sent("setPageFilters")).toHaveLength(0);
  });

  it("an override ONLY where a visual resolves differently: a slicer's none pair drops the filter for that Card alone", async () => {
    await install();
    visuals = [visual("chart", "card-a", 1, "m"), visual("chart", "card-b", 1, "m"), visual("chart", "card-z", 2, "m")];
    reportFilters.publishReportFilters("slicer", [slicerFilter("s1", "Region", 1, "m", "T.R", ["North"])]);
    await frame();
    expect(sent("setPageFilters").at(-1), "no pair: every visual reads the base, so no override").toEqual({
      op: "setPageFilters",
      pages: [page("sheet-1", "m", [{ field: "T.R", includedItems: ["North"], filterLevel: 1 }])],
    });

    h.requests = [];
    reportFilters.publishPageInteractions("sheet-1", {
      pairs: [{ source: { kind: "slicer", id: "s1" }, target: { kind: "chart", id: "card-b" }, mode: "none" }],
    });
    await frame();
    expect(sent("setPageFilters")).toEqual([
      {
        op: "setPageFilters",
        pages: [
          page("sheet-1", "m", [{ field: "T.R", includedItems: ["North"], filterLevel: 1 }], [], [
            { object: { kind: "chart", id: "card-b" }, filters: [], tupleFilters: [] },
          ]),
        ],
      },
    ]);
  });

  it("a visuals-scoped ribbon filter yields an OVERRIDE on its target, never a base filter", async () => {
    await install();
    visuals = [visual("chart", "card-a", 1, "m"), visual("chart", "card-b", 1, "m")];
    reportFilters.publishReportFilters("ribbon", [
      ribbonFilter("rf-v", "Visual", { kind: "visuals", targets: [{ kind: "chart", id: "card-a" }] }, "m", "T.V", ["v"]),
    ]);
    await frame();
    expect(sent("setPageFilters").at(-1)).toEqual({
      op: "setPageFilters",
      pages: [
        page("sheet-1", "m", [], [], [
          { object: { kind: "chart", id: "card-a" }, filters: [{ field: "T.V", includedItems: ["v"], filterLevel: 1 }], tupleFilters: [] },
        ]),
      ],
    });
  });

  it("highlights never reach bindings; a filter-mode selection does, as field or TUPLE filters; the source keeps the base", async () => {
    await install();
    visuals = [
      visual("chart", "src", 1, "m", true),
      visual("chart", "bar", 1, "m", true),
      visual("chart", "card", 1, "m", false),
      visual("chart", "range", 1, "m", false, false),
    ];
    // Default highlight: the bar paints a highlight (not sent), the card cannot
    // highlight so it is FILTERED, the range chart follows nothing.
    reportFilters.setCrossFilter({
      source: { kind: "chart", id: "src" },
      sourceName: "Src",
      pageSheetId: "sheet-1",
      connectionId: "m",
      fields: ["T.A", "T.B"],
      tuples: [
        ["a1", "b1"],
        ["a2", "b2"],
      ],
    });
    await frame();
    const tuple = { fields: ["T.A", "T.B"], tuples: [["a1", "b1"], ["a2", "b2"]] };
    expect(sent("setPageFilters").at(-1)).toEqual({
      op: "setPageFilters",
      pages: [page("sheet-1", "m", [], [], [{ object: { kind: "chart", id: "card" }, filters: [], tupleFilters: [tuple] }])],
    });
    expect(JSON.stringify(sent("setPageFilters")), "a highlight leaked onto the wire").not.toMatch(/highlight/i);

    // defaultMode filter: the bar is filtered too; a rectangular selection is per-field.
    h.requests = [];
    reportFilters.publishPageInteractions("sheet-1", { defaultMode: "filter", pairs: [] });
    reportFilters.setCrossFilter({
      source: { kind: "chart", id: "src" },
      sourceName: "Src",
      pageSheetId: "sheet-1",
      connectionId: "m",
      fields: ["T.A"],
      tuples: [["a1"], ["a2"]],
    });
    await frame();
    const filtered = { filters: [{ field: "T.A", includedItems: ["a1", "a2"], filterLevel: 1 }], tupleFilters: [] };
    expect(sent("setPageFilters"), "two changes in one frame are ONE send").toEqual([
      {
        op: "setPageFilters",
        pages: [
          page("sheet-1", "m", [], [], [
            { object: { kind: "chart", id: "bar" }, ...filtered },
            { object: { kind: "chart", id: "card" }, ...filtered },
          ]),
        ],
      },
    ]);
  });

  it("a change coalesces to ONE send per frame, however many moved", async () => {
    await install();
    visuals = [visual("chart", "card", 1, "m")];
    reportFilters.publishReportFilters("slicer", [slicerFilter("s1", "A", 1, "m", "T.A", ["x"])]);
    reportFilters.publishReportFilters("ribbon", [ribbonFilter("rf", "Y", { kind: "page", sheetId: "sheet-1" }, "m", "T.Y", ["1"])]);
    reportFilters.publishPageInteractions("sheet-1", {
      pairs: [{ source: { kind: "slicer", id: "s1" }, target: { kind: "chart", id: "card" }, mode: "none" }],
    });
    reportFilters.setCrossFilter({
      source: { kind: "chart", id: "other" },
      sourceName: "Other",
      pageSheetId: "sheet-1",
      connectionId: "m",
      fields: ["T.B"],
      tuples: [["b"]],
    });
    expect(sent("setPageFilters"), "nothing before the frame").toHaveLength(0);
    await frame();
    expect(sent("setPageFilters")).toHaveLength(1);
  });

  it("a visual that appears under a live selection re-sends on the next object refresh (and an unchanged one does not)", async () => {
    await install();
    reportFilters.publishPageInteractions("sheet-1", { defaultMode: "filter", pairs: [] });
    reportFilters.setCrossFilter({
      source: { kind: "chart", id: "src" },
      sourceName: "Src",
      pageSheetId: "sheet-1",
      connectionId: "m",
      fields: ["T.A"],
      tuples: [["a1"]],
    });
    await frame();
    expect(sent("setPageFilters").at(-1)).toEqual({ op: "setPageFilters", pages: [page("sheet-1", "m", [])] });

    h.requests = [];
    visuals = [visual("chart", "card", 1, "m")];
    events.emitAppEvent(events.AppEvents.MUTATION_REFRESH, { domains: ["objects"], source: "commit" });
    await frame();
    expect(sent("setPageFilters")).toEqual([
      {
        op: "setPageFilters",
        pages: [
          page("sheet-1", "m", [], [], [
            { object: { kind: "chart", id: "card" }, filters: [{ field: "T.A", includedItems: ["a1"], filterLevel: 1 }], tupleFilters: [] },
          ]),
        ],
      },
    ]);

    h.requests = [];
    events.emitAppEvent(events.AppEvents.MUTATION_REFRESH, { domains: ["objects"], source: "commit" });
    await frame();
    expect(sent("setPageFilters")).toHaveLength(0);
  });

  it("grid_refresh_window_event_is_a_trigger (backend-made writes: MCP, AI, scripts)", async () => {
    await install();
    window.dispatchEvent(new Event("grid:refresh"));
    await frame();
    expect(sent("cellsChanged")).toEqual([{ op: "cellsChanged", cells: null }]);
  });

  it("names, sheets, recalculation, structural undo and mutation refreshes are triggers too", async () => {
    await install();
    for (const evt of [
      events.AppEvents.NAMED_RANGES_CHANGED,
      events.AppEvents.SHEET_ADDED,
      events.AppEvents.SHEET_DELETED,
      events.AppEvents.SHEET_RENAMED,
      events.AppEvents.RECALCULATION_COMPLETED,
      events.AppEvents.STRUCTURAL_UNDO,
      events.AppEvents.MUTATION_REFRESH,
    ]) {
      h.requests = [];
      events.emitAppEvent(evt, {});
      await frame();
      expect(sent("cellsChanged"), evt).toEqual([{ op: "cellsChanged", cells: null }]);
    }
    h.requests = [];
    seam.reevaluateAfterNameChange();
    await frame();
    expect(sent("cellsChanged")).toEqual([{ op: "cellsChanged", cells: null }]);
  });

  it("File > New resets the cache, then sends SetPageFilters, List, ResolveAll, RefreshMeasures", async () => {
    await install();
    expect(seam.listBindings()).toHaveLength(1);
    const heard: unknown[] = [];
    seam.onBindingsChanged((c) => heard.push(c));
    h.bindings = [];
    events.emitAppEvent(events.AppEvents.AFTER_NEW);
    expect(seam.listBindings()).toEqual([]);
    expect(heard).toEqual([{ objects: [CHART], reload: true }]);
    await settle();
    expect((h.requests as ObjectBindingsRequest[]).map((r) => r.op)).toEqual([
      "setPageFilters",
      "list",
      "resolveAll",
      "refreshMeasures",
    ]);
    expect(sent("refreshMeasures")).toEqual([{ op: "refreshMeasures", sheetIndex: null }]);
    // With the cache now empty, a cell edit costs nothing.
    events.emitAppEvent(events.AppEvents.CELLS_UPDATED, { changes: [{ row: 0, col: 0 }] });
    await frame();
    expect(sent("cellsChanged")).toHaveLength(0);
  });

  it("a model change or refresh asks Rust to re-fetch bound measures", async () => {
    await install();
    events.emitAppEvent(events.AppEvents.BI_MODEL_CHANGED, { connectionId: "aw", domain: "measure" });
    events.emitAppEvent(events.AppEvents.BI_REFRESH_COMPLETED, { connectionId: "aw", tables: [], durationMs: 1 });
    await settle();
    expect(sent("refreshMeasures")).toEqual([
      { op: "refreshMeasures", sheetIndex: null },
      { op: "refreshMeasures", sheetIndex: null },
    ]);
  });

  it("bootstrapShell installs the bridge (in CODE, not in a comment)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const code = fs
      .readFileSync(path.resolve(__dirname, "../../shell/bootstrap.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).toMatch(/^\s*installObjectBindingsBridge\(\);/m);
    expect(code).toMatch(/import \{ installObjectBindingsBridge \} from "\.\.\/api\/objectBindings";/);
  });

  it("uninstall stops every trigger", async () => {
    await install();
    uninstall();
    events.emitAppEvent(events.AppEvents.CELLS_UPDATED);
    window.dispatchEvent(new Event("grid:refresh"));
    await frame();
    expect(h.requests).toEqual([]);
    expect(h.tauri.has(seam.BACKEND_OBJECT_BINDINGS_EVENT)).toBe(false);
  });
});
