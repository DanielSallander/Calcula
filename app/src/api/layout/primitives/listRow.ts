//! FILENAME: app/src/api/layout/primitives/listRow.ts
// PURPOSE: The ONE list-row recipe of the Calcula Clusters grammar, shared by
//          Menu (command rows) and Dropdown (option rows).
// CONTEXT: A menu runs commands and a dropdown picks a value, but to the user
//          both are "a list that dropped down", and they must look like one
//          list language: a 30px row (MENU_ROW_HEIGHT), radius 6, padding 0 9,
//          gap 9, a 16px check column holding an accent tick, an optional
//          20px icon column, the label, and trailing hint/shortcut/preview.
//          The classes live in their own module (no components) so Menu.tsx
//          and Dropdown.tsx both import them and neither copies the other.
//
//          The focused row IS the current row — `:focus` paints the same wash
//          as `:hover`, and both lists move focus with the pointer — so a
//          keyboard user and a mouse user see one highlighted row, never two.
//
//          Disabled is either the native attribute (a <button> menu item) or
//          aria-disabled (a <div role="option">); both get the one disabled
//          idiom, opacity .5 and a default cursor.
//
//          Colours come only from LT (../theme).

import { css } from "@emotion/css";
import { LT } from "../theme";
import { FONT_FAMILY, FONT_MONO, MENU_ROW_HEIGHT } from "../tokens";

/** One list row: menu item or listbox option. */
export const listRowClass = css`
  display: flex;
  align-items: center;
  gap: 9px;
  box-sizing: border-box;
  width: 100%;
  height: ${MENU_ROW_HEIGHT}px;
  padding: 0 9px;
  margin: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: ${LT.text};
  cursor: pointer;
  font-family: ${FONT_FAMILY};
  font-size: 12px;
  font-weight: 400;
  line-height: 1;
  text-align: left;
  user-select: none;
  white-space: nowrap;
  transition: background-color ${LT.motionHover};

  &:hover:not(:disabled):not([aria-disabled="true"]) {
    background: ${LT.hover};
  }

  &:focus {
    outline: none;
    background: ${LT.hover};
  }

  &:focus-visible {
    outline: none;
    box-shadow: ${LT.focusRing};
  }

  &:disabled,
  &[aria-disabled="true"] {
    opacity: 0.5;
    cursor: default;
  }
`;

/** The 16px column the accent tick sits in. Always present, so labels align
 *  whether or not their row is checked. */
export const listCheckClass = css`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 16px;
  height: 16px;
  color: ${LT.stateAccent};
`;

/** Optional icon column: 20 wide, so a 16px and a 20px icon share a centre. */
export const listIconClass = css`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 20px;
`;

/** The label: takes the free width and ellipsises. */
export const listLabelClass = css`
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
`;

/** Hint / shortcut / preview, pushed to the row's end. */
export const listTrailingClass = css`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: none;
  margin-left: auto;
`;

/** Secondary trailing text ("task pane", "default"). */
export const listHintClass = css`
  font-size: 11px;
  color: ${LT.textSecondary};
`;

/** A keyboard shortcut in the mono face ("Ctrl+B"). */
export const listShortcutClass = css`
  font-family: ${FONT_MONO};
  font-size: 11px;
  color: ${LT.textSecondary};
`;
