//! FILENAME: app/extensions/Charts/rendering/paramWidgets.ts
// PURPOSE: On-canvas controls for bound params (C5 S5). A param with `bind`
//          renders a small control (stepper / cycle / segment) in a strip at the
//          chart's top-left when the chart is selected; clicking a control's zone
//          changes the live widget value (chartWidgetValues store), which
//          resolveParams then picks up on the next render. Drawn on the MAIN
//          canvas (live, like quick-access buttons) so values + hover update for
//          free. Modeled on the quick-access / pivot-field-button precedent.

import type { ChartSpec, ParamSpec, ParamBinding } from "../types";

// ============================================================================
// Types
// ============================================================================

/** A clickable zone within a control: a +/- step, or a direct option pick. */
export type WidgetAction = { dir: 1 | -1 } | { option: string | number };

export interface WidgetZone {
  x: number;
  y: number;
  width: number;
  height: number;
  action: WidgetAction;
}

/** A laid-out on-canvas control for one bound param (absolute canvas coords). */
export interface WidgetControl {
  paramName: string;
  bind: ParamBinding;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Display text per segment (drawn left-to-right); zones[i] aligns to text segment. */
  text: string;
  zones: WidgetZone[];
  /** For segment: the option string of the currently-selected zone (for highlight). */
  current: string;
}

// ============================================================================
// Layout
// ============================================================================

const H = 22;          // control height
const PAD = 6;         // text padding
const GAP = 6;         // gap between controls
const STEP_W = 16;     // width of a +/- button zone
const OFFSET_X = 8;    // strip inset from chart left
const OFFSET_Y = 8;    // strip inset from chart top

let measureCtx: OffscreenCanvasRenderingContext2D | null = null;
let measureTried = false;
function measure(text: string): number {
  if (!measureTried) {
    measureTried = true;
    if (typeof OffscreenCanvas !== "undefined") {
      try {
        const c = new OffscreenCanvas(1, 1);
        measureCtx = c.getContext("2d");
        if (measureCtx) measureCtx.font = "11px 'Segoe UI', system-ui, sans-serif";
      } catch {
        measureCtx = null;
      }
    }
  }
  return measureCtx ? measureCtx.measureText(text).width : text.length * 6.2;
}

/** The bound params worth a control: has bind + a usable name. */
function boundParams(spec: ChartSpec): ParamSpec[] {
  return (spec.params ?? []).filter((p) => p.bind && (p.name ?? "").trim() !== "");
}

/** Whether a spec has any on-canvas controls (cheap gate for the render path). */
export function hasWidgetControls(spec: ChartSpec): boolean {
  return boundParams(spec).length > 0;
}

/**
 * Lay out the bound-param controls in a horizontal strip at (originX, originY)
 * (absolute canvas coords). `currentOf(name)` supplies the value to display.
 */
export function computeWidgetControls(
  spec: ChartSpec,
  chartCanvasX: number,
  chartCanvasY: number,
  currentOf: (paramName: string) => string,
): WidgetControl[] {
  const controls: WidgetControl[] = [];
  let x = chartCanvasX + OFFSET_X;
  const y = chartCanvasY + OFFSET_Y;

  for (const p of boundParams(spec)) {
    const bind = p.bind!;
    const name = p.name.trim();
    const value = currentOf(name);
    const zones: WidgetZone[] = [];
    let width: number;
    let text: string;

    if (bind.input === "segment") {
      // [name:] [opt][opt]...  — one zone per option (direct pick).
      const options = bind.options ?? [];
      const labelText = `${name}: `;
      let zx = x + PAD + measure(labelText);
      for (const opt of options) {
        const w = measure(String(opt)) + PAD * 2;
        zones.push({ x: zx, y, width: w, height: H, action: { option: opt } });
        zx += w;
      }
      width = zx - x + PAD;
      text = labelText;
    } else if (bind.input === "cycle") {
      // [name: value ▸] — single zone steps forward.
      text = `${name}: ${value} ▸`;
      width = measure(text) + PAD * 2;
      zones.push({ x, y, width, height: H, action: { dir: 1 } });
    } else {
      // stepper: [−][ name: value ][+]
      text = `${name}: ${value}`;
      const mid = measure(text) + PAD * 2;
      width = STEP_W + mid + STEP_W;
      zones.push({ x, y, width: STEP_W, height: H, action: { dir: -1 } });
      zones.push({ x: x + STEP_W + mid, y, width: STEP_W, height: H, action: { dir: 1 } });
    }

    controls.push({ paramName: name, bind, x, y, width, height: H, text, zones, current: value });
    x += width + GAP;
  }

  return controls;
}

