//! FILENAME: app/extensions/Charts/lib/dataPointOverrides.ts
// PURPOSE: Utility functions for applying per-data-point visual overrides, and
//          the ONE shared resolver every painter uses to turn a painter-space
//          datum into its resolved fill / border / gradient / pattern / marker.
// CONTEXT: Used by chart painters to look up and apply DataPointOverride
//          settings for individual bars, slices, points, etc.

import type {
  DataPointOverride,
  ChartSpec,
  ParsedChartData,
  GradientFill,
  PatternFill,
  MarkerStyle,
} from "../types";
import { DATA_POINT_KEY_SEPARATOR, INVERTED_FILL_COLOR } from "../types";

/**
 * Translate a PAINTER-space (post-filter) series/category index pair to
 * AUTHORING-space (pre-filter / original) using the kept-index maps the data
 * reader threads onto ParsedChartData. dataPointOverrides are keyed in authoring
 * space, so the index lookup in {@link buildOverrideIndex} MUST be done in
 * authoring space; otherwise hiding a lower-index series/category aliases an
 * override onto the wrong datum. {@link resolveDatumStyle} calls this itself, so
 * a painter must NOT pre-translate. Absent maps mean identity (no filter ran).
 * Pure.
 */
export function toAuthoringIndices(
  data: Pick<ParsedChartData, "keptSeriesIndices" | "keptCategoryIndices">,
  seriesIndex: number,
  categoryIndex: number,
): { seriesIndex: number; categoryIndex: number } {
  return {
    seriesIndex: data.keptSeriesIndices ? (data.keptSeriesIndices[seriesIndex] ?? seriesIndex) : seriesIndex,
    categoryIndex: data.keptCategoryIndices ? (data.keptCategoryIndices[categoryIndex] ?? categoryIndex) : categoryIndex,
  };
}

// NOTE ON WHAT IS NOT HERE. This file used to also export
// `getDataPointOverride`, `applyOverrideColor`, `applyOverrideOpacity`,
// `buildOverrideMap` and `getOverrideFromMap`. Once every painter went through
// `resolveDatumStyle` they had no caller left anywhere in the repo except their
// own unit tests, and `buildOverrideMap`'s comment claimed a caller it did not
// have ("the design panel's authoring view" — ChartDesignSections uses
// `toAuthoringIndices`). They were INDEX-ONLY, so each one was a working,
// exported, documented route straight past the `key` matching and the
// authoring-space translation that exist to stop an override landing on the
// wrong datum. They are deleted rather than deprecated: this project carries no
// backward-compatibility obligation, and a dead helper that does the dangerous
// thing correctly is the one the next author copies.

/**
 * Get the explode offset for a pie/donut slice.
 * Returns the pixel offset if the data point is exploded, 0 otherwise.
 * Consumed by {@link resolveDatumStyle} (`explodeOffset`), which is what the
 * pie painter reads — it must not re-derive the offset inline.
 */
export function getExplodeOffset(
  override: DataPointOverride | undefined,
): number {
  return override?.exploded ?? 0;
}

// ============================================================================
// Datum identity keys
// ============================================================================

/**
 * The identity key for a datum: its resolved series name and category label.
 *
 * WHY: an index pair is not an identity. Insert a row into the plotted range
 * and every category index below it shifts by one, so an override written for
 * "March" silently reappears on "April". Excel ships both index-keyed and
 * datum-keyed behaviour and documents neither default as safe; Calcula already
 * solved the FILTER half of this ({@link toAuthoringIndices} maps painter space
 * to authoring space) but not the DATA half. The key closes it, and the index
 * stays as the fallback so specs written before the key existed keep working.
 */
export function dataPointKey(seriesName: string, categoryLabel: string): string {
  return `${seriesName}${DATA_POINT_KEY_SEPARATOR}${categoryLabel}`;
}

/**
 * The identity key of a PAINTER-space datum, or undefined when the indices fall
 * outside the parsed data (a radial chart painting more slices than categories,
 * a malformed spec).
 *
 * NOT THE ONE THE WRITE PATH WANTS. A key that names TWO datums (a duplicated
 * category label) is resolved onto the first of them, so stamping it on the
 * second makes that datum permanently unformattable — see
 * {@link unambiguousDataPointKeyForDatum}, which is what
 * `ChartFormatPane.datumWriteTarget` calls. This one answers the plain
 * question and is what the tests and the resolver's own scan use.
 */
