//! FILENAME: app/extensions/Controls/Shape/shapeHitRegions.ts
// PURPOSE: The host side of a shape script's DECLARED HIT RECTANGLES (M3b) —
//          the store, the transparent shim elements that actually claim pointer
//          input over the shape's `ui.html` iframe, and the design-mode outline
//          that makes a claim visible.
// CONTEXT: `shapeRenderer.ts` set every html overlay to `pointer-events: none`
//          UNCONDITIONALLY ("allows click-through"), so a script's frame could
//          never receive a click and the whole `ui.html` surface was
//          decorative. The opposite — an interactive frame — would swallow
//          every pointer event inside the shape's box, including the ones that
//          select, move and resize the shape. This module is the middle: the
//          iframe STAYS `pointer-events: none` forever, and the host puts a
//          transparent shim over each rectangle the script declared.
//
//          WHY SHIMS RATHER THAN pointer-events ON THE IFRAME. The frame is
//          `sandbox="allow-scripts"` with an opaque origin, so the host cannot
//          reach into its document to dispatch anything, and CSS has no way to
//          make one element hit-transparent in part of its box while still
//          painting there (`clip-path` clips the PAINT too, which would erase
//          the frame's own visuals). A shim above the frame catches the pointer
//          and the existing postMessage bridge carries it in — the same bridge
//          `render.sendMessage` already uses, so no new channel into the frame.
//
//          THE TWO ESCAPES, because a script may legitimately claim its whole
//          frame and must not be able to trap the user there:
//            1. DESIGN MODE suspends every claim at once (shims are removed
//               while it is on) and outlines each declared rectangle with a
//               dashed box, so the user can see what a script took and can
//               always select, move, resize and delete the shape.
//            2. RIGHT-CLICK is never claimed — no shim listens for
//               `contextmenu`, and it bubbles to the window handlers that route
//               by client point — so the shape's own menu stays reachable even
//               on a fully claimed frame.
//
//          WHY THE OUTLINE IS A DOM ELEMENT AND NOT A CANVAS STROKE. It was a
//          `ctx.strokeRect` onto the grid canvas for as long as it existed, and
//          not one pixel of it ever reached the user's eye: the frame is an
//          OPAQUE (`background: #ffffff`) positioned sibling of that canvas in
//          the same parent at `z-index: 5`, the canvas is positioned with no
//          z-index at all, and every outline rectangle is clipped INSIDE the
//          frame's box by `shapeHitShimRects` — so the frame painted over all
//          of it, every time. Design Mode gave the user their clicks back and
//          told them nothing about what had taken them, which is exactly the
//          half of the escape this outline exists to be. It is now a
//          `pointer-events: none` element ABOVE the frame, built and torn down
//          on the same paths as the shims, so "shown" and "claimed" cannot
//          drift apart.

import {
  MAX_SHAPE_HIT_REGIONS,
  SHAPE_HIT_POINTER_MESSAGE_TYPE,
  type ShapeHitPointerMessage,
  type ShapeHitRegion,
} from "@api/scriptHost/shapeHitRegionSpec";
import { claimPointer } from "@api/pointerClaims";
// The envelope carrying a claimed click into the frame is the shared module's,
// not this file's. Hand-rolling it here made the protocol tag a third copy of a
// value whose own definition claimed to be the only one.
import { postToScriptFrame } from "../../_shared/scriptFrame";
import { getDesignMode } from "../lib/designMode";

// ============================================================================
// The store
// ============================================================================

/** controlId -> the rectangles its script declared, in declaration order. */
const hitRegions = new Map<string, ShapeHitRegion[]>();

/** controlId -> the shim elements currently claiming those rectangles. */
const hitShims = new Map<string, HTMLDivElement[]>();

/**
 * controlId -> the dashed outline elements Design Mode shows over those
 * rectangles. Never populated at the same time as `hitShims` for the same
 * shape: the two are the two sides of the mode switch in `syncShapeHitDom`.
 */
const hitOutlines = new Map<string, HTMLDivElement[]>();

/** The `data-` attribute a shim carries, so a stray one is findable in the DOM. */
export const SHAPE_HIT_SHIM_ATTR = "data-shape-hit-region";

/** The same, for a design-mode outline. */
export const SHAPE_HIT_OUTLINE_ATTR = "data-shape-hit-outline";

/** The dashed blue the rest of the design-mode chrome is drawn in. */
const HIT_OUTLINE_COLOR = "#0e639c";

