//! FILENAME: app/extensions/Charts/lib/__tests__/chartStorePendingSaveRemap.test.ts
// PURPOSE: A chart save still pending when a sheet is deleted or moved must not
//          write the chart's PRE-operation data-range indices back over the
//          backend's remap.
// CONTEXT: X14 (wave D; wave C sheets fix-up, W9). The backend re-anchors a
//          chart's INDEX-ONLY ranges (`spec.data`, `layers[].data`, a lookup's
//          `from`, `concat` children) when a sheet is deleted or moved
//          (object_deps.rs `remap_chart_index_ranges`), and pins a range whose
//          sheet is gone to an unresolvable sheet id. `update_chart` writes the
//          WHOLE record, and `reloadChartsAfterSheetListChange` adopted only
//          the chart's own placement index before flushing a pending save --
//          so a drag still waiting its 300 ms wrote the stale ranges back, and
//          the chart charted whatever sheet took the old index.
//
//          The fix is a three-way merge before the flush: wherever the backend
//          changed the stored record and the pending edit did not, the
//          backend's value is adopted; where the pending edit changed it, the
//          edit wins. So a pending drag keeps its position AND the remap; an
//          edit to the range's rows keeps the rows and takes the remapped
//          sheet; a range the user re-pointed at another sheet stays theirs.
//
//          Review D (X14 follow-up): the merge went into a LIST only when the
//          edit kept its length, so a pending edit that appended a layer (Keep
//          a cue, attach a comment) or a transform, or removed or reordered
//          one, wrote every untouched element's stale index back -- and the
//          flush's stamp then pinned it to whichever sheet took that index.
//          A list is now merged ELEMENT BY ELEMENT against the element each
//          one came from, whatever the edit did to the list's length.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  getSheets: vi.fn(),
  alertAsync: vi.fn<(message: string, options?: unknown) => Promise<void>>(() => Promise.resolve()),
}));

vi.mock("@api/lib", () => ({ getSheets: h.getSheets }));
vi.mock("@api/dialogs", () => ({ alertAsync: (m: string, o?: unknown) => h.alertAsync(m, o) }));

import {
  getChartById,
  loadChartsFromBackend,
  moveChart,
  previewChartSpec,
  reloadChartsAfterSheetListChange,
  resetChartStore,
  updateChartSpec,
} from "../chartStore";
import { chartsBackend } from "../chartsBackend";
import { installSheetIdCacheInvalidation, loadSheetIdMap, resetSheetIdCacheForTests } from "../sheetIdMap";
import type { ChartSpec, DataRangeRef, LayerSpec, TransformSpec } from "../../types";

/** `calp::chart_refs::UNRESOLVABLE_SHEET_ID` as the backend serializes it. */
const GONE = "ffffffff-ffff-ffff-ffff-ffffffffffff";

