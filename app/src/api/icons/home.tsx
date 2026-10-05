//! FILENAME: app/src/api/icons/home.tsx
// PURPOSE: The Home tab's glyphs: the 34 FROZEN keys redrawn in place on the
//          24-unit duotone grid, plus the Home extras (Superscript, Subscript,
//          FontColor, Replace, and Excel's Merge menu: MergeCenter, MergeAcross,
//          UnmergeCells beside the frozen MergeCells), plus the 60 keys of
//          Excel's Home tab (2026-10-04: the Paste options, Underline and
//          Borders menus, Orientation, Accounting, Conditional Formatting, Format
//          as Table, the Insert / Delete / Format cells menus, AutoSum, Fill,
//          Clear, Sort & Filter, Go To, and ObjectAlignTop/Middle/Bottom for the
//          Canvas Arrange menu), plus ObjectAlignLeft/Center/Right, added by
//          the same day's icon review so that menu's six rows all draw objects.
// CONTEXT: The 34 keys (Cut ... ClearAll) are frozen because they are a
//          contract, not a style: homeTabIcons.tsx maps persisted Home-tab item
//          ids onto them, GROUP_ICON_IDS lists them in the customize dialog,
//          and sandboxed add-ins name them as icon TOKENS through
//          AddInsRibbonSection (`keyof typeof RibbonIcon`). A key may be
//          redrawn; it may never be renamed or removed.
//
//          Most drawings are the approved mockup's (Home.dc.html) converted
//          verbatim. Three were corrected rather than copied, because the
//          correction is geometry, not taste:
//          - AlignLeft/Center/Right: the mockup's four rows ran 3.8..23.8, so
//            the glyph sat 1.8 units low (1.5px at the 20px control size).
//            Shifted up to 2..22, centred on the grid (2.4..21.6 since the
//            2026-09-24 pixel-grid pass, see horizontalAlign).
//          - WrapText: the return arrow's round cap reached y = 24.5 and was
//            clipped by the viewBox. Shifted up 2 units. (Redrawn again on
//            2026-10-04 as Excel's "ab / c" picture; see WrapText.)
//          - IndentIncrease/Decrease: the rows sat one unit above the arrow
//            they are indented from; the rows moved down so the arrow points
//            at the middle row.
//
//          Percent, Comma, NumberFormat and the two Decimal glyphs had no
//          mockup drawing and were typographic (<text>) before. <text> is
//          banned in the set (it renders in whatever font the machine has), so
//          they are drawn as paths in the same language. The Home band keeps
//          these five TYPOGRAPHIC in its own buttons (the approved plan: "%",
//          "," ".0" read like "B"); these drawings are for every surface that
//          needs a picture — the customize dialog, menus, add-in tokens.
//
//          Excel's Home tab (2026-10-04). The owner asked for Excel's Home tab
//          "with Excel's look in our style", so the new keys, and nine frozen
//          keys redrawn in place (AlignTop, AlignMiddle, AlignBottom, WrapText,
//          FillColor, InsertRow, InsertColumn, DeleteRow, DeleteColumn), follow
//          the metaphor of Excel 365's own pictures, captured from a live
//          Excel: what is shown, where, and which way it points. Microsoft's
//          artwork is not copied. Excel's grey lines become STRONG or SOFT, its
//          one blue element ACCENT, its red DANGER; every accent keeps 1.2 of
//          background from the greys (`npm run check:icon-contact` measures 0
//          for all sixty). Pictures that share a menu are held apart by SHAPE
//          (ribbonIcons.test.tsx "menu families").
//
//          Two reviews checked the sixty-nine pictures the same day, one for
//          Excel fidelity and one for 20px legibility. Where they disagreed
//          the 20px pixel map decided (docs/design/ICONS.md 2.3, "20px
//          wins"): the 45-degree Orientation words stand upright, Paste
//          Formulas' x and Paste Transpose's arrow are on whole pixels, Paste
//          Link's links meet end to end, Delete Cells' point is short, Go To's
//          cell is taller and Remove Hyperlinks is Excel's chain with a corner
//          X. Each drawing's comment records what it replaced and why.

import React from "react";
import {
  IconFrame,
  SOFT,
  STRONG,
  ACCENT,
  DANGER,
  PIXEL_STROKE,
  line,
  type RibbonIconProps,
} from "./frame";
import { Search } from "./generic";

// ============================================================================
// Clipboard
// ============================================================================

/** Cut: two soft blades, the accent handle is the one doing the cutting.
 *  The blades are ONE stroked path: a stroke paints its self-crossing once,
 *  where two translucent SOFT shapes would paint the pivot twice (a dark knot
 *  at the 50% tint). They stop 1.2 units (one clean pixel at 20px) short of
 *  BOTH handles, so the green handle borders only the background: green
 *  against the grey is under 2:1 in every skin (docs/design/ICONS.md 2.2). */
function Cut({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M7.83 3.87L14.07 14.71M16.17 3.87L9.93 14.71" {...line(SOFT, 3.2)} />
      <circle cx="5.8" cy="19.2" r="3.3" fill={ACCENT} />
      <circle cx="18.2" cy="19.2" r="3.3" fill={STRONG} />
    </IconFrame>
  );
}

/** Copy: a soft original behind its strong copy. Both sheets are 13.2 x 16.8
 *  with every edge on the pixel grid (a multiple of 1.2), the copy offset 6
 *  right and 2.4 down, so no edge paints as a grey half-pixel at 20px. */
function Copy({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="13.2" height="16.8" rx="3.2" fill={SOFT} />
      <rect x="8.4" y="4.8" width="13.2" height="16.8" rx="3.2" fill={STRONG} />
    </IconFrame>
  );
}

/** Paste: a soft board, strong content, the accent clip. The clip sits in a
 *  U-notch cut into the top of the board, 1.2 units clear on three sides with
 *  every edge on the 1.2 pixel grid, so the green borders only the background
 *  (on the board it was 1.5:1 against the grey, the owner's 2026-09-24 report).
 *  The board ends at 21.6 and the two content rows are 3.6 tall (3 px) on
 *  whole pixels, 2.4 apart and 2.4 from the notch and the board's foot. */
function Paste({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M2.4 6a2.8 2.8 0 0 1 2.8-2.8H5.4a0.6 0.6 0 0 1 0.6 0.6a3.4 3.4 0 0 0 3.4 3.4H14.6a3.4 3.4 0 0 0 3.4-3.4a0.6 0.6 0 0 1 0.6-0.6H18.8a2.8 2.8 0 0 1 2.8 2.8V18.8a2.8 2.8 0 0 1-2.8 2.8H5.2a2.8 2.8 0 0 1-2.8-2.8z"
        fill={SOFT}
      />
      <rect x="7.2" y="9.6" width="9.6" height="3.6" rx="1.8" fill={STRONG} />
      <rect x="7.2" y="15.6" width="9.6" height="3.6" rx="1.8" fill={STRONG} />
      <rect x="7.2" y="1.2" width="9.6" height="4.8" rx="2.2" fill={ACCENT} />
    </IconFrame>
  );
}

/**
 * Format Painter: a paint roller laying down a stroke of the copied format.
 *
 * The owner's drawing (icons/format-painter.svg, 64x64, 2026-09-24): a dark
 * roller tilted 31 degrees at the top right, a grey wire frame leaving its right
 * end and running back under it, a dark handle, and a green swatch under the
 * handle. Channels follow the owner's colours: roller and handle STRONG, the
 * wire SOFT (drawn first, so the opaque shapes cover its ends), the swatch
 * ACCENT (the format being applied).
 *
 * Departures from the owner's file, each forced by the 20px ribbon size:
 * - the wire is 3.0 units instead of 0.64 (a 0.64 line is a quarter pixel), so
 *   it sits further out: exactly 1.2 units (one clean pixel at 20px) clear of
 *   the roller's end, with its run's top edge on a whole pixel row. Its leg
 *   passes over the top of the handle rather than dropping into it (no height
 *   is left for the owner's drop), and the run ends where the handle hides its
 *   square corner. The wire stays the owner's grey: it reads as a separate
 *   part only because SOFT is 50% (3.3:1 on the cluster); at the old 30% it
 *   was 1.9:1 and the roller looked detached from the handle;
 * - the drawing is 1.075x the first conversion, nearly centred (margins
 *   L 2.4 / T 1.45 / R 1.9 / B 1.2), and the swatch sits on whole pixels
 *   (8 x 3 px, the owner's width rounded) one clean pixel row below the
 *   handle, so handle and stroke never fuse in Light or Dark;
 * - corners are the set's 1.4 minimum rather than the owner's 1.1-1.2.
 */
function FormatPainter({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M17.27 8.4L20.61 10.41L18.76 13.5L9.7 13.5" {...line(SOFT, 3)} />
      <rect x="7.12" y="3.72" width="12.04" height="4.41" rx="1.4" fill={STRONG} transform="rotate(31 13.14 5.92)" />
      <path
        d="M7.38 13.03Q7.81 11.79 8.76 11.94L10.48 12.67Q11.17 13.03 10.91 13.69C10.56 14.35 9.53 14.93 9.19 16.02C8.93 16.83 8.63 17.48 8.11 18L4.2 18C4.42 17.19 4.97 16.2 5.79 15.29C6.69 14.27 7.12 13.72 7.38 13.03Z"
        fill={STRONG}
      />
      <rect x="2.4" y="19.2" width="9.6" height="3.6" rx="1.4" fill={ACCENT} />
    </IconFrame>
  );
}

// Paste options: Excel's Paste split button and its menu (2026-10-04).
//
// Excel draws every paste option the same way: the clipboard at the back left,
// and in front of it, bottom right, a small sheet carrying WHAT the option
// pastes (fx, %fx, a brush, a dotted grid, a width bar, a transpose arrow, 123,
// %123, 123 with a brush, % with a brush, a chain). The twelve keys keep that
// composition and that vocabulary in the duotone language:
// - the board is SOFT, Paste's board cut back to an L (a full board plus a
//   badge does not fit at 20px), and the clip STRONG, laid on its top edge
//   (STRONG over SOFT, never the reverse);
// - the badge is the ACCENT and stands on the BACKGROUND, never on the board,
//   in two places: the bottom slot (7.2..21.6 x 12..21.6, 12 x 8 px, 1.2 clear
//   of the board on both sides of the cut: Paste's notch) and the free corner
//   (13.2..21.6 x 2.4..10.8, 7 x 7 px), which holds the QUALIFIER of a compound
//   option (% = number formatting, a small brush = source formatting), because
//   Excel's "%fx" written side by side does not fit with 2.6 strokes;
// - the clip is STRONG here while Paste's is ACCENT: one accent per icon, and
//   in a column of twelve options the coloured part must be the part that tells
//   them apart, not the clip they all share.
// The four compound options draw their badge as two green glyphs (fx with %,
// 123 with %, 123 with a brush, % with a brush): one concept, "what the paste
// brings", the way Unmerge Cells' four green cells are one cut row.
// Excel's own paste-option artwork was not captured (the probe ran with an
// empty clipboard, which shows only Paste); the vocabulary is Excel's gallery.

/** Paste's board cut back to an L: outer 2.4..12 x 3.6..21.6 (8 x 15 px),
 *  outer corners 2.4, the top band 3.6..10.8 (6 px) and the left edge 2.4..6
 *  (3 px); the band's end, the edge's foot and the inside corner take 1.2, so
 *  the L has no sharp corner. ONE path, so the SOFT never overlaps itself. */
const PASTE_BOARD =
  "M4.8 3.6H9.6A2.4 2.4 0 0 1 12 6V9.6A1.2 1.2 0 0 1 10.8 10.8H7.2A1.2 1.2 0 0 0 6 12V20.4A1.2 1.2 0 0 1 4.8 21.6A2.4 2.4 0 0 1 2.4 19.2V6A2.4 2.4 0 0 1 4.8 3.6Z";

/** The board and its clip, shared by all twelve options so they cannot drift
 *  apart (the mergeGridRow precedent). The clip is a STRONG pill 7.2 x 3.6
 *  (6 x 3 px) centred on the board and reaching y 1.2, as Paste's clip does. */
function pasteBoard(): React.ReactElement {
  return (
    <>
      <path d={PASTE_BOARD} fill={SOFT} />
      <rect x="3.6" y="1.2" width="7.2" height="3.6" rx="1.8" fill={STRONG} />
    </>
  );
}

/** "fx" in the bottom slot, FILLED on whole pixels. The f: stem 9.6..12 x
 *  14.4..21.6, its hook 12..14.4 x 12..14.4 turning out of a 2.4 radius, the
 *  crossbar 7.2..13.2 x 15.6..18 (both subpaths clockwise, so they union). The
 *  x: a whole-pixel staircase 14.4..21.6 x 15.6..21.6 (6 x 5 px) with 2 px arms
 *  -- rows of 2 + 2, 4, 2, 4 and 2 + 2 px -- its top level with the crossbar,
 *  one clean pixel column right of it. Two 2.6 diagonals in that box (the
 *  first drawing) painted a solid 6 x 6 px star with 12 half-covered accent
 *  pixels; the staircase has one (2026-10-04 icon review). An italic f (the Fx
 *  key's) smeared at 20px. */
function pasteFx(): React.ReactElement {
  return (
    <>
      <path d="M9.6 21.6V14.4A2.4 2.4 0 0 1 12 12H14.4V14.4H12V21.6ZM7.2 15.6H13.2V18H7.2Z" fill={ACCENT} />
      <path
        d="M14.4 15.6H16.8V16.8H19.2V15.6H21.6V16.8H20.4V18H19.2V19.2H20.4V20.4H21.6V21.6H19.2V20.4H16.8V21.6H14.4V20.4H15.6V19.2H16.8V18H15.6V16.8H14.4Z"
        fill={ACCENT}
      />
    </>
  );
}

/** "123" in the bottom slot as ONE PIXEL_STROKE path of horizontal and
 *  vertical runs on the grid: the 1 a 2 px bar, the 2 and the 3 4 px wide with
 *  1 px counters, 1 px between digits (ink 7.2..21.6 x 12..21.6). */
const PASTE_DIGITS = "M8.4 13.2V20.4M12 13.2H14.4V16.8H12V20.4H14.4M18 13.2H20.4V20.4H18M18 16.8H20.4";

/** The qualifier "with number formatting": a % in the free corner. Two 2.4
 *  square dots (2 x 2 px) in opposite corners of the 8.4 box and a 2.6 slash on
 *  x + y = 24, 1.25 clear of each dot and 1.3 of the board. Round dots this
 *  small sat under a unit from the slash and the % painted as an X. The dots
 *  are SQUARE (rx 0), the Borders family's 2 px mark: at rx 0.6 every one
 *  painted as a plus sign at 150% (2026-10-04 icon review; at 100% the two
 *  are pixel-identical). */
function pasteCornerPercent(): React.ReactElement {
  return (
    <>
      <rect x="13.2" y="2.4" width="2.4" height="2.4" rx="0" fill={ACCENT} />
      <rect x="19.2" y="8.4" width="2.4" height="2.4" rx="0" fill={ACCENT} />
      <path d="M20.2 3.8L14.6 9.4" {...line(ACCENT, 2.6)} />
    </>
  );
}

/** The qualifier "with the source formatting": a small brush filling the free
 *  corner (13.2..21.2 x 2.8..10.8) on the diagonal x + y = 24, handle (2.4
 *  long) running into 4.8-wide bristles. One colour: a two-channel brush this
 *  small painted as two separate dots at 20px. */
function pasteCornerBrush(): React.ReactElement {
  return (
    <>
      <path d="M18.19 5.81L19.89 4.11" {...line(ACCENT, 2.6)} />
      <path
        d="M16 4.6L19.4 8L17.68 9.72C16.34 11.05 14.73 10.97 13.88 10.12C13.03 9.27 12.95 7.66 14.28 6.32Z"
        fill={ACCENT}
      />
    </>
  );
}

/** Formulas: "fx". */
function PasteFormulas({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {pasteBoard()}
      {pasteFx()}
    </IconFrame>
  );
}

