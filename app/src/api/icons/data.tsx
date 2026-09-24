//! FILENAME: app/src/api/icons/data.tsx
// PURPOSE: The data glyphs: tables and their style options, pivots and their
//          layout options, slicers, timelines, sparklines, BI (Fx, sources,
//          connections) and Page Layout (themes, margins, orientation...).
// CONTEXT: None of these had a mockup drawing; they are drawn in the mockup's
//          language (see ./frame.tsx). Two families are built from ONE shared
//          figure so their members can only differ in the part they name:
//
//          - The TABLE family (Table, HeaderRow, TotalRow, FirstColumn,
//            LastColumn, TableStyle, FilterButton, GrandTotals) is one 3 x 3
//            grid of cells painted by a function of (row, column). HeaderRow
//            and TotalRow therefore differ ONLY in which row is accent, which
//            is exactly the difference between the two check boxes they sit
//            next to in Table Design.
//          - The SPARKLINE family (Sparkline, SparkLine, SparkColumn,
//            SparkWinLoss) shares one soft cell, because a sparkline lives in a
//            cell. `Sparkline` is the feature (insert / group); `SparkLine`
//            with a capital L is the LINE type beside SparkColumn and
//            SparkWinLoss. Both keys are part of the contract.
//
//          The ACCENT follows the furniture rule: the soft table or page is the
//          ground, the accent is the part the command names (the header row,
//          the total row, the banding, the print area, the page break).

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
import { FUNNEL } from "./chart";

// ============================================================================
// The table figure
// ============================================================================

/** Track starts and sizes of the 3 x 3 cell grid, the same both ways: it fills
 *  2.4..21.6 (16 px at 20px) with 1.2-unit (1 px) gutters. Three EQUAL cells
 *  would be 14/3 px each, so no size puts every edge on a whole pixel (the old
 *  5.6 x 5.2 cells painted a half-grey seam along every one); the outer tracks
 *  are 6 units (5 px) and the middle one 4.8 (4 px) instead. */
const GRID = [2.4, 9.6, 15.6] as const;
const TRACK = [6, 4.8, 6] as const;

type CellPaint = (row: number, col: number) => string;

function TableGrid({ paint }: { paint: CellPaint }): React.ReactElement {
  return (
    <>
      {GRID.map((y, row) =>
        GRID.map((x, col) => (
          <rect
            key={`${row}-${col}`}
            x={x}
            y={y}
            width={TRACK[col]}
            height={TRACK[row]}
            rx="1.6"
            fill={paint(row, col)}
          />
        )),
      )}
    </>
  );
}

/** Table: the strong header row over a soft body. */
function Table({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <TableGrid paint={(row) => (row === 0 ? STRONG : SOFT)} />
    </IconFrame>
  );
}

function HeaderRow({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <TableGrid paint={(row) => (row === 0 ? ACCENT : SOFT)} />
    </IconFrame>
  );
}

function TotalRow({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <TableGrid paint={(row) => (row === 2 ? ACCENT : SOFT)} />
    </IconFrame>
  );
}

function FirstColumn({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <TableGrid paint={(_row, col) => (col === 0 ? ACCENT : SOFT)} />
    </IconFrame>
  );
}

function LastColumn({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <TableGrid paint={(_row, col) => (col === 2 ? ACCENT : SOFT)} />
    </IconFrame>
  );
}

/** Table styles: an accent header and a strong band — a table wearing a
 *  style, as opposed to Table's plain one. */
function TableStyle({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <TableGrid paint={(row) => (row === 0 ? ACCENT : row === 2 ? STRONG : SOFT)} />
    </IconFrame>
  );
}

/** Filter button: the header's last cell is the accent drop-down button. */
function FilterButton({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <TableGrid
        paint={(row, col) => (row === 0 ? (col === 2 ? ACCENT : STRONG) : SOFT)}
      />
    </IconFrame>
  );
}