const baseAxis = { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null };
function spec(over: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark: "bar",
    data: { sheetIndex: 2, startRow: 0, startCol: 0, endRow: 3, endCol: 1 },
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

const r = (sheetIndex: number, extra: Partial<DataRangeRef> = {}): DataRangeRef => ({
  sheetIndex,
  startRow: 0,
  startCol: 0,
  endRow: 3,
  endCol: 1,
  ...extra,
});

/** Index-only ranges in every place the backend's remap walks. */
function everywhere(): ChartSpec {
  return spec({
    data: r(2),
    layers: [{ mark: "line", data: r(3) }],
    transform: [{ type: "lookup", from: r(0), fields: ["T"] } as unknown as TransformSpec],
    concat: { charts: [spec({ data: r(1) })] },
  });
}

/**
 * The backend's side of "Sheet index 1 was deleted": every index above 1 moves
 * down one, a range ON sheet 1 is pinned to the unresolvable id, and the
 * entry's own placement is re-anchored. The JSON is re-serialized with its
 * keys in another order, as serde_json does.
 */
function backendDeletesSheet1(entry: { id: string; sheetIndex: number; specJson: string }) {
  const record = JSON.parse(entry.specJson);
  const remap = (ref: DataRangeRef): DataRangeRef => {
    if (typeof ref.sheetId === "string" && ref.sheetId !== "") return ref;
    if (ref.sheetIndex === 1) return { ...ref, sheetId: GONE };
    return ref.sheetIndex > 1 ? { ...ref, sheetIndex: ref.sheetIndex - 1 } : ref;
  };
  const walk = (s: ChartSpec): ChartSpec => {
    const out: ChartSpec = { ...s };
    if (s.data && typeof s.data === "object" && "startRow" in s.data) out.data = remap(s.data as DataRangeRef);
    if (Array.isArray(s.layers)) {
      out.layers = s.layers.map((l) => (l.data && typeof l.data === "object" && "startRow" in l.data ? { ...l, data: remap(l.data as DataRangeRef) } : l));
    }
    if (Array.isArray(s.transform)) {
      out.transform = s.transform.map((t) => {
        const lookup = t as unknown as { type: string; from?: DataRangeRef };
        return lookup.type === "lookup" && lookup.from ? ({ ...lookup, from: remap(lookup.from) } as unknown as TransformSpec) : t;
      });
    }
    if (s.concat?.charts) out.concat = { ...s.concat, charts: s.concat.charts.map(walk) };
    return out;
  };
  record.spec = walk(record.spec);
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])]))
        : v;
  return {
    id: entry.id,
    sheetIndex: entry.sheetIndex > 1 ? entry.sheetIndex - 1 : entry.sheetIndex,
    specJson: JSON.stringify(sorted(record)),
  };
}

let stored: Array<{ id: string; sheetIndex: number; specJson: string }> = [];
const invokeBackend = vi.fn();

function entry(id: string, sheetIndex: number, s: ChartSpec) {
  return {
    id,
    sheetIndex,
    specJson: JSON.stringify({ chartId: id, name: `Chart ${id}`, sheetIndex, x: 10, y: 20, width: 400, height: 300, spec: s }),
  };
}

/** The chart the last `update_chart` wrote. */
function written(): { sheetIndex: number; chart: { x: number; spec: ChartSpec } } {
  const calls = invokeBackend.mock.calls.filter((c) => c[0] === "update_chart");
  expect(calls.length, "the pending save was never flushed").toBeGreaterThan(0);
  const e = (calls[calls.length - 1][1] as { entry: { sheetIndex: number; specJson: string } }).entry;
  return { sheetIndex: e.sheetIndex, chart: JSON.parse(e.specJson) };
}

let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  resetChartStore();
  resetSheetIdCacheForTests();
  invokeBackend.mockReset();
  h.alertAsync.mockReset();
  h.alertAsync.mockImplementation(() => Promise.resolve());
  h.getSheets.mockReset();
  h.getSheets.mockImplementation(async () => ({ sheets: [], activeIndex: 0 }));
  chartsBackend.set(invokeBackend);
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  stored = [entry("c1", 2, everywhere())];
  invokeBackend.mockImplementation(async (cmd: string, args?: { entry?: { id: string; sheetIndex: number; specJson: string } }) => {
    if (cmd === "get_charts") return stored;
    if (cmd === "update_chart" && args?.entry) {
      stored = [{ id: args.entry.id, sheetIndex: args.entry.sheetIndex, specJson: args.entry.specJson }];
    }
    return undefined;
  });
  // A chart some path wrote by INDEX (a script, an MCP client): loaded as is,
  // no late stamp (the sheet list is not to hand).
  await loadChartsFromBackend({ stampSheetIds: false });
});