/** Formulas & Number Formatting: Excel's "%fx", the % moved to the corner. */
function PasteFormulasNumberFormats({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {pasteBoard()}
      {pasteCornerPercent()}
      {pasteFx()}
    </IconFrame>
  );
}

/**
 * Keep Source Formatting: Excel's brush, bristles down-left, on the diagonal
 * x + y = 28.8 -- the one that keeps a 5.4-wide head clear of the board's
 * corner. Two channels so it reads as a brush and not a green spatula: the
 * bristles (5.4 x 7.8) ACCENT, the paint being kept; the handle a STRONG 2.6
 * line starting 1.2 past them (the ferrule gap), its cap ending at x 21.6.
 */
function PasteKeepSourceFormatting({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {pasteBoard()}
      <path d="M16.77 12.03L20.3 8.5" {...line(STRONG, 2.6)} />
      <path
        d="M13.09 11.89L16.91 15.71L14.43 18.19C12.5 20.12 10.44 20.27 9.48 19.32C8.53 18.36 8.68 16.3 10.61 14.37Z"
        fill={ACCENT}
      />
    </IconFrame>
  );
}

/** The dotted frame of No Borders: ten 2.4 square dots (rx 0, the Borders
 *  family's dot) on a 3.6 pitch round 8.4..21.6 x 12..21.6, perimeter only (a
 *  full matrix read as a keypad). */
const PASTE_NO_BORDER_DOTS: ReadonlyArray<readonly [number, number]> = [
  [8.4, 12], [8.4, 15.6], [8.4, 19.2], [12, 12], [12, 19.2],
  [15.6, 12], [15.6, 19.2], [19.2, 12], [19.2, 15.6], [19.2, 19.2],
];

/** No Borders: a sheet whose border is not drawn -- the frame in dots, the
 *  Borders menu's "no border" look. */
function PasteNoBorders({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {pasteBoard()}
      {PASTE_NO_BORDER_DOTS.map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width="2.4" height="2.4" rx="0" fill={ACCENT} />
      ))}
    </IconFrame>
  );
}

/** Keep Source Column Widths: Excel's measuring bar |-| (the face of its
 *  Format menu and its Column Width row), ONE path with square corners on the
 *  grid: ticks 7.2..9.6 and 19.2..21.6 x 13.2..20.4 (2 x 6 px), the bar
 *  between them 15.6..18. No arrowheads: in 7.2 units they painted a blob;
 *  9.6 ticks read as the letter H. */
function PasteColumnWidths({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {pasteBoard()}
      <path d="M7.2 13.2H9.6V15.6H19.2V13.2H21.6V20.4H19.2V18H9.6V20.4H7.2Z" fill={ACCENT} />
    </IconFrame>
  );
}

/**
 * Transpose: rows become columns. The row (13.2..21.6 x 3.6..6, in the corner)
 * and the column (7.2..9.6 x 12..21.6, in the slot) with an elbow arrow from
 * the one to the other: all ACCENT, one concept, the turned data. STRONG bars
 * joined the clip into one dark band; the arrow alone read as "rotate".
 *
 * The elbow is a PIXEL_STROKE on whole pixels: down the column 18 from a round
 * end 1.2 under the row, then left along the row 15.6 into a head whose base
 * is the column 14.4 (12..19.2, 6 px) and whose tip (10.8, 15.6) stands 1.2
 * from the column bar; the board's rounded band end is 3 units from the head.
 * Until the 2026-10-04 icon review it was a double-headed quarter arc (a 2.6
 * stroke): 24 half-covered accent pixels, the most of any paste option, and it
 * read as a hook; the elbow has 17. One head: the turn goes one way, row to
 * column.
 */
function PasteTranspose({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {pasteBoard()}
      <rect x="13.2" y="3.6" width="8.4" height="2.4" rx="1.2" fill={ACCENT} />
      <rect x="7.2" y="12" width="2.4" height="9.6" rx="1.2" fill={ACCENT} />
      <path d="M18 8.4V15.6H14.4" {...line(ACCENT, PIXEL_STROKE)} />
      <path d="M14.4 12V19.2L10.8 15.6Z" fill={ACCENT} />
    </IconFrame>
  );
}

/** Values: Excel's "123". */
function PasteValues({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {pasteBoard()}
      <path d={PASTE_DIGITS} {...line(ACCENT, PIXEL_STROKE)} />
    </IconFrame>
  );
}

/** Values & Number Formatting: Excel's "%123", the % in the corner, 1.2 above
 *  the digits. */
function PasteValuesNumberFormats({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {pasteBoard()}
      {pasteCornerPercent()}
      <path d={PASTE_DIGITS} {...line(ACCENT, PIXEL_STROKE)} />
    </IconFrame>
  );
}

/** Values & Source Formatting: "123" with the corner brush. Its nearest
 *  neighbour is Values & Number Formatting: a fat blob on a short handle vs a
 *  thin slash between two dots. */
function PasteValuesSourceFormatting({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {pasteBoard()}
      {pasteCornerBrush()}
      <path d={PASTE_DIGITS} {...line(ACCENT, PIXEL_STROKE)} />
    </IconFrame>
  );
}

/** Formatting: Excel's "%" with a brush (formats only). The corner brush over
 *  a % in the slot: 2.4 square dots (rx 0, as pasteCornerPercent's) at the
 *  corners of a 9.6 box centred in it and a 2.6 slash on x + y = 31.2, 2.1
 *  clear of each dot -- the family's one %, so round dots (an X at 20px) are
 *  not used here either. */
function PasteFormatting({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {pasteBoard()}
      {pasteCornerBrush()}
      <rect x="9.6" y="12" width="2.4" height="2.4" rx="0" fill={ACCENT} />
      <rect x="16.8" y="19.2" width="2.4" height="2.4" rx="0" fill={ACCENT} />
      <path d="M17.9 13.3L10.9 20.3" {...line(ACCENT, 2.6)} />
    </IconFrame>
  );
}

/** Paste Link: the generic Link key's two links at 0.75 scale (radius 2.48),
 *  written out (no scale transform) as one 2.6 stroked path of two capsules on
 *  the diagonal x + y = 30, meeting END TO END at (15, 15); that diagonal keeps
 *  the outer edge 1.5 from the board's corner, and the ink ends at 22.0. Link's
 *  own interlock (each link through the other's hole) was the first drawing:
 *  at this size it left each hole one clean pixel and the chain painted as a
 *  solid capsule. Meeting end to end, the holes keep 4 and 6 (2026-10-04 icon
 *  review); Remove Hyperlinks draws the same chain larger. */
function PasteLink({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {pasteBoard()}
      <path
        d="M10.08 16.41L11.49 15A2.48 2.48 0 0 1 15 18.51L13.59 19.92A2.48 2.48 0 0 1 10.08 16.41ZM15 11.49L16.41 10.08A2.48 2.48 0 0 1 19.92 13.59L18.51 15A2.48 2.48 0 0 1 15 11.49Z"
        {...line(ACCENT, 2.6)}
      />
    </IconFrame>
  );
}

/** Paste Special...: Excel's row has no picture; the key needs one. An
 *  ellipsis, the label's own "..." (the row opens a dialog): three 3.6 squares
 *  (3 px, rx 0.9, the 3 px cell rule) 1.2 apart on the slot's baseline row. A
 *  gear says "settings", a mini dialog is FormatCells. */
function PasteSpecial({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {pasteBoard()}
      <rect x="8.4" y="15.6" width="3.6" height="3.6" rx="0.9" fill={ACCENT} />
      <rect x="13.2" y="15.6" width="3.6" height="3.6" rx="0.9" fill={ACCENT} />
      <rect x="18" y="15.6" width="3.6" height="3.6" rx="0.9" fill={ACCENT} />
    </IconFrame>
  );
}

// ============================================================================
// Font
// ============================================================================

/** The A that Grow Font and Shrink Font share: tall (18.9 units with its
 *  caps, its flat top edge on the pixel row at 2.4) and narrow, so the arrow
 *  beside it keeps a 1.2-unit margin to the frame. The first drawing was 23.3
 *  units wide, its arrow ran to the frame edge (touching the segmented pill's
 *  divider), and Shrink's arrowhead fused with the A's right foot. The bar is
 *  a PIXEL_STROKE on the row at 14.4: two whole pixels at 20px. */
const LETTER_A = "M3.6 19.8L7.2 3.9h2.4L13.2 19.8";
const LETTER_A_BAR = "M5.4 14.4h6";

/** Grow Font: a strong A, the accent arrow is the verb. The arrowhead is a
 *  solid wedge: a stroked chevron narrow enough to fit beside the A painted
 *  as a blob at 20px. The shaft is a PIXEL_STROKE centred on x = 19.2 and the
 *  wedge's base sits on a pixel row, so the arrow has no soft edge at 20px
 *  (the 2.8 shaft covered 2 1/3 pixels, the owner's "slightly fuzzy"). */
function FontSizeUp({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d={LETTER_A} {...line(STRONG)} />
      <path d={LETTER_A_BAR} {...line(STRONG, PIXEL_STROKE)} />
      <path d="M19.2 19.8V7.2" {...line(ACCENT, PIXEL_STROKE)} />
      <path d="M15.6 7.2L19.2 2.4L22.8 7.2Z" fill={ACCENT} />
    </IconFrame>
  );
}

/** Shrink Font: FontSizeUp with the arrow turned down (mirrored about y = 12). */
function FontSizeDown({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d={LETTER_A} {...line(STRONG)} />
      <path d={LETTER_A_BAR} {...line(STRONG, PIXEL_STROKE)} />
      <path d="M19.2 4.2V16.8" {...line(ACCENT, PIXEL_STROKE)} />
      <path d="M15.6 16.8H22.8L19.2 21.6Z" fill={ACCENT} />
    </IconFrame>
  );
}

/** Font Color: the strong A alone. The colour itself is the 4px data bar the
 *  host control paints under the icon (ColorSwatch variant="bar"), so the
 *  glyph carries no accent that could be mistaken for the chosen colour. Its
 *  flat top edge is on the pixel row at 2.4 and the bar is a PIXEL_STROKE. */
function FontColor({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M4 19.6L10.4 4h3.2L20 19.6" {...line(STRONG, 3.2)} />
      <path d="M7.6 14.4h8.8" {...line(STRONG, PIXEL_STROKE)} />
    </IconFrame>
  );
}

/**
 * Fill Color: Excel's picture -- an outline paint bucket tipped 45 degrees with
 * its mouth up-right, a narrow loop handle on its top corner, and paint pouring
 * over the lip down the right side. The chosen colour is the host's 4px data
 * bar (ColorSwatch variant="bar"), so the glyph carries no accent that could be
 * taken for it: the bucket and handle are STRONG, the pour SOFT (a second
 * material, as Excel draws its pour in a colour of its own). Excel's pour is
 * blue; a green one here would read as the chosen colour beside the bar (and
 * it touches the lip: 6.5 units of contact).
 *
 * - Bucket: three sides of a square tilted 45 degrees (T 10.8,6 / L 4.2,12.6 /
 *   B 10.8,19.2 / R 17.4,12.6), a 2.6 stroke, every vertex on the 0.6 lattice;
 *   the mouth T-R stays OPEN, which is what makes it a bucket and not a
 *   diamond. Its foot reaches 20.5: the bar's top edge lands on 21.6 (icon
 *   pixel row 18, measured in a mock of ColorSwatch's real structure), one
 *   clean row below.
 * - Handle: FILLED, not stroked, so its legs sit on whole pixels (9.6..12 and
 *   13.2..15.6) round a 1.2 slot with a round top -- the narrow loop still
 *   shows at 20px; outer arch r 3, its top on the row 2.4. A stroked arch (2.6)
 *   smeared the slot shut; a square PIXEL_STROKE loop read as a tab. The left
 *   foot hides under the bucket's round cap at T; the right leg ends on the
 *   mouth line, 1.7 clear of the far wall (deeper, the bucket read as a bag).
 * - Pour: leaves the mouth under the lip's stroke (SOFT under STRONG), crests
 *   on the row 8.4 and runs down a 2.4 column (19.2..21.6) to a round end on
 *   the row 19.2. Excel's tapered tail faded out at 20px in SOFT, so the
 *   column keeps its width.
 *
 * Redrawn 2026-10-04 when the owner asked for Excel's look. The previous
 * drawing (a soft diamond and a strong drop, Material's metaphor) reached
 * y 23.0, under the bar.
 */
function FillColor({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M16.2 12C16.8 9.9 18.3 8.4 19.8 8.4C21 8.4 21.6 9.6 21.6 10.8V18A1.2 1.2 0 0 1 19.2 18V13.2C19.2 12.2 18.6 11.4 17.4 11.4Z"
        fill={SOFT}
      />
      <path d="M10.8 6L4.2 12.6L10.8 19.2L17.4 12.6" {...line(STRONG, 2.6)} />
      <path d="M9.6 6V5.4A3 3 0 0 1 15.6 5.4V9.6A1.2 1.2 0 0 1 13.2 9.6V5.4A0.6 0.6 0 0 0 12 5.4V6Z" fill={STRONG} />
    </IconFrame>
  );
}

/** The letter U of the Underline menu, FILLED rather than stroked so its
 *  stems are 2.4 wide (2 px) with every straight edge on the grid (outer 6 /
 *  18, inner 8.4 / 15.6); a curved stroke would be 2.6 and soft on both sides
 *  (the Replace elbow is the precedent for a filled 2 px band with a curve).
 *  The bowl is an outer radius 6 / inner 3.6 annulus; the stem tops are flat
 *  on the row 2.4, like a typeface's U and like LETTER_A's top. STRONG: the
 *  letter is the subject; the line the command adds is the ACCENT. */
const LETTER_U = "M6 2.4V10.8A6 6 0 0 0 18 10.8V2.4H15.6V10.8A3.6 3.6 0 0 1 8.4 10.8V2.4Z";
/** The same U 1.2 shorter (bottom 15.6), to leave room for two bars. */
const LETTER_U_SHORT = "M6 2.4V9.6A6 6 0 0 0 18 9.6V2.4H15.6V9.6A3.6 3.6 0 0 1 8.4 9.6V2.4Z";

/** Underline (the Underline split's first row; the face stays the letter):
 *  the U (6..18 x 2.4..16.8, 10 x 12 px) with one ACCENT bar 2.4 below it,
 *  3.6..20.4 x 19.2..21.6 -- wider than the letter, as Excel's is. The gap is
 *  a sixth of the letter's height, Excel's proportion. */
function Underline({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d={LETTER_U} fill={STRONG} />
      <path d="M4.8 20.4H19.2" {...line(ACCENT, PIXEL_STROKE)} />
    </IconFrame>
  );
}

/** Double Underline: the shorter U over two bars 1.2 apart (16.8..19.2 and
 *  20.4..22.8). Recorded departure from the fill rule: the ink runs to 22.8,
 *  so it sits 0.6 low and 1.2 from the frame edge, both exactly at the rule's
 *  limits, with a 20.4 long side; bars on Underline's baseline left a squat U
 *  jammed onto them, and a narrower U looked like a different letter. Excel's
 *  row shows a "D"; the same U in both rows makes "one line or two" the only
 *  difference, which is the meaning. */
function DoubleUnderline({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d={LETTER_U_SHORT} fill={STRONG} />
      <path d="M4.8 18H19.2M4.8 21.6H19.2" {...line(ACCENT, PIXEL_STROKE)} />
    </IconFrame>
  );
}

