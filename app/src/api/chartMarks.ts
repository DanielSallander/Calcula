//! FILENAME: app/src/api/chartMarks.ts
// PURPOSE: IoC registry for chart marks (chart types), so extensions can add a
//          chart type without the kernel/Charts depending on them.
// CONTEXT: The API layer cannot import from extensions (Alien Rule). Chart marks
//          need Charts-internal render types (ChartLayout/HitGeometry/...), which
//          live in the Charts extension — so the public contract types those
//          heavy params as `unknown`. The Charts extension provides a thin typed
//          wrapper (rendering/markRegistry.ts) that casts at the boundary and
//          keeps full internal type safety. Built-in marks register through the
//          same path a third party would (dogfooding).

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * Pure geometry of a laid-out chart, exposed so a custom mark can position
 * itself. A structural subset of the Charts-internal ChartLayout — cast the
 * opaque `layout` param to this in a custom mark's paint/geometry callbacks.
 */
export interface ChartMarkLayout {
  width: number;
  height: number;
  margin: { top: number; right: number; bottom: number; left: number };
  plotArea: { x: number; y: number; width: number; height: number };
}

/** Descriptive metadata for a chart mark (drives UI + axis classification). */
export interface ChartMarkMeta {
  /** Human-readable name shown in the chart-type picker. */
  label: string;
  /** Axis family: "cartesian" gets X/Y axes; "radial"/"other" do not. */
  layoutFamily: "cartesian" | "radial" | "other";
  /** True for the built-in marks (lets the UI group built-in vs custom). */
  builtin?: boolean;
  /**
   * True for a SANDBOXED mark (B8.D): its `paint` is a host-side shim that blits
   * a worker-rendered ImageBitmap into the plot area rather than drawing
   * synchronously. The mark code runs in a Worker realm with no main-thread
   * canvas/DOM access. Built-in + in-process custom marks leave this unset.
   */
  sandboxed?: boolean;
}

/**
 * A chart mark: how to paint it, lay it out, and hit-test it. The data/spec/
 * layout/theme params are opaque (`unknown`) at the API boundary; the Charts
 * renderer supplies the real types via its typed wrapper. Custom marks may cast
 * `layout` to {@link ChartMarkLayout} to find the plot rectangle.
 */
export interface ChartMarkDefinition {
  meta: ChartMarkMeta;
  paint(ctx: Ctx, data: unknown, spec: unknown, layout: unknown, theme: unknown): void;
  computeLayout(width: number, height: number, spec: unknown, data: unknown, theme: unknown): unknown;
  computeGeometry(data: unknown, spec: unknown, layout: unknown, theme: unknown): unknown;
}

// ============================================================================
// Registry
// ============================================================================

const registry = new Map<string, ChartMarkDefinition>();

/** Register (or override) a chart mark by id. Built-ins and extensions use this. */
export function registerChartMark(mark: string, def: ChartMarkDefinition): void {
  registry.set(mark, def);
}

/** Look up a registered mark's definition, or undefined. */
export function getChartMark(mark: string): ChartMarkDefinition | undefined {
  return registry.get(mark);
}

/** Look up a registered mark's metadata, or undefined. */
export function getChartMarkMeta(mark: string): ChartMarkMeta | undefined {
  return registry.get(mark)?.meta;
}

/** Whether a mark id has a registered definition. */
export function isChartMarkRegistered(mark: string): boolean {
  return registry.has(mark);
}

/** All registered mark ids, in registration order. */
export function listChartMarks(): string[] {
  return [...registry.keys()];
}
