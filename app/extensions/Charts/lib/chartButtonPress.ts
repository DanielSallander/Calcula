//! FILENAME: app/extensions/Charts/lib/chartButtonPress.ts
// PURPOSE: The chart's own BUTTONS as ONE hit test: a selected chart's
//          quick-access buttons (outside its right edge), a pivot chart's field
//          buttons, and a selected chart's bound-param widget controls (the
//          +/- steps and option segments in its top-left strip). The zone
//          answer (chartZoneAt.ts) and the release (index.ts `handleMouseUp`)
//          both read it, so the hand the pointer shows, the press Core hands
//          over and the button that finally acts can never disagree.
// CONTEXT: BUG-0258 design phase 4b. The buttons used to be FRAME with a hand:
//          a press on one selected the chart and a drag from it MOVED the
//          chart, and the button acted on the click that happened to follow
//          (the pending sub-selection click, or on a first press a special
//          case for field buttons). They are CONTENT now: Core hands the press
//          to `floatingObject:bodyDragStart` and never moves the chart from
//          it, and the button acts only when the press is RELEASED over the
//          SAME button -- the key below names it (which quick-access button,
//          which pivot field, which widget param and step). Sliding off
//          cancels, as a Windows button does.
//
//          The quick-access buttons and the widget controls are gated on the
//          chart's selection because they EXIST only while it is selected:
//          the renderer paints and caches them then, and keeps the last
//          positions after a deselect. The field buttons are painted on every
//          pivot chart. PURE: it reads the cache and writes nothing.

import { getCachedChartData, getChartLocalCoords } from "../rendering/chartRenderer";
import { hitTestWidgetControls, type WidgetAction } from "../rendering/paramWidgets";
import { hitTestQuickAccessButtons, quickAccessButtonKey, type QuickAccessButton } from "../rendering/quickAccessButtons";
import { isChartSelected } from "../handlers/selectionHandler";
import type { ParamBinding, PivotChartFieldButton } from "../types";

/** The zone parts that are one of the chart's buttons (the brush is the other content part). */
export type ChartButtonPart = "quickAccess" | "fieldButton" | "widget";

const BUTTON_PARTS: ReadonlySet<string> = new Set<ChartButtonPart>(["quickAccess", "fieldButton", "widget"]);

/** Whether a zone part names one of the chart's buttons. */
export function isChartButtonPart(part: unknown): part is ChartButtonPart {
  return typeof part === "string" && BUTTON_PARTS.has(part);
}

/** A widget control's zone under a point: which param, and which step or option. */
export interface ChartWidgetHit {
  paramName: string;
  bind: ParamBinding;
  action: WidgetAction;
}

/** One of the chart's buttons under a point, with the key that names THAT button. */
export type ChartButtonHit =
  | { part: "quickAccess"; key: string; button: QuickAccessButton }
  | { part: "fieldButton"; key: string; button: PivotChartFieldButton }
  | { part: "widget"; key: string; control: ChartWidgetHit };

function fieldButtonKey(b: PivotChartFieldButton): string {
  const f = b.field as Partial<PivotChartFieldButton["field"]> | undefined;
  return `fieldButton|${f?.area ?? ""}|${f?.fieldIndex ?? ""}|${f?.name ?? ""}`;
}

function widgetKey(w: ChartWidgetHit): string {
  const step = "option" in w.action ? `option=${String(w.action.option)}` : `dir=${w.action.dir}`;
  return `widget|${w.paramName}|${step}`;
}

/**
 * The button of kind `part` under a logical canvas point of chart `chartId`,
 * or null. A release acts only when this names the SAME button (the same key)
 * at the release point as it did at the press point.
 */
export function chartButtonOfPart(
  chartId: string,
  part: ChartButtonPart,
  canvasX: number,
  canvasY: number,
): ChartButtonHit | null {
  const cached = getCachedChartData(chartId);
  if (!cached) return null;
  switch (part) {
    case "quickAccess": {
      const buttons = cached.quickAccessButtons;
      if (!buttons || buttons.length === 0 || !isChartSelected(chartId)) return null;
      const button = hitTestQuickAccessButtons(canvasX, canvasY, buttons);
      return button ? { part, key: `quickAccess|${quickAccessButtonKey(button)}`, button } : null;
    }
    case "fieldButton": {
      const buttons = cached.pivotFieldButtons;
      if (!buttons || buttons.length === 0) return null;
      const local = getChartLocalCoords(chartId, canvasX, canvasY);
      if (!local) return null;
      const button = buttons.find(
        (b) => local.localX >= b.x && local.localX <= b.x + b.width && local.localY >= b.y && local.localY <= b.y + b.height,
      );
      return button ? { part, key: fieldButtonKey(button), button } : null;
    }
    case "widget": {
      const controls = cached.widgetControls;
      if (!controls || controls.length === 0 || !isChartSelected(chartId)) return null;
      const control = hitTestWidgetControls(canvasX, canvasY, controls);
      return control ? { part, key: widgetKey(control), control } : null;
    }
  }
}

/** The first of the chart's buttons under a point -- quick-access, then a field button, then a widget control -- or null. */
export function chartButtonAt(chartId: string, canvasX: number, canvasY: number): ChartButtonHit | null {
  return (
    chartButtonOfPart(chartId, "quickAccess", canvasX, canvasY) ??
    chartButtonOfPart(chartId, "fieldButton", canvasX, canvasY) ??
    chartButtonOfPart(chartId, "widget", canvasX, canvasY)
  );
}
