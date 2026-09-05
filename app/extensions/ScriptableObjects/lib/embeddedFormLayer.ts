//! FILENAME: app/extensions/ScriptableObjects/lib/embeddedFormLayer.ts
// PURPOSE: The pixels half of forms EMBEDDED on a sheet (M3c): the grid overlay
//          that positions one DOM host per placement over the canvas, the React
//          root inside it, the pointer rule, and the structural-edit wiring that
//          keeps a placement's GEOMETRY in step with the grid while leaving its
//          IDENTITY alone.
// CONTEXT: The DOM construction follows the ONE precedent this codebase already
//          has for host-owned pixels anchored to cells — `updateHtmlOverlay` in
//          extensions/Controls/Shape/shapeRenderer.ts — because the render loop
//          is the only place the canvas origin, the scroll offset and the header
//          sizes are all known at once. Everything ABOVE the pixels (sessions,
//          stores, the patch wire) is in lib/scriptEmbedHost.ts and is testable
//          without a canvas; this module is deliberately thin.
//
// THE POINTER RULE, AND WHY IT IS M3b's RULE. A surface painted over the grid
// can eat the user's clicks. M3b answered that for a shape's HTML frame by
// making the frame permanently click-through and letting the script DECLARE the
// rectangles that take input, with Design Mode as the escape that suspends every
// claim at once. An embedded form's claim is the same shape, with the two
// simplifications its construction earns:
//   - THE RECTANGLE IS DECLARED BY THE USER, not by the script: it is the
//     placement's own box, the box they drew. A script cannot widen it, cannot
//     move it, and cannot claim a pixel outside it.
//   - DESIGN MODE IS STILL THE ESCAPE. While it is on, the host element is
//     `pointer-events: none`, so the user gets their clicks back on the cells
//     underneath — and the box is outlined so they can see what was taken.
// AND `pointer-events: auto` IS ONLY HALF OF TAKING A CLICK. This element is a
// DESCENDANT of `S.GridArea`, which is where Core binds `onMouseDown`, so a
// press that lands here still bubbles into the grid: it selected the cell UNDER
// the card and `preventDefault`ed the browser's focus on the way, so clicking a
// widget never focused it. The other half is Core's generic pointer-claim rule
// (`claimPointer`, @api/pointerClaims) — an attribute this element carries that
// tells Core "this press is not yours" — applied and suspended in one place with
// `pointer-events`, in `applyPointerRule` below.
// Right-click is never claimed either, and that one is LOAD-BEARING rather than
// tidy: `EMBEDDED_FORM_ORPHAN_REMEDY` tells the user to right-click the cell at
// a form's top-left corner and pick a grid menu item, which is only true while
// the menu opens THROUGH this card. Two things make it open, and neither is
// obvious from here. The surface installs no `contextmenu` handler, so the event
// bubbles from this element out to `GridArea`, where the grid binds
// `onContextMenu` (core/components/Spreadsheet/Spreadsheet.tsx) — and that
// handler then RETURNS WITHOUT OPENING THE CELL MENU if `findFloatingRegionAt`
// finds a region under the pointer, which is right for a chart or a slicer and
// would be fatal here. It does not, because the region below publishes no
// `floating` box. So the day someone wires a drag by adding one — the obvious
// next step, and the one a reviewer proposed — both items that sentence names
// go unreachable while the sentence still claims them. Pinned end to end
// against Core's own predicate in `__tests__/embeddedFormLayer.test.ts` ("an
// orphan's card does not eat the right-click its own sentence asks for").
//
// AND THE OUTLINE IS A STYLE ON THE HOST ELEMENT, NEVER A CANVAS STROKE. It was
// a `ctx.strokeRect` for as long as it existed and no user ever saw one pixel of
// it: the card inside this element is opaque (`background: var(--dialog-bg)`,
// components/scriptEmbed/ScriptEmbeddedFormSurface.styles.ts) and the element is
// a positioned sibling of the grid canvas at `z-index: 6`, so anything stroked
// on the canvas INSIDE that box is painted over immediately. Design Mode gave
// the user their clicks back and told them nothing about what had taken them —
// exactly the defect `extensions/Controls/Shape/shapeHitRegions.ts` traces for
// M3b's own outline, and for the same reason. This surface is the simpler case: ONE
// box, and it is our own element, so the outline rides on the element (a CSS
// `outline`, painted after the element's descendants) instead of on a sibling —
// which also means it cannot be stranded when the surface hides, the failure
// that module has to clean up by hand.
//
// AND THE CONTEXT MENU IS THE WHOLE GESTURE SET, TODAY. The pointer paragraph
// used to end "...AND can select, move and delete the object", which was never
// true: an embedded form is CELL-ANCHORED and Core's move and select paths are
// built on a region's `floating` box (`handleOverlayMoveMouseDown` returns early
// on `!hit.region.floating`), so no drag of this box has ever moved, selected or
// resized anything. Re-anchoring an orphan and deleting a placement happen
// through the grid context menu on the anchor cell (lib/embeddedFormUx.ts) —
// which is what `EMBEDDED_FORM_ORPHAN_REMEDY` names — and moving a LIVE one is
// not offered at all yet. That is why the region data below no longer
// advertises `movable` / `resizable`, and why this overlay registers no
// `hitTest`: Core reaches a registration's `hitTest` in ONE place
// (`checkOverlayBody`, overlayMoveHandlers.ts) and skips every region without a
// `floating` box before it gets there, so the answer this module used to give
// there was never asked for — a claim nothing can honour, of the same family as
// the `movable` flag, and the reason "Design Mode selects it" looked plausible
// enough to write down twice.
//
// THE SHEET FILTER, AND WHY IT IS THIS MODULE'S JOB. A `GridRegion` carries no
// sheet dimension (`@api/gridOverlays.ts`) and the renderer hands EVERY
// published region of a type to the overlay that owns that type, so no layer
// above this one CAN filter by sheet — this module does it or nobody does.
// Publishing the whole placement store painted every form in the workbook on
// every sheet: an opaque 320x240 host with `pointer-events: auto` sitting over
// cells the form was never placed on, following the user from tab to tab, with
// Design Mode the only way to get those clicks back — and, in Design Mode, a
// phantom whose drag rewrote another sheet's anchor. `extensions/Controls/
// index.ts` names that exact defect in its own comment ("a click on one of
// those phantoms edited a control on a sheet the user was not looking at") and
// answers it by holding ONE sheet in its store at a time. This module keeps the
// whole store and filters at publication instead, because a placement on
// another sheet still has a LIVE session (lib/scriptEmbedHost.ts) whose store,
// typed values and bound-cell watch must survive a tab click.
//
// AND THE VISIBILITY SIGNAL IS THIS MODULE'S, FOR THE SAME REASON. The host
// arms a bound-cell watch while a surface is on screen and takes it down when
// it is not (`paneSessionDeps.visible` / `.hidden`, api/scriptHost/host.ts), on
// the invariant it states there in one line: a pane nobody can see reads
// nothing. That signal was the React component's MOUNT effect, which is right
// for the docked pane — the panel really does unmount it — and wrong here and
// only here, because hiding on this surface is `display: none` and a
// `display: none` ancestor does not unmount a React tree. So a form scrolled
// out of the viewport kept its watch armed: every later edit to a bound cell
// was re-read (audited, one entry per cell) and announced to the script as
// `onPaneChange { source: "cell" }` for a surface nobody could see, which is
// exactly the state the gate exists to stop. The signal now leaves from the
// SAME branches that write `display` — `hideHost` and the paint below — so the
// two cannot disagree again, and the component reports nothing.

