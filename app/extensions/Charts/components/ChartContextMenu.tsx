//! FILENAME: app/extensions/Charts/components/ChartContextMenu.tsx
// PURPOSE: Context menu for right-clicking a chart, built on the ELEMENT under
//          the cursor rather than on whatever the last left click selected.
// CONTEXT: Shown for any right-click on a chart that is not an axis hit (axes
//          have their own AxisContextMenu). A chart right-click must show
//          object actions only — never the grid's cell context menu.
//
//          THE DEFECT THIS MENU WAS RESTRUCTURED FOR (open-items.md, "Right-
//          click does not move the chart's selection"): every item acted on the
//          LEFT-click selection, so right-clicking bar B while bar A was
//          selected formatted A. The fix is NOT a wider contribution contract —
//          that would change the subject of all six existing contributions —
//          but a recorded subject: the right-click handler writes what the
//          cursor was over to `setChartRightClickTarget` (@api/chartData) and
//          this menu reads it back with `getChartRightClickTarget(chartId)`,
//          which answers null for a target belonging to a different chart.
//
//          SINGULAR VS PLURAL IS LOAD-BEARING. It is how the reader learns
//          which rung of the ladder they are on: a point offers "Format Data
//          Point...", a series offers "Format Data Series..." plus the verbs
//          that only make sense for a whole series ("Add Data Labels", "Add
//          Trendline"). `ChartRightClickTarget.pointIndex` being ABSENT is
//          Excel's PointIndex = -1 and is the ONE thing that decides which.
//
//          SHAPE (Excel's, adapted where a verb would otherwise lie):
//            Delete Chart · Reset to Match Style · Change Chart Type... ·
//            Select Data...   — the shared block
//            <element verbs>
//            Edit Script... · <contributions>
//            Format <element>...   — ALWAYS last
//
//          THREE DELIBERATE DEVIATIONS FROM EXCEL, each because the honest
//          alternative was a menu item that lies:
//          1. Excel's shared first item is a bare "Delete" whose subject is the
//             selected element. Here it is always "Delete Chart". A destructive
//             verb whose subject changes rung by rung is the same ambiguity
//             this whole item exists to remove, and it is the one place where
//             getting it wrong destroys the reader's work. Element deletes are
//             element verbs with their subject in the label ("Delete Title",
//             "Delete Legend").
//          2. No "Add Data Label" (singular) on a point. Neither `DataLabelSpec`
//             nor `DataPointOverride` can express a label on ONE point —
//             `seriesFilter` is the finest grain there is — so the item would
//             either do nothing or silently label the whole series. It returns
//             with a per-point label in the spec, not before.
//          3. "Add Trendline" carries no ellipsis: an ellipsis is a promise of
//             a dialog, and there is no trendline dialog. The item adds a
//             linear trendline for that series outright, which is what Excel's
//             dialog defaults to anyway; the rest lives in the Design panel.

