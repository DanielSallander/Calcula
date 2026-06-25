//! FILENAME: app/extensions/Charts/rendering/markRegistry.ts
// PURPOSE: Charts-side typed wrapper over the public @api chart-mark registry.
// CONTEXT: The public registry (@api/chartMarks) types render params as `unknown`
//          to stay decoupled from the Charts extension. This wrapper re-exposes
//          register/get with the real Charts render types and casts at the
//          boundary, so the internal dispatch keeps full type safety while
//          third-party extensions register through @api with the opaque contract.

import type { ChartSpec, ChartLayout, ParsedChartData, HitGeometry } from "../types";
import type { ChartRenderTheme } from "./chartTheme";
import {
  registerChartMark as apiRegisterChartMark,
  getChartMark as apiGetChartMark,
  isChartMarkRegistered as apiIsChartMarkRegistered,
  listChartMarks as apiListChartMarks,
  type ChartMarkDefinition as ApiChartMarkDefinition,
  type ChartMarkMeta,
} from "@api/chartMarks";

export type { ChartMarkMeta } from "@api/chartMarks";

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** A chart mark with the real Charts render types (the typed view of the @api contract). */
export interface ChartMarkDefinition {
  meta: ChartMarkMeta;
  paint(ctx: Ctx, data: ParsedChartData, spec: ChartSpec, layout: ChartLayout, theme: ChartRenderTheme): void;
  computeLayout(width: number, height: number, spec: ChartSpec, data: ParsedChartData, theme: ChartRenderTheme): ChartLayout;
  computeGeometry(data: ParsedChartData, spec: ChartSpec, layout: ChartLayout, theme: ChartRenderTheme): HitGeometry;
}

/** Register (or override) a chart mark. Built-ins call this; extensions use @api directly. */
export function registerChartMark(mark: string, def: ChartMarkDefinition): void {
  apiRegisterChartMark(mark, def as unknown as ApiChartMarkDefinition);
}

/** Look up a registered mark with Charts render types, or undefined. */
export function getChartMark(mark: string): ChartMarkDefinition | undefined {
  return apiGetChartMark(mark) as unknown as ChartMarkDefinition | undefined;
}

/** Whether a mark id has a registered definition. */
export function isChartMarkRegistered(mark: string): boolean {
  return apiIsChartMarkRegistered(mark);
}

/** All registered mark ids, in registration order. */
export function listChartMarks(): string[] {
  return apiListChartMarks();
}
