//! FILENAME: app/extensions/Charts/lib/chartZoneAt.ts
// PURPOSE: The chart's `zoneAt` (BUG-0258 design phase 2): the ONE answer Core
//          derives the press, the hover pointer and the meaning of Ctrl/Shift
//          from (@api/gridOverlays `resolveFloatingZone`).
//            content, the chart's own BUTTONS (phase 4b) -- a selected chart's
//            pointer  quick-access buttons (outside its right edge), a pivot
//                     chart's field buttons, and a selected chart's
//                     bound-param widget controls (a +/- step or an option
//                     segment of its top-left strip) --
//                     `{kind:'content', cursor:'pointer',
//                     part:'quickAccess'|'fieldButton'|'widget'}`, from ONE
//                     hit test (lib/chartButtonPress.ts). Core selects the
//                     chart as a plain press and hands the press to
//                     `floatingObject:bodyDragStart`; the button acts when
//                     that press is RELEASED over the same button (index.ts
//                     `handleMouseUp`), and a drag from it never moves the
//                     chart -- locked or not, subscribed or not. The rest of
//                     the widget strip (its labels, the gaps) stays frame.
//            content  the PLOT AREA of a brushable, non-composed chart, off its
//                     param widgets -- `{kind:'content', cursor:'crosshair',
//                     part:'brush'}`. Core selects the chart as a plain press
//                     and hands the press to `floatingObject:bodyDragStart`,
//                     where the interval brush takes it (index.ts); the chart
//                     never moves from there.
//            frame    everything else (null): the chart moves by its body, as
//                     in Excel -- its bars, points, slices and axes included,
//                     and the insight overlay's cue stepper and comment boxes
//                     (D8: they act on the click that follows a frame press) --
//                     so the pointer there is 'move' (or 'default' when it
//                     cannot move), never a hand that promises a click the
//                     press would turn into a move.
// CONTEXT: It replaces the S6 per-press body-drag claim, with the SAME geometry minus
//          its `isChartSelected` gate. That gate only ever passed on the first
//          press because Core used to ask the claim AFTER the press had
//          selected the chart; Core now asks `zoneAt` BEFORE it selects
//          anything, so a gate on the chart's own selection would turn the
//          first press into a move. Without it the press is unchanged (the
//          first press on a brushable plot already brushed) and the hover is
//          honest: a crosshair over the plot of EVERY brushable chart, where
//          it used to promise a move the press would not make (owner-approved
//          answer). PURE: it reads the chart, its cached layout and its canvas
//          position, and writes nothing -- Core asks it on every hover move.
//
//          THE POINTER IS ONLY THIS ANSWER. The Charts mousemove used to write
//          `canvas.style.cursor = "pointer"` over any chart's bars, points,
//          slices, axes and buttons -- a second writer whose inline cursor on
//          the grid <canvas> overrode Core's (child over parent), so a
//          brushable plot showed a hand instead of the crosshair, a movable
//          chart's bars a hand instead of 'move', a locked chart's a hand
//          instead of 'default'. The buttons that really act on a click are
//          said here instead; src/api/__tests__/gridCanvasCursorCensus.test.ts
//          keeps the second writer from coming back.
//          The quick-access buttons and the widget controls are gated on the
//          chart's selection only because they EXIST only while it is selected
//          (painted and cached by the renderer then; the renderer keeps the
//          last positions after a deselect).

import type { OverlayZoneFn } from "@api/gridOverlays";
import { getChartById } from "./chartStore";
import { chartButtonAt } from "./chartButtonPress";
import { getCachedChartData, getChartLocalCoords } from "../rendering/chartRenderer";
import { isComposed } from "../rendering/chartDispatch";
import { isInWidgetArea } from "../rendering/paramWidgets";
import { SELECTION_SUPPORTED_MARKS } from "../handlers/chartPointSelection";

/** The zone a press or a hover at this point of a chart is in (null = frame). */
export const chartZoneAt: OverlayZoneFn = (ctx) => {
  const cid = ctx.region.data?.chartId as string | undefined;
  if (!cid) return null;
  const ch = getChartById(cid);
  if (!ch) return null;

  // The chart's own buttons: CONTENT with a hand -- they act on release.
  const button = chartButtonAt(cid, ctx.canvasX, ctx.canvasY);
  if (button) return { kind: "content", cursor: "pointer", part: button.part };

  const cached = getCachedChartData(cid);
  if (!SELECTION_SUPPORTED_MARKS.has(ch.spec.mark)) return null;
  if (!ch.spec.params?.some((p) => p.select === "point" && p.brush)) return null;
  const pa = cached?.layout?.plotArea;
  if (!cached || !pa) return null;
  // Composed charts (repeat/facet/concat) tile independent sub-scales; a
  // single brush rectangle across panels has no well-defined interval, so
  // the interval brush is OFF for them in v1. A plain click still selects a
  // panel datum (the mouseup hit-test path, not the body drag).
  if (cached.data && isComposed(ch.spec, cached.data)) return null;
  // The widget strip off its controls (labels, gaps) is frame, not the brush.
  if (cached.widgetControls && isInWidgetArea(ctx.canvasX, ctx.canvasY, cached.widgetControls)) return null;
  const loc = getChartLocalCoords(cid, ctx.canvasX, ctx.canvasY);
  if (!loc) return null;
  const inPlot =
    loc.localX >= pa.x && loc.localX <= pa.x + pa.width && loc.localY >= pa.y && loc.localY <= pa.y + pa.height;
  return inPlot ? { kind: "content", cursor: "crosshair", part: "brush" } : null;
};