/** Grand totals: the final row AND the final column — one concept, one
 *  channel, the L they form. */
function GrandTotals({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <TableGrid paint={(row, col) => (row === 2 || col === 2 ? ACCENT : SOFT)} />
    </IconFrame>
  );
}

/** Banded rows: four full-width rows, every second one accent. Each row is
 *  3.6 (3 px) with a 1.2 (1 px) gap: 15 px, which cannot centre in 20, so the
 *  block sits 0.6 high (2.4..20.4), against the accent row at the bottom. */
function BandedRows({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {[2.4, 7.2, 12, 16.8].map((y, i) => (
        <rect
          key={y}
          x="2.4"
          y={y}
          width="19.2"
          height="3.6"
          rx="1.6"
          fill={i % 2 === 1 ? ACCENT : SOFT}
        />
      ))}
    </IconFrame>
  );
}

/** Banded columns: BandedRows turned on its side (3.6 columns, 1.2 gaps,
 *  2.4..20.4 across, full height). */
function BandedColumns({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {[2.4, 7.2, 12, 16.8].map((x, i) => (
        <rect
          key={x}
          x={x}
          y="2.4"
          width="3.6"
          height="19.2"
          rx="1.6"
          fill={i % 2 === 1 ? ACCENT : SOFT}
        />
      ))}
    </IconFrame>
  );
}

// ============================================================================
// Pivot
// ============================================================================

/** Pivot: strong row and column headers around a soft body, the accent value
 *  cell where they cross — a crosstab, which is what a pivot IS. */
function Pivot({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="9.6" y="2.4" width="12" height="4.8" rx="2" fill={STRONG} />
      <rect x="2.4" y="9.6" width="4.8" height="12" rx="2" fill={STRONG} />
      <rect x="9.6" y="9.6" width="12" height="12" rx="2.4" fill={SOFT} />
      <rect x="9.6" y="9.6" width="6" height="6" rx="2.4" fill={ACCENT} />
    </IconFrame>
  );
}

/** Field list: rows of box + name; accent boxes are the checked fields. A
 *  4.8 box (4 px) and a 3.6 name (3 px) cannot share a centre on whole pixels,
 *  so each name sits on its box's baseline (box bottom = name bottom). */
function PivotFields({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="4.8" height="4.8" rx="1.6" fill={ACCENT} />
      <rect x="9.6" y="3.6" width="12" height="3.6" rx="1.8" fill={STRONG} />
      <rect x="2.4" y="9.6" width="4.8" height="4.8" rx="1.6" fill={ACCENT} />
      <rect x="9.6" y="10.8" width="12" height="3.6" rx="1.8" fill={STRONG} />
      <rect x="2.4" y="16.8" width="4.8" height="4.8" rx="1.6" fill={SOFT} />
      <rect x="9.6" y="18" width="12" height="3.6" rx="1.8" fill={SOFT} />
    </IconFrame>
  );
}

/** Calculated field: a soft column with a strong header, and the accent
 *  equals sign that makes it computed. */
function CalcField({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="9.6" height="19.2" rx="2.6" fill={SOFT} />
      <rect x="2.4" y="2.4" width="9.6" height="4.8" rx="2.3" fill={STRONG} />
      <rect x="14.4" y="7.2" width="7.2" height="3.6" rx="1.6" fill={ACCENT} />
      <rect x="14.4" y="13.2" width="7.2" height="3.6" rx="1.6" fill={ACCENT} />
    </IconFrame>
  );
}

/** Report filter pages: a strong front page with the filter funnel cut out of
 *  it as a HOLE (a reverse-wound subpath), in front of the accent pages it
 *  produces. Both pages are 13.2 squares (front 2.4..15.6 x 8.4..21.6, back
 *  8.4..21.6 x 2.4..15.6); the accent back page is an L that stays 1.2 units
 *  clear of the front page. The funnel's stem is 2.4 wide on whole pixels
 *  (8.4..10.8), so the funnel is centred on it, 0.6 right of the page centre.
 *  Until 2026-09-24 the funnel was an accent shape enclosed by STRONG: 1.35:1
 *  in Dark, where STRONG is a light grey. */
