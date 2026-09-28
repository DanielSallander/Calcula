//! FILENAME: app/extensions/Charts/lib/__tests__/chartStoreSheetIds.test.ts
// PURPOSE: M4 (canvas sheets) -- the chart store's half of "a chart follows its
//          data sheet":
//            1. stampSpecSheetIds finds a DataRangeRef in all FOUR places a spec
//               carries one (data, layers[].data, lookup `from`, concat
//               children, recursively) and leaves everything else alone;
//            2. fromEntry: the backend entry's placement index WINS over the
//               stale copy inside the JSON (the backend remaps the entry on a
//               sheet delete / move and never rewrites the JSON);
//            3. the load-time migration stamps the sheet id and persists it
//               through the debounced update AS A STAMP (`sheetIdStamp:
//               "afterLoad"`, the stored record plus its ids -- recorded clean
//               by the backend) -- and a refused stamp write is logged, not
//               shown as lost work;
//            4. createChart stamps from a warm sheet cache synchronously, and
//               from a cold one as a stamp that says it FINISHES the create
//               (`"afterCreate"`, which the backend records as dirtying);
//            5. a reload after a sheet-list change flushes a pending save
//               WITHOUT writing the pre-remap placement index back.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  getSheets: vi.fn(),
  alertAsync: vi.fn<(message: string, options?: unknown) => Promise<void>>(() => Promise.resolve()),
}));

vi.mock("@api/lib", () => ({ getSheets: h.getSheets }));
vi.mock("@api/dialogs", () => ({ alertAsync: (m: string, o?: unknown) => h.alertAsync(m, o) }));

import {
  createChart,
  fromEntry,
  getChartById,
  loadChartsFromBackend,
  flushPendingChartSaves,
  moveChart,
  reloadChartsAfterSheetListChange,
  resetChartStore,
} from "../chartStore";
import { chartsBackend } from "../chartsBackend";
import { stampSpecSheetIds, specHasUnstampedRangeRef } from "../chartSheetRefs";
import { installSheetIdCacheInvalidation, loadSheetIdMap, resetSheetIdCacheForTests } from "../sheetIdMap";
import type { ChartSpec, DataRangeRef, TransformSpec } from "../../types";

const invokeBackend = vi.fn();

const baseAxis = { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null };
function spec(over: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark: "bar",
    data: { sheetIndex: 1, startRow: 0, startCol: 0, endRow: 4, endCol: 1 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "Sales", sourceIndex: 1, color: null }],
    title: null,
    xAxis: { ...baseAxis },
    yAxis: { ...baseAxis },
    legend: { visible: true, position: "bottom" },
    palette: "default",
    ...over,
  } as ChartSpec;
}

const r = (sheetIndex: number, sheetId?: string): DataRangeRef => ({
  sheetIndex,
  ...(sheetId ? { sheetId } : {}),
  startRow: 0,
  startCol: 0,
  endRow: 3,
  endCol: 1,
});

/** A spec carrying a range ref in every place one can live. */
function everywhere(): ChartSpec {
  return spec({
    data: r(0),
    layers: [{ mark: "line", data: r(1) }, { mark: "rule" }],
    transform: [
      { type: "lookup", from: r(2), fields: ["T"] },
      { type: "filter", field: "Sales", predicate: "> 0" } as unknown as TransformSpec,
    ],
    concat: { charts: [spec({ data: r(1), concat: { charts: [spec({ data: r(0) })] } }), spec({ data: "Sheet1!A1:B4" })] },
  });
}

const IDS: Record<number, string> = { 0: "id-0", 1: "id-1", 2: "id-2" };
const idFor = (i: number) => IDS[i];

function entry(id: string, placementInEntry: number, placementInJson: number, s: ChartSpec) {
  return {
    id,
    sheetIndex: placementInEntry,
    specJson: JSON.stringify({ chartId: id, name: `Chart ${id}`, sheetIndex: placementInJson, x: 10, y: 20, width: 400, height: 300, spec: s }),
  };
}

let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let uninstall: (() => void) | null = null;

