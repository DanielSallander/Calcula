//! FILENAME: app/extensions/Charts/components/ChartFormatPane.tsx
// PURPOSE: The ONE Format task pane for charts — Excel's retargeting "Format
//          <element>" pane. It does not close and reopen as the selection
//          moves; it RE-TARGETS in place, and every control applies
//          immediately.
// CONTEXT:
//          SPLIT OF AUTHORITY — decided here, once, so this pane and the
//          contextual ribbon Design panel cannot become two sources of truth:
//
//            * THIS PANE formats THE CURRENT SELECTION. Whatever rung of the
//              ladder the reader is on — one bar, a series, the title, an axis,
//              the legend, the plot area — the pane shows the properties of
//              THAT and nothing else.
//            * THE RIBBON DESIGN PANEL (components/ChartDesignSections.tsx)
//              configures THE WHOLE CHART: its type, its data, its palette,
//              which elements exist at all, export, the JSON spec.
//
//          The dividing question is "does this control need a selection to
//          mean anything?". Palette: no — Design panel. This bar's fill: yes —
//          this pane. A control that appears in both is a bug in one of them.
//
//          RETARGETING NEVER COMES FROM `props.data`. A task pane's `data` is
//          frozen at the moment `openPane` was called and is not refreshed
//          when the selection moves (see `openPane` in
//          app/src/shell/registries/taskPaneExtensions.ts — the store holds
//          whatever the opener passed). A pane that read its target from
//          `data` would format the element that happened to be selected when
//          somebody first opened it, forever. The target is read from the
//          `@api/chartSelection` registry and re-read on every change.
//
//          THE ACTIVE SECTION SURVIVES A RETARGET. Excel 2010 lost it on every
//          selection change and Peltier wrote it up as a named complaint: pick
//          "Options", click the next bar, and you are back on "Fill & Line".
//          The remedy here is that the reader's LAST DELIBERATE CHOICE is
//          remembered separately from the tab actually shown. Retargeting to an
//          element that has no Text tab falls back to its first tab, and
//          retargeting BACK to one that does restores Text. Storing only the
//          shown tab would forget it the moment the reader touched a bar.
//
//          RE-READ THE SPEC AT COMMIT TIME, ALWAYS. `deepMergeSpec`
//          (lib/chartStore.ts) replaces ARRAYS WHOLESALE. A pane that cached
//          `spec.dataPointOverrides` on render and wrote its cached copy back
//          would silently discard any override added in between — by the JSON
//          spec editor, by a script, by the chart's own filter path — because
//          its stale array is the one that wins. Every commit in this file
//          starts with `getChartById(chartId)`, and no control writes back a
//          collection it was rendered from.
//
//          THERE ARE NO DEAD TABS. Excel shows Effects and Size & Properties
//          for most elements; Calcula's chart spec records neither shadow/glow
//          nor per-element geometry, so those tabs would be empty for every
//          element — the exact dead-member defect CI-7 removed from the hit
//          taxonomy. They arrive with the spec fields, not before.

import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { css } from "@emotion/css";
import { AppEvents, emitAppEvent, onAppEvent } from "@api/events";
import type { TaskPaneViewProps } from "@api/uiTypes";
import { DialogSection } from "@api/dialogLayout";
import {
  getChartSelection,
  onChartSelectionChanged,
  publishChartSelection,
  type ChartSelectionSnapshot,
} from "@api/chartSelection";

import type {
  AxisCrossesAt,
  AxisLabelPosition,
  AxisSpec,
  ChartSpec,
  DataPointOverride,
  DisplayUnit,
  MarkerStyle,
  ThemeOverrides,
  TickMarkType,
} from "../types";
import {
  getChartById,
  getPreviewBaseSpec,
  previewChartSpec,
  restoreChartSpecPreview,
  syncChartRegions,
  updateChartSpec,
} from "../lib/chartStore";
import { getCachedChartData, invalidateChartCache } from "../rendering/chartRenderer";
import { unambiguousDataPointKeyForDatum, toAuthoringIndices } from "../lib/dataPointOverrides";
import { datumAddress } from "../lib/datumAddress";
// ONE resolver for "what does Reset to Match Style drop", shared with the
// context menu that already owned it. Two derivations of the SCOPE (the
// right-clicked element there, the current selection here), one answer about
// what a reset removes — a second copy would drift on the first new style
// field, and the field it forgot would be an override that cannot be cleared.
import {
  resetToMatchStyleScopePatch,
  type ResetToMatchStyleScope,
} from "./ChartContextMenu";
import { getCurrentChartId, getSubSelection } from "../handlers/selectionHandler";
import { ChartEvents } from "../lib/chartEvents";
import { resolveChartTheme } from "../rendering/chartTheme";

/** Task-pane view id. Also the id the retired modal dialogs redirect to. */
export const CHART_FORMAT_PANE_ID = "chart-format";

// ============================================================================
// Publishing the selection into @api/chartSelection
// ============================================================================

/**
 * Translate the Charts selection ladder into the published
 * `@api/chartSelection` snapshot.
 *
 * WHY IT LIVES HERE AND LISTENS TO AN EVENT. The ladder's own state machine
 * (handlers/selectionHandler.ts) mutates from half a dozen call sites, and a
 * publish call at each of them is six places to forget one. `index.ts` already
 * emits `AppEvents.CHART_SELECTION_CHANGED` after EVERY one of those mutations,
 * so the event is used as the SIGNAL and the handler is read as the SOURCE —
 * the payload itself is deliberately not trusted, because it does not carry
 * `axisType` and a published snapshot that could not name which axis is
 * selected would make "Format Axis" guess.
 */
export function publishCurrentChartSelection(): void {
  const chartId = getCurrentChartId();
  if (chartId === null) {
    publishChartSelection(null);
    return;
  }
  const chart = getChartById(chartId);
  if (chart === null) {
    publishChartSelection(null);
    return;
  }

  const sub = getSubSelection();
  const cached = getCachedChartData(chartId);
  const seriesName =
    sub.seriesIndex != null
      ? (cached?.data?.series?.[sub.seriesIndex]?.name ??
        chart.spec.series?.[sub.seriesIndex]?.name)
      : undefined;
  const categoryName =
    sub.categoryIndex != null ? cached?.data?.categories?.[sub.categoryIndex] : undefined;

  publishChartSelection({
    chartId,
    chartName: chart.name,
    level: sub.level,
    seriesIndex: sub.seriesIndex,
    categoryIndex: sub.categoryIndex,
    axisType: sub.axisType,
    elementId: sub.elementId,
    seriesName: seriesName || undefined,
    categoryName: categoryName || undefined,
  });
}

/**
 * Keep `@api/chartSelection` in step with the ladder for as long as the Charts
 * extension is active. Returns the uninstall; call it from `deactivate`.
 */
export function installChartSelectionPublisher(): () => void {
  publishCurrentChartSelection();
  const offSelection = onAppEvent(AppEvents.CHART_SELECTION_CHANGED, () => {
    publishCurrentChartSelection();
  });
  // A rename or a data refresh changes the DISPLAY NAME without touching the
  // ladder, and the registry derives the name, so it has to be told.
  const onUpdated = (): void => publishCurrentChartSelection();
  window.addEventListener(ChartEvents.CHART_UPDATED, onUpdated);
  return () => {
    offSelection();
    window.removeEventListener(ChartEvents.CHART_UPDATED, onUpdated);
    publishChartSelection(null);
  };
}

// ============================================================================
// Which sections a selection offers
// ============================================================================

/** The tabs this pane can show. Closed: a tab with no fields is a dead tab. */
export type ChartFormatTabId = "fill" | "options" | "text";

export const CHART_FORMAT_TAB_LABELS: Record<ChartFormatTabId, string> = {
  fill: "Fill & Line",
  options: "Options",
  text: "Text",
};

