// FILENAME: app/extensions/Distribution/lib/roleChipColors.ts
// PURPOSE: The glyph and colours that mean "this came from a published
//          application", in ONE place.
// CONTEXT: Two surfaces say it now — the status-bar role badge (which workbook is
//          this?) and the sheet-tab mark (which SHEET is this?). They are read
//          seconds apart by the same person, so a green ↓ on one and a blue ↑ on
//          the other would read as two different facts. Inlined hexes in two
//          components is exactly how that happens; a shared constant is what a
//          test can hold.

/** A sheet or workbook pulled from somebody else's application. Read-only to you. */
export const SUBSCRIBED_CHIP = {
  /** A down arrow: this came from somewhere else. */
  glyph: "↓",
  fg: "#137333",
  bg: "#e8f5e9",
} as const;

/** A workbook you may edit and push back. */
export const WORKING_COPY_CHIP = {
  /** A pencil: this is yours to change. */
  glyph: "✎",
  fg: "#1a56b8",
  bg: "#e8f0fe",
} as const;

/** A working copy whose workspace has moved on — the push that gets refused. */
export const WORKING_COPY_STALE_CHIP = {
  glyph: "✎",
  fg: "#a05a00",
  bg: "#fef7e0",
} as const;
