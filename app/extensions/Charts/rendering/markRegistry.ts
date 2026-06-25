//! FILENAME: app/extensions/Charts/rendering/markRegistry.ts
// PURPOSE: Registry of chart marks (paint + layout + hit-geometry) so the mark
//          set is data-driven and extensible instead of hardcoded in switch
//          statements (closes the CLAUDE.md dogfooding gap). Built-in marks
//          register here exactly as a third-party would; the dispatch layer
//          looks them up. Adding a chart type becomes a single registration.

import type { ChartSpec, ChartLayout, ParsedChartData, HitGeometry } from "../types";
import type { ChartRenderTheme } from "./chartTheme";

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** The three things a chart mark must provide: how to paint, lay out, and hit-test. */
export interface ChartMarkDefinition {
  paint(ctx: Ctx, data: ParsedChartData, spec: ChartSpec, layout: ChartLayout, theme: ChartRenderTheme): void;
  computeLayout(width: number, height: number, spec: ChartSpec, data: ParsedChartData, theme: ChartRenderTheme): ChartLayout;
  computeGeometry(data: ParsedChartData, spec: ChartSpec, layout: ChartLayout, theme: ChartRenderTheme): HitGeometry;
}

const registry = new Map<string, ChartMarkDefinition>();

/** Register (or override) a chart mark. Built-ins call this; extensions may too. */
export function registerChartMark(mark: string, def: ChartMarkDefinition): void {
  registry.set(mark, def);
}

/** Look up a registered mark, or undefined if none. */
export function getChartMark(mark: string): ChartMarkDefinition | undefined {
  return registry.get(mark);
}

/** Whether a mark has a registered definition. */
export function isChartMarkRegistered(mark: string): boolean {
  return registry.has(mark);
}

/** All registered mark names (registration order). */
export function listChartMarks(): string[] {
  return [...registry.keys()];
}
