//! FILENAME: app/extensions/Charts/handlers/chartTextEditing.ts
// PURPOSE: The chart's TEXT gestures — double-click a title or an axis title
//          and type it in place, as in Excel — plus the one uniform rule for
//          what a double-click on every OTHER chart element means.
// CONTEXT: This wires three things that already exist and had never met:
//          Wave A's `OverlayRegistration.onDoubleClick` (@api/gridOverlays) and
//          `openOverlayTextEditor` (@api/overlayTextEditor), Wave B's measured
//          `layout.elements` rects, and CI-7's `ChartElementId` taxonomy. It
//          owns no DOM, no rect arithmetic that the painters already did, and
//          no second copy of the element taxonomy.
//
// ===========================================================================
// THE TRAP THAT WOULD SILENTLY DESTROY A CELL LINK
// ===========================================================================
// A chart title may be a cell reference: `=Sheet1!A1`. `resolveSpecReferences`
// (lib/dataSourceResolver.ts) returns a NEW spec whose `title`,
// `xAxis.title` and `yAxis.title` are the RESOLVED STRINGS, and that resolved
// spec is what reaches the layout, the painters and therefore `layout.elements`.
//
// So the two halves of this editor read from two DIFFERENT specs, on purpose:
//
//   * the TEXT comes from the RAW store spec — `getChartById(id).spec` — because
//     seeding it from the render spec would open the editor showing "Revenue"
//     and commit the literal string "Revenue", silently replacing the link with
//     a frozen copy of what it happened to say that morning. Nothing would
//     report an error; the chart would simply stop tracking the cell.
//   * the RECT comes from the RESOLVED layout, because that is where the glyphs
//     actually are. A box measured from `=Sheet1!A1` would be the wrong size and
//     in the wrong place.
//
// `rawChartTextValue` is the only reader of the title fields here and it takes a
// spec argument, so the mistake cannot be made by reaching for a module global.
//
// ===========================================================================
// WHY A DOUBLE-CLICK'S ANSWER IS COMPUTED FROM THE PIXEL AND NOTHING ELSE
// ===========================================================================
// `handleFloatingSelected` (index.ts) sets a pending ladder click only when the
// chart is ALREADY selected. So the two clicks inside one double-click advance
// the selection ladder a different number of times depending on what was
// selected before the gesture started: once on a fresh chart (chart -> series),
// twice on an already-selected one (chart -> series -> dataPoint). Same gesture,
// two answers — and by the time `dblclick` reaches us both mouseups have
// already run, so there is nothing left to intercept.
//
// The rule here is therefore: A DOUBLE-CLICK IS ONE GESTURE, SO IT GETS ONE
// ANSWER, and that answer is a function of what is under the pointer alone. It
// OVERWRITES whatever the two intermediate clicks did to the ladder. A datum
// double-click always lands on the SERIES — Excel's "Format Data Series", which
// is also what a fresh chart does today, so the common case is unchanged.
// Reaching one individual data point stays the slow single-click ladder, where
// "which point" is a deliberate, visible choice the reader can see happening.
// `subSelectionForDoubleClick` is that rule, it is pure, and it is tested.
//
// ===========================================================================
// THE Y AXIS TITLE IS EDITED HORIZONTALLY, DELIBERATELY
// ===========================================================================
// The y-axis title is painted rotated -90deg, so its layout rect is TALL and one
// font-size WIDE (`recordYAxisTitleRect`, chartPainterUtils). A `<textarea>`
// cannot be rotated in place without the caret and the selection geometry going
// with it. The editor is therefore a horizontal box on the same CENTRE; the
// title returns to its rotation the moment it is committed. This is the one
// place the in-place editor is not pixel-faithful, and it is stated here rather
// than discovered.

import {
  openOverlayTextEditor,
  type OverlayTextEditorHandle,
  type OverlayTextEditorRect,
} from "@api/overlayTextEditor";
import { requestOverlayRedraw, type OverlayHitTestContext } from "@api/gridOverlays";
import { emitAppEvent } from "@api/events";
import type {
  ChartElementId,
  ChartElementRect,
  ChartHitResult,
  ChartSpec,
  ChartSubSelection,
} from "../types";
import { getChartById, updateChartSpec } from "../lib/chartStore";
import {
  getCachedChartData,
  getChartLocalCoords,
  invalidateChartCache,
} from "../rendering/chartRenderer";
import { chartElementOf, hitTestGeometry } from "../rendering/chartHitTesting";
import { resolveChartTheme } from "../rendering/chartTheme";
import {
  getSubSelection,
  isChartSelected,
  selectChart,
  setSubSelection,
} from "./selectionHandler";