function FilterPages({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M11 2.4H19a2.6 2.6 0 0 1 2.6 2.6v8a2.6 2.6 0 0 1-2.6 2.6h-1a1.2 1.2 0 0 1-1.2-1.2V11a3.8 3.8 0 0 0-3.8-3.8H9.6a1.2 1.2 0 0 1-1.2-1.2V5a2.6 2.6 0 0 1 2.6-2.6z"
        fill={ACCENT}
      />
      <path
        d="M5 8.4h8a2.6 2.6 0 0 1 2.6 2.6v8a2.6 2.6 0 0 1-2.6 2.6H5a2.6 2.6 0 0 1-2.6-2.6v-8A2.6 2.6 0 0 1 5 8.4zM5.6 10.8L8.4 14.4V19.2L10.8 18V14.4L13.6 10.8z"
        fill={STRONG}
      />
    </IconFrame>
  );
}

/** Subtotals: soft detail rows, each group closed by an accent subtotal. The
 *  rows sit on BandedRows' whole-pixel rhythm (3.6 rows, 1.2 gaps). */
function Subtotals({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="6" y="2.4" width="15.6" height="3.6" rx="1.6" fill={SOFT} />
      <rect x="2.4" y="7.2" width="19.2" height="3.6" rx="1.6" fill={ACCENT} />
      <rect x="6" y="12" width="15.6" height="3.6" rx="1.6" fill={SOFT} />
      <rect x="2.4" y="16.8" width="19.2" height="3.6" rx="1.6" fill={ACCENT} />
    </IconFrame>
  );
}

/** Report layout: strong outer labels, accent inner (indented) labels, soft
 *  values — the compact/outline/tabular choice is about exactly that indent. */
function ReportLayout({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="9.6" height="3.6" rx="1.6" fill={STRONG} />
      <rect x="13.2" y="2.4" width="8.4" height="3.6" rx="1.6" fill={SOFT} />
      <rect x="6" y="9.6" width="6" height="3.6" rx="1.6" fill={ACCENT} />
      <rect x="13.2" y="9.6" width="8.4" height="3.6" rx="1.6" fill={SOFT} />
      <rect x="6" y="16.8" width="6" height="3.6" rx="1.6" fill={ACCENT} />
      <rect x="13.2" y="16.8" width="8.4" height="3.6" rx="1.6" fill={SOFT} />
    </IconFrame>
  );
}

/** Blank rows: two groups of rows, the accent dash marks the empty row
 *  inserted between them. Five rows and four 1 px gaps must fit 16 px, so the
 *  strong rows are 3.6 (3 px) and the soft rows and the dash 2.4 (2 px); every
 *  gap is 1.2, which also keeps the dash one clean pixel clear of both
 *  groups. */
function BlankRows({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="19.2" height="3.6" rx="1.5" fill={STRONG} />
      <rect x="2.4" y="7.2" width="19.2" height="2.4" rx="1.2" fill={SOFT} />
      <rect x="2.4" y="10.8" width="6" height="2.4" rx="1.2" fill={ACCENT} />
      <rect x="2.4" y="14.4" width="19.2" height="3.6" rx="1.5" fill={STRONG} />
      <rect x="2.4" y="19.2" width="19.2" height="2.4" rx="1.2" fill={SOFT} />
    </IconFrame>
  );
}

/** Expand / Collapse (a pivot or outline button): a soft box, the accent sign
 *  is the verb. The sign is PIXEL_STROKE centred on 12: two whole pixels,
 *  centred in the 16 px box (2.4..21.6), where a 3 px line cannot centre. */
