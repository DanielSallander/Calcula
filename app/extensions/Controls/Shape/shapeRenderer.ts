//! FILENAME: app/extensions/Controls/Shape/shapeRenderer.ts
// PURPOSE: Grid overlay render and hit-test functions for floating shape controls.
// CONTEXT: Registered with registerGridOverlay() via dispatcher in index.ts.
//          Follows the exact same async-cache pattern as Button/floatingRenderer.ts.

import type {
  OverlayRenderContext,
  OverlayHitTestContext,
} from "@api/gridOverlays";
import {
  overlayGetRowHeaderWidth,
  overlayGetColHeaderHeight,
  overlaySheetToCanvas,
} from "@api/gridOverlays";
import { emitAppEvent } from "@api/events";
import { showToast } from "@api/notifications";
import { getShapeBitmap, hasShapeBitmapRenderer } from "@api";
import { getDesignMode } from "../lib/designMode";
import {
  clearShapeHitRegions,
  migrateShapeHitRegions,
  removeShapeHitDom,
  shapeHitDomIds,
  syncShapeHitDom,
} from "./shapeHitRegions";
import { onFloatingControlRegionsPublished } from "../lib/regionPublication";
import {
  buildScriptFrameDocument,
  claimScriptFrameSlot,
  createScriptFrameRouter,
  migrateScriptFrameSlot,
  parkScriptFrameSlot,
  readScriptFrameThemeTokens,
  releaseScriptFrameSlot,
  scriptFrameBudgetUsage,
  setScriptFrameInert,
  unparkScriptFrameSlot,
  type ScriptFrameSlotRefusal,
} from "../../_shared/scriptFrame";
import { resolveControlProperties } from "../lib/controlApi";
import { isFloatingControlSelected, getSelectedFloatingControls } from "../Button/floatingSelection";
import { getShapeDefinition, isConnectorShape, type ShapePathCommand } from "./shapeCatalog";

// ============================================================================
// Global postMessage listener (receives messages from shape iframes)
// ============================================================================

// The protocol, the integrity check and the reserved-type handling all live in
// extensions/_shared/scriptFrame — ONE definition shared with the Controls-pane
// card host, which listens on this same window for its own frames. This router
// resolves only the ids THIS host registered, so the two never fight over an id.
const routeShapeFrameMessage = createScriptFrameRouter({
  resolveFrame: (instanceId) => htmlOverlayElements.get(instanceId) ?? null,
  deliver: ({ instanceId, type, data }) => {
    emitAppEvent("shape:htmlMessage", { instanceId, type, data });
  },
  // No onIntrinsicSize: an on-grid shape is the size the user drew it. The
  // report is still CONSUMED rather than forwarded — bridge plumbing must not
  // arrive at a script as if its own page had sent it.
});

window.addEventListener("message", (e) => {
  routeShapeFrameMessage(e);
});

// ============================================================================
// Cached Metadata (async fetch with sync render)
// ============================================================================

interface CachedShapeData {
  shapeType: string;
  fill: string;
  stroke: string;
  strokeWidth: number;
  text: string;
  textColor: string;
  fontSize: number;
  fontBold: boolean;
  fontItalic: boolean;
  textAlign: CanvasTextAlign;
  opacity: number;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
}

const shapeDataCache = new Map<string, CachedShapeData>();
const pendingFetches = new Set<string>();

/**
 * Set of control IDs whose cached data is stale.
 * Stale entries are kept visible during rendering while a re-fetch is
 * in progress, preventing a visible "blink" to default values.
 */
const staleEntries = new Set<string>();

// ============================================================================
// Custom Renderers (from shape scripts)
// ============================================================================

type CustomCanvasRenderer = (ctx: CanvasRenderingContext2D, bounds: { x: number; y: number; width: number; height: number }) => void;

/** Map of controlId -> custom canvas renderer provided by a shape script. */
const customCanvasRenderers = new Map<string, CustomCanvasRenderer>();

/** Map of controlId -> HTML content string provided by a shape script. */
const customHtmlContent = new Map<string, string>();

/** Map of controlId -> iframe overlay element for interactive HTML shapes. */
const htmlOverlayElements = new Map<string, HTMLIFrameElement>();

/** Track content hash per controlId to avoid unnecessary iframe reloads. */
const overlayContentHash = new Map<string, string>();

// ----------------------------------------------------------------------------
// A refused frame budget
//
// The budget refuses a NEW frame once the workbook already holds 24 of them, or
// once their documents total 16 MB. What the shape does about it is decided
// here, because the alternative shipped once and was worse than the budget it
// was protecting: the render pass returned early on a refusal, so the shape
// painted NOTHING — no fill, no stroke, no text, not even the default rectangle
// a shape without any html would draw — while staying selectable, an invisible
// hole in the grid. And it was mute: `claimScriptFrameSlot` builds a sentence
// naming the budget and the way out, and the call site dropped it, where the
// pane card host shows the same sentence in place of its frame.
//
// So a refusal now does two things. The render pass falls through to the
// ordinary shape catalog (the shape is drawn as if it had no html at all), and
// the sentence is said out loud: `console.warn` per instance so a diagnosis
// names every affected shape, and one toast per REFUSAL KIND so a dashboard
// with a dozen refused shapes tells the user once rather than a dozen times.
//
// AND IT DOES NOT KEEP TRYING. A refused shape has no frame and no content
// hash, so it re-enters the "needs a document" branch on every single paint —
// rebuilding a document the per-call validator lets reach 5 MB, sixty times a
// second, for a claim already known to fail. The record below remembers the
// html and the budget as they stood when the answer came back, and a repaint
// that changes neither is answered from it. Releasing another frame moves the
// budget, so the retry the refusal sentence tells the user to make still
// happens on the very next paint.
// ----------------------------------------------------------------------------

/** What the budget said, and what it said it about. */
interface FrameRefusalRecord {
  refusal: ScriptFrameSlotRefusal;
  message: string;
  /** The exact html that was turned down. Different content is a new question. */
  html: string;
  /** The budget's occupancy at the moment of refusal, as one comparable string.
   *  A different occupancy is also a new question — that is the self-heal. */
  budgetStamp: string;
}

/** Map of controlId -> the standing refusal for its html frame. */
const frameRefusals = new Map<string, FrameRefusalRecord>();

