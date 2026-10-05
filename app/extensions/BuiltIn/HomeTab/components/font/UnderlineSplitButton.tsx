//! FILENAME: app/extensions/BuiltIn/HomeTab/components/font/UnderlineSplitButton.tsx
// PURPOSE: Excel's Underline split button for the Home tab's Font group
//          (CONTRACT 3.3): the face is the typographic "U" -- over one line or
//          two, whichever kind was chosen last -- and applies that kind; the
//          chevron opens Excel's two radio rows, Underline and Double
//          Underline.
// CONTEXT: Rendered for the catalog item "underline" (HomeItemProps; the
//          dispatcher in HomeTabGroupComponent looks it up by id, and the id is
//          persisted in customised layouts). What each part writes, and why the
//          face is pressed only for ITS kind, is underline.ts (measured in live
//          Excel).
//
//          The face stays a LETTER, as the old toggle and Excel's own face are:
//          B, I and U read faster than any drawing of them. The menu rows carry
//          the drawn Underline / DoubleUnderline pictures, as Excel's do.
//
//          IN THE EMPHASIS PILL. SplitMenuButton's icon face renders
//          `span.split > button.split-main + button.split-chevron`, the shape
//          Segmented already rounds and divides (the Chart Design "Elements"
//          pill of split toggles), and its menu is a portal -- nothing else is
//          added inside the pill. So the dispatcher can keep this control in
//          the B | I | U pill: give the element `data-testid="fmt-underline"`
//          (what segmentOf reads) and leave `segment: "emphasis"` on the item.
//          Pinned by underlineSplitButton.test.tsx, "inside a Segmented pill".
//
//          Same 28px control in the band and in a panel (Excel's Underline is
//          a small split in the band too, never a hero), so `band` changes
//          nothing here.

import React from "react";
import { RibbonIcon } from "@api";
import { MenuItem, SplitMenuButton } from "@api/layout";
import type { HomeItemProps } from "../homeItemProps";
import { itemTooltip } from "../itemTooltip";
import {
  UNDERLINE_ROWS,
  chooseUnderline,
  runUnderline,
  underlineFaceKind,
  underlineKindOf,
  underlineRow,
  type UnderlineKind,
} from "./underline";
import { useSessionValue } from "./sessionStore";

/** Menu row pictures are drawn on the 20px grid. */
const MENU_ICON_SIZE = 20;

/** The face's letter: the typographic U the old toggle drew (same size), its
 *  underline single or double after the remembered kind. aria-hidden: the
 *  half's own aria-label names it ("Underline" / "Double Underline"). */
function UnderlineGlyph({ kind }: { kind: UnderlineKind }): React.ReactElement {
  return (
    <span
      aria-hidden="true"
      data-underline-glyph={kind}
      style={{
        fontSize: 14,
        lineHeight: 1,
        textDecorationLine: "underline",
        textDecorationStyle: kind === "double" ? "double" : "solid",
      }}
    >
      U
    </span>
  );
}

/**
 * Excel's Underline split button. Pressed while the active cell carries the
 * FACE's kind (Excel: the single command is not pressed on a double cell).
 */
export function UnderlineSplitButton({ item, state }: HomeItemProps): React.ReactElement {
  const faceKind = useSessionValue(underlineFaceKind);
  const cellKind = underlineKindOf(state.currentStyle?.underline);
  const pressed = state.currentStyle !== null && state.currentStyle !== undefined && cellKind === faceKind;
  const face = underlineRow(faceKind);
  const menuName = item.label || UNDERLINE_ROWS[0].label;

  // The catalog's tooltip ("Underline (Ctrl+U)") describes the SINGLE face --
  // Ctrl+U is single underline. A double face says what it does and claims no
  // shortcut it does not have.
  const tip = itemTooltip(item);
  const single = faceKind === "single";

  return (
    <SplitMenuButton
      face="icon"
      icon={<UnderlineGlyph kind={faceKind} />}
      label={face.label}
      pressed={pressed}
      tooltip={single ? tip.tooltip || face.label : face.label}
      shortcut={single ? tip.shortcut : undefined}
      commandId={single ? tip.commandId : undefined}
      data-testid={`fmt-${item.id}`}
      data-active={pressed || undefined}
      chevronTestId={`fmt-${item.id}-options`}
      chevronLabel={`${menuName} options`}
      menuLabel={menuName}
      onClick={() => void runUnderline(state, faceKind)}
    >
      {UNDERLINE_ROWS.map((row) => (
        <MenuItem
          key={row.kind}
          role="menuitemradio"
          checked={cellKind === row.kind}
          icon={React.createElement(RibbonIcon[row.icon], { size: MENU_ICON_SIZE })}
          testId={`fmt-${item.id}-${row.slug}`}
          onSelect={() => void chooseUnderline(state, row.kind)}
        >
          {row.label}
        </MenuItem>
      ))}
    </SplitMenuButton>
  );
}
