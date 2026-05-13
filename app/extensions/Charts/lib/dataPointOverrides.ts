//! FILENAME: app/extensions/Charts/lib/dataPointOverrides.ts
// PURPOSE: Utility functions for applying per-data-point visual overrides.
// CONTEXT: Used by chart painters to look up and apply DataPointOverride
//          settings for individual bars, slices, points, etc.

import type { DataPointOverride, ChartSpec } from "../types";

/**
 * Find a data point override for a specific series + category index.
 * Returns the override object if found, undefined otherwise.
 */
export function getDataPointOverride(
  spec: ChartSpec,
  seriesIndex: number,
  categoryIndex: number,
): DataPointOverride | undefined {
  if (!spec.dataPointOverrides || spec.dataPointOverrides.length === 0) {
    return undefined;
  }
  return spec.dataPointOverrides.find(
    (o) => o.seriesIndex === seriesIndex && o.categoryIndex === categoryIndex,
  );
}

/**
 * Apply a data point override's color to the resolved color.
 * Returns the override color if present, otherwise the original color.
 */
export function applyOverrideColor(
  originalColor: string,
  override: DataPointOverride | undefined,
): string {
  return override?.color ?? originalColor;
}

/**
 * Apply a data point override's opacity.
 * Returns the override opacity if present, otherwise the original opacity (or null).
 */
export function applyOverrideOpacity(
  originalOpacity: number | null,
  override: DataPointOverride | undefined,
): number | null {
  if (override?.opacity !== undefined) return override.opacity;
  return originalOpacity;
}

/**
 * Get the explode offset for a pie/donut slice.
 * Returns the pixel offset if the data point is exploded, 0 otherwise.
 */
export function getExplodeOffset(
  override: DataPointOverride | undefined,
): number {
  return override?.exploded ?? 0;
}

/**
 * Build a lookup map for fast per-point override access.
 * Key format: "seriesIndex,categoryIndex"
 */
export function buildOverrideMap(
  overrides: DataPointOverride[] | undefined,
): Map<string, DataPointOverride> {
  const map = new Map<string, DataPointOverride>();
  if (!overrides) return map;
  for (const o of overrides) {
    map.set(`${o.seriesIndex},${o.categoryIndex}`, o);
  }
  return map;
}

/**
 * Look up an override from a pre-built map.
 */
export function getOverrideFromMap(
  map: Map<string, DataPointOverride>,
  seriesIndex: number,
  categoryIndex: number,
): DataPointOverride | undefined {
  return map.get(`${seriesIndex},${categoryIndex}`);
}