/**
 * Record a script's declaration. An empty list RELEASES the frame, which is the
 * same door the host uses on unmount — one code path, so "released on unmount"
 * cannot drift from "released on request".
 *
 * The count is re-checked here even though `vHitRegions` already refused an
 * over-budget call at the broker: this is the boundary where a claim becomes a
 * DOM element, and it is reached by an app event that any host-side caller can
 * emit. The refusal is ALL-OR-NOTHING, matching what the typings promise the
 * script author — "anything outside those bounds refuses the whole call and
 * leaves the previous claim in place". Truncating instead would hand back a
 * frame that is interactive in some of the places its author asked for and not
 * others, with nothing anywhere saying so.
 */
export function setShapeHitRegions(instanceId: string, regions: readonly ShapeHitRegion[]): void {
  if (regions.length === 0) {
    hitRegions.delete(instanceId);
    removeShapeHitDom(instanceId);
    return;
  }
  if (regions.length > MAX_SHAPE_HIT_REGIONS) {
    console.warn(
      `[Controls] refused a hit-region declaration for ${instanceId}: ${regions.length} ` +
        `rectangles is past the limit of ${MAX_SHAPE_HIT_REGIONS}. The previous claim stands.`,
    );
    return;
  }
  // Copied, so a caller that keeps its array cannot change what the host claims
  // after the fact.
  hitRegions.set(instanceId, [...regions]);
}

/** The rectangles a shape has declared (empty when it has declared none). */
export function getShapeHitRegions(instanceId: string): readonly ShapeHitRegion[] {
  return hitRegions.get(instanceId) ?? [];
}

/** True when this shape has claimed anything at all. */
export function hasShapeHitRegions(instanceId: string): boolean {
  return hitRegions.has(instanceId);
}

/** Drop a shape's declaration and every element it had over its frame. */
export function clearShapeHitRegions(instanceId: string): void {
  hitRegions.delete(instanceId);
  removeShapeHitDom(instanceId);
}

/**
 * Move a shape's claim to its NEW id after a structural edit re-keys it.
 *
 * The same failure `migrateShapeInstanceId` exists for: an id-keyed side table
 * that is not migrated leaves the claim stranded under the old id, so the
 * script's frame silently goes click-through the moment somebody inserts a row.
 */
export function migrateShapeHitRegions(oldId: string, newId: string): void {
  if (oldId === newId) return;
  const regions = hitRegions.get(oldId);
  if (regions !== undefined) {
    hitRegions.delete(oldId);
    hitRegions.set(newId, regions);
  }
  // The shims and outlines are rebuilt from the store on the next paint; drop
  // the old ones rather than re-keying elements that are about to be
  // repositioned anyway.
  removeShapeHitDom(oldId);
  // ...and the DESTINATION's, which is not the same statement twice. A rename
  // can land on an id another control still holds (see
  // `reanchorFloatingControls`), and `migrateShapeInstanceId` removes THAT
  // control's iframe from the page in the same breath. Its shims are not keyed
  // to the frame they were built over — each one closes over the element — so a
  // shim reused for the arrival (`syncShapeHitDom` reuses whenever the rectangle
  // COUNT is unchanged, which two toolbar-shaped shapes trivially are) goes on
  // posting claimed clicks into a detached frame: swallowed on the way in by its
  // own `stopPropagation` and delivered nowhere. And when the arrival paints no
  // frame at all, the leftover element is an invisible `pointer-events: auto`
  // rectangle over the bare grid that the unpainted sweep can never collect,
  // because the id it is filed under IS being painted.
  removeShapeHitDom(newId);
}

/** Forget every shape's claim (workbook close / test isolation). */
export function resetShapeHitRegions(): void {
  for (const id of shapeHitDomIds()) removeShapeHitDom(id);
  hitRegions.clear();
}

// ============================================================================
// Geometry (pure — this is the part the tests can pin without a browser)
// ============================================================================

/** A declared rectangle placed in canvas pixels and clipped to the frame's box. */
export interface ShapeHitShimRect {
  region: ShapeHitRegion;
  /** Canvas pixels. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Frame-local pixels of this rect's top-left AFTER clipping — what the
   *  pointer message adds its offset to, so a clipped shim still reports the
   *  point the frame would measure. */
  frameX: number;
  frameY: number;
}

/**
 * Place a shape's declared rectangles on the canvas.
 *
 * `frameLeft` / `frameTop` / `frameWidth` / `frameHeight` are the iframe's ACTUAL
 * laid-out box, which is the header-clipped box `updateHtmlOverlay` positions it
 * at — not the shape's unclipped bounds. That is deliberate: the frame's content
 * lays out inside THAT box, so frame-local (0,0) is that box's top-left, and
 * placing the shims from it keeps a shim over the pixels the frame actually
 * paints when the shape is half-scrolled under a header.
 *
 * A rectangle that falls entirely outside the frame's box yields nothing — a
 * claim cannot reach a pixel the frame does not cover.
 */