/** Refusal kinds already toasted; cleared when nothing is refused any more, so
 *  a budget that fills up again is announced again rather than staying silent
 *  for the rest of the session. */
const announcedRefusalKinds = new Set<ScriptFrameSlotRefusal>();

function currentBudgetStamp(): string {
  const usage = scriptFrameBudgetUsage();
  return `${usage.frames}:${usage.bytes}`;
}

/** The refusal sentence for a shape whose html frame the budget turned down,
 *  or undefined when its frame is live (or it has no html at all). */
export function getShapeFrameRefusal(instanceId: string): string | undefined {
  return frameRefusals.get(instanceId)?.message;
}

/** Record a refusal and say it once. Repeated frames of the same refusal are
 *  silent — this runs from the render loop. */
function noteFrameRefusal(
  instanceId: string,
  refusal: ScriptFrameSlotRefusal,
  message: string,
  html: string,
): void {
  const previous = frameRefusals.get(instanceId);
  // The record is rewritten either way: the budget or the content moved to get
  // here, and a stale stamp would make the next paint ask all over again.
  frameRefusals.set(instanceId, {
    refusal,
    message,
    html,
    budgetStamp: currentBudgetStamp(),
  });
  if (previous?.message === message) return;
  console.warn(`[ShapeRenderer] HTML frame refused for ${instanceId}: ${message}`);
  if (!announcedRefusalKinds.has(refusal)) {
    announcedRefusalKinds.add(refusal);
    showToast(`This shape is drawn without its HTML: ${message}`, { variant: "warning" });
  }
}

/** Forget a refusal — the frame was granted, or the shape lost its html. */
function clearFrameRefusal(instanceId: string): void {
  if (!frameRefusals.delete(instanceId)) return;
  if (frameRefusals.size === 0) announcedRefusalKinds.clear();
}

/** Register a custom canvas renderer for a shape. */
export function setCustomCanvasRenderer(instanceId: string, renderer: CustomCanvasRenderer): void {
  customCanvasRenderers.set(instanceId, renderer);
}

/** Remove a custom canvas renderer for a shape. */
export function removeCustomCanvasRenderer(instanceId: string): void {
  customCanvasRenderers.delete(instanceId);
}

/** Set HTML content for a shape (will skip canvas rendering). */
export function setShapeHtmlContent(instanceId: string, html: string): void {
  customHtmlContent.set(instanceId, html);
  // Mark hash as stale so the iframe reloads on next render
  overlayContentHash.delete(instanceId);
}

/** Get HTML content for a shape. */
export function getShapeHtmlContent(instanceId: string): string | undefined {
  return customHtmlContent.get(instanceId);
}

/** Check if a shape has custom HTML content. */
export function hasShapeHtmlContent(instanceId: string): boolean {
  return customHtmlContent.has(instanceId);
}

/** Get the iframe overlay element for a shape (for sending messages). */
export function getShapeOverlayFrame(instanceId: string): HTMLIFrameElement | null {
  return htmlOverlayElements.get(instanceId) ?? null;
}

/** Remove the HTML overlay iframe element for a shape (cleanup on deletion). */
export function removeShapeHtmlOverlay(instanceId: string): void {
  const el = htmlOverlayElements.get(instanceId);
  if (el) {
    el.remove();
    htmlOverlayElements.delete(instanceId);
  }
  customHtmlContent.delete(instanceId);
  overlayContentHash.delete(instanceId);
  // A shape with no html has nothing left to refuse, and leaving the record
  // behind would keep the "already announced" latch shut for a budget that has
  // just been given room.
  clearFrameRefusal(instanceId);
  // ...and its share of the frame budget. A charge that outlives its frame is a
  // slow leak that eventually refuses a frame nothing is actually holding.
  releaseScriptFrameSlot(instanceId);
  // The frame is gone, so its declared hit rectangles have nothing to claim on
  // behalf of. Dropped HERE rather than at each of the four call sites, because
  // a shim that outlives its frame is an invisible element eating clicks over
  // the bare grid.
  clearShapeHitRegions(instanceId);
}

/**
 * Park the DOM a shape keeps OUTSIDE the canvas — its overlay iframe, the shims
 * claiming pointer input over it and the design-mode outlines showing what was
 * claimed — for every shape that is no longer painted.
 *
 * WHY THIS EXISTS. Every other release runs from inside the render pass or from
 * an explicit teardown, so all of them assume the shape is still being
 * rendered. A shape that simply STOPS being rendered reached none of them: a
 * sheet switch swaps the floating store, the departing sheet's control loses its
 * overlay region, `renderFloatingShape` is never called for it again — and its
 * shims stayed exactly where they were, `pointer-events: auto` at zIndex 6 in
 * the canvas parent, swallowing every click on the NEXT sheet's bare grid, with
 * Design Mode unable to give them back (the suspension lives in
 * `syncShapeHitDom`, the function that is no longer running). A shape left
 * behind IN Design Mode is the same failure wearing the other coat: no shims to
 * strand, but a dashed outline still drawn over the next sheet's grid, naming a
 * claim nothing on screen is making.
 *
 * PARKED, NOT TORN DOWN. Nothing here touches what the SCRIPT declared — the
 * html content and the hit rectangles both survive — because the script is still
 * mounted and will never re-declare on its own: the user switching back to the
 * sheet must get the same interactive shape, not a blank frame. The frame is
 * hidden rather than removed for the same reason the off-screen branch hides it:
 * `display: none` costs the frame nothing, where removing the element would
 * reload its srcdoc and drop whatever state its own scripts had built up. The
 * next paint of that shape sets `display: block` and rebuilds the shims from the
 * declaration, so this is exactly reversible.
 *
 * PARKED IS NOT FREE, THOUGH. A hidden frame is still a whole document holding
 * the user's memory, and it still held its share of the live-frame budget — with
 * nothing anywhere ever giving it back, because the budget's only release ran
 * from teardown paths a parked shape reaches by definition never. Twenty-four
 * frames on a sheet nobody is looking at therefore refused every frame on the
 * sheet the user IS looking at, permanently and silently. So the budget is TOLD
 * the frame is parked: the charge stands (the memory is real), but it becomes
 * the first thing spent when the next sheet's shapes need room, and
 * `evictParkedShapeFrame` below is what the budget calls to make that teardown
 * real.
 */