beforeEach(() => {
  resetChartStore();
  resetSheetIdCacheForTests();
  invokeBackend.mockReset();
  h.alertAsync.mockReset();
  h.alertAsync.mockImplementation(() => Promise.resolve());
  h.getSheets.mockReset();
  h.getSheets.mockImplementation(async () => ({
    sheets: [0, 1, 2].map((i) => ({ index: i, name: `S${i}`, sheetId: IDS[i], visibility: "visible" })),
    activeIndex: 0,
  }));
  chartsBackend.set(invokeBackend);
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
  resetSheetIdCacheForTests();
  resetChartStore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

/** The spec a given backend command was last called with, parsed. */
function lastWrittenSpec(command: string): { sheetIndex: number; chart: { sheetIndex: number; x: number; spec: ChartSpec } } | null {
  const calls = invokeBackend.mock.calls.filter((c) => c[0] === command);
  if (calls.length === 0) return null;
  const e = (calls[calls.length - 1][1] as { entry: { sheetIndex: number; specJson: string } }).entry;
  return { sheetIndex: e.sheetIndex, chart: JSON.parse(e.specJson) };
}

// ===========================================================================

describe("stampSpecSheetIds", () => {
  it("stamps data, layers[].data, lookup from and concat children (recursively)", () => {
    const out = stampSpecSheetIds(everywhere(), idFor);
    expect((out.data as DataRangeRef).sheetId).toBe("id-0");
    expect((out.layers![0].data as DataRangeRef).sheetId).toBe("id-1");
    expect(out.layers![1].data).toBeUndefined();
    const lookup = out.transform![0] as { from: DataRangeRef };
    expect(lookup.from.sheetId).toBe("id-2");
    const child = out.concat!.charts[0];
    expect((child.data as DataRangeRef).sheetId).toBe("id-1");
    expect((child.concat!.charts[0].data as DataRangeRef).sheetId).toBe("id-0");
    // An A1 string stays NAME-bound.
    expect(out.concat!.charts[1].data).toBe("Sheet1!A1:B4");
    expect(specHasUnstampedRangeRef(out)).toBe(false);
  });

  it("does not mutate its input and returns the SAME spec when nothing needs a stamp", () => {
    const input = everywhere();
    const before = JSON.stringify(input);
    const once = stampSpecSheetIds(input, idFor);
    expect(JSON.stringify(input)).toBe(before);
    expect(stampSpecSheetIds(once, idFor)).toBe(once);
  });

  it("keeps an existing id and leaves a ref whose index no sheet has", () => {
    const s = spec({ data: r(0, "already"), layers: [{ mark: "line", data: r(7) }] });
    const out = stampSpecSheetIds(s, idFor);
    expect((out.data as DataRangeRef).sheetId).toBe("already");
    expect((out.layers![0].data as DataRangeRef).sheetId).toBeUndefined();
  });
});

describe("fromEntry: the entry's placement index wins", () => {
  it("prefers entry.sheetIndex over the stale copy inside specJson", () => {
    const def = fromEntry(entry("c1", 3, 1, spec()));
    expect(def.sheetIndex).toBe(3);
  });

  it("still reads the JSON's geometry and spec", () => {
    const def = fromEntry(entry("c1", 0, 0, spec({ title: "T" })));
    expect(def.x).toBe(10);
    expect(def.spec.title).toBe("T");
  });

  it("the loaded store carries the remapped placement", async () => {
    invokeBackend.mockImplementation(async (cmd: string) => (cmd === "get_charts" ? [entry("c1", 0, 2, spec({ data: r(0, "id-0") }))] : undefined));
    await loadChartsFromBackend();
    expect(getChartById("c1")!.sheetIndex).toBe(0);
  });
});

describe("load-time migration", () => {
  it("stamps every unstamped ref from ONE sheet-list read and persists through update_chart", async () => {
    invokeBackend.mockImplementation(async (cmd: string) =>
      cmd === "get_charts" ? [entry("c1", 0, 0, everywhere()), entry("c2", 0, 0, spec({ data: r(2) }))] : undefined,
    );
    await loadChartsFromBackend();
    expect(h.getSheets).toHaveBeenCalledTimes(1);
    expect(specHasUnstampedRangeRef(getChartById("c1")!.spec)).toBe(false);
    expect((getChartById("c2")!.spec.data as DataRangeRef).sheetId).toBe("id-2");

    await flushPendingChartSaves();
    const writes = invokeBackend.mock.calls.filter((c) => c[0] === "update_chart");
    expect(writes.map((c) => (c[1] as { entry: { id: string } }).entry.id).sort()).toEqual(["c1", "c2"]);
    const written = lastWrittenSpec("update_chart")!;
    expect(specHasUnstampedRangeRef(written.chart.spec)).toBe(false);
  });

  it("writes nothing (and reads no sheet list) when every ref is already stamped", async () => {
    invokeBackend.mockImplementation(async (cmd: string) =>
      cmd === "get_charts" ? [entry("c1", 0, 0, spec({ data: r(1, "id-1") })), entry("c2", 0, 0, spec({ data: "Sheet1!A1:B4" }))] : undefined,
    );
    await loadChartsFromBackend();
    await flushPendingChartSaves();
    expect(h.getSheets).not.toHaveBeenCalled();
    expect(invokeBackend.mock.calls.filter((c) => c[0] === "update_chart")).toHaveLength(0);
  });

  it("a REFUSED stamp write is logged, never shown as lost work", async () => {
    invokeBackend.mockImplementation(async (cmd: string) => {
      if (cmd === "get_charts") return [entry("c1", 0, 0, spec())];
      if (cmd === "update_chart") throw "Sheet is protected: edit objects is not allowed";
      return undefined;
    });
    await loadChartsFromBackend();
    await flushPendingChartSaves();
    expect(h.alertAsync).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("source sheet id"))).toBe(true);
  });

  it("a real edit before the flush makes a refusal loud again", async () => {
    invokeBackend.mockImplementation(async (cmd: string) => {
      if (cmd === "get_charts") return [entry("c1", 0, 0, spec())];
      if (cmd === "update_chart") throw "Sheet is protected: edit objects is not allowed";
      return undefined;
    });
    await loadChartsFromBackend();
    moveChart("c1", 99, 99);
    await flushPendingChartSaves();
    expect(h.alertAsync).toHaveBeenCalledTimes(1);
  });

  it("records the stamp AS A STAMP: the STORED record plus its ids, flagged as finishing the load -- never the normalized definition", async () => {
    // What a raw `save_chart` stores (scripts, MCP, the E2E harness): a BARE
    // spec, no axes, no legend, no wrapper. The store normalizes that into a
    // full ChartDefinition in memory. Written back through the ordinary update
    // the stamp dirtied the document on every open and every reload (journey
    // dirty-flag.spec.ts, PERSISTENCE); the backend records a write flagged
    // `sheetIdStamp: "afterLoad"` clean, but only after verifying it adds sheet ids and nothing
    // else -- which the normalized definition never would.
    const bare = {
      mark: "bar",
      data: { sheetIndex: 1, startRow: 5, startCol: 30, endRow: 8, endCol: 31 },
      series: [{ sourceIndex: 1, name: "Sales", color: "#4472C4" }],
      title: "Dirty Flag Chart",
    };
    invokeBackend.mockImplementation(async (cmd: string) =>
      cmd === "get_charts" ? [{ id: "c3", sheetIndex: 0, specJson: JSON.stringify(bare) }] : undefined,
    );
    await loadChartsFromBackend();
    // In memory the chart is normalized AND stamped.
    expect(getChartById("c3")!.spec.xAxis).toBeDefined();
    expect((getChartById("c3")!.spec.data as DataRangeRef).sheetId).toBe("id-1");

    await flushPendingChartSaves();
    const writes = invokeBackend.mock.calls.filter((c) => c[0] === "update_chart");
    expect(writes).toHaveLength(1);
    const args = writes[0][1] as { entry: { id: string; sheetIndex: number; specJson: string }; sheetIdStamp?: string };
    expect(args.sheetIdStamp, "the load-time stamp must travel as a stamp that finishes the LOAD").toBe("afterLoad");
    expect(args.entry.id).toBe("c3");
    expect(args.entry.sheetIndex).toBe(0);
    expect(JSON.parse(args.entry.specJson), "exactly the stored record, plus the sheet id").toEqual({
      ...bare,
      data: { ...bare.data, sheetId: "id-1" },
    });
  });

  it("a real edit is written as an ordinary update, whole definition, never flagged as a stamp", async () => {
    invokeBackend.mockImplementation(async (cmd: string) =>
      cmd === "get_charts" ? [entry("c1", 0, 0, spec())] : undefined,
    );
    await loadChartsFromBackend();
    moveChart("c1", 99, 99);
    await flushPendingChartSaves();
    const writes = invokeBackend.mock.calls.filter((c) => c[0] === "update_chart");
    expect(writes).toHaveLength(1);
    const args = writes[0][1] as { entry: { specJson: string }; sheetIdStamp?: string };
    expect(args.sheetIdStamp).toBeUndefined();
    const written = JSON.parse(args.entry.specJson) as { x: number; spec: ChartSpec };
    expect(written.x).toBe(99);
    expect((written.spec.data as DataRangeRef).sheetId, "the edit still carries the stamp").toBe("id-1");
  });
});