// Borders: Excel's Borders split button and its menu (2026-10-04).
//
// Excel's metaphor, every Excel since 2007: a 2 x 2 cell figure (an outer
// square and a centre cross) drawn in DOTTED lines, the edges the command draws
// SOLID. A solid edge takes the place of the dotted line it replaces, a thick
// edge is twice as thick and grows INWARD, a double edge is two thin lines with
// the dotted figure ending above them. Translated: the dotted lines are SOFT
// 2 x 2 px dots, the drawn edges ACCENT ("the edges this command draws" is the
// icon's one accent concept; Excel draws them in its dots' grey). No Border has
// no accent. The thirteen presets differ by SHAPE, so they also differ in
// grayscale-disabled, high contrast and for a colour-blind reader: thin / thick
// / double by bar thickness (2 / 4 / 2+1+2 px), which edges by position, None /
// All / Outside by dotted vs solid.
//
// Two recorded exceptions to ICONS.md 2.3:
// - the dots are SQUARE (rx 0): a 2 px mark with any radius paints as a plus
//   sign at 150% (rx 0.6 and 1.2 rendered), and rx 0.6 leaves stray
//   antialiased pixels at 100%. Excel's dots are square pixels too;
// - they are 2.4 units, under the 3.6 part and 4.3 free-standing-dot floors:
//   not parts but the texture of a dotted line. A faint SOLID soft grid made
//   No Border vs All Borders a colour-only difference.

/** Where the dots start along every line of the figure, the same both ways
 *  (px 2, 6, 9, 12, 16 at 20px). Indexes 0 / 2 / 4 are the three LINES (outer,
 *  centre, outer), 1 and 3 the dots between them. The figure spans 2.4..21.6
 *  both ways (16 px). A 16 px figure cannot hold 2 px dots on an even pitch
 *  with a dot on the centre crossing, so the gaps run 2, 1, 1, 2 px, tightening
 *  toward the crossing as Excel's own dots do. The centre line (10.8..13.2)
 *  cannot be whole pixels at 150%; no centred 2 px line can. */
const BORDER_DOT = [2.4, 7.2, 10.8, 14.4, 19.2] as const;

/** An accent edge's box [x, y, width, height], for the dot clearance. */
type BorderEdgeBox = readonly [x: number, y: number, width: number, height: number];

/** The thin edges (a PIXEL_STROKE on the outer line's centre, covering the dot
 *  line it replaces, round caps: a full pill), the thick bottom (4.8, twice the
 *  thin edge as Excel's is; 3.6 could not be told from thin at a glance) and
 *  the double bottom (two thin edges with a 1.2 gap). */
const BORDER_EDGE = {
  top: [2.4, 2.4, 19.2, 2.4],
  bottom: [2.4, 19.2, 19.2, 2.4],
  left: [2.4, 2.4, 2.4, 19.2],
  right: [19.2, 2.4, 2.4, 19.2],
  thickBottom: [2.4, 16.8, 19.2, 4.8],
  doubleBottom: [2.4, 15.6, 19.2, 6],
} as const satisfies Record<string, BorderEdgeBox>;

/** The thin and the thick outside frame, as four boxes each. */
const BORDER_FRAME: readonly BorderEdgeBox[] = [
  BORDER_EDGE.top, BORDER_EDGE.bottom, BORDER_EDGE.left, BORDER_EDGE.right,
];
const BORDER_THICK_FRAME: readonly BorderEdgeBox[] = [
  [2.4, 2.4, 19.2, 4.8], [2.4, 16.8, 19.2, 4.8], [2.4, 2.4, 4.8, 19.2], [16.8, 2.4, 4.8, 19.2],
];

/** True when a 2.4 dot at (x, y) keeps 1.2 of background from an edge box. */
function borderDotClear(x: number, y: number, [bx, by, bw, bh]: BorderEdgeBox): boolean {
  const EPS = 1e-6;
  return (
    x + 2.4 + 1.2 <= bx + EPS ||
    bx + bw + 1.2 <= x + EPS ||
    y + 2.4 + 1.2 <= by + EPS ||
    by + bh + 1.2 <= y + EPS
  );
}

/** The un-bordered lines: the 21 lattice dots (the three rows of five, and
 *  the two dots between them on each of the three columns), minus every dot
 *  that would come closer than 1.2 to a drawn edge. The accent keeps one clean
 *  pixel of background from the grey by construction, not by hand. */
function borderDots(edges: readonly BorderEdgeBox[]): React.ReactElement[] {
  const lines = [BORDER_DOT[0], BORDER_DOT[2], BORDER_DOT[4]];
  const dots: Array<readonly [number, number]> = [
    ...lines.flatMap((y) => BORDER_DOT.map((x) => [x, y] as const)),
    ...lines.flatMap((x) => [BORDER_DOT[1], BORDER_DOT[3]].map((y) => [x, y] as const)),
  ];
  return dots
    .filter(([x, y]) => edges.every((edge) => borderDotClear(x, y, edge)))
    .map(([x, y]) => <rect key={`${x}-${y}`} x={x} y={y} width="2.4" height="2.4" rx="0" fill={SOFT} />);
}

/** The thin edge drawings, one PIXEL_STROKE path each on the outer line. */
function borderTopEdge(): React.ReactElement {
  return <path d="M3.6 3.6H20.4" {...line(ACCENT, PIXEL_STROKE)} />;
}
function borderBottomEdge(): React.ReactElement {
  return <path d="M3.6 20.4H20.4" {...line(ACCENT, PIXEL_STROKE)} />;
}
/** The thick bottom: a 19.2 x 4.8 rect, rx 1.4 -- a bar, not a pill (as a 4.8
 *  stroke its round caps would end it in 4 px half-circles). */
function borderThickBottomEdge(): React.ReactElement {
  return <rect x="2.4" y="16.8" width="19.2" height="4.8" rx="1.4" fill={ACCENT} />;
}
/** The double bottom: one PIXEL_STROKE path, bars 15.6..18 and 19.2..21.6,
 *  the 1.2 between them one clean pixel. */
function borderDoubleBottomEdge(): React.ReactElement {
  return <path d="M3.6 16.8H20.4M3.6 20.4H20.4" {...line(ACCENT, PIXEL_STROKE)} />;
}

/** Bottom Border (also the Borders split button's default face): the bottom
 *  line solid. 16 dots. */
function BorderBottom({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {borderDots([BORDER_EDGE.bottom])}
      {borderBottomEdge()}
    </IconFrame>
  );
}

/** Top Border: the top line solid. */
function BorderTop({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {borderDots([BORDER_EDGE.top])}
      {borderTopEdge()}
    </IconFrame>
  );
}

/** Left Border: the left line solid. */
function BorderLeft({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {borderDots([BORDER_EDGE.left])}
      <path d="M3.6 3.6V20.4" {...line(ACCENT, PIXEL_STROKE)} />
    </IconFrame>
  );
}

/** Right Border: the right line solid. */
function BorderRight({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {borderDots([BORDER_EDGE.right])}
      <path d="M20.4 3.6V20.4" {...line(ACCENT, PIXEL_STROKE)} />
    </IconFrame>
  );
}

/** No Border: the dotted figure alone, all 21 dots, no accent. As the split
 *  button's face (when it was the last border used) it is all SOFT and reads
 *  fainter than its neighbours, still clearly above the disabled look. */
function BorderNone({ size }: RibbonIconProps): React.ReactElement {
  return <IconFrame size={size}>{borderDots([])}</IconFrame>;
}

/** All Borders (also More Borders..., as in Excel): every line solid, as ONE
 *  PIXEL_STROKE path (one path paints its crossings once; the cross's round
 *  caps end inside the frame band, so the T-junctions are square). With every
 *  line drawn no dotted line is left to be the ground, and the set needs a
 *  SOFT or STRONG shape, so each cell holds a SOFT 3.6 square (3 x 3 px, rx 0:
 *  even the 3 px cells' rx 0.9 painted a plus) 1.2 clear of the grid. It is
 *  the ground the borders sit round; Excel leaves the cells empty. */
function BorderAll({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {[6, 14.4].flatMap((y) =>
        [6, 14.4].map((x) => <rect key={`${x}-${y}`} x={x} y={y} width="3.6" height="3.6" rx="0" fill={SOFT} />),
      )}
      <path d="M3.6 3.6H20.4V20.4H3.6ZM12 3.6V20.4M3.6 12H20.4" {...line(ACCENT, PIXEL_STROKE)} />
    </IconFrame>
  );
}

/** Outside Borders: the thin frame as one PIXEL_STROKE path (round joins give
 *  the outer corners the bar's 1.2 radius) round the five dots of the centre
 *  cross, 2.4 clear of it. */
function BorderOutside({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {borderDots(BORDER_FRAME)}
      <path d="M3.6 3.6H20.4V20.4H3.6Z" {...line(ACCENT, PIXEL_STROKE)} />
    </IconFrame>
  );
}

/** Thick Outside Borders: a 4.8 frame as ONE filled path, a 1.4-cornered
 *  square clockwise and the 7.2..16.8 hole counter-clockwise (the MergeCenter
 *  hole technique). The 8 px hole leaves 6 px after the clearance: room for the
 *  crossing dot, not the arm dots, so a lone centre dot stands where Excel
 *  shows a small dotted cross (a soft plus read as "add", a soft square as a
 *  separate cell). */
function BorderThickOutside({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {borderDots(BORDER_THICK_FRAME)}
      <path
        d="M3.8 2.4H20.2A1.4 1.4 0 0 1 21.6 3.8V20.2A1.4 1.4 0 0 1 20.2 21.6H3.8A1.4 1.4 0 0 1 2.4 20.2V3.8A1.4 1.4 0 0 1 3.8 2.4ZM7.2 7.2V16.8H16.8V7.2Z"
        fill={ACCENT}
      />
    </IconFrame>
  );
}

/** Bottom Double Border: the dotted figure ending above two thin bars. */
function BorderDoubleBottom({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {borderDots([BORDER_EDGE.doubleBottom])}
      {borderDoubleBottomEdge()}
    </IconFrame>
  );
}

/** Thick Bottom Border: the dotted figure over one 4 px bar. It keeps the
 *  same 13 dots as Double, so the two differ only in the bar: solid 4 px vs
 *  2 + 1 + 2 px with a line of background through it. */
function BorderThickBottom({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {borderDots([BORDER_EDGE.thickBottom])}
      {borderThickBottomEdge()}
    </IconFrame>
  );
}

/** Top and Bottom Border. */
function BorderTopBottom({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {borderDots([BORDER_EDGE.top, BORDER_EDGE.bottom])}
      {borderTopEdge()}
      {borderBottomEdge()}
    </IconFrame>
  );
}

/** Top and Thick Bottom Border. */
function BorderTopThickBottom({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {borderDots([BORDER_EDGE.top, BORDER_EDGE.thickBottom])}
      {borderTopEdge()}
      {borderThickBottomEdge()}
    </IconFrame>
  );
}

/** Top and Double Bottom Border. */
function BorderTopDoubleBottom({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {borderDots([BORDER_EDGE.top, BORDER_EDGE.doubleBottom])}
      {borderTopEdge()}
      {borderDoubleBottomEdge()}
    </IconFrame>
  );
}

/**
 * Line Color (the Borders menu's "Line Color >" row): Excel's cell corner, a
 * pencil drawing it, and the colour bar.
 * - SOFT: the cell corner, one PIXEL_STROKE path: the left edge on the columns
 *   2.4..4.8 down to 16.8, the top edge on the rows 2.4..4.8 out to 14.4, a
 *   round join at the corner.
 * - ACCENT: the pencil (Excel's blue) at 45 degrees, tip (6.6, 16.8), its long
 *   edges on x + y = 20.4 and 26.4 (multiples of 1.2, so the diagonal steps
 *   evenly), 4.24 wide, one shape: a cone cut off by a gap was a detached
 *   smudge at 20px. It stops 1.2 above the bar and clear of the corner.
 * - STRONG: the bar, 19.2 x 3.6 at 18..21.6. A menu row's icon is a static
 *   picture the host cannot paint into, so the bar shows the default line
 *   colour, Excel's "Automatic" -- the text colour, which is why Excel's own
 *   bar is black. A green bar would promise green lines.
 */
function LineColor({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M3.6 15.6V3.6H13.2" {...line(SOFT, PIXEL_STROKE)} />
      <path
        d="M6.6 16.8L11.1 15.3L20.01 6.39A1.4 1.4 0 0 0 20.01 4.41L18.99 3.39A1.4 1.4 0 0 0 17.01 3.39L8.1 12.3Z"
        fill={ACCENT}
      />
      <rect x="2.4" y="18" width="19.2" height="3.6" rx="1.4" fill={STRONG} />
    </IconFrame>
  );
}

/** Format Cells: an accent title bar over a soft dialog with strong fields.
 *  The title bar stands one clean pixel (1.2 units) above the dialog body, so
 *  the green borders only the background. Until 2026-09-24 the two fields were
 *  the accent and sat ON the grey (1.5:1). The fields are 2.4 tall (two whole
 *  pixels at 20px) and span 10.8..19.2, 2.4 inside the body top and bottom: a
 *  3.2 field painted a grey half-pixel row along each edge. */
function FormatCells({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="19.2" height="4.8" rx="2.4" fill={ACCENT} />
      <rect x="2.4" y="8.4" width="19.2" height="13.2" rx="3.4" fill={SOFT} />
      <rect x="5.4" y="10.8" width="6" height="2.4" rx="1.2" fill={STRONG} />
      <rect x="5.4" y="16.8" width="10" height="2.4" rx="1.2" fill={STRONG} />
    </IconFrame>
  );
}

/** Superscript: a strong x, the accent block raised to the exponent slot.
 *  The block is 6 x 6 on whole pixels, more than 2 units clear of the x. */
function Superscript({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M3.6 8.6l8.4 11M12 8.6l-8.4 11" {...line(STRONG)} />
      <rect x="15.6" y="2.4" width="6" height="6" rx="2" fill={ACCENT} />
    </IconFrame>
  );
}

/** Subscript: Superscript with the x raised and the block lowered. */
function Subscript({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M3.6 4.4l8.4 11M12 4.4l-8.4 11" {...line(STRONG)} />
      <rect x="15.6" y="15.6" width="6" height="6" rx="2" fill={ACCENT} />
    </IconFrame>
  );
}

// ============================================================================
// Alignment
// ============================================================================

/**
 * Vertical alignment of TEXT (redrawn 2026-10-04): Excel's picture -- the SAME
 * three-line text block (long, short centred, long) pushed to the top, the
 * middle or the bottom of the box. No edge rule and one colour: the block's
 * position is the whole meaning, so the rule's "centred within 0.6" does not
 * apply (the Indent precedent).
 *
 * Three STRONG bars 2.4 tall (2 px) with 2.4 gaps, a 12-unit block (10 px):
 * long 19.2 at 2.4..21.6, short 12 at 6..18 -- the same measure as the short
 * rows of AlignLeft / Center / Right in the pill right below. The block starts
 * at 2.4, 6 or 9.6, so Middle is centred on 12 and the three positions are
 * 3 px apart at 20px. rx 1.2, a 2.4 bar's full pill. Lines are 2 px where
 * Excel's are 1 (the set's 2.4 floor), and rows and gaps 1:1 where Excel's are
 * 1:2. STRONG, not AlignLeft's SOFT long rows: every row carries the meaning
 * here, and AlignBottom is PRESSED on every default cell, where SOFT loses
 * contrast (the Dark pressed tint, 2.6:1). 1.2 gaps painted one solid bar.
 *
 * The previous drawings (an ACCENT edge rule with a SOFT object against it)
 * say "align an OBJECT to this edge": they are ObjectAlignTop/Middle/Bottom
 * below, which the Canvas Arrange menu uses.
 */
function textBlock(size: number | undefined, rows: readonly [number, number, number]): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y={rows[0]} width="19.2" height="2.4" rx="1.2" fill={STRONG} />
      <rect x="6" y={rows[1]} width="12" height="2.4" rx="1.2" fill={STRONG} />
      <rect x="2.4" y={rows[2]} width="19.2" height="2.4" rx="1.2" fill={STRONG} />
    </IconFrame>
  );
}

function AlignTop({ size }: RibbonIconProps): React.ReactElement {
  return textBlock(size, [2.4, 7.2, 12]);
}

function AlignMiddle({ size }: RibbonIconProps): React.ReactElement {
  return textBlock(size, [6, 10.8, 15.6]);
}

function AlignBottom({ size }: RibbonIconProps): React.ReactElement {
  return textBlock(size, [9.6, 14.4, 19.2]);
}