// ============================================================================
// Drawing
// ============================================================================

let hovered = false;
export function setWidgetHovered(v: boolean): void { hovered = v; }
export function isWidgetHovered(): boolean { return hovered; }

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Draw the controls on the main canvas. */
export function drawWidgetControls(ctx: CanvasRenderingContext2D, controls: WidgetControl[]): void {
  ctx.save();
  ctx.font = "11px 'Segoe UI', system-ui, sans-serif";
  ctx.textBaseline = "middle";

  for (const c of controls) {
    // Pill background + border.
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    roundRect(ctx, c.x, c.y, c.width, c.height, 4);
    ctx.fill();
    ctx.strokeStyle = "#c8c8c8";
    ctx.lineWidth = 1;
    ctx.stroke();

    if (c.bind.input === "stepper") {
      ctx.fillStyle = "#444";
      ctx.textAlign = "center";
      ctx.fillText("−", c.x + STEP_W / 2, c.y + c.height / 2);
      ctx.fillText("+", c.x + c.width - STEP_W / 2, c.y + c.height / 2);
      ctx.textAlign = "left";
      ctx.fillText(c.text, c.x + STEP_W + PAD, c.y + c.height / 2);
    } else if (c.bind.input === "cycle") {
      ctx.fillStyle = "#333";
      ctx.textAlign = "left";
      ctx.fillText(c.text, c.x + PAD, c.y + c.height / 2);
    } else {
      // segment: label + each option zone (selected option highlighted).
      ctx.fillStyle = "#666";
      ctx.textAlign = "left";
      ctx.fillText(c.text, c.x + PAD, c.y + c.height / 2);
      for (const z of c.zones) {
        if (!("option" in z.action)) continue;
        const selected = String(z.action.option) === c.current;
        if (selected) {
          ctx.fillStyle = "#d6e4f0";
          roundRect(ctx, z.x, z.y + 2, z.width, z.height - 4, 3);
          ctx.fill();
        }
        ctx.fillStyle = selected ? "#005fb8" : "#444";
        ctx.textAlign = "center";
        ctx.fillText(String(z.action.option), z.x + z.width / 2, z.y + z.height / 2);
      }
    }
  }
  ctx.restore();
}

// ============================================================================
// Hit Testing
// ============================================================================

/** Hit-test the controls (absolute canvas coords). Returns the clicked action. */
export function hitTestWidgetControls(
  canvasX: number,
  canvasY: number,
  controls: WidgetControl[],
): { paramName: string; bind: ParamBinding; action: WidgetAction } | null {
  for (const c of controls) {
    for (const z of c.zones) {
      if (canvasX >= z.x && canvasX <= z.x + z.width && canvasY >= z.y && canvasY <= z.y + z.height) {
        return { paramName: c.paramName, bind: c.bind, action: z.action };
      }
    }
  }
  return null;
}

/** Whether a point is anywhere within a control (for the extended hit-test claim). */
export function isInWidgetArea(canvasX: number, canvasY: number, controls: WidgetControl[]): boolean {
  return controls.some((c) => canvasX >= c.x && canvasX <= c.x + c.width && canvasY >= c.y && canvasY <= c.y + c.height);
}
