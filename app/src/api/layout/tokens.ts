//! FILENAME: app/src/api/layout/tokens.ts
// PURPOSE: Shared layout constants for panel/ribbon content.
// CONTEXT: One source of truth for control heights, gaps and band geometry so
//          extensions stop hand-rolling per-tab pixel values. The shell's
//          renderers and the @api/layout primitives both consume these.

/** Small control height (compact list-row buttons). */
export const CONTROL_HEIGHT_SM = 22;
/** Standard input field height. */
export const FIELD_HEIGHT = 24;
/** Standard control/button height. */
export const CONTROL_HEIGHT_MD = 26;

export const GAP_XS = 4;
export const GAP_SM = 6;
export const GAP_MD = 8;

/** Total ribbon content band height (shell-owned, includes 6px padding).
 *  Sized so a group fits three 22px control rows plus its label, like Excel. */
export const RIBBON_BAND_HEIGHT = 100;
/** Usable content height inside the band (band minus 2x6 padding). */
export const RIBBON_CONTENT_HEIGHT = 88;

/** Height above which a measured ribbon section demotes to a launcher. */
export const DEMOTE_HEIGHT = 92;
/** Height below which a demoted section may promote back inline. */
export const PROMOTE_HEIGHT = 84;

/** Collapsed launcher button minimum width (matches Excel's collapsed group). */
export const LAUNCHER_MIN_WIDTH = 56;
/** Effective width a launcher occupies in the band, chrome included. */
export const LAUNCHER_BAND_WIDTH = 64;

/** Launcher flyout width bounds — mirrors the sidebar's own resize range. */
export const FLYOUT_DEFAULT_WIDTH = 320;
export const FLYOUT_MIN_WIDTH = 240;
export const FLYOUT_MAX_WIDTH = 480;

export const FONT_FAMILY =
  "'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif";
export const LABEL_FONT_SIZE = 11;
export const GROUP_LABEL_FONT_SIZE = 10;

/** Clamp a requested flyout width into the sanctioned range. */
export function clampFlyoutWidth(width: number | undefined): number {
  const w = width ?? FLYOUT_DEFAULT_WIDTH;
  return Math.min(FLYOUT_MAX_WIDTH, Math.max(FLYOUT_MIN_WIDTH, w));
}