/** Vertical alignment of OBJECTS (the Canvas Arrange menu): the accent rule
 *  is the edge the soft object hugs. These were AlignTop/Middle/Bottom until
 *  2026-10-04, when those keys became Excel's text block; the Arrange menu
 *  aligns shapes, charts and controls, not text, so it keeps this picture.
 *  The rule is 2.4 tall (two whole pixels at 20px) in all three, because
 *  ObjectAlignMiddle's rule must be centred on y = 12 and only an even number
 *  of pixels can be centred there on whole pixels; the object keeps 2.4
 *  clear. */
function ObjectAlignTop({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="19.2" height="2.4" rx="1.2" fill={ACCENT} />
      <rect x="8.4" y="7.2" width="7.2" height="14.4" rx="2.4" fill={SOFT} />
    </IconFrame>
  );
}

function ObjectAlignMiddle({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="10.8" width="19.2" height="2.4" rx="1.2" fill={ACCENT} />
      <rect x="8.4" y="2.4" width="7.2" height="6" rx="2.2" fill={SOFT} />
      <rect x="8.4" y="15.6" width="7.2" height="6" rx="2.2" fill={SOFT} />
    </IconFrame>
  );
}

function ObjectAlignBottom({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="19.2" width="19.2" height="2.4" rx="1.2" fill={ACCENT} />
      <rect x="8.4" y="2.4" width="7.2" height="14.4" rx="2.4" fill={SOFT} />
    </IconFrame>
  );
}

/** Horizontal alignment of OBJECTS (the Canvas Arrange menu's Align Left /
 *  Center / Right rows): ObjectAlignTop / Middle / Bottom mirrored across the
 *  diagonal, written out (x and y swapped, so every edge stays on the grid)
 *  rather than transformed. Added by the 2026-10-04 icon review: those three
 *  rows still showed AlignLeft / Center / Right, the TEXT paragraph pictures,
 *  one separator above these object pictures -- the "align the text" reading
 *  the vertical rows had just been rid of. Office's Align menu draws all six
 *  rows as objects against an edge. Not AlignObjects (the menu's face: an edge
 *  with TWO objects of different widths). */
function ObjectAlignLeft({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="2.4" height="19.2" rx="1.2" fill={ACCENT} />
      <rect x="7.2" y="8.4" width="14.4" height="7.2" rx="2.4" fill={SOFT} />
    </IconFrame>
  );
}

function ObjectAlignCenter({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="10.8" y="2.4" width="2.4" height="19.2" rx="1.2" fill={ACCENT} />
      <rect x="2.4" y="8.4" width="6" height="7.2" rx="2.2" fill={SOFT} />
      <rect x="15.6" y="8.4" width="6" height="7.2" rx="2.2" fill={SOFT} />
    </IconFrame>
  );
}

function ObjectAlignRight({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="19.2" y="2.4" width="2.4" height="19.2" rx="1.2" fill={ACCENT} />
      <rect x="2.4" y="8.4" width="14.4" height="7.2" rx="2.4" fill={SOFT} />
    </IconFrame>
  );
}

/** Horizontal alignment: soft full-width rows, the strong short rows show
 *  which edge the text keeps. One drawing, three offsets of the short rows.
 *  On whole pixels: soft rows 2.4 tall, strong rows 3.6, gaps 2.4, spanning
 *  2.4..21.6. Four equal rows cannot do that (3.2 rows painted a grey
 *  half-pixel row along every edge), and the thicker row is the one that
 *  carries the meaning. */
function horizontalAlign(size: number | undefined, shortX: number): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="19.2" height="2.4" rx="1.2" fill={SOFT} />
      <rect x={shortX} y="7.2" width="12" height="3.6" rx="1.8" fill={STRONG} />
      <rect x="2.4" y="13.2" width="19.2" height="2.4" rx="1.2" fill={SOFT} />
      <rect x={shortX} y="18" width="12" height="3.6" rx="1.8" fill={STRONG} />
    </IconFrame>
  );
}

function AlignLeft({ size }: RibbonIconProps): React.ReactElement {
  return horizontalAlign(size, 2.4);
}

function AlignCenter({ size }: RibbonIconProps): React.ReactElement {
  return horizontalAlign(size, 6);
}

function AlignRight({ size }: RibbonIconProps): React.ReactElement {
  return horizontalAlign(size, 9.6);
}

// The lower-case letters of Excel's alignment pictures ("ab" in Wrap Text and
// the Orientation menu, "c" in Wrap Text), as filled paths: each drawn in its
// own frame with the x-height band at y 3.6..10.8 and the baseline at 10.8,
// and placed ONLY by translate and rotate, never scale, so every wall stays 2.4
// in every orientation (the transform rule in ribbonIcons.test.tsx). Rotation
// only by a quarter turn: turned 45 degrees a 6 px letter is not legible (see
// the Orientation block below).
//
// Why these proportions, on the 20px pixel grid: x-height 7.2 (6 px), walls
// 2.4 (2 px, PIXEL_STROKE's width) and counters 2.4 (2 px, the smallest hole
// that still paints as a hole): a 6 px letter is the smallest that can have
// 2 px walls on both sides of a 2 px counter. Excel's letters are 1 px strokes;
// these are twice as heavy, so they are as small as they can be. Upright,
// every straight edge is on the 1.2 grid; only the half-disc arcs antialias.

/** Single-storey a: a half-disc of radius 3.6 on the left and a flat stem on
 *  the right (3.6..7.2); its counter (a half-disc of 1.2 plus 1.2 of flat) is
 *  wound the other way, so it is a HOLE (the Search lens technique, no mask).
 *  A double-storey a needs 10 px, not 6. */
const LOWER_A = "M3.6 3.6H7.2V10.8H3.6A3.6 3.6 0 0 1 3.6 3.6ZM3.6 6A1.2 1.2 0 0 0 3.6 8.4H4.8V6Z";
/** b: the a mirrored, plus an ascender 3.6 (3 px) above the x-height with a
 *  full round cap. a and b are otherwise mirror images, so in the turned
 *  pictures the ascender is the ONLY cue to which way the word reads; a 2.4
 *  ascender was a stub once turned. */
const LOWER_B = "M0 1.2A1.2 1.2 0 0 1 2.4 1.2V3.6H3.6A3.6 3.6 0 0 1 3.6 10.8H0ZM2.4 6V8.4H3.6A1.2 1.2 0 0 0 3.6 6Z";
/** c: the a's half-disc with two arms ending in round terminals at 7.2. */
const LOWER_C = "M3.6 3.6H6A1.2 1.2 0 0 1 6 6H3.6A1.2 1.2 0 0 0 3.6 8.4H6A1.2 1.2 0 0 1 6 10.8H3.6A3.6 3.6 0 0 1 3.6 3.6Z";

/** The word "ab" (16.8 x 10.8: a at 0..7.2, b at 9.6..16.8) under one
 *  transform: Wrap Text upright, Rotate Text Up / Down turned a quarter. The
 *  gap between the letters is 2.4, which a quarter turn keeps on whole
 *  pixels. */
function wordAb(transform: string): React.ReactElement {
  return (
    <g transform={transform}>
      <path d={LOWER_A} fill={STRONG} />
      <path d={LOWER_B} fill={STRONG} transform="translate(9.6 0)" />
    </g>
  );
}

/**
 * Wrap Text (redrawn 2026-10-04): Excel's picture -- "ab" on the first line,
 * "c" wrapped onto the second, and a return arrow that runs down beside the b
 * and curls left into a head pointing at the c.
 *
 * - The word at (2.4, 2.4): a 2.4..9.6, b 12..19.2, ascender top 2.4. The c at
 *   (2.4, 10.8), 2.4..9.6 x 14.4..21.6, under the a with one clean pixel row
 *   between them.
 * - The arrow is ONE filled ACCENT outline (no stroke, so it bends on whole
 *   pixels like Replace's elbow): a 2 px column 19.2..21.6 from a round cap at
 *   12, exactly 1.2 from the b's bowl; an outer radius 3.6 (inner 1.2) into the
 *   row 16.8..19.2; a head 4.8 long x 7.2 tall (FontSizeUp's proportions), its
 *   base on the column 15.6 and its tip at (10.8, 18), 1.2 right of the c and
 *   1.2 below the b. Excel's arrow starts just under the b; a column starting
 *   there leaves the hook no straight run at all.
 *
 * The 2026-09-23 drawing (a soft line over a strong line turning back) had 5.8
 * units of accent contact; this one measures 0.
 */
function WrapText({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {wordAb("translate(2.4 2.4)")}
      <path d={LOWER_C} fill={STRONG} transform="translate(2.4 10.8)" />
      <path
        d="M10.8 18L15.6 14.4V16.8H18A1.2 1.2 0 0 0 19.2 15.6V13.2A1.2 1.2 0 0 1 21.6 13.2V15.6A3.6 3.6 0 0 1 18 19.2H15.6V21.6Z"
        fill={ACCENT}
      />
    </IconFrame>
  );
}

// Orientation: Excel's Orientation menu button (2026-10-04). STRONG letters,
// ONE accent concept each: the arrow (or, for Format Cell Alignment, the angle).
//
// The 45-degree pictures (Angle Counterclockwise, Angle Clockwise and the Text
// Orientation face) keep the letters UPRIGHT and STEP the word along the angle:
// the b one x-height (7.2) above or below the a, one clean pixel column right
// of it, so the word's baseline climbs or falls at 45 degrees. Recorded
// departure from Excel, whose letters are turned. They were turned here too
// until the 2026-10-04 icon review: a 6 px letter turned 45 degrees keeps two
// clean pixels of its hole inside four grey ones, so "ab" painted as two rings
// -- a "%", and the Orientation face sits beside the Number group's real % --
// at 100% and at 150% alike. A taller b (a 6.0 ascender) was rendered beside
// this version and still read as rings. Upright, every hole is a clean 2 x 2 px
// and the half-covered STRONG pixels drop from 29 to 14.
//
// The arrowhead is a right-angled triangle with its right angle at the tip:
// its legs run along a pixel row and a pixel column, so the head is crisp at
// 20px though the arrow is diagonal (Excel's own head is the same two-armed L).
// The shaft is a 2.6 diagonal (a diagonal keeps MIN_STROKE) on the line through
// the tip, so it enters the middle of the head's base, and ends inside the head
// so there is no seam. Departure from Excel: its arrow is longer than the word,
// with the head beyond the b; at 2 px letters a word and a head beyond it do
// not fit the 19.2 box, so the arrow runs beside the word.

/** "ab" with the a and the b placed separately, both upright (translate only). */
function steppedAb(a: readonly [number, number], b: readonly [number, number]): React.ReactElement {
  return (
    <>
      <path d={LOWER_A} fill={STRONG} transform={`translate(${a[0]} ${a[1]})`} />
      <path d={LOWER_B} fill={STRONG} transform={`translate(${b[0]} ${b[1]})`} />
    </>
  );
}

/** The word stepping UP: the a at 2.4..9.6 x 12..19.2, the b at 10.8..18 with
 *  its bowl on 4.8..12 (the a's top row is the b's baseline) and its ascender
 *  cap at 1.2, the frame margin's minimum. */
const WORD_AB_UP: readonly [readonly [number, number], readonly [number, number]] = [
  [2.4, 8.4],
  [10.8, 1.2],
];

/** Angle Counterclockwise (textRotation custom:45): the word stepping up, the
 *  arrow running up-right below the b. Head: legs 4.8 on the row 13.2 and the
 *  column 21.6, tip (21.6, 13.2), 1.7 clear of the b's bowl; shaft on
 *  x + y = 34.8 from (14.4, 20.4), its round cap reaching 21.7. */
function AngleCounterclockwise({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {steppedAb(...WORD_AB_UP)}
      <path d="M14.4 20.4L20.4 14.4" {...line(ACCENT, 2.6)} />
      <path d="M16.8 13.2H21.6V18Z" fill={ACCENT} />
    </IconFrame>
  );
}

/** Angle Clockwise (custom:-45): the word stepping DOWN (the a at 4.8..12 x
 *  2.4..9.6, the b at 13.2..20.4 with its ascender cap at 7.2 and its bowl on
 *  10.8..18), the arrow running down-right below the a: head legs 4.8 on the
 *  column 12 and the row 21.6, tip (12, 21.6); shaft on x - y = -9.6. Excel's
 *  composition (the word, the arrow under it); it differs from its twin by
 *  shape (the other diagonal, the arrow on the other side). */
function AngleClockwise({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {steppedAb([4.8, -1.2], [13.2, 7.2])}
      <path d="M6.2 15.8L10.8 20.4" {...line(ACCENT, 2.6)} />
      <path d="M12 16.8V21.6H7.2Z" fill={ACCENT} />
    </IconFrame>
  );
}

/**
 * Text Orientation: the Orientation button's face AND the menu's "Format Cell
 * Alignment" row. Excel's Format Cell Alignment picture: Angle
 * Counterclockwise's word, with the arrow's diagonal run down to a vertex on
 * the bottom pixel row (13.2, 20.4) and a horizontal leg from it, a
 * PIXEL_STROKE on the row 20.4: the ANGLE the text is turned through (both legs
 * are the one accent). The diagonal (on x + y = 33.6, the line through the tip
 * (21.6, 12)) has a smaller head, legs 3.6, 1.5 clear of the b's bowl. Its
 * round cap at the vertex reaches 21.7, inside the leg's own cap.
 *
 * Two departures, both for the owner to see:
 * - Excel's ribbon face is the plain word with an up-right arrow, i.e. Angle
 *   Counterclockwise. The contract gives the face and the Format Cell
 *   Alignment row ONE key, and two rows of one menu may not show one drawing
 *   (the "menu families" test), so the face shows the angle. Aliasing this key
 *   to AngleCounterclockwise (the Find = Search idiom) would give Excel's face
 *   at the cost of the same picture on the menu's first and last rows.
 * - Excel puts a head on the flat leg too. On the row 20.4 it pushed the ink to
 *   22.8; on 19.2 the leg, its head and the vertex fused into one green knot.
 */
function TextOrientation({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {steppedAb(...WORD_AB_UP)}
      <path d="M13.2 20.4L20.4 13.2" {...line(ACCENT, 2.6)} />
      <path d="M18 12H21.6V15.6Z" fill={ACCENT} />
      <path d="M13.2 20.4H20.4" {...line(ACCENT, PIXEL_STROKE)} />
    </IconFrame>
  );
}

/** Vertical Text (textRotation vertical, stacked letters): Excel's down arrow
 *  beside an upright "a" stacked over "b". The column is 19.2 tall exactly
 *  (a 2.4..9.6, one clean row, the b's ascender cap from 10.8, its bowl
 *  14.4..21.6). The arrow is a PIXEL_STROKE shaft on the column 7.2 and
 *  FontSizeDown's wedge, 2.4 clear of the letters. It differs from Rotate Text
 *  Down (also a down arrow) by its UPRIGHT letters in a narrow column. Its
 *  arrow sits 1 px right of the Rotate rows' arrows; lining them up left a
 *  loose gap between arrow and letters. */
function VerticalText({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d={LOWER_A} fill={STRONG} transform="translate(13.2 -1.2)" />
      <path d={LOWER_B} fill={STRONG} transform="translate(13.2 10.8)" />
      <path d="M7.2 3.6V16.8" {...line(ACCENT, PIXEL_STROKE)} />
      <path d="M3.6 16.8H10.8L7.2 21.6Z" fill={ACCENT} />
    </IconFrame>
  );
}

/** Rotate Text Up (rotate90): an up arrow beside the word turned to read
 *  upward -- local (x, y) -> (10.8 + y, 20.4 - x): a at 13.2..20.4, b at
 *  3.6..10.8, the bowls in the column 14.4..21.6, the b's ascender pointing
 *  LEFT. Shaft a PIXEL_STROKE on the column 6, wedge base 2.2 from the
 *  ascender's cap. */
function RotateTextUp({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {wordAb("translate(10.8 20.4) rotate(-90)")}
      <path d="M6 20.4V7.2" {...line(ACCENT, PIXEL_STROKE)} />
      <path d="M2.4 7.2H9.6L6 2.4Z" fill={ACCENT} />
    </IconFrame>
  );
}