export function shapeHitShimRects(
  regions: readonly ShapeHitRegion[],
  frameLeft: number,
  frameTop: number,
  frameWidth: number,
  frameHeight: number,
): ShapeHitShimRect[] {
  const rects: ShapeHitShimRect[] = [];
  for (const region of regions) {
    const clippedX = Math.max(region.x, 0);
    const clippedY = Math.max(region.y, 0);
    const clippedRight = Math.min(region.x + region.width, frameWidth);
    const clippedBottom = Math.min(region.y + region.height, frameHeight);
    const width = clippedRight - clippedX;
    const height = clippedBottom - clippedY;
    if (width <= 0 || height <= 0) continue;
    rects.push({
      region,
      left: frameLeft + clippedX,
      top: frameTop + clippedY,
      width,
      height,
      frameX: clippedX,
      frameY: clippedY,
    });
  }
  return rects;
}

// ============================================================================
// The shims
// ============================================================================

/**
 * Every shape that currently has ANY element of its own on the page — a shim or
 * a design-mode outline — as a snapshot.
 *
 * A snapshot rather than the live keys, because the caller's whole job is to
 * remove some of them — iterating the map while deleting from it is how a sweep
 * silently skips entries.
 *
 * BOTH maps, not just the shims: in Design Mode a shape has outlines and no
 * shims at all, so a sweep reading only `hitShims` would find nothing to release
 * and would leave a dashed rectangle floating over the next sheet's grid.
 */
export function shapeHitDomIds(): string[] {
  return [...new Set([...hitShims.keys(), ...hitOutlines.keys()])];
}

/** Remove every element a shape has over its frame — shims AND outlines. */
export function removeShapeHitDom(instanceId: string): void {
  removeShims(instanceId);
  removeOutlines(instanceId);
}

/** Remove only the pointer-claiming shims (idempotent). */
function removeShims(instanceId: string): void {
  const shims = hitShims.get(instanceId);
  if (!shims) return;
  for (const shim of shims) shim.remove();
  hitShims.delete(instanceId);
}

/** Remove only the design-mode outlines (idempotent). */
function removeOutlines(instanceId: string): void {
  const outlines = hitOutlines.get(instanceId);
  if (!outlines) return;
  for (const outline of outlines) outline.remove();
  hitOutlines.delete(instanceId);
}

/**
 * shim element -> the rectangle it CURRENTLY stands for.
 *
 * WHY THIS EXISTS RATHER THAN A CLOSURE. `syncShapeHitDom` reuses the elements
 * whenever the NUMBER of rectangles is unchanged and only repositions them, so a
 * re-declaration of two rectangles into two other rectangles keeps the same two
 * elements. The pointer handlers used to close over the `ShapeHitShimRect` they
 * were built with, and `shapeHitShimRects` allocates fresh rect objects on every
 * sync — so the closure could never catch up. The element said one thing
 * (`dataset.hitRegionId`) and the message into the frame said another: a click
 * on the rectangle drawn over Cancel told the script `save` was pressed, at the
 * OLD rectangle's frame-local origin, so the script ran the wrong handler at the
 * wrong point. Nothing in the app reads `dataset.hitRegionId` back, so the
 * divergence was silent, and it healed by accident whenever something rebuilt
 * the elements (design mode, a scroll that clipped the frame out of view, a
 * declaration with a different count) — intermittent rather than reproducible.
 * The handlers read this map, and the reposition loop writes it in the same
 * breath as the attribute, so the two cannot disagree by construction.
 */
const shimRects = new WeakMap<HTMLDivElement, ShapeHitShimRect>();

/**
 * Tell the frame that a claimed rectangle was pointed at.
 *
 * Rides the bridge `buildScriptFrameDocument` already installs, through the
 * shared poster that spells its envelope: the frame receives a `shape-message`
 * CustomEvent whose `detail.type` is the reserved `"calcula:pointer"`, so it
 * cannot collide with a type the script chose for its own traffic. Coordinates
 * are frame-local, the space the script declared in.
 */