/**
 * What the pane is formatting, collapsed from the ladder into ONE name.
 *
 * The ladder distinguishes `level: "axis"` from `level: "element", elementId:
 * "xAxis"`, and a datum can arrive as `level: "dataPoint"` or as an `element`
 * hit; the pane cares only about the subject. Pure, exported for tests.
 */
export type ChartFormatSubject =
  | "dataPoint"
  | "series"
  | "title"
  | "xAxisTitle"
  | "yAxisTitle"
  | "axis"
  | "legend"
  | "legendEntry"
  | "plotArea"
  | "chartArea"
  | "none";

export function formatSubjectOf(sel: ChartSelectionSnapshot): ChartFormatSubject {
  if (sel.chartId === null) return "none";
  switch (sel.level) {
    case "none":
      return "none";
    case "dataPoint":
      return "dataPoint";
    case "series":
      return "series";
    case "axis":
      return "axis";
    case "chart":
      return "chartArea";
    case "element":
      switch (sel.elementId) {
        case "title":
          return "title";
        case "xAxisTitle":
          return "xAxisTitle";
        case "yAxisTitle":
          return "yAxisTitle";
        case "xAxis":
        case "yAxis":
          return "axis";
        case "legend":
          return "legend";
        case "legendEntry":
          return "legendEntry";
        case "plotArea":
          return "plotArea";
        // `datum`, `filterButton`, `chartArea`, `none` and an absent id all
        // format the chart area, which is what Excel does for a click that
        // lands on chart furniture it has no panel for.
        default:
          return "chartArea";
      }
  }
}

/** Which tabs a subject offers, in order. Never empty for a real subject. */
export function tabsForSubject(subject: ChartFormatSubject): ChartFormatTabId[] {
  switch (subject) {
    case "dataPoint":
      return ["fill", "options"];
    case "series":
      return ["fill"];
    case "title":
    case "xAxisTitle":
    case "yAxisTitle":
      return ["text"];
    case "axis":
      // Options first, as Excel's Format Axis opens on "Axis Options": the
      // bounds and the scale are what a reader came for; the line colour is a
      // second thought.
      return ["options", "fill", "text"];
    case "legend":
    case "legendEntry":
      return ["options", "text"];
    case "plotArea":
      return ["fill"];
    case "chartArea":
      return ["fill", "text"];
    case "none":
      return [];
  }
}

/**
 * The tab actually shown: the reader's remembered preference when the subject
 * offers it, otherwise the subject's first tab.
 *
 * This is the whole of the Peltier fix, and it is a pure function so the rule
 * can be tested without a DOM.
 */
export function resolveActiveTab(
  tabs: ChartFormatTabId[],
  preferred: ChartFormatTabId | null,
): ChartFormatTabId | null {
  if (tabs.length === 0) return null;
  if (preferred !== null && tabs.includes(preferred)) return preferred;
  return tabs[0];
}

// ============================================================================
// Commit helpers — every one of them RE-READS the spec
// ============================================================================

/** Repaint + persist, the one sequence every chart edit in this pane ends with. */
function announceChartEdit(chartId: string): void {
  invalidateChartCache(chartId);
  syncChartRegions();
  window.dispatchEvent(new Event(ChartEvents.CHART_UPDATED));
  emitAppEvent(AppEvents.GRID_REFRESH);
}

/**
 * Apply a patch computed from the CURRENT stored spec.
 *
 * `build` is handed the freshly read spec and returns the patch, so a control
 * can spread a collection it has just read rather than one it rendered from.
 * Returning null commits nothing.
 *
 * COMMIT IS AN EXIT PATH FOR THE LIVE PREVIEW, and it is enforced here rather
 * than at each control: this is the one commit funnel in the file, so every
 * control gets the guarantee that its patch is built from the STORED spec and
 * not from whatever the pointer is hovering over.
 */
export function applySpecPatch(
  chartId: string,
  build: (spec: ChartSpec) => Partial<ChartSpec> | null,
): void {
  endChartSpecPreview();
  const chart = getChartById(chartId);
  if (chart === null) return;
  const patch = build(chart.spec);
  if (patch === null) return;
  updateChartSpec(chartId, patch);
  announceChartEdit(chartId);
}

// ============================================================================
// CI-14 — live preview is a TRANSIENT WRITE
// ============================================================================
//
// Hovering a swatch repaints the chart and writes NOTHING: no undo entry, no
// dirty flag, nothing scheduled for the backend. Clicking it writes exactly
// one. The store half of that promise is `previewChartSpec` /
// `restoreChartSpecPreview` (lib/chartStore.ts) — `updateChartSpec` ends in
// `scheduleSave` unconditionally, so a preview routed through it would be
// PERSISTED, and the last colour the pointer crossed on its way elsewhere would
// be what the workbook keeps.
//
// EVERY EXIT PATH RESTORES, and they are enumerated rather than assumed:
//   mouse-out ......... the swatch's own onMouseLeave / onBlur
//   commit ............ applySpecPatch, above
//   pane close ........ the unmount cleanup in ChartFormatPane
//   chart deselect .... the selection subscription, when the SUBJECT changes
//   chart deletion .... chartStore.deleteChart drops it (the chart is gone)
//   File > New/Open ... chartStore.loadChartsFromBackend drops it
// and, as the backstop that makes a missed exit path harmless rather than
// corrupting, `updateChartSpec` itself restores before it merges.

/**
 * Whether THIS module started the preview that is currently up.
 *
 * Module scope because the preview is a property of the pointer, not of a React
 * subtree: the swatch that starts it and the unmount that ends it are in
 * different components, and there is exactly one Format pane.
 */
let paneHasPreview = false;

/**
 * Show a patch on the chart without committing it.
 *
 * `build` is handed the spec a COMMIT would start from — the stored one, never
 * the currently previewed one — so hovering ten swatches in a row previews ten
 * alternatives to the same base rather than stacking ten merges.
 */
export function previewSpecPatch(
  chartId: string,
  build: (spec: ChartSpec) => Partial<ChartSpec> | null,
): void {
  const base = getPreviewBaseSpec(chartId);
  if (base === null) return;
  const patch = build(base);
  if (patch === null) return;
  previewChartSpec(chartId, patch);
  paneHasPreview = true;
  // Repaint only. `announceChartEdit` invalidates the render cache, re-syncs
  // the overlay regions and asks the grid to repaint; none of it persists.
  announceChartEdit(chartId);
}

/** End the live preview and repaint. A no-op when nothing is previewing. */
export function endChartSpecPreview(): void {
  if (!paneHasPreview) return;
  paneHasPreview = false;
  const chartId = restoreChartSpecPreview();
  if (chartId !== null) announceChartEdit(chartId);
}

/** Test/diagnostic hook: is a pane-owned preview on screen right now? */
export function paneIsPreviewing(): boolean {
  return paneHasPreview;
}

/** Visual fields of a DataPointOverride — what makes one worth keeping. */
const OVERRIDE_VISUAL_FIELDS: Array<keyof DataPointOverride> = [
  "color",
  "opacity",
  "borderColor",
  "borderWidth",
  "exploded",
  "gradientFill",
  "patternFill",
  "invertIfNegative",
  "markerStyle",
  "markerSize",
  "markerFill",
  "markerBorderColor",
  "markerBorderWidth",
];

/**
 * What a control may change about one datum.
 *
 * The two INDEX fields are excluded on purpose: they are the override's
 * address, not its formatting, and a patch that could rewrite them would let a
 * colour picker move the override onto a different bar.
 */
export type ChartDatumFormatPatch = Partial<
  Omit<DataPointOverride, "seriesIndex" | "categoryIndex">
>;