// ============================================================================
// Contract
// ============================================================================

/**
 * A double-click on a chart element that is NOT editable text asks for that
 * element's Format surface. The pane that shows it is a separate item; this
 * extension announces the request and does not care who answers.
 *
 * The payload describes THE SELECTION the double-click just made — the same
 * thing `getSubSelection()` now reports — rather than a second, parallel
 * description of the hit. One fact, one spelling.
 */
export const CHART_FORMAT_ELEMENT_EVENT = "chart:format-element";

/** Payload of {@link CHART_FORMAT_ELEMENT_EVENT}. */
export interface ChartFormatElementDetail {
  chartId: string;
  /** Which element to format. Never a text element — those open the editor. */
  elementId: ChartElementId;
  /** Series index, for `datum` and `legendEntry`. */
  seriesIndex?: number;
  /** Which axis, for `xAxis` / `yAxis`. */
  axisType?: "x" | "y";
}

/**
 * The chart elements whose content is EDITABLE TEXT held in the spec.
 *
 * Derived nowhere and re-typed nowhere: every other element in
 * {@link ChartElementId} either has no text (plot area, datum) or has text the
 * spec does not own (axis tick labels come from the data). Adding a member here
 * means adding a spec field to {@link rawChartTextValue} and
 * {@link chartTextSpecPatch}, both of which switch exhaustively.
 */
export const CHART_TEXT_ELEMENT_IDS = ["title", "xAxisTitle", "yAxisTitle"] as const;

/** A chart element the reader can type into. */
export type ChartTextElementId = (typeof CHART_TEXT_ELEMENT_IDS)[number];

/** Is this element one the reader can type into? */
export function isChartTextElement(id: ChartElementId | undefined): id is ChartTextElementId {
  return id !== undefined && (CHART_TEXT_ELEMENT_IDS as readonly string[]).includes(id);
}

/** What a double-click on a chart resolves to. */
export type ChartDoubleClickAction =
  | { kind: "editText"; elementId: ChartTextElementId }
  | { kind: "format"; elementId: ChartElementId; seriesIndex?: number; axisType?: "x" | "y" }
  | { kind: "none" };

// ============================================================================
// Editor geometry
// ============================================================================

/** Horizontal breathing room around the measured glyph box, in chart-local px. */
export const CHART_TEXT_EDITOR_PAD_X = 8;
/** Vertical breathing room around the measured glyph box, in chart-local px. */
export const CHART_TEXT_EDITOR_PAD_Y = 4;
/** Narrowest the editor may get, so a one-letter title is still clickable. */
export const CHART_TEXT_EDITOR_MIN_WIDTH = 72;

/**
 * The editor box for a measured element rect, in CHART-LOCAL px.
 *
 * Pure, so the rotation decision above is a tested fact rather than a comment.
 * Grows about the rect's CENTRE, which is what keeps a centred title centred.
 */
export function editorBoxForElement(
  elementId: ChartTextElementId,
  rect: ChartElementRect,
): ChartElementRect {
  const centreX = rect.x + rect.width / 2;
  const centreY = rect.y + rect.height / 2;
  // The rotated title's rect is tall-and-thin; un-rotate it by swapping which
  // side is the run of glyphs and which is the line height.
  const rotated = elementId === "yAxisTitle";
  const along = rotated ? rect.height : rect.width;
  const across = rotated ? rect.width : rect.height;
  const width = Math.max(along + CHART_TEXT_EDITOR_PAD_X * 2, CHART_TEXT_EDITOR_MIN_WIDTH);
  const height = across + CHART_TEXT_EDITOR_PAD_Y * 2;
  return { x: centreX - width / 2, y: centreY - height / 2, width, height };
}

/** The measured (or estimated) rect for one text element, or undefined. */
function elementRectOf(chartId: string, elementId: ChartTextElementId): ChartElementRect | undefined {
  const elements = getCachedChartData(chartId)?.layout?.elements;
  if (!elements) return undefined;
  switch (elementId) {
    case "title":
      return elements.title;
    case "xAxisTitle":
      return elements.xAxisTitle;
    case "yAxisTitle":
      return elements.yAxisTitle;
  }
}

