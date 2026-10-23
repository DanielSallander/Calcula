//! FILENAME: app/src/api/icons/data.tsx
// PURPOSE: The data glyphs: tables and their style options, pivots and their
//          layout options, slicers, timelines, sparklines, BI (Fx, sources,
//          connections) and Page Layout (themes, margins, orientation...).
// CONTEXT: Most of these had no mockup drawing; they are drawn in the mockup's
//          language (see ./frame.tsx). Two families are built from ONE shared
//          figure so their members can only differ in the part they name:
//
//          - The TABLE family (HeaderRow, TotalRow, FirstColumn, LastColumn,
//            TableStyle, FilterButton, GrandTotals) is one 3 x 3 grid of cells
//            painted by a function of (row, column). HeaderRow and TotalRow
//            therefore differ ONLY in which row is accent, which is exactly
//            the difference between the Header Row and Total Row options they
//            name (Table Design draws those options as plain check boxes; no
//            built-in control uses these two keys today).
//          - The SPARKLINE family (Sparkline, SparkLine, SparkColumn,
//            SparkWinLoss) shares one soft cell, because a sparkline lives in a
//            cell. `Sparkline` is the feature (insert / group); `SparkLine`
//            with a capital L is the LINE type beside SparkColumn and
//            SparkWinLoss. Both keys are part of the contract.
//
//          The ACCENT follows the furniture rule: the soft table or page is the
//          ground, the accent is the part the command names (the header row,
//          the total row, the banding, the print area, the page break).
//
//          The Canvas tab (2026-10-08) added Power BI's Matrix, Calcula's
//          Floating Grid (on the table figure's columns), and the report-page
//          keys: New Page, Page Navigator, Clear All Slicers, the Page View
//          rows and Wallpaper.
//
//          Four keys here are Visuals gallery tiles -- Table, Matrix, Slicer
//          and Timeline -- and are drawn in the Visuals family's language
//          (marks.tsx; 2026-10-22): square where a part meets something, a
//          full curve where it ends freely, one 2.4 cut. Table is therefore
//          no longer the table figure with a STRONG header row.

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
import { roundedPlus } from "./generic";
import { dMark, pill } from "./marks";

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

/** One row of the Table visual: a pill `height` tall (a row has no axis, so it
 *  is free at both ends) cut twice by THE gap into three cells, D | square |
 *  D, on the lattice's columns x 2.4 / 9.6 / 16.8. */
function tableRow(y: number, height: number, paint: string): React.ReactElement {
  return (
    <>
      {dMark(2.4, y, 4.8, height, "left", paint)}
      <rect x="9.6" y={y} width="4.8" height={height} fill={paint} />
      {dMark(16.8, y, 4.8, height, "right", paint)}
    </>
  );
}

/** Table (the Visuals gallery's tile; also Table Design's panel icon and
 *  Convert to Range, the Table JSON pane's 16px header and the Writeback
 *  tab): three ROWS, each a pill cut into three cells (2026-10-22, the
 *  Visuals family): an ACCENT header row 3.6 tall at y 2.4..6 over two STRONG
 *  value rows 4.8 tall at 8.4..13.2 and 15.6..20.4. The header is THINNER
 *  than the rows so it reads as a header by shape too: drawn as a third row of
 *  the same height, it differed from the body by hue alone, which is lost in
 *  grayscale (the disabled look, a colour-blind reader) and nearly lost in
 *  Dark and High contrast (the implementation review of 2026-10-22). The
 *  header stays three cells, not one bar: a bar over cells is Floating
 *  Grid's silhouette on the same tab. The plain 3 x 3 grid of squares was the
 *  competing "Crisp" direction's picture. */
