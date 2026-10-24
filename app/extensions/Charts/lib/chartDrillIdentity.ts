//! FILENAME: app/extensions/Charts/lib/chartDrillIdentity.ts
// PURPOSE: WHAT a right-clicked chart element IS to a drill-through
//          (docs/design/model-drillthrough.md 2.3): a member PATH to drill on,
//          a MEASURE-ONLY datum (a Card / KPI / Gauge, drilled with the page's
//          filters only), or NO identity (a transformed or composed chart, a
//          missing key) -- offered disabled with the reason, never run
//          unfiltered. Computed at the right-click RECORD site in index.ts from
//          the render cache and written into `ChartRightClickTarget`, so the
//          context menu reads one recorded answer instead of hit-testing again.
// CONTEXT: The path comes from `memberPathOfHit` (handlers/crossFilterClick.ts),
//          the ONE rule for "which members does this hit name" -- taken from the
//          HIT, not from the ladder's `pointIndex`, which is withheld on a first
//          right-click (that click selects the SERIES). Labels ride BESIDE the
//          keys for the menu row and the caption: a label is display text in
//          the app locale, two members can share one, and a two-field category
//          has ONE drawn label -- so a coordinate gets a label only when it is
//          the sole coordinate of its part (the category part or the series
//          part); keys identify, labels only show.
//
//          Pure: no store, no backend, no React.

import type { MemberPath } from "@api/reportFilters";
import type { ChartDrillIdentityKind, ChartRightClickTarget } from "@api/chartData";
import type { DrillFilterSpec } from "@api/drillThrough";
import { memberPathOfHit } from "../handlers/crossFilterClick";
import { isDatumHit } from "../rendering/chartHitTesting";
import { TRANSFORMED_SOURCE_REASON } from "./chartModelVisuals";
import { isCartesianChart, isDesignQueryDataSource, type ChartHitResult, type ChartSpec, type ParsedChartData } from "../types";
import { BLANK_MEMBER_LABEL } from "../../_shared/drillThrough/dslFilters";

/** Why a datum has no identity when the chart has never painted (no render cache). */
export const DRILL_NO_CACHE_REASON = "The chart has not been drawn yet, so this point names no model member";
/** Why a datum of a composed chart (concat / facet / repeat panels) has no identity. */
export const DRILL_COMPOSED_REASON = "A composed chart's points name no model member";
/** Why a datum has no identity when its data carries no member paths or its key is missing. */
export const DRILL_NO_MEMBER_REASON = "This point names no model member";
/** Why a lone measure's legend entry has no identity: no field narrows it. */
export const DRILL_MEASURE_LEGEND_REASON = "A measure's legend entry names no model member";

/** The recorded answer: the kind, the path (null unless `path`), and the labels parallel to it. */
export interface ChartDrillIdentity {
  kind: ChartDrillIdentityKind;
  path: MemberPath | null;
  /** Parallel to `path`; `null` where no label is known for that coordinate. Empty when `path` is null. */
  labels: ReadonlyArray<string | null>;
  /** Present only for `none`. */
  reason?: string;
}

/** Whether the chart is tiled from several independent reads (its datums belong to a panel, not the spec). */
function isComposed(spec: ChartSpec): boolean {
  return spec.concat !== undefined || spec.facet !== undefined || spec.repeat !== undefined;
}

/** Whether the parsed data is a measure-only result: ONE category with the EMPTY path. */
function isMeasureOnly(data: ParsedChartData): boolean {
  return (
    Array.isArray(data.categoryMembers) &&
    data.categoryMembers.length === 1 &&
    data.categoryMembers[0].length === 0
  );
}

/**
 * The category and series PARTS of the hit, by the same index rule
 * `memberPathOfHit` applies (a radial mark's slice and legend entry name the
 * CATEGORY; a cartesian legend entry names the series only). Returns null when
 * an index is missing -- the path itself has already said so.
 */
function hitParts(
  data: ParsedChartData,
  hit: ChartHitResult,
  radial: boolean,
): { category: MemberPath; series: MemberPath } | null {
  const categories = data.categoryMembers ?? [];
  const seriesPaths = data.seriesMembers ?? [];
  if (isDatumHit(hit)) {
    const ci = radial ? (hit.pointIndex ?? hit.seriesIndex) : hit.pointIndex;
    const si = radial ? 0 : hit.seriesIndex;
    if (ci === undefined || si === undefined) return null;
    return { category: categories[ci] ?? [], series: seriesPaths[si] ?? [] };
  }
  if (hit.element === "legendEntry") {
    const i = hit.seriesIndex;
    if (i === undefined) return null;
    if (radial) return { category: categories[i] ?? [], series: seriesPaths[0] ?? [] };
    return { category: [], series: seriesPaths[i] ?? [] };
  }
  return null;
}