/** Rotate Text Down (rotate270): a down arrow beside the word turned to read
 *  downward -- local (x, y) -> (21.6 - y, 3.6 + x): a at 3.6..10.8, b at
 *  13.2..20.4, the baseline on the LEFT facing the arrow, the b's ascender
 *  pointing RIGHT. The wedge's base corner is exactly 1.2 from the b's flat
 *  side (measured 1.3). */
function RotateTextDown({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {wordAb("translate(21.6 3.6) rotate(90)")}
      <path d="M6 3.6V16.8" {...line(ACCENT, PIXEL_STROKE)} />
      <path d="M2.4 16.8H9.6L6 21.6Z" fill={ACCENT} />
    </IconFrame>
  );
}

/** Indent: soft rows pushed right, the accent arrow is the push. The rows
 *  are 3.6 tall on whole pixels and span 18 units (3.6..21.6, 0.6 below
 *  centre: three 3 px rows with 3 px gaps are 15 px and cannot be centred in
 *  20) and the wedge is 6 x 11.2, centred on the middle row with its straight
 *  side on a pixel column: the first drawing was 12 px tall at 20px and the
 *  lightest icon in the set. */
function IndentIncrease({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="10.2" y="3.6" width="11.4" height="3.6" rx="1.8" fill={SOFT} />
      <rect x="10.2" y="10.8" width="11.4" height="3.6" rx="1.8" fill={SOFT} />
      <rect x="10.2" y="18" width="11.4" height="3.6" rx="1.8" fill={SOFT} />
      <path d="M2.4 7L8.4 12.6L2.4 18.2z" fill={ACCENT} />
    </IconFrame>
  );
}

function IndentDecrease({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="10.2" y="3.6" width="11.4" height="3.6" rx="1.8" fill={SOFT} />
      <rect x="10.2" y="10.8" width="11.4" height="3.6" rx="1.8" fill={SOFT} />
      <rect x="10.2" y="18" width="11.4" height="3.6" rx="1.8" fill={SOFT} />
      <path d="M8.4 7L2.4 12.6L8.4 18.2z" fill={ACCENT} />
    </IconFrame>
  );
}

// Merge: Excel's Merge & Center split button and its menu (2026-10-02).
//
// The owner asked for "Merge Cells as in Excel", so the four drawings follow
// Excel's own metaphor, which every Excel since 2007 shares and the current
// Microsoft 365 "monoline" set (2018 onward, kept by the 2023 Fluent refresh)
// draws most clearly: a grid two cells wide and three rows tall whose MIDDLE
// row is the merged cell, with any arrow INSIDE that row pointing OUTWARD. The
// four differ by SHAPE, as Excel's do: a TALL merged row with a double arrow
// (Merge & Center) or a right arrow (Merge Across), a THIN merged row with
// nothing in it (Merge Cells), and the thin row cut back into cells (Unmerge
// Cells). Microsoft's artwork is not copied; only what is shown, where, and
// which way the arrows point.
//
// Translated into the duotone language rather than traced:
// - Excel OUTLINES the merged row and draws the arrow inside it. In a filled set
//   at 20px an outline leaves the arrow about 2 px, so the row is a solid ACCENT
//   bar (the one coloured object, as Excel's blue row is) and the arrow is a
//   HOLE in it: a reverse-wound subpath, the Search lens / Lock keyhole
//   technique (never a <mask>).
// - The cells above and below are SOFT, each row two cells split by the 2.4
//   centred gap that stands in for Excel's column divider.
// - Every SOFT cell stands exactly 1.2 units (one clean pixel at 20px) clear of
//   the green, so ACCENT borders only the background (ICONS.md 2.2,
//   `npm run check:icon-contact` measures 0).
// - Every straight edge is a multiple of 1.2 (whole pixels at 20px) and the
//   ink spans 2.4..21.6 on both axes: centred, long side 19.2 (the fill rule).
// The 2026-09-24 drawing (icons/merge-cells.svg: green wedges pointing INWARD at
// a merged cell over a row of dark cells) was Google Sheets' metaphor (Material
// cell_merge), not Excel's; it is retired.

/** One row of the two-column grid every Merge glyph stands on: two SOFT cells
 *  8.4 wide at 2.4 and 13.2, split by the 2.4 centred gap (Excel's column
 *  divider). */
function mergeGridRow(y: number, height: number, rx: number): React.ReactElement {
  return (
    <>
      <rect x="2.4" y={y} width="8.4" height={height} rx={rx} fill={SOFT} />
      <rect x="13.2" y={y} width="8.4" height={height} rx={rx} fill={SOFT} />
    </>
  );
}

/** The TALL merged row (Merge & Center, Merge Across): 19.2 x 9.6 at
 *  2.4..21.6 x 7.2..16.8 (16 x 8 px at 20px), corners 1.8, drawn CLOCKWISE so
 *  that a counter-clockwise subpath after it is cut out as a hole under the
 *  default nonzero fill rule. The SOFT rows above (2.4..6) and below (18..21.6)
 *  are 3.6 tall (3 px), so they take rx 0.9 (ICONS.md 2.3: at 1.4 a 3 px cell
 *  paints as a plus sign). */
const MERGED_ROW_TALL =
  "M4.2 7.2H19.8A1.8 1.8 0 0 1 21.6 9V15A1.8 1.8 0 0 1 19.8 16.8H4.2A1.8 1.8 0 0 1 2.4 15V9A1.8 1.8 0 0 1 4.2 7.2Z";

/**
 * Merge & Center (the Home split button's face and the first menu item):
 * Excel's tall merged row with a double arrow pointing OUT to both edges -- the
 * cells become one and the content goes to the middle.
 *
 * The arrow is a counter-clockwise hole in the green row: shaft a 2.4 band on
 * the pixel rows 10.8..13.2 (a PIXEL_STROKE-equivalent run, two whole pixels),
 * heads 4.8 long x 7.2 tall (4 x 6 px) with tips at 4.8 and 19.2, 2.4 inside
 * the row's ends, and head bases on the pixel columns 9.6 and 14.4.
 *
 * Deliberate exception to ICONS.md 2.2's rule that a part left beside a cut
 * stays 2.4 wide (and frame.tsx's 3.6-unit part minimum): the 1.2 of green
 * above and below each head (8.4 - 7.2 and 16.8 - 15.6) is the merged cell's
 * OUTLINE -- Excel's own merged row is a 1 px outline round its arrow. Heads
 * 4.8 tall leave 2.4 but paint as "a bar with fat ends" at 100%, not as a
 * double arrow (both rendered at 20px, 2026-10-02). Do not shrink them to
 * satisfy the rule.
 */
function MergeCenter({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {mergeGridRow(2.4, 3.6, 0.9)}
      <path
        d={`${MERGED_ROW_TALL}M4.8 12L9.6 15.6V13.2H14.4V15.6L19.2 12L14.4 8.4V10.8H9.6V8.4Z`}
        fill={ACCENT}
      />
      {mergeGridRow(18, 3.6, 0.9)}
    </IconFrame>
  );
}

/**
 * Merge Across: Excel's Merge Across -- the same tall merged row with ONE arrow
 * pointing right: each ROW of the selection becomes its own merged cell.
 *
 * Same grid and same hole technique as MergeCenter: the shaft runs on the pixel
 * rows 10.8..13.2 from 4.8 (2.4 inside the row's left end) to the head base on
 * the pixel column 14.4, and the head is MergeCenter's right head (4.8 long x
 * 7.2 tall, tip at 19.2). The same deliberate exception applies: the 1.2 of
 * green above and below the head is the merged cell's outline (see
 * MergeCenter); heads 4.8 tall read as a bar with a fat end at 100%.
 */
function MergeAcross({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {mergeGridRow(2.4, 3.6, 0.9)}
      <path d={`${MERGED_ROW_TALL}M4.8 13.2H14.4V15.6L19.2 12L14.4 8.4V10.8H4.8Z`} fill={ACCENT} />
      {mergeGridRow(18, 3.6, 0.9)}
    </IconFrame>
  );
}

/**
 * Merge Cells: Excel's plain Merge Cells -- a THIN merged row with no arrow
 * between rows of cells: the cells become one and nothing moves (no centring).
 *
 * On whole pixels at 20px: SOFT rows 6 tall (5 px) at 2.4..8.4 and
 * 15.6..21.6, the ACCENT row 19.2 x 4.8 (16 x 4 px) at 9.6..14.4, 1.2 clear of
 * both. Excel's proportions (the merged row roughly a third of the height,
 * thinner than Merge & Center's) are kept so the two read apart by shape.
 *
 * Redrawn 2026-10-02 when the owner asked for Excel's approach. The KEY is
 * frozen (the Home "merge" launcher glyph and add-in tokens name it) and now
 * draws exactly what Excel's "Merge Cells" draws; the Home button's face is
 * MergeCenter. The owner's 2026-09-24 drawing (icons/merge-cells.svg: inward
 * wedges at a merged cell over a row of cells) is retired with it.
 */
function MergeCells({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {mergeGridRow(2.4, 6, 1.4)}
      <rect x="2.4" y="9.6" width="19.2" height="4.8" rx="1.4" fill={ACCENT} />
      {mergeGridRow(15.6, 6, 1.4)}
    </IconFrame>
  );
}

/** The thin merged row cut back into cells: four 3.6 (3 px) cells whose
 *  origins are on the pixel grid. The gaps are 1.2, 2.4 and 1.2: the middle
 *  one is the grid's own 2.4 column gap, so each column splits in two (Excel
 *  continues its column line through the unmerged row the same way). */
const UNMERGED_CELL_X = [2.4, 7.2, 13.2, 18] as const;

/**
 * Unmerge Cells: Excel's Unmerge Cells -- Merge Cells' thin row cut back into
 * four separate cells (Excel's tooltip: "Split the current cell into multiple
 * cells").
 *
 * The SOFT rows are Merge Cells' (6 tall at 2.4 and 15.6); the four ACCENT
 * cells are 3.6 x 4.8 (3 x 4 px) at 9.6..14.4, rx 0.9 because at 1.4 a 3 px
 * cell paints as a plus sign (ICONS.md 2.3). The four green rects are ONE
 * accent concept, the cut row, not four accents: the "exactly one thing per
 * icon" rule names the row, and a single path would draw the same pixels.
 */
function UnmergeCells({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {mergeGridRow(2.4, 6, 1.4)}
      {UNMERGED_CELL_X.map((x) => (
        <rect key={x} x={x} y="9.6" width="3.6" height="4.8" rx="0.9" fill={ACCENT} />
      ))}
      {mergeGridRow(15.6, 6, 1.4)}
    </IconFrame>
  );
}

// ============================================================================
// Number (drawn, not typeset: see the header)
// ============================================================================

/** Percent: two strong rings and the accent slash between them. */
function Percent({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <circle cx="7" cy="7" r="3" {...line(STRONG, 2.8)} />
      <circle cx="17" cy="17" r="3" {...line(STRONG, 2.8)} />
      <path d="M18.6 4.4L5.4 19.6" {...line(ACCENT, 3.2)} />
    </IconFrame>
  );
}

/** Comma style: two soft digit groups and the accent thousands comma. The
 *  comma is 1.15x its first size around its head and the groups are 13.2 tall
 *  from a whole pixel; the groups are 4.8 wide (4 px at 20px, every edge on a
 *  pixel column) so the bigger head keeps 1.8 units clear of each. */
function Comma({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="3.6" width="4.8" height="13.2" rx="2.2" fill={SOFT} />
      <rect x="16.8" y="3.6" width="4.8" height="13.2" rx="2.2" fill={SOFT} />
      <path
        d="M12 11.01a2.99 2.99 0 0 1 2.99 2.99c0 3.34-1.84 5.87-4.72 7.13a1.04 1.04 0 0 1-1.27-1.61c.92-.81 1.38-1.73 1.5-2.93A2.99 2.99 0 0 1 12 11.01z"
        fill={ACCENT}
      />
    </IconFrame>
  );
}

/** Number Format: the accent number sign beside a soft cell that holds a
 *  strong digit. The # stands on the background, 1.4 units clear of the cell:
 *  drawn on a grey card (until 2026-09-24) its thin green strokes were 1.5:1
 *  against the grey and read as a dark smudge. On whole pixels: the cell
 *  3.6..20.4, the digit 2.4 wide centred in it, and the #'s crossbars a
 *  PIXEL_STROKE path of their own on the rows at 9.6 and 14.4 (its slanted
 *  strokes cannot be crisp and keep MIN_STROKE). */
function NumberFormat({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="14.4" y="3.6" width="7.2" height="16.8" rx="3" fill={SOFT} />
      <rect x="16.8" y="7.2" width="2.4" height="9.6" rx="1.2" fill={STRONG} />
      <path d="M7.4 6.6l-1.6 10.8M11.4 6.6l-1.6 10.8" {...line(ACCENT, 2.6)} />
      <path d="M3.6 9.6h8.2M3.2 14.4h8.2" {...line(ACCENT, PIXEL_STROKE)} />
    </IconFrame>
  );
}

/** Increase Decimal: ".00" — a strong point, two soft digits, and the accent
 *  arrow pointing the way the digits grow. The arrow's shaft is a
 *  PIXEL_STROKE on the row at y = 6 (its head is slanted and keeps
 *  MIN_STROKE; y = 6 is on the 2.4 grid, so the shaft is crisp at 150% too),
 *  and the digits are 4.8 x 8.4 on whole pixels, 13.2..21.6, so the drawing
 *  spans 1.5..21.6, centred within 0.45 (at 1.5..20.4 it sat 1.05 high).
 *  The point is 4.3 across (the free-standing-dot minimum) with its centre on
 *  a pixel CORNER at 20px and at 30px, so it paints as a round 4px dot on the
 *  digits' baseline; off the corner it painted as a lopsided 3px blob. */
function DecimalIncrease({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M20.4 6H8.6" {...line(ACCENT, PIXEL_STROKE)} />
      <path d="M11.8 2.8L8.6 6l3.2 3.2" {...line(ACCENT, 2.6)} />
      <circle cx="4.8" cy="19.2" r="2.15" fill={STRONG} />
      <rect x="8.4" y="13.2" width="4.8" height="8.4" rx="2.2" fill={SOFT} />
      <rect x="15.6" y="13.2" width="4.8" height="8.4" rx="2.2" fill={SOFT} />
    </IconFrame>
  );
}

/** Decrease Decimal: ".0" — one digit fewer, the arrow reversed. Centred
 *  (4.8 units each side): it sits in a segmented pill right beside
 *  DecimalIncrease, and hugging the left edge put it 1.5 px off centre.
 *  Drawn on the same pixel rows as DecimalIncrease, the point again centred
 *  on a pixel corner. */
function DecimalDecrease({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M6 6H17.8" {...line(ACCENT, PIXEL_STROKE)} />
      <path d="M14.6 2.8L17.8 6l-3.2 3.2" {...line(ACCENT, 2.6)} />
      <circle cx="7.2" cy="19.2" r="2.15" fill={STRONG} />
      <rect x="10.8" y="13.2" width="4.8" height="8.4" rx="2.2" fill={SOFT} />
    </IconFrame>
  );
}

/**
 * Accounting Number Format (the face of its split button): Excel's picture --
 * a banknote with a stack of coins standing in front of its bottom-right
 * corner. The coins are the ACCENT, the one thing Excel colours (gold there),
 * and what turns the frame into money; the note is Excel's grey outline in
 * STRONG, its printed portrait a SOFT dot.
 *
 * - Note: a PIXEL_STROKE path of H/V runs on the pixel grid (edges 2.4..21.6 x
 *   2.4..15.6, 1.45:1 against Excel's 1.55:1). Its bottom run stops 1.2 short
 *   of the coins and its right run about 1.5 above them, so the corner is
 *   HIDDEN behind the stack, as in Excel, and the green borders only the
 *   background.
 * - Portrait: r 2.4 centred on a pixel CORNER (9.6, 8.4), so it paints as a
 *   round 4px dot (the DecimalIncrease point rule); Excel's oval cannot sit on
 *   a pixel corner both ways and blurred.
 * - Coins: ONE path, x 12..21.6 (both sides on pixel columns) x 10.8..21.6: the
 *   top face (an ellipse ry 1.8) and two coin edges 2.4 tall at the sides, each
 *   arc the one above it shifted down 3.6, so every gap is 1.2 of background.
 *   Flatter coins (ry 1.2) painted as a striped block at 20px.
 *
 * Differs from Database (a soft cylinder under a strong lid, no cuts) by the
 * note and by the cut stack.
 */
