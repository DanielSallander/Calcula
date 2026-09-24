//! FILENAME: app/src/api/icons/home.tsx
// PURPOSE: The Home tab's glyphs: the 34 FROZEN keys redrawn in place on the
//          24-unit duotone grid, plus the Home extras (Superscript, Subscript,
//          FontColor, Replace).
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
//            clipped by the viewBox. Shifted up 2 units.
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

/** Fill Color: a soft bucket and a strong drop; like FontColor, the chosen
 *  colour is the host's data bar, not a channel of the glyph. */
function FillColor({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M11 2.2a1.8 1.8 0 0 1 2.55 0l7.5 7.5a2.6 2.6 0 0 1 0 3.68l-6.6 6.6a2.6 2.6 0 0 1-3.68 0l-6.6-6.6a2.6 2.6 0 0 1 0-3.68z"
        fill={SOFT}
      />
      <path
        d="M20.2 16s2.6 2.8 2.6 4.4a2.6 2.6 0 0 1-5.2 0c0-1.6 2.6-4.4 2.6-4.4z"
        fill={STRONG}
      />
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

/** Vertical alignment: the accent rule is the edge the soft content hugs.
 *  The rule is 2.4 tall (two whole pixels at 20px) in all three, because
 *  AlignMiddle's rule must be centred on y = 12 and only an even number of
 *  pixels can be centred there on whole pixels; the content keeps 2.4 clear. */
function AlignTop({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="19.2" height="2.4" rx="1.2" fill={ACCENT} />
      <rect x="8.4" y="7.2" width="7.2" height="14.4" rx="2.4" fill={SOFT} />
    </IconFrame>
  );
}

function AlignMiddle({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="10.8" width="19.2" height="2.4" rx="1.2" fill={ACCENT} />
      <rect x="8.4" y="2.4" width="7.2" height="6" rx="2.2" fill={SOFT} />
      <rect x="8.4" y="15.6" width="7.2" height="6" rx="2.2" fill={SOFT} />
    </IconFrame>
  );
}

function AlignBottom({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="19.2" width="19.2" height="2.4" rx="1.2" fill={ACCENT} />
      <rect x="8.4" y="2.4" width="7.2" height="14.4" rx="2.4" fill={SOFT} />
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

/** Wrap Text: a soft line above, the strong line turning back, the accent
 *  head is the wrap. The soft row and the strong line match the Align rows
 *  (2.4 and 3.6 on whole pixels): the line is a 3.6 stroke centred on y = 9
 *  and 17.4, odd multiples of 0.6, so both of its edges land on pixel rows. */
function WrapText({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="19.2" height="2.4" rx="1.2" fill={SOFT} />
      <path d="M4.2 9H15.6a4.2 4.2 0 0 1 0 8.4H12" {...line(STRONG, 3.6)} />
      <path d="M14 14.4L10.6 17.4l3.4 3" {...line(ACCENT)} />
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

/** The row of cells Merge Cells stands on: column origins on the 20px pixel
 *  grid (every value a multiple of 1.2 units). */
const MERGE_COLUMNS = [2.4, 7.2, 12, 16.8] as const;

/**
 * Merge Cells: two arrows pushing in on a merged cell above a row of cells.
 *
 * The owner's drawing (icons/merge-cells.svg and .png, 2026-09-24): the green
 * merged cell spans columns 2-3 of the top row, green arrows in columns 1 and 4
 * point INWARD at it, and dark cells sit below. Channels follow the owner:
 * arrows and merged cell ACCENT (one concept, the merge), the cells STRONG.
 *
 * Second pass, the owner's request the same day: the bottom row of cells is
 * gone and everything else grew into the room it left ("the arrows are barely
 * visible and the cells look very small"). The arrows are 4 x 8 px (were 3 x 4),
 * the merged cell 7 x 8 px (was 7 x 4), the cells 3 x 5 px (were 3 x 4). The
 * cells cannot get WIDER: four columns with one-pixel gaps are 15 px, the whole
 * box. Taller than 5 px they read as pillars, not cells (tried: 7 px).
 *
 * Drawn on the 20px pixel grid: every straight edge is a multiple of 1.2 units,
 * so every gap is a clean pixel (the arrow-to-cell-row gap is two, which keeps
 * green 2.4 units off the dark cells, docs/design/ICONS.md 2.2). Do not "fix"
 * either of these:
 * - rx 0.75 (the owner's 2/64) is below frame.tsx's 1.4 on purpose: at 1.4 a
 *   3px cell renders as a plus sign;
 * - the ink sits 0.6 units left of centre and 0.6 below it: 17 x 15 px cannot
 *   be centred on whole pixels, and centring it puts every edge on a half pixel
 *   and smears every gap.
 * The arrows overhang the cell row by one pixel each side: inside a 3px column
 * a wedge is too small to read (the first pass). The owner's shafted arrows
 * (0.68-unit lines) became solid wedges: a plain triangle is the arrow the
 * Indent icons beside it already use.
 */
function MergeCells({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M1.2 3.6L6 8.4L1.2 13.2Z" fill={ACCENT} />
      <rect x="7.2" y="3.6" width="8.4" height="9.6" rx="0.75" fill={ACCENT} />
      <path d="M21.6 3.6L16.8 8.4L21.6 13.2Z" fill={ACCENT} />
      {MERGE_COLUMNS.map((x) => (
        <rect key={x} x={x} y="15.6" width="3.6" height="6" rx="0.75" fill={STRONG} />
      ))}
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

// ============================================================================
// Cells: insert / delete rows and columns
// ============================================================================

/** The soft neighbours are the ground; the verb (accent plus, danger minus)
 *  sits in the gap where the row or column arrives or leaves. The neighbours
 *  are 4.8 thick, on whole pixels, so the gap is 9.6 and the verb (7.2 across
 *  with its round caps) stands 1.2 clear of both: one clean pixel of
 *  background at 20px, never green or red laid against the grey. The plus
 *  and the minus are PIXEL_STROKE lines centred on (12, 12), so their long
 *  edges land on pixel boundaries: a 3-unit minus is 2.5 px and painted a grey
 *  half-pixel row above and below. */
function InsertRow({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="19.2" height="4.8" rx="2.2" fill={SOFT} />
      <rect x="2.4" y="16.8" width="19.2" height="4.8" rx="2.2" fill={SOFT} />
      <path d="M12 9.6v4.8M9.6 12h4.8" {...line(ACCENT, PIXEL_STROKE)} />
    </IconFrame>
  );
}

function InsertColumn({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="4.8" height="19.2" rx="2.2" fill={SOFT} />
      <rect x="16.8" y="2.4" width="4.8" height="19.2" rx="2.2" fill={SOFT} />
      <path d="M12 9.6v4.8M9.6 12h4.8" {...line(ACCENT, PIXEL_STROKE)} />
    </IconFrame>
  );
}

function DeleteRow({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="19.2" height="4.8" rx="2.2" fill={SOFT} />
      <rect x="2.4" y="16.8" width="19.2" height="4.8" rx="2.2" fill={SOFT} />
      <path d="M9.6 12h4.8" {...line(DANGER, PIXEL_STROKE)} />
    </IconFrame>
  );
}

function DeleteColumn({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="4.8" height="19.2" rx="2.2" fill={SOFT} />
      <rect x="16.8" y="2.4" width="4.8" height="19.2" rx="2.2" fill={SOFT} />
      <path d="M9.6 12h4.8" {...line(DANGER, PIXEL_STROKE)} />
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

// ============================================================================
// Group export
// ============================================================================

/* eslint-disable @typescript-eslint/naming-convention -- the keys are React component names (PascalCase, which the rule already allows for functions) and a frozen public contract, not Rust-mirrored fields. */
/** The 34 frozen keys, in their historical order, then the Home extras. */
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
} as const;
/* eslint-enable @typescript-eslint/naming-convention */

