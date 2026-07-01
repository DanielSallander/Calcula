//! FILENAME: app/src/api/chartParams.ts
// PURPOSE: Feature-neutral facade for programmatically driving a chart's params.
// CONTEXT: Charts own the param/widget system (the ephemeral "live value" that
//   overrides a param's cell/literal default, plus the spec.params declarations).
//   A consumer (e.g. the Animation chart-param driver) needs to enumerate charts +
//   params and sweep a param's value each frame WITHOUT importing Charts internals.
//   The Charts extension provides the implementation via registerChartParamController
//   (IoC); this facade imports NO extension (No First-Class Citizens / A2).

export type ChartParamValue = number | string | boolean;

export interface ChartParamBinding {
  input: "stepper" | "cycle" | "segment";
  options?: (string | number)[];
  min?: number;
  max?: number;
  step?: number;
}

export interface AnimatableChart {
  chartId: string;
  name: string;
  sheetIndex: number;
}

export interface ChartParameter {
  name: string;
  bind?: ChartParamBinding;
}

/** The chart-param control surface, implemented by the Charts extension. */
export interface ChartParamController {
  /** Charts that declare at least one bindable (stepper/cycle/segment) param. */
  listAnimatableCharts(sheetIndex?: number): AnimatableChart[];
  /** A chart's declared params (with their bind config), or [] if not found. */
  listParams(chartId: string): ChartParameter[];
  /** The current live (widget) value for a param, or undefined if unset. */
  getParamValue(chartId: string, paramName: string): ChartParamValue | undefined;
  /** Set the live value for a param and trigger a chart re-render. */
  setParamValue(chartId: string, paramName: string, value: ChartParamValue): void;
  /** Clear the live value for a param (revert to its cell/literal default) and re-render. */
  clearParamValue(chartId: string, paramName: string): void;
}

let registered: ChartParamController | null = null;

/**
 * Provide the chart-param implementation. Called once by the Charts extension in
 * activate(), and with `null` on deactivate. Inverts the dependency so this facade
 * never imports the Charts extension.
 */
export function registerChartParamController(impl: ChartParamController | null): void {
  registered = impl;
}

export function getChartParamController(): ChartParamController | null {
  return registered;
}

/** Charts with bindable params (empty if Charts is unavailable). */
export function listAnimatableCharts(sheetIndex?: number): AnimatableChart[] {
  return registered ? registered.listAnimatableCharts(sheetIndex) : [];
}

/** A chart's params (empty if Charts is unavailable / chart not found). */
export function listChartParams(chartId: string): ChartParameter[] {
  return registered ? registered.listParams(chartId) : [];
}

/** The current live value for a param (undefined if unset / unavailable). */
export function getChartParamValue(chartId: string, paramName: string): ChartParamValue | undefined {
  return registered ? registered.getParamValue(chartId, paramName) : undefined;
}

/** Set a param's live value + re-render (no-op if Charts unavailable). */
export function setChartParamValue(chartId: string, paramName: string, value: ChartParamValue): void {
  registered?.setParamValue(chartId, paramName, value);
}

/** Clear a param's live value + re-render (no-op if Charts unavailable). */
export function clearChartParamValue(chartId: string, paramName: string): void {
  registered?.clearParamValue(chartId, paramName);
}
