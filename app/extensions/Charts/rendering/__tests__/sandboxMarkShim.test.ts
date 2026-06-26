//! FILENAME: app/extensions/Charts/rendering/__tests__/sandboxMarkShim.test.ts
// PURPOSE: B8.D + Feature 2 — the host-side shim that fronts a sandboxed (worker-
//          rendered) chart mark. It must: report meta.sandboxed; draw the FULL
//          host-owned chrome (background + axes/legend, or a radial frame) and
//          degrade to chrome-only on a bitmap MISS (no drawImage); on a HIT clip
//          to the plot rect and blit the worker bitmap there (never outside);
//          surface the worker's (host-sanitized, cached) per-datum hit geometry
//          OFFSET into chart space; and register into the chart-mark registry.

import { describe, it, expect, vi, beforeEach } from "vitest";

// The shim imports getChartMarkBitmap + getChartMarkGeometry from @api; a minimal
// mock keeps the test off the desktop host.
vi.mock("@api", () => ({ getChartMarkBitmap: vi.fn(), getChartMarkGeometry: vi.fn() }));
import { getChartMarkBitmap, getChartMarkGeometry } from "@api";

import { buildSandboxMarkDefinition, registerSandboxMark } from "../sandboxMarkShim";
import { getChartMark } from "../markRegistry";
import { resolveChartTheme } from "../chartTheme";
import { computeCartesianLayout } from "../chartPainterUtils";
import type { ChartSpec, ParsedChartData } from "../../types";

const theme = resolveChartTheme(undefined);
const spec = {
  mark: "sandbox:demo",
  data: "Sheet1!A1:B3",
  hasHeaders: true,
  seriesOrientation: "columns",
  categoryIndex: 0,
  series: [{ name: "S", sourceIndex: 1, color: null }],
  title: null,
  xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
  yAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
  legend: { visible: false, position: "bottom" },
  palette: "default",
} as unknown as ChartSpec;
const data: ParsedChartData = { categories: ["a", "b"], series: [{ name: "S", values: [1, 2], color: null }] };

/** A permissive spy 2D context — records the calls the shim + chrome make. Covers
 *  the full surface drawCartesianChrome/drawCartesianAxes touch so paint() runs. */
function spyCtx() {
  const grad = { addColorStop: vi.fn() };
  return {
    save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), closePath: vi.fn(),
    rect: vi.fn(), clip: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn(),
    moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), fill: vi.fn(),
    quadraticCurveTo: vi.fn(), setLineDash: vi.fn(), translate: vi.fn(), rotate: vi.fn(),
    fillText: vi.fn(), measureText: vi.fn((t: string) => ({ width: t.length * 6 })),
    createLinearGradient: vi.fn(() => grad), createRadialGradient: vi.fn(() => grad),
    fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", textAlign: "", textBaseline: "", globalAlpha: 1,
  };
}

function fakeBitmap() {
  return { width: 100, height: 80, close: vi.fn() } as unknown as ImageBitmap;
}

beforeEach(() => {
  vi.mocked(getChartMarkBitmap).mockReset();
  vi.mocked(getChartMarkGeometry).mockReset();
});

