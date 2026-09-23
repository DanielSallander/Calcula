//! FILENAME: app/src/api/layout/tokens.ts
// PURPOSE: Shared layout constants for panel/ribbon content.
// CONTEXT: One source of truth for control heights, gaps and band geometry so
//          extensions stop hand-rolling per-tab pixel values. The shell's
//          renderers and the @api/layout primitives both consume these.
//
//          These are TypeScript constants, not CSS custom properties, on
//          purpose: the shell MEASURES the band against them (height demotion,
//          width demotion), so a skin must never be able to move them — a skin
//          that changed a CSS height would desync the measurement loop.
//
// THE FILL RULE (owner review, 2026-09-22). A ribbon cluster pads EQUALLY on
// all four sides and its content FILLS the box. The first draft put a 26px
// pill in a 77px card with 6px at the sides and 25px above and below, which
// read as crammed and empty at the same time. The chain is derived once:
//
//   band                         100
//   - band padding 4 + 4          92   RIBBON_CONTENT_HEIGHT
//   - caption block 15            77   the cluster card
//   - card padding 8 + 8          61   BAND_MAX_CONTENT_HEIGHT
//
// and every cluster fills that 61 in exactly one of two ways:
//   ONE TALL ROW   61   a hero, a tile, or a Segmented of 61px controls
//   TWO ROWS       28 + ROW_GAP 5 + 28 = 61

/** Small control height (compact list rows, secondary buttons). */
export const CONTROL_HEIGHT_SM = 24;
/** Standard input / select / dropdown height. */
export const FIELD_HEIGHT = 28;
/** Standard control/button height — one band row. */
export const CONTROL_HEIGHT_MD = 28;
/** A control that fills a whole ribbon cluster on its own (hero, tile). */
export const TALL_CONTROL_HEIGHT = 61;
/** Gap between the two rows of a two-row cluster: 28 + 5 + 28 = 61. */
export const ROW_GAP = 5;

export const GAP_XS = 4;
export const GAP_SM = 6;
export const GAP_MD = 8;

/** Total ribbon content band height (shell-owned, includes its padding). */
export const RIBBON_BAND_HEIGHT = 100;
/** Vertical padding of the band, top and bottom. */
export const RIBBON_BAND_PADDING_Y = 4;
/** Usable band height inside its padding. */
export const RIBBON_CONTENT_HEIGHT = RIBBON_BAND_HEIGHT - 2 * RIBBON_BAND_PADDING_Y; // 92
/** The group caption under a cluster: 13px line-height + 2px margin. */
export const GROUP_LABEL_BLOCK_HEIGHT = 15;
/** Cluster card padding, applied on ALL FOUR sides (the fill rule). */
export const CLUSTER_PAD = 8;
/** Horizontal gap between two clusters. */
export const CLUSTER_GAP = 6;
/** Content box inside a cluster card: what a section may occupy. */
export const BAND_MAX_CONTENT_HEIGHT =
  RIBBON_CONTENT_HEIGHT - GROUP_LABEL_BLOCK_HEIGHT - 2 * CLUSTER_PAD; // 61

/**
 * Height above which a measured ribbon section demotes to a launcher.
 * 2px of slack over the content box, and callers compare a ROUNDED height:
 * the probe reads a fractional contentRect, and demotion is sticky for the
 * session, so a section measuring 61.4 must not be demoted forever.
 */
export const DEMOTE_HEIGHT = BAND_MAX_CONTENT_HEIGHT + 2; // 63

/** Launcher button minimum width (a demoted cluster). */
export const LAUNCHER_MIN_WIDTH = 58;
/** Effective width a launcher occupies in the band: button + card padding + gap. */
export const LAUNCHER_BAND_WIDTH = LAUNCHER_MIN_WIDTH + 2 * CLUSTER_PAD + CLUSTER_GAP; // 80

/** Launcher flyout width bounds — mirrors the sidebar's own resize range. */
export const FLYOUT_DEFAULT_WIDTH = 320;
export const FLYOUT_MIN_WIDTH = 240;
export const FLYOUT_MAX_WIDTH = 480;

// ---- Icon ladder (the duotone set is drawn on a 24-unit grid) -------------
/** Icon inside a standard 28px control. */
export const ICON_SIZE_SM = 20;
/** Icon in the activity rail, sidebar headers and launcher slots. */
export const ICON_SIZE_MD = 24;
/** Icon in a tile or hero. */
export const ICON_SIZE_LG = 30;
/** Hero icon slot (the box the 30px icon sits in). */
export const HERO_ICON_SLOT = 34;
/** Hero icon size. */
export const HERO_ICON_SIZE = ICON_SIZE_LG;
/** Launcher icon size. */
export const LAUNCHER_ICON_SIZE = ICON_SIZE_MD;
/** Width of a tile (height is TALL_CONTROL_HEIGHT in the band). */
export const TILE_WIDTH = 44;

export const FONT_FAMILY =
  "'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif";
export const FONT_MONO = "'Cascadia Code', Consolas, ui-monospace, monospace";
export const LABEL_FONT_SIZE = 11;
export const GROUP_LABEL_FONT_SIZE = 11;
/** One header recipe for sidebar sections, side-panel titles, panel groups. */
export const HEADER_FONT_SIZE = 12;

/** Menu / listbox row height. */
export const MENU_ROW_HEIGHT = 30;
/** Hover delay before a tooltip appears. */
export const TOOLTIP_DELAY_MS = 400;

/** Clamp a requested flyout width into the sanctioned range. */
export function clampFlyoutWidth(width: number | undefined): number {
  const w = width ?? FLYOUT_DEFAULT_WIDTH;
  return Math.min(FLYOUT_MAX_WIDTH, Math.max(FLYOUT_MIN_WIDTH, w));
}
