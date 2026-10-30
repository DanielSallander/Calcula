//! FILENAME: app/extensions/Charts/__tests__/structuralEditPendingSave.test.ts
// PURPOSE: A chart edit still WAITING to be saved (the store debounces its
//          writes by 300 ms) when the backend rewrites the chart on its own --
//          a structural edit moving its ranges and series (BUG-0357,
//          chart_range_shift.rs), or that edit undone. Neither the reader's
//          edit nor the backend's rewrite may be lost:
//            - revF#1: a pending change to the SERIES list, merged with a
//              backend that removed or put back series, is lined up by each
//              series' name, never by its position;
//            - revF#4: a save that fires while the structural command runs,
//              or while the reload after it reads the store, is made against
//              the record the store last saw (`update_chart`'s `base`); the
//              backend refuses it, and the store merges and writes again.
//            - rev3C#6: an edit made while a write is IN FLIGHT is not
//              recorded as saved, so the next merge keeps it;
//            - rev3C#7: a write still refused as CHANGED after the last merge
//              is reported in a plain sentence, and rolled back to what the
//              backend stores now.
// CONTEXT: The extension is ACTIVATED for real (the shared lifecycle harness);
//          the backend is a fake `invokeBackend` that, like chart_commands.rs,
//          refuses a write whose base it no longer holds.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadHarness, settle, type Loader } from "../../ModelMenu/__tests__/lifecycleHarness";

const h = vi.hoisted(() => ({ toasts: [] as string[], alerts: [] as string[] }));

vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  listenForEvent: vi.fn(async () => () => {}),
  listenTauriEvent: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async (cmd: string) => (cmd === "get_all_styles" ? [] : null)),
}));
vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/event")>()),
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@api/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/notifications")>()),
  showToast: vi.fn((message: string) => {
    h.toasts.push(message);
    return { dismiss: () => {} };
  }),
}));
vi.mock("@api/dialogs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/dialogs")>()),
  alertAsync: vi.fn(async (message: string) => {
    h.alerts.push(message);
  }),
}));

const CHARTS: Loader = () => import("..");
const CHART_ID = "01912345-6789-7abc-8def-0123456789ab";

interface Entry {
  id: string;
  sheetIndex: number;
  specJson: string;
}

interface Series {
  name: string;
  sourceIndex: number;
  color: string | null;
}

const SALES: Series = { name: "Sales", sourceIndex: 1, color: null };
const COST: Series = { name: "Cost", sourceIndex: 2, color: null };

/** The chart as the store writes it: Sheet1!A1:{endCol}{endRow + 1}. */
function record(
  o: { endRow?: number; endCol?: number; title?: string | null; series?: Series[]; x?: number } = {},
): string {
  return JSON.stringify({
    chartId: CHART_ID,
    name: "Chart 1",
    sheetIndex: 0,
    x: o.x ?? 10,
    y: 10,
    width: 300,
    height: 200,
    spec: {
      mark: "bar",
      data: { sheetIndex: 0, sheetId: "S0", startRow: 0, startCol: 0, endRow: o.endRow ?? 4, endCol: o.endCol ?? 2 },
      hasHeaders: true,
      seriesOrientation: "columns",
      categoryIndex: 0,
      series: o.series ?? [SALES, COST],
      title: o.title ?? null,
      xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
      yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
      legend: { visible: true, position: "bottom" },
      palette: "default",
    },
  });
}

interface StoredSpec {
  title: string | null;
  data: { endRow: number; endCol: number };
  series: Series[];
}

