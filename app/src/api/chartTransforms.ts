//! FILENAME: app/src/api/chartTransforms.ts
// PURPOSE: IoC registry for custom CHART DATA TRANSFORMS, so an extension can add
//          a transform step (a ParsedChartData -> ParsedChartData function) to the
//          chart data pipeline without the kernel/Charts depending on it. Symmetric
//          to the chart-mark registry (chartMarks.ts) — the dogfooding extension
//          point for the transform pipeline.
// CONTEXT: The built-in transforms (filter/sort/aggregate/calculate/window/bin/
//          lookup/pivot) are dispatched by a hardcoded switch in the Charts
//          extension and are NOT in this registry; this registry is consulted only
//          for an UNKNOWN transform type (the switch's default). The data/spec
//          params are opaque (`unknown`) at the API boundary — the Charts pipeline
//          supplies the real ParsedChartData / transform-spec types and casts.

/** The eight built-in transform types — a custom transform may not shadow one
 *  (the Charts dispatch switch handles these BEFORE the registry, so a colliding
 *  registration would silently never run; we reject it loudly instead). */
const BUILTIN_TRANSFORM_TYPES: ReadonlySet<string> = new Set([
  "filter", "sort", "aggregate", "calculate", "window", "bin", "lookup", "pivot",
]);

/** Whether `type` is a built-in transform type (reserved). */
export function isBuiltinTransformType(type: string): boolean {
  return BUILTIN_TRANSFORM_TYPES.has(type);
}

/** Context handed to a custom transform's apply(). */
export interface ChartTransformContext {
  /** Resolved chart param values ([Name] -> value), if the chart declares params. */
  params?: ReadonlyMap<string, unknown>;
}

/**
 * A custom chart transform. `apply` is a PURE function returning NEW parsed chart
 * data (never mutating its input), exactly like the built-in transforms. `data`
 * and `spec` are opaque at the API boundary (the Charts pipeline passes the real
 * ParsedChartData and the transform-spec object — including the custom params the
 * author wrote in the spec).
 */
export interface ChartTransformDefinition {
  /** Optional metadata for tooling/docs (the type id is the registry key). */
  meta?: { description?: string };
  apply(data: unknown, spec: unknown, ctx: ChartTransformContext): unknown;
}

const registry = new Map<string, ChartTransformDefinition>();

/** Register (or override) a custom transform by its `type` id. REFUSES a built-in
 *  type id (which the pipeline dispatches before the registry). */
export function registerChartTransform(type: string, def: ChartTransformDefinition): void {
  if (isBuiltinTransformType(type)) {
    throw new Error(`Cannot register a custom transform with the built-in type "${type}".`);
  }
  registry.set(type, def);
}

/** Remove a registered custom transform (e.g. on extension deactivate). No-op for
 *  an unknown id; never removes a built-in (built-ins are not in the registry). */
export function unregisterChartTransform(type: string): void {
  registry.delete(type);
}

/** Look up a registered custom transform, or undefined. */
export function getChartTransform(type: string): ChartTransformDefinition | undefined {
  return registry.get(type);
}

/** Whether a custom transform type is registered. */
export function isChartTransformRegistered(type: string): boolean {
  return registry.has(type);
}

/** All registered custom transform type ids, in registration order. */
export function listChartTransforms(): string[] {
  return [...registry.keys()];
}