function postPointerToFrame(
  frame: HTMLIFrameElement,
  instanceId: string,
  rect: ShapeHitShimRect,
  event: MouseEvent,
  kind: ShapeHitPointerMessage["kind"],
): void {
  // offsetX/offsetY are relative to the SHIM, and the shim's frame-local origin
  // is known, so the sum is the point in the frame's own space. A browser that
  // reports no offset (or a synthetic event) still yields the rectangle's own
  // corner, which is truthful rather than invented.
  const offsetX = Number.isFinite(event.offsetX) ? event.offsetX : 0;
  const offsetY = Number.isFinite(event.offsetY) ? event.offsetY : 0;
  const data: ShapeHitPointerMessage = {
    region: rect.region.id,
    x: rect.frameX + offsetX,
    y: rect.frameY + offsetY,
    kind,
    button: event.button,
  };
  postToScriptFrame(frame, instanceId, SHAPE_HIT_POINTER_MESSAGE_TYPE, data);
}

/** Build one transparent claim over a rectangle. */
function createShim(
  instanceId: string,
  rect: ShapeHitShimRect,
  frame: HTMLIFrameElement,
): HTMLDivElement {
  const shim = document.createElement("div");
  shim.setAttribute(SHAPE_HIT_SHIM_ATTR, instanceId);
  shim.dataset.hitRegionId = rect.region.id;
  // THE CLAIM. Without this the rectangle is decorative: this element is a
  // DESCENDANT of `S.GridArea`, which is where Core binds `onMouseDown`, so the
  // native mousedown bubbles straight past the `stopPropagation` below and into
  // the grid — which then selects the shape and opens the properties pane over
  // a rectangle the script was told it owns. `pointerdown`/`click` are not the
  // events Core listens for, and the module header's "the canvas is a SIBLING"
  // is true of the canvas and beside the point: the handler is not on the
  // canvas. `claimPointer` is Core's generic rule (@api/pointerClaims) and
  // knows nothing about shapes; a shim carries its shape's id purely as the
  // owner label. Right-click is exempt inside that rule, so the shape's own
  // menu stays reachable here exactly as the header promises.
  claimPointer(shim, instanceId);
  shimRects.set(shim, rect);
  shim.style.position = "absolute";
  shim.style.background = "transparent";
  // The whole point of the element. Everything the script did NOT declare has
  // no shim over it, so the pointer lands on the grid canvas exactly as before.
  shim.style.pointerEvents = "auto";
  shim.style.cursor = "pointer";
  // Above the iframe (z-index 5) so the claim is not covered by the frame it
  // belongs to, and below anything the app floats over the grid.
  shim.style.zIndex = "6";

  // Both handlers read the CURRENT rectangle out of `shimRects` — never the one
  // this element was created with, which goes stale the moment the script
  // re-declares the same number of rectangles (see the map's comment). A missing
  // entry means the element outlived its record, which `createShim` makes
  // impossible; dropping the event is the truthful answer, because the
  // alternative is telling the frame about a rectangle the host no longer
  // stands behind.
  const onPointerDown = (e: Event): void => {
    // The canvas is a SIBLING, so it never sees this event at all; the
    // stopPropagation is for window-level bubble listeners that would otherwise
    // read a claimed click as a grid gesture.
    e.stopPropagation();
    const current = shimRects.get(shim);
    if (!current) return;
    postPointerToFrame(frame, instanceId, current, e as MouseEvent, "pointerdown");
  };
  const onClick = (e: Event): void => {
    e.stopPropagation();
    const current = shimRects.get(shim);
    if (!current) return;
    postPointerToFrame(frame, instanceId, current, e as MouseEvent, "click");
  };
  // The grid's double-click door now honours the claim too, so a double-click
  // inside a declared rectangle no longer opens the inline editor on the cell
  // under the shape. It also therefore reaches NOTHING unless it is forwarded —
  // and "the host swallowed it" is a worse answer for a script author than
  // either of the two the host could give. Forwarded on the same bridge as the
  // other two, so a script that wants a double-click has one to listen for and
  // one that only wants `click` still gets both presses.
  const onDoubleClick = (e: Event): void => {
    e.stopPropagation();
    const current = shimRects.get(shim);
    if (!current) return;
    postPointerToFrame(frame, instanceId, current, e as MouseEvent, "dblclick");
  };
  shim.addEventListener("pointerdown", onPointerDown);
  shim.addEventListener("click", onClick);
  shim.addEventListener("dblclick", onDoubleClick);
  // NO `contextmenu` listener, deliberately: right-click stays the SHAPE's, so
  // the control's own menu is reachable even when a script has claimed the
  // whole frame.
  return shim;
}

/**
 * Bring the elements a shape owns over its frame into line with its declaration
 * and its current box — the pointer-claiming shims in run mode, the dashed
 * outlines in Design Mode, never both.
 *
 * Called from the render loop, so it must be cheap and idempotent: it rebuilds
 * the element list only when the count changed and otherwise repositions the
 * elements it already has — which is why a reused shim carries no state of its
 * own and reads its rectangle out of `shimRects` instead.
 */