/**
 * Where the editor belongs RIGHT NOW, in logical canvas px — the space
 * `openOverlayTextEditor` measures in, and the same space the overlay hit-test
 * reports `canvasX`/`canvasY` in.
 *
 * Called EVERY frame by the seam, and computed from scratch every time: the
 * chart's canvas origin is a function of the live scroll offset and the header
 * sizes, so a rect captured once drifts the first time the reader scrolls.
 * `getChartLocalCoords(id, 0, 0)` is the chart's origin read backwards — it
 * answers "where is canvas 0,0 in chart-local space", and negating it gives the
 * chart's top-left in canvas space without this module owning a second copy of
 * the scroll arithmetic.
 *
 * Returns null — which hides the editor without ending the session — while the
 * object is being dragged or resized, when the chart is gone, and when the
 * element has no rect (an absent title has nothing to sit on).
 */
export function chartTextEditorRect(
  chartId: string,
  elementId: ChartTextElementId,
): OverlayTextEditorRect | null {
  if (dragActiveChartId === chartId) return null;
  if (!getChartById(chartId)) return null;
  const rect = elementRectOf(chartId, elementId);
  if (!rect) return null;
  const inverseOrigin = getChartLocalCoords(chartId, 0, 0);
  if (!inverseOrigin) return null;
  const box = editorBoxForElement(elementId, rect);
  return {
    x: box.x - inverseOrigin.localX,
    y: box.y - inverseOrigin.localY,
    width: box.width,
    height: box.height,
  };
}

// ============================================================================
// Reading and writing the RAW spec
// ============================================================================

/**
 * The stored text of one element, straight from the RAW spec — `null` when the
 * element has no title at all, and possibly a formula such as `=Sheet1!A1`.
 *
 * Takes the spec as an argument on purpose: see the header. The caller must
 * hand it `getChartById(id).spec` and never a resolved render spec.
 */
export function rawChartTextValue(spec: ChartSpec, elementId: ChartTextElementId): string | null {
  switch (elementId) {
    case "title":
      return spec.title ?? null;
    case "xAxisTitle":
      return spec.xAxis?.title ?? null;
    case "yAxisTitle":
      return spec.yAxis?.title ?? null;
  }
}

/** The spec patch that writes `value` into one element's title field. */
export function chartTextSpecPatch(
  spec: ChartSpec,
  elementId: ChartTextElementId,
  value: string | null,
): Partial<ChartSpec> {
  switch (elementId) {
    case "title":
      return { title: value };
    case "xAxisTitle":
      return { xAxis: { ...spec.xAxis, title: value } };
    case "yAxisTitle":
      return { yAxis: { ...spec.yAxis, title: value } };
  }
}

/**
 * Write an edited title back.
 *
 * Empty text means NO TITLE, not an empty title: `spec.title === null` is how a
 * chart says it has none, and clearing the box is how Excel removes one. A
 * value identical to what is already stored writes nothing at all, so clicking
 * away from an untouched title does not produce a backend update or an undo
 * entry.
 *
 * Returns true when the store was actually written.
 */
export function commitChartText(
  chartId: string,
  elementId: ChartTextElementId,
  text: string,
): boolean {
  const chart = getChartById(chartId);
  if (!chart) return false;
  const next = text.trim() === "" ? null : text;
  if (rawChartTextValue(chart.spec, elementId) === next) return false;
  // `updateChartSpec` is the existing 300ms-debounced path: ONE backend update
  // and ONE `record_chart_undo` entry for the whole edit, however many
  // keystrokes it took.
  updateChartSpec(chartId, chartTextSpecPatch(chart.spec, elementId, next));
  invalidateChartCache(chartId);
  requestOverlayRedraw();
  return true;
}

/**
 * Remove a title outright — the Delete key on a selected title.
 *
 * This is the other way `spec.title === null` becomes reachable from the UI.
 * Putting a removed title BACK is the Chart Elements checkbox, which is a
 * separate item; until it lands, re-adding one means the Design panel's title
 * field or the spec editor.
 */
export function clearChartText(chartId: string, elementId: ChartTextElementId): boolean {
  const chart = getChartById(chartId);
  if (!chart) return false;
  if (rawChartTextValue(chart.spec, elementId) === null) return false;
  updateChartSpec(chartId, chartTextSpecPatch(chart.spec, elementId, null));
  invalidateChartCache(chartId);
  requestOverlayRedraw();
  return true;
}

// ============================================================================
// Session state
// ============================================================================

interface ActiveTextEdit {
  chartId: string;
  elementId: ChartTextElementId;
  handle: OverlayTextEditorHandle;
}