export function dataPointKeyForDatum(
  data: ParsedChartData,
  painterSeriesIdx: number,
  painterCatIdx: number,
): string | undefined {
  const series = data.series[painterSeriesIdx];
  const category = data.categories[painterCatIdx];
  if (series === undefined || category === undefined) return undefined;
  return dataPointKey(series.name, category);
}

/**
 * The identity key of a PAINTER-space datum, but ONLY when that key names
 * exactly ONE datum in `data`. Otherwise `undefined`.
 *
 * WHY THE WRITER NEEDS THE STRICTER QUESTION. {@link buildOverrideIndex}
 * resolves a key to the FIRST datum carrying it in authoring order — a
 * documented tie-break for a key that has gone ambiguous since it was written.
 * But a category label that repeats is ordinary ("East, North, North, West"),
 * and a writer that stamps the key anyway CREATES the collision: the override
 * written for the second "North" is key-matched onto the first, so the bar the
 * reader clicked never changes and the duplicate-labelled datum cannot be
 * formatted AT ALL. An ambiguous datum therefore gets no key and falls to the
 * index stage, which addresses exactly the datum that was clicked.
 *
 * The pair (seriesName, categoryLabel) repeats iff the name repeats or the
 * label does, so this is O(series + categories) rather than O(series x
 * categories) — it is on the live preview path (every colour-swatch hover).
 */
export function unambiguousDataPointKeyForDatum(
  data: ParsedChartData,
  painterSeriesIdx: number,
  painterCatIdx: number,
): string | undefined {
  const key = dataPointKeyForDatum(data, painterSeriesIdx, painterCatIdx);
  if (key === undefined) return undefined;

  const name = data.series[painterSeriesIdx].name;
  const category = data.categories[painterCatIdx];
  let names = 0;
  for (const s of data.series) if (s.name === name) names++;
  let labels = 0;
  for (const c of data.categories) if (c === category) labels++;
  if (names * labels > 1) return undefined;

  return key;
}

// ============================================================================
// Resolution index (key first, index second)
// ============================================================================

/** How an override was matched to the datum it formats. */
export type DatumMatchKind = "key" | "index" | "none";

/** One resolved slot in an {@link OverrideIndex}. */
export interface IndexedMatch {
  override: DataPointOverride;
  matchedBy: "key" | "index";
}

/** Resolved authoring-datum -> override map for one (spec, data) pair. */
export interface OverrideIndex {
  /** Authoring-space "seriesIndex,categoryIndex" -> the override that wins there. */
  byDatum: Map<string, IndexedMatch>;
}

interface CachedIndex {
  index: OverrideIndex;
  /** Identity + length of the overrides array the index was built from. */
  overridesRef: DataPointOverride[] | undefined;
  overridesLength: number;
  /** Shape of the data the key scan walked. */
  seriesCount: number;
  categoryCount: number;
}

/**
 * Per-(spec, data) memo for the resolution index. Painters call
 * {@link resolveDatumStyle} once per datum, and the key scan is O(series x
 * categories) — without this the frame would be quadratic. WeakMap on both
 * levels so a replaced spec or dataset is collected with its index.
 *
 * The stamp guards the in-place cases: a spec whose `dataPointOverrides` array
 * is swapped, grown or shrunk, or a dataset whose shape changed, rebuilds.
 */
const INDEX_CACHE = new WeakMap<ChartSpec, WeakMap<ParsedChartData, CachedIndex>>();

/**
 * Build the authoring-datum -> override index for one (spec, data) pair.
 *
 * Two stages, in this order:
 *
 * 1. KEY. Every override carrying a `key` is matched against the datums that
 *    are actually being painted. When a category label is DUPLICATED (two rows
 *    both labelled "North"), one key names two datums — the TIE-BREAK is the
 *    FIRST match in AUTHORING order (smallest authoring seriesIndex, then
 *    smallest authoring categoryIndex). A key-matched override is CONSUMED: it
 *    no longer applies at its stale index pair, which is the whole point.
 * 2. INDEX. Every override the key stage did not consume — one with no `key`,
 *    or one whose key names a datum that no longer exists — falls back to its
 *    `seriesIndex`/`categoryIndex` pair.
 *
 * Within each stage the FIRST override in spec order wins a contested datum —
 * the `Array.find` semantics the index lookup has always had.
 *
 * Exported for testing; painters go through {@link resolveDatumStyle}.
 */
