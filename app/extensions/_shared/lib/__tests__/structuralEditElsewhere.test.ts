//! FILENAME: app/extensions/_shared/lib/__tests__/structuralEditElsewhere.test.ts
// PURPOSE: BUG-0357 follow-up, end to end -- a row/column edit OFF the active
//          sheet's canvas (a script's insertRows with a non-active sheetIndex,
//          or a floating grid's backing sheet through `{ target }`) makes the
//          chart store re-read the data range the backend moved, and a LATER
//          save of that chart writes the moved range, never the old one.
// CONTEXT: The backend moves chart and sparkline ranges on those routes too
//          (chart_range_shift.rs), but tauri-api.ts announced nothing for them,
//          so the Charts store kept the old range until a reload and the next
//          persist (a drag, a title edit) wrote it back over the moved one.
//          This drives the REAL `insertRows` wrapper (only Tauri's `invoke` is
//          doubled) into the REAL, activated Charts extension over the real
//          window event bus -- the subscription `onStructuralEdit` makes is part
//          of what is tested, and Sparklines subscribes through the same list.

import { describe, it, expect, vi } from "vitest";
import { loadHarness, settle, type Loader } from "../../../ModelMenu/__tests__/lifecycleHarness";

vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  listenForEvent: vi.fn(async () => () => {}),
  listenTauriEvent: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "get_active_sheet") return 0;
    if (cmd === "get_all_styles") return [];
    if (cmd === "insert_rows" || cmd === "delete_columns") return [];
    return null;
  }),
}));
vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/event")>()),
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => {}),
}));

const CHARTS: Loader = () => import("../../../Charts");
const CHART_ID = "01912345-6789-7abc-8def-0123456789ab";

interface Entry {
  id: string;
  sheetIndex: number;
  specJson: string;
}

/** A chart PLACED on Sheet1 that charts Sheet2!A1:C{endRow + 1}. */
function record(endRow: number, title: string | null = null): string {
  return JSON.stringify({
    chartId: CHART_ID,
    name: "Chart 1",
    sheetIndex: 0,
    x: 10,
    y: 10,
    width: 300,
    height: 200,
    spec: {
      mark: "bar",
      data: { sheetIndex: 1, sheetId: "S1", startRow: 0, startCol: 0, endRow, endCol: 2 },
      hasHeaders: true,
      seriesOrientation: "columns",
      categoryIndex: 0,
      series: [{ name: "Sales", sourceIndex: 1, color: null }],
      title,
      xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
      yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
      legend: { visible: true, position: "bottom" },
      palette: "default",
    },
  });
}

/** Activate Charts over a fake chart backend, its events on the REAL app bus. */
async function activate() {
  const stored: Entry[] = [{ id: CHART_ID, sheetIndex: 0, specJson: record(4) }];
  const updates: Entry[] = [];
  const invokeBackend = vi.fn(async (command: string, args?: unknown) => {
    if (command === "get_charts") return stored.map((e) => ({ ...e }));
    if (command === "update_chart") {
      const entry = (args as { entry: Entry }).entry;
      updates.push(entry);
      const i = stored.findIndex((e) => e.id === entry.id);
      if (i >= 0) stored[i] = { ...entry };
      return null;
    }
    return null;
  });
  const { ext, context } = await loadHarness(CHARTS, { invokeBackend });
  // The shell's ExtensionContext.events.on IS onAppEvent (ExtensionManager.ts).
  const { onAppEvent } = await import("@api/events");
  const inertFn = (): unknown => new Proxy(() => () => {}, { get: () => inertFn(), apply: () => () => {} });
  const events = new Proxy({} as Record<string, unknown>, {
    get: (_t, prop) => (prop === "on" ? onAppEvent : inertFn()),
  });
  const wrapped = new Proxy({} as Record<string, unknown>, {
    get: (_t, prop) => (prop === "events" ? events : (context as Record<string | symbol, unknown>)[prop as string]),
  }) as never;
  await ext.activate(wrapped);
  await settle();
  const store = await import("../../../Charts/lib/chartStore");
  // The wrapper under test, from the same module graph the extension uses.
  const lib = await import("@api/lib");
  return { ext, stored, updates, store, lib };
}

const endRowOf = (spec: unknown): number => ((spec as { data: { endRow: number } }).data.endRow);