/**
 * The labels parallel to `path`. A part made of ONE coordinate is labelled by
 * the hit's drawn text for that part (the category label for the category
 * part, the series name for the series part; a radial legend entry's drawn
 * text IS the category); a part of two or more coordinates has one drawn label
 * for several members and gets none. When the parts do not add up to the path
 * (they always do, by construction), nothing is labelled rather than guessed.
 */
function labelsFor(
  path: MemberPath,
  parts: { category: MemberPath; series: MemberPath } | null,
  hit: ChartHitResult,
  radial: boolean,
): ReadonlyArray<string | null> {
  if (!parts || parts.category.length + parts.series.length !== path.length) return path.map(() => null);
  const datum = isDatumHit(hit);
  const categoryLabel = datum ? hit.categoryName : radial ? hit.seriesName : undefined;
  const seriesLabel = datum || !radial ? hit.seriesName : undefined;
  const categoryLabels = parts.category.map(() => (parts.category.length === 1 ? categoryLabel ?? null : null));
  const seriesLabels = parts.series.map(() => (parts.series.length === 1 ? seriesLabel ?? null : null));
  return [...categoryLabels, ...seriesLabels];
}

/**
 * The drill identity of a right-click on `spec`'s chart, or null when the
 * question does not arise: the chart is not a design-query chart, or the hit
 * is not a datum / legend entry. `data` is the render cache's parsed data
 * (null when the chart has never painted).
 */
export function chartDrillIdentity(
  spec: ChartSpec | undefined,
  data: ParsedChartData | null | undefined,
  hit: ChartHitResult | null | undefined,
): ChartDrillIdentity | null {
  if (!spec || !isDesignQueryDataSource(spec.data)) return null;
  if (!hit || !(isDatumHit(hit) || hit.element === "legendEntry")) return null;

  const none = (reason: string): ChartDrillIdentity => ({ kind: "none", path: null, labels: [], reason });

  // The reasons a chart as a WHOLE has no identities, in the order a reader
  // would want to hear them: what the spec does to its data first.
  if (isComposed(spec)) return none(DRILL_COMPOSED_REASON);
  if (Array.isArray(spec.transform) && spec.transform.length > 0) return none(TRANSFORMED_SOURCE_REASON);
  if (!data) return none(DRILL_NO_CACHE_REASON);

  const mark = String(spec.mark ?? "");
  const radial = !isCartesianChart(mark);
  const path = memberPathOfHit(data, hit, mark);
  if (path) {
    return { kind: "path", path, labels: labelsFor(path, hitParts(data, hit, radial), hit, radial) };
  }
  if (isMeasureOnly(data)) return { kind: "measureOnly", path: null, labels: [] };
  if (hit.element === "legendEntry" && !isDatumHit(hit)) {
    const parts = hitParts(data, hit, radial);
    if (parts && parts.category.length === 0 && parts.series.length === 0) return none(DRILL_MEASURE_LEGEND_REASON);
  }
  return none(DRILL_NO_MEMBER_REASON);
}

/** The recorded identity as the fields `ChartRightClickTarget` carries. */
export function drillIdentityFields(
  identity: ChartDrillIdentity | null,
): Pick<ChartRightClickTarget, "memberPath" | "memberLabels" | "drillIdentity" | "drillIdentityReason"> {
  if (!identity) return {};
  return {
    memberPath: identity.path,
    memberLabels: identity.labels,
    drillIdentity: identity.kind,
    ...(identity.reason !== undefined ? { drillIdentityReason: identity.reason } : {}),
  };
}

/**
 * The clicked datum as the drill runner's KEY filters: one spec per coordinate
 * (`includedKeys: [key]`), its label beside it when one is known. The blank
 * member (key "") is labelled "(Blank)" whatever was drawn. Empty for a
 * measure-only datum or no path.
 */
export function drillSpecsOf(
  target: Pick<ChartRightClickTarget, "memberPath" | "memberLabels"> | null | undefined,
): DrillFilterSpec[] {
  const path = target?.memberPath;
  if (!path) return [];
  return path.map((coord, i) => {
    const label = coord.key === "" ? BLANK_MEMBER_LABEL : target?.memberLabels?.[i] ?? null;
    const spec: DrillFilterSpec = { field: coord.field, includedKeys: [coord.key] };
    if (label !== null && label !== "") spec.labels = [label];
    return spec;
  });
}

/**
 * The datum as the run row names it: "Mar, Cost" -- every coordinate's label
 * in path order (the blank member as "(Blank)"), or null when some coordinate
 * has no label (the caller falls back to the drawn subject) or there is no
 * path (a measure-only datum).
 */
export function drillSubjectText(
  target: Pick<ChartRightClickTarget, "memberPath" | "memberLabels"> | null | undefined,
): string | null {
  const path = target?.memberPath;
  if (!path || path.length === 0) return null;
  const labels = path.map((coord, i) => (coord.key === "" ? BLANK_MEMBER_LABEL : target?.memberLabels?.[i] ?? null));
  if (labels.some((l) => l === null || l === "")) return null;
  return labels.join(", ");
}