export function releaseUnpaintedShapeOverlays(paintedIds: ReadonlySet<string>): void {
  for (const instanceId of shapeHitDomIds()) {
    if (!paintedIds.has(instanceId)) removeShapeHitDom(instanceId);
  }
  for (const [instanceId, el] of htmlOverlayElements) {
    // `display: none` does not travel to the shims (they are siblings of the
    // frame, not children), which is why both halves are swept here: a hidden
    // frame with live shims is the invisible click-eater, and a live frame with
    // no shims is a stale picture on the wrong sheet.
    if (paintedIds.has(instanceId)) continue;
    el.style.display = "none";
    parkScriptFrameSlot(instanceId, evictParkedShapeFrame);
  }
}

/**
 * Give a parked frame's memory back because another frame needs it.
 *
 * Called by the budget, and only for a frame this host parked. The DOM goes —
 * that is the point: the charge has already been dropped, and an element that
 * outlives its charge is the same leak wearing the other coat. What the SCRIPT
 * declared stays: `customHtmlContent` and the hit-region declaration both
 * survive, so the shape rebuilds itself on its next paint exactly as a first
 * paint would and claims the budget again then. The content hash goes with the
 * element, because a hash with no frame would make that next paint believe the
 * document was already loaded.
 *
 * What is lost is the frame's own internal state — its scripts start over. That
 * is precisely the cost the parking above exists to avoid, and it is now paid
 * only under real pressure instead of the budget being spent forever.
 */
function evictParkedShapeFrame(instanceId: string): void {
  const el = htmlOverlayElements.get(instanceId);
  if (el) {
    el.remove();
    htmlOverlayElements.delete(instanceId);
  }
  overlayContentHash.delete(instanceId);
  // Belt and braces: a parked shape's shims were already dropped by the sweep
  // above, but an evictor that leaves DOM behind is exactly the class of defect
  // this function exists to close.
  removeShapeHitDom(instanceId);
}

/**
 * Tear down EVERY on-grid html frame, and everything keyed alongside one.
 *
 * The DOCUMENT-lifecycle release, wired to File > New / File > Open and to the
 * extension's deactivate. Nothing did this at all: the budget's charges, the
 * script-supplied html and the content hashes all survived a document swap, so
 * the second workbook of a session began with the first one's frames still
 * charged — the budget measured "frames ever created this session" rather than
 * "frames alive", and the refusal sentence's "this workbook already has N" was
 * counting somebody else's workbook. A control's id derives from its anchor
 * cell, so the surviving content was worse than an accounting error: a plain
 * shape in the new workbook, at an anchor the old one had an html shape at,
 * painted the OLD workbook's frame.
 *
 * Every id is RELEASED rather than the budget being blanket-reset. Forgetting a
 * charge is only honest when the frame it stood for is really gone, and this is
 * the function that makes that true.
 */
export function releaseAllShapeHtmlOverlays(): void {
  // The UNION of every map this host keys by control id, walked once, so no
  // single map's bookkeeping decides what gets released. They very nearly
  // coincide, but not exactly: a shape the budget refused has html and no
  // element, one the budget evicted while parked has html and no hash, and a
  // frame that is on screen has all of them.
  const instanceIds = new Set<string>([
    ...htmlOverlayElements.keys(),
    ...customHtmlContent.keys(),
    ...overlayContentHash.keys(),
    ...frameRefusals.keys(),
  ]);
  for (const instanceId of instanceIds) {
    htmlOverlayElements.get(instanceId)?.remove();
    releaseScriptFrameSlot(instanceId);
    clearShapeHitRegions(instanceId);
  }
  htmlOverlayElements.clear();
  customHtmlContent.clear();
  overlayContentHash.clear();
  frameRefusals.clear();
  announcedRefusalKinds.clear();
}

// The subscription is made at MODULE SCOPE, not from the extension's activate,
// because that is what makes it impossible to forget: a shim or an overlay frame
// can only exist once this module has been loaded, so the listener is always in
// place before there is anything to release — and it stays in place across a
// deactivate/activate cycle, exactly like the maps it sweeps.
onFloatingControlRegionsPublished(releaseUnpaintedShapeOverlays);

/**
 * Migrate every id-keyed piece of shape state to a control's NEW id.
 *
 * A structural edit re-keys a pinned control (its id derives from its anchor
 * cell). Without migrating, a scripted shape lost its canvas renderer and HTML
 * content and leaked its iframe under the old id. The content hash moves too so
 * the existing iframe is reused rather than reloaded.
 */
export function migrateShapeInstanceId(oldId: string, newId: string): void {
  if (oldId === newId) return;
  const renderer = customCanvasRenderers.get(oldId);
  if (renderer !== undefined) {
    customCanvasRenderers.delete(oldId);
    customCanvasRenderers.set(newId, renderer);
  }
  const html = customHtmlContent.get(oldId);
  if (html !== undefined) {
    customHtmlContent.delete(oldId);
    customHtmlContent.set(newId, html);
  }
  const frame = htmlOverlayElements.get(oldId);
  if (frame !== undefined) {
    htmlOverlayElements.delete(oldId);
    // The destination id can already own a frame: ids are anchor-derived, and a
    // re-anchor lands a pinned control on a cell an unpinned one still anchors
    // (nothing checks for the collision). Setting over that entry orphaned a
    // LIVE document in the canvas parent — no map names it, so no teardown,
    // sheet switch or File > New can ever reach it again, and it keeps painting
    // over the grid. Removed here, so the element and its budget charge (dropped
    // by `migrateScriptFrameSlot` below) go together.
    htmlOverlayElements.get(newId)?.remove();
    htmlOverlayElements.set(newId, frame);
    // The element's own label follows the re-key as well: it is how a frame
    // sitting in the canvas parent is traced back to a control, and one still
    // naming the dead id makes a migrated frame and an orphan look alike.
    frame.dataset.shapeOverlay = newId;
  }
  const hash = overlayContentHash.get(oldId);
  if (hash !== undefined) {
    overlayContentHash.delete(oldId);
    overlayContentHash.set(newId, hash);
  }
  // A standing refusal moves with the control too. Left under the old id it
  // would re-announce itself on the new id's very next paint, and
  // `getShapeFrameRefusal` would answer for a control that no longer exists.
  const refusal = frameRefusals.get(oldId);
  if (refusal !== undefined) {
    frameRefusals.delete(oldId);
    frameRefusals.set(newId, refusal);
  }
  // The frame budget is keyed by instanceId too. Leaving the charge under the
  // old id leaks it forever AND leaves the new id uncounted — the budget would
  // drift in both directions at once on every structural edit.
  migrateScriptFrameSlot(oldId, newId);
  migrateShapeHitRegions(oldId, newId);
}

