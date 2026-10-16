//! FILENAME: app/src/api/visualContainerPaint.ts
// PURPOSE: The Canvas2D painters of the VISUAL CONTAINER (D-FORMAT) and THE
//          one layout cache that keeps paint == hit.
// CONTEXT: Used by Core's overlay paint (`renderOverlayRegion`: under-paint,
//          the family's render, over-paint), by the chart PNG export / chart
//          previews (which paint without Core) and by every family that lays
//          out and hit-tests inside the content rect.
//
//          paint == hit: Core MEASURES the layout it paints (wrapped title
//          lines need a canvas) and records it here keyed by region id +
//          signature; `visualContentRectFor` answers every family's paint AND
//          hit test from that record while the signature still matches, and
//          from the pure 1-line layout otherwise. The signature is
//          POSITION-INDEPENDENT (size + the layout-relevant leaves), so a
//          moved object keeps its measured layout, translated, until the next
//          paint -- a hit test during a drag never falls back to a different
//          answer than the one on screen.
//
//          Coordinates: layouts are in sheet px (logical). `origin` is the
//          canvas (logical) position of the outer rect's top-left corner; every
//          layout rect is painted at `origin + (rect - outer.topLeft)`.
//          Canvas shadows are NOT scaled by the context transform, so the
//          shadow painter scales blur and offset by the transform's own scale
//          (zoom x device pixel ratio).

import type { GridRegion } from "./gridOverlays";
import {
  layoutVisualContainer,
  lineHeightFor,
  containerBorderInset,
  type ContainerRect,
  type ResolvedVisualContainer,
  type ResolvedVisualText,
  type VisualContainerLayout,
  type VisualGradient,
  type VisualShadowPosition,
} from "./visualContainer";

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Origin = { dx: number; dy: number };

/** A region as a family publishes it once it carries a resolved container. */
export type ContainerRegion = GridRegion & { container?: ResolvedVisualContainer };

// ============================================================================
// Small helpers
// ============================================================================

function toCanvas(r: ContainerRect, layout: VisualContainerLayout, origin: Origin): ContainerRect {
  return {
    x: origin.dx + (r.x - layout.outer.x),
    y: origin.dy + (r.y - layout.outer.y),
    width: r.width,
    height: r.height,
  };
}