function Accounting({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M9.6 14.4H3.6V3.6H20.4V8.4" {...line(STRONG, PIXEL_STROKE)} />
      <circle cx="9.6" cy="8.4" r="2.4" fill={SOFT} />
      <path
        d="M12 12.6A4.8 1.8 0 0 1 21.6 12.6A4.8 1.8 0 0 1 12 12.6ZM12 13.8A4.8 1.8 0 0 0 21.6 13.8V16.2A4.8 1.8 0 0 1 12 16.2ZM12 17.4A4.8 1.8 0 0 0 21.6 17.4V19.8A4.8 1.8 0 0 1 12 19.8Z"
        fill={ACCENT}
      />
    </IconFrame>
  );
}

// ============================================================================
// Styles
// ============================================================================

/** Cell Styles: a gallery of four swatches, the two styled ones accent and the
 *  two plain ones soft, crossed. No card behind them: every swatch borders only
 *  the background, 2.4 units apart (two clean pixels at 20px, centred on the
 *  box; a 1.2 gap cannot be both centred and on whole pixels). */
function CellStyles({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="8.4" height="8.4" rx="2.2" fill={ACCENT} />
      <rect x="13.2" y="2.4" width="8.4" height="8.4" rx="2.2" fill={SOFT} />
      <rect x="2.4" y="13.2" width="8.4" height="8.4" rx="2.2" fill={SOFT} />
      <rect x="13.2" y="13.2" width="8.4" height="8.4" rx="2.2" fill={ACCENT} />
    </IconFrame>
  );
}

/**
 * Conditional Formatting (the Styles hero): Excel's picture -- a table with two
 * highlighted runs of different lengths and one single cell between them, so
 * they read as rule-driven highlights. Four columns 2.4..6 / 7.2..12 /
 * 13.2..16.8 / 18..21.6 (3 / 4 / 3 / 3 px) on the TableGrid's rows 2.4..8.4 /
 * 9.6..14.4 / 15.6..21.6. Both runs start in the second column; the top run
 * spans two columns, the bottom one three, to the edge. Every run edge is a
 * gutter, 1.2 from the next grey. Cells 3 px wide take rx 0.9 (ICONS.md 2.3).
 *
 * Departure (an owner call): Excel's RED runs are ACCENT, not DANGER -- DANGER
 * is the destructive verb in this set, and a red Conditional Formatting would
 * read as "delete". Excel's blue cell is STRONG: one accent concept, the
 * highlighted cells (two runs, one concept, as Unmerge's four cells are).
 */
function ConditionalFormatting({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="3.6" height="6" rx="0.9" fill={SOFT} />
      <rect x="7.2" y="2.4" width="9.6" height="6" rx="1.6" fill={ACCENT} />
      <rect x="18" y="2.4" width="3.6" height="6" rx="0.9" fill={SOFT} />
      <rect x="2.4" y="9.6" width="3.6" height="4.8" rx="0.9" fill={SOFT} />
      <rect x="7.2" y="9.6" width="4.8" height="4.8" rx="1.4" fill={STRONG} />
      <rect x="13.2" y="9.6" width="3.6" height="4.8" rx="0.9" fill={SOFT} />
      <rect x="18" y="9.6" width="3.6" height="4.8" rx="0.9" fill={SOFT} />
      <rect x="2.4" y="15.6" width="3.6" height="6" rx="0.9" fill={SOFT} />
      <rect x="7.2" y="15.6" width="14.4" height="6" rx="1.6" fill={ACCENT} />
    </IconFrame>
  );
}

/** The TableGrid's top row and its left column's middle cell (data.tsx's
 *  tracks 2.4 / 9.6 / 15.6, sizes 6 / 4.8 / 6, rx 1.6): a sheet's column
 *  headers and row numbers. Format as Table and the four sheet keys (Insert,
 *  Delete, Rename and Protect Sheet) stand on it, keeping the bottom-right
 *  square 9.6..21.6 free for their verb, 1.2 clear of every cell. */
function sheetHeaderCells(): React.ReactElement {
  return (
    <>
      <rect x="2.4" y="2.4" width="6" height="6" rx="1.6" fill={SOFT} />
      <rect x="9.6" y="2.4" width="4.8" height="6" rx="1.6" fill={SOFT} />
      <rect x="15.6" y="2.4" width="6" height="6" rx="1.6" fill={SOFT} />
      <rect x="2.4" y="9.6" width="6" height="4.8" rx="1.6" fill={SOFT} />
    </>
  );
}

/**
 * Format as Table (the Styles hero): Excel's picture -- a table whose bottom-
 * right block is styled, with a paintbrush laid across it, bristles down-left.
 *
 * - The TableGrid's top row and left column as SOFT cells (sheetHeaderCells
 *   plus the column's last cell), and the bottom-right square 9.6..21.6 in
 *   ACCENT: the style being applied.
 * - A STRONG brush on the axis x + y = 31.8, bristle tip (10.6, 21.2), length
 *   15: a curved bristle head 5 wide and 6 long, a 1.2 ferrule gap, then a 2.6
 *   handle. Excel's blue bristles are STRONG with the handle: an ACCENT head
 *   touched the grey cells.
 * - The green block cannot lie UNDER the brush (1.2 of background must
 *   separate them), so it is two pieces cut 1.2 clear of the brush: a channel
 *   +/- (1.3 + 1.2) along the handle and +/- (2.5 + 1.2) beside the head, the
 *   step between them 7.2 along the axis. The outer corners keep rx 1.6; the
 *   cut corners are sharp, as Merge's arrow holes are.
 *
 * The busiest drawing of the Home set: at 20px it reads as "table plus a dark
 * diagonal with a bulb", at 30px (the hero's size) as Excel's brush. Differs
 * from CellStyles (four free swatches) and TableStyle (a 3 x 3 grid with an
 * accent header) by shape.
 */
function FormatAsTable({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {sheetHeaderCells()}
      <rect x="2.4" y="15.6" width="6" height="6" rx="1.6" fill={SOFT} />
      <path d="M9.6 11.2A1.6 1.6 0 0 1 11.2 9.6L18.664 9.6L13.923 14.341L13.075 13.493L9.6 16.967Z" fill={ACCENT} />
      <path d="M21.6 13.736L21.6 20A1.6 1.6 0 0 1 20 21.6L15.433 21.6L18.307 18.725L17.459 17.877Z" fill={ACCENT} />
      <path
        d="M10.883 21.483Q9.044 19.079 11.236 17.028L13.075 15.19L16.61 18.725L14.913 20.422Q13.146 22.049 10.883 21.483Z"
        fill={STRONG}
      />
      <path d="M16.61 15.19L20.287 11.513" {...line(STRONG, 2.6)} />
    </IconFrame>
  );
}

// ============================================================================
// Cells: Excel's Insert, Delete and Format menus (2026-10-04)
// ============================================================================
//
// Every grid picture here is SOFT cells on the 1.2 pixel grid with 1.2 (one
// pixel) gutters, as Merge's are; ACCENT (inserting) or DANGER (deleting) is
// the verb and keeps 1.2 of background from every grey. Arrowheads are Merge's
// (a 90-degree tip, the base on a pixel column or row). An X is two
// line(DANGER, 3) diagonals in ONE path, sized by its ink: a round-capped
// diagonal's ink ends 1.5 beyond each endpoint. Excel's blue cell beside a red
// X becomes STRONG, because ACCENT and DANGER never meet in one icon.

/** One row of the Cells heroes' three-column grid: the TableGrid's columns
 *  2.4..8.4 / 9.6..14.4 / 15.6..21.6 (5 / 4 / 5 px; three equal cells cannot
 *  be whole pixels in 16 px), 3.6 tall (3 px) with rx 0.9 because a 3 px cell
 *  paints as a plus sign at rx 1.4 (ICONS.md 2.3). The heroes put rows at 2.4
 *  and 18 and act in the tall band 7.2..16.8 between them, 1.2 clear of both
 *  (Merge's rows). */
function cellsGridRow(y: number): React.ReactElement {
  return (
    <>
      <rect x="2.4" y={y} width="6" height="3.6" rx="0.9" fill={SOFT} />
      <rect x="9.6" y={y} width="4.8" height="3.6" rx="0.9" fill={SOFT} />
      <rect x="15.6" y={y} width="6" height="3.6" rx="0.9" fill={SOFT} />
    </>
  );
}

/**
 * Insert (the Insert hero's face and the "Insert Cells..." row): Excel's 3 x 3
 * grid whose middle row's centre and right cells are new, with an arrow
 * pointing LEFT out of them -- the cells push the old ones aside.
 *
 * In the band: ONE accent path for the arrow, its neck and the centre cell (a
 * head 9.6 tall with its tip at (2.4, 12) and its base on the column 7.2, a
 * 2.4 neck on the rows 10.8..13.2, the cell 9.6..14.4), plus the right cell
 * 15.6..21.6: the grid's own columns, so the new cells line up with the rows
 * above and below. Departure: the head stops at the grid's edge instead of
 * poking past it (the 1.2 frame margin). It differs from MergeAcross by shape:
 * three-cell rows, and a SOLID arrow leaving the cells to the left (Merge's is
 * a hole pointing right in a full-width bar).
 */
function InsertCells({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {cellsGridRow(2.4)}
      {cellsGridRow(18)}
      <path
        d="M2.4 12L7.2 7.2L7.2 10.8L9.6 10.8L9.6 8.6A1.4 1.4 0 0 1 11 7.2L13 7.2A1.4 1.4 0 0 1 14.4 8.6L14.4 15.4A1.4 1.4 0 0 1 13 16.8L11 16.8A1.4 1.4 0 0 1 9.6 15.4L9.6 13.2L7.2 13.2L7.2 16.8Z"
        fill={ACCENT}
      />
      <rect x="15.6" y="7.2" width="6" height="9.6" rx="1.4" fill={ACCENT} />
    </IconFrame>
  );
}

/** The X of DeleteCells and DeleteRow: centre (17.4, 12), arms 2.7, ink
 *  13.2..21.6 x 7.8..16.2 -- 1.8 clear of the soft rows and 2.3 from the
 *  STRONG point beside it. */
const DELETE_X_RIGHT = "M14.7 9.3L20.1 14.7M20.1 9.3L14.7 14.7";

/** Delete (the Delete hero's face and the "Delete Cells..." row): Excel's grid
 *  with its middle row pulled out, a cell pointing at a red X. The middle row
 *  has no soft cells at all (a 1 px step-in was invisible at 20px): a STRONG
 *  cell spanning the band, 2.4..9.6 x 7.2..16.8 (6 x 8 px), with a small point
 *  on the middle of its right side -- Delete Sheet Rows' point exactly (45
 *  degrees, 4.8 tall, 2.4 deep, tip (12, 12)) -- and the DANGER X. Excel's
 *  leaving block is a cell, wider than its point. The first drawing ran the
 *  point over the band's full height (the body 6 wide, the point 3.6 deep):
 *  at 20px a solid pentagon beside the X, which read as a Play button
 *  (2026-10-04 icon review). A point with steep sides over the full height
 *  painted as a "D" instead; this one keeps whole-pixel sides down to 9.6 and
 *  14.4. */
function DeleteCells({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {cellsGridRow(2.4)}
      {cellsGridRow(18)}
      <path d="M2.4 8.6A1.4 1.4 0 0 1 3.8 7.2H9.6V9.6L12 12L9.6 14.4V16.8H3.8A1.4 1.4 0 0 1 2.4 15.4Z" fill={STRONG} />
      <path d={DELETE_X_RIGHT} {...line(DANGER)} />
    </IconFrame>
  );
}

/**
 * Format (the Format hero's face): Excel's grid under a measuring bar with end
 * ticks |-| spanning its centre cell -- cell SIZE.
 *
 * The measure is ONE accent path: two 2.4-wide pill ticks 4.8 tall (2.4..7.2)
 * joined by a 2.4 bar on the rows 3.6..6, the ticks' inner edges (7.2, 16.8)
 * flush with the STRONG cell's sides, so the bar measures exactly that cell.
 * The grid starts 1.2 below the ticks: columns 3 / 8 / 3 px, rows 5 / 5 px.
 * Departure: the measured column is WIDE and the grid two rows tall; with
 * Excel's 3 x 3 equal cells the bar was a 4 px dumbbell over a 4 x 3 px cell
 * and read as an "I" over a keypad at 20px. Not FormatCells (the Format Cells
 * dialog's picture), which is a row of the same menu.
 */
function FormatMenu({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M4.8 3.6A1.2 1.2 0 0 1 7.2 3.6H16.8A1.2 1.2 0 0 1 19.2 3.6V6A1.2 1.2 0 0 1 16.8 6H7.2A1.2 1.2 0 0 1 4.8 6Z"
        fill={ACCENT}
      />
      <rect x="2.4" y="8.4" width="3.6" height="6" rx="0.9" fill={SOFT} />
      <rect x="7.2" y="8.4" width="9.6" height="6" rx="1.4" fill={STRONG} />
      <rect x="18" y="8.4" width="3.6" height="6" rx="0.9" fill={SOFT} />
      <rect x="2.4" y="15.6" width="3.6" height="6" rx="0.9" fill={SOFT} />
      <rect x="7.2" y="15.6" width="9.6" height="6" rx="1.4" fill={SOFT} />
      <rect x="18" y="15.6" width="3.6" height="6" rx="0.9" fill={SOFT} />
    </IconFrame>
  );
}

/** The neighbouring rows of the Sheet Rows pictures: full-width SOFT bars
 *  19.2 x 3.6 (Merge's thin rows, rx 0.9) at 2.4..6 and 18..21.6. Excel draws
 *  1 px bracket fragments; a full bar reads as "a row" at once. */
function neighbourRows(): React.ReactElement {
  return (
    <>
      <rect x="2.4" y="2.4" width="19.2" height="3.6" rx="0.9" fill={SOFT} />
      <rect x="2.4" y="18" width="19.2" height="3.6" rx="0.9" fill={SOFT} />
    </>
  );
}

/** The neighbouring columns: neighbourRows turned a quarter. */
function neighbourColumns(): React.ReactElement {
  return (
    <>
      <rect x="2.4" y="2.4" width="3.6" height="19.2" rx="0.9" fill={SOFT} />
      <rect x="18" y="2.4" width="3.6" height="19.2" rx="0.9" fill={SOFT} />
    </>
  );
}

/**
 * Insert Sheet Rows (redrawn 2026-10-04): Excel's picture -- the neighbouring
 * rows, a new row arriving from the left (2.4..10.8 x 9.6..14.4, 7 x 4 px), and
 * an arrow pointing LEFT into it from the right: tip (12, 12), head 9.6 tall
 * with its base on the column 16.8, a 2.4 shaft on the rows 10.8..13.2 to a
 * round end at 21.6. The tip stands 1.2 from the row's end: accent beside
 * accent needs no gap, but without it row and arrow fused into one tag.
 *
 * The columns are this picture turned a quarter clockwise about (12, 12),
 * (x, y) -> (24 - y, x), WRITTEN OUT rather than rotated: 24 is a multiple of
 * 1.2, so every edge stays on the grid. The frozen key's meaning is unchanged;
 * the 2026-09-23 drawing (two soft rows and a plus) is retired.
 */
function InsertRow({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {neighbourRows()}
      <rect x="2.4" y="9.6" width="8.4" height="4.8" rx="1.4" fill={ACCENT} />
      <path d="M12 12L16.8 7.2L16.8 10.8L20.4 10.8A1.2 1.2 0 0 1 21.6 12A1.2 1.2 0 0 1 20.4 13.2L16.8 13.2L16.8 16.8Z" fill={ACCENT} />
    </IconFrame>
  );
}