export function syncShapeHitDom(opts: {
  instanceId: string;
  frame: HTMLIFrameElement;
  canvasParent: HTMLElement;
  /** The iframe's laid-out box, in canvas pixels (see `shapeHitShimRects`). */
  frameLeft: number;
  frameTop: number;
  frameWidth: number;
  frameHeight: number;
}): void {
  const { instanceId, frame, canvasParent, frameLeft, frameTop, frameWidth, frameHeight } = opts;

  const rects = shapeHitShimRects(
    getShapeHitRegions(instanceId),
    frameLeft,
    frameTop,
    frameWidth,
    frameHeight,
  );

  // Design Mode is the user's escape: while it is on, NOTHING is claimed, so a
  // shape whose script took its whole frame can still be selected, moved,
  // resized and deleted — and the same rectangles are OUTLINED instead, so the
  // user can see what was taken. Both halves are decided here, from the same
  // geometry, because "the claim is suspended" and "the claim is shown" must
  // never be able to answer differently.
  if (getDesignMode()) {
    removeShims(instanceId);
    syncOutlines(instanceId, rects, canvasParent);
    return;
  }
  removeOutlines(instanceId);

  if (rects.length === 0) {
    removeShims(instanceId);
    return;
  }

  let shims = hitShims.get(instanceId);
  if (!shims || shims.length !== rects.length) {
    removeShims(instanceId);
    shims = rects.map((rect) => {
      const shim = createShim(instanceId, rect, frame);
      canvasParent.appendChild(shim);
      return shim;
    });
    hitShims.set(instanceId, shims);
  }

  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i];
    const shim = shims[i];
    // What the element SAYS and what its handlers will REPORT are written
    // together, on purpose: an element reused across a re-declaration is the
    // whole hazard this loop has to answer for.
    shim.dataset.hitRegionId = rect.region.id;
    shimRects.set(shim, rect);
    shim.style.left = `${rect.left}px`;
    shim.style.top = `${rect.top}px`;
    shim.style.width = `${rect.width}px`;
    shim.style.height = `${rect.height}px`;
  }
}

// ============================================================================
// Design-mode chrome
// ============================================================================

/**
 * One dashed box over one declared rectangle.
 *
 * A DOM element rather than a canvas stroke because the frame is opaque and
 * paints above the canvas (see the module header): a stroke here is ink the
 * user can never see. `pointer-events: none` because Design Mode's promise is
 * that the clicks come back — the element that SHOWS a claim must not become
 * one — and z-index 7 so it is above both the frame (5) and a shim (6), even
 * though a shim cannot exist while this element does.
 */
function createOutline(instanceId: string, rect: ShapeHitShimRect): HTMLDivElement {
  const el = document.createElement("div");
  el.setAttribute(SHAPE_HIT_OUTLINE_ATTR, instanceId);
  el.dataset.hitRegionId = rect.region.id;
  el.style.position = "absolute";
  el.style.boxSizing = "border-box";
  el.style.background = "transparent";
  el.style.border = `1px dashed ${HIT_OUTLINE_COLOR}`;
  el.style.pointerEvents = "none";
  el.style.zIndex = "7";
  return el;
}

/**
 * Outline each declared rectangle while Design Mode is on.
 *
 * This is the half of the escape that makes the claim LEGIBLE: without it a
 * user who turned Design Mode on to get their clicks back would still have no
 * way to see what the script had taken, or that it had taken anything.
 *
 * Same reuse rule as the shims — rebuild only when the COUNT changed, otherwise
 * reposition — so a repaint while Design Mode is on does not churn the DOM every
 * frame. An outline carries no handlers and no rect record, so unlike a shim it
 * has nothing that can go stale beyond its own geometry.
 */
function syncOutlines(
  instanceId: string,
  rects: readonly ShapeHitShimRect[],
  canvasParent: HTMLElement,
): void {
  if (rects.length === 0) {
    removeOutlines(instanceId);
    return;
  }
  let outlines = hitOutlines.get(instanceId);
  if (!outlines || outlines.length !== rects.length) {
    removeOutlines(instanceId);
    outlines = rects.map((rect) => {
      const el = createOutline(instanceId, rect);
      canvasParent.appendChild(el);
      return el;
    });
    hitOutlines.set(instanceId, outlines);
  }
  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i];
    const el = outlines[i];
    el.dataset.hitRegionId = rect.region.id;
    el.style.left = `${rect.left}px`;
    el.style.top = `${rect.top}px`;
    el.style.width = `${rect.width}px`;
    el.style.height = `${rect.height}px`;
  }
}
