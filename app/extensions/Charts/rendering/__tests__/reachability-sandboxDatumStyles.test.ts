//! FILENAME: app/extensions/Charts/rendering/__tests__/reachability-sandboxDatumStyles.test.ts
// PURPOSE: R-2 gap 2 (design doc chart-interaction.md §6.7). A SANDBOXED /
//          custom mark could not honour `spec.dataPointOverrides` at all: its
//          pixels arrive as an opaque worker ImageBitmap, so the host cannot
//          apply an override to them and cannot check that the mark did. The
//          answer taken is the reachable one — the host RESOLVES the overrides
//          and ships the answer in the paint payload as `datumStyles`, and a
//          mark DECLARES whether it honours them
//          (`meta.honoursDataPointOverrides`) so a per-point formatting UI has
//          something to ask before it accepts a setting.
// CONTEXT: This file drives the real shim and simulates the worker exactly the
//          way `scriptHost/worker/bootstrap.ts` does — it calls the mark body as
//          `body(ctx, target.item, bounds)` with a recording canvas — so the
//          assertion is "a custom mark that reads datumStyles actually paints
//          the override", end to end from the spec through the host resolver
//          into the mark's own canvas calls.
//
//          THE SECOND BODY IS THE ARGUMENT FOR THE FEATURE. `paint.spec` has
//          always reached the worker, so a mark COULD have read
//          `spec.dataPointOverrides` itself. `resolvesItsOwnOverrides` below is
//          that mark, written the obvious way — index by the loop counter — and
//          it puts the colour on the WRONG datum the moment a filter hides a
//          lower-index series, because the raw array is keyed in AUTHORING
//          space. That is the drift the shipped payload exists to prevent.

import { describe, it, expect, vi, beforeEach } from "vitest";

// The shim imports getChartMarkBitmap + getChartMarkGeometry from "@api". Only
// that specifier is mocked: "@api/chartMarks" is a different module and stays
// real, which is what lets the registry predicate be tested here too.
vi.mock("@api", () => ({ getChartMarkBitmap: vi.fn(), getChartMarkGeometry: vi.fn() }));
import { getChartMarkBitmap } from "@api";

import {
  registerChartMark as apiRegisterChartMark,
  unregisterChartMark,
  chartMarkHonoursDataPointOverrides,
  type ChartMarkPaintContext,
  type ChartMarkDatumStyle,
} from "@api/chartMarks";

import { buildSandboxMarkDefinition, registerSandboxMark } from "../sandboxMarkShim";
import { dataPointKey, resolvedDatumStylesForMark } from "../../lib/dataPointOverrides";
import { resolveChartTheme } from "../chartTheme";
import type { ChartSpec, ParsedChartData, DataPointOverride } from "../../types";
import { makeRecordingCtx } from "./dispatch-recordingCtx";
// Side-effect import: registering the built-in marks is chartDispatch's job, and
// the predicate's "every built-in honours them" arm needs one to exist.
import "../chartDispatch";

const THEME = resolveChartTheme(undefined);
const WIDTH = 480;
const HEIGHT = 320;
const OVERRIDE_COLOUR = "#FFCC00";
const MARK_ID = "sandbox:reachability";

const DATA: ParsedChartData = {
  categories: ["A", "B", "C", "D"],
  series: [
    { name: "S1", values: [10, 20, 30, 40], color: null },
    { name: "S2", values: [18, 26, 34, 42], color: null },
  ],
};

/** DATA with the lowest-index series hidden, carrying the painter -> authoring map. */
const FILTERED: ParsedChartData = {
  categories: DATA.categories,
  series: DATA.series.slice(1),
  keptSeriesIndices: [1],
};

function makeSpec(extra: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark: MARK_ID,
    data: { startRow: 0, startCol: 0, endRow: 4, endCol: 2, sheetIndex: 0 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [{ name: "S1", sourceIndex: 1, color: null }],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: false, position: "bottom" },
    palette: "default",
    ...extra,
  } as ChartSpec;
}

function override(seriesIndex: number, categoryIndex: number, extra: Partial<DataPointOverride> = {}): DataPointOverride {
  return { seriesIndex, categoryIndex, color: OVERRIDE_COLOUR, ...extra };
}

// ============================================================================
// The worker double
// ============================================================================

/** A mark body, with the signature bootstrap.ts calls a markRenderer with. */
type MarkBody = (
  ctx: CanvasRenderingContext2D,
  paint: ChartMarkPaintContext,
  bounds: { x: number; y: number; width: number; height: number },
) => void;

/**
 * Drive the REAL shim and run `body` where the worker would run, returning the
 * ctx call stream the body produced.
 *
 * `getChartMarkBitmap` returns null (a cache miss) so the shim paints only its
 * chrome — the host-side blit is not what is under test here. The payload it
 * was handed IS.
 */