/** Activate Charts over a fake backend that checks a write's `base` as chart_commands.rs does. */
async function activate(initial: string) {
  const stored: Entry[] = [{ id: CHART_ID, sheetIndex: 0, specJson: initial }];
  const updates: Entry[] = [];
  const refused: Entry[] = [];
  /**
   * While `read` is set, `get_charts` waits for it (a slow read); while
   * `write` is set, `update_chart` waits for it (a write in flight).
   * `beforeWrite` runs as each `update_chart` is handled, before its base is
   * checked (the backend rewriting the record just ahead of it).
   */
  const gate: { read: Promise<void> | null; write: Promise<void> | null; beforeWrite: (() => void) | null } = {
    read: null,
    write: null,
    beforeWrite: null,
  };
  const invokeBackend = vi.fn(async (command: string, args?: unknown) => {
    if (command === "get_charts") {
      if (gate.read) await gate.read;
      return stored.map((e) => ({ ...e }));
    }
    if (command === "save_chart") {
      // The upsert a create writes (chart_commands.rs save_chart).
      if (gate.write) await gate.write;
      const { entry } = args as { entry: Entry };
      const i = stored.findIndex((e) => e.id === entry.id);
      if (i < 0) stored.push({ ...entry });
      else stored[i] = { ...entry };
      return null;
    }
    if (command === "update_chart") {
      if (gate.write) await gate.write;
      gate.beforeWrite?.();
      const { entry, base } = args as { entry: Entry; base?: Entry };
      const i = stored.findIndex((e) => e.id === entry.id);
      if (i < 0) throw `Chart with id ${entry.id} not found`;
      if (base && (stored[i].sheetIndex !== base.sheetIndex || stored[i].specJson !== base.specJson)) {
        refused.push(entry);
        throw `CHART_RECORD_CHANGED: chart ${entry.id} changed in the workbook after this edit was made`;
      }
      updates.push(entry);
      stored[i] = { ...entry };
      return null;
    }
    return null;
  });
  const { ext, context } = await loadHarness(CHARTS, { invokeBackend });
  const subscribers = new Map<string, Array<(detail: unknown) => void>>();
  const inertFn = (): unknown => new Proxy(() => () => {}, { get: () => inertFn(), apply: () => () => {} });
  const events = new Proxy({} as Record<string, unknown>, {
    get: (_t, prop) => {
      if (prop === "on") {
        return (name: string, cb: (detail: unknown) => void) => {
          subscribers.set(name, [...(subscribers.get(name) ?? []), cb]);
          return () => subscribers.set(name, (subscribers.get(name) ?? []).filter((x) => x !== cb));
        };
      }
      return inertFn();
    },
  });
  const wrapped = new Proxy({} as Record<string, unknown>, {
    get: (_t, prop) => (prop === "events" ? events : (context as Record<string | symbol, unknown>)[prop as string]),
  }) as never;
  await ext.activate(wrapped);
  await settle();
  const store = await import("../lib/chartStore");
  const fire = async (name: string, detail?: unknown) => {
    for (const cb of subscribers.get(name) ?? []) cb(detail);
    await settle();
  };
  const storedSpec = (): StoredSpec => (JSON.parse(stored[0].specJson) as { spec: StoredSpec }).spec;
  const writtenSpec = (): StoredSpec => (JSON.parse(updates.at(-1)!.specJson) as { spec: StoredSpec }).spec;
  return { ext, stored, updates, refused, gate, store, fire, storedSpec, writtenSpec };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  h.toasts.length = 0;
  h.alerts.length = 0;
});