import React, { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { css } from "@emotion/css";
import type { OverlayProps } from "@api/uiTypes";
import { showDialog } from "@api";
import { CommandRegistry } from "@api/commands";
import { emitAppEvent, AppEvents } from "@api/events";
import {
  getChartContextMenuContributions,
  onChartContextMenuContributionsChange,
  type ChartContextMenuContribution,
} from "@api/chartContextMenu";
import {
  getChartRightClickTarget,
  type ChartRightClickTarget,
  type ChartTargetElement,
} from "@api/chartData";

import { getChartById, updateChartSpec, syncChartRegions } from "../lib/chartStore";
import { chartObjectClipboardRows } from "../lib/chartMenuSelection";
import { noteChartMenuMounted } from "../lib/chartMenuState";
import { getCachedChartData, invalidateChartCache } from "../rendering/chartRenderer";
// The ONE answer to "where do this chart's error-bar options live?" — a
// mark-dependent switch that the painter owns and this file must not re-spell.
import { getErrorBarOptions, withErrorBarOptions } from "../rendering/errorBarPainter";
import {
  selectionAfterHidingLegendEntry,
  setSubSelection,
} from "../handlers/selectionHandler";
// `markOffersPerPointFormatting` is the ONE rule behind both doors into
// per-point formatting — this menu's verb and the Format pane's sections. See
// `pointIsFormattable` below.
import { dataPointKey, markOffersPerPointFormatting } from "../lib/dataPointOverrides";
import { ChartEvents } from "../lib/chartEvents";
import { CHART_DIALOG_ID } from "../manifest";
import {
  CHART_FORMAT_SELECTION_COMMAND,
  DATA_POINT_KEY_SEPARATOR,
  isPivotDataSource,
} from "../types";
import type {
  ChartSpec,
  ChartSubSelection,
  DataPointOverride,
  ErrorBarOptions,
} from "../types";

// ============================================================================
// Contributed items (from @api/chartContextMenu)
// ============================================================================

/**
 * A STABLE snapshot of the contributed items.
 *
 * `getChartContextMenuContributions()` sorts into a fresh array on every call.
 * `useSyncExternalStore` compares snapshots with `Object.is`, so handing it that
 * getter directly means "changed" on every single render — React re-renders
 * forever and the menu never paints. This repo has been bitten by exactly that
 * before (see AIChat's `runningJobs` memoisation), so the array is built once
 * per actual change and the same reference is returned until the registry
 * notifies us.
 *
 * The cache is also invalidated on (re)subscribe: while no menu is open nothing
 * is listening, so a contributor that registered in the meantime would otherwise
 * be missing from the next menu.
 */
let cachedContributions: ChartContextMenuContribution[] = [];
let contributionsCacheValid = false;

function subscribeToContributions(onStoreChange: () => void): () => void {
  contributionsCacheValid = false;
  return onChartContextMenuContributionsChange(() => {
    contributionsCacheValid = false;
    onStoreChange();
  });
}

function contributionsSnapshot(): ChartContextMenuContribution[] {
  if (!contributionsCacheValid) {
    cachedContributions = getChartContextMenuContributions();
    contributionsCacheValid = true;
  }
  return cachedContributions;
}

/**
 * Items this chart should show. A contributor's `visible` predicate is foreign
 * code running inside our render, so a throw is treated as "not applicable"
 * rather than being allowed to take the whole menu — and with it Delete Chart —
 * down with it.
 */
function visibleFor(
  items: readonly ChartContextMenuContribution[],
  chartId: string,
): ChartContextMenuContribution[] {
  return items.filter((item) => {
    if (!item.visible) return true;
    try {
      return item.visible(chartId);
    } catch (err) {
      console.warn(`[Charts] Context-menu contribution "${item.id}" threw in visible():`, err);
      return false;
    }
  });
}

// ============================================================================
// The subject of the menu
// ============================================================================

/**
 * What this menu acts on: the right-clicked element, resolved once per open.
 *
 * `element` is never absent — a right-click with no recorded target is a
 * right-click on the object as a whole, which is what the menu did before this
 * restructure and is still the right answer for the chart frame.
 */
export interface MenuSubject {
  element: ChartTargetElement;
  /** Excel's name for the element, used in the header and the Format verb. */
  name: string;
  /** Which datum/series/entry, when the element names one. */
  identity: string | null;
  /** Painter-space series index (datum / legend entry). */
  seriesIndex?: number;
  /** Painter-space point index. ABSENT = the whole series. */
  pointIndex?: number;
  /**
   * Which of the series' trendlines was right-clicked — an index into
   * `spec.trendlines`. Set only for `element: "trendline"`, because one series
   * can carry a linear fit and a moving average and the series index alone
   * cannot tell "Delete Trendline" which one to remove.
   */
  trendlineIndex?: number;
  /** Authoring-space pair for `dataPointOverrides`, when the recorder supplied it. */
  authoring?: { seriesIndex: number; pointIndex: number };
  seriesName?: string;
  categoryName?: string;
  axisType?: "x" | "y";
}

/**
 * WHAT "DELETE THIS FURNITURE" MEANS, for the four in-plot elements.
 *
 * ONE RESOLVER, TWO DERIVATIONS — the shape {@link resetToMatchStyleScopePatch}
 * and {@link hideLegendEntryPatch} already established. The Delete KEY derives
 * its target from the selection ladder ({@link furnitureTargetFromSubSelection})
 * and this menu derives it from the RIGHT-CLICKED element
 * ({@link furnitureTargetFromSubject}); both ask this function for the patch,
 * because a second copy would drift the first time one of these fields learned
 * a new way to disappear.
 *
 * Indices are PAINTER space throughout — the space the hit test answers in, the
 * space `dataLabels.seriesFilter` is already documented in, and the space the
 * two new suppression fields are declared in. There is no authoring translation
 * here BECAUSE there is nothing to translate against: unlike
 * `dataPointOverrides`, none of these four is keyed by datum identity.
 */
export type FurnitureDeleteTarget =
  | { element: "trendline"; seriesIndex?: number; trendlineIndex?: number }
  | { element: "errorBars"; seriesIndex?: number }
  | { element: "dataLabel"; seriesIndex?: number; pointIndex?: number }
  | { element: "dataTable" };

/**
 * The spec patch that removes `target`, or null when there is nothing to remove.
 *
 * NULL IS NOT "NOT MINE". Every caller consumes the keystroke or hides the menu
 * row on its own terms; returning null only says the spec already looks the way
 * the reader is asking for. That distinction is the one this programme has paid
 * for twice — an already-cleared title and an already-hidden legend row both
 * answer "nothing changed", and a Delete listener that read that as "not mine"
 * let the second press destroy the chart.
 */
export function furnitureDeletePatch(
  spec: ChartSpec,
  target: FurnitureDeleteTarget,
): Partial<ChartSpec> | null {
  switch (target.element) {
    case "dataTable":
      return spec.dataTable?.enabled
        ? { dataTable: { ...spec.dataTable, enabled: false } }
        : null;

    case "trendline": {
      const all = spec.trendlines ?? [];
      if (all.length === 0) return null;
      // The ORDINAL first: one series can carry a linear fit and a moving
      // average at once, and removing "the one for series 2" would then remove
      // whichever happened to be written first. The series-only fallback is for
      // a target built before the ordinal travelled.
      const at =
        target.trendlineIndex !== undefined && target.trendlineIndex >= 0 && target.trendlineIndex < all.length
          ? target.trendlineIndex
          : all.findIndex((t) => (t.seriesIndex ?? 0) === (target.seriesIndex ?? 0));
      if (at < 0) return null;
      const kept = all.filter((_, i) => i !== at);
      return { trendlines: kept.length > 0 ? kept : undefined };
    }

    case "errorBars": {
      const si = target.seriesIndex;
      if (si === undefined) return null;
      const opts = getErrorBarOptions(spec);
      if (!opts || !opts.enabled) return null;
      const filter = opts.seriesFilter ?? null;
      if (filter !== null && !filter.includes(si)) return null; // already gone

      let next: ErrorBarOptions;
      if (filter !== null) {
        const kept = filter.filter((i) => i !== si);
        next = kept.length > 0
          ? { ...opts, enabled: true, seriesFilter: kept }
          : { ...opts, enabled: false, seriesFilter: null };
      } else {
        // No filter yet means "every series". Turning one off has to enumerate
        // the others, and a spec whose series are not enumerable (a pivot or
        // design-query chart, where `spec.series` is empty) cannot say "all of
        // them except this one" — the same null case `dataLabelRow` documents.
        // Falling back to `enabled: false` there would strip the error bars off
        // every series, which is the coarser act this field exists to avoid.
        const others = spec.series.map((_, i) => i).filter((i) => i !== si);
        if (spec.series.length === 0) return null;
        next = others.length > 0
          ? { ...opts, enabled: true, seriesFilter: others }
          : { ...opts, enabled: false, seriesFilter: null };
      }
      // The WRITE half of getErrorBarOptions, from the same module and gated on
      // the same mark list — never a hand-spread of `spec.markOptions`, which is
      // a nineteen-arm union and cannot legally grow an `errorBars` property.
      return withErrorBarOptions(spec, next);
    }

    case "dataLabel": {
      const si = target.seriesIndex;
      const pi = target.pointIndex;
      if (si === undefined || pi === undefined) return null;
      const dl = spec.dataLabels;
      if (!dl || !dl.enabled) return null;
      const hidden = dl.hiddenPoints ?? [];
      if (hidden.some((h) => h.seriesIndex === si && h.pointIndex === pi)) return null;
      return {
        dataLabels: { ...dl, hiddenPoints: [...hidden, { seriesIndex: si, pointIndex: pi }] },
      };
    }
  }
}

/**
 * The SELECTION ladder's rung, as a delete target. Returns null for a rung that
 * is not one of the four.
 */
export function furnitureTargetFromSubSelection(
  sub: ChartSubSelection,
): FurnitureDeleteTarget | null {
  if (sub.level !== "element") return null;
  switch (sub.elementId) {
    case "trendline":
      return { element: "trendline", seriesIndex: sub.seriesIndex, trendlineIndex: sub.trendlineIndex };
    case "errorBars":
      return { element: "errorBars", seriesIndex: sub.seriesIndex };
    case "dataLabel":
      // The ladder spells a data label's point as `categoryIndex` — the same
      // field a dataPoint rung uses, because it is the same index.
      return { element: "dataLabel", seriesIndex: sub.seriesIndex, pointIndex: sub.categoryIndex };
    case "dataTable":
      return { element: "dataTable" };
    default:
      return null;
  }
}

/** The RIGHT-CLICKED element, as a delete target. Null when it is not one of the four. */
export function furnitureTargetFromSubject(subject: MenuSubject): FurnitureDeleteTarget | null {
  switch (subject.element) {
    case "trendline":
      return {
        element: "trendline",
        seriesIndex: subject.seriesIndex,
        trendlineIndex: subject.trendlineIndex,
      };
    case "errorBars":
      return { element: "errorBars", seriesIndex: subject.seriesIndex };
    case "dataLabel":
      return { element: "dataLabel", seriesIndex: subject.seriesIndex, pointIndex: subject.pointIndex };
    case "dataTable":
      return { element: "dataTable" };
    default:
      return null;
  }
}

/** A datum target with no point index is the whole SERIES (Excel's PointIndex = -1). */
function isSeriesSubject(s: MenuSubject): boolean {
  return s.element === "datum" && s.pointIndex === undefined;
}

function isPointSubject(s: MenuSubject): boolean {
  return s.element === "datum" && s.pointIndex !== undefined;
}

/** Excel's name for each element. `datum` is decided by the point index. */
function elementName(element: ChartTargetElement, hasPoint: boolean): string {
  switch (element) {
    case "datum":
      return hasPoint ? "Data Point" : "Data Series";
    case "plotArea":
      return "Plot Area";
    case "title":
      return "Chart Title";
    case "xAxisTitle":
    case "yAxisTitle":
      return "Axis Title";
    case "xAxis":
      return "Horizontal (Category) Axis";
    case "yAxis":
      return "Vertical (Value) Axis";
    case "legend":
      return "Legend";
    case "legendEntry":
      return "Legend Entry";
    // The in-plot furniture, in Excel's own words. "Error Bars" is plural
    // because the object IS the whole set for a series — there is no per-point
    // error bar — while "Data Label" is singular because there is one per point.
    // The number is not decoration: it is how the reader learns what a Delete
    // here is about to take away.
    case "trendline":
      return "Trendline";
    case "errorBars":
      return "Error Bars";
    case "dataLabel":
      return "Data Label";
    case "dataTable":
      return "Data Table";
    // A filter button, the chart frame and a miss are all "the object" as far
    // as a menu verb is concerned.
    case "filterButton":
    case "chartArea":
    case "none":
    default:
      return "Chart Area";
  }
}

export function subjectFor(target: ChartRightClickTarget | null): MenuSubject {
  if (!target) {
    return { element: "chartArea", name: "Chart Area", identity: null };
  }
  const hasPoint = target.pointIndex !== undefined;
  const identity =
    target.element === "datum"
      ? hasPoint
        ? [target.seriesName, target.categoryName].filter(Boolean).join(" — ") || null
        : target.seriesName ?? null
      : target.element === "legendEntry"
        ? target.seriesName ?? null
        : null;

  return {
    element: target.element,
    name: elementName(target.element, hasPoint),
    identity,
    ...(target.seriesIndex !== undefined ? { seriesIndex: target.seriesIndex } : {}),
    ...(target.pointIndex !== undefined ? { pointIndex: target.pointIndex } : {}),
    ...(target.trendlineIndex !== undefined ? { trendlineIndex: target.trendlineIndex } : {}),
    ...(target.authoring ? { authoring: target.authoring } : {}),
    ...(target.seriesName !== undefined ? { seriesName: target.seriesName } : {}),
    ...(target.categoryName !== undefined ? { categoryName: target.categoryName } : {}),
    ...(target.axisType !== undefined ? { axisType: target.axisType } : {}),
  };
}

// ============================================================================
// "Reset to Match Style" — what the subject would actually drop
// ============================================================================

/**
 * WHAT a reset acts on, independent of how the reader asked for it.
 *
 * The context menu derives this from the RIGHT-CLICKED element; the Format pane
 * derives it from the CURRENT SELECTION (Excel's `ClearToMatchStyle`, whose
 * subject is whatever is selected). Two derivations, ONE resolver — a second
 * copy of "what does reset drop" would drift on the first new style field.
 *
 * Indices here are AUTHORING space, the space `dataPointOverrides` and
 * `spec.series` are addressed in; callers translate before they build a scope.
 */
export type ResetToMatchStyleScope =
  | {
      level: "dataPoint";
      seriesIndex?: number;
      categoryIndex?: number;
      /** `seriesName|categoryLabel`, when the datum has one. */
      key?: string | null;
    }
  | { level: "series"; seriesIndex?: number; seriesName?: string | null }
  | { level: "chart" };

/**
 * The spec patch that returns `scope` to the palette/theme, or null when there
 * is nothing manual on it.
 *
 * Returning null is what keeps the item OFF the menu and DISABLED in the pane:
 * an always-live "Reset to Match Style" that does nothing on most charts trains
 * the reader to ignore it.
 *
 * A point is matched by its identity KEY first (`seriesName|categoryLabel`,
 * stamped at write time) and only then by its index pair, for the same reason
 * `resolveDatumStyle` does: indices shift under a filter, the key does not.
 *
 * THREE PLACES HOLD A MANUAL FILL, and a reset that missed one would leave the
 * trap it exists to remove: `dataPointOverrides` (per datum), `seriesColors`
 * (name-keyed — since OB-1 the ONE spelling every formatting surface writes)
 * and `series[].color` (index-keyed, now written only by AUTHORING: XLSX
 * import, the chart examples, the Insert Chart dialog's Data tab). The third
 * is still cleared here precisely because nothing else clears it: an imported
 * colour a reader cannot get rid of is the same trap in a different field. At
 * chart level `config.theme` goes too — that is the "and every per-element
 * style back to the theme" half of Excel's "all formatting, including
 * overrides, is reset".
 */
export function resetToMatchStyleScopePatch(
  spec: ChartSpec,
  scope: ResetToMatchStyleScope,
): Partial<ChartSpec> | null {
  const overrides = spec.dataPointOverrides ?? [];
  const seriesColors = spec.seriesColors ?? {};
  const seriesList = spec.series ?? [];
  const patch: Partial<ChartSpec> = {};

  // ---- per-datum overrides -------------------------------------------------
  let keptOverrides: DataPointOverride[];
  if (scope.level === "dataPoint") {
    const key = scope.key ?? null;
    const si = scope.seriesIndex;
    const ci = scope.categoryIndex;
    keptOverrides = overrides.filter((o) => {
      if (key != null && o.key === key) return false;
      if (o.key == null && si != null && ci != null && o.seriesIndex === si && o.categoryIndex === ci) {
        return false;
      }
      return true;
    });
  } else if (scope.level === "series") {
    const si = scope.seriesIndex;
    const prefix =
      scope.seriesName != null ? `${scope.seriesName}${DATA_POINT_KEY_SEPARATOR}` : null;
    keptOverrides = overrides.filter((o) => {
      if (prefix != null && o.key != null) return !o.key.startsWith(prefix);
      return !(si != null && o.seriesIndex === si);
    });
  } else {
    keptOverrides = [];
  }
  if (keptOverrides.length !== overrides.length) {
    patch.dataPointOverrides = keptOverrides.length > 0 ? keptOverrides : undefined;
  }

  // ---- name-keyed series colours ------------------------------------------
  //
  // A RECORD IS NOT AN ARRAY. `deepMergeSpec` replaces arrays wholesale but
  // merges plain objects field by field, so `seriesColors` handed a SMALLER
  // record keeps every key that record left out — the colour would survive its
  // own removal. Dropped names are therefore written explicitly as `undefined`
  // (a key `deepMergeSpec` copies across and `JSON.stringify` then omits), and
  // only a reset that empties the record can replace the whole field.
  if (scope.level !== "dataPoint") {
    const keptColors: Record<string, string> = scope.level === "chart" ? {} : { ...seriesColors };
    if (scope.level === "series" && scope.seriesName != null) delete keptColors[scope.seriesName];
    const droppedNames = Object.keys(seriesColors).filter((name) => !(name in keptColors));
    if (droppedNames.length > 0) {
      if (Object.keys(keptColors).length === 0) {
        patch.seriesColors = undefined;
      } else {
        const next: Record<string, string | undefined> = { ...keptColors };
        for (const name of droppedNames) next[name] = undefined;
        patch.seriesColors = next as Record<string, string>;
      }
    }
  }

  // ---- index-keyed series colours (spec.series[i].color) -------------------
  if (scope.level !== "dataPoint") {
    const inScope = (entry: { name?: string }, i: number): boolean => {
      if (scope.level === "chart") return true;
      if (scope.seriesIndex != null) return i === scope.seriesIndex;
      return scope.seriesName != null && entry.name === scope.seriesName;
    };
    if (seriesList.some((entry, i) => inScope(entry, i) && entry.color != null)) {
      patch.series = seriesList.map((entry, i) =>
        inScope(entry, i) && entry.color != null ? { ...entry, color: null } : entry,
      );
    }
  }

  // ---- per-element theme overrides (chart level only) ----------------------
  if (scope.level === "chart") {
    const theme = spec.config?.theme;
    if (theme !== undefined && Object.keys(theme).length > 0) {
      // `deepMergeSpec` keeps an explicitly-undefined key, so this genuinely
      // removes the theme block rather than leaving it standing.
      patch.config = { ...(spec.config ?? {}), theme: undefined };
    }
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * The menu's adapter: the RIGHT-CLICKED element, as a reset scope.
 *
 * `authoring` is preferred over the painter pair for exactly the reason the
 * Format verb prefers it — `dataPointOverrides` is keyed in authoring space and
 * the hit test answers in painter space.
 */
export function resetScopeForSubject(subject: MenuSubject): ResetToMatchStyleScope {
  if (isPointSubject(subject)) {
    return {
      level: "dataPoint",
      seriesIndex: subject.authoring?.seriesIndex ?? subject.seriesIndex,
      categoryIndex: subject.authoring?.pointIndex ?? subject.pointIndex,
      key:
        subject.seriesName != null && subject.categoryName != null
          ? dataPointKey(subject.seriesName, subject.categoryName)
          : null,
    };
  }
  if (isSeriesSubject(subject)) {
    return {
      level: "series",
      seriesIndex: subject.authoring?.seriesIndex ?? subject.seriesIndex,
      seriesName: subject.seriesName ?? null,
    };
  }
  // Anything else is the chart as a whole.
  return { level: "chart" };
}

/** The patch for a right-clicked element. Kept as the menu's own entry point. */
export function resetToMatchStylePatch(
  spec: ChartSpec,
  subject: MenuSubject,
): Partial<ChartSpec> | null {
  return resetToMatchStyleScopePatch(spec, resetScopeForSubject(subject));
}

// ============================================================================
// Styles (matches AxisContextMenu)
// ============================================================================

const styles = {
  menu: css`
    position: fixed;
    z-index: 10000;
    background: #fff;
    border: 1px solid #ccc;
    border-radius: 4px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
    min-width: 180px;
    padding: 4px 0;
    font-size: 12px;
    font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
  `,
  item: css`
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 16px;
    cursor: pointer;
    white-space: nowrap;
    color: #333;

    &:hover {
      background: #e8f0fe;
    }
  `,
  divider: css`
    border-top: 1px solid #e8e8e8;
    margin: 4px 0;
  `,
  header: css`
    padding: 4px 16px 2px;
    font-size: 10px;
    font-weight: 600;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
  `,
  subject: css`
    padding: 0 16px 4px;
    font-size: 11px;
    color: #444;
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
};

// ============================================================================
// Component
// ============================================================================

/** One rendered row. `id` is the stable handle tests and E2E address it by. */
interface MenuRow {
  id: string;
  label: string;
  run: () => void;
}

export function ChartContextMenu({ onClose, data }: OverlayProps): React.ReactElement | null {
  const chartId = data?.chartId as string | undefined;
  const screenX = data?.screenX as number | undefined;
  const screenY = data?.screenY as number | undefined;

  const menuRef = useRef<HTMLDivElement>(null);

  const chart = chartId != null ? getChartById(chartId) : undefined;

  // Contributed items, re-read when a contributor activates or deactivates — an
  // extension can register AFTER this menu already exists.
  const contributions = useSyncExternalStore(subscribeToContributions, contributionsSnapshot);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    setTimeout(() => document.addEventListener("mousedown", handler, true), 50);
    return () => document.removeEventListener("mousedown", handler, true);
  }, [onClose]);

  // Close on Escape -- and CONSUME it: the Escape that closes the menu is the
  // menu's alone, so nothing behind it (the grid's own keyboard) hears it as
  // well. The canvas binding and Charts' element walk, which run EARLIER on
  // this path, stand down while the menu is open (lib/chartMenuState.ts).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [onClose]);

  // Open while mounted (lib/chartMenuState.ts).
  useEffect(() => noteChartMenuMounted(), []);

  // KEEP THE WHOLE MENU ON SCREEN, FROM ITS MEASURED BOX.
  //
  // The inline style below clamps from an ESTIMATE — `40 + rows * 26` — and an
  // estimate that comes up short puts the last row below the viewport, where it
  // is visible, enabled and unclickable. The row that falls off is always the
  // last one, which is always "Format <element>...", and over a data table (the
  // lowest object on a chart) it fell off at the default placement in a
  // 1280x800 window: Playwright reported "element is visible, enabled and
  // stable" and then "element is outside of the viewport" on every retry, for
  // thirty seconds.
  //
  // So the estimate only decides where the menu is FIRST laid out; the real
  // height then decides where it sits. `useLayoutEffect` runs before paint, so
  // the correction is never seen, and it runs after EVERY render because a
  // contribution can arrive (useSyncExternalStore) and change the row count.
  // The width is measured for the same reason — the 200px reserve was a guess
  // about the longest label in the menu.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el || screenX == null || screenY == null) return;
    const { width, height } = el.getBoundingClientRect();
    el.style.left = `${Math.max(0, Math.min(screenX, window.innerWidth - width))}px`;
    el.style.top = `${Math.max(0, Math.min(screenY, window.innerHeight - height))}px`;
  });

  if (!chart || chartId == null || screenX == null || screenY == null) return null;

  const spec = chart.spec;
  const chartLabel = spec?.title ?? chart.name ?? "Chart";

  // THE SUBJECT. Read here rather than in state: the record is written by the
  // right-click that opened this menu, so it is already final by first render,
  // and holding a copy in state would only add a way for the two to disagree.
  const subject = subjectFor(getChartRightClickTarget(chartId));

  /**
   * The spec-write choreography every mutating item shares — identical to
   * AxisContextMenu's. Dropping any step is a chart that does not repaint
   * (cache), a region that no longer matches its chart (regions) or a Design
   * panel showing stale sections (event).
   */
  const applySpec = (updates: Partial<ChartSpec>) => {
    updateChartSpec(chartId, updates);
    invalidateChartCache(chartId);
    syncChartRegions();
    window.dispatchEvent(new Event(ChartEvents.CHART_UPDATED));
    emitAppEvent(AppEvents.GRID_REFRESH);
  };

  const openChartDialog = (initialTab: "data" | "design") => {
    // `initialTab` is honoured by CreateChartDialog (`resolveInitialTab`), which
    // degrades a "data" request to Design in pivot mode because pivot mode
    // renders no Data tab at all.
    if (isPivotDataSource(spec.data)) {
      showDialog(CHART_DIALOG_ID, { pivotId: spec.data.pivotId, editChartId: chartId, initialTab });
    } else {
      showDialog(CHART_DIALOG_ID, { editChartId: chartId, initialTab });
    }
  };

  // --------------------------------------------------------------------------
  // The shared block
  // --------------------------------------------------------------------------

  const rows: MenuRow[] = [];

  // On a CANVAS: Duplicate / Copy / Paste of the WHOLE object selection, every
  // family (W25, @api/objectClipboard); none on a worksheet.
  rows.push(...chartObjectClipboardRows());

  rows.push({
    id: "deleteChart",
    label: "Delete Chart",
    // Routed through index.ts so deletion runs the exact same sequence as the
    // Delete key (deselect, store removal, cache, regions, events).
    run: () =>
      window.dispatchEvent(
        new CustomEvent(ChartEvents.CHART_DELETE_REQUEST, { detail: { chartId } }),
      ),
  });

  const resetPatch = resetToMatchStylePatch(spec, subject);
  if (resetPatch) {
    rows.push({
      id: "resetToMatchStyle",
      label: "Reset to Match Style",
      run: () => applySpec(resetPatch),
    });
  }

  rows.push({
    id: "changeChartType",
    label: "Change Chart Type...",
    run: () => openChartDialog("design"),
  });
  rows.push({
    id: "selectData",
    label: "Select Data...",
    run: () => openChartDialog("data"),
  });

  // --------------------------------------------------------------------------
  // Element verbs
  // --------------------------------------------------------------------------

  if (subject.element === "title" && spec.title != null) {
    rows.push({
      id: "deleteTitle",
      label: "Delete Title",
      run: () => applySpec({ title: null }),
    });
  }

  if (subject.element === "xAxisTitle" && spec.xAxis?.title != null) {
    rows.push({
      id: "deleteAxisTitle",
      label: "Delete Axis Title",
      run: () => applySpec({ xAxis: { ...spec.xAxis, title: null } }),
    });
  }
  if (subject.element === "yAxisTitle" && spec.yAxis?.title != null) {
    rows.push({
      id: "deleteAxisTitle",
      label: "Delete Axis Title",
      run: () => applySpec({ yAxis: { ...spec.yAxis, title: null } }),
    });
  }

  if (subject.element === "legendEntry" && spec.legend?.visible && subject.seriesIndex !== undefined) {
    // THE FINER ACT COMES FIRST. A reader who right-clicked ONE row means that
    // row; offering "Delete Legend" above it would put the coarser, harder-to-
    // undo verb under the pointer that the finer one is for.
    const si = subject.seriesIndex;
    const hidePatch = hideLegendEntryPatch(spec, si);
    if (hidePatch) {
      rows.push({
        id: "hideLegendEntry",
        label: "Hide Legend Entry",
        run: () => {
          // The rows AS MEASURED, read before the cache is invalidated: the
          // selection has to land on a row that exists, and after the write the
          // layout has not been recomputed yet.
          const entries =
            getCachedChartData(chartId)?.layout?.elements?.legendItems?.map((it) => it.seriesIndex) ??
            [];
          // Moved BEFORE the write, so `applySpec`'s CHART_UPDATED — which is
          // what makes the selection publisher re-read the ladder — republishes
          // the rung the reader has actually been moved to rather than the row
          // that has just stopped being drawn.
          setSubSelection(chartId, selectionAfterHidingLegendEntry(entries, si));
          applySpec(hidePatch);
        },
      });
    }
  }

  // THE IN-PLOT FURNITURE'S OWN DELETE. One row, one subject, the subject in
  // the label — the deviation this menu already records for the shared "Delete
  // Chart" item, applied consistently: a destructive verb whose subject changes
  // rung by rung is the ambiguity the recorded subject exists to remove.
  //
  // The row is offered only when the patch is real, for the reason
  // `hideLegendEntryPatch`'s twin is: a menu item that does nothing trains the
  // reader to skip the menu. (The Delete KEY behaves differently and must: it
  // consumes the keystroke either way, because a second press falling through
  // to the destroy arm is how a chart disappears.)
  const furnitureTarget = furnitureTargetFromSubject(subject);
  if (furnitureTarget) {
    const patch = furnitureDeletePatch(spec, furnitureTarget);
    if (patch) {
      rows.push({
        id: `delete:${furnitureTarget.element}`,
        label: `Delete ${subject.name}`,
        run: () => {
          // The rung being deleted stops existing; leaving it selected is the
          // stale-subject defect the cue rings taught us. Moved BEFORE the
          // write so `applySpec`'s CHART_UPDATED republishes the rung the
          // reader has actually been moved to.
          setSubSelection(chartId, { level: "chart" });
          applySpec(patch);
        },
      });
    }
  }

  if ((subject.element === "legend" || subject.element === "legendEntry") && spec.legend?.visible) {
    rows.push({
      id: "deleteLegend",
      label: "Delete Legend",
      run: () => applySpec({ legend: { ...spec.legend, visible: false } }),
    });
  }

  if (isSeriesSubject(subject) && subject.seriesIndex !== undefined) {
    const si = subject.seriesIndex;

    // Data labels. `seriesFilter` indexes the PARSED (painter-space) series,
    // which is the same space the hit test answers in, so no translation.
    const labelRow = dataLabelRow(spec, si);
    if (labelRow) {
      rows.push({ id: labelRow.id, label: labelRow.label, run: () => applySpec(labelRow.patch) });
    }

    // Trendlines. `TrendlineSpec.seriesIndex` also indexes the parsed series.
    if (TRENDLINE_MARKS.has(spec.mark)) {
      const existing = (spec.trendlines ?? []).some((t) => (t.seriesIndex ?? 0) === si);
      rows.push(
        existing
          ? {
              id: "removeTrendline",
              label: "Remove Trendline",
              run: () => {
                const kept = (spec.trendlines ?? []).filter((t) => (t.seriesIndex ?? 0) !== si);
                applySpec({ trendlines: kept.length > 0 ? kept : undefined });
              },
            }
          : {
              id: "addTrendline",
              label: "Add Trendline",
              run: () =>
                applySpec({
                  trendlines: [...(spec.trendlines ?? []), { type: "linear", seriesIndex: si }],
                }),
            },
      );
    }
  }

  // --------------------------------------------------------------------------
  // Object-level items
  // --------------------------------------------------------------------------

  rows.push({
    id: "editScript",
    label: "Edit Script...",
    run: () =>
      emitAppEvent("scriptable-objects:edit-script", {
        objectType: "chart",
        instanceId: String(chartId),
        objectName: chartLabel,
      }),
  });

  // --------------------------------------------------------------------------
  // Format <element>... — ALWAYS last
  // --------------------------------------------------------------------------

  // CAN THIS POINT BE FORMATTED AT ALL? A per-point override reaches every
  // built-in mark, but a CUSTOM mark paints in a worker and only the mark itself
  // can say whether it reads the resolved styles the host ships it. On a mark
  // that does not, the Format Data Point dialog would take a colour, write it
  // into the spec, dirty the document — and paint nothing. The verb is therefore
  // WITHHELD rather than offered and then quietly ignored; Delete Chart, Reset
  // to Match Style, Change Chart Type and Select Data all still stand, and the
  // whole SERIES is still formattable from the Design tab.
  const pointIsFormattable =
    !isPointSubject(subject) || markOffersPerPointFormatting(spec.mark);

  const formatRow: MenuRow = {
    id: "formatElement",
    label: `Format ${subject.element === "legendEntry" ? "Legend" : subject.name}...`,
    run: () => {
      if (isPointSubject(subject)) {
        // dataPointOverrides are keyed in AUTHORING space; the hit test answers
        // in painter space. Prefer the translated pair and fall back to the
        // painter one, which is identical whenever no filter is active.
        showDialog("chart:dataPointFormat", {
          chartId,
          seriesIndex: subject.authoring?.seriesIndex ?? subject.seriesIndex ?? 0,
          categoryIndex: subject.authoring?.pointIndex ?? subject.pointIndex ?? 0,
          categoryName: subject.categoryName,
          isPieOrDonut: spec.mark === "pie" || spec.mark === "donut",
        });
        return;
      }
      if (subject.element === "xAxis" || subject.element === "yAxis") {
        showDialog("chart:formatAxisDialog", {
          chartId,
          axisType: subject.axisType ?? (subject.element === "yAxis" ? "y" : "x"),
        });
        return;
      }
      if (furnitureTarget) {
        // The retargeting Format PANE, not the chart dialog. The four in-plot
        // elements have sections there and nowhere else, and the selection has
        // ALREADY been moved to the right-clicked element by the handler that
        // opened this menu — so the pane targets what the reader clicked rather
        // than what was selected before. Routed through the command registry
        // because that is the same door Ctrl+1 uses; a second call to
        // `openTaskPane` here would be a second way in that could forget to
        // republish the selection first.
        void CommandRegistry.execute(CHART_FORMAT_SELECTION_COMMAND);
        return;
      }
      // Everything else formats from the chart dialog's Design tab, which is
      // where title / legend / series appearance actually lives.
      openChartDialog("design");
    },
  };

  const visibleContributions = visibleFor(contributions, chartId);

  // The FIRST placement, from the row count. It is only a starting point — the
  // layout effect above re-places the menu from its measured box before the
  // browser paints, which is what actually guarantees the last row is
  // clickable. Kept because a first layout at roughly the right place keeps the
  // correction to a few pixels (and because a hand-built DOM in a test that
  // never runs effects still gets a sane top).
  const estimatedHeight = 40 + (rows.length + visibleContributions.length + 1) * 26;

  return (
    <div
      ref={menuRef}
      className={styles.menu}
      data-chart-context-menu={subject.element}
      style={{
        left: Math.min(screenX, window.innerWidth - 200),
        top: Math.max(0, Math.min(screenY, window.innerHeight - estimatedHeight)),
      }}
    >
      <div className={styles.header}>{chartLabel}</div>
      {subject.element !== "chartArea" && (
        <div className={styles.subject} data-chart-menu-subject={subject.element}>
          {subject.identity != null ? `${subject.name}: ${subject.identity}` : subject.name}
        </div>
      )}

      {rows.map((row) => (
        <div
          key={row.id}
          className={styles.item}
          data-chart-menu-item={row.id}
          onClick={() => {
            // Close FIRST, for the same reason a contribution does: an item
            // that opens a dialog must not fight this menu for the dropdown
            // layer, and a throw must not leave the menu stuck on screen.
            onClose();
            row.run();
          }}
        >
          {row.label}
        </div>
      ))}

      {visibleContributions.map((item) => (
        <div
          key={item.id}
          className={styles.item}
          data-chart-menu-item={`contribution:${item.id}`}
          onClick={() => {
            // Close FIRST: a contribution that opens a dialog or a task pane must
            // not have to fight this menu for the dropdown layer, and a throw
            // from foreign code must not leave the menu stuck on screen.
            //
            // The right-clicked subject is deliberately NOT cleared on unmount:
            // a contribution reads it through `getChartRightClickTarget` from
            // inside this very `onSelect`, which runs AFTER `onClose()`.
            onClose();
            try {
              item.onSelect(chartId);
            } catch (err) {
              console.warn(`[Charts] Context-menu contribution "${item.id}" threw:`, err);
            }
          }}
        >
          {item.label}
        </div>
      ))}

      {pointIsFormattable && <div className={styles.divider} />}

      {pointIsFormattable && (
        <div
          className={styles.item}
          data-chart-menu-item={formatRow.id}
          onClick={() => {
            onClose();
            formatRow.run();
          }}
        >
          {formatRow.label}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Element-verb helpers
// ============================================================================

/**
 * "Hide Legend Entry" — the ONE resolver for removing a single ROW from the
 * legend while its series stays PLOTTED. Returns null when there is nothing to
 * hide, so neither route offers an act that would do nothing.
 *
 * WHY THIS EXISTS AT ALL. `LegendSpec.hiddenEntries` was declared, schema'd,
 * documented in the generated spec reference and HONOURED end to end — the
 * layout estimate and the painter both filter through `visibleLegendEntries`
 * — and NOTHING in the repository ever pushed an index into it. So the finest
 * act the reader could perform on a legend entry was Delete, and Delete hid the
 * WHOLE legend: precisely the coarser act the field was added to avoid. A field
 * with no writer is a promise the product does not keep.
 *
 * ONE RESOLVER, TWO DERIVATIONS — the same shape as
 * {@link resetToMatchStyleScopePatch}. The Delete key derives the index from
 * the SELECTION ladder and this menu derives it from the RIGHT-CLICKED entry;
 * both ask this function what the patch is, because a second copy would drift
 * the first time hiding learned about another way a row can disappear.
 *
 * `deepMergeSpec` replaces arrays wholesale, so handing back the whole new
 * array is what makes the write land; the indices are kept SORTED only so two
 * equivalent specs compare equal in a saved file, never because anything reads
 * them in order.
 *
 * DELIBERATE DIVERGENCE FROM EXCEL, recorded on `LegendSpec.hiddenEntries`
 * itself: Excel's legend-entry deletion is not individually undoable — you
 * remove the whole legend and recreate it. Here it is one ordinary spec edit,
 * so it is one ordinary undo entry.
 */
export function hideLegendEntryPatch(
  spec: ChartSpec,
  seriesIndex: number,
): Partial<ChartSpec> | null {
  if (!Number.isInteger(seriesIndex) || seriesIndex < 0) return null;
  const hidden = spec.legend?.hiddenEntries ?? [];
  if (hidden.includes(seriesIndex)) return null;
  return {
    legend: {
      ...spec.legend,
      hiddenEntries: [...hidden, seriesIndex].sort((a, b) => a - b),
    },
  };
}

/**
 * Marks whose trendline painter produces something meaningful.
 *
 * Conservative on purpose: `trendlinePainter` builds a point scale over the
 * categories and a linear y scale, so a radial mark would get a regression line
 * drawn across a pie. A mark missing from this set loses the item, never gets a
 * wrong one.
 */
const TRENDLINE_MARKS = new Set<string>(["bar", "line", "area", "scatter", "combo", "bubble"]);

/**
 * The data-label row for a series, or null when the toggle could not be honoured
 * for THAT SERIES alone.
 *
 * The null case is real and deliberate: with labels on for the whole chart
 * (`seriesFilter` absent) and a spec whose series are not enumerable — a pivot
 * or design-query chart, where `spec.series` is empty — there is no way to say
 * "all of them except this one". Offering "Remove Data Labels" there would strip
 * them from every series, so the item is simply not offered.
 */
export function dataLabelRow(
  spec: ChartSpec,
  seriesIndex: number,
): { id: string; label: string; patch: Partial<ChartSpec> } | null {
  const dl = spec.dataLabels;
  const filter = dl?.seriesFilter ?? null;
  const on = !!dl?.enabled && (filter === null || filter.includes(seriesIndex));

  if (!on) {
    return {
      id: "addDataLabels",
      label: "Add Data Labels",
      patch: {
        dataLabels: {
          ...(dl ?? {}),
          enabled: true,
          // A disabled spec's stale filter must not silently exclude the very
          // series being switched on.
          seriesFilter: dl?.enabled && filter !== null ? [...filter, seriesIndex] : [seriesIndex],
        },
      },
    };
  }

  if (filter !== null) {
    const kept = filter.filter((i) => i !== seriesIndex);
    return {
      id: "removeDataLabels",
      label: "Remove Data Labels",
      patch: {
        dataLabels: { ...dl, enabled: kept.length > 0, seriesFilter: kept.length > 0 ? kept : null },
      },
    };
  }

  const others = spec.series.map((_, i) => i).filter((i) => i !== seriesIndex);
  if (spec.series.length === 0) return null;
  return {
    id: "removeDataLabels",
    label: "Remove Data Labels",
    patch: {
      dataLabels: { ...dl, enabled: others.length > 0, seriesFilter: others.length > 0 ? others : null },
    },
  };
}
