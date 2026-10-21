//! FILENAME: app/extensions/CanvasSheet/lib/interactionOverlay.tsx
// PURPOSE: The DOM overlay of Edit interactions (P4 S10): what it shows (the
//          pure model, `buildInteractionOverlayModel`) and its lifetime (one
//          React root in the grid's canvas layer, mounted only while the mode
//          is on).
// CONTEXT: One strip of Filter / Highlight / None buttons per OTHER visual on
//          the page, at the top-right of that visual's CONTENT rect
//          (@api/visualContainerPaint `visualContentRect`, the rect every
//          family paints in), converted to canvas px through
//          `overlaySheetToCanvas` and to CSS px by the zoom. The source gets a
//          2px outline.
//
//          Placement is re-read EVERY animation frame while the mode is on, the
//          `@api/overlayTextEditor` precedent: there is no single event for "a
//          visual moved, the page scrolled, the zoom changed or a container
//          title wrapped", and every missed one leaves a strip over the wrong
//          visual. React re-renders only when the computed model changed.
//
//          Hidden (nothing rendered) while a formula picks a reference -- a
//          press there names the object beneath (D-PICK) -- and while an
//          in-place text editor is open. Unmounted when the mode ends, which
//          a sheet switch and File > New / Open always do (lib/editInteractions
//          .ts), so it can never leak onto another sheet
//          (e2e_task_pane_leak_narrows_grid.md).

import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { getGridStateSnapshot } from "@api/grid";
import {
  currentFloatingHitGeometry,
  getGridRegions,
  overlaySheetToCanvas,
  type GridRegion,
  type OverlayRenderContext,
} from "@api/gridOverlays";
import { visualContentRect, type ContainerRegion } from "@api/visualContainerPaint";
import { listModelVisuals, type ModelVisualInfo } from "@api/modelVisuals";
import { interactionFor, type InteractionMode, type VisualRef } from "@api/reportFilters";
import { isFormulaReferencePickActive } from "@api/editing";
import { getGridCanvasLayer, isOverlayTextEditorOpen } from "@api/overlayTextEditor";
import { getCanvasSheetSnapshot } from "./canvasSheetStore";
import {
  INTERACTION_OVERLAY_ATTR,
  getEditInteractionsState,
  setInteraction,
  subscribeEditInteractions,
  visualRefOfRegion,
} from "./editInteractions";
import { InteractionIcons } from "../components/InteractionIcons";

/** The disabled None's reason when the source reads another model. */
export const OTHER_MODEL_REASON = "Uses another model";
/** The disabled None's reason when no family lists the visual as a model visual. */
export const NOT_A_MODEL_VISUAL_REASON = "Does not read a model";
/** The disabled None's reason when the visual reads a model but follows no other. */
export const NOT_A_TARGET_REASON = "Does not follow other visuals";

/** The button labels, in the strip's order. */
export const INTERACTION_LABELS: Readonly<Record<InteractionMode, string>> = Object.freeze({
  filter: "Filter",
  highlight: "Highlight",
  none: "None",
});

/** One button of a strip. */
export interface InteractionButtonModel {
  mode: InteractionMode;
  label: string;
  /** `canvas-interaction-<kind>-<id>-<mode>`. */
  testId: string;
  /** The current mode of the pair (aria-pressed, bold). */
  pressed: boolean;
  disabled: boolean;
  title: string;
}

/** The strip on one target visual. */
export interface InteractionStripModel {
  target: VisualRef;
  /** `kind:id`, the React key. */
  key: string;
  /** The content rect's RIGHT edge and TOP, in CSS px of the canvas layer. */
  right: number;
  top: number;
  buttons: InteractionButtonModel[];
}

/** A CSS-px rectangle in the canvas layer. */
export interface CssRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Everything the overlay renders. */
export interface InteractionOverlayModel {
  pageSheetId: string;
  source: VisualRef;
  sourceOutline: CssRect | null;
  strips: InteractionStripModel[];
}

function refKey(ref: VisualRef): string {
  return `${ref.kind}:${ref.id}`;
}

/** `canvas-interaction-<kind>-<id>-<mode>`. */
export function interactionTestId(ref: VisualRef, mode: InteractionMode): string {
  return `canvas-interaction-${ref.kind}-${ref.id}-${mode}`;
}

/** The buttons of one target's strip. Pure; exported for tests. */
export function stripButtons(
  pageSheetId: string,
  source: VisualRef,
  sourceInfo: ModelVisualInfo | null,
  target: VisualRef,
  targetInfo: ModelVisualInfo | null,
): InteractionButtonModel[] {
  const reason = !targetInfo
    ? NOT_A_MODEL_VISUAL_REASON
    : targetInfo.connectionId === null || !targetInfo.role.target
      ? (targetInfo.role.reason ?? NOT_A_TARGET_REASON)
      : sourceInfo && sourceInfo.connectionId !== null && sourceInfo.connectionId !== targetInfo.connectionId
        ? OTHER_MODEL_REASON
        : null;
  if (reason !== null) {
    return [
      {
        mode: "none",
        label: INTERACTION_LABELS.none,
        testId: interactionTestId(target, "none"),
        pressed: false,
        disabled: true,
        title: reason,
      },
    ];
  }
  const canHighlight = targetInfo!.role.canHighlight;
  const current = interactionFor(pageSheetId, source, { ref: target, canHighlight }, source.kind === "slicer");
  const sourceName = sourceInfo?.name ?? "the selected visual";
  const titles: Record<InteractionMode, string> = {
    filter: `Filter: show only what ${sourceName} selects`,
    highlight: `Highlight: show everything, emphasise what ${sourceName} selects`,
    none: `None: ${sourceName} does not affect this visual`,
  };
  const modes: InteractionMode[] = canHighlight ? ["filter", "highlight", "none"] : ["filter", "none"];
  return modes.map((mode) => ({
    mode,
    label: INTERACTION_LABELS[mode],
    testId: interactionTestId(target, mode),
    pressed: current === mode,
    disabled: false,
    title: titles[mode],
  }));
}