/** At most one chart text edit at a time — the seam enforces the same rule. */
let activeTextEdit: ActiveTextEdit | null = null;

/**
 * The chart currently being dragged or resized, so {@link chartTextEditorRect}
 * can hide rather than chase it. Set from index.ts's floating-object handlers,
 * which are the only place that knows a drag is live.
 */
let dragActiveChartId: string | null = null;

/** Note that a chart is (or is no longer) being dragged or resized. */
export function setChartDragActive(chartId: string | null): void {
  dragActiveChartId = chartId;
}

/** The live chart text edit, or null. */
export function getActiveChartTextEdit(): { chartId: string; elementId: ChartTextElementId } | null {
  return activeTextEdit === null
    ? null
    : { chartId: activeTextEdit.chartId, elementId: activeTextEdit.elementId };
}

/** Drop all text-editing state (extension deactivation). */
export function resetChartTextEditing(): void {
  const session = activeTextEdit;
  activeTextEdit = null;
  dragActiveChartId = null;
  // `enterInserts` editors have no cancelling KEY, so the caller is the only
  // thing that can discard one — and a teardown must discard rather than
  // commit, or unloading the extension would write the half-typed text.
  if (session) session.handle.cancel();
}

// ============================================================================
// Opening the editor
// ============================================================================

/**
 * Open the in-place editor on one of a chart's text elements.
 *
 * Returns the handle, or null when there is nothing to edit (unknown chart) or
 * no grid to edit it on — the seam hands back a closed handle when the canvas
 * layer is not mounted, and a closed handle must never be recorded as the live
 * session.
 */
export function openChartTextEditor(
  chartId: string,
  elementId: ChartTextElementId,
): OverlayTextEditorHandle | null {
  const chart = getChartById(chartId);
  if (!chart) return null;

  const theme = resolveChartTheme(chart.spec.config);
  const isMainTitle = elementId === "title";

  // RAW, not resolved. The whole reason this module exists — see the header.
  const initialText = rawChartTextValue(chart.spec, elementId) ?? "";

  const session = { chartId, elementId } as ActiveTextEdit;

  const handle = openOverlayTextEditor({
    getRect: () => chartTextEditorRect(chartId, elementId),
    initialText,
    multiline: true,
    // Excel's chart-title rule: Enter inserts a newline and the edit is
    // committed by clicking outside. There is no cancelling key there.
    enterInserts: true,
    // Typing '=' and then clicking a cell yields '=Sheet1!A1', which is exactly
    // the cell-linked title `resolveSpecReferences` already resolves and
    // `chartInvalidation` already watches. No new storage is involved.
    acceptsFormulaReferences: true,
    selectAll: true,
    textAlign: "center",
    font: {
      sizePx: isMainTitle ? theme.titleFontSize : theme.axisTitleFontSize,
      family: theme.fontFamily,
      weight: isMainTitle ? 600 : "normal",
      color: isMainTitle ? theme.titleColor : theme.axisTitleColor,
    },
    owner: `charts:text:${elementId}`,
    onCommit: (text) => {
      if (activeTextEdit === session) activeTextEdit = null;
      commitChartText(chartId, elementId, text);
    },
    onCancel: () => {
      if (activeTextEdit === session) activeTextEdit = null;
    },
  });

  if (!handle.isOpen()) return null;
  session.handle = handle;
  activeTextEdit = session;
  return handle;
}

// ============================================================================
// The gestures
// ============================================================================

/**
 * What a double-click at this canvas point means for this chart.
 *
 * Pure with respect to selection state: it looks at the pixel and nothing else,
 * which is the determinism rule stated in the header.
 */
export function resolveChartDoubleClick(
  chartId: string,
  canvasX: number,
  canvasY: number,
): ChartDoubleClickAction {
  const cached = getCachedChartData(chartId);
  if (!cached) return { kind: "none" };
  const local = getChartLocalCoords(chartId, canvasX, canvasY);
  if (!local) return { kind: "none" };

  const hit = hitTestGeometry(local.localX, local.localY, cached.hitGeometry, cached.layout);
  const element = chartElementOf(hit);

  if (isChartTextElement(element)) return { kind: "editText", elementId: element };
  // "none" is CI-7's word for "outside the object", which a double-click that
  // Core routed to this overlay cannot be — but a stale cache can produce it,
  // and formatting nothing is not a thing to ask for.
  if (element === "none") return { kind: "none" };
  if (element === "xAxis" || element === "yAxis") {
    return {
      kind: "format",
      elementId: element,
      axisType: hit.axisType ?? (element === "yAxis" ? "y" : "x"),
    };
  }
  if (element === "datum" || element === "legendEntry") {
    return { kind: "format", elementId: element, seriesIndex: hit.seriesIndex };
  }
  return { kind: "format", elementId: element };
}