function Expand({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="19.2" height="19.2" rx="3.6" fill={SOFT} />
      <path d="M12 7.6V16.4M7.6 12H16.4" {...line(ACCENT, PIXEL_STROKE)} />
    </IconFrame>
  );
}

function Collapse({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="19.2" height="19.2" rx="3.6" fill={SOFT} />
      <path d="M7.6 12H16.4" {...line(ACCENT, PIXEL_STROKE)} />
    </IconFrame>
  );
}

/** Clear filter: the soft funnel with the danger X in its empty corner. The X
 *  (15.6..22.8 x 14..21.2 with its round caps) keeps 1.2 of background to the
 *  funnel's stem (x 14.4) and to its slanted side, and 1.2 to the frame edge. */
function ClearFilter({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d={FUNNEL} fill={SOFT} />
      <path d="M17 15.4l4.4 4.4M21.4 15.4L17 19.8" {...line(DANGER, 2.8)} />
    </IconFrame>
  );
}

// ============================================================================
// Slicers, timelines, sparklines
// ============================================================================

/** Slicer: a soft panel of item buttons; the accent item is selected. Three
 *  3 px buttons with 1 px gaps are 11 px, which cannot centre in the 16 px
 *  panel, so they sit half a pixel low (3 px of panel above them, 2 px below),
 *  under the space a slicer's caption takes. */
function Slicer({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="19.2" height="19.2" rx="3.4" fill={SOFT} />
      <rect x="6" y="6" width="12" height="3.6" rx="1.8" fill={ACCENT} />
      <rect x="6" y="10.8" width="12" height="3.6" rx="1.8" fill={STRONG} />
      <rect x="6" y="15.6" width="12" height="3.6" rx="1.8" fill={STRONG} />
    </IconFrame>
  );
}

/** Timeline: a strong caption over a soft track; the accent span is the
 *  selected period. */
function Timeline({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="4.8" width="9.6" height="3.6" rx="1.6" fill={STRONG} />
      <rect x="2.4" y="12" width="19.2" height="7.2" rx="2.4" fill={SOFT} />
      <rect x="9.6" y="12" width="7.2" height="7.2" rx="2.4" fill={ACCENT} />
    </IconFrame>
  );
}

/** The soft cell every sparkline glyph is drawn inside: 2.4..21.6 x
 *  4.8..19.2, every edge on the 2.4 grid, so it is crisp at 100% and at 150%.
 *  The column and win/loss bars keep 2.4 clear of its top and bottom; the two
 *  line glyphs, whose ends are round, keep at least 1.8. */
function SparkCell(): React.ReactElement {
  return <rect x="2.4" y="4.8" width="19.2" height="14.4" rx="3" fill={SOFT} />;
}

/** Sparkline (the feature): a strong line in a cell, the accent last point.
 *  The glyph (6.6..17.3) is centred in the cell, so the point stands 1.8 below
 *  the cell's top edge rather than crowding it. */
function Sparkline({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <SparkCell />
      <path d="M5.6 16l3.8-4.4 3.4 2.8 4-4.6" {...line(STRONG, 2.6)} />
      <circle cx="17.8" cy="9" r="2.4" fill={ACCENT} />
    </IconFrame>
  );
}

/** SparkLine (the LINE type): the series itself is the accent. */
function SparkLine({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <SparkCell />
      <path d="M5.6 15.4l3.8-4.4 3.4 2.8 5.2-5.8" {...line(ACCENT, 2.8)} />
    </IconFrame>
  );
}

function SparkColumn({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <SparkCell />
      <rect x="4.8" y="12" width="3.6" height="4.8" rx="1.4" fill={ACCENT} />
      <rect x="9.6" y="7.2" width="3.6" height="9.6" rx="1.4" fill={ACCENT} />
      <rect x="14.4" y="10.8" width="3.6" height="6" rx="1.4" fill={ACCENT} />
    </IconFrame>
  );
}

/** Win/loss: strong wins above the midline (y 12), the accent loss below it.
 *  Four 2 px bars with 1 px gaps (4.8..18). */