import React from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  AppEvents,
  emitAppEvent,
  getDesignMode,
  onAppEvent,
  onDesignModeChange,
  overlayGetColumnX,
  overlayGetColHeaderHeight,
  overlayGetRowHeaderWidth,
  overlayGetRowY,
  registerGridOverlay,
  replaceGridRegionsByType,
  removeGridRegionsByType,
  type GridRegion,
  type OverlayRenderContext,
} from "@api";
// The subpath, not the barrel: this is Core's own pointer rule and a test that
// doubles `@api` must still be measuring the REAL one, the same way M3b's shim
// reaches it.
import { claimPointer, releasePointerClaim } from "@api/pointerClaims";
import {
  listEmbeddedFormPlacementsForSheet,
  orphanEmbeddedFormsForSheet,
  shiftEmbeddedFormPlacements,
  structuralAnchorShift,
  type StructuralEditKind,
} from "@api/scriptHost/embeddedFormPlacements";
import { ScriptEmbeddedFormView } from "../components/scriptEmbed";
import type { EmbeddedFormSurfaceView, ScriptEmbedHostDeps } from "./scriptEmbedHost";

/** The grid-overlay region type these surfaces occupy. */
export const EMBEDDED_FORM_REGION_TYPE = "script-embedded-form";

/**
 * The dashed outline Design Mode paints around a claimed box (M3b's idiom),
 * spelled as the CSS `outline` shorthand it is assigned to — see the header for
 * why it is a style on the host element and not a canvas stroke.
 */