/** A sheet-px rect as a CSS-px rect in the canvas layer. */
function toCss(
  rect: { x: number; y: number; width: number; height: number },
  ctx: Pick<OverlayRenderContext, "config" | "viewport">,
  zoom: number,
): CssRect {
  const { canvasX, canvasY } = overlaySheetToCanvas(ctx as OverlayRenderContext, rect.x, rect.y);
  return { left: canvasX * zoom, top: canvasY * zoom, width: rect.width * zoom, height: rect.height * zoom };
}

/**
 * What the overlay shows NOW, or null when it shows nothing: the mode is off,
 * the active sheet is not a canvas (or has no sheet id yet), a reference pick
 * or an in-place text edit is live, or the grid is not mounted. Exported for
 * tests.
 */
export function buildInteractionOverlayModel(regions: readonly GridRegion[] = getGridRegions()): InteractionOverlayModel | null {
  const { active, source } = getEditInteractionsState();
  if (!active || !source) return null;
  const page = getCanvasSheetSnapshot().active;
  if (!page?.sheetId) return null;
  if (isFormulaReferencePickActive() || isOverlayTextEditorOpen()) return null;
  const geo = currentFloatingHitGeometry();
  if (!geo) return null;
  const zoom = getGridStateSnapshot()?.zoom || 1;
  const ctx = {
    config: { rowHeaderWidth: geo.rowHeaderWidth, colHeaderHeight: geo.colHeaderHeight },
    viewport: { scrollX: geo.scrollX, scrollY: geo.scrollY },
  } as unknown as Pick<OverlayRenderContext, "config" | "viewport">;

  const infos = new Map<string, ModelVisualInfo>();
  for (const v of listModelVisuals()) infos.set(refKey(v.ref), v);
  const sourceInfo = infos.get(refKey(source)) ?? null;

  let sourceOutline: CssRect | null = null;
  const strips: InteractionStripModel[] = [];
  const seen = new Set<string>();
  for (const region of regions) {
    if (!region.floating) continue;
    const ref = visualRefOfRegion(region);
    if (!ref) continue;
    const key = refKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    if (key === refKey(source)) {
      sourceOutline = toCss(region.floating, ctx, zoom);
      continue;
    }
    const content = toCss(visualContentRect(region as ContainerRegion), ctx, zoom);
    strips.push({
      target: ref,
      key,
      right: content.left + content.width,
      top: content.top,
      buttons: stripButtons(page.sheetId, source, sourceInfo, ref, infos.get(key) ?? null),
    });
  }
  return { pageSheetId: page.sheetId, source, sourceOutline, strips };
}

// ============================================================================
// Lifetime
// ============================================================================

export { INTERACTION_OVERLAY_ATTR };

/**
 * Mount the overlay while the mode is on, re-placing it every frame; unmount
 * it when the mode ends. Returns the cleanups.
 */
export function installInteractionOverlay(): Array<() => void> {
  let host: HTMLDivElement | null = null;
  let root: Root | null = null;
  let frame: number | null = null;
  let lastSignature = "";

  const raf = (cb: () => void): number =>
    typeof requestAnimationFrame === "function" ? requestAnimationFrame(cb) : (setTimeout(cb, 16) as unknown as number);
  const cancelRaf = (id: number): void => {
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id);
    else clearTimeout(id);
  };

  const onPick = (pageSheetId: string, source: VisualRef, target: VisualRef, mode: InteractionMode): void => {
    void setInteraction(pageSheetId, source, target, mode).then(() => {
      // Re-render at once with the stored answer (the layout store publishes
      // the new interactions before the promise resolves).
      lastSignature = "";
      tick(false);
    });
  };

  const unmount = (): void => {
    if (frame !== null) cancelRaf(frame);
    frame = null;
    lastSignature = "";
    root?.unmount();
    root = null;
    host?.remove();
    host = null;
  };

  function tick(schedule: boolean): void {
    if (!getEditInteractionsState().active) {
      unmount();
      return;
    }
    if (!host || !host.isConnected) {
      const layer = getGridCanvasLayer();
      if (layer) {
        root?.unmount();
        host = document.createElement("div");
        host.setAttribute(INTERACTION_OVERLAY_ATTR, "");
        host.style.position = "absolute";
        host.style.left = "0";
        host.style.top = "0";
        host.style.width = "100%";
        host.style.height = "100%";
        host.style.pointerEvents = "none";
        host.style.overflow = "hidden";
        host.style.zIndex = "5";
        layer.appendChild(host);
        root = createRoot(host);
        lastSignature = "";
      }
    }
    if (root) {
      const model = buildInteractionOverlayModel();
      const signature = JSON.stringify(model);
      if (signature !== lastSignature) {
        lastSignature = signature;
        root.render(<InteractionIcons model={model} onPick={onPick} />);
      }
    }
    if (schedule) frame = raf(() => tick(true));
  }

  const onState = (): void => {
    if (getEditInteractionsState().active) {
      if (frame === null) tick(true);
      else {
        lastSignature = "";
        tick(false);
      }
    } else {
      unmount();
    }
  };

  return [subscribeEditInteractions(onState), unmount];
}