function SparkWinLoss({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <SparkCell />
      <rect x="4.8" y="7.2" width="2.4" height="4.8" rx="1.2" fill={STRONG} />
      <rect x="8.4" y="7.2" width="2.4" height="4.8" rx="1.2" fill={STRONG} />
      <rect x="12" y="12" width="2.4" height="4.8" rx="1.2" fill={ACCENT} />
      <rect x="15.6" y="7.2" width="2.4" height="4.8" rx="1.2" fill={STRONG} />
    </IconFrame>
  );
}

// ============================================================================
// BI and sources
// ============================================================================

/** Report: a soft page, a strong title, an accent chart as wide as the title.
 *  Three 3 px bars with 1 px gaps are 11 px, which cannot centre on a 14 px
 *  page, so the page is 15 px (2.4..20.4, 0.6 left of the frame centre) and
 *  the title and bars share 4.8..18 inside it. */
function Report({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="18" height="19.2" rx="3" fill={SOFT} />
      <rect x="4.8" y="4.8" width="13.2" height="3.6" rx="1.6" fill={STRONG} />
      <rect x="4.8" y="13.2" width="3.6" height="4.8" rx="1.4" fill={ACCENT} />
      <rect x="9.6" y="10.8" width="3.6" height="7.2" rx="1.4" fill={ACCENT} />
      <rect x="14.4" y="14.4" width="3.6" height="3.6" rx="1.4" fill={ACCENT} />
    </IconFrame>
  );
}

/** Function (fx): a strong hooked f and an accent x, drawn as strokes. The f
 *  has arcs, so it keeps the 2.8 line, placed so its top and bottom outer
 *  edges (2.4, 21.6) and the stem's left edge (8.4) land on whole pixels; the
 *  straight crossbar is PIXEL_STROKE on 10.8. */
function Fx({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M14.4 3.8h-1.8a2.8 2.8 0 0 0-2.8 2.8v10.8a2.8 2.8 0 0 1-2.8 2.8H5.4"
        {...line(STRONG, 2.8)}
      />
      <path d="M6.6 10.8H12.4" {...line(STRONG, PIXEL_STROKE)} />
      <path d="M15.4 12.4l5 6.2M20.4 12.4l-5 6.2" {...line(ACCENT, 2.8)} />
    </IconFrame>
  );
}

/** Change data source: the soft data block with its strong header, and the
 *  accent arrow feeding a new range into it. The block and header edges are on
 *  the 2.4 grid; the straight shaft is its own PIXEL_STROKE path centred on
 *  13.2 (edges 12 / 14.4, whole pixels at 100% and 150%), and only the
 *  diagonal head keeps the 2.8 line. */
function ChangeSource({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="12" height="19.2" rx="2.8" fill={SOFT} />
      <path
        d="M5.2 2.4h6.4a2.8 2.8 0 0 1 2.8 2.8v2H2.4v-2a2.8 2.8 0 0 1 2.8-2.8z"
        fill={STRONG}
      />
      <path d="M21.6 13.2H12.4" {...line(ACCENT, PIXEL_STROKE)} />
      <path d="M15.4 10.2l-3 3 3 3" {...line(ACCENT, 2.8)} />
    </IconFrame>
  );
}

/** Connection: a strong source node joined by a soft link to the accent
 *  destination node. The link keeps the standard 3-unit line on purpose: this
 *  icon is drawn at 16px (the Workbook Connections pane) and 30px (the Slicer
 *  Options hero), never at 20, and a 3 line centred on 12 is exactly two whole
 *  pixels at 16px and within an eighth of a pixel at 30px, where PIXEL_STROKE
 *  would paint two half-grey rows. */
function Connection({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M6 12H18" {...line(SOFT)} />
      <circle cx="5.6" cy="12" r="3.6" fill={STRONG} />
      <circle cx="18.4" cy="12" r="3.6" fill={ACCENT} />
    </IconFrame>
  );
}

