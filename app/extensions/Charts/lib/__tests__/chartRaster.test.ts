//! FILENAME: app/extensions/Charts/lib/__tests__/chartRaster.test.ts
// PURPOSE: D-IO-8 as a test: the export path paints NO transient cue, and the
//          snapshot path paints every visible one and the comments. Also the
//          pure layer builders behind "Keep in chart".

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChartDefinition, ChartSpec, ParsedChartData } from "../../types";

const h = vi.hoisted(() => ({
  getChartById: vi.fn(),
  readChartDataResolved: vi.fn(),
}));

vi.mock("../chartStore", () => ({ getChartById: h.getChartById, updateChartSpec: vi.fn() }));
vi.mock("../chartDataReader", () => ({ readChartDataResolved: h.readChartDataResolved }));

import { renderChartPng } from "../chartRaster";
import { layerForCue, layerForComment } from "../chartOverlayHost";
import { setChartCues, setChartComments, clearAllChartCues, setChartCueStep } from "@api/chartCues";

const data: ParsedChartData = {
  categories: ["Jan", "Feb", "Mar"],
  series: [{ name: "Sales", values: [100, 200, 300], color: null }],
};
const spec = {
  mark: "bar", data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 3, endCol: 1 }, hasHeaders: true,
  seriesOrientation: "columns", categoryIndex: 0, series: [], title: null,
  xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
  yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
  legend: { visible: false, position: "bottom" }, stacking: "none",
} as unknown as ChartSpec;
const chart: ChartDefinition = { chartId: "c1", name: "Chart 1", sheetIndex: 0, x: 0, y: 0, width: 600, height: 400, spec };

/** A recording OffscreenCanvas: every 2D call is logged by name. */
function installFakeOffscreen(): string[] {
  const calls: string[] = [];
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (_t, prop: string) => {
      if (prop === "measureText") return () => ({ width: 10 });
      if (prop === "getImageData") return () => ({ data: new Uint8ClampedArray(4) });
      return (..._a: unknown[]) => { calls.push(prop); };
    },
    set: () => true,
  });
  class FakeOffscreen {
    constructor(public width: number, public height: number) {}
    getContext() { return ctx; }
    convertToBlob() { return Promise.resolve(new Blob(["png"], { type: "image/png" })); }
  }
  (globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas = FakeOffscreen;
  return calls;
}

const savedOffscreen = (globalThis as unknown as { OffscreenCanvas?: unknown }).OffscreenCanvas;

beforeEach(() => {
  clearAllChartCues();
  h.getChartById.mockReturnValue(chart);
  h.readChartDataResolved.mockResolvedValue({ spec, data, unfilteredData: data, diagnostics: [], params: new Map() });
});

afterEach(() => {
  (globalThis as unknown as { OffscreenCanvas?: unknown }).OffscreenCanvas = savedOffscreen;
});

describe("renderChartPng", () => {
  it("export: paints the chart and NO cue, even while the chart carries an overlay", async () => {
    const calls = installFakeOffscreen();
    setChartCues("c1", [{ cueId: "f#0", factId: "f", kind: "ring", polarity: "bad", anchor: { type: "datum", series: "Sales", categoryIndex: 2, categoryLabel: "Mar" } }]);
    const blob = await renderChartPng("c1", { withOverlay: false });
    expect(blob.type).toBe("image/png");
    expect(calls).toContain("fillRect"); // the chart was painted
    expect(calls).not.toContain("ellipse"); // no ring
  });

  it("snapshot: paints the visible cues and the comments over the chart", async () => {
    const calls = installFakeOffscreen();
    setChartCues("c1", [
      { cueId: "f#0", factId: "f", kind: "ring", polarity: "bad", anchor: { type: "datum", series: "Sales", categoryIndex: 2, categoryLabel: "Mar" }, description: "Highest Sales" },
      { cueId: "g#0", factId: "g", kind: "ring", polarity: "good", anchor: { type: "datum", series: "Sales", categoryIndex: 0, categoryLabel: "Jan" }, description: "Lowest Sales" },
    ]);
    setChartComments("c1", [{ id: "k", cueId: "f#0", factId: "f", text: "Launch", anchor: { type: "datum", series: "Sales", categoryIndex: 2, categoryLabel: "Mar" } }]);
    await renderChartPng("c1", { withOverlay: true });
    // A bar's cue is a BOX, and the test above proves the chart itself strokes
    // no ellipse — so no ellipse here means the cue really is square.
    expect(calls).not.toContain("ellipse");
    expect(calls).toContain("fillText");
    // The comment box and the chart both draw paths, so the honest measure of
    // "one more cue" is the DELTA between one step and all of them.
    const oneStep = calls.filter((c) => c === "moveTo").length;

    calls.length = 0;
    setChartCueStep("c1", "all");
    await renderChartPng("c1", { withOverlay: true });
    expect(calls.filter((c) => c === "moveTo").length - oneStep).toBe(1);
    expect(calls).not.toContain("ellipse");
  });

  it("throws for a chart that does not exist", async () => {
    installFakeOffscreen();
    h.getChartById.mockReturnValue(undefined);
    await expect(renderChartPng("nope")).rejects.toThrow("not found");
  });
});

describe("keep in chart: the layers", () => {
  it("a datum ring becomes a marker layer anchored by series name and category index, coloured by polarity", () => {
    const layer = layerForCue({ cueId: "f#0", factId: "f", kind: "ring", polarity: "bad", anchor: { type: "datum", series: "Sales", categoryIndex: 2, categoryLabel: "Mar" }, description: "Highest Sales" });
    expect(layer).toEqual({ mark: "marker", markOptions: { series: "Sales", x: 2, shape: "ring", color: "#d93025", label: "Highest Sales" } });
    const emph = layerForCue({ cueId: "f#1", factId: "f", kind: "emphasis", polarity: "good", anchor: { type: "datum", series: "Sales", categoryIndex: 0, categoryLabel: "Jan" } });
    expect(emph?.markOptions).toMatchObject({ shape: "emphasis" });
  });

  it("a band, a rule or a whole-series emphasis cannot be kept as a marker", () => {
    expect(layerForCue({ cueId: "f#0", factId: "f", kind: "band", polarity: "attention", anchor: { type: "span", from: 1, to: 2 } })).toBeNull();
    expect(layerForCue({ cueId: "f#0", factId: "f", kind: "emphasis", polarity: "good", anchor: { type: "series", series: "Sales" } })).toBeNull();
  });

  it("a comment becomes a text layer at its datum's value; an unattached one cannot be kept", () => {
    const c = { id: "k", cueId: "f#0", factId: "f", text: "Launch", anchor: { type: "datum" as const, series: "Sales", categoryIndex: 2, categoryLabel: "Mar" } };
    expect(layerForComment(c, 300)).toEqual({ mark: "text", markOptions: { x: 2, y: 300, text: "Launch", anchor: "start", baseline: "bottom" } });
    expect(layerForComment({ ...c, anchor: null }, 300)).toBeNull();
    expect(layerForComment(c, null)).toBeNull();
  });
});