/** Insert Sheet Columns: Insert Sheet Rows turned a quarter clockwise, as
 *  Excel turns it -- the column comes down from the top, the arrow points UP
 *  into it from below. */
function InsertColumn({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {neighbourColumns()}
      <rect x="9.6" y="2.4" width="4.8" height="8.4" rx="1.4" fill={ACCENT} />
      <path d="M12 12L16.8 16.8L13.2 16.8L13.2 20.4A1.2 1.2 0 0 1 12 21.6A1.2 1.2 0 0 1 10.8 20.4L10.8 16.8L7.2 16.8Z" fill={ACCENT} />
    </IconFrame>
  );
}

/** Delete Sheet Rows (redrawn 2026-10-04): Excel's picture -- the same
 *  neighbours, the leaving row with a POINTED right end (4.8 tall, pointing to
 *  (12, 12) with 45-degree sides) and the red X. The row is STRONG where
 *  Excel's is blue: no ACCENT beside DANGER. */
function DeleteRow({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {neighbourRows()}
      <path d="M2.4 11A1.4 1.4 0 0 1 3.8 9.6L9.6 9.6L12 12L9.6 14.4L3.8 14.4A1.4 1.4 0 0 1 2.4 13Z" fill={STRONG} />
      <path d={DELETE_X_RIGHT} {...line(DANGER)} />
    </IconFrame>
  );
}

/** Delete Sheet Columns: Delete Sheet Rows turned a quarter clockwise (the
 *  column comes down from the top, pointed below, the X under it). */
function DeleteColumn({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {neighbourColumns()}
      <path d="M13 2.4A1.4 1.4 0 0 1 14.4 3.8L14.4 9.6L12 12L9.6 9.6L9.6 3.8A1.4 1.4 0 0 1 11 2.4Z" fill={STRONG} />
      <path d="M14.7 14.7L9.3 20.1M14.7 20.1L9.3 14.7" {...line(DANGER)} />
    </IconFrame>
  );
}

/** The sheet the four sheet keys stand on: sheetHeaderCells, and the
 *  bottom-left cell with Excel's curled corner as a dog-ear -- the cell's
 *  corner cut on the diagonal (2.4, 18)-(6, 21.6), legs 3.6 (3 px) with both
 *  ends on the grid, and the folded flap laid on it as a STRONG right triangle
 *  (STRONG on SOFT, the allowed order), its right angle at (6, 18) rounded 0.6.
 *  The curl is STRONG in all four where Excel colours it blue too: the one
 *  accent is the verb. A fuller grid read more like a sheet for Insert/Delete
 *  but squashed the padlock into a dome, so all four share this one. */
function sheetCorner(): React.ReactElement {
  return (
    <>
      {sheetHeaderCells()}
      <path d="M2.4 17.2A1.6 1.6 0 0 1 4 15.6L6.8 15.6A1.6 1.6 0 0 1 8.4 17.2L8.4 20A1.6 1.6 0 0 1 6.8 21.6L6 21.6L2.4 18Z" fill={SOFT} />
      <path d="M2.4 18L5.4 18A0.6 0.6 0 0 1 6 18.6L6 21.6Z" fill={STRONG} />
    </>
  );
}

/** Insert Sheet: the sheet with an arrow pointing LEFT along its bottom row
 *  at the curled cell (Excel inserts the new sheet BEFORE the active one): tip
 *  (9.6, 18), 1.2 from the curled cell; head 7.2 tall with its base on the
 *  column 14.4; a 2.4 shaft on the rows 16.8..19.2 to a round end at 21.6. */
function InsertSheet({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {sheetCorner()}
      <path d="M9.6 18L14.4 14.4L14.4 16.8L20.4 16.8A1.2 1.2 0 0 1 21.6 18A1.2 1.2 0 0 1 20.4 19.2L14.4 19.2L14.4 21.6Z" fill={ACCENT} />
    </IconFrame>
  );
}

/** Delete Sheet: the sheet with Excel's red X at the bottom right, centred on
 *  the free square (16.2, 16.2), arms 3.6: ink 11.1..21.3, 2.7 clear of the
 *  cells, about 40% of the box as Excel's is. */
function DeleteSheet({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {sheetCorner()}
      <path d="M12.6 12.6L19.8 19.8M19.8 12.6L12.6 19.8" {...line(DANGER)} />
    </IconFrame>
  );
}

/** Rename Sheet: the sheet with Excel's pencil, writing end down-left: an
 *  ACCENT pencil on a 45-degree axis from its tip (10.8, 21) up and right,
 *  4.2 wide, a 3.6 cone, a 1.2 notch (the paper line that makes it a pencil
 *  and not an arrow: without it, it read as an arrow pointing down-left), then
 *  the body to length 14.4 with a round end. Wholly inside the free square,
 *  1.8 from every cell. Solid where Excel's is an outline (a 3.5 px outline
 *  pencil is 1 px lines). Not the generic Pencil key, whose SOFT body would
 *  vanish into the cells. */
function RenameSheet({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {sheetCorner()}
      <path d="M11.463 20.825A0.4 0.4 0 0 1 10.975 20.337L11.861 16.969L14.831 19.939Z" fill={ACCENT} />
      <path
        d="M12.709 16.121L18.012 10.818A2.1 2.1 0 0 1 20.982 10.818A2.1 2.1 0 0 1 20.982 13.788L15.679 19.091Z"
        fill={ACCENT}
      />
    </IconFrame>
  );
}

/** Protect Sheet / Unprotect Sheet: the sheet with Excel's padlock, in the
 *  Lock key's shape language (rounded body, arched shackle, the keyhole a
 *  HOLE): body 9.6 x 7.2 on the grid (12..21.6 x 14.4..21.6, rx 1.8) centred
 *  on x 16.8 so the 2.4 round keyhole is on whole pixels with 2.4 of body
 *  round it; the shackle (r 3, legs on 13.8 and 19.8) tops out at 9.6, the top
 *  of the free square, its opening 3.4 wide (r 2.4 closed up at 20px). The
 *  WHOLE lock is ACCENT, Excel's one coloured object: Lock splits it (accent
 *  shackle, strong body), but its shackle meets its body, which is that key's
 *  allowlisted contact, and a new key must measure 0. */
function ProtectSheet({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {sheetCorner()}
      <path
        d="M13.8 14.4H19.8A1.8 1.8 0 0 1 21.6 16.2V19.8A1.8 1.8 0 0 1 19.8 21.6H13.8A1.8 1.8 0 0 1 12 19.8V16.2A1.8 1.8 0 0 1 13.8 14.4ZM16.8 16.8A1.2 1.2 0 0 0 16.8 19.2A1.2 1.2 0 0 0 16.8 16.8Z"
        fill={ACCENT}
      />
      <path d="M13.8 14.4V13.9a3 3 0 0 1 6 0V14.4" {...line(ACCENT, 2.6)} />
    </IconFrame>
  );
}

/** Row Height...: Excel's double arrow beside a cell bracket open toward it.
 *  The arrow (ACCENT, one path) has a 2.4 shaft on the columns 4.8..7.2 and
 *  heads 7.2 wide x 4.8 long whose tips (2.4 and 21.6) are exactly the
 *  bracket's outer top and bottom: the arrow measures the cell's height. The
 *  bracket is a SOFT PIXEL_STROKE whose centre lines (3.6, 20.4, 12) are all on
 *  the grid, its round ends at 10.8, one pixel column clear of the heads. SOFT,
 *  the ground (Excel's grey): a STRONG bracket outweighed the arrow, and a
 *  filled soft cell read as a slab. */
function RowHeight({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M6 2.4L9.6 7.2L7.2 7.2L7.2 16.8L9.6 16.8L6 21.6L2.4 16.8L4.8 16.8L4.8 7.2L2.4 7.2Z" fill={ACCENT} />
      <path d="M12 3.6H20.4V20.4H12" {...line(SOFT, PIXEL_STROKE)} />
    </IconFrame>
  );
}

/** Column Width...: Row Height turned a quarter COUNTER-clockwise,
 *  (x, y) -> (y, 24 - x): the bracket opens downward and the double arrow lies
 *  under it, as Excel draws it. */
function ColumnWidth({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M2.4 18L7.2 14.4L7.2 16.8L16.8 16.8L16.8 14.4L21.6 18L16.8 21.6L16.8 19.2L7.2 19.2L7.2 21.6Z" fill={ACCENT} />
      <path d="M3.6 12V3.6H20.4V12" {...line(SOFT, PIXEL_STROKE)} />
    </IconFrame>
  );
}

// ============================================================================
// Editing
// ============================================================================

/** Undo / Redo: a soft path back, the accent head is the verb. The path is a
 *  3.6 stroke centred on y = 9 and 19.8 (odd multiples of 0.6), so both of
 *  its straight runs have their edges on pixel rows; its bottom edge is 21.6. */
function Undo({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M4.4 9H14.4a5.4 5.4 0 0 1 0 10.8H10.8" {...line(SOFT, 3.6)} />
      <path d="M8.6 4.4L3.2 9l5.4 4.6" {...line(ACCENT, 3.2)} />
    </IconFrame>
  );
}

function Redo({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M19.6 9H9.6a5.4 5.4 0 0 0 0 10.8h3.6" {...line(SOFT, 3.6)} />
      <path d="M15.4 4.4L20.8 9l-5.4 4.6" {...line(ACCENT, 3.2)} />
    </IconFrame>
  );
}

/** Find & Replace: a soft original, the strong replacement, the accent arrow
 *  carrying one into the other. The two cards are 10.8 x 6 on whole pixels.
 *  The arrow's elbow is a FILLED band two pixels thick (a 2.4 stroke may not
 *  curve, and a 2.8 one is 2 1/3 px): its runs sit on the row 4.8..7.2 and
 *  the column 18..20.4, its outer corner keeps a 3.6 radius, and its round
 *  tail stops 1.2 clear of the soft card. The chevron is slanted and keeps
 *  MIN_STROKE. */
function Replace({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="10.8" height="6" rx="2.4" fill={SOFT} />
      <rect x="10.8" y="15.6" width="10.8" height="6" rx="2.4" fill={STRONG} />
      <path
        d="M15.6 4.8H16.8a3.6 3.6 0 0 1 3.6 3.6V12.6H18V8.4a1.2 1.2 0 0 0-1.2-1.2H15.6a1.2 1.2 0 0 1 0-2.4z"
        fill={ACCENT}
      />
      <path d="M16.8 10.2l2.4 2.4 2.4-2.4" {...line(ACCENT, 2.6)} />
    </IconFrame>
  );
}

/** Clear Contents' soft cell, 19.2 square on whole pixels (Clear All draws a
 *  stack instead, see below). The X is the verb. */
const CLEAR_CELL = { x: 2.4, y: 2.4, width: 19.2, height: 19.2, rx: 3.6 } as const;

/** Clear Contents: the cell with a STRONG X — the values go, nothing that
 *  cannot be retyped. */
function ClearContents({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect {...CLEAR_CELL} fill={SOFT} />
      <path d="M8.4 8.4l7.2 7.2M15.6 8.4l-7.2 7.2" {...line(STRONG, 3.2)} />
    </IconFrame>
  );
}

/**
 * Clear Formatting: a % (the format) and an eraser whose green tip is the verb.
 *
 * The owner's drawing (icons/clear-formatting.svg, 2026-09-24): a dark percent
 * sign at the top left and an eraser tilted 45 degrees at the bottom right with
 * a green tip and a dark body. Channels follow the owner: % and eraser body
 * STRONG, the tip ACCENT (the owner chose green, not the DANGER red that Clear
 * Contents / Clear All use for their X, so this icon never uses DANGER).
 *
 * Departures from the owner's file, each forced by the 20px ribbon size:
 * - the % rings (0.94-unit lines) became solid dots (r 2.1, centred on pixel
 *   corners so each paints as a round 4px dot, not a 3px plus sign): a ring this
 *   small at the set's 2.6 minimum line fills in anyway;
 * - the slash is 2.6 wide at the owner's 54 degrees, and the % is ~1.3x the
 *   owner's size, 1.3 units clear of the slash; the lower dot sits ~1.7 units
 *   from the eraser, so % and eraser stay two objects;
 * - the eraser keeps the owner's width (5.94) but is ~1.33x LONGER (16.97):
 *   at the owner's length it painted as two diamonds at 20px (the owner's
 *   "looks not so great"); this long it paints as one bar with a green cap.
 *   Tip 4.24 long (0.71 of the width; the owner's cap is 0.75), a 1.7 cut (the
 *   owner's 0.75 vanishes at 20px), body 11.03. A tip as long as it is wide
 *   still painted as a separate green diamond. Every vertex is on a multiple
 *   of 0.6 and every 45-degree edge on x+y or x-y = a multiple of 1.2, so the
 *   diagonal steps evenly at 100%;
 * - the drawing spans 1.3-1.5 units from every edge, the same footprint as
 *   Undo and Redo beside it (it was the smallest icon in the Editing cluster).
 */
function ClearFormatting({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <circle cx="3.6" cy="3.6" r="2.1" fill={STRONG} />
      <circle cx="9.6" cy="11.4" r="2.1" fill={STRONG} />
      <path d="M10 2.8L3.2 12.2" {...line(STRONG, 2.6)} />
      <path
        d="M10.2 16.2L8.4 18A1.697 1.697 0 0 0 8.4 20.4L10.2 22.2A1.697 1.697 0 0 0 12.6 22.2L14.4 20.4Z"
        fill={ACCENT}
      />
      <path
        d="M11.4 15L18 8.4A1.697 1.697 0 0 1 20.4 8.4L22.2 10.2A1.697 1.697 0 0 1 22.2 12.6L15.6 19.2Z"
        fill={STRONG}
      />
    </IconFrame>
  );
}

/** Clear All: a STACK of cells (the layers — contents, formats, comments)
 *  with a DANGER X through the front one. It must differ from Clear Contents
 *  by SHAPE, not only by the X's colour: the shape-first rule in ICONS.md,
 *  because a colour difference alone vanishes in high contrast and for a
 *  red-green colour-blind reader. The back layer is a STRONG edge peeking out
 *  above and to the right, never a second soft fill (two translucent fills
 *  would darken where they overlap). On whole pixels: the front cell is 14.4
 *  square at 2.4..16.8 x 7.2..21.6, and the back edge is a FILLED band two
 *  pixels thick (row 2.4..4.8, column 19.2..21.6, a 3.6 outer corner and round
 *  ends), 2.4 clear of the cell; as a curved 2.6 stroke it was 2.17 px and
 *  soft on both sides. */
function ClearAll({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M7.2 2.4H18a3.6 3.6 0 0 1 3.6 3.6V16.8a1.2 1.2 0 0 1-2.4 0V6a1.2 1.2 0 0 0-1.2-1.2H7.2a1.2 1.2 0 0 1 0-2.4z"
        fill={STRONG}
      />
      <rect x="2.4" y="7.2" width="14.4" height="14.4" rx="3.2" fill={SOFT} />
      <path d="M6.4 11.2l6.4 6.4M12.8 11.2l-6.4 6.4" {...line(DANGER, 3)} />
    </IconFrame>
  );
}

/** AutoSum: Excel's sigma with serif ticks, ONE filled STRONG polygon and no
 *  accent (Excel's is plain grey). Bars 2.4 thick on the rows 2.4..4.8 and
 *  19.2..21.6, x 3.6..20.4 (16.8 wide, centred); serifs 2.4 wide on the
 *  columns 18..20.4, 2 x 4 px; the chevron's parallel edges 4.2 apart along x
 *  on a 7.2 / 6.6 slope, 3.1 thick (the set's 3-unit line), its tip on the
 *  column 14.4. A stroked sigma cannot put its bars on whole pixels; 3.6 bars
 *  read as a heavy black E. */
function AutoSum({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M3.6 2.4H20.4V7.2H18V4.8H7.8L14.4 12L7.8 19.2H18V16.8H20.4V21.6H3.6V19.2L10.2 12L3.6 4.8Z" fill={STRONG} />
    </IconFrame>
  );
}