/**
 * The ONE selection a double-click leaves behind, from the action alone.
 *
 * A datum lands on its SERIES, never on the individual point: see the header
 * for why the gesture refuses to depend on what was selected before it.
 */
export function subSelectionForDoubleClick(action: ChartDoubleClickAction): ChartSubSelection | null {
  switch (action.kind) {
    case "none":
      return null;
    case "editText":
      return { level: "element", elementId: action.elementId };
    case "format":
      if (action.elementId === "xAxis" || action.elementId === "yAxis") {
        return { level: "axis", axisType: action.axisType ?? (action.elementId === "yAxis" ? "y" : "x") };
      }
      if (action.elementId === "datum") {
        return action.seriesIndex === undefined
          ? { level: "chart" }
          : { level: "series", seriesIndex: action.seriesIndex };
      }
      if (action.elementId === "legendEntry") {
        return { level: "element", elementId: "legendEntry", seriesIndex: action.seriesIndex };
      }
      if (action.elementId === "legend") return { level: "element", elementId: "legend" };
      // plotArea, chartArea, filterButton — the whole object.
      return { level: "chart" };
  }
}

/** Is this canvas point inside the rect? Inclusive, as the chart hit-tests are. */
function pointInRect(x: number, y: number, rect: OverlayTextEditorRect): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

/**
 * Core's `OverlayRegistration.onDoubleClick` for the chart overlay.
 *
 * Returns true when the gesture was taken. Returning false leaves it to Core,
 * which over a floating object is to do nothing — a double-click on a chart must
 * never open the cell editor hidden underneath it.
 */
export function handleChartDoubleClick(ctx: OverlayHitTestContext): boolean {
  const chartId = ctx.region.data?.chartId as string | undefined;
  if (chartId == null) return false;

  // A double-click INSIDE the open editor is the reader selecting a word. Core
  // already refuses it at the DOM door (its INPUT/TEXTAREA guard runs before
  // this), but that guard reads `event.target`; this one reads geometry, so the
  // rule survives a caller that has no DOM event — and re-entering here would
  // tear down the editor the reader is typing in.
  const live = activeTextEdit;
  if (live !== null && live.chartId === chartId && live.handle.isOpen()) {
    const rect = chartTextEditorRect(chartId, live.elementId);
    if (rect && pointInRect(ctx.canvasX, ctx.canvasY, rect)) return true;
  }

  const action = resolveChartDoubleClick(chartId, ctx.canvasX, ctx.canvasY);
  if (action.kind === "none") return false;

  if (!isChartSelected(chartId)) selectChart(chartId);
  const next = subSelectionForDoubleClick(action);
  if (next) setSubSelection(chartId, next);

  if (action.kind === "editText") {
    openChartTextEditor(chartId, action.elementId);
    return true;
  }

  emitAppEvent<ChartFormatElementDetail>(CHART_FORMAT_ELEMENT_EVENT, {
    chartId,
    elementId: action.elementId,
    seriesIndex: action.seriesIndex,
    axisType: action.axisType,
  });
  return true;
}

/**
 * Excel's OTHER way into the editor: the second of two SLOW single clicks on a
 * title that is already selected.
 *
 * Asked by index.ts's mouseup path BEFORE `advanceSelection`, because the ladder
 * would otherwise just select the same title again and the reader would never
 * get past selecting it. Returns true when the editor opened and the caller
 * should not advance the ladder.
 */
export function maybeEnterTextEditOnClick(chartId: string, hitResult: ChartHitResult): boolean {
  const element = chartElementOf(hitResult);
  if (!isChartTextElement(element)) return false;
  if (!isChartSelected(chartId)) return false;
  const sub = getSubSelection();
  if (sub.level !== "element" || sub.elementId !== element) return false;
  return openChartTextEditor(chartId, element) !== null;
}

/**
 * The Delete key over a selected title: clear it.
 *
 * Returns true when it took the keystroke, which is how index.ts knows not to
 * delete the whole chart instead.
 */
export function handleChartTextDelete(chartId: string): boolean {
  const sub = getSubSelection();
  if (sub.level !== "element") return false;
  if (!isChartTextElement(sub.elementId)) return false;
  return clearChartText(chartId, sub.elementId);
}
