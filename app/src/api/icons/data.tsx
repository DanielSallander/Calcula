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
  line,
  type RibbonIconProps,
} from "./frame";
import { FUNNEL } from "./chart";

// ============================================================================
// The table figure
// ============================================================================

/** Column lefts and row tops of the 3 x 3 cell grid: 5.6 x 5.2 cells with a
 *  1.2 gutter, filling 2.4..21.6 x 3..21. */
const GRID_X = [2.4, 9.2, 16] as const;
const GRID_Y = [3, 9.4, 15.8] as const;
const CELL_W = 5.6;
const CELL_H = 5.2;

type CellPaint = (row: number, col: number) => string;

function TableGrid({ paint }: { paint: CellPaint }): React.ReactElement {
  return (
    <>
      {GRID_Y.map((y, row) =>
        GRID_X.map((x, col) => (
          <rect
            key={`${row}-${col}`}
            x={x}
            y={y}
            width={CELL_W}
            height={CELL_H}
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

/** Banded rows: four full-width rows, every second one accent. */
function BandedRows({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {[3, 7.8, 12.6, 17.4].map((y, i) => (
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

/** Banded columns: BandedRows turned on its side. */
function BandedColumns({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {[2.4, 7.5, 12.6, 17.7].map((x, i) => (
        <rect
          key={x}
          x={x}
          y="3"
          width="3.9"
          height="18"
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
      <rect x="9.4" y="2.4" width="12.2" height="5.2" rx="2" fill={STRONG} />
      <rect x="2.4" y="9.4" width="5.2" height="12.2" rx="2" fill={STRONG} />
      <rect x="9.4" y="9.4" width="12.2" height="12.2" rx="2.4" fill={SOFT} />
      <rect x="9.4" y="9.4" width="5.6" height="5.6" rx="2" fill={ACCENT} />
    </IconFrame>
  );
}

/** Field list: rows of box + name; accent boxes are the checked fields. */
function PivotFields({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.6" width="5" height="5" rx="1.6" fill={ACCENT} />
      <rect x="10" y="3.5" width="11.6" height="3.2" rx="1.6" fill={STRONG} />
      <rect x="2.4" y="9.5" width="5" height="5" rx="1.6" fill={ACCENT} />
      <rect x="10" y="10.4" width="11.6" height="3.2" rx="1.6" fill={STRONG} />
      <rect x="2.4" y="16.4" width="5" height="5" rx="1.6" fill={SOFT} />
      <rect x="10" y="17.3" width="11.6" height="3.2" rx="1.6" fill={SOFT} />
    </IconFrame>
  );
}

/** Calculated field: a soft column with a strong header, and the accent
 *  equals sign that makes it computed. */
function CalcField({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.8" width="9.4" height="18.4" rx="2.6" fill={SOFT} />
      <rect x="2.4" y="2.8" width="9.4" height="4.6" rx="2.3" fill={STRONG} />
      <rect x="14.4" y="8.6" width="7.2" height="3" rx="1.5" fill={ACCENT} />
      <rect x="14.4" y="13.4" width="7.2" height="3" rx="1.5" fill={ACCENT} />
    </IconFrame>
  );
}

/** Report filter pages: a strong page in front of a soft one, the accent
 *  funnel on the front page. The funnel's stroke in the same channel only
 *  rounds its corners (ACCENT is opaque, so fill and stroke do not compound). */
function FilterPages({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="8.6" y="2.4" width="13" height="13" rx="2.6" fill={SOFT} />
      <rect x="2.4" y="8.6" width="13" height="13" rx="2.6" fill={STRONG} />
      <path
        d="M5 11.6h7.8l-2.9 3.5v3.3l-2 1v-4.3z"
        fill={ACCENT}
        stroke={ACCENT}
        strokeWidth={1}
        strokeLinejoin="round"
      />
    </IconFrame>
  );
}

/** Subtotals: soft detail rows, each group closed by an accent subtotal. */
function Subtotals({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="6.4" y="2.6" width="15.2" height="3.8" rx="1.6" fill={SOFT} />
      <rect x="2.4" y="7.6" width="19.2" height="3.8" rx="1.6" fill={ACCENT} />
      <rect x="6.4" y="12.6" width="15.2" height="3.8" rx="1.6" fill={SOFT} />
      <rect x="2.4" y="17.6" width="19.2" height="3.8" rx="1.6" fill={ACCENT} />
    </IconFrame>
  );
}

/** Report layout: strong outer labels, accent inner (indented) labels, soft
 *  values — the compact/outline/tabular choice is about exactly that indent. */
function ReportLayout({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="3" width="9" height="4" rx="1.6" fill={STRONG} />
      <rect x="13" y="3" width="8.6" height="4" rx="1.6" fill={SOFT} />
      <rect x="6" y="10" width="5.4" height="4" rx="1.6" fill={ACCENT} />
      <rect x="13" y="10" width="8.6" height="4" rx="1.6" fill={SOFT} />
      <rect x="6" y="17" width="5.4" height="4" rx="1.6" fill={ACCENT} />
      <rect x="13" y="17" width="8.6" height="4" rx="1.6" fill={SOFT} />
    </IconFrame>
  );
}

/** Blank rows: two groups of rows, the accent dash marks the empty row
 *  inserted between them. */
function BlankRows({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.5" width="19.2" height="3" rx="1.5" fill={STRONG} />
      <rect x="2.4" y="6.5" width="19.2" height="3" rx="1.5" fill={SOFT} />
      <rect x="2.4" y="10.5" width="6" height="3" rx="1.5" fill={ACCENT} />
      <rect x="2.4" y="14.5" width="19.2" height="3" rx="1.5" fill={STRONG} />
      <rect x="2.4" y="18.5" width="19.2" height="3" rx="1.5" fill={SOFT} />
    </IconFrame>
  );
}

/** Expand / Collapse (a pivot or outline button): a soft box, the accent sign
 *  is the verb. */
function Expand({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="3" y="3" width="18" height="18" rx="3.6" fill={SOFT} />
      <path d="M12 7.6v8.8M7.6 12h8.8" {...line(ACCENT)} />
    </IconFrame>
  );
}

function Collapse({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="3" y="3" width="18" height="18" rx="3.6" fill={SOFT} />
      <path d="M7.6 12h8.8" {...line(ACCENT)} />
    </IconFrame>
  );
}

/** Clear filter: the soft funnel with the danger X in its empty corner. */
function ClearFilter({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d={FUNNEL} fill={SOFT} />
      <path d="M17 14.8l4.6 4.6M21.6 14.8L17 19.4" {...line(DANGER, 2.8)} />
    </IconFrame>
  );
}

// ============================================================================
// Slicers, timelines, sparklines
// ============================================================================

/** Slicer: a soft panel of item buttons; the accent item is selected. */
function Slicer({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="19.2" height="19.2" rx="3.4" fill={SOFT} />
      <rect x="5.4" y="5.6" width="13.2" height="3.4" rx="1.7" fill={ACCENT} />
      <rect x="5.4" y="10.3" width="13.2" height="3.4" rx="1.7" fill={STRONG} />
      <rect x="5.4" y="15" width="13.2" height="3.4" rx="1.7" fill={STRONG} />
    </IconFrame>
  );
}

/** Timeline: a strong caption over a soft track; the accent span is the
 *  selected period. */
function Timeline({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="4" width="9" height="3.2" rx="1.6" fill={STRONG} />
      <rect x="2.4" y="10.4" width="19.2" height="7.6" rx="2.4" fill={SOFT} />
      <rect x="9.2" y="10.4" width="7.6" height="7.6" rx="2.4" fill={ACCENT} />
    </IconFrame>
  );
}

/** The soft cell every sparkline glyph is drawn inside. */
function SparkCell(): React.ReactElement {
  return <rect x="2.4" y="4" width="19.2" height="16" rx="3" fill={SOFT} />;
}

/** Sparkline (the feature): a strong line in a cell, the accent last point. */
function Sparkline({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <SparkCell />
      <path d="M5.6 15.4l3.8-4.4 3.4 2.8 4-4.6" {...line(STRONG, 2.6)} />
      <circle cx="17.8" cy="8.4" r="2.4" fill={ACCENT} />
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
      <rect x="5.8" y="12" width="3.4" height="5" rx="1.4" fill={ACCENT} />
      <rect x="10.3" y="7.2" width="3.4" height="9.8" rx="1.4" fill={ACCENT} />
      <rect x="14.8" y="10.4" width="3.4" height="6.6" rx="1.4" fill={ACCENT} />
    </IconFrame>
  );
}

/** Win/loss: strong wins above the midline, the accent loss below it. */
function SparkWinLoss({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <SparkCell />
      <rect x="4.2" y="7" width="3" height="4.6" rx="1.4" fill={STRONG} />
      <rect x="8.4" y="7" width="3" height="4.6" rx="1.4" fill={STRONG} />
      <rect x="12.6" y="12.4" width="3" height="4.6" rx="1.4" fill={ACCENT} />
      <rect x="16.8" y="7" width="3" height="4.6" rx="1.4" fill={STRONG} />
    </IconFrame>
  );
}

// ============================================================================
// BI and sources
// ============================================================================

/** Report: a soft page, a strong title, an accent chart. */
function Report({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="3.6" y="2.4" width="16.8" height="19.2" rx="3" fill={SOFT} />
      <rect x="6.4" y="5.4" width="11.2" height="3" rx="1.5" fill={STRONG} />
      <rect x="6.4" y="13" width="3" height="5.6" rx="1.4" fill={ACCENT} />
      <rect x="10.5" y="10.4" width="3" height="8.2" rx="1.4" fill={ACCENT} />
      <rect x="14.6" y="14.4" width="3" height="4.2" rx="1.4" fill={ACCENT} />
    </IconFrame>
  );
}

/** Function (fx): a strong hooked f and an accent x, drawn as strokes. */
function Fx({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M14.4 4.2h-1.8a2.8 2.8 0 0 0-2.8 2.8v10.4a2.8 2.8 0 0 1-2.8 2.8H5.4"
        {...line(STRONG, 2.8)}
      />
      <path d="M6.6 10.4h5.8" {...line(STRONG, 2.8)} />
      <path d="M15.4 12.4l5 6.2M20.4 12.4l-5 6.2" {...line(ACCENT, 2.8)} />
    </IconFrame>
  );
}

/** Change data source: the soft data block with its strong header, and the
 *  accent arrow feeding a new range into it. */
function ChangeSource({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="3.2" width="12.8" height="17.6" rx="2.8" fill={SOFT} />
      <path
        d="M5.2 3.2h7.2a2.8 2.8 0 0 1 2.8 2.8v2H2.4V6a2.8 2.8 0 0 1 2.8-2.8z"
        fill={STRONG}
      />
      <path d="M21.6 14.2H12.4M15.4 11.2l-3 3 3 3" {...line(ACCENT, 2.8)} />
    </IconFrame>
  );
}

/** Connection: a strong source node joined by a soft link to the accent
 *  destination node. */
function Connection({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M6 12h12" {...line(SOFT)} />
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
 *  fonts and colours together, which is what a document theme is. */
function Theme({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="19.2" height="19.2" rx="3.4" fill={SOFT} />
      <path d="M5.4 17.6L9 6.6h1.6l3.6 11" {...line(STRONG, 2.8)} />
      <path d="M7 13.8h5.6" {...line(STRONG, 2.6)} />
      <rect x="16.2" y="12.4" width="3.6" height="5.2" rx="1.4" fill={ACCENT} />
    </IconFrame>
  );
}

/** Fonts: "Aa" — a strong capital and an accent lowercase, both as strokes. */
function Fonts({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M1.8 19.6L6.6 5.4h2.2l4.8 14.2" {...line(STRONG)} />
      <path d="M4.2 14.6h6.8" {...line(STRONG, 2.6)} />
      <circle cx="18.6" cy="16.2" r="2.6" {...line(ACCENT, 2.6)} />
      <path d="M21.2 13.2v6.6" {...line(ACCENT, 2.6)} />
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
      <rect x="8.6" y="8.6" width="13" height="13" rx="3" fill={SOFT} />
      <rect x="2.4" y="2.4" width="13" height="13" rx="3" fill={STRONG} />
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
      <rect x="5.2" y="5.2" width="8" height="5.6" rx="1.6" fill={STRONG} />
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
      <rect x="2.4" y="2.4" width="11" height="19.2" rx="2.6" fill={SOFT} />
      <rect x="9.2" y="12" width="12.4" height="9.6" rx="2.6" fill={STRONG} />
      <path d="M14.8 4.2h2.2a2.6 2.6 0 0 1 2.6 2.6v2.4M17.2 7.2l2.4 2.4 2.4-2.4" {...line(ACCENT, 2.6)} />
    </IconFrame>
  );
}

/** Page size: a strong page inside a larger soft one, the accent arrow
 *  pulling out to the larger size. */
function PageSize({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="19.2" height="19.2" rx="3.2" fill={SOFT} />
      <rect x="2.4" y="2.4" width="10" height="12.6" rx="3.2" fill={STRONG} />
      <path d="M14.6 14.6l5 5M19.6 14.8v4.8h-4.8" {...line(ACCENT, 2.8)} />
    </IconFrame>
  );
}

/** Print area: a soft page with the accent region that will print. */
function PrintArea({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="3.6" y="2.4" width="16.8" height="19.2" rx="3" fill={SOFT} />
      <rect x="6.6" y="5.4" width="10.8" height="8.4" rx="1.8" fill={ACCENT} />
    </IconFrame>
  );
}

/** Breaks: two soft pages cut by the accent dashed page break. */
function Breaks({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="3.6" y="2.4" width="16.8" height="6.8" rx="2.4" fill={SOFT} />
      <rect x="3.6" y="14.8" width="16.8" height="6.8" rx="2.4" fill={SOFT} />
      <rect x="2.4" y="10.5" width="4.4" height="3" rx="1.5" fill={ACCENT} />
      <rect x="9.8" y="10.5" width="4.4" height="3" rx="1.5" fill={ACCENT} />
      <rect x="17.2" y="10.5" width="4.4" height="3" rx="1.5" fill={ACCENT} />
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
