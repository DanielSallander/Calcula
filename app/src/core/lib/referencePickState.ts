//! FILENAME: app/src/core/lib/referencePickState.ts
// PURPOSE: The state of a REFERENCE PICK on a floating object (D-PICK, owner
//          finding F3): whether a formula is picking a reference right now, the
//          range a pick drag covers (for the owning family to paint dashed),
//          and the echo window of a finished pick (the second press and the
//          dblclick of a double-click that started as a pick are its echo).
// CONTEXT: The probe and the predicate used to live in floatingHandles.ts, which
//          imports api/gridOverlays -- so gridOverlays could not re-export them
//          without closing a cycle. This leaf imports only formulaEditTarget (a
//          module with no imports) and TYPES from api/gridOverlays, so the facade
//          (@api/gridOverlays, @api/editing) and Core's press path all read the
//          ONE predicate from here. floatingHandles.ts re-exports it unchanged.
//
//          THE GRID PROBE. The grid editor's formula mode lives in
//          core/hooks/useEditing, which imports the renderer floatingHandles is
//          painted from; it is handed in through `registerGridReferencePickProbe`
//          by the resize handlers (overlayResizeHandlers.ts registers
//          `isGlobalFormulaMode` at module load) rather than imported here.

import { getExternalFormulaTarget } from "./formulaEditTarget";
import type { FloatingReferencePickPreview } from "../../api/gridOverlays";

// ============================================================================
// Whether a formula is picking a reference
// ============================================================================

let gridReferencePickProbe: (() => boolean) | null = null;

/**
 * Hand this module the GRID editor's "a formula is picking a reference" probe
 * (see the header: an import would close a cycle through the renderer). Last
 * registration wins; the cleanup removes only what is still this probe.
 */
export function registerGridReferencePickProbe(probe: () => boolean): () => void {
  gridReferencePickProbe = probe;
  return () => {
    if (gridReferencePickProbe === probe) gridReferencePickProbe = null;
  };
}

/**
 * Whether a formula is PICKING a reference right now -- in the grid's own
 * editor, or in an extension's external editor (a floating grid's cell editor,
 * @api/editing). A press on a floating object then belongs to the pick.
 */
export function floatingReferencePickActive(): boolean {
  let grid = false;
  try {
    grid = gridReferencePickProbe?.() === true;
  } catch (err) {
    console.error("[referencePickState] reference-pick probe threw:", err);
  }
  return grid || getExternalFormulaTarget()?.isExpectingReference() === true;
}

// ============================================================================
// The live pick drag's preview
// ============================================================================

let preview: FloatingReferencePickPreview | null = null;
const previewListeners = new Set<() => void>();

/** What a pick drag covers right now (the owning family paints it dashed), or null. */
export function getFloatingReferencePickPreview(): FloatingReferencePickPreview | null {
  return preview;
}

/**
 * Core-internal: set or clear the preview (the pick session in
 * useMouseSelection/layout/floatingReferencePickSession.ts is the one writer).
 * Listeners hear a CHANGE only; setting null over null announces nothing.
 */
export function setFloatingReferencePickPreview(p: FloatingReferencePickPreview | null): void {
  if (p === null && preview === null) return;
  preview = p;
  for (const listener of Array.from(previewListeners)) {
    try {
      listener();
    } catch (err) {
      console.error("[referencePickState] preview listener threw:", err);
    }
  }
}

/** Listen for preview changes. Returns the unsubscribe. */
export function onFloatingReferencePickPreviewChanged(listener: () => void): () => void {
  previewListeners.add(listener);
  return () => {
    previewListeners.delete(listener);
  };
}

// ============================================================================
// The echo of a finished pick
// ============================================================================

/** How long after a finished pick a press or dblclick on the same object is its echo. */
export const DOUBLE_CLICK_ECHO_MS = 500;
/** How far from the finished pick (client px) an echo may land. */
export const ECHO_RADIUS_PX = 4;

let lastPick: { regionId: string; clientX: number; clientY: number; at: number } | null = null;

/**
 * Remember a finished pick, so the second press and the dblclick of a
 * double-click are recognised as its echo. The insertion flips the edit out of
 * "expecting a reference", so without this the second press would be an
 * ordinary press: it would select the object and commit the half-typed edit.
 */
export function noteFinishedReferencePick(
  regionId: string,
  clientX: number,
  clientY: number,
  at: number = Date.now(),
): void {
  lastPick = { regionId, clientX, clientY, at };
}

/**
 * True for DOUBLE_CLICK_ECHO_MS after a pick on `regionId`, within
 * ECHO_RADIUS_PX of where it finished. A point without coordinates is never an
 * echo.
 */
export function isReferencePickEcho(
  regionId: string,
  clientX: number,
  clientY: number,
  at: number = Date.now(),
): boolean {
  if (lastPick === null || lastPick.regionId !== regionId) return false;
  const elapsed = at - lastPick.at;
  if (!(elapsed >= 0 && elapsed < DOUBLE_CLICK_ECHO_MS)) return false;
  const distance = Math.hypot(clientX - lastPick.clientX, clientY - lastPick.clientY);
  return distance <= ECHO_RADIUS_PX;
}

/**
 * Test reset: no preview, no echo, no listeners. The grid probe is left alone:
 * overlayResizeHandlers.ts registers it once at module load, and a test that
 * cleared it could not get it back (its own probes clean up after themselves).
 */
export function __resetReferencePickStateForTests(): void {
  preview = null;
  previewListeners.clear();
  lastPick = null;
}