/**
 * Which stored override this write target already owns: the one carrying the
 * same identity KEY first, its index pair second.
 *
 * KEY FIRST, AND THIS IS THE WHOLE POINT. `buildOverrideIndex` resolves a key
 * BEFORE an index, so once a row insert has moved a datum the override that
 * formats it is the key-matched one, and its stored `categoryIndex` is stale by
 * exactly the number of inserted rows. An index-only lookup missed it and
 * PUSHED a second override carrying the same key — which the resolver can never
 * reach, because the key stage awards the slot to the first override in array
 * order. The edit was persisted and permanently invisible, every further edit
 * merged into the same shadowed duplicate, and the pane read the NEW override
 * back and showed blue over a red bar. Matching by key also repairs the stale
 * address, since the merged override is re-stamped with the current pair.
 *
 * A key is only ever stamped when it is UNAMBIGUOUS (see
 * `unambiguousDataPointKeyForDatum`), so a key match here cannot steal a
 * different datum's override.
 */
function findOverrideSlot(
  overrides: readonly DataPointOverride[],
  seriesIndex: number,
  categoryIndex: number,
  key: string | undefined,
): number {
  if (key !== undefined && key.length > 0) {
    const byKey = overrides.findIndex((o) => o.key === key);
    if (byKey >= 0) return byKey;
  }
  return overrides.findIndex(
    (o) => o.seriesIndex === seriesIndex && o.categoryIndex === categoryIndex,
  );
}

/**
 * Merge one datum's override into the existing list, in AUTHORING space.
 *
 * A patch field set to `undefined` CLEARS that property. An override left with
 * no visual field at all is removed rather than persisted as an empty husk, and
 * an empty list is returned as `undefined` so the spec does not carry `[]`.
 *
 * `existing` must be the array read from the store at commit time. Pure, so the
 * merge can be tested away from the store.
 */
export function mergeDataPointOverrides(
  existing: readonly DataPointOverride[] | undefined,
  seriesIndex: number,
  categoryIndex: number,
  key: string | undefined,
  patch: ChartDatumFormatPatch,
): DataPointOverride[] | undefined {
  const out = (existing ?? []).map((o) => ({ ...o }));
  const idx = findOverrideSlot(out, seriesIndex, categoryIndex, key);

  const base: DataPointOverride =
    idx >= 0 ? out[idx] : { seriesIndex, categoryIndex, ...(key ? { key } : {}) };

  const merged: DataPointOverride = { ...base, ...patch, seriesIndex, categoryIndex };
  // An explicit `undefined` CLEARS the property rather than storing a hole:
  // the spread above copies the key across, and a stored `"color": undefined`
  // would survive `Object.entries` in deepMergeSpec as a present-but-empty
  // field that `resolveDatumStyle`'s `??` chain treats as unset while
  // `stillFormats` below counts it as set — the override would then persist
  // forever as an invisible husk.
  for (const field of Object.keys(patch) as Array<keyof ChartDatumFormatPatch>) {
    if (patch[field] === undefined) delete merged[field];
  }
  // Stamp the identity key on every write, so an override written before the
  // key existed acquires one the first time it is touched here.
  if (key) merged.key = key;

  const stillFormats = OVERRIDE_VISUAL_FIELDS.some(
    (f) => merged[f] !== undefined && merged[f] !== null,
  );

  if (stillFormats) {
    if (idx >= 0) out[idx] = merged;
    else out.push(merged);
  } else if (idx >= 0) {
    out.splice(idx, 1);
  }

  return out.length > 0 ? out : undefined;
}

/**
 * Where a PAINTER-space datum's override is written: authoring indices plus the
 * identity key. `toAuthoringIndices` is identity when no filter has run, and
 * the key is absent when the indices fall outside the parsed data.
 */
export function datumWriteTarget(
  chartId: string,
  painterSeriesIndex: number,
  painterCategoryIndex: number,
): { seriesIndex: number; categoryIndex: number; key: string | undefined } {
  const cached = getCachedChartData(chartId);
  const chart = getChartById(chartId);
  if (!cached || chart === null) {
    return {
      seriesIndex: painterSeriesIndex,
      categoryIndex: painterCategoryIndex,
      key: undefined,
    };
  }
  // THE ADDRESS IS THE PAINTER'S, NOT THE HIT GEOMETRY'S. `datumAddress`
  // translates the ladder's indices into the (view, series, category) triple
  // the painter actually resolves this datum at — a radial mark walks its
  // categories through `seriesIndex`, a Pareto chart re-sorts its bars, a
  // histogram's datums are bins. Writing at the ladder's own spelling is how an
  // override came to be stored at an address nothing reads.
  const at = datumAddress(chart.spec, cached.data, painterSeriesIndex, painterCategoryIndex);
  const authoring = toAuthoringIndices(at.view, at.seriesIndex, at.categoryIndex);
  return {
    ...authoring,
    // UNAMBIGUOUS, not merely present: a duplicated category label ("East,
    // North, North, West") makes one key name two datums, and the resolver's
    // tie-break awards it to the FIRST — so stamping it on the second created a
    // collision the reader could not get past. No key means the index stage,
    // which addresses exactly the datum that was clicked.
    key: unambiguousDataPointKeyForDatum(at.view, at.seriesIndex, at.categoryIndex),
  };
}

/** Commit a per-datum override for the selected data point. */
export function commitDataPointOverride(
  chartId: string,
  painterSeriesIndex: number,
  painterCategoryIndex: number,
  patch: ChartDatumFormatPatch,
): void {
  const target = datumWriteTarget(chartId, painterSeriesIndex, painterCategoryIndex);
  applySpecPatch(chartId, (spec) => ({
    dataPointOverrides: mergeDataPointOverrides(
      spec.dataPointOverrides,
      target.seriesIndex,
      target.categoryIndex,
      target.key,
      patch,
    ),
  }));
}

/** Preview a per-datum override without committing it. */
export function previewDataPointOverride(
  chartId: string,
  painterSeriesIndex: number,
  painterCategoryIndex: number,
  patch: ChartDatumFormatPatch,
): void {
  const target = datumWriteTarget(chartId, painterSeriesIndex, painterCategoryIndex);
  previewSpecPatch(chartId, (spec) => ({
    dataPointOverrides: mergeDataPointOverrides(
      spec.dataPointOverrides,
      target.seriesIndex,
      target.categoryIndex,
      target.key,
      patch,
    ),
  }));
}

/** The override currently formatting the selected datum, read fresh. */
function readDataPointOverride(
  chartId: string,
  painterSeriesIndex: number,
  painterCategoryIndex: number,
): DataPointOverride | undefined {
  const chart = getChartById(chartId);
  if (chart === null) return undefined;
  const target = datumWriteTarget(chartId, painterSeriesIndex, painterCategoryIndex);
  const overrides = chart.spec.dataPointOverrides;
  if (!overrides) return undefined;
  // The SAME lookup the write uses, so the swatch shows what the next edit will
  // change. Reading by index alone missed a key-matched override whose stored
  // index the data has since moved, and the pane then showed "no colour" on a
  // bar that is painted red.
  const idx = findOverrideSlot(overrides, target.seriesIndex, target.categoryIndex, target.key);
  return idx >= 0 ? overrides[idx] : undefined;
}

/** Commit a partial axis patch, rebuilt from the freshly read axis. */
export function commitAxisPatch(
  chartId: string,
  axisType: "x" | "y",
  patch: Partial<AxisSpec>,
): void {
  applySpecPatch(chartId, (spec) => {
    const axis = axisType === "x" ? spec.xAxis : spec.yAxis;
    const next: AxisSpec = { ...axis, ...patch };
    return axisType === "x" ? { xAxis: next } : { yAxis: next };
  });
}

/**
 * Commit a theme override, rebuilt from the freshly read config.
 *
 * A field set to `undefined` in the patch RESETS it: `deepMergeSpec` walks
 * `Object.entries`, which keeps a key whose value is undefined, so the stored
 * override is genuinely removed rather than left standing.
 */
