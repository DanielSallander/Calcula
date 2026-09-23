//! FILENAME: app/src/shell/Overlays/MiniFormatToolbar/MiniFormatToolbar.styles.ts
// PURPOSE: Chrome of the Mini Format Toolbar — the floating pill above the grid
//          context menu (Calcula Clusters, Open.dc.html board 4).
// CONTEXT: The toolbar used to be its own little design system: 24px square
//          buttons with 3px corners, a hand-rolled 14px colour grid, divider
//          rules between groups and native selects in the OS look. It now
//          composes the SAME @api/layout controls the ribbon does (Segmented
//          pills, 28px IconButtons, ColorSwatch + ColorPopover, Select) and this
//          file draws only what is the toolbar's own: the pill it floats in, and
//          the stacking layers the overlays it opens are given.
//
//          THE PILL obeys the fill rule like a ribbon cluster: equal padding on
//          all four sides around one 28px row (6 top/bottom + 28 = 40 inside a
//          1px hairline), the cluster tint as its background, the popover
//          radius and the toolbar shadow. Every value is a token, so a skin
//          restyles the toolbar with the ribbon.
//
//          LAYERING. The toolbar floats one step above the context menu. The
//          @api overlays it opens are portalled to <body> at their own default
//          layers (Popover 1100, Tooltip 1200), which is right everywhere else
//          but would draw a colour palette or a tooltip BEHIND the context menu
//          it opens over. So the toolbar hands each overlay an explicit layer
//          through the primitives' `zIndex` / `tooltipZIndex` props — no global
//          stylesheet rule, nothing that outlives the toolbar.
//
//          Colours come only from tokens (LT); this folder is under the chrome
//          hex ban in eslint.boundaries.js.

import { css } from "@emotion/css";
import { FONT_FAMILY, LT } from "../../../api/layout";

// ============================================================================
// Identity
// ============================================================================

/** Prefix of every data-testid this toolbar renders — including the bodies of
 *  the colour popovers it opens. */
export const TESTID_PREFIX = "mini-format-";

// ============================================================================
// Layers
// ============================================================================

/**
 * The context menu's layer. `--z-context-menu` is a theme token, and both
 * built-in themes pin it at 10000 (core/theme/defaultTheme.ts and
 * darkTheme.ts). The pill follows the token itself (it must sit exactly one
 * step above the menu, whatever a theme says), but the overlays it opens take
 * a NUMBER — the z-index props of Popover / Tooltip / ColorSwatch are numeric —
 * so the value is mirrored here, and the unit tests fail if a theme moves the
 * menu above the layers derived from it.
 */
export const CONTEXT_MENU_LAYER = 10000;

/** The pill: one step above the context menu it sits over. */
export const TOOLBAR_Z_INDEX = `calc(var(--z-context-menu, ${CONTEXT_MENU_LAYER}) + 1)`;

/**
 * The overlays the toolbar opens — its two colour palettes — one step above
 * the pill (10002). ColorSwatch stacks its own tooltips over this layer: the
 * palette's swatch tooltips at +1, the trigger's tooltip at +2.
 */
export const MINI_TOOLBAR_LAYER = CONTEXT_MENU_LAYER + 2;

/** Every other tooltip on the toolbar: the same layer as a colour trigger's
 *  (MINI_TOOLBAR_LAYER + 2), so no tooltip is ever drawn under an open
 *  palette. */
export const MINI_TOOLBAR_TOOLTIP_LAYER = MINI_TOOLBAR_LAYER + 2;

// ============================================================================
// The pill
// ============================================================================

export const toolbar = css`
  position: fixed;
  z-index: ${TOOLBAR_Z_INDEX};
  display: inline-flex;
  align-items: center;
  gap: 5px;
  box-sizing: border-box;
  padding: 6px 8px;
  border: 1px solid ${LT.clusterBorder};
  border-radius: ${LT.radiusPopover};
  background: ${LT.clusterBg};
  box-shadow: ${LT.shadowToolbar};
  color: ${LT.text};
  font-family: ${FONT_FAMILY};
  white-space: nowrap;
  user-select: none;
`;

/** Font colour + fill colour: two standalone swatches, closer to each other
 *  than to their neighbours. */
export const colourPair = css`
  display: inline-flex;
  align-items: center;
  gap: 2px;
`;

// ============================================================================
// Typographic glyphs (B / I / U / S stay letters, as in Excel and the Home tab)
// ============================================================================

const letter = css`
  display: inline-block;
  font-family: ${FONT_FAMILY};
  font-size: 14px;
  line-height: 1;
`;

export const glyph = {
  bold: css`
    ${letter};
    font-weight: 700;
  `,
  italic: css`
    ${letter};
    font-family: Georgia, "Times New Roman", serif;
    font-style: italic;
  `,
  underline: css`
    ${letter};
    text-decoration: underline;
  `,
  strikethrough: css`
    ${letter};
    text-decoration: line-through;
  `,
};