function Table({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {tableRow(2.4, 3.6, ACCENT)}
      {tableRow(8.4, 4.8, STRONG)}
      {tableRow(15.6, 4.8, STRONG)}
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

/** Table styles: the table figure (the 3 x 3 grid the style options share)
 *  wearing a style: an accent header row and a strong band in a soft body.
 *  Table itself is the Visuals family's picture (pill rows, all STRONG under
 *  its header), so the two differ by shape as well as by the soft body. */
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

/** Slicer (2026-10-22, the Visuals family): no panel. Three items at y 2.4 /
 *  9.6 / 16.8, each a round 4.8 radio dot and a 4.8 PILL label from x 9.6 (a
 *  label has no axis, so both of its ends are full curves). The selected item
 *  is an ACCENT dot and a STRONG label; the two unselected items are SOFT, dot
 *  and label, as a slicer dims what is not picked. Unselected labels in STRONG
 *  left the green dot as the only cue, which disappears in grayscale (the
 *  disabled look, a colour-blind reader) and against High contrast's solid
 *  grey (the implementation review of 2026-10-22). The old soft panel holding
 *  three dark pills was the heaviest, muddiest picture of the strip, and its
 *  green pill sat one pixel from the black ones. Keep the markers ROUND:
 *  square ticks beside name bars are PivotFields', the PivotTable Fields
 *  pane's icon, on screen whenever a pivot is selected; and keep the ACCENT
 *  on the dot (a green middle pill would repeat ChartBar's "middle bar, green,
 *  longest"). */
function Slicer({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <circle cx="4.8" cy="4.8" r="2.4" fill={SOFT} />
      {pill(9.6, 2.4, 10.8, 4.8, SOFT)}
      <circle cx="4.8" cy="12" r="2.4" fill={ACCENT} />
      {pill(9.6, 9.6, 12, 4.8, STRONG)}
      <circle cx="4.8" cy="19.2" r="2.4" fill={SOFT} />
      {pill(9.6, 16.8, 8.4, 4.8, SOFT)}
    </IconFrame>
  );
}

/** Timeline (2026-10-22, the Visuals family): a left-aligned STRONG label
 *  pill (4.8 x 12) over ONE 7.2 track pill cut ONCE by THE gap at x 12..14.4:
 *  the ACCENT selected span from the start of the track (9.6) and the SOFT
 *  rest (7.2), each a D where the track ends freely. A strip, centred, every
 *  straight edge on the 2.4 grid. Cut twice, the track's two semicircular
 *  ends under the caption read as the wheels of a car. */
function Timeline({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {pill(2.4, 4.8, 12, 4.8, STRONG)}
      {dMark(2.4, 12, 9.6, 7.2, "left", ACCENT)}
      {dMark(14.4, 12, 7.2, 7.2, "right", SOFT)}
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
// The Canvas tab: Power BI's report authoring (2026-10-08)
// ============================================================================
//
// The grid-shaped visuals (Matrix, Floating Grid), the report PAGE and what
// is done to it (New Page, Page Navigator, the three Page View rows,
// Wallpaper) and Clear All Slicers. Power BI's compositions where it has a
// picture -- its blue is ACCENT, its grey SOFT, its dark outline STRONG and
// filled -- and Power BI's page-view rows from memory where its ribbon shows
// a checkbox or nothing. Until 2026-10-08 the Canvas tab drew Floating Grid
// with Table, Fit to Window with Resize and Actual Size with Search. No
// transform anywhere; every key measures 0 accent contact. The Matrix is a
// Visuals gallery tile and was redrawn in the Visuals family on 2026-10-22.

/** Matrix (the Visuals gallery's Matrix tile, a pivot table on the page):
 *  Power BI's matrix, a grid under a header with the totals -- the last
 *  column and the last row -- in blue, on the Visuals family's 3 x 3 lattice
 *  of MARK cells (4.8, THE gap apart): a SOFT header row of three cells
 *  (Power BI's grey header; the total column has a header too), two STRONG
 *  value cells (Power BI's white cells), and the ACCENT totals -- the total
 *  column under the header and the total row -- as ONE L-shaped path whose
 *  free outer corner is a true quarter circle (r 4.8, a cell's width). Its
 *  arms are 12 and 19.2: with a full-height column arm the L drew a mirrored
 *  capital "J". Power BI's exact picture is nine cells with blue totals,
 *  which is GrandTotals here (the pivot option), so the totals MERGE into the
 *  L, the shape no other key has; a STRONG header row would be Floating Grid's
 *  silhouette (a bar over cells). */
function Matrix({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="4.8" height="4.8" fill={SOFT} />
      <rect x="9.6" y="2.4" width="4.8" height="4.8" fill={SOFT} />
      <rect x="16.8" y="2.4" width="4.8" height="4.8" fill={SOFT} />
      <rect x="2.4" y="9.6" width="4.8" height="4.8" fill={STRONG} />
      <rect x="9.6" y="9.6" width="4.8" height="4.8" fill={STRONG} />
      <path d="M16.8 9.6H21.6V16.8A4.8 4.8 0 0 1 16.8 21.6H2.4V16.8H16.8Z" fill={ACCENT} />
    </IconFrame>
  );
}

/** Floating Grid (Calcula's own object, no Power BI picture): a small grid of
 *  cells that floats on the page and is moved by its title bar. ONE unbroken
 *  STRONG title bar 2.4..21.6 x 2.4..7.2 (rx 2), what you drag, over two rows
 *  of cells on the table figure's GRID columns (rows 8.4..14.4 and
 *  15.6..21.6, 5 px each, 1.2 gutters, rx 1.6), SOFT with the active cell
 *  ACCENT. Table, which drew this button until 2026-10-08 and is the Table
 *  visual's tile on the same tab, is three rows cut into cells, an ACCENT
 *  header row over two STRONG rows (HeaderRow is the table figure with ACCENT
 *  header cells);
 *  the one bar over two rows is a different shape. A thinner title over three
 *  rows smeared into the old Table at 20px; a SOFT drop shadow beside SOFT
 *  cells was two greys of one tint. */
function FloatingGrid({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="19.2" height="4.8" rx="2" fill={STRONG} />
      {[8.4, 15.6].map((y, row) =>
        GRID.map((x, col) => (
          <rect
            key={`${row}-${col}`}
            x={x}
            y={y}
            width={TRACK[col]}
            height="6"
            rx="1.6"
            fill={row === 0 && col === 0 ? ACCENT : SOFT}
          />
        )),
      )}
    </IconFrame>
  );
}

/** New Page (the Pages hero): Power BI's page with a plus at its lower right.
 *  Report's page -- SOFT, with Report's STRONG title bar 4.8..16.8 x 4.8..8.4,
 *  so it reads as a REPORT page and not a worksheet (InsertSheet) or a file
 *  -- with More's ACCENT plus (roundedPlus at half 4.2, centred (17.4, 17.4),
 *  arms 15.6..19.2) in a notch cut from the page's lower right corner. The
 *  page is 2.4..19.2 x 2.4..21.6 (outer rx 3) minus the square from (12, 12)
 *  (inner corner r 1.6): an L whose notch edges leave exactly 1.2 to the
 *  plus's tips. Portrait: a landscape page read as a card at 20px because the
 *  plus took half its height. */
function NewPage({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M5.4 2.4H16.2a3 3 0 0 1 3 3V9a3 3 0 0 1-3 3H13.6a1.6 1.6 0 0 0-1.6 1.6V18.6a3 3 0 0 1-3 3H5.4a3 3 0 0 1-3-3V5.4a3 3 0 0 1 3-3z"
        fill={SOFT}
      />
      <rect x="4.8" y="4.8" width="12" height="3.6" rx="1.6" fill={STRONG} />
      <path d={roundedPlus(17.4, 17.4, 4.2)} fill={ACCENT} />
    </IconFrame>
  );
}

/** Page Navigator (the Buttons menu's row): Power BI's row of page tabs
 *  above the page, the current one highlighted. Three 4.8 square page
 *  buttons (rx 1.6, 2.4 apart, y 3.6..8.4): the current one ACCENT, the
 *  others STRONG; under them, 2.4 clear, a SOFT page 2.4..21.6 x 10.8..20.4
 *  (rx 2.4, the page you are on). Power BI's buttons carry page names; ours
 *  are blank (no text). 3 px pills read as a carousel's pager dots. Ink
 *  3.6..20.4 tall, centred. The first drawing put the buttons UNDER the page
 *  -- a soft box over three marks on x 2.4 / 9.6 / 16.8 with the first one
 *  green, which is Legend exactly (review 0 of 2026-10-08); tabs over the
 *  page is the familiar "tabs" picture and Legend's opposite. */
function PageNavigator({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="3.6" width="4.8" height="4.8" rx="1.6" fill={ACCENT} />
      <rect x="9.6" y="3.6" width="4.8" height="4.8" rx="1.6" fill={STRONG} />
      <rect x="16.8" y="3.6" width="4.8" height="4.8" rx="1.6" fill={STRONG} />
      <rect x="2.4" y="10.8" width="19.2" height="9.6" rx="2.4" fill={SOFT} />
    </IconFrame>
  );
}

/** Clear All Slicers (the Buttons menu's row): Power BI's funnel with an
 *  eraser, said in Clear Filter's language -- a SOFT card (19.2 square, rx
 *  3.4: the panel the Slicer drew until 2026-10-22; the Slicer is now dots
 *  and pills, ICONS.md 2.5) carrying a STRONG funnel, with a DANGER X in
 *  Clear Filter's 2.8 line (arms 2.4 from (18, 18); Clear Filter's own are
 *  2.2 from (19.2, 17.6)) in a round bite out of the card's
 *  lower right: a circle r 6.094 about (18, 18), the X's reach plus its cap
 *  plus 1.3, meeting the edges at 13.083. The funnel is its own smaller
 *  polygon, not FUNNEL: mouth 4.9..15.5, a 3 px stem 8.4..12 on whole pixels,
 *  rounded by a 1.2 same-channel stroke. Card (slicers) + funnel (filter) + X
 *  (clear), and no ACCENT: DANGER is the verb. Clear Filter (a row of Home's
 *  Sort & Filter menu, not of this one) is a bare funnel with the X, so the
 *  two differ by shape. The X's round caps reach
 *  21.8 (Clear Filter's reach 22.8). A larger funnel ran its stem into the
 *  bite; the card with the old Slicer's item bars read as a list. */
function ClearSlicers({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M5.8 2.4H18.2a3.4 3.4 0 0 1 3.4 3.4V13.083A6.094 6.094 0 0 0 13.083 21.6H5.8a3.4 3.4 0 0 1-3.4-3.4V5.8a3.4 3.4 0 0 1 3.4-3.4z"
        fill={SOFT}
      />
      <path
        d="M5.5 5.4L14.9 5.4L11.4 10.2L11.4 13.8L9 15L9 10.2Z"
        fill={STRONG}
        stroke={STRONG}
        strokeWidth={1.2}
        strokeLinejoin="round"
      />
      <path d="M15.6 15.6l4.8 4.8M20.4 15.6l-4.8 4.8" {...line(DANGER, 2.8)} />
    </IconFrame>
  );
}

/** The landscape window the Page View rows Fit to Width and Actual Size draw
 *  in: 19.2 x 14.4 at 2.4..21.6 x 4.8..19.2, rx 2.4 (16 x 12 px, a 4:3
 *  page), every straight edge on the 2.4 grid. Each row cuts its own hole. */
const PAGE_WINDOW =
  "M4.8 4.8H19.2A2.4 2.4 0 0 1 21.6 7.2V16.8A2.4 2.4 0 0 1 19.2 19.2H4.8A2.4 2.4 0 0 1 2.4 16.8V7.2A2.4 2.4 0 0 1 4.8 4.8Z";

/** Fit to Page (the Page View menu's face and first row): the page held by
 *  the window's four corners, Power BI's page-view "fit" picture. A SOFT
 *  landscape page 6..18 x 7.2..16.8 (rx 1.6) and four ACCENT corner brackets
 *  as ONE PIXEL_STROKE path, centre lines on x 3.6 / 20.4 and y 4.8 / 19.2,
 *  whose inner edges sit exactly 1.2 off the page on all four sides: the
 *  window hugs the page. Resize drew Fit to Window until 2026-10-08, and
 *  Size & Position with the same picture; each now has its own. */
function FitToPage({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="6" y="7.2" width="12" height="9.6" rx="1.6" fill={SOFT} />
      <path
        d="M3.6 8.4V4.8H8.4M15.6 4.8H20.4V8.4M20.4 15.6V19.2H15.6M8.4 19.2H3.6V15.6"
        {...line(ACCENT, PIXEL_STROKE)}
      />
    </IconFrame>
  );
}

/** Fit to Width (Page View): the window and a double arrow from side to
 *  side. PAGE_WINDOW in SOFT with a HOLE 4.8..19.2 x 7.2..16.8 (rx 1.2),
 *  walls 2.4 all round, and an ACCENT double arrow 6..18 on y 12 (Size &
 *  Position's measuring arrow, longer), its tips 1.2 from the hole's sides
 *  and its heads 1.2 from the hole's top and bottom. Beside Fit to Page in
 *  the same menu: a closed frame with a level arrow against four open corners
 *  round a solid page. */
function FitToWidth({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d={`${PAGE_WINDOW}M6 7.2A1.2 1.2 0 0 0 4.8 8.4V15.6A1.2 1.2 0 0 0 6 16.8H18A1.2 1.2 0 0 0 19.2 15.6V8.4A1.2 1.2 0 0 0 18 7.2Z`}
        fill={SOFT}
      />
      <path d="M6 12L9.6 8.4V10.8H14.4V8.4L18 12L14.4 15.6V13.2H9.6V15.6Z" fill={ACCENT} />
    </IconFrame>
  );
}

/** Actual Size (Page View): "1:1" on a page, 100%. PAGE_WINDOW in SOFT with a
 *  SLOT cut through it at x 9.6..14.4, y 7.2..16.8; two STRONG ones, each a
 *  2.4 stem (x 7.2..9.6 and 16.8..19.2, y 7.2..16.8) with a 45-degree flag
 *  whose vertical edge is the whole-pixel column x 4.8 / 14.4; the colon is
 *  two ACCENT 2.4 squares (rx 0) in the slot, 1.2 clear of the stems, the flag
 *  and the slot's ends. No text. Square flat flags were crisper but read
 *  "7:7"; Power BI's "100%" would need three digits and a % at 20px. Search,
 *  which drew this button until 2026-10-08, is also Find's picture. */
function ActualSize({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d={`${PAGE_WINDOW}M9.6 7.2V16.8H14.4V7.2Z`} fill={SOFT} />
      <path d="M7.2 7.2H9.6V16.8H7.2V9.6L4.8 12V9.6Z" fill={STRONG} />
      <path d="M16.8 7.2H19.2V16.8H16.8V9.6L14.4 12V9.6Z" fill={STRONG} />
      <rect x="10.8" y="8.4" width="2.4" height="2.4" rx="0" fill={ACCENT} />
      <rect x="10.8" y="13.2" width="2.4" height="2.4" rx="0" fill={ACCENT} />
    </IconFrame>
  );
}

/** Wallpaper (Page, a ColorSwatch split: the area OUTSIDE the page): the page
 *  with its surround filled. An ACCENT surround 2.4..21.6 square (rx 3) with
 *  a landscape HOLE 4.8..19.2 x 6..18 (rx 1.2) -- walls 2.4 at the sides,
 *  3.6 above and below -- and a STRONG page 6..18 x 7.2..16.8 (rx 1.4) inside
 *  it, 1.2 clear all round. Page Background (Background: a soft sheet with
 *  accent hills) has the colour INSIDE the page, this one outside it. The
 *  page is STRONG, not SOFT, so it stays apart from Fit to Page's grey page
 *  in high contrast too. Power BI's Format-pane Wallpaper card has no
 *  picture. */
function Wallpaper({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M5.4 2.4H18.6A3 3 0 0 1 21.6 5.4V18.6A3 3 0 0 1 18.6 21.6H5.4A3 3 0 0 1 2.4 18.6V5.4A3 3 0 0 1 5.4 2.4ZM6 6A1.2 1.2 0 0 0 4.8 7.2V16.8A1.2 1.2 0 0 0 6 18H18A1.2 1.2 0 0 0 19.2 16.8V7.2A1.2 1.2 0 0 0 18 6Z"
        fill={ACCENT}
      />
      <rect x="6" y="7.2" width="12" height="9.6" rx="1.4" fill={STRONG} />
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
  // ---- the Canvas tab: Power BI's report authoring (2026-10-08) -------------
  Matrix,
  FloatingGrid,
  NewPage,
  PageNavigator,
  ClearSlicers,
  FitToPage,
  FitToWidth,
  ActualSize,
  Wallpaper,
} as const;
/* eslint-enable @typescript-eslint/naming-convention */