/**
 * The Fill menu's picture, drawn for Down and turned about (12, 12) for the
 * other three (the Upload / Link "one drawing, transformed" idiom). Excel's
 * picture is a cell with a title band and a blue arrow; here:
 * - a STRONG title bar 2.4..21.6 x 2.4..7.2 (16 x 4 px): the source the fill
 *   copies from;
 * - a SOFT U-frame below it (sides on the columns 2.4..4.8 and 19.2..21.6,
 *   bottom on the rows 19.2..21.6, one path), flush under the bar (STRONG
 *   beside SOFT is allowed and they meet on one pixel row);
 * - the ACCENT arrow pointing away from the bar, one path: a 2 px shaft from a
 *   round top at 8.4 to a head 8 x 4 px with its tip at 18, 1.2 from the bar
 *   and from the frame's inside, 2.4 from its sides.
 * The centre and every coordinate are on the grid, so each quarter turn keeps
 * every edge on whole pixels, and the four differ by SHAPE: the bar moves to
 * the side being copied from. Departure: Excel keeps Fill Up's band at the top
 * and turns only the arrow; turning the whole picture makes "the bar is the
 * source" one rule.
 */
function fillPicture(size: number | undefined, turn: 0 | 90 | 180 | -90): React.ReactElement {
  const picture = (
    <>
      <path d="M2.4 7.2V4.8a2.4 2.4 0 0 1 2.4-2.4H19.2a2.4 2.4 0 0 1 2.4 2.4V7.2Z" fill={STRONG} />
      <path
        d="M2.4 7.2H4.8V18a1.2 1.2 0 0 0 1.2 1.2H18a1.2 1.2 0 0 0 1.2-1.2V7.2H21.6V19.2a2.4 2.4 0 0 1-2.4 2.4H4.8a2.4 2.4 0 0 1-2.4-2.4Z"
        fill={SOFT}
      />
      <path d="M10.8 9.6a1.2 1.2 0 0 1 2.4 0V13.2H16.8L12 18L7.2 13.2H10.8Z" fill={ACCENT} />
    </>
  );
  return (
    <IconFrame size={size}>
      {turn === 0 ? picture : <g transform={`rotate(${turn} 12 12)`}>{picture}</g>}
    </IconFrame>
  );
}

/** Fill Down (also the Fill menu button's face). */
function FillDown({ size }: RibbonIconProps): React.ReactElement {
  return fillPicture(size, 0);
}

/** Fill Right: the bar on the left, the arrow pointing right. */
function FillRight({ size }: RibbonIconProps): React.ReactElement {
  return fillPicture(size, -90);
}

/** Fill Up: the bar at the bottom, the arrow pointing up. */
function FillUp({ size }: RibbonIconProps): React.ReactElement {
  return fillPicture(size, 180);
}

/** Fill Left: the bar on the right, the arrow pointing left. */
function FillLeft({ size }: RibbonIconProps): React.ReactElement {
  return fillPicture(size, 90);
}

/** Clear (the Clear menu button's face and its "Clear All" row): Excel's bare
 *  eraser, which is Clear Formatting's eraser on its own -- the same tilt, tip
 *  side, channels (STRONG body, ACCENT tip, the owner's colour choice) and 1.7
 *  cut, about 1.4x larger, without the %. Long sides on x + y = 18 and 30
 *  (8.49 wide), ends on x - y = -14.4 and 14.4; the tip spans x - y -14.4..-6,
 *  the body -3.6..14.4; outer corners r 1.697 (1.2 x root 2) as Clear
 *  Formatting's, every vertex on the 0.6 lattice and every diagonal on a
 *  multiple of 1.2, so it steps evenly at 100%. Ink 2.5..21.5 both ways.
 *  Excel's fat eraser painted its body as a diamond at 20px, the failure Clear
 *  Formatting's comment records. */
function Clear({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M6 12L3 15A1.697 1.697 0 0 0 3 17.4L6.6 21A1.697 1.697 0 0 0 9 21L12 18Z" fill={ACCENT} />
      <path d="M7.2 10.8L15 3A1.697 1.697 0 0 1 17.4 3L21 6.6A1.697 1.697 0 0 1 21 9L13.2 16.8Z" fill={STRONG} />
    </IconFrame>
  );
}

/**
 * Remove Hyperlinks: Excel's picture -- a whole chain with a red X at its
 * lower right, which is also how the set already says "remove this" (Clear
 * Filter: the funnel and a corner X).
 *
 * - The chain is Paste Link's, larger: two STRONG capsules (radius 2.8, a 2.6
 *   stroke, so each hole is 3.0 wide) on the anti-diagonal through (10.8,
 *   10.8), meeting END TO END there (an interlocked chain filled its own holes
 *   at this size), centrelines 3.6 long, written out as coordinates. Ink
 *   2.2..19.4 both ways.
 * - The X is Clear Filter's: two line(DANGER, 2.8) diagonals with 4.4 arms
 *   centred on (18, 18), ink 14.4..21.6 in the free corner, 2.1 clear of the
 *   chain's near caps. DANGER, not ACCENT: removing is the
 *   destructive verb (ClearAll's X), and ACCENT on a link means "attach"
 *   (Link).
 *
 * Until the 2026-10-04 icon review it was Link's chain broken and struck
 * through by a red slash: a recognisable "unlink", but not Excel's picture,
 * and 17 x 17 units, the lightest row of the Clear menu (weight 82 against
 * Clear's 101; this one weighs 105).
 */
function RemoveHyperlinks({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M8.25 17.31L10.8 14.76A2.8 2.8 0 0 0 6.84 10.8L4.29 13.35A2.8 2.8 0 0 0 8.25 17.31ZM14.76 10.8L17.31 8.25A2.8 2.8 0 0 0 13.35 4.29L10.8 6.84A2.8 2.8 0 0 0 14.76 10.8Z"
        {...line(STRONG, 2.6)}
      />
      <path d="M15.8 15.8L20.2 20.2M20.2 15.8L15.8 20.2" {...line(DANGER, 2.8)} />
    </IconFrame>
  );
}

/** The letters of Sort A to Z / Z to A (paths, never <text>), 9.6 x 8.4 each.
 *  The A: a flat apex 2.4 wide on the pixel row (LETTER_A's flat top), legs 2.8
 *  wide along x, the counter a reverse-wound HOLE -- sub-pixel at 20px (one
 *  lighter pixel) but what makes it an A at 30px and up; without it the A was a
 *  solid wedge there. The Z: bars 2.4 on the pixel rows, the diagonal 4.8 wide
 *  along x on a 3.6 rise (2.9 thick). 2.4 between the letters. */
const SORT_A_TOP = "M2.4 10.8L6 2.4H8.4L12 10.8H9.2L8.171 8.4H6.229L5.2 10.8ZM6.743 7.2H7.657L7.2 6.133Z";
const SORT_A_BOTTOM = "M2.4 21.6L6 13.2H8.4L12 21.6H9.2L8.171 19.2H6.229L5.2 21.6ZM6.743 18H7.657L7.2 16.933Z";
const SORT_Z_TOP = "M2.4 2.4H12V4.8L7.2 8.4H12V10.8H2.4V8.4L7.2 4.8H2.4Z";
const SORT_Z_BOTTOM = "M2.4 13.2H12V15.6L7.2 19.2H12V21.6H2.4V19.2L7.2 15.6H2.4Z";
/** Excel's down arrow beside the letters, STRONG (Excel's is the Z's grey; an
 *  ACCENT arrow would be a second accent beside the A, a SOFT one looked
 *  disabled), ONE path: a 2 px shaft on the columns 16.8..19.2 from a round
 *  top at 2.4, and FontSizeDown's wedge (13.2..22.8 x 16.8..21.6, 45 degrees;
 *  a stroked chevron painted a blob). Like FontSizeUp/Down the wedge reaches
 *  22.8, so the drawing sits 0.6 right, within the rule. */
const SORT_ARROW_DOWN = "M16.8 3.6a1.2 1.2 0 0 1 2.4 0V16.8H22.8L18 21.6L13.2 16.8H16.8Z";

/** Sort A to Z: Excel's blue A (ACCENT) over the Z (STRONG), with the arrow.
 *  The head comes within 1.2 of the Z's right end; both are STRONG, so the
 *  accent rule does not apply, and the pixels stay apart. */
function SortAscending({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d={SORT_A_TOP} fill={ACCENT} />
      <path d={SORT_Z_BOTTOM} fill={STRONG} />
      <path d={SORT_ARROW_DOWN} fill={STRONG} />
    </IconFrame>
  );
}

/** Sort Z to A: the letters swapped; the A's triangle at the bottom reads
 *  without colour. The A's nearest approach to the head is about 3.0. */
function SortDescending({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d={SORT_Z_TOP} fill={STRONG} />
      <path d={SORT_A_BOTTOM} fill={ACCENT} />
      <path d={SORT_ARROW_DOWN} fill={STRONG} />
    </IconFrame>
  );
}

/**
 * Sort & Filter (the Editing hero): Excel's blue A over a grey Z beside a
 * funnel, the funnel shorter than the letters and vertically centred.
 * - The letters are NARROW here, 7.2 wide (2.4..9.6): the A with a flat apex
 *   4.8..7.2 and 2.4 legs whose inner feet land on pixel columns, and no
 *   counter (at this width it would be a 0.3 sliver); the Z's diagonal 4.2
 *   wide along x on a 3.6 rise (3.2 thick).
 * - The funnel is SOFT in the Filter key's language (Filter's ACCENT stem is
 *   dropped: the A is this icon's accent): rim on the row 4.8, 10.8..21.6
 *   (9 px) with 1.2 corners, straight cone sides down to a 3 px stem
 *   14.4..18, its foot at 19.2 -- centred on 12, 2.4 from the A everywhere.
 * The letters are narrower than Sort A to Z's because a 9.6 funnel with its
 * stem on the grid painted as a T or a Y at 20px; 10.8 with a 3.6 stem is the
 * narrowest that reads as a funnel. The weakest of the Editing icons at 20px
 * (closer to a flared cup), it reads as a funnel at 30px, the hero's size.
 */
function SortFilter({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M2.4 10.8L4.8 2.4H7.2L9.6 10.8H7.2L6.514 8.4H5.486L4.8 10.8Z" fill={ACCENT} />
      <path d="M2.4 13.2H9.6V15.6L6.6 19.2H9.6V21.6H2.4V19.2L5.4 15.6H2.4Z" fill={STRONG} />
      <path
        d="M12 4.8H20.4A1.2 1.2 0 0 1 21.6 6L18 14.4V18A1.2 1.2 0 0 1 16.8 19.2H15.6A1.2 1.2 0 0 1 14.4 18V14.4L10.8 6A1.2 1.2 0 0 1 12 4.8Z"
        fill={SOFT}
      />
    </IconFrame>
  );
}

/** Go To...: Excel's plain blue right arrow, pointing at a SOFT cell, the
 *  destination. Excel draws the arrow alone, but every key paints a SOFT or
 *  STRONG shape, and a STRONG arrow alone is the generic arrow with no accent;
 *  a soft card with an accent arrow is the Replace idiom in the same Find &
 *  Select menu. The arrow (one path): a 2 px shaft on the rows 10.8..13.2 from
 *  a round tail at 2.4 to a head 4 x 8 px; the cell 13.2..21.6 x 6..18 (7 x 10
 *  px), 1.2 clear of the tip. An arrow is a strip; the strip is centred. The
 *  cell was 8 px tall until the 2026-10-04 icon review: at 19.2 x 9.6 of ink Go
 *  To was the lightest of the 93 keys measured (weight 44, under Find's 62 and
 *  Replace's 83 in the same menu); now 52. It differs from ChangeSource (an
 *  arrow pointing LEFT into a tall block with a strong header) by direction and
 *  shape. */
function GoTo({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M2.4 12a1.2 1.2 0 0 1 1.2-1.2H7.2V7.2L12 12L7.2 16.8V13.2H3.6A1.2 1.2 0 0 1 2.4 12Z" fill={ACCENT} />
      <rect x="13.2" y="6" width="8.4" height="12" rx="1.4" fill={SOFT} />
    </IconFrame>
  );
}

// ============================================================================
// Group export
// ============================================================================

/* eslint-disable @typescript-eslint/naming-convention -- the keys are React component names (PascalCase, which the rule already allows for functions) and a frozen public contract, not Rust-mirrored fields. */
/** The 34 frozen keys, in their historical order, then the Home extras, the
 *  Merge menu and Excel's Home tab (104 keys). */
export const HOME_ICONS = {
  Cut,
  Copy,
  Paste,
  FormatPainter,
  FontSizeUp,
  FontSizeDown,
  FormatCells,
  FillColor,
  AlignTop,
  AlignMiddle,
  AlignBottom,
  AlignLeft,
  AlignCenter,
  AlignRight,
  WrapText,
  IndentIncrease,
  IndentDecrease,
  MergeCells,
  Percent,
  Comma,
  NumberFormat,
  DecimalIncrease,
  DecimalDecrease,
  CellStyles,
  InsertRow,
  InsertColumn,
  DeleteRow,
  DeleteColumn,
  Undo,
  Redo,
  /** The magnifier is the generic Search drawing; one component, two keys. */
  Find: Search,
  ClearContents,
  ClearFormatting,
  ClearAll,
  // ---- Home extras ----------------------------------------------------------
  Superscript,
  Subscript,
  FontColor,
  Replace,
  // ---- Merge menu (2026-10-02): Excel's four Merge commands, with the frozen
  // MergeCells above as the plain merge ----------------------------------------
  MergeCenter,
  MergeAcross,
  UnmergeCells,
  // ---- Excel's Home tab (2026-10-04). Keys only grow: appended, never
  // reordered. The frozen AlignTop/Middle/Bottom, WrapText, FillColor and
  // Insert/Delete Row/Column above were redrawn in place the same day. ---------
  // Alignment: the Orientation menu, and the Canvas Arrange menu's object
  // alignment (the previous AlignTop/Middle/Bottom drawings).
  TextOrientation,
  AngleCounterclockwise,
  AngleClockwise,
  VerticalText,
  RotateTextUp,
  RotateTextDown,
  ObjectAlignTop,
  ObjectAlignMiddle,
  ObjectAlignBottom,
  // Cells: the Insert, Delete and Format heroes and their menus.
  InsertCells,
  DeleteCells,
  FormatMenu,
  InsertSheet,
  DeleteSheet,
  RowHeight,
  ColumnWidth,
  RenameSheet,
  ProtectSheet,
  // Font: the Underline split's rows, the Borders split and its menu.
  Underline,
  DoubleUnderline,
  BorderBottom,
  BorderTop,
  BorderLeft,
  BorderRight,
  BorderNone,
  BorderAll,
  BorderOutside,
  BorderThickOutside,
  BorderDoubleBottom,
  BorderThickBottom,
  BorderTopBottom,
  BorderTopThickBottom,
  BorderTopDoubleBottom,
  LineColor,
  // Clipboard: the Paste split's options.
  PasteFormulas,
  PasteFormulasNumberFormats,
  PasteKeepSourceFormatting,
  PasteNoBorders,
  PasteColumnWidths,
  PasteTranspose,
  PasteValues,
  PasteValuesNumberFormats,
  PasteValuesSourceFormatting,
  PasteFormatting,
  PasteLink,
  PasteSpecial,
  // Number and Styles.
  Accounting,
  ConditionalFormatting,
  FormatAsTable,
  // Editing: AutoSum, Fill, Clear, Sort & Filter, Go To.
  AutoSum,
  FillDown,
  FillRight,
  FillUp,
  FillLeft,
  Clear,
  RemoveHyperlinks,
  SortFilter,
  SortAscending,
  SortDescending,
  GoTo,
  // ---- The 2026-10-04 icon review: the Canvas Align menu's horizontal rows,
  // so all six rows draw objects (the text AlignLeft/Center/Right were there).
  ObjectAlignLeft,
  ObjectAlignCenter,
  ObjectAlignRight,
} as const;
/* eslint-enable @typescript-eslint/naming-convention */

