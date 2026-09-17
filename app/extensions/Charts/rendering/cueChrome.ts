//! FILENAME: app/extensions/Charts/rendering/cueChrome.ts
// PURPOSE: The overlay's chrome: the stepper pill ("‹ 2 of 4 ›  Lowest Cost"),
//          the comment boxes beside cues, and the tray for comments whose fact
//          is gone. Computed, drawn and hit-tested per frame, the way the
//          bound-param widgets are (`paramWidgets.ts`).
// CONTEXT: docs/design/insight-overlays.md §4.8a. Stepping is the clutter
//          defence that replaced the cap of three: one point of interest at a
//          time, with a deterministic description, and *show all* one click
//          away. The pill sits in the chart's top-right so it never collides
//          with the param widgets in the top-left, and it is drawn only while
//          the chart carries cues. Everything here is composite-time paint
//          over the cached raster — nothing reaches the spec or the export.
//
//          A comment is drawn as a small box hanging off its cue's datum with
//          a short leader, and its `movedFrom` badge when the fact moved. A
//          comment with no anchor (its fact is gone) goes to the TRAY at the
//          chart's bottom-left, so it is never painted over the wrong bar.

import type { ChartCue, ChartCueComment, ChartCueStep } from "@api/chartCues";
import type { HitGeometry, ParsedChartData } from "../types";
import { resolveCueTarget, cueContextOf, CUE_STYLES, type CueTarget, type CuePaintContext } from "./cuePainter";

// ============================================================================
// The stepper pill
// ============================================================================

export type CueStepperAction = "prev" | "next" | "all" | "step";

