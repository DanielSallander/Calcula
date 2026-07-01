//! FILENAME: app/extensions/Animation/drivers/chartParamDriver.ts
// PURPOSE: The "chart-param" driver — sweep a chart's param value over a sequence,
//          re-rendering the chart each frame. Pure frontend (no IPC, no recalc):
//          each frame sets the chart's live widget value via the @api/chartParams
//          IoC facade, which Charts repaints. Restores the prior value on stop.

import type { Driver } from "../lib/driver";
import type { ChartParamSpec, ChartParamSequence } from "../types";
import {
  getChartParamValue,
  setChartParamValue,
  clearChartParamValue,
  type ChartParamValue,
} from "@api/chartParams";

/** The ordered values a sequence visits (FP-noise rounded for ranges). */
export function buildSequence(seq: ChartParamSequence): ChartParamValue[] {
  if (seq.kind === "options") return seq.options.slice();
  const { from, to, step } = seq;
  if (!Number.isFinite(step) || step === 0) return [from];
  if (Math.sign(to - from) !== Math.sign(step) && to !== from) return [from]; // step points away from `to`
  const n = Math.floor(Math.abs(to - from) / Math.abs(step) + 1e-9) + 1;
  const out: ChartParamValue[] = [];
  for (let i = 0; i < n; i++) out.push(Math.round((from + i * step) * 1e9) / 1e9);
  return out;
}

export function createChartParamDriver(cfg: ChartParamSpec): Driver {
  const values = buildSequence(cfg.sequence);
  const at = (t: number): ChartParamValue | undefined =>
    values.length ? values[Math.max(0, Math.min(values.length - 1, t))] : undefined;
  let prior: ChartParamValue | undefined;
  let snapped = false;

  return {
    frameCount: Math.max(1, values.length),

    async snapshot(): Promise<void> {
      prior = getChartParamValue(cfg.chartId, cfg.paramName);
      snapped = true;
    },

    async applyFrame(t: number): Promise<void> {
      const v = at(t);
      if (v !== undefined) setChartParamValue(cfg.chartId, cfg.paramName, v);
    },

    async restore(): Promise<void> {
      if (!snapped) return;
      if (prior === undefined) clearChartParamValue(cfg.chartId, cfg.paramName);
      else setChartParamValue(cfg.chartId, cfg.paramName, prior);
    },

    frameLabel(t: number): string {
      const v = at(t);
      return v === undefined ? "" : String(v);
    },
  };
}