function paintThroughWorker(body: MarkBody, spec: ChartSpec, data: ParsedChartData): string[] {
  let workerStream: string[] = [];
  vi.mocked(getChartMarkBitmap).mockImplementation((_id, _key, item, w, h) => {
    const rec = makeRecordingCtx(w, h);
    body(rec.ctx, item as ChartMarkPaintContext, { x: 0, y: 0, width: w, height: h });
    workerStream = rec.calls;
    return null;
  });
  const def = buildSandboxMarkDefinition("scriptR", MARK_ID, { label: "R", layoutFamily: "cartesian" });
  const layout = def.computeLayout(WIDTH, HEIGHT, spec, data, THEME);
  def.paint(makeRecordingCtx(WIDTH, HEIGHT).ctx, data, spec, layout, THEME);
  return workerStream;
}

/** The payload the shim handed the worker for this (spec, data). */
function capturePayload(spec: ChartSpec, data: ParsedChartData): ChartMarkPaintContext {
  let captured: ChartMarkPaintContext | null = null;
  vi.mocked(getChartMarkBitmap).mockImplementation((_id, _key, item) => {
    captured = item as ChartMarkPaintContext;
    return null;
  });
  const def = buildSandboxMarkDefinition("scriptR", MARK_ID, { label: "R", layoutFamily: "cartesian" });
  const layout = def.computeLayout(WIDTH, HEIGHT, spec, data, THEME);
  def.paint(makeRecordingCtx(WIDTH, HEIGHT).ctx, data, spec, layout, THEME);
  if (captured === null) throw new Error("the shim never asked the worker to paint");
  return captured;
}

/**
 * THE HONEST MARK. Paints one square per datum from its own palette, and takes
 * the fill from `datumStyles` where the host says an override reached.
 */
const honoursTheHostsAnswer: MarkBody = (ctx, paint, b) => {
  const data = paint.data as ParsedChartData;
  const byDatum = new Map<string, ChartMarkDatumStyle>();
  for (const d of paint.datumStyles) byDatum.set(`${d.seriesIndex},${d.categoryIndex}`, d);

  const cw = b.width / Math.max(1, data.categories.length);
  const sh = b.height / Math.max(1, data.series.length);
  for (let si = 0; si < data.series.length; si++) {
    for (let ci = 0; ci < data.categories.length; ci++) {
      const hit = byDatum.get(`${si},${ci}`);
      ctx.fillStyle = hit?.fill ?? "#336699";
      ctx.fillRect(ci * cw, si * sh, cw, sh);
    }
  }
};

/**
 * THE MARK THAT DOES IT ITSELF — the obvious wrong spelling. Reads
 * `spec.dataPointOverrides` and matches on its own loop counters, which is
 * AUTHORING space pretending to be painter space.
 */
const resolvesItsOwnOverrides: MarkBody = (ctx, paint, b) => {
  const data = paint.data as ParsedChartData;
  const overrides = (paint.spec as ChartSpec).dataPointOverrides ?? [];
  const cw = b.width / Math.max(1, data.categories.length);
  const sh = b.height / Math.max(1, data.series.length);
  for (let si = 0; si < data.series.length; si++) {
    for (let ci = 0; ci < data.categories.length; ci++) {
      const hit = overrides.find((o) => o.seriesIndex === si && o.categoryIndex === ci);
      ctx.fillStyle = hit?.color ?? "#336699";
      ctx.fillRect(ci * cw, si * sh, cw, sh);
    }
  }
};

