//! FILENAME: app/src/shell/ActivityBar/ActivityBar.styles.ts
// PURPOSE: The activity rail's chrome — container, 48px cells, 40px chips,
//          the active indicator and the two badges — as emotion classes on the
//          --activity-bar-* tokens.
// CONTEXT: Calcula Clusters redesign (approved mockup, Sidebar board:
//          calcula.css `.cal-rail`, `.cal-railbtn`, `.cal-chip40`). The rail
//          used to be inline style objects with a hardcoded #333333 ground,
//          white icons dimmed through three opacity steps and a 2px white bar;
//          none of it followed a skin. Everything here is a token, so Light
//          gets a light rail, Dark a dark one, and a company skin can repaint
//          it without code.
//
//          Geometry (the same padding rule as a ribbon cluster): each item is a
//          48x48 hit target that hosts a 40x40 chip with radius 10. The chip
//          carries the hover and active washes and the keyboard focus ring; the
//          48px button carries the text colour (which the icons inherit through
//          currentColor) and the 3px active indicator on its left edge.
//
//          State hooks are ATTRIBUTES, not interpolated class names:
//          `[aria-current="true"]` on the button and `[data-rail-chip]` on the
//          chip. Emotion does not resolve `.${otherClass}` inside a selector (it
//          splices that class's declarations and the rule silently dies), and an
//          attribute also keeps the painted state and the announced state from
//          disagreeing.
//
//          Every colour is `var(--token, #lightFallback)`: the fallback keeps a
//          window that never loaded the skin legible, and it is the only place a
//          literal may appear (eslint.boundaries.js, chromeColorConfigs).

import { css } from "@emotion/css";
import { FONT_FAMILY } from "../../api/layout";

/** The rail's fixed width. Layout, the side panel and E2E geometry all assume it. */
export const ACTIVITY_BAR_WIDTH = 48;

/** Side of the chip inside each 48px cell (4px of breathing room per side). */
export const RAIL_CHIP_SIZE = 40;

/** Rendered size every rail icon is normalised to, whatever its author drew. */
export const RAIL_ICON_SIZE = 24;

// ---- tokens (each written once, with its light baseline as the fallback) ----

const RAIL_BG = "var(--activity-bar-bg, #f3f4f6)";
const RAIL_FG = "var(--activity-bar-fg, #4b5563)";
const RAIL_FG_ACTIVE = "var(--activity-bar-fg-active, #111827)";
const RAIL_HOVER_BG = "var(--activity-bar-item-hover-bg, rgba(17, 24, 39, 0.06))";
const RAIL_ACTIVE_BG =
  "var(--activity-bar-item-active-bg, color-mix(in srgb, var(--state-accent, #047857) 14%, transparent))";
const RAIL_INDICATOR = "var(--activity-bar-indicator, var(--state-accent, #047857))";
const FOCUS_RING = "var(--focus-ring, 0 0 0 2px var(--bg-surface, #ffffff), 0 0 0 4px var(--state-accent, #047857))";
const MOTION_HOVER = "var(--motion-hover, 120ms cubic-bezier(0.2, 0, 0, 1))";

// ---- container ---------------------------------------------------------------

export const railContainer = css`
  display: flex;
  flex-direction: column;
  width: ${ACTIVITY_BAR_WIDTH}px;
  min-width: ${ACTIVITY_BAR_WIDTH}px;
  height: 100%;
  flex-shrink: 0;
  background: ${RAIL_BG};
  font-family: ${FONT_FAMILY};
`;

export const railTop = css`
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 4px;
  flex: 1;
`;

export const railBottom = css`
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-bottom: 4px;
`;

// ---- one item: 48px button hosting a 40px chip ---------------------------------

export const railButton = css`
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  box-sizing: border-box;
  width: ${ACTIVITY_BAR_WIDTH}px;
  height: ${ACTIVITY_BAR_WIDTH}px;
  padding: 0;
  margin: 0;
  border: none;
  border-radius: 0;
  background: transparent;
  color: ${RAIL_FG};
  cursor: pointer;
  transition: color ${MOTION_HOVER};

  &:hover {
    color: ${RAIL_FG_ACTIVE};
  }

  &:hover > [data-rail-chip] {
    background: ${RAIL_HOVER_BG};
  }

  /* The ring sits on the chip, not the 48px cell, so it hugs what the user
     sees as the control. index.css paints a global button:focus-visible
     outline; this class out-ranks it. */
  &:focus-visible {
    outline: none;
  }

  &:focus-visible > [data-rail-chip] {
    box-shadow: ${FOCUS_RING};
  }

  /* Active AFTER hover: equal specificity, so the active wash survives a
     hover over the active item (the mockup's cascade order). */
  &[aria-current="true"] {
    color: ${RAIL_FG_ACTIVE};
  }

  &[aria-current="true"] > [data-rail-chip] {
    background: ${RAIL_ACTIVE_BG};
  }

  &[aria-current="true"]::before {
    content: "";
    position: absolute;
    left: 0;
    top: 12px;
    bottom: 12px;
    width: 3px;
    border-radius: 0 2px 2px 0;
    background: ${RAIL_INDICATOR};
  }
`;

export const railChip = css`
  display: flex;
  align-items: center;
  justify-content: center;
  width: ${RAIL_CHIP_SIZE}px;
  height: ${RAIL_CHIP_SIZE}px;
  border-radius: 10px;
  background: transparent;
  transition:
    background-color ${MOTION_HOVER},
    box-shadow ${MOTION_HOVER};

  /* Extension icons arrive at whatever size their author drew (14, 16, 18,
     22, 24...). The rail shows every one at one size so the column reads as a
     set; the viewBox scales the drawing. */
  & svg {
    width: ${RAIL_ICON_SIZE}px;
    height: ${RAIL_ICON_SIZE}px;
    flex: none;
  }
`;

// ---- badges (painted by the @api Badge; these only position it) ---------------

/** Notification count: bottom-right of the chip. */
export const railBadge = css`
  position: absolute;
  bottom: 7px;
  right: 7px;
`;

/** Design-mode "JS" script pill: top-right, apart from the count. */
export const railScriptBadge = css`
  position: absolute;
  top: 5px;
  right: 5px;
  letter-spacing: 0.03em;
`;