const DESIGN_OUTLINE = "1px dashed rgba(0, 120, 212, 0.9)";

/**
 * Drawn just INSIDE the element's own edge, where the stroke this replaced was
 * aimed. An outline sitting outside the box would be the first thing an ancestor
 * with `overflow: hidden` clips away, and it would also straddle the cell the
 * placement is anchored to.
 */
const DESIGN_OUTLINE_OFFSET = "-1px";

interface Host {
  el: HTMLDivElement;
  root: Root;
  /** The last view rendered, so a scroll-driven reposition does not need one. */
  view: EmbeddedFormSurfaceView | null;
  /**
   * Is this surface being PAINTED right now? State this module owns, because
   * this module is the only thing that knows: the element and its React tree
   * survive both hides (see the header), so nothing above can be asked.
   */
  visible: boolean;
}

/**
 * Install the layer. Returns the teardown AND the `ScriptEmbedHostDeps` the
 * wiring needs, so `installScriptEmbedHost(layer.deps)` is the whole assembly.
 */
export function installEmbeddedFormLayer(hostBridge: {
  /** `openEmbeddedScriptForm` from the script host, injected so this module has no host import. */
  openSession: ScriptEmbedHostDeps["openSession"];
  /** `closeEmbeddedScriptForm` from the script host. */
  closeSession: ScriptEmbedHostDeps["closeSession"];
  /** The active sheet index — the structural events carry none. */
  activeSheetIndex: () => Promise<number>;
}): { deps: ScriptEmbedHostDeps; dispose: () => void } {
  const hosts = new Map<string, Host>();
  /**
   * The latest view per placement, held OUTSIDE the DOM. A placement that is
   * scrolled out of view has no element, but its session is live and its state
   * changes anyway; without this, a form that opened off screen appeared blank
   * until its next patch. It is also what a re-created element renders from.
   */
  const pendingViews = new Map<string, EmbeddedFormSurfaceView>();
  /**
   * The sheet the user is looking at — the filter `syncRegions` applies (see the
   * header for why it can only be applied here).
   *
   * Starts at 0 and is corrected below from `hostBridge.activeSheetIndex()`,
   * the same seed-then-track shape lib/embeddedFormUx.ts uses for its
   * synchronous `visible` predicates. It is never read from a region: the
   * region set is what this value PRODUCES.
   */
  let activeSheet = 0;
  let disposed = false;

  /**
   * Who is told when a surface starts or stops being painted — the wiring, once
   * (`ScriptEmbedHostDeps.onSurfaceVisibility`, lib/scriptEmbedHost.ts). A Set
   * rather than one slot only so a second subscriber cannot silently displace
   * the first; there is one subscriber today.
   */
  const visibilityHandlers = new Set<(placementId: string, visible: boolean) => void>();

  /**
   * Who is told when the user moves between sheet tabs
   * (`ScriptEmbedHostDeps.onActiveSheetChange`). The wiring needs this for a
   * reason the visibility signal cannot serve: a placement on a sheet the user
   * has not visited is not painted, so it never reports "visible" — and the
   * wiring must still learn that its sheet has come up, because that is when its
   * session may open against the right sheet. Same Set-not-slot rule as above.
   */
  const sheetHandlers = new Set<(sheetIndex: number) => void>();

  /**
   * Announce a CHANGE of visibility, never the steady state. The grid repaints
   * every frame and a "visible" costs the host an armed watch plus one audited
   * re-read per bound cell, so re-announcing what is already true would turn
   * scrolling into a read storm — the opposite of the defect this signal fixes.
   */
  const setVisible = (placementId: string, host: Host, visible: boolean): void => {
    if (host.visible === visible) return;
    host.visible = visible;
    for (const handler of visibilityHandlers) handler(placementId, visible);
  };

  /**
   * Take one surface off the screen without taking it DOWN: the element and its
   * React root stay (the session is live and the user will very likely be back),
   * so this is the only place that can report the surface stopped being painted.
   * Both hide paths — off the active sheet, and scrolled out of the viewport —
   * go through here, which is what keeps `display` and the host's bound-cell
   * watch answering the same question.
   */
  const hideHost = (placementId: string, host: Host): void => {
    host.el.style.display = "none";
    // And that is the whole hide: the design-mode outline is a style ON this
    // element (see the header), so it goes with it. M3b's shape outlines are
    // SIBLINGS of the frame they describe and `display: none` does not travel to
    // a sibling, which is why `shapeHitRegions.ts` has to remove them by hand
    // here — a missed one leaves a dashed rectangle standing over whatever
    // scrolls into that space. This surface structurally cannot have that bug.
    setVisible(placementId, host, false);
  };

  /** Render one view into one host. The ONE call site of `root.render`. */
  const renderInto = (host: Host, view: EmbeddedFormSurfaceView): void => {
    host.view = view;
    host.root.render(
      React.createElement(ScriptEmbeddedFormView, {
        placementId: view.placementId,
        state: view.state,
        badge: view.badge,
        width: view.width,
      }),
    );
  };

  /**
   * The pointer rule for one host element, in ONE place because it is two
   * statements that must always agree.
   *
   * `pointer-events` decides whether the browser's hit test can even land on
   * this element; the CLAIM decides whether the press that landed on it is the
   * grid's. Both were needed and only the first was here: this element is a
   * DESCENDANT of `S.GridArea`, where Core binds `onMouseDown`, so a click on a
   * widget bubbled into the grid, whose cell path calls `event.preventDefault()`
   * before its first await — cancelling the browser's focus — and then moved the
   * cell selection to the cell UNDER the card. The write landed in the journey
   * only because `locator.fill()` focuses programmatically; a real user typing
   * after a real click typed into the grid.
   *
   * DESIGN MODE suspends both halves together. `pointer-events: none` alone
   * already hides the claim from Core (the rule reads the TARGET's ancestors,
   * and an element that is not hit-testable is never the target), so the
   * `releasePointerClaim` is belt to that braces — and it is what makes the
   * suspension VISIBLE in the DOM, which is the same reason the outline exists.
   */
  const applyPointerRule = (placementId: string, el: HTMLElement): void => {
    if (getDesignMode()) {
      el.style.pointerEvents = "none";
      releasePointerClaim(el);
      return;
    }
    el.style.pointerEvents = "auto";
    claimPointer(el, placementId);
  };

  const ensureHost = (placementId: string, canvasParent: HTMLElement): Host => {
    const existing = hosts.get(placementId);
    if (existing) {
      if (existing.el.parentElement !== canvasParent) canvasParent.appendChild(existing.el);
      return existing;
    }
    const el = document.createElement("div");
    el.dataset.embeddedForm = placementId;
    el.style.position = "absolute";
    el.style.boxSizing = "border-box";
    el.style.overflow = "hidden";
    el.style.zIndex = "6";
    // See the header: the box the USER drew is the claim, and Design Mode
    // suspends it. Re-applied on every paint, so a design-mode toggle takes
    // effect on the next frame without a second code path.
    applyPointerRule(placementId, el);
    canvasParent.appendChild(el);
    // `visible: false` until the paint below actually places it: a host created
    // in this call has not been positioned yet, and reporting it visible here
    // would arm the watch a frame before the surface existed on screen.
    const host: Host = { el, root: createRoot(el), view: null, visible: false };
    hosts.set(placementId, host);
    // An element created LATER (the user scrolled the placement into view)
    // renders what the wiring already decided, not nothing.
    const pending = pendingViews.get(placementId);
    if (pending) renderInto(host, pending);
    return host;
  };

  const dropHost = (placementId: string): void => {
    const host = hosts.get(placementId);
    if (!host) return;
    hosts.delete(placementId);
    // No visibility report: this is the placement leaving the DOCUMENT, and the
    // wiring has already ended its session (`reconcile` closes before it
    // forgets). The `visible` bit goes with the host record.
    //
    // Unmount asynchronously: React refuses a synchronous unmount from inside a
    // render pass, and this can be reached from one (a placement removed while
    // the sheet is painting).
    const { root, el } = host;
    queueMicrotask(() => {
      root.unmount();
      el.remove();
    });
  };

  /**
   * The regions the grid renderer walks — one per placement ON THE ACTIVE SHEET,
   * anchored to its cell. The sheet filter is the whole reason this reads
   * `listEmbeddedFormPlacementsForSheet` and not the store entire; see the
   * header.
   */
  const syncRegions = (): void => {
    if (disposed) return;
    const onSheet = listEmbeddedFormPlacementsForSheet(activeSheet);
    const regions: GridRegion[] = onSheet.map((p) => ({
      id: p.id,
      type: EMBEDDED_FORM_REGION_TYPE,
      startRow: p.anchorRow,
      startCol: p.anchorCol,
      endRow: p.anchorRow,
      endCol: p.anchorCol,
      data: {
        placementId: p.id,
        sheetIndex: p.sheetIndex,
        offsetX: p.offsetX,
        offsetY: p.offsetY,
        width: p.width,
        height: p.height,
        orphaned: p.orphaned,
        // NO `movable` / `resizable` HERE, deliberately. They were published as
        // `getDesignMode()`, copied from the floating-control store — where they
        // work, because a floating control publishes a `floating` box. Core
        // reads `data.movable` only AFTER `handleOverlayMoveMouseDown` has
        // accepted a hit, and that gate is `!hit.region.floating`
        // (`core/hooks/useMouseSelection/layout/overlayMoveHandlers.ts`); a
        // cell-anchored region never reaches it, and `data.resizable` is
        // consulted only for floating regions too. So the flags moved nothing
        // and resized nothing, while the surfaces around them told the user to
        // drag the box. Region data is a CLAIM the renderer honours; publishing
        // one nothing can honour is how those sentences got written.
      },
    }));
    replaceGridRegionsByType(EMBEDDED_FORM_REGION_TYPE, regions);
    // A placement that just LEFT the active sheet keeps its element and its
    // React root — its session is live and the user will very likely be back —
    // but it must stop covering the sheet in front of them. Hiding is this
    // module's own answer for "painted nowhere" (the off-screen branch in
    // `renderRegion`), and it has to happen here because an unpublished region
    // is never handed to `renderRegion` again: nothing else would ever hide it.
    const painted = new Set(onSheet.map((p) => p.id));
    for (const [placementId, host] of hosts) {
      if (painted.has(placementId)) continue;
      hideHost(placementId, host);
    }
  };

  /**
   * Paint one placement. Called from the grid's own paint pass, which is the
   * only place the canvas origin, the scroll offset and the header sizes are
   * known together — the same reason `updateHtmlOverlay` lives there.
   */
  const renderRegion = (ctx: OverlayRenderContext): void => {
    if (disposed) return;
    const data = (ctx.region.data ?? {}) as {
      placementId?: string;
      sheetIndex?: number;
      offsetX?: number;
      offsetY?: number;
      width?: number;
      height?: number;
    };
    const placementId = data.placementId;
    if (typeof placementId !== "string") return;
    const canvasParent = ctx.ctx.canvas.parentElement;
    if (!canvasParent) return;

    const host = hosts.get(placementId);
    // BELT AND BRACES over the filter in `syncRegions`. The region set is
    // published by this module, but it is held by the Core renderer and read on
    // a paint this module does not trigger, so a region that outlives its sheet
    // for one frame — a repaint racing a tab click — must still not paint. Same
    // two lines as the off-screen branch below, for the same reason: an
    // invisible box that still claims clicks is the worse failure.
    if (typeof data.sheetIndex === "number" && data.sheetIndex !== activeSheet) {
      if (host) hideHost(placementId, host);
      return;
    }

    const left = overlayGetColumnX(ctx, ctx.region.startCol) + (data.offsetX ?? 0);
    const top = overlayGetRowY(ctx, ctx.region.startRow) + (data.offsetY ?? 0);
    const width = data.width ?? 0;
    const height = data.height ?? 0;
    const rowHeaderWidth = overlayGetRowHeaderWidth(ctx);
    const colHeaderHeight = overlayGetColHeaderHeight(ctx);
    const visible =
      left + width > rowHeaderWidth &&
      top + height > colHeaderHeight &&
      left < ctx.canvasWidth &&
      top < ctx.canvasHeight;

    if (!visible) {
      // Scrolled out of the viewport. `hideHost` is the whole answer: the
      // element stops painting, its box stops claiming clicks (the stale
      // invisible click-eater M3b calls out by name), AND the host's bound-cell
      // watch comes down — see the header for the read storm that ran here for
      // as long as those three were three different decisions.
      if (host) hideHost(placementId, host);
      return;
    }

    const placed = host ?? ensureHost(placementId, canvasParent);
    // Clipped to the visible area, like the shape frame: a surface half under a
    // header must not paint over it.
    const clippedLeft = Math.max(left, rowHeaderWidth);
    const clippedTop = Math.max(top, colHeaderHeight);
    const box = {
      left: clippedLeft,
      top: clippedTop,
      width: Math.min(left + width, ctx.canvasWidth) - clippedLeft,
      height: Math.min(top + height, ctx.canvasHeight) - clippedTop,
    };
    placed.el.style.display = "block";
    placed.el.style.left = `${box.left}px`;
    placed.el.style.top = `${box.top}px`;
    placed.el.style.width = `${box.width}px`;
    placed.el.style.height = `${box.height}px`;
    applyPointerRule(placementId, placed.el);
    // Show what has been taken, the way M3b shows a declared rectangle — but on
    // THIS element, above the opaque card it draws, because a stroke on the
    // canvas inside this box is ink nobody can see (see the header). Re-derived
    // on every paint from the same call as `pointerEvents` above, so the claim
    // and the picture of the claim cannot disagree, and CLEARED rather than left
    // standing: a dashed box around a surface that is taking the clicks again
    // would say the opposite of what is true.
    placed.el.style.outline = getDesignMode() ? DESIGN_OUTLINE : "none";
    placed.el.style.outlineOffset = DESIGN_OUTLINE_OFFSET;
    // Painted. Announced from HERE and not from the element's creation, so the
    // watch arms on the frame the surface is actually placed on screen.
    setVisible(placementId, placed, true);
  };

  // NO `hitTest` HERE, deliberately — see the header. Core consults a
  // registration's `hitTest` only for regions that publish a `floating` box, and
  // these are cell-anchored, so one registered here answers a question that is
  // never asked. The one it used to answer ("in Design Mode this box is mine")
  // was read by nothing, tested by a unit test that could reach it directly, and
  // was the last piece of evidence for a selection gesture that does not exist.
  const unregisterOverlay = registerGridOverlay({
    type: EMBEDDED_FORM_REGION_TYPE,
    render: renderRegion,
    priority: 20,
  });

  // ---- One queue for everything that asks the app which sheet it is on ------
  // Serialized, like the Controls store's: these handlers await an IPC answer,
  // and two rapid events would otherwise apply their conclusions out of order.
  // Sheet switches share the queue with structural edits rather than running
  // beside them, so a switch can never republish the region set in the middle
  // of a shift and put half-moved anchors on screen.
  let serialQueue: Promise<void> = Promise.resolve();

  /**
   * Adopt an active sheet index, whether it came in a SHEET_CHANGED detail or
   * has to be asked for. Queued so answers land in the order they were asked;
   * a bare `.then` on each would let a seed that resolves late overwrite a tab
   * click that happened while it was in flight.
   */
  const adoptActiveSheet = (ask: () => number | Promise<number>): void => {
    serialQueue = serialQueue
      .then(async () => {
        const index = await ask();
        if (disposed || index === activeSheet) return;
        activeSheet = index;
        // Republish for the new sheet (which also hides the departing sheet's
        // hosts), then ask for the paint that positions the arriving ones —
        // nothing else repaints the canvas on a tab click.
        syncRegions();
        emitAppEvent(AppEvents.GRID_REFRESH);
        // AFTER the republish, so a wiring that opens a session in response
        // paints into a region set that already describes this sheet.
        for (const handler of sheetHandlers) handler(index);
      })
      .catch((err) => {
        console.error("[ScriptableObjects] embedded-form sheet switch failed:", err);
      });
  };

  // ---- Structural edits: geometry moves, identity does not ------------------
  const onStructuralEdit = (kind: StructuralEditKind) => (detail: unknown): void => {
    const d = (detail ?? {}) as { startRow?: number; startCol?: number; count?: number };
    const at = kind.startsWith("row") ? d.startRow : d.startCol;
    const count = d.count;
    if (at === undefined || count === undefined) return;
    serialQueue = serialQueue
      .then(async () => {
        const sheetIndex = await hostBridge.activeSheetIndex();
        // The placement store decides what a deleted anchor means (an ORPHAN,
        // never a deletion) — see embeddedFormPlacements.ts. This only supplies
        // the mapping and repaints.
        if (shiftEmbeddedFormPlacements(sheetIndex, structuralAnchorShift(kind, at, count))) {
          syncRegions();
          emitAppEvent(AppEvents.GRID_REFRESH);
        }
      })
      .catch((err) => {
        console.error("[ScriptableObjects] embedded-form structural shift failed:", err);
      });
  };

  const offs: Array<() => void> = [];
  for (const [event, kind] of [
    [AppEvents.ROWS_INSERTED, "rowInsert"],
    [AppEvents.ROWS_DELETED, "rowDelete"],
    [AppEvents.COLUMNS_INSERTED, "colInsert"],
    [AppEvents.COLUMNS_DELETED, "colDelete"],
  ] as const) {
    offs.push(onAppEvent(event, onStructuralEdit(kind)));
  }
  offs.push(
    onAppEvent(AppEvents.SHEET_CHANGED, (detail) => {
      const d = (detail ?? {}) as { sheetIndex?: number };
      // The shell dispatches this WITHOUT a detail on the undo of a sheet
      // add/delete/reorder (`shell/bootstrap.ts`), so an index is not
      // guaranteed. Ignoring those would leave the layer painting the sheet the
      // user just left, which is the whole defect — ask instead.
      adoptActiveSheet(() =>
        typeof d.sheetIndex === "number" ? d.sheetIndex : hostBridge.activeSheetIndex(),
      );
    }),
  );
  offs.push(
    onAppEvent(AppEvents.SHEET_DELETED, (detail) => {
      const d = (detail ?? {}) as { sheetIndex?: number };
      if (typeof d.sheetIndex !== "number") return;
      // The sheet a form was placed on is gone. Same answer as a deleted anchor
      // row: orphan the placement rather than dropping it, so a user who undoes
      // the sheet deletion gets their form back.
      if (orphanEmbeddedFormsForSheet(d.sheetIndex)) syncRegions();
    }),
  );
  offs.push(
    onDesignModeChange(() => {
      // A REFRESH IS THE WHOLE ANSWER. The claim (`pointer-events`) and the
      // outline are both re-derived from `getDesignMode()` inside the paint, and
      // the region set itself no longer varies with design mode — it carried
      // `movable` / `resizable` until those were removed as flags Core cannot
      // honour for a cell-anchored region (see `syncRegions`), and republishing
      // an identical set was the only thing they bought.
      emitAppEvent(AppEvents.GRID_REFRESH);
    }),
  );

  const deps: ScriptEmbedHostDeps = {
    paint: (placementId, view) => {
      // Remembered FIRST, so the two orders — paint-then-create (the placement
      // is off screen) and create-then-paint (it is on screen) — end in the
      // same render, made by `ensureHost` or by this call.
      pendingViews.set(placementId, view);
      syncRegions();
      const host = hosts.get(placementId);
      if (host) renderInto(host, view);
    },
    forget: (placementId) => {
      pendingViews.delete(placementId);
      dropHost(placementId);
      syncRegions();
    },
    onSurfaceVisibility: (handler) => {
      visibilityHandlers.add(handler);
      return () => visibilityHandlers.delete(handler);
    },
    // READ, never cached by the wiring: this module owns the answer and
    // corrects it asynchronously at install (see `adoptActiveSheet`), so a copy
    // taken once on the other side of the seam would be 0 for as long as the
    // first IPC took, and would strand every placement on the sheet a workbook
    // actually opened on.
    activeSheetIndex: () => activeSheet,
    onActiveSheetChange: (handler) => {
      sheetHandlers.add(handler);
      return () => sheetHandlers.delete(handler);
    },
    openSession: hostBridge.openSession,
    closeSession: hostBridge.closeSession,
  };

  syncRegions();
  // SHEET_CHANGED only reports CHANGES, so the first answer has to be asked
  // for: a workbook opened on its third sheet would otherwise paint the first
  // sheet's forms until the user clicked a tab.
  adoptActiveSheet(() => hostBridge.activeSheetIndex());

  return {
    deps,
    dispose: () => {
      disposed = true;
      for (const off of offs) off();
      unregisterOverlay();
      removeGridRegionsByType(EMBEDDED_FORM_REGION_TYPE);
      for (const placementId of [...hosts.keys()]) dropHost(placementId);
      pendingViews.clear();
      visibilityHandlers.clear();
      sheetHandlers.clear();
    },
  };
}