export function commitThemePatch(chartId: string, patch: Partial<ThemeOverrides>): void {
  applySpecPatch(chartId, (spec) => ({
    config: { ...spec.config, theme: { ...spec.config?.theme, ...patch } },
  }));
}

/** The preview twin of {@link commitThemePatch}. Same patch, no persistence. */
export function previewThemePatch(chartId: string, patch: Partial<ThemeOverrides>): void {
  previewSpecPatch(chartId, (spec) => ({
    config: { ...spec.config, theme: { ...spec.config?.theme, ...patch } },
  }));
}

/** The preview twin of {@link commitAxisPatch}. */
export function previewAxisPatch(
  chartId: string,
  axisType: "x" | "y",
  patch: Partial<AxisSpec>,
): void {
  previewSpecPatch(chartId, (spec) => {
    const axis = axisType === "x" ? spec.xAxis : spec.yAxis;
    const next: AxisSpec = { ...axis, ...patch };
    return axisType === "x" ? { xAxis: next } : { yAxis: next };
  });
}

// ============================================================================
// CI-11 — Reset to Match Style, scoped to the CURRENT SELECTION
// ============================================================================
//
// Excel's `ClearToMatchStyle`: "resets ... to automatic; all formatting,
// including overrides, is reset". It is the exact inverse of per-point
// colouring, and it is not optional politeness — a point-level override that
// cannot be individually cleared is a TRAP: the only ways out would be to
// re-colour the point to something that merely looks like the palette entry, or
// to clear every override on the chart.
//
// The scope follows the ladder, which is what makes the trap escapable:
//   one bar selected ...... that ONE override
//   a series selected ..... that series' overrides and its colour
//   the chart selected .... every override, every series colour, the theme
//
// The resolver itself lives in ChartContextMenu.tsx and is shared; only the
// SCOPE is derived here.

/** Human name for the scope, so the button can say what it will touch. */
export const RESET_SCOPE_DESCRIPTION: Record<ResetToMatchStyleScope["level"], string> = {
  dataPoint: "this data point",
  series: "this series",
  chart: "the whole chart",
};

/**
 * Which reset scope the current selection means.
 *
 * Indices are translated to AUTHORING space, because that is the space
 * `dataPointOverrides` and `spec.series` are keyed in while the selection
 * carries painter-space indices. A legend entry resets its SERIES — that is
 * what the entry stands for.
 *
 * For a series the category index handed to `datumWriteTarget` is a
 * placeholder: only the series half of the translated pair is read.
 */
export function resetScopeForSelection(
  chartId: string,
  sel: ChartSelectionSnapshot,
): ResetToMatchStyleScope {
  const subject = formatSubjectOf(sel);
  if (subject === "dataPoint" && sel.seriesIndex != null && sel.categoryIndex != null) {
    const target = datumWriteTarget(chartId, sel.seriesIndex, sel.categoryIndex);
    return {
      level: "dataPoint",
      seriesIndex: target.seriesIndex,
      categoryIndex: target.categoryIndex,
      key: target.key ?? null,
    };
  }
  if ((subject === "series" || subject === "legendEntry") && sel.seriesIndex != null) {
    const target = datumWriteTarget(chartId, sel.seriesIndex, 0);
    return {
      level: "series",
      seriesIndex: target.seriesIndex,
      seriesName: sel.seriesName ?? null,
    };
  }
  return { level: "chart" };
}

/**
 * What a reset would drop right now, or null when there is nothing manual in
 * scope. Used BOTH to enable the button and to perform the reset, so a disabled
 * button and a no-op click cannot disagree.
 *
 * Deliberately reads the LIVE spec rather than the preview base: the button
 * should describe what is on screen. The click re-derives from the stored spec
 * (the commit funnel ends the preview first), and the pointer has to leave the
 * swatch — repainting this row — before the button can be reached, so an
 * enabled-looking button is never clickable while a preview is up.
 */
export function pendingResetPatch(
  chartId: string,
  sel: ChartSelectionSnapshot,
): Partial<ChartSpec> | null {
  const chart = getChartById(chartId);
  if (chart === null) return null;
  return resetToMatchStyleScopePatch(chart.spec, resetScopeForSelection(chartId, sel));
}

/**
 * Perform the reset. ONE `updateChartSpec` call for the whole operation — one
 * undo entry, and one flush out of the 300 ms debounce window, however many
 * collections the patch rewrites.
 */
export function commitResetToMatchStyle(chartId: string, sel: ChartSelectionSnapshot): boolean {
  return commitResetToMatchStyleImpl(chartId, sel);
}

/**
 * The `chart.resetToMatchStyle` command body, for `index.ts` to register.
 *
 * It reads the CURRENT selection itself, so the command means the same thing
 * however it is invoked — ribbon, keyboard or script. Given no chart id it uses
 * the selected chart; given one that is not selected it resets that chart as a
 * whole, which is the only scope a caller who named a chart can have meant.
 * (`chart.clearDataPointOverrides` is exactly this call's chart-level leg.)
 */
export function runResetToMatchStyleCommand(chartId?: string): boolean {
  const sel = getChartSelection();
  const target = chartId ?? sel.chartId;
  if (target === null || target === undefined) return false;
  const scopedSelection: ChartSelectionSnapshot =
    sel.chartId === target ? sel : { ...sel, chartId: target, level: "chart" };
  return commitResetToMatchStyleImpl(target, scopedSelection);
}

function commitResetToMatchStyleImpl(chartId: string, sel: ChartSelectionSnapshot): boolean {
  let applied = false;
  applySpecPatch(chartId, (spec) => {
    const patch = resetToMatchStyleScopePatch(spec, resetScopeForSelection(chartId, sel));
    applied = patch !== null;
    return patch;
  });
  return applied;
}

// ============================================================================
// Styles
// ============================================================================