/**
 * Build the full document for the overlay iframe.
 *
 * The document itself — bridge, protocol spellings, theme contract — is built
 * by extensions/_shared/scriptFrame, shared byte-for-byte with the pane card
 * host. Only the on-grid flavour is decided here: no min-height, because an
 * on-grid shape is exactly the box the user drew.
 */
function buildOverlayDocument(controlId: string, userHtml: string): string {
  return buildScriptFrameDocument(controlId, userHtml, {
    themeTokens: readScriptFrameThemeTokens(),
  });
}

/** The frame's laid-out box in canvas pixels. */
interface HtmlOverlayBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Create or update the positioned iframe overlay element for a shape.
 * Called from the render loop with current viewport info.
 *
 * The design-mode chrome for a claimed rectangle is placed from HERE too, by
 * `syncShapeHitDom`, over the same clipped box the shims are placed on. It used
 * to be returned to the caller so the renderer could stroke it onto the canvas,
 * and every one of those strokes landed UNDER this opaque frame — the outline
 * has to be a sibling element above it (see shapeHitRegions.ts's header), which
 * means it is placed where the box is known rather than computed a second time.
 *
 * Returns whether the frame OWNS the shape's pixels this paint. `false` is the
 * budget refusing it, and the caller must then paint the ordinary shape: this
 * function returned void for one release, so a refusal painted nothing at all.
 */
function updateHtmlOverlay(
  controlId: string,
  html: string,
  canvasX: number,
  canvasY: number,
  width: number,
  height: number,
  rowHeaderWidth: number,
  colHeaderHeight: number,
  canvasWidth: number,
  canvasHeight: number,
  canvasParent: HTMLElement,
): boolean {
  let el = htmlOverlayElements.get(controlId);

  // Being painted is the opposite of being parked, and the unpark has to happen
  // HERE rather than in the claim below: a shape whose content has not changed
  // never reaches the claim, so a frame that came back from a sheet switch would
  // stay on the eviction list — visible, interactive, and first in line to be
  // torn down under the next shape's pressure. Idempotent and cheap, which it
  // has to be: this runs from the render loop.
  unparkScriptFrameSlot(controlId);

  // The document is rebuilt only when the content actually changed (or there is
  // no frame yet) — this runs from the render loop, and re-assigning `srcdoc`
  // reloads the frame and throws away whatever state its own scripts built.
  const needsDocument = !el || overlayContentHash.get(controlId) !== html;
  let overlayDocument: string | null = null;
  if (needsDocument) {
    // A refusal that nothing has changed since is answered from the record
    // rather than by rebuilding a document (up to 5 MB of it) and asking a
    // question whose answer is already known. Neither branch below is skipped
    // when the html or the budget HAS moved, so the way out the refusal
    // sentence names — clear another frame — takes effect on the next paint.
    const standing = frameRefusals.get(controlId);
    if (standing && standing.html === html && standing.budgetStamp === currentBudgetStamp()) {
      return false;
    }
    overlayDocument = buildOverlayDocument(controlId, html);
    // The frame budget, charged BEFORE the element exists. A workbook has no
    // limit on shapes and a frame is a whole document with its own event loop,
    // so an app that puts one on every shape it owns spends the user's memory
    // until Calcula dies — and it looks like Calcula being slow rather than an
    // app misbehaving. Re-priced (never double-counted) per instanceId. A
    // refusal tears down the frame — no frame, no shims, no half-built element
    // to strand — and answers `false`, which is what makes the caller paint the
    // shape from the catalog instead of leaving a hole in the grid.
    const slot = claimScriptFrameSlot(controlId, overlayDocument.length);
    if (!slot.granted) {
      if (el) {
        el.remove();
        htmlOverlayElements.delete(controlId);
        overlayContentHash.delete(controlId);
        releaseScriptFrameSlot(controlId);
      }
      removeShapeHitDom(controlId);
      noteFrameRefusal(
        controlId,
        slot.refusal ?? "too-many-frames",
        slot.message ?? "the workbook's live HTML frame budget is full",
        html,
      );
      return false;
    }
    // Granted: whatever the last paint refused is history, and the shape's
    // pixels are the frame's again.
    clearFrameRefusal(controlId);
  }

  // Create iframe if it doesn't exist
  if (!el) {
    el = document.createElement("iframe");
    el.dataset.shapeOverlay = controlId;
    // allow-scripts only: with srcdoc this gives the iframe an opaque origin,
    // so its scripts cannot reach the parent window, app-origin storage, or
    // __TAURI__. The postMessage bridge below is the only communication path.
    el.sandbox.add("allow-scripts");
    el.style.position = "absolute";
    el.style.overflow = "hidden";
    el.style.boxSizing = "border-box";
    el.style.border = "1px solid #d0d0d0";
    el.style.borderRadius = "4px";
    el.style.background = "#ffffff";
    el.style.boxShadow = "0 2px 8px rgba(0,0,0,0.12)";
    // The FRAME itself never takes pointer events, in either mode. Turning this
    // to "auto" would hand the script every pixel of the shape's box — including
    // the ones that select, move and resize the shape — and CSS cannot make one
    // element hit-transparent in part of its box while still painting there.
    // Pointer input is claimed a rectangle at a time instead, by the shim
    // elements `syncShapeHitDom` puts ABOVE this frame (M3b). Undeclared
    // pixels stay click-through exactly as they were.
    //
    // The `background: #ffffff` above is also why the design-mode outline is an
    // element and not a canvas stroke: this frame is opaque and paints over the
    // canvas, so anything drawn on the canvas inside its box is invisible.
    el.style.pointerEvents = "none";
    // ...and the KEYBOARD never reaches it either, in either mode. Hit-
    // transparency is a mouse property: the frame stayed in the tab order, so
    // Tab walked out of the grid and into the script's own `<input>`, and a
    // document painted under `ui.html` alone read what was typed there. The
    // shims are SIBLINGS of this element rather than children, so inertness
    // does not travel to them and the claimed path keeps working exactly as it
    // did — the frame is fed synthesized pointer events, which an inert
    // document still receives.
    setScriptFrameInert(el, true);
    el.style.zIndex = "5";
    el.srcdoc = overlayDocument as string;
    overlayContentHash.set(controlId, html);
    canvasParent.appendChild(el);
    htmlOverlayElements.set(controlId, el);
  }

  // Check visibility: hide if off-screen or behind headers
  const endX = canvasX + width;
  const endY = canvasY + height;
  const isVisible = endX > rowHeaderWidth && endY > colHeaderHeight &&
                    canvasX < canvasWidth && canvasY < canvasHeight;

  if (!isVisible) {
    el.style.display = "none";
    // A hidden frame claims nothing, and says nothing about a claim either:
    // `display: none` does not travel to the shims or the outlines (they are
    // siblings, not children), so leaving them behind would leave invisible
    // click-eaters — and, in Design Mode, a dashed rectangle naming a claim that
    // is nowhere on screen — over whatever scrolled into that space.
    removeShapeHitDom(controlId);
    // The frame is alive and still owns these pixels; it is merely scrolled
    // where none of them are on screen. Painting the catalog shape here would
    // draw an ordinary rectangle under the header the frame is hiding behind.
    return true;
  }

  el.style.display = "block";

  // Clip to visible area (don't overlap headers)
  const clippedLeft = Math.max(canvasX, rowHeaderWidth);
  const clippedTop = Math.max(canvasY, colHeaderHeight);
  const clippedRight = Math.min(endX, canvasWidth);
  const clippedBottom = Math.min(endY, canvasHeight);

  const box: HtmlOverlayBox = {
    left: clippedLeft,
    top: clippedTop,
    width: clippedRight - clippedLeft,
    height: clippedBottom - clippedTop,
  };

  el.style.left = `${box.left}px`;
  el.style.top = `${box.top}px`;
  el.style.width = `${box.width}px`;
  el.style.height = `${box.height}px`;

  // Update content only if changed (avoid iframe reload on every render).
  // `overlayDocument` is non-null exactly when it did change — the budget was
  // charged for that document above.
  if (overlayDocument !== null && overlayContentHash.get(controlId) !== html) {
    el.srcdoc = overlayDocument;
    overlayContentHash.set(controlId, html);
  }

  // Claim whatever the script declared — or, in Design Mode, outline it instead
  // of claiming it — over the frame's CLIPPED box: the box the frame's own
  // content lays out in, so a shim sits on the pixels the frame actually paints
  // even when the shape is half-scrolled under a header.
  syncShapeHitDom({
    instanceId: controlId,
    frame: el,
    canvasParent,
    frameLeft: box.left,
    frameTop: box.top,
    frameWidth: box.width,
    frameHeight: box.height,
  });

  return true;
}

// ============================================================================
// Script Status Tracking
// ============================================================================

/** Set of controlIds that have a script attached. */
const shapesWithScripts = new Set<string>();

/** Mark a shape as having a script attached. */
export function markShapeHasScript(instanceId: string): void {
  shapesWithScripts.add(instanceId);
}

/** Mark a shape as no longer having a script. */
export function unmarkShapeHasScript(instanceId: string): void {
  shapesWithScripts.delete(instanceId);
}

/** Check if a shape has a script attached. */
export function shapeHasScript(instanceId: string): boolean {
  return shapesWithScripts.has(instanceId);
}

/** Invalidate cached data for a specific shape control. */
export function invalidateShapeCache(controlId: string): void {
  staleEntries.add(controlId);
  pendingFetches.delete(controlId);
}

/** Invalidate all cached shape data. */
export function invalidateAllShapeCaches(): void {
  for (const key of shapeDataCache.keys()) {
    staleEntries.add(key);
  }
  pendingFetches.clear();
}

// ============================================================================
// Selection Indicator Helper
// ============================================================================

/**
 * Draw selection border and resize handles for a shape control.
 * Used by both default and custom renderers.
 */
function drawSelectionIndicators(
  ctx: CanvasRenderingContext2D,
  controlId: string,
  canvasX: number,
  canvasY: number,
  shapeWidth: number,
  shapeHeight: number,
  _overlayCtx: OverlayRenderContext,
): void {
  if (!getDesignMode()) return;
  const selected = isFloatingControlSelected(controlId);
  if (!selected) return;

  ctx.strokeStyle = "#0e639c";
  ctx.lineWidth = 2;
  ctx.setLineDash([]);
  ctx.strokeRect(canvasX + 1, canvasY + 1, shapeWidth - 2, shapeHeight - 2);
  drawResizeHandles(ctx, canvasX, canvasY, shapeWidth, shapeHeight);
}

// ============================================================================
// Path Rendering
// ============================================================================

/**
 * Build a Canvas 2D path from normalized shape path commands.
 * Coordinates are scaled from [0,1] to actual [width, height] with offset.
 */
function buildPath(
  ctx: CanvasRenderingContext2D,
  commands: ShapePathCommand[],
  width: number,
  height: number,
  offsetX: number,
  offsetY: number,
): void {
  ctx.beginPath();
  for (const cmd of commands) {
    switch (cmd.op) {
      case "M":
        ctx.moveTo(offsetX + cmd.x * width, offsetY + cmd.y * height);
        break;
      case "L":
        ctx.lineTo(offsetX + cmd.x * width, offsetY + cmd.y * height);
        break;
      case "C":
        ctx.bezierCurveTo(
          offsetX + cmd.x1 * width,
          offsetY + cmd.y1 * height,
          offsetX + cmd.x2 * width,
          offsetY + cmd.y2 * height,
          offsetX + cmd.x * width,
          offsetY + cmd.y * height,
        );
        break;
      case "Q":
        ctx.quadraticCurveTo(
          offsetX + cmd.x1 * width,
          offsetY + cmd.y1 * height,
          offsetX + cmd.x * width,
          offsetY + cmd.y * height,
        );
        break;
      case "Z":
        ctx.closePath();
        break;
    }
  }
}

// ============================================================================
// Overlay Render Function
// ============================================================================

/**
 * Render function for floating shape controls.
 * Called synchronously for each floating-control region with controlType "shape".
 */
export function renderFloatingShape(overlayCtx: OverlayRenderContext): void {
  const { ctx, region } = overlayCtx;
  if (!region.floating) return;
  if (region.data?.controlType !== "shape") return;

  const sheetIndex = region.data?.sheetIndex as number;
  const row = region.data?.row as number;
  const col = region.data?.col as number;
  if (sheetIndex == null || row == null || col == null) return;

  const rowHeaderWidth = overlayGetRowHeaderWidth(overlayCtx);
  const colHeaderHeight = overlayGetColHeaderHeight(overlayCtx);

  // Convert sheet pixel position to canvas pixel position
  const { canvasX, canvasY } = overlaySheetToCanvas(
    overlayCtx,
    region.floating.x,
    region.floating.y,
  );
  const shapeWidth = region.floating.width;
  const shapeHeight = region.floating.height;

  const endX = canvasX + shapeWidth;
  const endY = canvasY + shapeHeight;

  // Skip if not visible. These early-outs bypass updateHtmlOverlay entirely, so
  // a shape scrolled off screen would otherwise keep its hit shims — and, in
  // Design Mode, its outlines — at the canvas pixels it USED to occupy:
  // invisible click-eaters, or a dashed rectangle naming a claim nothing on
  // screen is making, sitting over whatever scrolled into that space. Release
  // them here, at the two returns that skip the only code that would have
  // repositioned them.
  if (endX < rowHeaderWidth || endY < colHeaderHeight) {
    removeShapeHitDom(region.id);
    return;
  }
  if (canvasX > overlayCtx.canvasWidth || canvasY > overlayCtx.canvasHeight) {
    removeShapeHitDom(region.id);
    return;
  }

  // Clip to cell area (not over headers)
  ctx.save();
  ctx.beginPath();
  ctx.rect(
    rowHeaderWidth,
    colHeaderHeight,
    overlayCtx.canvasWidth - rowHeaderWidth,
    overlayCtx.canvasHeight - colHeaderHeight,
  );
  ctx.clip();

  // Get cached shape data or trigger async fetch
  const controlId = region.id;
  let data = shapeDataCache.get(controlId);
  const isStale = staleEntries.has(controlId);

  if ((!data || isStale) && !pendingFetches.has(controlId)) {
    fetchShapeData(controlId, sheetIndex, row, col);
  }
  if (!data) {
    data = {
      shapeType: "rectangle",
      fill: "#4472C4",
      stroke: "#2F528F",
      strokeWidth: 1,
      text: "",
      textColor: "#FFFFFF",
      fontSize: 11,
      fontBold: false,
      fontItalic: false,
      textAlign: "center",
      opacity: 1,
      rotation: 0,
      flipH: false,
      flipV: false,
    };
  }

  // Worker-realm scripts provide cached bitmaps instead of functions
  // (sandbox design §6.2): blit inside the existing clip — a script can
  // never paint outside its region. Missing bitmap = single-flight request
  // queued; skip the custom layer this frame (graceful degradation).
  if (hasShapeBitmapRenderer(controlId)) {
    const bmp = getShapeBitmap(controlId, shapeWidth, shapeHeight, window.devicePixelRatio || 1);
    if (bmp) {
      ctx.drawImage(bmp, canvasX, canvasY, shapeWidth, shapeHeight);
    }
    drawSelectionIndicators(ctx, controlId, canvasX, canvasY, shapeWidth, shapeHeight, overlayCtx);
    ctx.restore();
    return;
  }

  // Check for custom canvas renderer from shape script (legacy main-thread path)
  const customRenderer = customCanvasRenderers.get(controlId);
  if (customRenderer) {
    try {
      customRenderer(ctx, { x: canvasX, y: canvasY, width: shapeWidth, height: shapeHeight });
    } catch (err) {
      console.error("[ShapeRenderer] Custom renderer error:", err);
    }
    // Still draw selection indicators if in design mode
    drawSelectionIndicators(ctx, controlId, canvasX, canvasY, shapeWidth, shapeHeight, overlayCtx);
    ctx.restore();
    return;
  }

  // If shape has HTML content, the pixels are the DOM overlay's — there is no
  // canvas preview of an html shape in either mode, and nothing the canvas
  // paints inside the frame's box can be seen through it.
  //
  // ...UNLESS there is no frame. `updateHtmlOverlay` answers `false` when the
  // live-frame budget refused this one, and a canvas parent is a precondition
  // for a DOM overlay existing at all. In either case the html is not on
  // screen, so the pixels are the CANVAS's again and this branch must fall
  // through to the shape catalog below. It returned unconditionally for one
  // release: a refused shape painted no fill, no stroke, no text — an invisible
  // hole in the grid that could still be selected, with nothing said anywhere.
  const htmlContent = customHtmlContent.get(controlId);
  const canvasParent = htmlContent !== undefined ? ctx.canvas.parentElement : null;
  // The frame itself is always click-through; only the rectangles the script
  // DECLARED take pointer input, and `updateHtmlOverlay` places those — along
  // with the design-mode outlines that show them, which have to be siblings
  // ABOVE the frame rather than strokes on the canvas under it.
  const framePaintsTheShape =
    htmlContent !== undefined &&
    canvasParent !== null &&
    updateHtmlOverlay(
      controlId,
      htmlContent,
      canvasX,
      canvasY,
      shapeWidth,
      shapeHeight,
      rowHeaderWidth,
      colHeaderHeight,
      overlayCtx.canvasWidth,
      overlayCtx.canvasHeight,
      canvasParent,
    );

  if (framePaintsTheShape) {
    // Selection border and resize handles. NOT "on top of the iframe", as this
    // said until the outline defect was traced: these are canvas strokes at the
    // shape's bounds, which is exactly the box the opaque frame covers, so on
    // this path they are painted UNDER it and only the sub-pixel slivers outside
    // its border-radius show. The shape is still selectable (hit-testing is
    // canvas-side) and still movable; what is missing is the picture of it. The
    // fix is the same one the hit-region outline just took — a sibling element
    // above the frame — and it is filed rather than smuggled in here.
    drawSelectionIndicators(ctx, controlId, canvasX, canvasY, shapeWidth, shapeHeight, overlayCtx);
    ctx.restore();
    return;
  }

  if (htmlContent === undefined) {
    // A shape with no html has nothing the budget could be refusing, whichever
    // way it lost the content.
    clearFrameRefusal(controlId);
    // No HTML content — remove any leftover overlay element
    const existingOverlay = htmlOverlayElements.get(controlId);
    if (existingOverlay) {
      existingOverlay.remove();
      htmlOverlayElements.delete(controlId);
      overlayContentHash.delete(controlId);
      releaseScriptFrameSlot(controlId);
      // ...and the claim that frame carried. A shim over a frame that is no
      // longer painted is an invisible element eating clicks on bare grid.
      clearShapeHitRegions(controlId);
    }
  }

  const shapeDef = getShapeDefinition(data.shapeType);
  if (!shapeDef) {
    ctx.restore();
    return;
  }

  // Apply opacity
  const prevAlpha = ctx.globalAlpha;
  ctx.globalAlpha = Math.max(0, Math.min(1, data.opacity));

  // Apply rotation around center
  if (data.rotation !== 0) {
    const cx = canvasX + shapeWidth / 2;
    const cy = canvasY + shapeHeight / 2;
    ctx.translate(cx, cy);
    ctx.rotate((data.rotation * Math.PI) / 180);
    ctx.translate(-cx, -cy);
  }

  // Apply flip transforms around center
  if (data.flipH || data.flipV) {
    const cx = canvasX + shapeWidth / 2;
    const cy = canvasY + shapeHeight / 2;
    ctx.translate(cx, cy);
    ctx.scale(data.flipH ? -1 : 1, data.flipV ? -1 : 1);
    ctx.translate(-cx, -cy);
  }

  // 1. Fill path (skip for line shapes)
  if (!shapeDef.isLine) {
    buildPath(ctx, shapeDef.path, shapeWidth, shapeHeight, canvasX, canvasY);
    ctx.fillStyle = data.fill;
    ctx.fill();
  }

  // 2. Stroke path
  if (data.strokeWidth > 0) {
    buildPath(ctx, shapeDef.path, shapeWidth, shapeHeight, canvasX, canvasY);
    ctx.lineWidth = data.strokeWidth;
    ctx.strokeStyle = data.stroke;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
  }

  // 3. Text (if shape supports it and text is non-empty)
  if (shapeDef.supportsText !== false && data.text) {
    const fontWeight = data.fontBold ? "bold" : "normal";
    const fontStyle = data.fontItalic ? "italic" : "normal";
    ctx.font = `${fontStyle} ${fontWeight} ${data.fontSize}px system-ui`;
    ctx.fillStyle = data.textColor;
    ctx.textAlign = data.textAlign;
    ctx.textBaseline = "middle";

    // Clip text to shape bounds with padding
    ctx.save();
    ctx.beginPath();
    ctx.rect(canvasX + 4, canvasY + 4, shapeWidth - 8, shapeHeight - 8);
    ctx.clip();

    let textX = canvasX + shapeWidth / 2;
    if (data.textAlign === "left") textX = canvasX + 6;
    else if (data.textAlign === "right") textX = canvasX + shapeWidth - 6;

    ctx.fillText(data.text, textX, canvasY + shapeHeight / 2);
    ctx.restore();
  }

  // Restore opacity
  ctx.globalAlpha = prevAlpha;

  // 4. Selection indicators (shapes are always selectable)
  const selected = isFloatingControlSelected(controlId);
  if (selected) {
    // Selection border
    ctx.strokeStyle = "#0e639c";
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.strokeRect(canvasX + 1, canvasY + 1, shapeWidth - 2, shapeHeight - 2);

    // Resize handles at corners and midpoints
    drawResizeHandles(ctx, canvasX, canvasY, shapeWidth, shapeHeight);
  }

  // 5. Connection point indicators
  // Show connection points (small circles at edge midpoints) on non-connector
  // shapes when a connector/line shape is currently selected. This gives
  // visual guidance about potential attachment points.
  if (!shapeDef.isLine) {
    const shouldShowConnectionPoints = isConnectorSelectedGlobal();
    if (shouldShowConnectionPoints) {
      drawConnectionPoints(ctx, canvasX, canvasY, shapeWidth, shapeHeight);
    }
  }

  // 6. Script badge indicator (design mode only)
  if (getDesignMode() && shapesWithScripts.has(controlId)) {
    drawScriptBadge(ctx, canvasX, canvasY, shapeWidth);
  }

  ctx.restore();
}

// ============================================================================
// Hit Testing
// ============================================================================

/**
 * Hit-test for floating shape overlay regions.
 * Uses pixel-based bounds for floating overlays.
 */
export function hitTestFloatingShape(hitCtx: OverlayHitTestContext): boolean {
  if (hitCtx.region.data?.controlType !== "shape") return false;

  if (hitCtx.floatingCanvasBounds) {
    const b = hitCtx.floatingCanvasBounds;
    return (
      hitCtx.canvasX >= b.x &&
      hitCtx.canvasX <= b.x + b.width &&
      hitCtx.canvasY >= b.y &&
      hitCtx.canvasY <= b.y + b.height
    );
  }
  return false;
}

// ============================================================================
// Async Data Fetch
// ============================================================================

async function fetchShapeData(
  controlId: string,
  sheetIndex: number,
  row: number,
  col: number,
): Promise<void> {
  pendingFetches.add(controlId);
  try {
    const resolved = await resolveControlProperties(sheetIndex, row, col);
    if (!resolved || Object.keys(resolved).length === 0) return;

    shapeDataCache.set(controlId, {
      shapeType: resolved.shapeType ?? "rectangle",
      fill: resolved.fill ?? "#4472C4",
      stroke: resolved.stroke ?? "#2F528F",
      strokeWidth: parseFloat(resolved.strokeWidth ?? "1") || 1,
      text: resolved.text ?? "",
      textColor: resolved.textColor ?? "#FFFFFF",
      fontSize: parseInt(resolved.fontSize ?? "11", 10) || 11,
      fontBold: resolved.fontBold === "true",
      fontItalic: resolved.fontItalic === "true",
      textAlign: (resolved.textAlign as CanvasTextAlign) ?? "center",
      opacity: parseFloat(resolved.opacity ?? "1") || 1,
      rotation: parseFloat(resolved.rotation ?? "0") || 0,
      flipH: resolved.flipH === "true",
      flipV: resolved.flipV === "true",
    });
    staleEntries.delete(controlId);

    // Update floating control dimensions if width/height resolved from formula
    const resolvedWidth = resolved.width ? parseFloat(resolved.width) : NaN;
    const resolvedHeight = resolved.height ? parseFloat(resolved.height) : NaN;
    if (!isNaN(resolvedWidth) || !isNaN(resolvedHeight)) {
      const {
        getFloatingControl,
        resizeFloatingControl,
        syncFloatingControlRegions,
      } = await import("../lib/floatingStore");
      const ctrl = getFloatingControl(controlId);
      if (ctrl) {
        const w = !isNaN(resolvedWidth) && resolvedWidth > 0 ? resolvedWidth : ctrl.width;
        const h = !isNaN(resolvedHeight) && resolvedHeight > 0 ? resolvedHeight : ctrl.height;
        if (w !== ctrl.width || h !== ctrl.height) {
          resizeFloatingControl(controlId, ctrl.x, ctrl.y, w, h);
          syncFloatingControlRegions();
        }
      }
    }

    // Request redraw to show fetched data
    const { requestOverlayRedraw } = await import("../../../src/api/gridOverlays");
    requestOverlayRedraw();
  } catch (err) {
    console.error(`[Controls] Failed to fetch shape data for ${controlId}:`, err);
  } finally {
    pendingFetches.delete(controlId);
  }
}

// ============================================================================
// Drawing Helpers
// ============================================================================

function drawResizeHandles(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const handleSize = 6;
  ctx.fillStyle = "#0e639c";

  // Four corners
  ctx.fillRect(x - handleSize / 2, y - handleSize / 2, handleSize, handleSize);
  ctx.fillRect(x + w - handleSize / 2, y - handleSize / 2, handleSize, handleSize);
  ctx.fillRect(x - handleSize / 2, y + h - handleSize / 2, handleSize, handleSize);
  ctx.fillRect(x + w - handleSize / 2, y + h - handleSize / 2, handleSize, handleSize);

  // Four midpoints
  ctx.fillRect(x + w / 2 - handleSize / 2, y - handleSize / 2, handleSize, handleSize);
  ctx.fillRect(x + w / 2 - handleSize / 2, y + h - handleSize / 2, handleSize, handleSize);
  ctx.fillRect(x - handleSize / 2, y + h / 2 - handleSize / 2, handleSize, handleSize);
  ctx.fillRect(x + w - handleSize / 2, y + h / 2 - handleSize / 2, handleSize, handleSize);
}

// ============================================================================
// Connection Point Indicators
// ============================================================================

/**
 * Check if any currently selected floating control is a connector/line shape.
 * Used to decide whether to show connection point indicators on other shapes.
 */
function isConnectorSelectedGlobal(): boolean {
  const selectedIds = getSelectedFloatingControls();
  for (const id of selectedIds) {
    const cached = shapeDataCache.get(id);
    if (cached && isConnectorShape(cached.shapeType)) {
      return true;
    }
  }
  return false;
}

/**
 * Draw connection point indicators at the four edge midpoints of a shape.
 * Each indicator is a small circle with a green fill and dark border,
 * providing visual guidance for where connectors can attach.
 */
function drawConnectionPoints(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const radius = 4;
  const points = [
    { cx: x + w / 2, cy: y },           // top center
    { cx: x + w,     cy: y + h / 2 },   // right center
    { cx: x + w / 2, cy: y + h },       // bottom center
    { cx: x,         cy: y + h / 2 },   // left center
  ];

  for (const pt of points) {
    // Outer circle (border)
    ctx.beginPath();
    ctx.arc(pt.cx, pt.cy, radius + 1, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.strokeStyle = "#0e639c";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Inner filled circle
    ctx.beginPath();
    ctx.arc(pt.cx, pt.cy, radius - 1, 0, Math.PI * 2);
    ctx.fillStyle = "#4CAF50";
    ctx.fill();
  }
}

/**
 * Draw a small script badge icon in the top-right corner of a shape.
 * Shows a code bracket icon on a rounded pill to indicate a script is attached.
 */
function drawScriptBadge(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
): void {
  const badgeSize = 16;
  const badgeX = x + w - badgeSize - 3;
  const badgeY = y + 3;
  const radius = 4;

  // Badge background (rounded rect)
  ctx.beginPath();
  ctx.moveTo(badgeX + radius, badgeY);
  ctx.lineTo(badgeX + badgeSize - radius, badgeY);
  ctx.arcTo(badgeX + badgeSize, badgeY, badgeX + badgeSize, badgeY + radius, radius);
  ctx.lineTo(badgeX + badgeSize, badgeY + badgeSize - radius);
  ctx.arcTo(badgeX + badgeSize, badgeY + badgeSize, badgeX + badgeSize - radius, badgeY + badgeSize, radius);
  ctx.lineTo(badgeX + radius, badgeY + badgeSize);
  ctx.arcTo(badgeX, badgeY + badgeSize, badgeX, badgeY + badgeSize - radius, radius);
  ctx.lineTo(badgeX, badgeY + radius);
  ctx.arcTo(badgeX, badgeY, badgeX + radius, badgeY, radius);
  ctx.closePath();
  ctx.fillStyle = "rgba(0, 120, 212, 0.85)";
  ctx.fill();

  // Code brackets icon: < >
  const cx = badgeX + badgeSize / 2;
  const cy = badgeY + badgeSize / 2;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Left bracket <
  ctx.beginPath();
  ctx.moveTo(cx - 2, cy - 3);
  ctx.lineTo(cx - 5, cy);
  ctx.lineTo(cx - 2, cy + 3);
  ctx.stroke();

  // Right bracket >
  ctx.beginPath();
  ctx.moveTo(cx + 2, cy - 3);
  ctx.lineTo(cx + 5, cy);
  ctx.lineTo(cx + 2, cy + 3);
  ctx.stroke();
}