export function buildOverrideIndex(spec: ChartSpec, data: ParsedChartData): OverrideIndex {
  const byDatum = new Map<string, IndexedMatch>();
  const overrides = spec.dataPointOverrides;
  if (!overrides || overrides.length === 0) return { byDatum };

  const consumed = new Set<number>();
  const hasKeyed = overrides.some((o) => typeof o.key === "string" && o.key.length > 0);

  if (hasKeyed) {
    // Winning authoring position per key, over the datums actually painted.
    // Painter order and authoring order normally agree (filters preserve order),
    // but the tuple comparison does not assume it.
    const winners = new Map<string, { si: number; ci: number }>();
    for (let si = 0; si < data.series.length; si++) {
      const name = data.series[si].name;
      for (let ci = 0; ci < data.categories.length; ci++) {
        const k = dataPointKey(name, data.categories[ci]);
        const a = toAuthoringIndices(data, si, ci);
        const prev = winners.get(k);
        if (
          prev === undefined ||
          a.seriesIndex < prev.si ||
          (a.seriesIndex === prev.si && a.categoryIndex < prev.ci)
        ) {
          winners.set(k, { si: a.seriesIndex, ci: a.categoryIndex });
        }
      }
    }

    for (let i = 0; i < overrides.length; i++) {
      const o = overrides[i];
      if (typeof o.key !== "string" || o.key.length === 0) continue;
      const w = winners.get(o.key);
      // A key naming no painted datum is NOT consumed: it falls through to the
      // index stage, so a spec whose series was renamed degrades to the old
      // behaviour rather than losing the override entirely.
      if (w === undefined) continue;
      consumed.add(i);
      const slot = `${w.si},${w.ci}`;
      if (!byDatum.has(slot)) byDatum.set(slot, { override: o, matchedBy: "key" });
    }
  }

  for (let i = 0; i < overrides.length; i++) {
    if (consumed.has(i)) continue;
    const o = overrides[i];
    const slot = `${o.seriesIndex},${o.categoryIndex}`;
    if (!byDatum.has(slot)) byDatum.set(slot, { override: o, matchedBy: "index" });
  }

  return { byDatum };
}

function cachedOverrideIndex(spec: ChartSpec, data: ParsedChartData): OverrideIndex {
  let perData = INDEX_CACHE.get(spec);
  if (perData === undefined) {
    perData = new WeakMap<ParsedChartData, CachedIndex>();
    INDEX_CACHE.set(spec, perData);
  }
  const hit = perData.get(data);
  if (
    hit !== undefined &&
    hit.overridesRef === spec.dataPointOverrides &&
    hit.overridesLength === (spec.dataPointOverrides?.length ?? 0) &&
    hit.seriesCount === data.series.length &&
    hit.categoryCount === data.categories.length
  ) {
    return hit.index;
  }
  const index = buildOverrideIndex(spec, data);
  perData.set(data, {
    index,
    overridesRef: spec.dataPointOverrides,
    overridesLength: spec.dataPointOverrides?.length ?? 0,
    seriesCount: data.series.length,
    categoryCount: data.categories.length,
  });
  return index;
}

/**
 * The override that formats one PAINTER-space datum, matched by key first and
 * index second. Translates to authoring space internally — a caller must NOT
 * pre-translate.
 */
export function resolveDatumOverride(
  spec: ChartSpec,
  data: ParsedChartData,
  painterSeriesIdx: number,
  painterCatIdx: number,
): { override: DataPointOverride | undefined; matchedBy: DatumMatchKind } {
  if (!spec.dataPointOverrides || spec.dataPointOverrides.length === 0) {
    return { override: undefined, matchedBy: "none" };
  }
  const a = toAuthoringIndices(data, painterSeriesIdx, painterCatIdx);
  const hit = cachedOverrideIndex(spec, data).byDatum.get(`${a.seriesIndex},${a.categoryIndex}`);
  return hit === undefined
    ? { override: undefined, matchedBy: "none" }
    : { override: hit.override, matchedBy: hit.matchedBy };
}