describe("createChart stamps the id", () => {
  it("synchronously, from a warm sheet cache", async () => {
    uninstall = installSheetIdCacheInvalidation();
    await loadSheetIdMap();
    invokeBackend.mockResolvedValue(undefined);
    const chart = createChart(spec({ data: r(2) }), { sheetIndex: 0, x: 0, y: 0, width: 100, height: 100 });
    expect((chart.spec.data as DataRangeRef).sheetId).toBe("id-2");
    // And the create's save carries it.
    const saved = lastWrittenSpec("save_chart")!;
    expect((saved.chart.spec.data as DataRangeRef).sheetId).toBe("id-2");
  });

  it("after the save, through the update path, when the cache was cold", async () => {
    invokeBackend.mockResolvedValue(undefined);
    const chart = createChart(spec({ data: r(1) }), { sheetIndex: 0, x: 0, y: 0, width: 100, height: 100 });
    // The save is NOT delayed for the stamp (a create then an immediate delete
    // must reach the backend in that order).
    expect(invokeBackend.mock.calls[0][0]).toBe("save_chart");
    await new Promise((res) => setTimeout(res, 0));
    await flushPendingChartSaves();
    expect((getChartById(chart.chartId)!.spec.data as DataRangeRef).sheetId).toBe("id-1");
    expect((lastWrittenSpec("update_chart")!.chart.spec.data as DataRangeRef).sheetId).toBe("id-1");
    // A stamp of the record the create wrote, so it adds no second undo step
    // behind "Insert chart": exactly that record plus the id. It says it
    // finishes the CREATE: nothing is being loaded, so the backend must record
    // it as dirtying (like the create), never under the load path's clean reason.
    const stampWrite = invokeBackend.mock.calls.filter((c) => c[0] === "update_chart").pop()![1] as {
      entry: { specJson: string };
      sheetIdStamp?: string;
    };
    expect(stampWrite.sheetIdStamp, "a create's late stamp must say it finishes the create").toBe("afterCreate");
    const created = JSON.parse((invokeBackend.mock.calls[0][1] as { entry: { specJson: string } }).entry.specJson);
    expect(JSON.parse(stampWrite.entry.specJson)).toEqual({
      ...created,
      spec: { ...created.spec, data: { ...created.spec.data, sheetId: "id-1" } },
    });
  });
});

