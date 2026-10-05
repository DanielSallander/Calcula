//! FILENAME: app/extensions/ConditionalFormatting/components/galleryChrome.ts
// PURPOSE: The chrome the three Conditional Formatting galleries share -- their
//          own surface, the group headings, the option frame, the "More
//          Rules..." row -- and their arrow-key model.
// CONTEXT: ONE gallery, TWO hosts. The menu bar's Format > Conditional
//          Formatting flyout is dark in every skin (--menu-dropdown-bg is
//          #252526 in the light theme too); the Home tab's Conditional
//          Formatting hero opens the same customContent in an @api/layout card
//          (RegisteredMenuButton -> MenuSub), which is LT.surface. The
//          galleries used to paint with the menu bar's --menu-* variables. Those
//          ARE defined inside the card (the skin writes them on :root), so
//          nothing failed to resolve -- the card simply showed #cccccc text on
//          white and dark data-bar tiles on a light card. A gallery that
//          inherits its host's colours cannot be right in both, so it paints
//          its OWN LT surface: seamless inside the card (the same token), a
//          light panel inside the dark menu-bar flyout, and in both the
//          previews sit on a cell-white ground -- which is what they depict.
//
//          Colours come only from LT (the swatch colours are DATA, inside
//          `data-colour-data`, drawn by the galleries themselves).
//
//          KEYBOARD. Each option is a real <button> (Enter/Space/click choose).
//          The arrows move focus the way Excel's galleries do: Left/Right
//          step through the options in reading order, Up/Down move a whole row
//          within a group and cross into the neighbouring group at the same
//          column, Down from the last row reaches "More Rules...", Home/End
//          jump. A key that moves is preventDefault()ed; a key that cannot move
//          (ArrowLeft on the first option) is left alone, because it belongs to
//          the host -- a submenu level closes on it.

import { css } from "@emotion/css";
import { LT, FONT_FAMILY } from "@api/layout";
import type React from "react";

// ============================================================================
// Chrome
// ============================================================================

/** The gallery's own surface (see the header for why it has one). */
export const galleryRoot = css`
  box-sizing: border-box;
  padding: 6px;
  background: ${LT.surface};
  color: ${LT.text};
  border-radius: ${LT.radiusControl};
  font-family: ${FONT_FAMILY};
  font-size: 12px;
`;

/** A group caption ("Gradient Fill", "Directional"): the kit's heading recipe. */
export const groupHeading = css`
  padding: 6px 4px 4px;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  color: ${LT.textSecondary};
  user-select: none;
`;

/** A grid of options; the column count is set inline per gallery. */
export const optionGrid = css`
  display: grid;
  gap: 4px;
  padding: 2px;
`;

/** One option: a framed button around a colour-DATA preview. */
export const optionButton = css`
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  padding: 3px;
  border: 1px solid ${LT.controlBorder};
  border-radius: 4px;
  background: ${LT.surface};
  cursor: pointer;
  transition:
    border-color ${LT.motionHover},
    background-color ${LT.motionHover};

  &:hover {
    border-color: ${LT.clusterBorderHover};
    background: ${LT.hover};
  }

  &:focus {
    outline: none;
  }

  &:focus-visible {
    box-shadow: ${LT.focusRing};
  }
`;

/** The hairline above "More Rules..." (the kit's MenuSeparator recipe). */
export const footerRule = css`
  height: 1px;
  margin: 6px 2px 4px;
  background: ${LT.controlDivider};
`;

/** "More Rules...": a list row in the kit's menu language. */
export const moreRulesRow = css`
  display: flex;
  align-items: center;
  box-sizing: border-box;
  width: 100%;
  min-height: 28px;
  padding: 0 8px;
  border: none;
  border-radius: ${LT.radiusControl};
  background: ${LT.buttonBg};
  color: ${LT.text};
  font-family: ${FONT_FAMILY};
  font-size: 12px;
  text-align: left;
  cursor: pointer;

  &:hover {
    background: ${LT.menuHover};
  }

  &:focus {
    outline: none;
  }

  &:focus-visible {
    box-shadow: ${LT.focusRing};
  }
`;