// ============================================================================
// The ONE shared style resolver
// ============================================================================

/** The painter's own defaults for a datum, before any per-point override. */
export interface DatumStyleBase {
  /** Series/palette fill the painter would use. */
  fill?: string;
  /** Series opacity, or null for "fully opaque / painter default". */
  opacity?: number | null;
  borderColor?: string | null;
  borderWidth?: number | null;
  gradientFill?: GradientFill | null;
  patternFill?: PatternFill | null;
  markerStyle?: MarkerStyle | null;
  markerSize?: number | null;
  markerFill?: string | null;
  markerBorderColor?: string | null;
  markerBorderWidth?: number | null;
}

/** Fully resolved per-datum style. Every field is decided — no `undefined`. */
export interface ResolvedDatumStyle {
  fill: string;
  opacity: number | null;
  borderColor: string | null;
  borderWidth: number | null;
  gradientFill: GradientFill | null;
  patternFill: PatternFill | null;
  markerStyle: MarkerStyle | null;
  markerSize: number | null;
  /** Marker fill; falls back to the resolved `fill` when neither side sets one. */
  markerFill: string | null;
  markerBorderColor: string | null;
  markerBorderWidth: number | null;
  /** Pie/donut pull-out distance in pixels. 0 when not exploded. */
  explodeOffset: number;
  /** True when `invertIfNegative` fired: the value is negative and `fill` was replaced. */
  inverted: boolean;
  /** The override that won, for painters needing a field this shape does not carry. */
  override: DataPointOverride | undefined;
  /** How the override was matched — "none" when no override applies. */
  matchedBy: DatumMatchKind;
}

/**
 * Resolve the full visual style of ONE painter-space datum. This is the ONLY
 * sanctioned path from a painted datum to its per-point formatting.
 *
 * Painters MUST NOT hand-copy the pieces: a painter that skips
 * {@link toAuthoringIndices} aliases an override onto the wrong datum as soon
 * as a filter hides a lower-index series or category, and a painter that looks
 * up by index alone re-opens the row-insert defect the `key` exists to close.
 *
 * `painterSeriesIdx` / `painterCatIdx` are POST-filter indices — exactly the
 * loop counters a painter already has. Translation, key matching, the duplicate
 * label tie-break and the invert-if-negative rule all happen inside.
 */
export function resolveDatumStyle(
  spec: ChartSpec,
  data: ParsedChartData,
  painterSeriesIdx: number,
  painterCatIdx: number,
  base: DatumStyleBase = {},
): ResolvedDatumStyle {
  const { override, matchedBy } = resolveDatumOverride(spec, data, painterSeriesIdx, painterCatIdx);

  let fill = override?.color ?? base.fill ?? "";
  const value = data.series[painterSeriesIdx]?.values[painterCatIdx];
  const inverted =
    override?.invertIfNegative === true && typeof value === "number" && value < 0;
  if (inverted) fill = INVERTED_FILL_COLOR;

  const markerFill = override?.markerFill ?? base.markerFill ?? null;

  return {
    fill,
    opacity: override?.opacity ?? base.opacity ?? null,
    borderColor: override?.borderColor ?? base.borderColor ?? null,
    borderWidth: override?.borderWidth ?? base.borderWidth ?? null,
    // An inverted datum drops its gradient: a gradient would paint straight over
    // the inverted flat fill and the inversion would be invisible.
    gradientFill: inverted ? null : (override?.gradientFill ?? base.gradientFill ?? null),
    patternFill: override?.patternFill ?? base.patternFill ?? null,
    markerStyle: override?.markerStyle ?? base.markerStyle ?? null,
    markerSize: override?.markerSize ?? base.markerSize ?? null,
    markerFill: markerFill ?? (fill === "" ? null : fill),
    markerBorderColor: override?.markerBorderColor ?? base.markerBorderColor ?? null,
    markerBorderWidth: override?.markerBorderWidth ?? base.markerBorderWidth ?? null,
    explodeOffset: getExplodeOffset(override),
    inverted,
    override,
    matchedBy,
  };
}