afterEach(() => {
  resetSheetIdCacheForTests();
  resetChartStore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

describe("a pending save flushed after a sheet delete keeps the backend's range remap", () => {
  it("a pending DRAG: the position is the user's, every index-only range is the backend's", async () => {
    moveChart("c1", 250, 260);
    stored = [backendDeletesSheet1(stored[0])];

    await reloadChartsAfterSheetListChange();

    const w = written();
    expect(w.sheetIndex).toBe(1);
    expect(w.chart.x).toBe(250);
    const s = w.chart.spec;
    expect((s.data as DataRangeRef).sheetIndex, "spec.data: the stale index was written over the remap").toBe(1);
    expect((s.layers![0].data as DataRangeRef).sheetIndex, "layers[0].data").toBe(2);
    const lookup = (s.transform![0] as unknown as { from: DataRangeRef }).from;
    expect(lookup.sheetIndex, "a lookup below the deleted sheet is untouched").toBe(0);
    expect(lookup.sheetId).toBeUndefined();
    const child = s.concat!.charts[0].data as DataRangeRef;
    expect(child.sheetId, "a range on the DELETED sheet must stay pinned as gone, not resolve by index").toBe(GONE);
    // The reload then shows what the backend holds.
    expect((getChartById("c1")!.spec.data as DataRangeRef).sheetIndex).toBe(1);
    expect(getChartById("c1")!.x).toBe(250);
  });

  it("a pending edit of the range's ROWS keeps the rows and takes the remapped sheet", async () => {
    updateChartSpec("c1", { data: r(2, { endRow: 9 }) });
    stored = [backendDeletesSheet1(stored[0])];

    await reloadChartsAfterSheetListChange();

    const data = written().chart.spec.data as DataRangeRef;
    expect(data.endRow, "the user's edit was lost").toBe(9);
    expect(data.sheetIndex, "the stale index was written over the remap").toBe(1);
  });

  it("a range the user RE-POINTED at another sheet stays theirs (the edit wins where both changed)", async () => {
    updateChartSpec("c1", { data: r(0, { sheetId: "id-0" }) });
    stored = [backendDeletesSheet1(stored[0])];

    await reloadChartsAfterSheetListChange();

    const data = written().chart.spec.data as DataRangeRef;
    expect(data.sheetIndex).toBe(0);
    expect(data.sheetId).toBe("id-0");
  });

  it("a pending save under a hover PREVIEW persists the original spec, remapped", async () => {
    moveChart("c1", 250, 260);
    previewChartSpec("c1", { title: "hovered" } as Partial<ChartSpec>);
    stored = [backendDeletesSheet1(stored[0])];

    await reloadChartsAfterSheetListChange();

    const s = written().chart.spec;
    expect(s.title, "the preview was persisted").toBeNull();
    expect((s.data as DataRangeRef).sheetIndex, "the stale index was written over the remap").toBe(1);
  });

  it("a REFUSED flush names only the user's edit as lost: the remap is what the backend holds, not a lost edit", async () => {
    moveChart("c1", 250, 260);
    stored = [backendDeletesSheet1(stored[0])];
    invokeBackend.mockImplementation(async (cmd: string) => {
      if (cmd === "get_charts") return stored;
      if (cmd === "update_chart") throw "The sheet is protected.";
      return undefined;
    });

    await reloadChartsAfterSheetListChange();

    expect(h.alertAsync).toHaveBeenCalledTimes(1);
    const message = h.alertAsync.mock.calls[0][0];
    expect(message).toContain("Discarded: position.");
  });
});

describe("a pending edit that changes a LIST's length still takes the remap of every element it did not change", () => {
  /** Replace the stored chart with `s`, loaded the way a script-written chart loads (no late stamp). */
  async function storeAndLoad(s: ChartSpec): Promise<void> {
    stored = [entry("c1", 2, s)];
    await loadChartsFromBackend({ stampSheetIds: false });
  }
  const line = (data: DataRangeRef): LayerSpec => ({ mark: "line", data });
  /** The `text` layer a kept comment becomes (chartOverlayHost `layerForComment`): no data of its own. */
  const note = { mark: "text", markOptions: { x: 0, y: 1, text: "note" } } as LayerSpec;
  const layerData = (s: ChartSpec, i: number): DataRangeRef => s.layers![i].data as DataRangeRef;
  const layersNow = (): LayerSpec[] => getChartById("c1")!.spec.layers ?? [];

  /** Sheets after "index 1 (S1) deleted", with their ids. */
  const AFTER_DELETE = [
    { index: 0, name: "S0", sheetId: "id-S0", visibility: "visible" },
    { index: 1, name: "S2", sheetId: "id-S2", visibility: "visible" },
    { index: 2, name: "S3", sheetId: "id-S3", visibility: "visible" },
    { index: 3, name: "S4", sheetId: "id-S4", visibility: "visible" },
  ];

  it("APPENDING a layer (Keep a cue / a comment): the existing index-only layer is written remapped", async () => {
    await storeAndLoad(spec({ data: r(2), layers: [line(r(3))] }));
    updateChartSpec("c1", { layers: [...layersNow(), note] });
    stored = [backendDeletesSheet1(stored[0])];

    await reloadChartsAfterSheetListChange();

    const s = written().chart.spec;
    expect((s.data as DataRangeRef).sheetIndex, "spec.data (an object) follows the remap").toBe(1);
    expect(s.layers).toHaveLength(2);
    expect(layerData(s, 0).sheetIndex, "layers[0].data: the stale index was written over the remap").toBe(2);
    expect(s.layers![1], "the appended layer is the user's, as written").toEqual(note);
  });

  it("APPENDING a transform: a lookup's `from` is written remapped", async () => {
    const lookup = { type: "lookup", from: r(3), fields: ["T"] } as unknown as TransformSpec;
    await storeAndLoad(spec({ transform: [lookup] }));
    const filter = { type: "filter", field: "Sales", predicate: "> 0" } as unknown as TransformSpec;
    updateChartSpec("c1", { transform: [...(getChartById("c1")!.spec.transform ?? []), filter] });
    stored = [backendDeletesSheet1(stored[0])];

    await reloadChartsAfterSheetListChange();

    const s = written().chart.spec;
    expect(s.transform).toHaveLength(2);
    const from = (s.transform![0] as unknown as { from: DataRangeRef }).from;
    expect(from.sheetIndex, "transform[0].from: the stale index was written over the remap").toBe(2);
    expect(s.transform![1]).toEqual(filter);
  });

  it("with the app's WARM sheet-id cache the flush pins the appended-to chart's layer to the sheet it charted", async () => {
    const uninstall = installSheetIdCacheInvalidation();
    try {
      h.getSheets.mockImplementation(async () => ({ sheets: AFTER_DELETE, activeIndex: 0 }));
      await storeAndLoad(spec({ data: r(2), layers: [line(r(3))] }));
      updateChartSpec("c1", { layers: [...layersNow(), note] });
      stored = [backendDeletesSheet1(stored[0])];
      // The app re-reads its cache after the delete event: the post-delete list.
      await loadSheetIdMap();

      await reloadChartsAfterSheetListChange();

      const s = written().chart.spec;
      expect((s.data as DataRangeRef).sheetId).toBe("id-S2");
      expect(layerData(s, 0).sheetId, "the line layer charted S3 and was pinned to another sheet").toBe("id-S3");
    } finally {
      uninstall();
    }
  });

  it("REMOVING a layer: the remaining layer on the deleted sheet stays pinned as gone (never resolves by index to S2)", async () => {
    await storeAndLoad(spec({ layers: [line(r(3)), line(r(1))] }));
    updateChartSpec("c1", { layers: [layersNow()[1]] });
    stored = [backendDeletesSheet1(stored[0])];

    await reloadChartsAfterSheetListChange();

    const s = written().chart.spec;
    expect(s.layers).toHaveLength(1);
    expect(layerData(s, 0).sheetId, "the layer on the deleted sheet lost its gone pin").toBe(GONE);
  });

  it("REORDERING layers: each layer takes ITS OWN remap, never its neighbour's", async () => {
    await storeAndLoad(spec({ layers: [line(r(3)), line(r(1))] }));
    const [onS3, onS1] = layersNow();
    updateChartSpec("c1", { layers: [onS1, onS3] });
    stored = [backendDeletesSheet1(stored[0])];

    await reloadChartsAfterSheetListChange();

    const s = written().chart.spec;
    expect(layerData(s, 1).sheetId, "the deleted sheet's gone pin was given to the S3 layer").toBeUndefined();
    expect(layerData(s, 1).sheetIndex, "the S3 layer's own remap").toBe(2);
    expect(layerData(s, 0).sheetId, "the S1 layer's own gone pin").toBe(GONE);
  });

  it("EDITING a layer's rows and APPENDING another in one pending save: the rows are the user's, the sheet the backend's", async () => {
    await storeAndLoad(spec({ layers: [line(r(3))] }));
    updateChartSpec("c1", { layers: [line(r(3, { endRow: 9 })), note] });
    stored = [backendDeletesSheet1(stored[0])];

    await reloadChartsAfterSheetListChange();

    const s = written().chart.spec;
    expect(layerData(s, 0).endRow, "the user's edit was lost").toBe(9);
    expect(layerData(s, 0).sheetIndex, "the edited layer's stale index was written over the remap").toBe(2);
    expect(s.layers![1]).toEqual(note);
  });

  it("REMOVING one layer and EDITING the other's rows: the edited layer is merged with ITSELF, not with the one removed", async () => {
    // Merged by position, the S3 layer would be read against the removed S1
    // layer and take ITS gone pin -- a live range that would chart nothing.
    await storeAndLoad(spec({ layers: [line(r(1)), line(r(3))] }));
    updateChartSpec("c1", { layers: [line(r(3, { endRow: 9 }))] });
    stored = [backendDeletesSheet1(stored[0])];

    await reloadChartsAfterSheetListChange();

    const s = written().chart.spec;
    expect(s.layers).toHaveLength(1);
    expect(layerData(s, 0).sheetId, "the removed layer's gone pin was given to the edited S3 layer").toBeUndefined();
    expect(layerData(s, 0).endRow).toBe(9);
    expect(layerData(s, 0).sheetIndex, "the edited S3 layer's own remap").toBe(2);
  });

  it("an UNCHANGED layer is merged with ITSELF even beside a layer holding all its values and more", async () => {
    // The first layer is the same range STAMPED with its sheet id (the backend
    // leaves it alone); it shares every value the index-only layer has, and
    // sits at the position the index-only layer moves to.
    await storeAndLoad(spec({ layers: [line(r(3, { sheetId: "id-S3" })), line(r(3))] }));
    updateChartSpec("c1", { layers: [layersNow()[1]] });
    stored = [backendDeletesSheet1(stored[0])];

    await reloadChartsAfterSheetListChange();

    const s = written().chart.spec;
    expect(s.layers).toHaveLength(1);
    expect(layerData(s, 0).sheetIndex, "the index-only layer was read against the stamped one and kept its stale index").toBe(2);
  });

  it("REPLACING a layer with one that shares nothing with it: the new layer never takes the old one's gone pin", async () => {
    await storeAndLoad(spec({ layers: [line(r(1))] }));
    const replacement: LayerSpec = { mark: "area", data: { sheetIndex: 3, startRow: 5, startCol: 5, endRow: 9, endCol: 9 } };
    updateChartSpec("c1", { layers: [replacement] });
    stored = [backendDeletesSheet1(stored[0])];

    await reloadChartsAfterSheetListChange();

    const s = written().chart.spec;
    expect(layerData(s, 0).sheetId, "the replaced layer's gone pin was given to the new layer").toBeUndefined();
    expect(s.layers![0].mark).toBe("area");
  });

  it("a list too long to compare pair by pair still takes the remap of every element left IN PLACE", async () => {
    // 70 layers + 1 appended: past MAX_REWRITE_MATCH_PAIRS (4096 pairs).
    const many = Array.from({ length: 70 }, (_, i) => line(r(3, { endRow: 3 + i })));
    await storeAndLoad(spec({ layers: many }));
    updateChartSpec("c1", { layers: [...layersNow(), note] });
    stored = [backendDeletesSheet1(stored[0])];

    await reloadChartsAfterSheetListChange();

    const s = written().chart.spec;
    expect(s.layers).toHaveLength(71);
    expect(layerData(s, 0).sheetIndex, "the long list's untouched layers kept their stale index").toBe(2);
    expect(layerData(s, 69).sheetIndex).toBe(2);
    expect(layerData(s, 69).endRow).toBe(72);
  });
});

describe("control: with no pending save nothing is written", () => {
  it("the reload alone writes nothing", async () => {
    stored = [backendDeletesSheet1(stored[0])];
    await reloadChartsAfterSheetListChange();
    expect(invokeBackend.mock.calls.filter((c) => c[0] === "update_chart")).toHaveLength(0);
    expect((getChartById("c1")!.spec.data as DataRangeRef).sheetIndex).toBe(1);
  });
});