// ============================================================================
// Keyboard
// ============================================================================

/** Marks a gallery option (and lets the key model find it). */
export const OPTION_ATTR = "data-cf-option";
/** On each option grid: how many columns it lays out. */
export const COLUMNS_ATTR = "data-cf-columns";
/** On the "More Rules..." row. */
export const MORE_RULES_ATTR = "data-cf-more-rules";

interface Slot {
  el: HTMLElement;
  group: number;
  index: number;
  columns: number;
}

function slotsOf(root: HTMLElement): { slots: Slot[]; groups: Slot[][]; more: HTMLElement | null } {
  const groups: Slot[][] = [];
  const slots: Slot[] = [];
  const grids = Array.from(root.querySelectorAll<HTMLElement>(`[${COLUMNS_ATTR}]`));
  grids.forEach((grid, group) => {
    const columns = Math.max(1, Number(grid.getAttribute(COLUMNS_ATTR)) || 1);
    const own = Array.from(grid.querySelectorAll<HTMLElement>(`[${OPTION_ATTR}]`)).map(
      (el, index): Slot => ({ el, group, index, columns }),
    );
    groups.push(own);
    slots.push(...own);
  });
  const more = root.querySelector<HTMLElement>(`[${MORE_RULES_ATTR}]`);
  return { slots, groups, more };
}

/**
 * Where `key` moves focus from `current` inside a gallery, or null when it
 * does not move (the key is then the host's).
 */
export function galleryKeyTarget(root: HTMLElement, current: HTMLElement, key: string): HTMLElement | null {
  const { slots, groups, more } = slotsOf(root);
  const order: HTMLElement[] = [...slots.map((s) => s.el), ...(more ? [more] : [])];
  const at = order.indexOf(current);
  if (at < 0 || order.length === 0) return null;

  switch (key) {
    case "ArrowRight":
      return at + 1 < order.length ? order[at + 1] : null;
    case "ArrowLeft":
      return at > 0 ? order[at - 1] : null;
    case "Home":
      return at > 0 ? order[0] : null;
    case "End":
      return at < order.length - 1 ? order[order.length - 1] : null;
    default:
      break;
  }

  if (key !== "ArrowDown" && key !== "ArrowUp") return null;

  if (current === more) {
    // Up from "More Rules...": the last group's last row, first column.
    if (key !== "ArrowUp") return null;
    const last = groups[groups.length - 1];
    if (!last || last.length === 0) return null;
    const cols = last[0].columns;
    const lastRowStart = Math.floor((last.length - 1) / cols) * cols;
    return last[lastRowStart].el;
  }

  const slot = slots[at];
  const group = groups[slot.group];
  const column = slot.index % slot.columns;
  if (key === "ArrowDown") {
    if (slot.index + slot.columns < group.length) return group[slot.index + slot.columns].el;
    // Last row of a group whose final row is short: step onto that row's end.
    const lastRowStart = Math.floor((group.length - 1) / slot.columns) * slot.columns;
    if (slot.index < lastRowStart) return group[group.length - 1].el;
    const next = groups[slot.group + 1];
    if (next && next.length > 0) return next[Math.min(column, next.length - 1)].el;
    return more;
  }
  // ArrowUp
  if (slot.index - slot.columns >= 0) return group[slot.index - slot.columns].el;
  const prev = groups[slot.group - 1];
  if (!prev || prev.length === 0) return null;
  const cols = prev[0].columns;
  const lastRowStart = Math.floor((prev.length - 1) / cols) * cols;
  return prev[Math.min(lastRowStart + column, prev.length - 1)].el;
}

/** The galleries' onKeyDown: move focus, and take the key only when it moved. */
export function handleGalleryKeyDown(e: React.KeyboardEvent<HTMLElement>): void {
  if (e.defaultPrevented) return;
  const target = e.target as HTMLElement;
  const next = galleryKeyTarget(e.currentTarget, target, e.key);
  if (!next) return;
  e.preventDefault();
  next.focus();
}
