//! FILENAME: app/extensions/Charts/__tests__/structuralEditReload.test.ts
// PURPOSE: BUG-0357 -- after a structural edit the chart store re-reads the
//          data ranges the backend moved (chart_range_shift.rs, inside the
//          edit's own undo step), and a PENDING save adopts the moved range
//          instead of writing the old one back.
// CONTEXT: The extension is ACTIVATED for real (the shared lifecycle harness),
//          so the subscription is part of what is tested; the backend is a fake
//          `invokeBackend` holding the stored charts.

import { describe, it, expect, vi } from "vitest";
import { loadHarness, settle, type Loader } from "../../ModelMenu/__tests__/lifecycleHarness";

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

const CHARTS: Loader = () => import("..");
const CHART_ID = "01912345-6789-7abc-8def-0123456789ab";

interface Entry {
  id: string;
  sheetIndex: number;
  specJson: string;
}

/** The chart as the store writes it, its range Sheet1!A1:C{endRow + 1}. */
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
      data: { sheetIndex: 0, sheetId: "S0", startRow: 0, startCol: 0, endRow, endCol: 2 },
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

/** Activate Charts over a fake backend; `fire` delivers an app event to its subscribers. */
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
  const subscribers = new Map<string, Array<(detail: unknown) => void>>();
  const inertFn = (): unknown => new Proxy(() => () => {}, { get: () => inertFn(), apply: () => () => {} });
  const events = new Proxy({} as Record<string, unknown>, {
    get: (_t, prop) => {
      if (prop === "on") {
        return (name: string, cb: (detail: unknown) => void) => {
          const list = subscribers.get(name) ?? [];
          list.push(cb);
          subscribers.set(name, list);
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
  return { ext, stored, updates, store, fire, invokeBackend };
}

describe("charts re-read the ranges a structural edit moved (BUG-0357)", () => {
  it("an inserted row: the store reads the moved range from the backend", async () => {
    const { ext, stored, store, fire } = await activate();
    expect((store.getChartById(CHART_ID)!.spec.data as { endRow: number }).endRow).toBe(4);
    // The backend's insert_rows moved the range inside its undo step.
    stored[0].specJson = record(5);
    await fire("app:rows-inserted", { startRow: 2, count: 1 });
    expect((store.getChartById(CHART_ID)!.spec.data as { endRow: number }).endRow).toBe(5);
    await ext.deactivate?.();
  });

  it("Insert/Delete Cells and a structural undo (STRUCTURAL_UNDO) re-read too", async () => {
    const { ext, stored, store, fire } = await activate();
    stored[0].specJson = record(6);
    await fire("app:structural-undo", { description: "Insert Cells" });
    expect((store.getChartById(CHART_ID)!.spec.data as { endRow: number }).endRow).toBe(6);
    stored[0].specJson = record(3);
    await fire("app:columns-deleted", { startCol: 3, count: 1 });
    expect((store.getChartById(CHART_ID)!.spec.data as { endRow: number }).endRow).toBe(3);
    await ext.deactivate?.();
  });

  it("a PENDING edit keeps the reader's change AND adopts the moved range -- never writes the old range back", async () => {
    const { ext, stored, updates, store, fire } = await activate();
    store.updateChartSpec(CHART_ID, { title: "Mine" });
    stored[0].specJson = record(5);
    await fire("app:rows-inserted", { startRow: 2, count: 1 });
    const chart = store.getChartById(CHART_ID)!;
    expect(chart.spec.title).toBe("Mine");
    expect((chart.spec.data as { endRow: number }).endRow).toBe(5);
    const written = JSON.parse(updates.at(-1)!.specJson) as { spec: { title: string; data: { endRow: number } } };
    expect(written.spec.title).toBe("Mine");
    expect(written.spec.data.endRow).toBe(5);
    await ext.deactivate?.();
  });
});
