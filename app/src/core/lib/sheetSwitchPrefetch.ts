//! FILENAME: app/src/core/lib/sheetSwitchPrefetch.ts
// PURPOSE: BUG-0052 — make a sheet switch atomic ON SCREEN, not merely in
//          state, by fetching the target sheet's viewport BEFORE the visible
//          swap so the tab strip and the canvas commit in ONE paint.
// CONTEXT: Every sheet switch dispatches `sheet:beforeSwitch` -> the grid
//          sheet context -> `sheet:normalSwitch` with no `await` between them,
//          so the tab strip repaints on the very next frame — but the canvas
//          could not repaint until `fetchCells()` had completed a backend
//          round trip. Measured per animation frame, that put the NEW sheet's
//          bold tab over the OLD sheet's cells for ~40-70 ms (2-4 frames) on
//          EVERY switch: tab click, undo/redo follow, add/delete sheet, MCP.
//
//          THE FIX'S SHAPE, and why it is a handoff slot rather than a second
//          channel: the register's standing warning about the switch path is
//          that the last time per-sheet state had TWO hydration paths, the
//          second was mount-only and painted sheet 1's panes on sheet 2. So
//          nothing new listens and nothing new dispatches. The initiator —
//          which has ALREADY completed the backend switch, so a viewport read
//          answers about the NEW sheet — awaits `primeSheetSwitch()` and then
//          fires the exact same synchronous dispatch sequence as before, with
//          zero awaits inside it. GridCanvas's existing `sheet:normalSwitch`
//          handler (still the ONLY consumer that writes the cell cache on a
//          switch) collects the primed payload with `takePrefetchedSheetSwitch`
//          and commits it synchronously; React batches that with the sheet
//          context change, and a layout effect paints the canvas before the
//          browser paints the bold tab. One flush, one frame, no tear.
//
//          WHILE THE PRIME IS IN FLIGHT the screen still shows the old sheet
//          CONSISTENTLY — old tab, old cells — which is agreement, not a tear;
//          the visible latency of the switch is unchanged because the fetch
//          this prime performs is the same one the old code ran after the
//          swap. If no prefetcher is registered (grid not mounted) or the
//          fetch fails, the slot stays empty and the handler falls back to the
//          old post-switch fetch: degraded to the old two-frame tear, never to
//          a wrong or missing paint.
//
//          WHY IT LIVES IN CORE. It is a property OF the renderer, published
//          for the switch initiators (Shell's SheetTabs through `@api`, and
//          Core's own undo/redo follow). Same shape as lib/renderSignal.
//
//          THE VIEW STATE RIDES THE SAME PRIME. A sheet's gridlines, display
//          flags (headings, zeros, formulas, view mode), zoom, split and
//          freeze are per-sheet backend state, hydrated by Spreadsheet.tsx's
//          active-sheet effect. Hydrated AFTER the context switch -- three IPCs
//          from an effect of the render that switched -- the first frame(s) of
//          a worksheet reached from a CANVAS showed the canvas's headings-off,
//          gridlines-off and zoom (open-items 2.af, "One-frame flash"). So the
//          prime reads the target's view in parallel with its cells, into its
//          OWN slot (GridCanvas takes the cells; the hydration effect takes the
//          view, in a layout effect of the same flush). Same rules as the
//          cells: one slot, keyed by sheet index, taken once, aged out, and a
//          route that never primes keeps the async hydration.

import { invoke } from "@tauri-apps/api/core";
import type { CellData, SpillRangeInfo } from "../types";
import { markFetchStarted, markFetchSettled } from "./renderSignal";
import {
  loadSheetDisplayFlags,
  loadSheetViewState,
  type SheetDisplayFlags,
  type SheetViewState,
} from "./sheetViewState";

/** What a prime fetched: the same trio `GridCanvas.fetchCells` commits. */
export interface SheetSwitchPrefetchPayload {
  /** The range the cells cover — becomes the canvas's `lastFetchRef`. */
  fetchRange: { startRow: number; endRow: number; startCol: number; endCol: number };
  cells: CellData[];
  spillRanges: SpillRangeInfo[];
}

/**
 * The fetcher GridCanvas registers: reads the CURRENT viewport's range and
 * fetches it from the backend (which, at prime time, is already on the target
 * sheet). Returns null when the canvas cannot fetch (no size yet).
 */
export type SheetSwitchPrefetcher = () => Promise<SheetSwitchPrefetchPayload | null>;

let prefetcher: SheetSwitchPrefetcher | null = null;

interface PrimedSlot {
  sheetIndex: number;
  payload: SheetSwitchPrefetchPayload;
  primedAt: number;
}

/** At most ONE primed switch at a time; a new prime replaces a stale one. */
let slot: PrimedSlot | null = null;

/**
 * The target sheet's VIEW state, read by the same prime: what Spreadsheet's
 * active-sheet hydration would otherwise read after the swap.
 */
