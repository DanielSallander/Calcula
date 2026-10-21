//! FILENAME: app/extensions/CanvasSheet/lib/editInteractions.ts
// PURPOSE: Power BI's EDIT INTERACTIONS on a canvas page (P4 S10): a mode in
//          which one selected visual is the SOURCE, and every other visual on
//          the page shows Filter / Highlight / None icons that say -- and set --
//          how the source's selection reaches it.
// CONTEXT: The mode is VIEW state, never saved: `{ active, source }`. What it
//          edits is the page's persisted `CanvasLayout.interactions`, through
//          the one layout door (`set_canvas_layout`). Each click is ONE invoke;
//          Rust makes it one undo step ("Change visual interaction"), including
//          any pivot re-fold a model slicer -> PivotTable pair needs (DC-9), so
//          this side opens no transaction of its own.
//
//          Storage holds only what DIFFERS from the default: a click that picks
//          the mode the pair would have anyway removes the pair. The default is
//          @api/reportFilters' `interactionFor` rule 3 -- a slicer filters, a
//          visual gives the page's defaultMode or "highlight", and a highlight
//          the target cannot paint is a filter -- restated in
//          `defaultInteractionMode` and pinned against `interactionFor` by
//          editInteractions.test.ts, so the two cannot drift apart.
//
//          Enter: the active sheet is a canvas, it is not subscribed (the
//          layout is the publisher's), and exactly one selected object is a
//          visual that can be a source (@api/modelVisuals `role.source`).
//          While active, selecting another source-capable visual makes IT the
//          source (Power BI's behaviour); any other selection keeps the
//          current source.
//          Exit: Escape (the canvas keyboard, lib/objectCycling.ts), the
//          toggle, a sheet switch, File > New / Open, and the source's deletion.

import { setCanvasLayout, AppEvents, onAppEvent } from "@api";
import type { CanvasLayout } from "@api";
import { alertAsync } from "@api/dialogs";
import { CANVAS_INTERACTION_KINDS } from "@api/canvasSheet";
import { modelVisualOf } from "@api/modelVisuals";
import { getSelectedObjectRegions, objectRefOf, onObjectSelectionChanged } from "@api/objectSelection";
import { onRegionChange, type GridRegion } from "@api/gridOverlays";
import type { InteractionMode, VisualRef } from "@api/reportFilters";
import {
  applyCanvasLayout,
  canvasBySheetId,
  getCanvasSheetSnapshot,
  isSubscribedCanvas,
  refreshCanvasSheets,
  subscribeCanvasSheets,
} from "./canvasSheetStore";
import { SUBSCRIBED_NOTE } from "./canvasNotes";

/** The mode's state (view state; never persisted). */
export interface EditInteractionsState {
  active: boolean;
  source: VisualRef | null;
}

/** Why the toggle is disabled with nothing (or several things) selected. */
export const SELECT_ONE_VISUAL_NOTE = "Select one visual on the page first.";
/** Why the toggle is disabled off a canvas. */
export const NOT_A_CANVAS_NOTE = "Edit interactions works on a canvas page.";
/** The fallback when a selected object names no model visual. */
export const NOT_A_SOURCE_NOTE = "This visual does not filter others.";

/** The overlay host element's attribute (lib/interactionOverlay.tsx; E2E can find it). */
export const INTERACTION_OVERLAY_ATTR = "data-canvas-interactions";

/** The persisted shape of `CanvasLayout.interactions`. */
export type LayoutInteractions = NonNullable<CanvasLayout["interactions"]>;

const INACTIVE: EditInteractionsState = Object.freeze({ active: false, source: null });

let state: EditInteractionsState = INACTIVE;
const listeners = new Set<() => void>();

function setState(next: EditInteractionsState): void {
  if (next.active === state.active && sameRef(next.source, state.source)) return;
  state = Object.freeze({ ...next });
  for (const l of Array.from(listeners)) {
    try {
      l();
    } catch (err) {
      console.error("[CanvasSheet] edit-interactions listener threw:", err);
    }
  }
}

export function getEditInteractionsState(): EditInteractionsState {
  return state;
}