describe("buildSandboxMarkDefinition (B8.D shim + Feature 2 chrome/geometry)", () => {
  it("marks the definition sandboxed + non-builtin, preserving label/family", () => {
    const def = buildSandboxMarkDefinition("scriptX", "sandbox:demo", { label: "Demo", layoutFamily: "cartesian" });
    expect(def.meta.sandboxed).toBe(true);
    expect(def.meta.builtin).toBe(false);
    expect(def.meta.label).toBe("Demo");
    expect(def.meta.layoutFamily).toBe("cartesian");
  });

  it("degrades to empty hit geometry when the worker returned none", () => {
    vi.mocked(getChartMarkGeometry).mockReturnValue(undefined);
    const def = buildSandboxMarkDefinition("scriptX", "sandbox:demo", { label: "Demo", layoutFamily: "cartesian" });
    expect(def.computeGeometry(data, spec, computeCartesianLayout(400, 300, spec, data, theme), theme))
      .toEqual({ type: "bars", rects: [] });
  });

  it("offsets the worker's cached local-coord geometry into chart space", () => {
    const layout = computeCartesianLayout(400, 300, spec, data, theme);
    const pa = layout.plotArea;
    vi.mocked(getChartMarkGeometry).mockReturnValue({
      rects: [{ x: 10, y: 20, w: 30, h: 40, seriesIndex: 0, categoryIndex: 1, value: 7, seriesName: "S", categoryName: "b" }],
    });
    const def = buildSandboxMarkDefinition("scriptX", "sandbox:demo", { label: "Demo", layoutFamily: "cartesian" });
    const geo = def.computeGeometry(data, spec, layout, theme);
    expect(geo.type).toBe("bars");
    expect(geo).toMatchObject({
      rects: [{ x: 10 + pa.x, y: 20 + pa.y, width: 30, height: 40, seriesIndex: 0, categoryIndex: 1, value: 7, seriesName: "S", categoryName: "b" }],
    });
  });

  it("fills missing geometry labels from the data by index", () => {
    const layout = computeCartesianLayout(400, 300, spec, data, theme);
    vi.mocked(getChartMarkGeometry).mockReturnValue({ rects: [{ x: 0, y: 0, w: 5, h: 5, seriesIndex: 0, categoryIndex: 1 }] });
    const def = buildSandboxMarkDefinition("scriptX", "sandbox:demo", { label: "Demo", layoutFamily: "cartesian" });
    const geo = def.computeGeometry(data, spec, layout, theme);
    expect(geo).toMatchObject({ rects: [{ seriesName: "S", categoryName: "b", value: 0 }] });
  });

  it("computes a cartesian layout with a plot area", () => {
    const def = buildSandboxMarkDefinition("scriptX", "sandbox:demo", { label: "Demo", layoutFamily: "cartesian" });
    const layout = def.computeLayout(400, 300, spec, data, theme);
    expect(layout.plotArea.width).toBeGreaterThan(0);
    expect(layout.plotArea.height).toBeGreaterThan(0);
  });

  it("MISS: draws full chrome but does NOT blit (no bitmap yet)", () => {
    vi.mocked(getChartMarkBitmap).mockReturnValue(null);
    const def = buildSandboxMarkDefinition("scriptX", "sandbox:demo", { label: "Demo", layoutFamily: "cartesian" });
    const layout = def.computeLayout(400, 300, spec, data, theme);
    const ctx = spyCtx();
    def.paint(ctx as never, data, spec, layout, theme);
    expect(ctx.fillRect).toHaveBeenCalled(); // background + plot bg chrome
    expect(ctx.stroke).toHaveBeenCalled(); // axis lines drawn (full chrome)
    expect(ctx.drawImage).not.toHaveBeenCalled();
    expect(getChartMarkBitmap).toHaveBeenCalledTimes(1);
  });

  it("HIT: clips to the plot rect and blits the worker bitmap there", () => {
    const bmp = fakeBitmap();
    vi.mocked(getChartMarkBitmap).mockReturnValue(bmp);
    const def = buildSandboxMarkDefinition("scriptX", "sandbox:demo", { label: "Demo", layoutFamily: "cartesian" });
    const layout = def.computeLayout(400, 300, spec, data, theme);
    const pa = layout.plotArea;
    const ctx = spyCtx();
    def.paint(ctx as never, data, spec, layout, theme);
    expect(ctx.clip).toHaveBeenCalled(); // clipped before drawImage
    expect(ctx.drawImage).toHaveBeenCalledWith(bmp, pa.x, pa.y, pa.width, pa.height);
    // The clip rect is the plot rectangle (no overpaint of chrome/axes).
    expect(ctx.rect).toHaveBeenCalledWith(pa.x, pa.y, pa.width, pa.height);
  });

  it("passes the chart data/spec/layout/theme payload to the worker getter", () => {
    vi.mocked(getChartMarkBitmap).mockReturnValue(null);
    const def = buildSandboxMarkDefinition("scriptABC", "sandbox:demo", { label: "Demo", layoutFamily: "cartesian" });
    const layout = def.computeLayout(400, 300, spec, data, theme);
    def.paint(spyCtx() as never, data, spec, layout, theme);
    const call = vi.mocked(getChartMarkBitmap).mock.calls[0];
    expect(call[0]).toBe("scriptABC"); // instanceId = scriptId
    expect(typeof call[1]).toBe("string"); // composite key
    expect(call[1]).not.toContain("|"); // key must not collide with the in-flight delimiter
    expect(call[2]).toMatchObject({ spec, data }); // payload carries spec + data
  });

  it("paint() and computeGeometry() agree on the cache key (bitmap + geometry lookup)", () => {
    vi.mocked(getChartMarkBitmap).mockReturnValue(null);
    vi.mocked(getChartMarkGeometry).mockReturnValue(undefined);
    const def = buildSandboxMarkDefinition("scriptX", "sandbox:demo", { label: "Demo", layoutFamily: "cartesian" });
    const layout = def.computeLayout(400, 300, spec, data, theme);
    def.paint(spyCtx() as never, data, spec, layout, theme);
    def.computeGeometry(data, spec, layout, theme);
    expect(vi.mocked(getChartMarkBitmap).mock.calls[0][1]).toBe(vi.mocked(getChartMarkGeometry).mock.calls[0][0]);
  });

  it("RADIAL: uses a radial frame and exposes no per-datum geometry", () => {
    vi.mocked(getChartMarkBitmap).mockReturnValue(null);
    const def = buildSandboxMarkDefinition("scriptX", "sandbox:pie", { label: "Pie", layoutFamily: "radial" });
    const layout = def.computeLayout(400, 300, spec, data, theme);
    const ctx = spyCtx();
    def.paint(ctx as never, data, spec, layout, theme);
    expect(ctx.fillRect).toHaveBeenCalled(); // background chrome
    expect(def.computeGeometry(data, spec, layout, theme)).toEqual({ type: "bars", rects: [] });
    // Radial never consults the cartesian geometry cache.
    expect(getChartMarkGeometry).not.toHaveBeenCalled();
  });

  it("registerSandboxMark registers the shim under its mark id", () => {
    registerSandboxMark("scriptX", "sandbox:registered", { label: "Reg", layoutFamily: "cartesian" });
    const def = getChartMark("sandbox:registered");
    expect(def).toBeDefined();
    expect(def?.meta.sandboxed).toBe(true);
  });
});