/** Which datum (painter space) did the body paint in the override colour? */
function colouredDatums(stream: string[], cols: number, rows: number, w: number, h: number): string[] {
  const out: string[] = [];
  const cw = w / cols;
  const sh = h / rows;
  for (let i = 0; i < stream.length - 1; i++) {
    if (stream[i] !== `fillStyle=${OVERRIDE_COLOUR}`) continue;
    const m = /^fillRect\(([-0-9.]+),([-0-9.]+),/.exec(stream[i + 1]);
    if (!m) continue;
    out.push(`${Math.round(Number(m[2]) / sh)},${Math.round(Number(m[1]) / cw)}`);
  }
  return out;
}

beforeEach(() => {
  vi.mocked(getChartMarkBitmap).mockReset();
});

// ============================================================================
// 1. The payload
// ============================================================================

describe("the shim ships resolved per-datum styles to the worker", () => {
  it("carries spec, data, layout, theme AND datumStyles", () => {
    const payload = capturePayload(makeSpec(), DATA);
    expect(Object.keys(payload).sort()).toEqual(["data", "datumStyles", "layout", "spec", "theme"]);
  });

  it("is EMPTY on a chart with no overrides", () => {
    // Sparse on purpose: a chart with 200 series and 500 categories must not
    // clone 100,000 objects across the worker boundary on every repaint.
    expect(capturePayload(makeSpec(), DATA).datumStyles).toEqual([]);
  });

  it("lists exactly the datums an override reached", () => {
    const payload = capturePayload(makeSpec({ dataPointOverrides: [override(1, 2)] }), DATA);
    expect(payload.datumStyles).toHaveLength(1);
    expect(payload.datumStyles[0]).toMatchObject({
      seriesIndex: 1,
      categoryIndex: 2,
      fill: OVERRIDE_COLOUR,
      matchedBy: "index",
    });
  });

  it("reports a field the override is silent about as null, never as a guess", () => {
    // The host does not know a custom mark's palette. Inventing one would tell
    // the mark that every listed datum overrides everything.
    const d = capturePayload(makeSpec({ dataPointOverrides: [override(0, 0)] }), DATA).datumStyles[0];
    expect(d.opacity).toBeNull();
    expect(d.borderColor).toBeNull();
    expect(d.markerStyle).toBeNull();
    expect(d.gradientFill).toBeNull();
  });

  it("reports a colourless override as fill null, not as the empty string", () => {
    // "" would read as a real colour on the far side of the clone.
    const d = capturePayload(
      makeSpec({ dataPointOverrides: [{ seriesIndex: 0, categoryIndex: 0, opacity: 0.4 }] }),
      DATA,
    ).datumStyles[0];
    expect(d.fill).toBeNull();
    expect(d.opacity).toBe(0.4);
  });
});

// ============================================================================
// 2. The host resolver, directly
// ============================================================================

describe("resolvedDatumStylesForMark", () => {
  it("indexes in PAINTER space after a filter", () => {
    // Authoring series 1 survives the filter and is painted at painter index 0.
    const styles = resolvedDatumStylesForMark(makeSpec({ dataPointOverrides: [override(1, 2)] }), FILTERED);
    expect(styles).toHaveLength(1);
    expect(styles[0].seriesIndex).toBe(0);
    expect(styles[0].categoryIndex).toBe(2);
  });

  it("drops an override whose datum the filter hid", () => {
    expect(resolvedDatumStylesForMark(makeSpec({ dataPointOverrides: [override(0, 2)] }), FILTERED)).toEqual([]);
  });

  it("matches by identity KEY before index, and says which it used", () => {
    const styles = resolvedDatumStylesForMark(
      makeSpec({
        dataPointOverrides: [
          { seriesIndex: 9, categoryIndex: 9, key: dataPointKey("S2", "C"), color: OVERRIDE_COLOUR },
        ],
      }),
      DATA,
    );
    expect(styles).toHaveLength(1);
    expect(styles[0]).toMatchObject({ seriesIndex: 1, categoryIndex: 2, matchedBy: "key" });
  });

  it("carries the invert-if-negative decision rather than the raw flag", () => {
    const negative: ParsedChartData = {
      categories: ["A", "B"],
      series: [{ name: "S1", values: [-5, 5], color: null }],
    };
    const styles = resolvedDatumStylesForMark(
      makeSpec({ dataPointOverrides: [{ seriesIndex: 0, categoryIndex: 0, invertIfNegative: true }] }),
      negative,
    );
    expect(styles).toHaveLength(1);
    expect(styles[0].inverted).toBe(true);
    expect(styles[0].fill).not.toBeNull();
  });
});

// ============================================================================
// 3. A custom mark that USES it actually paints the override
// ============================================================================

describe("a custom mark that reads datumStyles paints the override", () => {
  it("colours the overridden datum and nothing else", () => {
    const base = paintThroughWorker(honoursTheHostsAnswer, makeSpec(), DATA);
    expect(base.some((c) => c.includes(OVERRIDE_COLOUR))).toBe(false);

    const over = paintThroughWorker(honoursTheHostsAnswer, makeSpec({ dataPointOverrides: [override(1, 2)] }), DATA);
    expect(over.some((c) => c.includes(OVERRIDE_COLOUR))).toBe(true);
    expect(colouredDatums(over, 4, 2, WIDTH, HEIGHT)).toEqual(["1,2"]);
  });

  it("follows the datum through a filter", () => {
    const over = paintThroughWorker(
      honoursTheHostsAnswer,
      makeSpec({ dataPointOverrides: [override(1, 2)] }),
      FILTERED,
    );
    // One painted series now, and the surviving one is the overridden one.
    expect(colouredDatums(over, 4, 1, WIDTH, HEIGHT)).toEqual(["0,2"]);
  });

  it("paints nothing extra for an override the filter hid", () => {
    const base = paintThroughWorker(honoursTheHostsAnswer, makeSpec(), FILTERED);
    const hidden = paintThroughWorker(
      honoursTheHostsAnswer,
      makeSpec({ dataPointOverrides: [override(0, 2)] }),
      FILTERED,
    );
    expect(hidden).toEqual(base);
  });
});

// ============================================================================
// 4. WHY the host resolves it: the obvious script-land spelling is wrong
// ============================================================================

describe("a mark that resolves spec.dataPointOverrides itself gets it wrong", () => {
  it("puts the colour on the WRONG datum once a filter hides a lower series", () => {
    const spec = makeSpec({ dataPointOverrides: [override(1, 2)] });

    // The host's answer: the surviving series, painter row 0.
    expect(colouredDatums(paintThroughWorker(honoursTheHostsAnswer, spec, FILTERED), 4, 1, WIDTH, HEIGHT))
      .toEqual(["0,2"]);

    // The mark's own answer: it is looking for painter row 1, which does not
    // exist in a one-series view, so the reader's colour simply disappears.
    expect(colouredDatums(paintThroughWorker(resolvesItsOwnOverrides, spec, FILTERED), 4, 1, WIDTH, HEIGHT))
      .toEqual([]);
  });

  it("paints a HIDDEN datum's colour onto its innocent neighbour", () => {
    // The sharper half. Authoring series 0 is filtered out, so nothing should
    // change — but the naive body matches its own loop counter 0 and recolours
    // the series that took the hidden one's place.
    const spec = makeSpec({ dataPointOverrides: [override(0, 2)] });
    expect(colouredDatums(paintThroughWorker(honoursTheHostsAnswer, spec, FILTERED), 4, 1, WIDTH, HEIGHT))
      .toEqual([]);
    expect(colouredDatums(paintThroughWorker(resolvesItsOwnOverrides, spec, FILTERED), 4, 1, WIDTH, HEIGHT))
      .toEqual(["0,2"]);
  });
});

// ============================================================================
// 5. The declaration a per-point formatting UI must ask about
// ============================================================================

describe("chartMarkHonoursDataPointOverrides", () => {
  it("is true for a built-in mark", () => {
    expect(chartMarkHonoursDataPointOverrides("bar")).toBe(true);
    expect(chartMarkHonoursDataPointOverrides("pie")).toBe(true);
  });

  it("is false for an id nothing registered", () => {
    // A mark that is not there cannot have promised anything.
    expect(chartMarkHonoursDataPointOverrides("sandbox:never-registered")).toBe(false);
  });

  it("is false for a custom mark that did not declare it", () => {
    const id = "test.silentCustomMark";
    apiRegisterChartMark(id, {
      meta: { label: "Silent", layoutFamily: "cartesian" },
      paint: () => {},
      computeLayout: (w: number, h: number) => ({ width: w, height: h, margin: { top: 0, right: 0, bottom: 0, left: 0 }, plotArea: { x: 0, y: 0, width: w, height: h } }),
      computeGeometry: () => ({ type: "bars", rects: [] }),
    });
    try {
      expect(chartMarkHonoursDataPointOverrides(id)).toBe(false);
    } finally {
      unregisterChartMark(id);
    }
  });

  it("is true for a custom mark that declared it", () => {
    const id = "test.honestCustomMark";
    apiRegisterChartMark(id, {
      meta: { label: "Honest", layoutFamily: "cartesian", honoursDataPointOverrides: true },
      paint: () => {},
      computeLayout: (w: number, h: number) => ({ width: w, height: h, margin: { top: 0, right: 0, bottom: 0, left: 0 }, plotArea: { x: 0, y: 0, width: w, height: h } }),
      computeGeometry: () => ({ type: "bars", rects: [] }),
    });
    try {
      expect(chartMarkHonoursDataPointOverrides(id)).toBe(true);
    } finally {
      unregisterChartMark(id);
    }
  });

  it("carries the declaration through registerSandboxMark onto the registry meta", () => {
    const declared = "sandbox:declares";
    const silent = "sandbox:silent";
    try {
      registerSandboxMark("scriptA", declared, { label: "D", layoutFamily: "cartesian", honoursDataPointOverrides: true });
      registerSandboxMark("scriptB", silent, { label: "S", layoutFamily: "cartesian" });
      expect(chartMarkHonoursDataPointOverrides(declared)).toBe(true);
      expect(chartMarkHonoursDataPointOverrides(silent)).toBe(false);
    } finally {
      unregisterChartMark(declared);
      unregisterChartMark(silent);
    }
  });
});