/** Adds a rounded-rect sub-path (radius clamped to half the short side; 0 = a plain rect). */
function traceRoundRect(ctx: Ctx2D, x: number, y: number, w: number, h: number, radius: number): void {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  if (r <= 0) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/** "#rgb" / "#rrggbb" / "#rrggbbaa" x alpha -> "rgba(r, g, b, a)"; null for anything else. */
export function visualColorWithAlpha(hex: string, alpha: number): string | null {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(hex);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((ch) => ch + ch).join("");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const own = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  const a = Math.round(Math.max(0, Math.min(1, alpha * own)) * 10000) / 10000;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** The CSS font of a container text. */
export function visualTextFont(t: Pick<ResolvedVisualText, "italic" | "bold" | "fontSize" | "fontFamily">): string {
  return `${t.italic ? "italic " : ""}${t.bold ? "bold " : ""}${t.fontSize}px ${t.fontFamily}`;
}

/**
 * Greedy word wrap with the context's CURRENT font: paragraphs at "\n", words at spaces; a word wider than
 * `maxWidth` keeps its own line (never broken mid-word). Always at least one line. Used by the measure AND
 * the paint, so they agree on the line count.
 */
export function wrapVisualText(ctx: Ctx2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(" ");
    let line = "";
    for (const word of words) {
      const candidate = line === "" ? word : `${line} ${word}`;
      if (line !== "" && maxWidth > 0 && ctx.measureText(candidate).width > maxWidth) {
        out.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    out.push(line);
  }
  return out.length > 0 ? out : [""];
}

function measureLines(ctx: Ctx2D, t: ResolvedVisualText, width: number): number {
  if (!t.show || !t.wrap) return 1;
  ctx.font = visualTextFont(t);
  return wrapVisualText(ctx, t.text, width).length;
}

/** The transform's scale (zoom x dpr), for the few properties the transform does not scale (shadows). */
function deviceScale(ctx: Ctx2D): number {
  const get = (ctx as { getTransform?: () => DOMMatrix }).getTransform;
  if (typeof get !== "function") return 1;
  const m = get.call(ctx);
  const s = Math.hypot(m.a, m.b);
  return Number.isFinite(s) && s > 0 ? s : 1;
}

const SHADOW_DIRECTIONS: Readonly<Record<VisualShadowPosition, readonly [number, number]>> = {
  bottomRight: [1, 1], bottom: [0, 1], bottomLeft: [-1, 1], right: [1, 0], center: [0, 0],
  left: [-1, 0], topRight: [1, -1], top: [0, -1], topLeft: [-1, -1],
};

/** The shadow's offset in logical px: the unit direction of `position` x `distance`. */
export function shadowOffsetFor(position: VisualShadowPosition, distance: number): { x: number; y: number } {
  const [ux, uy] = SHADOW_DIRECTIONS[position] ?? [1, 1];
  const len = Math.hypot(ux, uy);
  return len === 0 ? { x: 0, y: 0 } : { x: (ux / len) * distance, y: (uy / len) * distance };
}

/** The same direction table the chart painters use (Charts/rendering/gradientFill.ts), as fractions. */
function gradientCoords(direction: VisualGradient["direction"]): [number, number, number, number] {
  switch (direction) {
    case "bottomToTop": return [0.5, 1, 0.5, 0];
    case "leftToRight": return [0, 0.5, 1, 0.5];
    case "rightToLeft": return [1, 0.5, 0, 0.5];
    case "topLeftToBottomRight": return [0, 0, 1, 1];
    case "bottomRightToTopLeft": return [1, 1, 0, 0];
    case "topRightToBottomLeft": return [1, 0, 0, 1];
    case "bottomLeftToTopRight": return [0, 1, 1, 0];
    default: return [0.5, 0, 0.5, 1];
  }
}

function makeGradient(ctx: Ctx2D, g: VisualGradient, r: ContainerRect): CanvasGradient {
  let grad: CanvasGradient;
  if (g.type === "radial") {
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(r.width, r.height) / 2);
  } else {
    const [x0, y0, x1, y1] = gradientCoords(g.direction);
    grad = ctx.createLinearGradient(
      r.x + x0 * r.width, r.y + y0 * r.height, r.x + x1 * r.width, r.y + y1 * r.height,
    );
  }
  for (const stop of g.stops) grad.addColorStop(Math.max(0, Math.min(1, stop.offset)), stop.color);
  return grad;
}

// ============================================================================
// Measure + paint
// ============================================================================

/** Measures wrapped title/subtitle lines with `ctx`, then layoutVisualContainer. Leaves `ctx` as it was. */
export function measureVisualContainerLayout(ctx: Ctx2D, outer: ContainerRect, c: ResolvedVisualContainer): VisualContainerLayout {
  if (c.paint.title !== "core" || (!c.title.show && !c.subtitle.show)) return layoutVisualContainer(outer, c);
  const width = layoutVisualContainer(outer, c).content.width;
  ctx.save();
  try {
    const title = measureLines(ctx, c.title, width);
    const subtitle = measureLines(ctx, c.subtitle, width);
    return layoutVisualContainer(outer, c, { title, subtitle });
  } finally {
    ctx.restore();
  }
}

/** Path of the outer rounded rect (used by withContainerContentClip and the PNG export). Starts a new path. */
export function traceContainerOuter(ctx: Ctx2D, layout: VisualContainerLayout, c: ResolvedVisualContainer, origin: Origin): void {
  const o = toCanvas(layout.outer, layout, origin);
  ctx.beginPath();
  traceRoundRect(ctx, o.x, o.y, o.width, o.height, c.border.radius);
}

function setShadow(ctx: Ctx2D, c: ResolvedVisualContainer, color: string): void {
  const scale = deviceScale(ctx);
  const off = shadowOffsetFor(c.shadow.position, c.shadow.distance);
  ctx.shadowColor = color;
  ctx.shadowBlur = c.shadow.blur * scale;
  ctx.shadowOffsetX = off.x * scale;
  ctx.shadowOffsetY = off.y * scale;
}

/** A rect big enough to hold the outer rect plus its whole shadow. */
function shadowReach(o: ContainerRect, c: ResolvedVisualContainer): ContainerRect {
  const m = c.shadow.blur * 2 + c.shadow.distance + 2;
  return { x: o.x - m, y: o.y - m, width: o.width + 2 * m, height: o.height + 2 * m };
}

function paintShadow(ctx: Ctx2D, layout: VisualContainerLayout, c: ResolvedVisualContainer, origin: Origin): void {
  const color = visualColorWithAlpha(c.shadow.color, c.shadow.alpha);
  if (!color) return;
  const o = toCanvas(layout.outer, layout, origin);
  const reach = shadowReach(o, c);
  const radius = c.border.radius;
  ctx.save();
  try {
    if (c.shadow.offset === "inside") {
      // Clip to the shape; a ring OUTSIDE it casts its shadow inward. The ring itself is clipped away.
      ctx.beginPath();
      traceRoundRect(ctx, o.x, o.y, o.width, o.height, radius);
      ctx.clip();
      ctx.beginPath();
      ctx.rect(reach.x, reach.y, reach.width, reach.height);
      traceRoundRect(ctx, o.x, o.y, o.width, o.height, radius);
      setShadow(ctx, c, color);
      ctx.fillStyle = "#000000";
      ctx.fill("evenodd");
    } else {
      // Clip to everything OUTSIDE the shape, so the shape casting the shadow never shows itself (a
      // transparent background must not reveal it).
      ctx.beginPath();
      ctx.rect(reach.x, reach.y, reach.width, reach.height);
      traceRoundRect(ctx, o.x, o.y, o.width, o.height, radius);
      ctx.clip("evenodd");
      ctx.beginPath();
      traceRoundRect(ctx, o.x, o.y, o.width, o.height, radius);
      setShadow(ctx, c, color);
      ctx.fillStyle = "#000000";
      ctx.fill();
    }
  } finally {
    ctx.restore();
  }
}

function paintBackground(ctx: Ctx2D, layout: VisualContainerLayout, c: ResolvedVisualContainer, origin: Origin): void {
  const bg = c.background;
  if (bg.alpha <= 0) return;
  const gradient = bg.gradient && bg.gradient.stops.length >= 2 ? bg.gradient : null;
  if (!gradient && bg.color === "") return;
  const o = toCanvas(layout.outer, layout, origin);
  ctx.save();
  try {
    ctx.globalAlpha = ctx.globalAlpha * bg.alpha;
    ctx.fillStyle = gradient ? makeGradient(ctx, gradient, o) : bg.color;
    ctx.beginPath();
    traceRoundRect(ctx, o.x, o.y, o.width, o.height, c.border.radius);
    ctx.fill();
  } finally {
    ctx.restore();
  }
}

/**
 * Shadow (if paint.shadow === "core"), then background (if paint.background === "core"). An INSIDE shadow is
 * painted after the background (it falls on it); an outside one before. `origin` = canvas px of outer's (0,0).
 */
export function paintVisualContainerUnder(
  ctx: Ctx2D, layout: VisualContainerLayout, c: ResolvedVisualContainer, origin: Origin,
): void {
  const shadow = c.paint.shadow === "core" && c.shadow.show && c.shadow.alpha > 0;
  if (shadow && c.shadow.offset === "outside") paintShadow(ctx, layout, c, origin);
  if (c.paint.background === "core" && c.background.show) paintBackground(ctx, layout, c, origin);
  if (shadow && c.shadow.offset === "inside") paintShadow(ctx, layout, c, origin);
}

function paintText(ctx: Ctx2D, t: ResolvedVisualText, rect: ContainerRect, lines: number): void {
  if (rect.width <= 0 || rect.height <= 0) return;
  ctx.save();
  try {
    if (t.background !== "") {
      ctx.fillStyle = t.background;
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    }
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.width, rect.height);
    ctx.clip();
    ctx.font = visualTextFont(t);
    ctx.fillStyle = t.color;
    ctx.textBaseline = "top";
    ctx.textAlign = t.align;
    const lh = lineHeightFor(t.fontSize);
    const wrapped = t.wrap ? wrapVisualText(ctx, t.text, rect.width) : [t.text];
    const x = t.align === "center" ? rect.x + rect.width / 2 : t.align === "right" ? rect.x + rect.width : rect.x;
    const count = Math.min(Math.max(1, lines), wrapped.length);
    for (let i = 0; i < count; i++) {
      const line = wrapped[i];
      const y = rect.y + i * lh + (lh - t.fontSize) / 2;
      ctx.fillText(line, x, y);
      if (t.underline && line !== "") {
        const w = ctx.measureText(line).width;
        const x0 = t.align === "center" ? x - w / 2 : t.align === "right" ? x - w : x;
        ctx.fillRect(x0, y + t.fontSize + 1, w, Math.max(1, Math.round(t.fontSize / 14)));
      }
    }
  } finally {
    ctx.restore();
  }
}

function paintDivider(ctx: Ctx2D, layout: VisualContainerLayout, c: ResolvedVisualContainer, origin: Origin): void {
  const d = layout.divider;
  if (!d || c.divider.width <= 0 || c.divider.color === "") return;
  const dy = origin.dy - layout.outer.y;
  const dx = origin.dx - layout.outer.x;
  ctx.save();
  try {
    ctx.strokeStyle = c.divider.color;
    ctx.lineWidth = c.divider.width;
    const w = c.divider.width;
    if (typeof ctx.setLineDash === "function") {
      ctx.setLineDash(c.divider.style === "dashed" ? [w * 4, w * 2] : c.divider.style === "dotted" ? [w, w * 2] : []);
    }
    ctx.beginPath();
    ctx.moveTo(d.x0 + dx, d.y + dy);
    ctx.lineTo(d.x1 + dx, d.y + dy);
    ctx.stroke();
  } finally {
    ctx.restore();
  }
}

function paintBorder(ctx: Ctx2D, layout: VisualContainerLayout, c: ResolvedVisualContainer, origin: Origin): void {
  const w = c.border.width;
  if (w <= 0 || c.border.color === "") return;
  const o = toCanvas(layout.outer, layout, origin);
  ctx.save();
  try {
    ctx.strokeStyle = c.border.color;
    ctx.lineWidth = w;
    ctx.beginPath();
    // Stroked on the half-inset rect, so the whole band lies INSIDE the outer rect (the band the layout insets).
    traceRoundRect(ctx, o.x + w / 2, o.y + w / 2, Math.max(0, o.width - w), Math.max(0, o.height - w),
      Math.max(0, c.border.radius - w / 2));
    ctx.stroke();
  } finally {
    ctx.restore();
  }
}

/** Core-painted title, subtitle, divider (paint.title === "core"), then border (if paint.border === "core"). */
export function paintVisualContainerOver(
  ctx: Ctx2D, layout: VisualContainerLayout, c: ResolvedVisualContainer, origin: Origin,
): void {
  if (c.paint.title === "core") {
    if (layout.titleRect) paintText(ctx, c.title, toCanvas(layout.titleRect, layout, origin), layout.titleLines);
    if (layout.subtitleRect) paintText(ctx, c.subtitle, toCanvas(layout.subtitleRect, layout, origin), layout.subtitleLines);
    if (layout.divider) paintDivider(ctx, layout, c, origin);
  }
  if (c.paint.border === "core" && c.border.show) paintBorder(ctx, layout, c, origin);
}

/**
 * Run `paint` clipped to the CONTENT rect intersected with the rounded outer path (radius > 0). Families wrap
 * ONLY their content (chart raster drawImage, pivot cells, slicer items, control body) in it -- never their
 * affordances (chart Quick Access buttons, which sit OUTSIDE the object). Core does NOT clip the family render.
 * With radius 0 (or no container) it clips to the content rect only. Both rects are in canvas px. `paint` runs
 * exactly once, inside one save/restore (restored even when it throws).
 */
export function withContainerContentClip(
  ctx: Ctx2D, region: ContainerRegion, canvasOuter: ContainerRect, canvasContent: ContainerRect, paint: () => void,
): void {
  const radius = region.container?.border.radius ?? 0;
  ctx.save();
  try {
    ctx.beginPath();
    ctx.rect(canvasContent.x, canvasContent.y, canvasContent.width, canvasContent.height);
    ctx.clip();
    if (radius > 0) {
      ctx.beginPath();
      traceRoundRect(ctx, canvasOuter.x, canvasOuter.y, canvasOuter.width, canvasOuter.height, radius);
      ctx.clip();
    }
    paint();
  } finally {
    ctx.restore();
  }
}

// ============================================================================
// The one layout cache (paint == hit)
// ============================================================================

const painted = new Map<string, { signature: string; layout: VisualContainerLayout }>();

function textSignature(t: ResolvedVisualText): unknown[] {
  return [t.show, t.text, t.fontFamily, t.fontSize, t.bold, t.italic, t.wrap];
}

/**
 * Everything the layout depends on EXCEPT the position: the size, the border inset, the padding, the paint
 * split and the title / subtitle / divider / spacing leaves that change a band. Position-independent on
 * purpose (see the file header).
 */
export function containerLayoutSignature(outer: ContainerRect, c: ResolvedVisualContainer): string {
  return JSON.stringify([
    outer.width, outer.height, containerBorderInset(c), c.padding, c.paint.title,
    textSignature(c.title), textSignature(c.subtitle),
    c.divider.show, c.divider.width, c.divider.ignorePadding, c.spacing,
  ]);
}

/** Core records the layout it PAINTED for a region (sheet px), keyed by region id + signature. */
export function recordPaintedContainerLayout(regionId: string, signature: string, layout: VisualContainerLayout): void {
  painted.set(regionId, { signature, layout });
}

function translateRect(r: ContainerRect, dx: number, dy: number): ContainerRect {
  return { x: r.x + dx, y: r.y + dy, width: r.width, height: r.height };
}

/**
 * The whole layout for a region at `outer`: the painted one (translated to `outer`'s position) when its
 * signature matches, otherwise the pure 1-line layout.
 */
export function visualContainerLayoutFor(regionId: string, outer: ContainerRect, c: ResolvedVisualContainer): VisualContainerLayout {
  const hit = painted.get(regionId);
  if (hit && hit.signature === containerLayoutSignature(outer, c)) {
    const dx = outer.x - hit.layout.outer.x;
    const dy = outer.y - hit.layout.outer.y;
    const l = hit.layout;
    return {
      outer: { ...outer },
      titleRect: l.titleRect ? translateRect(l.titleRect, dx, dy) : null,
      subtitleRect: l.subtitleRect ? translateRect(l.subtitleRect, dx, dy) : null,
      divider: l.divider ? { y: l.divider.y + dy, x0: l.divider.x0 + dx, x1: l.divider.x1 + dx } : null,
      content: translateRect(l.content, dx, dy),
      titleLines: l.titleLines,
      subtitleLines: l.subtitleLines,
    };
  }
  return layoutVisualContainer(outer, c);
}

/**
 * THE content rect every family paints and hit-tests in: the painted layout when its signature matches,
 * otherwise the pure 1-line layout. Outer == content when `c` is undefined.
 */
export function visualContentRectFor(regionId: string, outer: ContainerRect, c: ResolvedVisualContainer | undefined): ContainerRect {
  if (!c) return { x: outer.x, y: outer.y, width: outer.width, height: outer.height };
  return visualContainerLayoutFor(regionId, outer, c).content;
}

/**
 * Same for a published region (its floating rect + its container). A cell-anchored region has no container
 * and no sheet-px rect here: it answers an empty rect at the origin, so a mistaken caller hits nothing rather
 * than something.
 */
export function visualContentRect(region: ContainerRegion): ContainerRect {
  const outer = region.floating;
  if (!outer) return { x: 0, y: 0, width: 0, height: 0 };
  return visualContentRectFor(region.id, outer, region.container);
}

/** File > New / Open and tests. */
export function resetPaintedContainerLayouts(): void {
  painted.clear();
}