/** Lightning (quick analysis, flash fill): one strong bolt. The same-channel
 *  stroke only rounds its corners. */
function Lightning({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M13.6 2.2L4.6 13.6h6.6l-1.4 8.2 9.6-11.6h-6.8z"
        fill={STRONG}
        stroke={STRONG}
        strokeWidth={1.4}
        strokeLinejoin="round"
      />
    </IconFrame>
  );
}

// ============================================================================
// Page Layout: themes
// ============================================================================

/** Theme: a soft card holding a strong letterform and one accent swatch —
 *  fonts and colours together, which is what a document theme is. The A's
 *  flat top is placed so its outer edge is on a whole pixel (4.8), its
 *  crossbar is PIXEL_STROKE on 13.2, and the swatch stands 1.2 clear of the
 *  A's right foot. */
function Theme({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="19.2" height="19.2" rx="3.4" fill={SOFT} />
      <path d="M5.4 17.6L9 6.2h1.6l3.6 11.4" {...line(STRONG, 2.8)} />
      <path d="M7.2 13.2H12.4" {...line(STRONG, PIXEL_STROKE)} />
      <rect x="16.8" y="13.2" width="3.6" height="4.8" rx="1.4" fill={ACCENT} />
    </IconFrame>
  );
}

/** Fonts: "Aa" — a strong capital and an accent lowercase, both as strokes.
 *  The A's flat top has its outer edge on a whole pixel (3.6); its crossbar
 *  and the a's stem are PIXEL_STROKE on the pixel grid (y 13.2, x 21.6), and
 *  the a's bowl sits against that stem. The crossbar is on 13.2 rather than
 *  14.4 because its edges (12, 14.4) are then whole pixels at 30px too: Fonts
 *  is a 30px hero (Page Layout) and the 24px Home Font launcher. */
function Fonts({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M1.8 19.6L6.6 5.1h2.2l4.8 14.5" {...line(STRONG)} />
      <path d="M4.2 13.2H11" {...line(STRONG, PIXEL_STROKE)} />
      <circle cx="19" cy="16.2" r="2.6" {...line(ACCENT, 2.6)} />
      <path d="M21.6 13.2V19.8" {...line(ACCENT, PIXEL_STROKE)} />
    </IconFrame>
  );
}

/** Colours: three overlapping discs. The soft one is drawn first so the
 *  opaque strong and accent discs cover it rather than tinting through it. */
function Colors({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <circle cx="12" cy="7.6" r="5.2" fill={SOFT} />
      <circle cx="7.6" cy="15.4" r="5.2" fill={STRONG} />
      <circle cx="16.4" cy="15.4" r="5.2" fill={ACCENT} />
    </IconFrame>
  );
}

/** Effects: a strong shape casting a soft shadow. */
function Effects({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="8.4" y="8.4" width="13.2" height="13.2" rx="3" fill={SOFT} />
      <rect x="2.4" y="2.4" width="13.2" height="13.2" rx="3" fill={STRONG} />
    </IconFrame>
  );
}

/** Background: a soft sheet whose accent picture sits behind strong cells. */
function Background({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="19.2" height="19.2" rx="3.4" fill={SOFT} />
      <path
        d="M2.4 17l5-5a1.6 1.6 0 0 1 2.26 0l3.94 3.94 2-2a1.6 1.6 0 0 1 2.26 0l3.74 3.74v.52a3.4 3.4 0 0 1-3.4 3.4H5.8a3.4 3.4 0 0 1-3.4-3.4z"
        fill={ACCENT}
      />
      <rect x="4.8" y="4.8" width="8.4" height="6" rx="1.6" fill={STRONG} />
    </IconFrame>
  );
}

// ============================================================================
// Page Layout: page setup
// ============================================================================

