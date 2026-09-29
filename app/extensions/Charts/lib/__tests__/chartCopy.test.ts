//! FILENAME: app/extensions/Charts/lib/__tests__/chartCopy.test.ts
// PURPOSE: A chart's share of the OBJECT CLIPBOARD (W25): Charts had no copy at
//          all, so a chart in a canvas multi-selection could not be copied,
//          pasted or duplicated by any key. Proved here, with the REAL chart
//          store, the REAL chart provider and the REAL seam:
//            - a snapshot is a deep copy of the STORED spec (not a hover
//              preview) and survives the original's later edit;
//            - a paste of two charts is ONE undo step, and every `save_chart`
//              LANDS before the step commits (a save still in flight at the
//              commit would record "Insert chart" as a separate Ctrl+Z step);
//            - each copy is a new chart (fresh id, next auto name) at the
//              place the seam chose, and the copies become the selection;
//            - a refused create shows NO chart dialog (the seam's one toast
//              names it) and leaves no chart behind.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@api", () => ({
  addTaskPaneContextKey: vi.fn(),
  removeTaskPaneContextKey: vi.fn(),
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
}));
const log: string[] = [];
vi.mock("../../../../src/core/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  beginUndoTransaction: vi.fn(async (label: string) => {
    log.push(`begin:${label}`);
  }),
  commitUndoTransaction: vi.fn(async () => {
    log.push("commit");
  }),
}));
const toasts: string[] = [];
vi.mock("@api/notifications", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  showToast: (message: string) => {
    toasts.push(message);
  },
}));
const alertAsync = vi.fn<(message: string, options?: unknown) => Promise<void>>(() => Promise.resolve());
vi.mock("@api/dialogs", () => ({ alertAsync: (m: string, o?: unknown) => alertAsync(m, o) }));

import { registerGridOverlay, setGridRegions, getGridRegions } from "@api/gridOverlays";
import {
  getSelectedObjectRegions,
  registerObjectSelectionProvider,
  resetObjectSelectionProviders,
  setObjectSelectionSet,
} from "@api/objectSelection";
import { copySelectedObjects, pasteObjectClipboard, resetObjectClipboard } from "@api/objectClipboard";
import {
  createChartLanded,
  getAllCharts,
  getChartById,
  loadChartsFromBackend,
  previewChartSpec,
  resetChartStore,
  restoreChartSpecPreview,
  setActiveSheetIndex,
  syncChartRegions,
  updateChartSpec,
} from "../chartStore";
import { chartsBackend } from "../chartsBackend";
import { createChartObjectSelectionProvider } from "../chartObjectSelection";
import { pasteChartSnapshots, snapshotChart } from "../chartCopy";
import { resetSelectionHandlerState } from "../../handlers/selectionHandler";
import type { ChartSpec } from "../../types";

const PROTECTED = "Sheet is protected: edit objects is not allowed";

const baseSpec = {
  mark: "bar",
  data: "Sheet1!A1:D13",
  hasHeaders: true,
  seriesOrientation: "columns",
  categoryIndex: 0,
  series: [{ name: "Revenue", sourceIndex: 1, color: null }],
  title: "Stored",
  xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
  yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
  legend: { visible: false, position: "bottom" },
  palette: "default",
} as unknown as ChartSpec;

const entry = (chartId: string, name: string, x: number) => ({
  id: chartId,
  sheetIndex: 0,
  specJson: JSON.stringify({ chartId, name, sheetIndex: 0, x, y: 20, width: 400, height: 300, spec: baseSpec }),
});

/** The backend double: records every call in `log`; `refuseSaves` rejects save_chart. */
let refuseSaves = false;
const invokeBackend = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
  if (cmd === "save_chart") {
    await new Promise((r) => setTimeout(r, 5)); // a real round trip takes time
    if (refuseSaves) {
      log.push("save_chart:refused");
      throw PROTECTED;
    }
    const e = args?.entry as { id: string };
    log.push(`save_chart:${e.id}`);
    return undefined;
  }
  return undefined;
});

const cleanups: Array<() => void> = [];

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(async () => {
  log.length = 0;
  toasts.length = 0;
  refuseSaves = false;
  alertAsync.mockClear();
  resetChartStore();
  resetObjectClipboard();
  resetObjectSelectionProviders();
  resetSelectionHandlerState();
  chartsBackend.set(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "get_charts") return [entry("c1", "Sales", 10), entry("c2", "Costs", 500)];
    return invokeBackend(cmd, args);
  });
  await loadChartsFromBackend();
  setActiveSheetIndex(0);
  syncChartRegions();
  log.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  cleanups.push(
    registerGridOverlay({ type: "chart", render: () => {}, priority: 15 }),
    registerObjectSelectionProvider(
      createChartObjectSelectionProvider({
        emitSelection: () => {},
        invalidateChart: () => {},
        refresh: () => {},
        copyChart: snapshotChart,
        pasteCharts: pasteChartSnapshots,
      }),
    ),
  );
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  resetObjectSelectionProviders();
  resetObjectClipboard();
  setGridRegions([]);
  vi.restoreAllMocks();
});

