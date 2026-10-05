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

// ---- The hero's vertical geometry ----------------------------------------
//
// A hero (CommandButton in the band) fills the 61px content box with its icon
// over its label, and since 2026-10-04 it comes in two label shapes, plus the
// split form of each (SplitMenuButton face "hero", Excel's LARGE split: Paste,
// Insert, Delete). Every one of them is derived here, so a test can add the
// pieces up and prove they still make 61:
//
//   ONE-LINE (the default, unchanged since the Clusters redesign)
//     pad 6 + slot 34 + gap 2 + line 13 + pad 6                     = 61
//   TWO-LINE (Excel's "Conditional / Formatting v")
//     pad 2 + icon 30 + gap 1 + line 13 + line 13 + pad 2           = 61
//     The 34px slot is the one thing that has to give: 34 + 26 is 60 and
//     leaves one pixel for four paddings. The ICON stays 30 (the slot shrinks
//     to the icon it holds), because a smaller picture on the heroes that
//     carry the longest names would read as the less important commands.
//   SPLIT, one-line: the hairline sits in the middle of the 2px gap, so the
//     icon and the label land on the SAME pixels as a plain hero beside it
//     (Cells: Insert and Delete splits beside the Format hero):
//     top part   pad 6 + slot 34 + 1                                 = 41
//     menu part  1 + line 13 + pad 6                                 = 20
//   SPLIT, two-line: the same rule over the two-line hero:
//     top part   pad 2 + icon 30                                     = 32
//     menu part  gap 1 + 2 x line 13 + pad 2                         = 29

/** One hero label line (11px text). */
export const HERO_LABEL_LINE_HEIGHT = 13;
/** Top and bottom padding of a ONE-LINE hero. */
export const HERO_PAD_Y = 6;
/** Gap between a one-line hero's icon slot and its label. */
export const HERO_LABEL_GAP = 2;
/** Gap between a two-line hero's icon and its first label line. */
export const HERO_TWO_LINE_GAP = 1;
/** Top and bottom padding of a TWO-LINE hero: whatever the 61 leaves. */
export const HERO_TWO_LINE_PAD_Y =
  (TALL_CONTROL_HEIGHT - HERO_ICON_SIZE - HERO_TWO_LINE_GAP - 2 * HERO_LABEL_LINE_HEIGHT) / 2; // 2
/** Height of a one-line hero split's icon (top) part. */
export const HERO_SPLIT_TOP_HEIGHT = HERO_PAD_Y + HERO_ICON_SLOT + HERO_LABEL_GAP / 2; // 41
/** Height of a two-line hero split's icon (top) part. */
export const HERO_SPLIT_TOP_HEIGHT_TWO_LINE = HERO_TWO_LINE_PAD_Y + HERO_ICON_SIZE; // 32

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
/** Hover delay before a submenu (MenuSub) opens -- and before hovering a
 *  DIFFERENT row closes an open one, so a pointer cutting diagonally across a
 *  sibling row on its way into the flyout does not lose it (Windows' menu
 *  timing; Excel's flyouts follow it). */
export const SUBMENU_HOVER_DELAY_MS = 200;

// ---- The card overlay (Popover `card`) -----------------------------------
//
// Every Clusters overlay -- a menu, a dropdown list, a colour palette, a
// MenuSub flyout -- is the same card: a 1px border and 8px of padding on all
// four sides (the fill rule, applied to overlays). They are constants rather
// than literals in Popover.tsx because a FLYOUT has to be placed by them: a
// MenuSub flyout opened at its row's top would put its first row
// border + padding = 9px BELOW the row that opened it. Excel lines the two up,
// so the flyout is lifted by exactly that much (SUBMENU_ALIGN_OFFSET), and the
// day the card's padding changes, the lift changes with it.

/** Padding of the card overlay, all four sides. */
export const POPOVER_CARD_PADDING = 8;
/** Border width of the card overlay. */
export const POPOVER_CARD_BORDER = 1;
/** How far a MenuSub flyout is moved along its row's edge (Popover
 *  `alignOffset` at "right-start"): up by the card's border + padding, so the
 *  flyout's first row sits level with the row that opened it, as in Excel. */
export const SUBMENU_ALIGN_OFFSET = -(POPOVER_CARD_BORDER + POPOVER_CARD_PADDING); // -9

// ---- The dialog launcher (Excel's corner arrow under a group) ------------
//
// Drawn by the shell in a group's caption row (SectionChrome), so its size is
// band geometry the shell lays the caption out by -- which is why it lives
// here with the rest of the geometry rather than in Launcher.tsx, the file that
// draws it (Launcher.tsx re-exports these names unchanged).

/** Hit box of the caption-row dialog launcher. 16 wide like a split button's
 *  chevron half; 13 tall, the caption's own line box (GROUP_LABEL_BLOCK_HEIGHT
 *  15 = 2px margin + 13px line), so in the caption row the glyph sits on the
 *  caption's text line and the button never reaches up into the card. */
export const DIALOG_LAUNCHER_WIDTH = 16;
export const DIALOG_LAUNCHER_HEIGHT = 13;
/** The corner-arrow glyph: about Excel's own (~10px at 100% zoom). */
export const DIALOG_LAUNCHER_GLYPH_SIZE = 10;
/** Symmetric horizontal padding the caption takes while a dialog launcher is
 *  present: the launcher's width plus a 2px gap, on BOTH sides, so the
 *  caption text stays centred under the card and never runs under the arrow.
 *  Only applied when a launcher is declared — a group without one keeps
 *  today's caption exactly (the visual goldens depend on that). */
export const DIALOG_LAUNCHER_CAPTION_PAD = DIALOG_LAUNCHER_WIDTH + 2;
/** With group labels hidden the caption collapses to zero height and the card
 *  grows to the band's full 92px, so the launcher (anchored to the cell's
 *  bottom-right) lands on the card's rounded corner. Insetting it by this much
 *  keeps the glyph inside the card's painted corner (radius 12) and still
 *  clear of the 61px content box: the card's free bottom strip is
 *  8 padding + (76 - 61) / 2 = 15.5px, and 2 + 13 = 15 fits under it. */
export const DIALOG_LAUNCHER_HIDDEN_INSET = 2;

/** Clamp a requested flyout width into the sanctioned range. */
export function clampFlyoutWidth(width: number | undefined): number {
  const w = width ?? FLYOUT_DEFAULT_WIDTH;
  return Math.min(FLYOUT_MAX_WIDTH, Math.max(FLYOUT_MIN_WIDTH, w));
}