const s = {
  pane: css`
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
    font-size: 12px;
    color: var(--text-primary, #222);
  `,
  header: css`
    padding: 8px 12px 6px 12px;
    border-bottom: 1px solid var(--border-color, #e0e0e0);
    flex-shrink: 0;
  `,
  subject: css`
    font-weight: 600;
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  chart: css`
    font-size: 11px;
    color: var(--text-secondary, #777);
    margin-top: 1px;
  `,
  tabs: css`
    display: flex;
    gap: 2px;
    padding: 6px 8px 0 8px;
    border-bottom: 1px solid var(--border-color, #e0e0e0);
    flex-shrink: 0;
  `,
  tab: css`
    border: 1px solid transparent;
    border-bottom: none;
    background: transparent;
    padding: 4px 10px;
    font-size: 12px;
    border-radius: 4px 4px 0 0;
    cursor: pointer;
    color: var(--text-secondary, #555);
    &:hover { background: var(--button-hover-bg, rgba(0, 0, 0, 0.06)); }
  `,
  tabActive: css`
    border-color: var(--border-color, #e0e0e0);
    background: var(--panel-bg, #fff);
    color: var(--text-primary, #222);
    font-weight: 600;
  `,
  body: css`
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 10px 12px 16px 12px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  `,
  row: css`
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 24px;
  `,
  label: css`
    width: 104px;
    flex-shrink: 0;
    color: var(--text-secondary, #555);
  `,
  input: css`
    flex: 1;
    min-width: 0;
    padding: 3px 6px;
    border: 1px solid var(--border-color, #ccc);
    border-radius: 3px;
    font-size: 12px;
  `,
  select: css`
    flex: 1;
    min-width: 0;
    padding: 3px 4px;
    border: 1px solid var(--border-color, #ccc);
    border-radius: 3px;
    font-size: 12px;
    background: var(--input-bg, #fff);
    cursor: pointer;
  `,
  color: css`
    width: 36px;
    height: 22px;
    padding: 1px;
    border: 1px solid var(--border-color, #ccc);
    border-radius: 3px;
    cursor: pointer;
    flex-shrink: 0;
  `,
  clear: css`
    border: 1px solid var(--border-color, #ccc);
    background: transparent;
    border-radius: 3px;
    font-size: 11px;
    padding: 2px 6px;
    cursor: pointer;
    color: var(--text-secondary, #555);
    &:hover { background: var(--button-hover-bg, rgba(0, 0, 0, 0.06)); }
  `,
  empty: css`
    padding: 16px 12px;
    color: var(--text-secondary, #777);
    font-size: 12px;
    line-height: 1.5;
  `,
  swatches: css`
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
    margin: 2px 0 0 112px;
  `,
  swatch: css`
    width: 16px;
    height: 16px;
    padding: 0;
    border: 1px solid var(--border-color, #bbb);
    border-radius: 2px;
    cursor: pointer;
    &:hover { outline: 1px solid var(--text-primary, #222); }
  `,
  resetRow: css`
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
  `,
  reset: css`
    border: 1px solid var(--border-color, #ccc);
    background: transparent;
    border-radius: 3px;
    font-size: 11px;
    padding: 3px 8px;
    cursor: pointer;
    color: var(--text-primary, #222);
    &:hover:enabled { background: var(--button-hover-bg, rgba(0, 0, 0, 0.06)); }
    &:disabled { color: var(--text-secondary, #999); cursor: default; }
  `,
  resetScope: css`
    font-size: 11px;
    color: var(--text-secondary, #888);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
};

// ============================================================================
// Field primitives
// ============================================================================

function Row({
  label,
  children,
}: {
  label?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className={s.row}>
      {label !== undefined && <span className={s.label}>{label}</span>}
      {children}
    </div>
  );
}

/**
 * The swatches a colour field offers for LIVE PREVIEW.
 *
 * A fixed strip rather than the palette in use: the point of the hover is to
 * see an alternative, and an Office-standard row is recognisable and small
 * enough to sit under a 104px label without wrapping the pane.
 */
export const PREVIEW_SWATCHES: readonly string[] = [
  "#4472c4",
  "#ed7d31",
  "#a5a5a5",
  "#ffc000",
  "#5b9bd5",
  "#70ad47",
  "#264478",
  "#9e480e",
  "#636363",
  "#000000",
];

function ColorField({
  label,
  value,
  fallback,
  onChange,
  onClear,
  onPreview,
}: {
  label: string;
  value: string | undefined;
  fallback: string;
  onChange: (hex: string) => void;
  onClear?: () => void;
  /**
   * Show `hex` on the chart without committing it. Given, the field grows a
   * swatch strip whose hover previews and whose click commits; omitted, the
   * field is a plain colour input. Every swatch ends the preview on the way
   * out — mouse-out, blur AND click — so no gesture can leave one standing.
   */
  onPreview?: (hex: string) => void;
}): React.ReactElement {
  return (
    <>
      <Row label={label}>
        <input
          type="color"
          aria-label={label}
          className={s.color}
          value={value ?? fallback}
          onChange={(e) => onChange(e.target.value)}
        />
        <span style={{ flex: 1, color: "var(--text-secondary, #888)", fontSize: 11 }}>
          {value ?? "Automatic"}
        </span>
        {onClear !== undefined && value !== undefined && (
          <button type="button" className={s.clear} onClick={onClear}>
            Reset
          </button>
        )}
      </Row>
      {onPreview !== undefined && (
        <div
          className={s.swatches}
          data-chart-swatches={label}
          onMouseLeave={endChartSpecPreview}
        >
          {PREVIEW_SWATCHES.map((hex) => (
            <button
              key={hex}
              type="button"
              className={s.swatch}
              style={{ background: hex }}
              title={`${label}: ${hex}`}
              aria-label={`${label} ${hex}`}
              data-chart-swatch={hex}
              onMouseEnter={() => onPreview(hex)}
              onFocus={() => onPreview(hex)}
              onMouseLeave={endChartSpecPreview}
              onBlur={endChartSpecPreview}
              onClick={() => onChange(hex)}
            />
          ))}
        </div>
      )}
    </>
  );
}

function TextField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (next: string) => void;
}): React.ReactElement {
  return (
    <Row label={label}>
      <input
        type="text"
        aria-label={label}
        className={s.input}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </Row>
  );
}

function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<[T, string]>;
  onChange: (next: T) => void;
}): React.ReactElement {
  return (
    <Row label={label}>
      <select
        aria-label={label}
        className={s.select}
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </Row>
  );
}

function CheckField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}): React.ReactElement {
  return (
    <Row>
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ margin: "0 0 0 2px", cursor: "pointer" }}
      />
      <span>{label}</span>
    </Row>
  );
}

/**
 * A numeric field whose EMPTY string means "auto" rather than zero.
 *
 * Local state is required: a controlled input fed straight from the spec cannot
 * hold "-" or "1." while the reader is still typing, and `parseFloat("")` is
 * NaN, which would commit a bound of `null` on every keystroke of a number.
 */
function NumberField({
  label,
  value,
  placeholder,
  onCommit,
}: {
  label: string;
  value: number | null | undefined;
  placeholder?: string;
  onCommit: (next: number | null) => void;
}): React.ReactElement {
  const [draft, setDraft] = useState(value == null ? "" : String(value));
  const lastExternal = useRef(value);
  if (lastExternal.current !== value) {
    lastExternal.current = value;
    const incoming = value == null ? "" : String(value);
    if (incoming !== draft && parseFloat(draft) !== value) setDraft(incoming);
  }

  return (
    <Row label={label}>
      <input
        type="text"
        aria-label={label}
        className={s.input}
        value={draft}
        placeholder={placeholder ?? "Auto"}
        onChange={(e) => {
          const next = e.target.value;
          setDraft(next);
          if (next.trim() === "") {
            onCommit(null);
            return;
          }
          const parsed = parseFloat(next);
          if (!Number.isNaN(parsed)) onCommit(parsed);
        }}
      />
    </Row>
  );
}

// ============================================================================
// Sections
// ============================================================================

const MARKER_OPTIONS: Array<[MarkerStyle | "auto", string]> = [
  ["auto", "Automatic"],
  ["circle", "Circle"],
  ["square", "Square"],
  ["diamond", "Diamond"],
  ["triangle", "Triangle"],
  ["cross", "Cross"],
  ["none", "None"],
];

function DataPointSections({
  chartId,
  tab,
  seriesIndex,
  categoryIndex,
}: {
  chartId: string;
  tab: ChartFormatTabId;
  seriesIndex: number;
  categoryIndex: number;
}): React.ReactElement {
  const override = readDataPointOverride(chartId, seriesIndex, categoryIndex);
  const chart = getChartById(chartId);
  const isRadial = chart?.spec.mark === "pie" || chart?.spec.mark === "donut";
  const set = (patch: ChartDatumFormatPatch): void =>
    commitDataPointOverride(chartId, seriesIndex, categoryIndex, patch);
  const show = (patch: ChartDatumFormatPatch): void =>
    previewDataPointOverride(chartId, seriesIndex, categoryIndex, patch);

  if (tab === "fill") {
    return (
      <>
        <DialogSection title="Fill">
          <ColorField
            label="Fill colour"
            value={override?.color}
            fallback="#4472c4"
            onChange={(hex) => set({ color: hex })}
            onClear={() => set({ color: undefined })}
            onPreview={(hex) => show({ color: hex })}
          />
          <NumberField
            label="Opacity"
            value={override?.opacity ?? null}
            placeholder="1.0"
            onCommit={(n) =>
              set({ opacity: n === null ? undefined : Math.min(1, Math.max(0, n)) })
            }
          />
        </DialogSection>
        <DialogSection title="Border">
          <ColorField
            label="Border colour"
            value={override?.borderColor}
            fallback="#000000"
            onChange={(hex) => set({ borderColor: hex })}
            onClear={() => set({ borderColor: undefined, borderWidth: undefined })}
            onPreview={(hex) => show({ borderColor: hex })}
          />
          <NumberField
            label="Border width"
            value={override?.borderWidth ?? null}
            placeholder="Auto"
            onCommit={(n) => set({ borderWidth: n === null ? undefined : n })}
          />
        </DialogSection>
      </>
    );
  }

  return (
    <>
      <DialogSection title="Point">
        <CheckField
          label="Invert if negative"
          checked={override?.invertIfNegative === true}
          onChange={(on) => set({ invertIfNegative: on ? true : undefined })}
        />
        {isRadial && (
          <NumberField
            label="Explode (px)"
            value={override?.exploded ?? null}
            placeholder="0"
            onCommit={(n) => set({ exploded: n === null || n <= 0 ? undefined : n })}
          />
        )}
      </DialogSection>
      <DialogSection title="Marker">
        <SelectField<MarkerStyle | "auto">
          label="Marker"
          value={(override?.markerStyle as MarkerStyle | undefined) ?? "auto"}
          options={MARKER_OPTIONS}
          onChange={(v) => set({ markerStyle: v === "auto" ? undefined : v })}
        />
        <NumberField
          label="Marker size"
          value={override?.markerSize ?? null}
          placeholder="Auto"
          onCommit={(n) => set({ markerSize: n === null ? undefined : n })}
        />
        <ColorField
          label="Marker fill"
          value={override?.markerFill}
          fallback="#4472c4"
          onChange={(hex) => set({ markerFill: hex })}
          onClear={() => set({ markerFill: undefined })}
          onPreview={(hex) => show({ markerFill: hex })}
        />
      </DialogSection>
    </>
  );
}

function SeriesSections({
  chartId,
  seriesIndex,
}: {
  chartId: string;
  seriesIndex: number;
}): React.ReactElement {
  const chart = getChartById(chartId);
  const colour = chart?.spec.series?.[seriesIndex]?.color ?? undefined;

  /**
   * One builder for both the commit and the preview: the ARRAY HAZARD is the
   * same either way, so the rebuild-from-the-read-array rule has to be written
   * once. `deepMergeSpec` replaces arrays wholesale, so a rendered copy would
   * discard any concurrent edit to a sibling series.
   */
  const seriesColourPatch =
    (hex: string | null) =>
    (spec: ChartSpec): Partial<ChartSpec> | null => {
      if (spec.series?.[seriesIndex] === undefined) return null;
      const series = spec.series.map((entry, i) =>
        i === seriesIndex ? { ...entry, color: hex } : entry,
      );
      return { series };
    };

  const setColour = (hex: string | null): void => {
    applySpecPatch(chartId, seriesColourPatch(hex));
  };

  return (
    <DialogSection title="Series fill">
      <ColorField
        label="Colour"
        value={colour ?? undefined}
        fallback="#4472c4"
        onChange={(hex) => setColour(hex)}
        onClear={() => setColour(null)}
        onPreview={(hex) => previewSpecPatch(chartId, seriesColourPatch(hex))}
      />
      <div style={{ fontSize: 11, color: "var(--text-secondary, #888)" }}>
        Cleared, the series takes its colour from the chart palette (Chart Design).
      </div>
    </DialogSection>
  );
}

function TitleSections({
  chartId,
  subject,
}: {
  chartId: string;
  subject: "title" | "xAxisTitle" | "yAxisTitle";
}): React.ReactElement {
  const chart = getChartById(chartId);
  const spec = chart?.spec;
  const theme = resolveChartTheme(spec?.config);

  const current =
    subject === "title"
      ? (spec?.title ?? "")
      : subject === "xAxisTitle"
        ? (spec?.xAxis?.title ?? "")
        : (spec?.yAxis?.title ?? "");

  const setText = (next: string): void => {
    const value = next === "" ? null : next;
    if (subject === "title") {
      applySpecPatch(chartId, () => ({ title: value }));
    } else {
      commitAxisPatch(chartId, subject === "xAxisTitle" ? "x" : "y", { title: value });
    }
  };

  const isChartTitle = subject === "title";
  const storedColour = isChartTitle
    ? spec?.config?.theme?.titleColor
    : spec?.config?.theme?.axisTitleColor;
  const storedSize = isChartTitle
    ? spec?.config?.theme?.titleFontSize
    : spec?.config?.theme?.axisTitleFontSize;

  // Written as two explicit patches rather than one computed key: a computed
  // key widens the patch to a string index signature, which would let a typo
  // reach ThemeOverrides unchecked.
  const setColour = (hex: string | undefined): void =>
    commitThemePatch(chartId, isChartTitle ? { titleColor: hex } : { axisTitleColor: hex });
  const showColour = (hex: string): void =>
    previewThemePatch(chartId, isChartTitle ? { titleColor: hex } : { axisTitleColor: hex });
  const setSize = (px: number | undefined): void =>
    commitThemePatch(chartId, isChartTitle ? { titleFontSize: px } : { axisTitleFontSize: px });

  return (
    <>
      <DialogSection title="Text">
        <TextField
          label="Text"
          value={current}
          placeholder="(no title)"
          onChange={setText}
        />
        <div style={{ fontSize: 11, color: "var(--text-secondary, #888)" }}>
          Clearing the text removes the title from the chart.
        </div>
      </DialogSection>
      <DialogSection title="Font">
        <ColorField
          label="Colour"
          value={storedColour}
          fallback={isChartTitle ? theme.titleColor : theme.axisTitleColor}
          onChange={(hex) => setColour(hex)}
          onClear={() => setColour(undefined)}
          onPreview={showColour}
        />
        <NumberField
          label="Size (px)"
          value={storedSize ?? null}
          placeholder={String(isChartTitle ? theme.titleFontSize : theme.axisTitleFontSize)}
          onCommit={(n) => setSize(n === null ? undefined : n)}
        />
      </DialogSection>
    </>
  );
}

const TICK_OPTIONS: Array<[TickMarkType, string]> = [
  ["none", "None"],
  ["inside", "Inside"],
  ["outside", "Outside"],
  ["cross", "Cross"],
];

const LABEL_POSITION_OPTIONS: Array<[AxisLabelPosition, string]> = [
  ["nextToAxis", "Next to axis"],
  ["high", "High"],
  ["low", "Low"],
  ["none", "None"],
];

const CROSSES_OPTIONS: Array<[AxisCrossesAt, string]> = [
  ["auto", "Automatic"],
  ["min", "Minimum"],
  ["max", "Maximum"],
  ["value", "At value"],
];

const DISPLAY_UNIT_OPTIONS: Array<[DisplayUnit, string]> = [
  ["none", "None"],
  ["hundreds", "Hundreds"],
  ["thousands", "Thousands"],
  ["tenThousands", "Ten thousands"],
  ["hundredThousands", "Hundred thousands"],
  ["millions", "Millions"],
  ["billions", "Billions"],
  ["trillions", "Trillions"],
];

const SCALE_OPTIONS: Array<["linear" | "log" | "pow" | "sqrt", string]> = [
  ["linear", "Linear"],
  ["log", "Logarithmic"],
  ["pow", "Power"],
  ["sqrt", "Square root"],
];

function AxisSections({
  chartId,
  axisType,
  tab,
}: {
  chartId: string;
  axisType: "x" | "y";
  tab: ChartFormatTabId;
}): React.ReactElement {
  const chart = getChartById(chartId);
  const axis = axisType === "x" ? chart?.spec.xAxis : chart?.spec.yAxis;
  const theme = resolveChartTheme(chart?.spec.config);
  const isValueAxis = axisType === "y";
  const set = (patch: Partial<AxisSpec>): void => commitAxisPatch(chartId, axisType, patch);

  if (axis === undefined) {
    return <div className={s.empty}>This chart has no {axisType.toUpperCase()} axis.</div>;
  }

  if (tab === "fill") {
    return (
      <>
        <DialogSection title="Axis line">
          <CheckField
            label="Show axis line"
            checked={axis.showLine !== false}
            onChange={(on) => set({ showLine: on })}
          />
          <ColorField
            label="Line colour"
            value={axis.lineColor}
            fallback={theme.axisColor}
            onChange={(hex) => set({ lineColor: hex })}
            onClear={() => set({ lineColor: undefined })}
            onPreview={(hex) => previewAxisPatch(chartId, axisType, { lineColor: hex })}
          />
          <NumberField
            label="Line width"
            value={axis.lineWidth ?? null}
            placeholder="1"
            onCommit={(n) => set({ lineWidth: n === null ? undefined : n })}
          />
        </DialogSection>
        <DialogSection title="Gridlines">
          <CheckField
            label="Show gridlines"
            checked={axis.gridLines === true}
            onChange={(on) => set({ gridLines: on })}
          />
        </DialogSection>
      </>
    );
  }

  if (tab === "text") {
    return (
      <DialogSection title="Axis title">
        <TextField
          label="Text"
          value={axis.title ?? ""}
          placeholder="(no title)"
          onChange={(next) => set({ title: next === "" ? null : next })}
        />
        <ColorField
          label="Label colour"
          value={chart?.spec.config?.theme?.axisLabelColor}
          fallback={theme.axisLabelColor}
          onChange={(hex) => commitThemePatch(chartId, { axisLabelColor: hex })}
          onClear={() => commitThemePatch(chartId, { axisLabelColor: undefined })}
          onPreview={(hex) => previewThemePatch(chartId, { axisLabelColor: hex })}
        />
      </DialogSection>
    );
  }

  return (
    <>
      {isValueAxis && (
        <DialogSection title="Bounds">
          <NumberField
            label="Minimum"
            value={axis.min}
            onCommit={(n) => set({ min: n })}
          />
          <NumberField
            label="Maximum"
            value={axis.max}
            onCommit={(n) => set({ max: n })}
          />
          <NumberField
            label="Major unit"
            value={axis.majorUnit ?? null}
            onCommit={(n) => set({ majorUnit: n })}
          />
          <NumberField
            label="Minor unit"
            value={axis.minorUnit ?? null}
            onCommit={(n) => set({ minorUnit: n })}
          />
        </DialogSection>
      )}

      <DialogSection title="Scale">
        {isValueAxis && (
          <SelectField<"linear" | "log" | "pow" | "sqrt">
            label="Type"
            value={(axis.scale?.type as "linear" | "log" | "pow" | "sqrt") ?? "linear"}
            options={SCALE_OPTIONS}
            onChange={(type) => set({ scale: { ...(axis.scale ?? {}), type } })}
          />
        )}
        <CheckField
          label="Values in reverse order"
          checked={axis.scale?.reverse === true}
          onChange={(on) => set({ scale: { ...(axis.scale ?? {}), reverse: on } })}
        />
        {isValueAxis && (
          <>
            <SelectField<DisplayUnit>
              label="Display units"
              value={axis.displayUnit ?? "none"}
              options={DISPLAY_UNIT_OPTIONS}
              onChange={(displayUnit) => set({ displayUnit })}
            />
            {(axis.displayUnit ?? "none") !== "none" && (
              <CheckField
                label="Show display unit label"
                checked={axis.showDisplayUnitLabel === true}
                onChange={(on) => set({ showDisplayUnitLabel: on })}
              />
            )}
          </>
        )}
        <SelectField<AxisCrossesAt>
          label="Crosses at"
          value={axis.crossesAt ?? "auto"}
          options={CROSSES_OPTIONS}
          onChange={(crossesAt) => set({ crossesAt })}
        />
        {axis.crossesAt === "value" && (
          <NumberField
            label="Cross value"
            value={axis.crossesAtValue ?? null}
            placeholder="0"
            onCommit={(n) => set({ crossesAtValue: n === null ? undefined : n })}
          />
        )}
      </DialogSection>

      <DialogSection title="Tick marks">
        <SelectField<TickMarkType>
          label="Major type"
          value={axis.majorTickMark ?? "outside"}
          options={TICK_OPTIONS}
          onChange={(majorTickMark) => set({ majorTickMark })}
        />
        <SelectField<TickMarkType>
          label="Minor type"
          value={axis.minorTickMark ?? "none"}
          options={TICK_OPTIONS}
          onChange={(minorTickMark) => set({ minorTickMark })}
        />
      </DialogSection>

      <DialogSection title="Labels">
        <CheckField
          label="Show axis labels"
          checked={axis.showLabels !== false}
          onChange={(on) => set({ showLabels: on })}
        />
        <SelectField<AxisLabelPosition>
          label="Position"
          value={axis.labelPosition ?? "nextToAxis"}
          options={LABEL_POSITION_OPTIONS}
          onChange={(labelPosition) => set({ labelPosition })}
        />
        <NumberField
          label="Label angle"
          value={axis.labelAngle ?? 0}
          placeholder="0"
          onCommit={(n) => set({ labelAngle: n ?? 0 })}
        />
        <TextField
          label="Number format"
          value={axis.tickFormat ?? ""}
          placeholder="e.g. $,.0f or .1%"
          onChange={(next) => set({ tickFormat: next === "" ? undefined : next })}
        />
      </DialogSection>
    </>
  );
}

function LegendSections({
  chartId,
  tab,
}: {
  chartId: string;
  tab: ChartFormatTabId;
}): React.ReactElement {
  const chart = getChartById(chartId);
  const legend = chart?.spec.legend;
  const theme = resolveChartTheme(chart?.spec.config);

  const set = (patch: Partial<{ visible: boolean; position: "top" | "bottom" | "left" | "right" }>): void => {
    applySpecPatch(chartId, (spec) => ({ legend: { ...spec.legend, ...patch } }));
  };

  if (tab === "text") {
    return (
      <DialogSection title="Legend text">
        <ColorField
          label="Colour"
          value={chart?.spec.config?.theme?.legendTextColor}
          fallback={theme.legendTextColor}
          onChange={(hex) => commitThemePatch(chartId, { legendTextColor: hex })}
          onClear={() => commitThemePatch(chartId, { legendTextColor: undefined })}
          onPreview={(hex) => previewThemePatch(chartId, { legendTextColor: hex })}
        />
        <NumberField
          label="Size (px)"
          value={chart?.spec.config?.theme?.legendFontSize ?? null}
          placeholder={String(theme.legendFontSize)}
          onCommit={(n) => commitThemePatch(chartId, { legendFontSize: n === null ? undefined : n })}
        />
      </DialogSection>
    );
  }

  return (
    <DialogSection title="Legend">
      <CheckField
        label="Show legend"
        checked={legend?.visible !== false}
        onChange={(visible) => set({ visible })}
      />
      <SelectField<"top" | "bottom" | "left" | "right">
        label="Position"
        value={legend?.position ?? "right"}
        options={[
          ["top", "Top"],
          ["bottom", "Bottom"],
          ["left", "Left"],
          ["right", "Right"],
        ]}
        onChange={(position) => set({ position })}
      />
    </DialogSection>
  );
}

function PlotAreaSections({ chartId }: { chartId: string }): React.ReactElement {
  const chart = getChartById(chartId);
  const theme = resolveChartTheme(chart?.spec.config);
  return (
    <DialogSection title="Plot area fill">
      <ColorField
        label="Background"
        value={chart?.spec.config?.theme?.plotBackground}
        fallback={theme.plotBackground}
        onChange={(hex) => commitThemePatch(chartId, { plotBackground: hex })}
        onClear={() => commitThemePatch(chartId, { plotBackground: undefined })}
        onPreview={(hex) => previewThemePatch(chartId, { plotBackground: hex })}
      />
    </DialogSection>
  );
}

function ChartAreaSections({
  chartId,
  tab,
}: {
  chartId: string;
  tab: ChartFormatTabId;
}): React.ReactElement {
  const chart = getChartById(chartId);
  const theme = resolveChartTheme(chart?.spec.config);

  if (tab === "text") {
    return (
      <DialogSection title="Chart font">
        <TextField
          label="Font family"
          value={chart?.spec.config?.theme?.fontFamily ?? ""}
          placeholder={theme.fontFamily}
          onChange={(next) => commitThemePatch(chartId, { fontFamily: next === "" ? undefined : next })}
        />
        <NumberField
          label="Label size"
          value={chart?.spec.config?.theme?.labelFontSize ?? null}
          placeholder={String(theme.labelFontSize)}
          onCommit={(n) => commitThemePatch(chartId, { labelFontSize: n === null ? undefined : n })}
        />
      </DialogSection>
    );
  }

  return (
    <DialogSection title="Chart area fill">
      <ColorField
        label="Background"
        value={chart?.spec.config?.theme?.background}
        fallback={theme.background}
        onChange={(hex) => commitThemePatch(chartId, { background: hex })}
        onClear={() => commitThemePatch(chartId, { background: undefined })}
        onPreview={(hex) => previewThemePatch(chartId, { background: hex })}
      />
    </DialogSection>
  );
}

// ============================================================================
// The pane
// ============================================================================

/** Identity of the thing being formatted, used to reseed local field state. */
function subjectKey(sel: ChartSelectionSnapshot): string {
  return [
    sel.chartId ?? "",
    sel.level,
    sel.elementId ?? "",
    sel.axisType ?? "",
    sel.seriesIndex ?? "",
    sel.categoryIndex ?? "",
  ].join("|");
}

/**
 * The Reset to Match Style control.
 *
 * DISABLED rather than hidden: the pane is a properties surface, and a greyed
 * control with its scope written beside it teaches what a reset WOULD do here.
 * (The context menu hides its twin instead, for the opposite reason — a menu
 * item that does nothing trains the reader to skip the menu.)
 *
 * Both the enabled state and the click go through the same resolver, so the
 * button cannot offer a reset that then does nothing.
 */
function ResetToMatchStyleRow({
  chartId,
  selection,
}: {
  chartId: string;
  selection: ChartSelectionSnapshot;
}): React.ReactElement {
  const scope = resetScopeForSelection(chartId, selection);
  const pending = pendingResetPatch(chartId, selection);
  return (
    <div className={s.resetRow}>
      <button
        type="button"
        className={s.reset}
        data-testid="chart-reset-to-match-style"
        data-reset-scope={scope.level}
        disabled={pending === null}
        title={
          pending === null
            ? `Nothing manual on ${RESET_SCOPE_DESCRIPTION[scope.level]}.`
            : `Reset ${RESET_SCOPE_DESCRIPTION[scope.level]} to the chart style.`
        }
        onClick={() => commitResetToMatchStyle(chartId, selection)}
      >
        Reset to Match Style
      </button>
      <span className={s.resetScope}>{RESET_SCOPE_DESCRIPTION[scope.level]}</span>
    </div>
  );
}

export function ChartFormatPane(_props: TaskPaneViewProps): React.ReactElement {
  // The target comes from the registry, NOT from `_props.data` — see the header.
  const [selection, setSelection] = useState<ChartSelectionSnapshot>(() => getChartSelection());
  useEffect(() => {
    setSelection(getChartSelection());
    return onChartSelectionChanged((next) => setSelection(next));
  }, []);

  // EXIT PATH — the SUBJECT changed (a different bar, a different chart, or a
  // deselect). Keyed on the subject rather than on "a snapshot arrived": the
  // republish that follows the preview's own repaint carries the SAME subject
  // with a display name derived from the just-invalidated render cache, and
  // restoring on that would kill every preview the instant it appeared.
  const currentSubject = subjectKey(selection);
  useEffect(() => {
    endChartSpecPreview();
  }, [currentSubject]);

  // EXIT PATH — the pane closed. A preview that outlived its pane would sit on
  // the chart with no control left on screen to take it back.
  useEffect(() => endChartSpecPreview, []);

  // Spec edits land in the store synchronously; the pane reads the store on
  // every render, so it only needs to be told to render again.
  const [, bumpSpec] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const onUpdated = (): void => bumpSpec();
    window.addEventListener(ChartEvents.CHART_UPDATED, onUpdated);
    return () => window.removeEventListener(ChartEvents.CHART_UPDATED, onUpdated);
  }, []);

  const subject = formatSubjectOf(selection);
  const tabs = useMemo(() => tabsForSubject(subject), [subject]);

  // The reader's LAST DELIBERATE CHOICE, kept apart from the tab on screen so a
  // retarget through an element that lacks it does not forget it.
  const [preferredTab, setPreferredTab] = useState<ChartFormatTabId | null>(null);
  const activeTab = resolveActiveTab(tabs, preferredTab);

  const chartId = selection.chartId;
  const onPickTab = useCallback((tab: ChartFormatTabId) => setPreferredTab(tab), []);

  if (chartId === null || subject === "none") {
    return (
      <div className={s.pane}>
        <div className={s.empty}>
          Select a chart, then click the part you want to format — a bar, the title, an
          axis or the legend. This pane always shows the current selection; the Chart
          Design tab configures the whole chart.
        </div>
      </div>
    );
  }

  const body = ((): React.ReactNode => {
    if (activeTab === null) return null;
    switch (subject) {
      case "dataPoint":
        return (
          <DataPointSections
            chartId={chartId}
            tab={activeTab}
            seriesIndex={selection.seriesIndex ?? 0}
            categoryIndex={selection.categoryIndex ?? 0}
          />
        );
      case "series":
        return <SeriesSections chartId={chartId} seriesIndex={selection.seriesIndex ?? 0} />;
      case "title":
      case "xAxisTitle":
      case "yAxisTitle":
        return <TitleSections chartId={chartId} subject={subject} />;
      case "axis":
        return (
          <AxisSections
            chartId={chartId}
            axisType={selection.axisType ?? (selection.elementId === "yAxis" ? "y" : "x")}
            tab={activeTab}
          />
        );
      case "legend":
      case "legendEntry":
        return <LegendSections chartId={chartId} tab={activeTab} />;
      case "plotArea":
        return <PlotAreaSections chartId={chartId} />;
      case "chartArea":
        return <ChartAreaSections chartId={chartId} tab={activeTab} />;
      default:
        return null;
    }
  })();

  return (
    <div className={s.pane} data-testid="chart-format-pane">
      <div className={s.header}>
        <div className={s.subject} data-testid="chart-format-subject">
          Format {selection.displayName}
        </div>
        <div className={s.chart}>{selection.chartName}</div>
        {/* Outside the keyed body: the reset is a property of the SELECTION,
            not of the active tab, and it must not be remounted by a retarget. */}
        <ResetToMatchStyleRow chartId={chartId} selection={selection} />
      </div>

      {tabs.length > 1 && (
        <div className={s.tabs} role="tablist">
          {tabs.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={tab === activeTab}
              className={`${s.tab} ${tab === activeTab ? s.tabActive : ""}`}
              onClick={() => onPickTab(tab)}
            >
              {CHART_FORMAT_TAB_LABELS[tab]}
            </button>
          ))}
        </div>
      )}

      {/* Keyed on the SUBJECT so every field's local draft reseeds on a
          retarget — without it, typing "12" into one bar's border width and
          then clicking the next bar would leave "12" in the box over a datum
          that has no border at all. */}
      <div className={s.body} key={subjectKey(selection)}>
        {body}
      </div>
    </div>
  );
}
