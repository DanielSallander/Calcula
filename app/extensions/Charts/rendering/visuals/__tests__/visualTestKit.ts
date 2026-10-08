//! FILENAME: app/extensions/Charts/rendering/visuals/__tests__/visualTestKit.ts
// PURPOSE: The spec/data builders and the stream readers the four tile-visual
//          painter tests share, on the recording context (dispatch-recordingCtx)
//          so a test reads WHAT was painted — the text, its colour, its place —
//          rather than that some method was called.

import type { ChartSpec, ParsedChartData, ChartLayout, HitGeometry } from "../../../types";
import { DEFAULT_CHART_THEME } from "../../chartTheme";
import { makeRecordingCtx } from "../../__tests__/dispatch-recordingCtx";
import { getChartMark } from "../../markRegistry";
// Side-effect import: the built-in registrations.
import "../../chartDispatch";

export const THEME = DEFAULT_CHART_THEME;

export function visualSpec(mark: string, extra: Partial<ChartSpec> = {}): ChartSpec {
  return {
    mark,
    data: { startRow: 0, startCol: 0, endRow: 4, endCol: 2, sheetIndex: 0 },
    hasHeaders: true,
    seriesOrientation: "columns",
    categoryIndex: 0,
    series: [],
    title: null,
    xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    yAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
    legend: { visible: false, position: "bottom" },
    palette: "default",
    ...extra,
  } as ChartSpec;
}

export function seriesData(
  categories: string[],
  series: Array<{ name: string; values: number[]; color?: string | null }>,
  displayValues?: string[][],
): ParsedChartData {
  return {
    categories,
    series: series.map((s) => ({ name: s.name, values: s.values, color: s.color ?? null })),
    ...(displayValues ? { displayValues } : {}),
  };
}

export interface Painted {
  calls: string[];
  layout: ChartLayout;
  geometry: HitGeometry;
}

/** Lay out, paint and measure one mark through the REGISTRY (what dispatch does). */
export function paintVisual(mark: string, spec: ChartSpec, data: ParsedChartData, w = 600, h = 400): Painted {
  const def = getChartMark(mark);
  if (!def) throw new Error(`mark ${mark} is not registered`);
  const { ctx, calls } = makeRecordingCtx(w, h);
  const layout = def.computeLayout(w, h, spec, data, THEME);
  def.paint(ctx, data, spec, layout, THEME);
  const geometry = def.computeGeometry(data, spec, layout, THEME);
  return { calls, layout, geometry };
}

/** Every string painted with fillText, in order. */
export function textsOf(calls: string[]): string[] {
  const out: string[] = [];
  for (const c of calls) {
    const m = /^fillText\((.*),(-?[\d.]+),(-?[\d.]+)\)$/.exec(c);
    if (m) out.push(m[1]);
  }
  return out;
}

/** The fillText entry for `text`: its position and the fillStyle in force. */
export function textAt(calls: string[], text: string): { x: number; y: number; fill: string; font: string } | null {
  let fill = "";
  let font = "";
  for (const c of calls) {
    if (c.startsWith("fillStyle=")) fill = c.slice("fillStyle=".length);
    else if (c.startsWith("font=")) font = c.slice("font=".length);
    else {
      const m = /^fillText\((.*),(-?[\d.]+),(-?[\d.]+)\)$/.exec(c);
      if (m && m[1] === text) return { x: Number(m[2]), y: Number(m[3]), fill, font };
    }
  }
  return null;
}

/** The px size in a canvas font string ("600 32px Segoe UI" -> 32). */
export function fontPx(font: string): number {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  return m ? Number(m[1]) : NaN;
}
