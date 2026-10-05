//! FILENAME: app/extensions/BuiltIn/HomeTab/components/font/underline.ts
// PURPOSE: What Excel's Underline split button (CONTRACT 3.3) remembers and
//          writes: the two kinds and their rows, the kind the face applies,
//          and the toggle each part runs.
// CONTEXT: The data and rules behind UnderlineSplitButton.tsx, kept out of the
//          component file so that file exports only the component.
//
//          WHAT EXCEL DOES, measured live through COM on 2026-10-04 (a fresh,
//          never-saved, off-screen Excel 365; GetPressedMso read after the
//          ribbon settled; home-font lane report, "Excel probe"):
//          - The Underline command is pressed on a SINGLE-underlined cell and
//            not on a double one; Double Underline is the reverse. So a pressed
//            face means "the cell carries the face's kind" -- the old Home
//            button lit up for ANY underline, and on a double-underlined cell
//            a click then wrote `none` while showing a single "U" pressed.
//          - Each row TOGGLES its own kind and REPLACES the other: Underline on
//            single -> none, on double -> single; Double Underline on double ->
//            none, on single -> double. The accounting underlines count as
//            their plain kind (Underline on single accounting -> none, on
//            double accounting -> single).
//          - The face runs whichever row was chosen LAST and draws it (a "U"
//            over one or two lines); a fresh Excel's face is single. That is
//            a session value shared by every copy of the button (see
//            sessionStore.ts), never per workbook.
//          Ctrl+U is Excel's single-underline command and stays the grid's own
//          binding; it does not move the face.

import type { RibbonIconKey } from "@api";
import type { UnderlineStyle } from "@api/types";
import type { HomeTabState } from "../homeItemProps";
import { applyFontFormat } from "./fontCommand";
import { createSessionValue } from "./sessionStore";

/** The two kinds the menu offers. */
export type UnderlineKind = "single" | "double";

/** One row of Excel's Underline menu. */
export interface UnderlineRow {
  kind: UnderlineKind;
  /** Excel's words; also the action a refusal names and the undo step. */
  label: string;
  /** Test-id suffix: the row is `fmt-<itemId>-<slug>`. */
  slug: string;
  /** Its picture (CONTRACT section 7), resolved at render. */
  icon: RibbonIconKey;
}

/** Excel's two rows, in Excel's order. */
export const UNDERLINE_ROWS: readonly UnderlineRow[] = [
  { kind: "single", label: "Underline", slug: "single", icon: "Underline" },
  { kind: "double", label: "Double Underline", slug: "double", icon: "DoubleUnderline" },
];

/** The row of a kind. */
export function underlineRow(kind: UnderlineKind): UnderlineRow {
  return kind === "double" ? UNDERLINE_ROWS[1] : UNDERLINE_ROWS[0];
}

/** The kind the face applies: the row chosen last this session (Excel's
 *  default single). */
export const underlineFaceKind = createSessionValue<UnderlineKind>("single");

/** Which kind a cell's underline belongs to; null when it has none. */
export function underlineKindOf(underline: UnderlineStyle | null | undefined): UnderlineKind | null {
  switch (underline) {
    case "single":
    case "singleAccounting":
      return "single";
    case "double":
    case "doubleAccounting":
      return "double";
    default:
      return null;
  }
}

/** What running `kind` writes over `current`: its own kind toggles off, any
 *  other underline (or none) becomes `kind`. */
export function underlineTarget(current: UnderlineStyle | null | undefined, kind: UnderlineKind): UnderlineStyle {
  return underlineKindOf(current) === kind ? "none" : kind;
}

/** Run `kind` (the face, or a row) against the active cell's underline. */
export async function runUnderline(state: HomeTabState, kind: UnderlineKind): Promise<void> {
  const row = underlineRow(kind);
  await applyFontFormat(state, { underline: underlineTarget(state.currentStyle?.underline, kind) }, row.label);
}

/** A row was chosen: it becomes the face (Excel moves the face even when the
 *  click toggles the underline OFF), then runs. */
export async function chooseUnderline(state: HomeTabState, kind: UnderlineKind): Promise<void> {
  underlineFaceKind.set(kind);
  await runUnderline(state, kind);
}