export interface CueStepperZone {
  action: CueStepperAction;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CueStepperControl {
  chartId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** "2 of 4" or "all 4". */
  counter: string;
  /** The active step's description, or "" when showing all. */
  description: string;
  zones: CueStepperZone[];
}

const PILL_HEIGHT = 20;
const PILL_MARGIN = 8;
const ARROW_W = 18;
const ALL_W = 26;
const PAD = 6;
export const CUE_STEPPER_FONT = "11px 'Segoe UI', system-ui, sans-serif";

/** Approximate text width without a canvas: enough to size a pill. */
function approxTextWidth(text: string): number {
  return Math.round(text.length * 6.2);
}

/**
 * Where the pill sits and what it says. `null` when there are no steps.
 * Pure — the geometry is testable without a canvas.
 */
export function computeCueStepper(
  chartId: string,
  chartCanvasX: number,
  chartCanvasY: number,
  chartWidth: number,
  steps: readonly string[],
  step: ChartCueStep,
): CueStepperControl | null {
  const n = steps.length;
  if (n === 0) return null;
  const counter = step === "all" ? `all ${n}` : `${step + 1} of ${n}`;
  const description = step === "all" ? "" : steps[step];
  const textW = approxTextWidth(counter) + (description ? PAD + approxTextWidth(description) : 0);
  const width = Math.min(chartWidth - 2 * PILL_MARGIN, ARROW_W + PAD + textW + PAD + ARROW_W + ALL_W);
  const x = chartCanvasX + chartWidth - PILL_MARGIN - width;
  const y = chartCanvasY + PILL_MARGIN;
  const zones: CueStepperZone[] = [
    { action: "prev", x, y, width: ARROW_W, height: PILL_HEIGHT },
    { action: "step", x: x + ARROW_W, y, width: width - 2 * ARROW_W - ALL_W, height: PILL_HEIGHT },
    { action: "next", x: x + width - ARROW_W - ALL_W, y, width: ARROW_W, height: PILL_HEIGHT },
    { action: "all", x: x + width - ALL_W, y, width: ALL_W, height: PILL_HEIGHT },
  ];
  return { chartId, x, y, width, height: PILL_HEIGHT, counter, description, zones };
}

export function hitTestCueStepper(canvasX: number, canvasY: number, control: CueStepperControl | null | undefined): CueStepperAction | null {
  if (!control) return null;
  for (const z of control.zones) {
    if (canvasX >= z.x && canvasX <= z.x + z.width && canvasY >= z.y && canvasY <= z.y + z.height) return z.action;
  }
  return null;
}

/** The surface the chrome painter needs. */
export type ChromePaintContext = CuePaintContext & Pick<CanvasRenderingContext2D, "moveTo" | "lineTo" | "closePath" | "measureText" | "strokeRect">;

function roundRect(ctx: ChromePaintContext, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
  ctx.lineTo(x + w, y + h - r);
  ctx.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
  ctx.lineTo(x + r, y + h);
  ctx.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
  ctx.lineTo(x, y + r);
  ctx.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
  ctx.closePath();
}

export function drawCueStepper(ctx: ChromePaintContext, control: CueStepperControl, showingAll: boolean): void {
  ctx.save();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  roundRect(ctx, control.x, control.y, control.width, control.height, 4);
  ctx.fill();
  ctx.strokeStyle = "#c8c8c8";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.font = CUE_STEPPER_FONT;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  const cy = control.y + control.height / 2;
  const [prev, step, next, all] = control.zones;
  ctx.fillStyle = "#333333";
  ctx.fillText("‹", prev.x + prev.width / 2, cy);
  ctx.fillText("›", next.x + next.width / 2, cy);
  ctx.textAlign = "left";
  const text = control.description ? `${control.counter}  ${control.description}` : control.counter;
  ctx.fillText(text, step.x + PAD, cy);
  ctx.textAlign = "center";
  ctx.fillStyle = showingAll ? "#0e639c" : "#666666";
  ctx.fillText("all", all.x + all.width / 2, cy);
  ctx.restore();
}

// ============================================================================
// Comments
// ============================================================================

export interface CommentBox {
  commentId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const COMMENT_FONT = "11px 'Segoe UI', system-ui, sans-serif";
const COMMENT_PAD = 5;
const COMMENT_MAX_W = 180;
const TRAY_ROW = 16;

function attachPointOf(chartX: number, chartY: number, target: CueTarget): { x: number; y: number } {
  switch (target.kind) {
    case "rect":
      return { x: chartX + target.rect.x + target.rect.width, y: chartY + target.rect.y };
    case "point":
      return { x: chartX + target.marker.cx + target.marker.radius, y: chartY + target.marker.cy - target.marker.radius };
    case "slice": {
      const mid = (target.arc.startAngle + target.arc.endAngle) / 2;
      const r = target.arc.outerRadius + 6;
      return { x: chartX + target.arc.centerX + Math.cos(mid) * r, y: chartY + target.arc.centerY + Math.sin(mid) * r };
    }
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Draw every comment: attached ones as boxes beside their datum, unattached
 * ones in the tray. Returns the boxes drawn (for hit-testing by the caller).
 */
export function paintChartComments(
  ctx: ChromePaintContext,
  chartX: number,
  chartY: number,
  chartWidth: number,
  chartHeight: number,
  geometry: HitGeometry,
  data: Pick<ParsedChartData, "series">,
  comments: readonly ChartCueComment[],
  cuesById: ReadonlyMap<string, ChartCue>,
): CommentBox[] {
  const boxes: CommentBox[] = [];
  if (comments.length === 0) return boxes;
  const context = cueContextOf(data);
  ctx.save();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.font = COMMENT_FONT;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";

  const tray: ChartCueComment[] = [];
  for (const comment of comments) {
    if (!comment.anchor) {
      tray.push(comment);
      continue;
    }
    const r = resolveCueTarget(geometry, comment.anchor, context);
    if (!r.ok) {
      tray.push(comment);
      continue;
    }
    const at = attachPointOf(chartX, chartY, r.target);
    const head = comment.movedFrom ? `was ${comment.movedFrom}` : "";
    const body = truncate(comment.text, 60);
    const width = Math.min(COMMENT_MAX_W, Math.max(approxTextWidth(body), approxTextWidth(head)) + 2 * COMMENT_PAD);
    const height = (head ? 2 : 1) * 14 + 2 * COMMENT_PAD;
    // Hang to the right of the datum, flipping left at the chart's edge.
    let x = at.x + 8;
    if (x + width > chartX + chartWidth - 4) x = at.x - 8 - width;
    const y = Math.max(chartY + 4, at.y - height - 6);
    const polarity = cuesById.get(comment.factId)?.polarity ?? "neutral";
    const stroke = CUE_STYLES[polarity].stroke;

    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(at.x, at.y);
    ctx.lineTo(x < at.x ? x + width : x, y + height);
    ctx.stroke();

    ctx.fillStyle = "rgba(255,255,255,0.95)";
    roundRect(ctx, x, y, width, height, 3);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#333333";
    let ty = y + COMMENT_PAD;
    if (head) {
      ctx.fillStyle = "#8a6d00";
      ctx.fillText(head, x + COMMENT_PAD, ty);
      ty += 14;
      ctx.fillStyle = "#333333";
    }
    ctx.fillText(body, x + COMMENT_PAD, ty);
    boxes.push({ commentId: comment.id, x, y, width, height });
  }

  if (tray.length > 0) {
    const rows = tray.length + 1;
    const height = rows * TRAY_ROW + 2 * COMMENT_PAD;
    const width = Math.min(chartWidth - 2 * PILL_MARGIN, COMMENT_MAX_W + 60);
    const x = chartX + PILL_MARGIN;
    const y = chartY + chartHeight - PILL_MARGIN - height;
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.strokeStyle = "#c8c8c8";
    ctx.lineWidth = 1;
    roundRect(ctx, x, y, width, height, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#666666";
    ctx.fillText(`${tray.length} comment${tray.length === 1 ? "" : "s"} no longer point${tray.length === 1 ? "s" : ""} at anything`, x + COMMENT_PAD, y + COMMENT_PAD);
    ctx.fillStyle = "#333333";
    tray.forEach((c, i) => {
      const ty = y + COMMENT_PAD + (i + 1) * TRAY_ROW;
      const was = c.movedFrom ? ` (was ${c.movedFrom})` : "";
      ctx.fillText(truncate(`${c.text}${was}`, 40), x + COMMENT_PAD, ty);
      boxes.push({ commentId: c.id, x, y: ty, width, height: TRAY_ROW });
    });
  }

  ctx.restore();
  return boxes;
}

export function hitTestCommentBoxes(canvasX: number, canvasY: number, boxes: readonly CommentBox[] | undefined): string | null {
  if (!boxes) return null;
  for (const b of boxes) {
    if (canvasX >= b.x && canvasX <= b.x + b.width && canvasY >= b.y && canvasY <= b.y + b.height) return b.commentId;
  }
  return null;
}