describe("reload after a sheet-list change", () => {
  it("flushes a pending drag with the backend's REMAPPED placement, then reloads", async () => {
    // Loaded on sheet 1.
    let stored = [entry("c1", 1, 1, spec({ data: r(1, "id-1") }))];
    invokeBackend.mockImplementation(async (cmd: string, args?: { entry?: { id: string; sheetIndex: number; specJson: string } }) => {
      if (cmd === "get_charts") return stored;
      if (cmd === "update_chart" && args?.entry) {
        stored = [{ id: args.entry.id, sheetIndex: args.entry.sheetIndex, specJson: args.entry.specJson }];
      }
      return undefined;
    });
    await loadChartsFromBackend();

    // A drag schedules a write 300 ms out ...
    moveChart("c1", 250, 260);
    // ... and before it fires, sheet 0 is deleted: the backend remaps the
    // chart's entry to sheet 0 (its JSON still says 1).
    stored = [{ ...stored[0], sheetIndex: 0 }];

    await reloadChartsAfterSheetListChange();

    const written = lastWrittenSpec("update_chart")!;
    expect(written.sheetIndex).toBe(0); // NOT the pre-remap 1
    expect(written.chart.x).toBe(250); // the drag survived
    const reloaded = getChartById("c1")!;
    expect(reloaded.sheetIndex).toBe(0);
    expect(reloaded.x).toBe(250);
  });

  it("drops a pending save for a chart that went with its sheet (no spurious error)", async () => {
    let stored = [entry("c1", 1, 1, spec({ data: r(1, "id-1") }))];
    invokeBackend.mockImplementation(async (cmd: string) => {
      if (cmd === "get_charts") return stored;
      if (cmd === "update_chart") throw "Chart with id c1 not found";
      return undefined;
    });
    await loadChartsFromBackend();
    moveChart("c1", 5, 5);
    stored = [];
    await reloadChartsAfterSheetListChange();
    expect(invokeBackend.mock.calls.filter((c) => c[0] === "update_chart")).toHaveLength(0);
    expect(h.alertAsync).not.toHaveBeenCalled();
    expect(getChartById("c1")).toBeNull();
  });
});