describe("an off-sheet structural edit reaches the chart store (BUG-0357 follow-up)", () => {
  // SABOTAGE: delete the announceStructuralEditElsewhere("Insert Rows") call in
  // insertRows' off-sheet branch (core/lib/tauri-api.ts) -> the store keeps
  // endRow 4, and the later save writes 4 back over the backend's 5.
  it("a script's insertRows on another sheet: the store reads the moved range, and a later save writes it", async () => {
    const { ext, stored, updates, store, lib } = await activate();
    expect(endRowOf(store.getChartById(CHART_ID)!.spec)).toBe(4);

    // The backend's off-sheet insert_rows moved the range inside its undo step.
    stored[0].specJson = record(5);
    await lib.insertRows(2, 1, 1);
    await settle();
    expect(endRowOf(store.getChartById(CHART_ID)!.spec), "the store re-read the moved range").toBe(5);

    // A LATER persist of that chart (here a title edit) writes the moved range.
    store.updateChartSpec(CHART_ID, { title: "Later" });
    await store.flushPendingChartSaves();
    const written = JSON.parse(updates.at(-1)!.specJson) as { spec: { title: string; data: { endRow: number } } };
    expect(written.spec.title).toBe("Later");
    expect(written.spec.data.endRow, "the old range must never be written back").toBe(5);
    await ext.deactivate?.();
  });

  it("a PENDING edit at the moment of the off-sheet edit keeps the reader's change AND adopts the moved range", async () => {
    const { ext, stored, updates, store, lib } = await activate();
    store.updateChartSpec(CHART_ID, { title: "Mine" });
    stored[0].specJson = record(5);
    await lib.insertRows(2, 1, 1);
    await settle();
    const chart = store.getChartById(CHART_ID)!;
    expect(chart.spec.title).toBe("Mine");
    expect(endRowOf(chart.spec)).toBe(5);
    const written = JSON.parse(updates.at(-1)!.specJson) as { spec: { title: string; data: { endRow: number } } };
    expect(written.spec.title).toBe("Mine");
    expect(written.spec.data.endRow).toBe(5);
    await ext.deactivate?.();
  });

  it("a floating grid's backing-sheet edit ({ target }) re-reads too", async () => {
    const { ext, stored, store, lib } = await activate();
    stored[0].specJson = record(3);
    await lib.deleteColumns(1, 1, undefined, { target: { kind: "floatingRange", id: "fr-1" } });
    await settle();
    expect(endRowOf(store.getChartById(CHART_ID)!.spec)).toBe(3);
    await ext.deactivate?.();
  });
});

describe("an off-sheet edit leaves the sheet on screen alone (review FU#5)", () => {
  /**
   * The Shell's translation of the `objects` mutation domain, for the one
   * event of it this test watches (src/shell/bootstrap.ts MUTATION_DOMAIN_EVENTS:
   * objects -> "charts:refresh", which the Charts extension answers with an
   * "objects" reload that clears every point selection and insight cue). The
   * unit harness does not run the Shell, so without this an `objects`
   * announcement would go unheard here.
   */
  async function translateObjectsDomain(): Promise<() => void> {
    const { onAppEvent, AppEvents } = await import("@api/events");
    return onAppEvent<{ domains?: string[] }>(AppEvents.MUTATION_REFRESH, (payload) => {
      if (payload?.domains?.includes("objects")) window.dispatchEvent(new CustomEvent("charts:refresh"));
    });
  }

  // SABOTAGE: make the Charts reload deselect for an "elsewhere" request too
  // (extensions/Charts/index.ts reloadCharts) -> the chart is deselected.
  // Before review FU#5 the off-sheet route announced STRUCTURAL_UNDO + objects:
  // the reload deselected the chart and the objects fan-out dropped its point
  // selection.
  it("a script's insertRows on another sheet: the selected chart stays selected, its point selection kept, and the store still re-reads", async () => {
    const { ext, stored, store } = await activate();
    const offTranslate = await translateObjectsDomain();
    try {
      const selection = await import("../../../Charts/handlers/selectionHandler");
      const points = await import("../../../Charts/handlers/chartPointSelection");
      selection.selectChart(CHART_ID);
      points.setPointSelection(CHART_ID, { pick: { keys: ["East"] } } as never);
      const lib = await import("@api/lib");

      stored[0].specJson = record(5);
      await lib.insertRows(2, 1, 1);
      await settle();

      expect(endRowOf(store.getChartById(CHART_ID)!.spec), "the store re-read the moved range").toBe(5);
      expect(selection.getCurrentChartId(), "an edit on a sheet nobody is looking at deselected the chart").toBe(CHART_ID);
      expect(points.getPointSelection(CHART_ID), "the point selection was dropped").toBeDefined();
    } finally {
      offTranslate();
      await ext.deactivate?.();
    }
  });

  it("an ON-sheet insert still deselects, as before", async () => {
    const { ext } = await activate();
    try {
      const selection = await import("../../../Charts/handlers/selectionHandler");
      selection.selectChart(CHART_ID);
      const lib = await import("@api/lib");
      await lib.insertRows(2, 1);
      await settle();
      expect(selection.getCurrentChartId()).toBeNull();
    } finally {
      await ext.deactivate?.();
    }
  });
});

describe("the shared structural-edit list hears the off-sheet routes (Sparklines rides the same list)", () => {
  // CHANGED DELIBERATELY (review FU#5): the off-canvas announcement is one per
  // burst -- the first edit at once, the rest of the burst once, at the end of
  // its window -- so the second call is heard after the window, not at once.
  it("onStructuralEdit calls back for an off-sheet insert at once, and for a target delete in the same burst at the window's end", async () => {
    vi.resetModules();
    const { onAppEvent } = await import("@api/events");
    const { onStructuralEdit } = await import("../structuralEditReload");
    const lib = await import("@api/lib");
    const onEdit = vi.fn();
    const off = onStructuralEdit((name, cb) => onAppEvent(name, cb), onEdit);
    try {
      await lib.insertRows(2, 1, 1);
      expect(onEdit).toHaveBeenCalledTimes(1);
      expect(onEdit).toHaveBeenLastCalledWith("elsewhere");
      await lib.deleteColumns(1, 1, undefined, { target: { kind: "floatingRange", id: "fr-1" } });
      expect(onEdit, "folded into the burst").toHaveBeenCalledTimes(1);
      await new Promise((r) => setTimeout(r, 120));
      expect(onEdit).toHaveBeenCalledTimes(2);
      expect(onEdit).toHaveBeenLastCalledWith("elsewhere");
    } finally {
      off();
    }
  });
});