/** Margins: a soft page with the strong content area inset from its edges. */
function Margins({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="3.6" y="2.4" width="16.8" height="19.2" rx="3" fill={SOFT} />
      <rect x="7.2" y="6" width="9.6" height="12" rx="1.6" fill={STRONG} />
    </IconFrame>
  );
}

/** Orientation: a soft portrait page, the strong landscape page, and the
 *  accent turn between them. */
function Orientation({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="10.8" height="19.2" rx="2.6" fill={SOFT} />
      <rect x="9.6" y="12" width="12" height="9.6" rx="2.6" fill={STRONG} />
      <path d="M14.8 4.2h2.2a2.6 2.6 0 0 1 2.6 2.6v2.4M17.2 7.2l2.4 2.4 2.4-2.4" {...line(ACCENT, 2.6)} />
    </IconFrame>
  );
}

/** Page size: a strong page inside a larger soft one, the accent arrow
 *  pulling out to the larger size. The arrow's corner is its own PIXEL_STROKE
 *  path on the pixel grid (x 19.2, y 19.2); only the diagonal keeps 2.8. */
function PageSize({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="19.2" height="19.2" rx="3.2" fill={SOFT} />
      <rect x="2.4" y="2.4" width="9.6" height="12" rx="3.2" fill={STRONG} />
      <path d="M14.6 14.6l4.6 4.6" {...line(ACCENT, 2.8)} />
      <path d="M19.2 14.4V19.2H14.4" {...line(ACCENT, PIXEL_STROKE)} />
    </IconFrame>
  );
}

/** Print area: a soft page with the accent region that will print. The region
 *  is 8 x 7 px (7.2..16.8 x 6..14.4), centred across the 14 px page with 3.6
 *  to its left, right and top: the same inset as Margins' content area beside
 *  it. A 9 px region (the old 10.8) cannot centre on a 14 px page. */
function PrintArea({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="3.6" y="2.4" width="16.8" height="19.2" rx="3" fill={SOFT} />
      <rect x="7.2" y="6" width="9.6" height="8.4" rx="1.8" fill={ACCENT} />
    </IconFrame>
  );
}

/** Breaks: two soft pages cut by the accent dashed page break. The dash is
 *  2.4 (2 px) centred on 12 with exactly 1.2 of background above and below. */
function Breaks({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="3.6" y="2.4" width="16.8" height="7.2" rx="2.4" fill={SOFT} />
      <rect x="3.6" y="14.4" width="16.8" height="7.2" rx="2.4" fill={SOFT} />
      <rect x="2.4" y="10.8" width="4.8" height="2.4" rx="1.2" fill={ACCENT} />
      <rect x="9.6" y="10.8" width="4.8" height="2.4" rx="1.2" fill={ACCENT} />
      <rect x="16.8" y="10.8" width="4.8" height="2.4" rx="1.2" fill={ACCENT} />
    </IconFrame>
  );
}

// ============================================================================
// Group export
// ============================================================================

/* eslint-disable @typescript-eslint/naming-convention -- the keys are React component names (PascalCase, which the rule already allows for functions) and a frozen public contract, not Rust-mirrored fields. */
export const DATA_ICONS = {
  Table,
  Pivot,
  PivotFields,
  CalcField,
  FilterPages,
  Fx,
  ChangeSource,
  Slicer,
  Timeline,
  Sparkline,
  SparkLine,
  SparkColumn,
  SparkWinLoss,
  Report,
  Lightning,
  Theme,
  Fonts,
  Colors,
  Effects,
  Margins,
  Orientation,
  PageSize,
  PrintArea,
  Breaks,
  Background,
  TableStyle,
  BandedRows,
  BandedColumns,
  HeaderRow,
  TotalRow,
  FirstColumn,
  LastColumn,
  FilterButton,
  Subtotals,
  GrandTotals,
  ReportLayout,
  BlankRows,
  Expand,
  Collapse,
  ClearFilter,
  Connection,
} as const;
/* eslint-enable @typescript-eslint/naming-convention */