export function subscribeEditInteractions(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isEditInteractionsActive(): boolean {
  return state.active;
}

function sameRef(a: VisualRef | null, b: VisualRef | null): boolean {
  if (a === null || b === null) return a === b;
  return a.kind === b.kind && a.id === b.id;
}

function isInteractionKind(kind: string): kind is VisualRef["kind"] {
  return (CANVAS_INTERACTION_KINDS as readonly string[]).includes(kind);
}

/** The interaction ref of a region, or null when it is not a chart / pivot / slicer. */
export function visualRefOfRegion(region: GridRegion): VisualRef | null {
  const ref = objectRefOf(region);
  if (!ref || !isInteractionKind(ref.kind)) return null;
  return { kind: ref.kind, id: ref.id };
}

// ============================================================================
// Pure rules (exported for tests)
// ============================================================================

/**
 * The mode a pair has when no pair is stored: @api/reportFilters
 * `interactionFor` rule 3 (pinned against it by the tests).
 */
export function defaultInteractionMode(
  defaultMode: LayoutInteractions["defaultMode"],
  sourceIsSlicer: boolean,
  targetCanHighlight: boolean,
): InteractionMode {
  if (sourceIsSlicer) return "filter";
  const mode = defaultMode ?? "highlight";
  return mode === "highlight" && !targetCanHighlight ? "filter" : mode;
}

/**
 * The page's interactions after setting (source -> target) to `mode`: any
 * stored pair for the two is replaced, and a mode equal to the default is not
 * stored at all. The other pairs keep their order. Pure.
 */
export function nextInteractions(
  current: CanvasLayout["interactions"] | undefined,
  source: VisualRef,
  target: VisualRef,
  mode: InteractionMode,
  targetCanHighlight: boolean,
): LayoutInteractions {
  const pairs = (current?.pairs ?? []).filter(
    (p) => !(sameRef(p.source as VisualRef, source) && sameRef(p.target as VisualRef, target)),
  );
  const fallback = defaultInteractionMode(current?.defaultMode, source.kind === "slicer", targetCanHighlight);
  if (mode !== fallback) {
    pairs.push({ source: { kind: source.kind, id: source.id }, target: { kind: target.kind, id: target.id }, mode });
  }
  const out: LayoutInteractions = { pairs };
  if (current?.defaultMode !== undefined) out.defaultMode = current.defaultMode;
  return out;
}

/** Whether two interactions values store the same thing (pair order included). */
export function sameInteractions(a: CanvasLayout["interactions"] | undefined, b: CanvasLayout["interactions"] | undefined): boolean {
  const norm = (v: CanvasLayout["interactions"] | undefined) =>
    JSON.stringify({
      d: v?.defaultMode ?? null,
      p: (v?.pairs ?? []).map((p) => [p.source.kind, p.source.id, p.target.kind, p.target.id, p.mode]),
    });
  return norm(a) === norm(b);
}

// ============================================================================
// Enter / exit
// ============================================================================

/** Whether the mode can be entered now, why not, and with which source. */
export function editInteractionsAvailability(): { ok: boolean; reason: string | null; source: VisualRef | null } {
  const snap = getCanvasSheetSnapshot();
  if (!snap.active) return { ok: false, reason: NOT_A_CANVAS_NOTE, source: null };
  if (snap.activeSubscribed) return { ok: false, reason: SUBSCRIBED_NOTE, source: null };
  const selected = getSelectedObjectRegions();
  if (selected.length !== 1) return { ok: false, reason: SELECT_ONE_VISUAL_NOTE, source: null };
  const ref = visualRefOfRegion(selected[0]);
  if (!ref) return { ok: false, reason: NOT_A_SOURCE_NOTE, source: null };
  const info = modelVisualOf(ref);
  if (!info || !info.role.source) return { ok: false, reason: info?.role.reason ?? NOT_A_SOURCE_NOTE, source: null };
  return { ok: true, reason: null, source: ref };
}

/** Enter the mode with the one selected visual as its source. Returns whether it entered. */
export function enterEditInteractions(): boolean {
  const a = editInteractionsAvailability();
  if (!a.ok || !a.source) return false;
  setState({ active: true, source: a.source });
  return true;
}

export function exitEditInteractions(): void {
  setState(INACTIVE);
}

/** The ribbon toggle: exit when active, otherwise enter. */
export function toggleEditInteractions(): boolean {
  if (state.active) {
    exitEditInteractions();
    return false;
  }
  return enterEditInteractions();
}

// ============================================================================
// The write
// ============================================================================

/**
 * Set how `source` reaches `target` on the page `pageSheetId`. ONE
 * `setCanvasLayout({ interactions })` invoke, and none when nothing would
 * change. Refused (false, nothing sent) on a subscribed canvas or an unknown
 * page. A backend refusal is told to the user.
 */
export async function setInteraction(
  pageSheetId: string,
  source: VisualRef,
  target: VisualRef,
  mode: InteractionMode,
): Promise<boolean> {
  const entry = canvasBySheetId(pageSheetId);
  if (!entry) return false;
  if (isSubscribedCanvas(entry.index)) return false;
  if (sameRef(source, target)) return false;
  const info = modelVisualOf(target);
  const canHighlight = info?.role.canHighlight === true;
  if (mode === "highlight" && !canHighlight) return false;
  const next = nextInteractions(entry.layout.interactions, source, target, mode, canHighlight);
  if (sameInteractions(entry.layout.interactions, next)) return false;
  try {
    const layout = await setCanvasLayout({ interactions: next }, entry.index);
    applyCanvasLayout(entry.index, layout);
    return true;
  } catch (err) {
    void refreshCanvasSheets();
    void alertAsync(String(err), { title: "Edit interactions" });
    return false;
  }
}

// ============================================================================
// Lifetime
// ============================================================================

/**
 * The exit rules and the source-follows-selection rule. Returns the cleanups.
 */
export function installEditInteractions(): Array<() => void> {
  const cleanups: Array<() => void> = [];
  let lastActiveIndex = getCanvasSheetSnapshot().activeIndex;
  cleanups.push(
    subscribeCanvasSheets(() => {
      const snap = getCanvasSheetSnapshot();
      if (snap.activeIndex !== lastActiveIndex) {
        lastActiveIndex = snap.activeIndex;
        exitEditInteractions();
        return;
      }
      // The canvas became subscribed (a pull) or stopped being a canvas.
      if (state.active && (!snap.active || snap.activeSubscribed)) exitEditInteractions();
    }),
  );
  for (const event of [AppEvents.AFTER_NEW, AppEvents.AFTER_OPEN]) {
    cleanups.push(onAppEvent(event, () => exitEditInteractions()));
  }
  // The source was deleted: its family no longer lists it.
  cleanups.push(
    onRegionChange(() => {
      if (state.active && state.source && !modelVisualOf(state.source)) exitEditInteractions();
    }),
  );
  // Selecting another source-capable visual makes it the source.
  cleanups.push(
    onObjectSelectionChanged(() => {
      if (!state.active) return;
      const a = editInteractionsAvailability();
      if (a.ok && a.source && !sameRef(a.source, state.source)) setState({ active: true, source: a.source });
    }),
  );
  cleanups.push(() => exitEditInteractions());
  return cleanups;
}