function regionOf(chartId: string) {
  const r = getGridRegions().find((g) => g.data?.chartId === chartId);
  if (!r) throw new Error(`no region for ${chartId}`);
  return r;
}

describe("the chart snapshot", () => {
  it("is a deep copy of the STORED spec -- not a hover preview, not a live reference", () => {
    previewChartSpec("c1", { title: "Hovered" } as Partial<ChartSpec>);
    const snap = snapshotChart("c1")!;
    restoreChartSpecPreview();
    expect(snap.spec.title, "the snapshot took the transient preview").toBe("Stored");
    updateChartSpec("c1", { title: "Edited later" } as Partial<ChartSpec>);
    expect(snap.spec.title, "the snapshot shares the live spec object").toBe("Stored");
    expect(snap).toMatchObject({ kind: "chart", x: 10, y: 20, width: 400, height: 300 });
  });

  it("is null for a chart that does not exist", () => {
    expect(snapshotChart("nope")).toBeNull();
  });
});

describe("Copy + Paste of charts through the object clipboard", () => {
  it("pastes EVERY copied chart as ONE undo step, each save LANDED before the commit, the copies selected", async () => {
    setObjectSelectionSet([regionOf("c1"), regionOf("c2")], regionOf("c1"));
    await copySelectedObjects();
    log.length = 0;

    await pasteObjectClipboard({ sheetIndex: 0 });
    await settle();

    const saves = log.filter((l) => l.startsWith("save_chart:"));
    expect(saves.length, "not every copied chart was created").toBe(2);
    expect(log[0]).toBe("begin:Paste Objects");
    const commitAt = log.indexOf("commit");
    expect(commitAt, "no commit").toBeGreaterThan(-1);
    for (const s of saves) {
      expect(log.indexOf(s), `${s} landed AFTER the step committed -- a separate Ctrl+Z step`).toBeLessThan(commitAt);
    }
    // New charts, fresh ids and auto names, one step (20 px) from each original.
    const copies = getAllCharts().filter((c) => c.chartId !== "c1" && c.chartId !== "c2");
    expect(copies.map((c) => [c.x, c.y]).sort()).toEqual([
      [30, 40],
      [520, 40],
    ]);
    for (const c of copies) {
      expect(c.name).toMatch(/^Chart \d+$/);
      expect(c.spec.title).toBe("Stored");
    }
    // The copies are the selection now (one held by Charts, one by the set).
    expect(getSelectedObjectRegions().map((r) => r.data?.chartId).sort()).toEqual(copies.map((c) => c.chartId).sort());
    expect(alertAsync).not.toHaveBeenCalled();
  });

  it("a REFUSED create shows no chart dialog, leaves no chart behind, and the seam names it once", async () => {
    setObjectSelectionSet([regionOf("c1")], regionOf("c1"));
    await copySelectedObjects();
    refuseSaves = true;
    await pasteObjectClipboard({ sheetIndex: 0 });
    await settle();
    expect(getAllCharts().map((c) => c.chartId).sort()).toEqual(["c1", "c2"]);
    expect(alertAsync, "a refused paste opened the store's own dialog").not.toHaveBeenCalled();
    expect(toasts).toEqual([`Paste: The object could not be pasted. ${PROTECTED}`]);
  });
});

describe("createChartLanded", () => {
  it("resolves only once the backend HAS the chart, and to the refusal otherwise", async () => {
    const landed = await createChartLanded(baseSpec, { sheetIndex: 0, x: 1, y: 2, width: 3, height: 4 });
    expect(landed.refusal).toBeNull();
    expect(log).toEqual([`save_chart:${landed.chart!.chartId}`]);

    refuseSaves = true;
    const refused = await createChartLanded(
      baseSpec,
      { sheetIndex: 0, x: 1, y: 2, width: 3, height: 4 },
      { reportRefusal: false },
    );
    expect(refused.chart).toBeNull();
    expect(refused.refusal).toBe(PROTECTED);
    expect(getChartById(landed.chart!.chartId)).not.toBeNull();
    expect(getAllCharts().length).toBe(3);
    expect(alertAsync).not.toHaveBeenCalled();
  });
});