describe("a pending SERIES edit meets a structural edit that removed or restored series (revF#1)", () => {
  it("Delete Column B: the backend's series are written, the recolour kept on the series that survived", async () => {
    const t = await activate(record());
    // The reader recolours Cost (a debounced save is pending).
    t.store.updateChartSpec(CHART_ID, { series: [SALES, { ...COST, color: "#ff0000" }] });
    // delete_columns(B): Sales goes, Cost is re-pointed to column B.
    t.stored[0].specJson = record({ endCol: 1, series: [{ ...COST, sourceIndex: 1 }] });
    await t.fire("app:columns-deleted", { startCol: 1, count: 1 });
    expect(t.writtenSpec().data.endCol).toBe(1);
    expect(t.writtenSpec().series).toEqual([{ name: "Cost", sourceIndex: 1, color: "#ff0000" }]);
    expect(t.store.getChartById(CHART_ID)!.spec.series).toEqual([{ name: "Cost", sourceIndex: 1, color: "#ff0000" }]);
    expect(h.toasts, "nothing the reader did was dropped").toEqual([]);
    await t.ext.deactivate?.();
  });

  it("Delete Column B under a recolour of Sales itself: Sales goes with its column, Cost is NOT given its colour", async () => {
    const t = await activate(record());
    t.store.updateChartSpec(CHART_ID, { series: [{ ...SALES, color: "#ff0000" }, COST] });
    t.stored[0].specJson = record({ endCol: 1, series: [{ ...COST, sourceIndex: 1 }] });
    await t.fire("app:columns-deleted", { startCol: 1, count: 1 });
    // Lined up by position, "Sales" (red) was written over Cost's re-pointed
    // series and Cost pointed outside the range.
    expect(t.writtenSpec().series).toEqual([{ name: "Cost", sourceIndex: 1, color: null }]);
    await t.ext.deactivate?.();
  });

  it("the undo of that delete within the debounce: the restored series come back, the recolour stays on Cost", async () => {
    const t = await activate(record({ endCol: 1, series: [{ ...COST, sourceIndex: 1 }] }));
    t.store.updateChartSpec(CHART_ID, { series: [{ ...COST, sourceIndex: 1, color: "#ff0000" }] });
    // Ctrl+Z of the column delete: the backend puts the two-series record back.
    t.stored[0].specJson = record();
    await t.fire("app:structural-undo", { description: "Delete Columns" });
    expect(t.writtenSpec().data.endCol).toBe(2);
    expect(t.writtenSpec().series).toEqual([SALES, { ...COST, color: "#ff0000" }]);
    await t.ext.deactivate?.();
  });

  it("an edit that changed WHICH series there are cannot be lined up: the backend's list is written, and the reader is told", async () => {
    const t = await activate(record());
    // The reader unchecks Sales; then column C (Cost) is deleted.
    t.store.updateChartSpec(CHART_ID, { series: [COST] });
    t.stored[0].specJson = record({ endCol: 1, series: [SALES] });
    await t.fire("app:columns-deleted", { startCol: 2, count: 1 });
    expect(t.writtenSpec().data.endCol).toBe(1);
    // Never Cost at column C (outside the range) -- the edit-wins answer.
    expect(t.writtenSpec().series).toEqual([SALES]);
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0]).toContain("series");
    await t.ext.deactivate?.();
  });
});

describe("a save that fires while the backend rewrites the chart is merged, never written over it (revF#4)", () => {
  it("the debounce firing while Insert Rows runs: refused as CHANGED, merged, written again", async () => {
    const t = await activate(record());
    t.store.updateChartSpec(CHART_ID, { title: "Mine" });
    // insert_rows is running and has moved the range; its reply (and the
    // ROWS_INSERTED that follows it) has not arrived when the timer fires.
    t.stored[0].specJson = record({ endRow: 5 });
    await wait(400);
    expect(t.storedSpec().data.endRow, "the moved range survives").toBe(5);
    expect(t.storedSpec().title, "and so does the reader's edit").toBe("Mine");
    expect(t.refused, "the stale write was made against the record the store had seen").toHaveLength(1);
    await t.fire("app:rows-inserted", { startRow: 2, count: 1 });
    expect(t.storedSpec().data.endRow).toBe(5);
    expect(t.storedSpec().title).toBe("Mine");
    const chart = t.store.getChartById(CHART_ID)!;
    expect((chart.spec.data as { endRow: number }).endRow).toBe(5);
    expect(chart.spec.title).toBe("Mine");
    await t.ext.deactivate?.();
  });

  it("the reload takes the pending save BEFORE it reads the store: no stale write goes out while it waits", async () => {
    const t = await activate(record());
    t.store.updateChartSpec(CHART_ID, { title: "Mine" });
    t.stored[0].specJson = record({ endRow: 5 });
    let release: () => void = () => {};
    t.gate.read = new Promise<void>((r) => {
      release = r;
    });
    await t.fire("app:rows-inserted", { startRow: 2, count: 1 });
    // Past the debounce while the reload's read is still outstanding.
    await wait(400);
    expect(t.refused, "the timer fired a write of the pre-insert record").toEqual([]);
    expect(t.updates).toEqual([]);
    t.gate.read = null;
    release();
    await wait(50);
    await settle();
    expect(t.storedSpec().data.endRow).toBe(5);
    expect(t.storedSpec().title).toBe("Mine");
    await t.ext.deactivate?.();
  });
});