export interface SheetSwitchViewPayload {
  /** `get_show_gridlines`; null when that read failed (the fallback re-reads it). */
  showGridlines: boolean | null;
  /** Zoom (as a render factor), split and freeze. */
  view: SheetViewState;
  /** Display zeros, show formulas, view mode, headings. */
  flags: SheetDisplayFlags;
}

interface PrimedViewSlot {
  sheetIndex: number;
  payload: SheetSwitchViewPayload;
  primedAt: number;
}

/** The view half of the prime, taken separately from the cells. */
let viewSlot: PrimedViewSlot | null = null;

/** Read the ACTIVE sheet's view state (the backend is on the target already). Never throws. */
async function readActiveSheetView(): Promise<SheetSwitchViewPayload> {
  const [showGridlines, view, flags] = await Promise.all([
    invoke<boolean>("get_show_gridlines").then(
      (v) => (typeof v === "boolean" ? v : null),
      () => null,
    ),
    loadSheetViewState(),
    loadSheetDisplayFlags(),
  ]);
  return { showGridlines, view, flags };
}

/**
 * A primed payload a switch never consumed (initiator threw between prime and
 * dispatch) must not be handed to a LATER switch: past this age it is trash.
 * Generous, because the prime and its take are normally microtasks apart.
 */
const SLOT_MAX_AGE_MS = 5_000;

/** GridCanvas mounts -> registers; unmount MUST call the returned dispose. */
export function registerSheetSwitchPrefetcher(fn: SheetSwitchPrefetcher): () => void {
  prefetcher = fn;
  return () => {
    if (prefetcher === fn) {
      prefetcher = null;
      slot = null;
      viewSlot = null;
    }
  };
}

/**
 * Fetch the target sheet's viewport BEFORE the visible swap.
 *
 * Call AFTER the backend switch has completed (so the read answers about the
 * new sheet) and BEFORE the first dispatch of the switch sequence. Never
 * throws: a failed prime leaves the slot empty and the switch proceeds on the
 * old fetch-after-swap path.
 *
 * The fetch is bracketed with the renderSignal in-flight marks so a capture
 * polling for quiescence cannot photograph the pre-switch grid mid-prime.
 *
 * The target's VIEW state is read in parallel (see the header), into its own
 * slot: a failed cell fetch does not cost the view, nor the other way round.
 */
export async function primeSheetSwitch(newSheetIndex: number): Promise<void> {
  slot = null;
  viewSlot = null;
  const fetch = prefetcher;
  if (!fetch) return;
  markFetchStarted();
  try {
    // `Promise.resolve().then` so even a SYNCHRONOUS throw from the fetcher
    // lands as a rejection of its own half, never as a lost view.
    const [cells, view] = await Promise.allSettled([
      Promise.resolve().then(() => fetch()),
      readActiveSheetView(),
    ]);
    const primedAt = performance.now();
    if (cells.status === "fulfilled") {
      if (cells.value) {
        slot = { sheetIndex: newSheetIndex, payload: cells.value, primedAt };
      }
    } else {
      console.error(
        "[sheetSwitchPrefetch] prime failed - falling back to post-switch fetch:",
        cells.reason,
      );
    }
    if (view.status === "fulfilled") {
      viewSlot = { sheetIndex: newSheetIndex, payload: view.value, primedAt };
    } else {
      console.error(
        "[sheetSwitchPrefetch] view prime failed - falling back to post-switch hydration:",
        view.reason,
      );
    }
  } finally {
    markFetchSettled();
  }
}

/**
 * Consume the primed payload for this switch, or null to take the fallback
 * path. Takes CLEAR the slot, and a payload primed for another sheet index or
 * left over from an abandoned switch is refused rather than painted.
 */
export function takePrefetchedSheetSwitch(
  newSheetIndex: number,
): SheetSwitchPrefetchPayload | null {
  const taken = slot;
  slot = null;
  if (!taken) return null;
  if (taken.sheetIndex !== newSheetIndex) return null;
  if (performance.now() - taken.primedAt > SLOT_MAX_AGE_MS) return null;
  return taken.payload;
}

/**
 * Consume the primed VIEW state for this switch, or null to take the fallback
 * (the async hydration). Same rules as {@link takePrefetchedSheetSwitch}: a
 * take clears the slot, and a view primed for another sheet index or left over
 * from an abandoned switch is refused rather than applied.
 */
export function takePrefetchedSheetView(newSheetIndex: number): SheetSwitchViewPayload | null {
  const taken = viewSlot;
  viewSlot = null;
  if (!taken) return null;
  if (taken.sheetIndex !== newSheetIndex) return null;
  if (performance.now() - taken.primedAt > SLOT_MAX_AGE_MS) return null;
  return taken.payload;
}

/** Test-only reset so a suite can start from a known point. */
export function resetSheetSwitchPrefetchForTests(): void {
  prefetcher = null;
  slot = null;
  viewSlot = null;
}
