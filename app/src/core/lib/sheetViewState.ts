//! FILENAME: app/src/core/lib/sheetViewState.ts
// PURPOSE: The one place the frontend converts between the reducer's zoom
//          RENDER FACTOR and the persisted zoom PERCENT, and the one place it
//          hydrates / writes back the per-sheet view state (zoom + split).
// CONTEXT: Zoom and the split bar used to be frontend-only session state --
//          the same disease as the hidden-rows bug. They now have a real
//          backend authority (AppState::sheet_zooms / split_configs) that
//          round-trips through the .cala file, so this module is the boundary.

import {
  getSheetZoom,
  setSheetZoom,
  getSplitWindow,
  getFreezePanes,
  getSheetDisplayFlags,
  setSheetDisplayFlags,
} from "./tauri-api";
import { ZOOM_MIN, ZOOM_MAX } from "../types";

/**
 * The legal zoom band, as a PERCENT.
 *
 * ONE band, shared by the UI, the backend command (`set_sheet_zoom`) and the
 * script contract (`api.setZoom`, `script_engine::types::ZOOM_MIN/MAX_PERCENT`).
 * They used to disagree: the reducer allowed up to 500% while the script API
 * capped at 400, so a user could zoom to 500%, have `Calcula.getZoom()` report
 * 500, and then have `api.setZoom(500)` reject the very number the getter had
 * just handed them.
 */
export const ZOOM_PERCENT_MIN = 10;
export const ZOOM_PERCENT_MAX = 400;

/** Reducer render factor (1.0 = 100%) -> persisted percent (100 = 100%). */
export function zoomFactorToPercent(factor: number): number {
  if (!Number.isFinite(factor)) return 100;
  const percent = Math.round(factor * 100);
  return Math.max(ZOOM_PERCENT_MIN, Math.min(ZOOM_PERCENT_MAX, percent));
}

/** Persisted percent (100 = 100%) -> reducer render factor (1.0 = 100%). */
export function zoomPercentToFactor(percent: number): number {
  if (!Number.isFinite(percent)) return 1;
  const clamped = Math.max(ZOOM_PERCENT_MIN, Math.min(ZOOM_PERCENT_MAX, percent));
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, clamped / 100));
}

/** The per-sheet view state the backend owns, in the units the reducer wants. */
export interface SheetViewState {
  /** Zoom as a RENDER FACTOR (1.0 = 100%) — what `setZoom()` takes. */
  zoomFactor: number;
  splitRow: number | null;
  splitCol: number | null;
  freezeRow: number | null;
  freezeCol: number | null;
}

/**
 * Read the active sheet's persisted view state: zoom, split bars and freeze.
 *
 * Freeze is here even though it always persisted correctly. The backend has
 * held a freeze per sheet, and the .cala has stored it, since BUG-0018 — but
 * the FRONTEND only ever read it once, at startup, from the View menu's mount
 * effect. Nothing re-read it when the active sheet changed, so a workbook with
 * a freeze on sheet 2 showed sheet 1's panes on sheet 2. The persistence was
 * never the broken half; the hydration was.
 *
 * Never throws: a backend that cannot answer (older build, command missing,
 * window still booting) yields the defaults rather than blocking the grid from
 * rendering. Losing a zoom is bad; refusing to draw the sheet is worse.
 */
export async function loadSheetViewState(): Promise<SheetViewState> {
  const [percent, split, freeze] = await Promise.all([
    getSheetZoom().catch(() => 100),
    getSplitWindow().catch(() => ({ splitRow: null, splitCol: null })),
    getFreezePanes().catch(() => ({ freezeRow: null, freezeCol: null })),
  ]);
  return {
    zoomFactor: zoomPercentToFactor(percent),
    splitRow: split?.splitRow ?? null,
    splitCol: split?.splitCol ?? null,
    freezeRow: freeze?.freezeRow ?? null,
    freezeCol: freeze?.freezeCol ?? null,
  };
}

/**
 * Write the active sheet's zoom back to the authority.
 *
 * Takes a render FACTOR because that is what the reducer holds; the conversion
 * to percent happens here so no caller has to know the file's unit.
 */
export async function persistSheetZoom(zoomFactor: number): Promise<void> {
  await setSheetZoom(zoomFactorToPercent(zoomFactor)).catch(() => {
    /* a failed persist must not break interactive zooming */
  });
}

// ---------------------------------------------------------------------------
// Per-sheet DISPLAY FLAGS
// ---------------------------------------------------------------------------

/**
 * The sheet's display mode, mirroring Rust `api_types::SheetDisplayFlags`
 * (camelCase over IPC, per the golden rule).
 *
 * These four had the same disease zoom and split had, only worse: they had no
 * backend authority AT ALL, so they never reached the file and reset on every
 * reload and every sheet switch. They are one unit here for the same reason they
 * are one unit in Rust — a partial landing reproduces the original bug for
 * whichever flag was left out.
 */
export interface SheetDisplayFlags {
  displayZeros: boolean;
  showFormulas: boolean;
  viewMode: string;
  displayHeadings: boolean;
}

/** The values a sheet has when it has never been touched. */
export const DEFAULT_SHEET_DISPLAY_FLAGS: SheetDisplayFlags = {
  displayZeros: true,
  showFormulas: false,
  viewMode: "normal",
  displayHeadings: true,
};

/**
 * Read the active sheet's display flags.
 *
 * Never throws, for the same reason `loadSheetViewState` does not: losing a
 * display flag is bad, refusing to draw the sheet is worse.
 */
export async function loadSheetDisplayFlags(): Promise<SheetDisplayFlags> {
  const flags = await getSheetDisplayFlags().catch(() => null);
  return {
    displayZeros: flags?.displayZeros ?? DEFAULT_SHEET_DISPLAY_FLAGS.displayZeros,
    showFormulas: flags?.showFormulas ?? DEFAULT_SHEET_DISPLAY_FLAGS.showFormulas,
    viewMode: flags?.viewMode ?? DEFAULT_SHEET_DISPLAY_FLAGS.viewMode,
    displayHeadings: flags?.displayHeadings ?? DEFAULT_SHEET_DISPLAY_FLAGS.displayHeadings,
  };
}

/**
 * Write one or more display flags back to the authority.
 *
 * A PARTIAL patch on purpose: a caller toggling "show formulas" must not have to
 * know the other three, and must not be able to clobber them with stale values.
 */
export async function persistSheetDisplayFlags(
  patch: Partial<SheetDisplayFlags>
): Promise<void> {
  await setSheetDisplayFlags(patch).catch(() => {
    /* a failed persist must not break the interactive toggle */
  });
}
