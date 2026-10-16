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
//            * File > New resets the cache and re-reads in the spec's order.
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
let pageFilters: typeof import("../pageFilters");
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
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    h.frames.push(() => cb(0));
    return h.frames.length;
  });
  seam = await import("../objectBindings");
  events = await import("../events");
  pageFilters = await import("../pageFilters");
});

afterEach(() => {
  uninstall();
  vi.unstubAllGlobals();
});

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

    pageFilters.publishPageFilters("slicer", [
      { sourceId: "s1", sourceName: "Slicer_Region", sheetIndex: 3, connectionId: "conn-1", field: "Geo.Region", includedItems: ["North"] },
    ]);
    await frame();
    expect(sent("setPageFilters")).toEqual([
      {
        op: "setPageFilters",
        pages: [{ sheetIndex: 3, connectionId: "conn-1", filters: [{ field: "Geo.Region", includedItems: ["North"], filterLevel: 1 }] }],
      },
    ]);
  });

  it("SetPageFilters carries the FULL snapshot, not only the page that moved", async () => {
    await install();
    pageFilters.publishPageFilters("slicer", [
      { sourceId: "s1", sourceName: "A", sheetIndex: 1, connectionId: "m", field: "T.A", includedItems: ["x"] },
      { sourceId: "s2", sourceName: "B", sheetIndex: 4, connectionId: "m", field: "T.B", includedItems: ["y"], filterLevel: 2 },
    ]);
    await frame();
    h.requests = [];
    pageFilters.publishPageFilters("slicer", [
      { sourceId: "s1", sourceName: "A", sheetIndex: 1, connectionId: "m", field: "T.A", includedItems: ["x", "z"] },
      { sourceId: "s2", sourceName: "B", sheetIndex: 4, connectionId: "m", field: "T.B", includedItems: ["y"], filterLevel: 2 },
    ]);
    await frame();
    expect(sent("setPageFilters")).toEqual([
      {
        op: "setPageFilters",
        pages: [
          { sheetIndex: 1, connectionId: "m", filters: [{ field: "T.A", includedItems: ["x", "z"], filterLevel: 1 }] },
          { sheetIndex: 4, connectionId: "m", filters: [{ field: "T.B", includedItems: ["y"], filterLevel: 2 }] },
        ],
      },
    ]);
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
    pageFilters.publishPageFilters("slicer", [
      { sourceId: "s1", sourceName: "Region", sheetIndex: 2, connectionId: "aw", field: "BI.dim_territory.Region", includedItems: ["Europe"] },
    ]);
    // The frame has NOT run: the filter change is still queued.
    await seam.setBinding(CHART, "/spec/markOptions/goal", "=[Revenue]*1.1");
    const order = (h.requests as ObjectBindingsRequest[]).map((r) => r.op);
    expect(order.indexOf("setPageFilters")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("setPageFilters")).toBeLessThan(order.indexOf("set"));
    expect(sent("setPageFilters")[0]).toEqual({
      op: "setPageFilters",
      pages: [{ sheetIndex: 2, connectionId: "aw", filters: [{ field: "BI.dim_territory.Region", includedItems: ["Europe"], filterLevel: 1 }] }],
    });
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