describe("what a write SENT is what counts as saved, and a write that keeps meeting rewrites says so plainly (rev3C#6, rev3C#7)", () => {
  it("a drag that lands while the previous write is in flight is kept through the Insert Rows that follows", async () => {
    const t = await activate(record());
    let release: () => void = () => {};
    t.gate.write = new Promise<void>((r) => {
      release = r;
    });
    // The drag's first position is written (the debounce fires) ...
    t.store.moveChart(CHART_ID, 50, 10);
    await wait(400);
    // ... and the drag goes on while that write is in flight.
    t.store.moveChart(CHART_ID, 90, 10);
    t.gate.write = null;
    release();
    await settle();
    expect((JSON.parse(t.updates[0].specJson) as { x: number }).x, "the in-flight write sent x 50").toBe(50);
    // Insert Rows before the next debounce: the backend moves the range of
    // the record it holds (x 50), and the reload merges the pending drag.
    t.stored[0].specJson = record({ endRow: 5, x: 50 });
    await t.fire("app:rows-inserted", { startRow: 2, count: 1 });
    const saved = JSON.parse(t.stored[0].specJson) as { x: number; spec: StoredSpec };
    // Recorded as saved from the LIVE chart after the await, x 90 looked
    // unedited, and the merge put the backend's x 50 back with no word.
    expect(saved.x, "the drag made during the write survives").toBe(90);
    expect(saved.spec.data.endRow, "and so does the moved range").toBe(5);
    expect(t.store.getChartById(CHART_ID)!.x).toBe(90);
    expect(h.toasts).toEqual([]);
    await t.ext.deactivate?.();
  });

  it("a chart dragged while its create is still being saved keeps the drag through the Insert Rows that follows", async () => {
    const t = await activate(record());
    let release: () => void = () => {};
    t.gate.write = new Promise<void>((r) => {
      release = r;
    });
    const spec = (JSON.parse(record()) as { spec: unknown }).spec as Parameters<typeof t.store.createChart>[0];
    const created = t.store.createChart(spec, { sheetIndex: 0, x: 20, y: 20, width: 300, height: 200 });
    // Dragged at once, while `save_chart` is in flight.
    t.store.moveChart(created.chartId, 120, 20);
    t.gate.write = null;
    release();
    await settle();
    const createdEntry = () => t.stored.find((e) => e.id === created.chartId)!;
    expect((JSON.parse(createdEntry().specJson) as { x: number }).x, "the create sent x 20").toBe(20);
    // Insert Rows: the backend moves the range of the record the create wrote.
    const moved = JSON.parse(createdEntry().specJson) as { spec: { data: { endRow: number } } };
    moved.spec.data.endRow = 5;
    createdEntry().specJson = JSON.stringify(moved);
    await t.fire("app:rows-inserted", { startRow: 2, count: 1 });
    const saved = JSON.parse(createdEntry().specJson) as { x: number; spec: StoredSpec };
    expect(saved.x, "the drag made during the create survives").toBe(120);
    expect(saved.spec.data.endRow, "and so does the moved range").toBe(5);
    await t.ext.deactivate?.();
  });

  it("refused as CHANGED after the last merge: a plain sentence, and the chart shows what is stored now", async () => {
    const t = await activate(record());
    // Every write meets one more rewrite of the record just ahead of it
    // (repeated script or AI edits): endRow 5, 6, 7, 8.
    let endRow = 4;
    t.gate.beforeWrite = () => {
      endRow += 1;
      t.stored[0].specJson = record({ endRow });
    };
    t.store.updateChartSpec(CHART_ID, { title: "Mine" });
    await wait(400);
    await vi.waitFor(() => expect(h.alerts).toHaveLength(1));
    t.gate.beforeWrite = null;
    const message = h.alerts[0];
    expect(message, "the reason is a sentence").toContain(
      "The chart was changed in the workbook while this edit was being saved.",
    );
    expect(message, "never the internal code").not.toContain("CHART_RECORD_CHANGED");
    expect(message, "never the chart's id").not.toContain(CHART_ID);
    expect(t.refused).toHaveLength(4);
    // "What you see now matches what is stored": the 4th rewrite, not the 3rd.
    const chart = t.store.getChartById(CHART_ID)!;
    expect((chart.spec.data as { endRow: number }).endRow, "the rollback shows the record stored now").toBe(8);
    expect(chart.spec.title ?? null).toBeNull();
    await t.ext.deactivate?.();
  });
});
