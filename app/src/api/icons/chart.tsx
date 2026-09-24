//! FILENAME: app/src/api/icons/chart.tsx
// PURPOSE: The chart glyphs: every chart TYPE, the chart FURNITURE (title,
//          gridlines, legend, labels...) and the chart ACTIONS.
// CONTEXT: The two families follow two halves of one rule, set by the approved
//          mockup (Main.dc.html / Icons.dc.html):
//
//          - A chart-TYPE icon is monochrome duotone: soft axes as the ground,
//            strong marks, and the ACCENT on exactly one series — the series
//            the picture is about. Office's blue/orange/grey type icons were
//            dropped on purpose: a categorical palette in chrome ignores the
//            skin, and a Dark user saw light-theme blue on a dark tile. If the
//            owner ever wants the categorical variant back it is a one-file
//            swap here, not a change to any caller.
//          - A FURNITURE icon is a soft chart body with the ACCENT on the
//            element the icon names: the title bar, the gridlines, the legend
//            keys, the axis labels. You find "Legend" by looking for the
//            highlighted legend, not by reading the tooltip.
//
//          Column, Bar, Line, Area, Pie, Donut, Scatter, the furniture and the
//          actions are the mockup's drawings. The remaining types
//          (Waterfall ... Pareto), SecondaryAxis and the four line-style
//          glyphs are drawn here in the same language.
//
//          Pixel grid (2026-09-24 sharpen pass): every horizontal and vertical
//          edge sits on a multiple of PIXEL_GRID (1.2 units, one device pixel
//          at 20px), so straight edges paint crisp at 100% instead of as a
//          half-covered grey pixel. That is why bars are 2.4 / 3.6 / 4.8 / 6
//          wide with 1.2 or 2.4 gaps, why the soft axes are lines 2.4 (PIXEL_STROKE)
//          thick, and why a column stops at 18, one clean pixel above the
//          Baseline at 19.2. Where it cost nothing at 100%, an edge sits on a
//          multiple of 2.4, which is also crisp at 150%. Only diagonals,
//          curves and round caps still antialias.
//
//          The HERO tiles of the Chart Design band draw at 30px (0.8 units per
//          device pixel), where only a multiple of 2.4 is crisp: the six quick
//          types (Column, Bar, Line, Area, Pie, Scatter), MarkOptions,
//          SwitchRowCol, FormatPoint and Code. Those put every straight edge
//          they can on the 2.4 grid (Column, Bar and FormatPoint therefore use
//          2.4 gaps where their siblings use 1.2), so they are crisp at 20px
//          AND at 30px. MarkOptions' middle rail is the exception: three evenly
//          spaced 2.4 rails centred on 12 can never all land on the 2.4 grid.
//          The gallery (24px) and the band's tall segments (28px) cannot
//          be crisp on this grid: of the multiples of 1.2, only 6, 12 and 18
//          are whole pixels there.
//
//          EditChart and SaveImage are the generic Pencil and Download
//          drawings under a chart key — the mockup draws them identically, and
//          re-using the component keeps the two keys from drifting apart.

import React from "react";
import {
  IconFrame,
  SOFT,
  STRONG,
  ACCENT,
  PIXEL_STROKE,
  line,
  type RibbonIconProps,
} from "./frame";
import { Pencil, Download } from "./generic";

// ============================================================================
// Shared ground
// ============================================================================

/** The soft category axis under a column-family chart: 2.4..21.6 x
 *  19.2..21.6, a line PIXEL_STROKE thick (two whole pixels at 20px, three at
 *  30px, so it is crisp at 100% AND 150%; a 3.6 axis always has one edge on a
 *  half pixel at 150%). A column above it stops at 18, so one clean pixel of
 *  background separates the two (and the accent column keeps its 1.2 from
 *  the grey). */
function Baseline(): React.ReactElement {
  return <rect x="2.4" y="19.2" width="19.2" height="2.4" rx="1.2" fill={SOFT} />;
}

/** The soft L of an x/y chart (line, scatter, bubble, trendline), drawn as
 *  ONE path. It was two overlapping rects, and SOFT is translucent, so the
 *  corner painted twice: at the 50% tint that joint is a dark knot only 2.2:1
 *  from STRONG. Both arms are lines PIXEL_STROKE thick on the pixel grid, like
 *  the Baseline: the vertical arm is x 2.4..4.8 and rises to 2.4, the
 *  horizontal arm is y 19.2..21.6 and runs to 21.6, so each round end fills
 *  exactly one pixel row or column. */
function Axes(): React.ReactElement {
  return (
    <path
      d="M2.4 3.6A1.2 1.2 0 0 1 4.8 3.6V19.2H20.4A1.2 1.2 0 0 1 20.4 21.6H3.6A1.2 1.2 0 0 1 2.4 20.4Z"
      fill={SOFT}
    />
  );
}

// ============================================================================
// Chart types
// ============================================================================

/** Column (a 30px hero tile): three 4.8 columns with 2.4 gaps at
 *  2.4 / 9.6 / 16.8, tops 9.6 / 2.4 / 7.2, so every side and top is on the
 *  2.4 grid (crisp at 20px and 30px); only the bottoms at 18 sit on the 1.2
 *  grid, to keep one pixel above the Baseline. */
function ChartColumn({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <Baseline />
      <rect x="2.4" y="9.6" width="4.8" height="8.4" rx="1.6" fill={STRONG} />
      <rect x="9.6" y="2.4" width="4.8" height="15.6" rx="1.6" fill={ACCENT} />
      <rect x="16.8" y="7.2" width="4.8" height="10.8" rx="1.6" fill={STRONG} />
    </IconFrame>
  );
}

/** Bar (a 30px hero tile): a 2.4 soft axis at x 2.4..4.8, y 2.4..21.6, and
 *  three 4.8 bars with 2.4 gaps at y 2.4 / 9.6 / 16.8, starting at x 7.2
 *  (lengths 9.6 / 14.4 / 7.2). Every edge is on the 2.4 grid. */
function ChartBar({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="2.4" height="19.2" rx="1.2" fill={SOFT} />
      <rect x="7.2" y="2.4" width="9.6" height="4.8" rx="1.6" fill={STRONG} />
      <rect x="7.2" y="9.6" width="14.4" height="4.8" rx="1.6" fill={ACCENT} />
      <rect x="7.2" y="16.8" width="7.2" height="4.8" rx="1.6" fill={STRONG} />
    </IconFrame>
  );
}

function ChartLine({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <Axes />
      <path d="M7.5 14.5l4-5 4 3 5-6.5" {...line(ACCENT)} />
    </IconFrame>
  );
}

/** Area (a 30px hero tile): the area stands on the Baseline from x 4.8 to
 *  19.2, leaving an equal 2.4 foot of axis at each end; its bottom and both
 *  sides are on the 2.4 grid. */
function ChartArea({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <Baseline />
      <path d="M4.8 19.2V13.8L8.7 9l4 3 5.3-6.5 1.2 0.9V19.2z" fill={SOFT} />
      <path d="M4.8 13.8L8.7 9l4 3 5.3-6.5" {...line(ACCENT)} />
    </IconFrame>
  );
}

function ChartPie({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <circle cx="12" cy="12" r="9.5" fill={SOFT} />
      <path d="M12 2.5A9.5 9.5 0 0 1 21.5 12H12z" fill={ACCENT} />
      <path d="M12 12h9.5a9.5 9.5 0 0 1-5.9 8.8z" fill={STRONG} />
    </IconFrame>
  );
}

function ChartDonut({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M12 2.5a9.5 9.5 0 1 0 0 19 9.5 9.5 0 0 0 0-19zm0 5.8a3.7 3.7 0 1 1 0 7.4 3.7 3.7 0 0 1 0-7.4z"
        fill={SOFT}
      />
      <path d="M12 2.5A9.5 9.5 0 0 1 21.5 12h-5.8A3.7 3.7 0 0 0 12 8.3z" fill={ACCENT} />
    </IconFrame>
  );
}

function ChartScatter({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <Axes />
      <circle cx="9" cy="14" r="2.8" fill={STRONG} />
      <circle cx="14" cy="8.6" r="2.8" fill={ACCENT} />
      <circle cx="18.6" cy="12.6" r="2.8" fill={STRONG} />
    </IconFrame>
  );
}

/** Waterfall: a start column, two floating increases climbing a staircase,
 *  and the total; the accent step is the change being explained. Four 3.6
 *  columns with 1.2 gaps: a 6-tall start, then two 4.8 steps (18 / 12 / 7.2
 *  / 2.4). rx is 1.0, not 1.4: on a 3px column 1.4 paints a short step as a
 *  plus sign (the MergeCells finding). */
function ChartWaterfall({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <Baseline />
      <rect x="2.4" y="12" width="3.6" height="6" rx="1" fill={STRONG} />
      <rect x="7.2" y="7.2" width="3.6" height="4.8" rx="1" fill={STRONG} />
      <rect x="12" y="2.4" width="3.6" height="4.8" rx="1" fill={ACCENT} />
      <rect x="16.8" y="2.4" width="3.6" height="15.6" rx="1" fill={STRONG} />
    </IconFrame>
  );
}

/** Combo: strong columns with the accent line series riding above them. The
 *  line zigzags like ChartLine's — a two-segment line over three columns
 *  read as a roof or a check mark, not as a second series. */
function ChartCombo({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <Baseline />
      <rect x="3.6" y="12" width="4.8" height="6" rx="1.6" fill={STRONG} />
      <rect x="9.6" y="10.8" width="4.8" height="7.2" rx="1.6" fill={STRONG} />
      <rect x="15.6" y="10.8" width="4.8" height="7.2" rx="1.6" fill={STRONG} />
      <path d="M3.8 9.6L9 5.2l5.8 3.4 5.4-5.2" {...line(ACCENT)} />
    </IconFrame>
  );
}

/** Radar: a soft pentagon web with the accent series polygon inside it. The
 *  pentagon's flat bottom edge sits on the pixel grid at y 20.4. */
function ChartRadar({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M10.38 3.49Q12 2.31 13.62 3.49L19.89 8.04Q21.51 9.22 20.89 11.12L18.5 18.5Q17.88 20.4 15.88 20.4L8.12 20.4Q6.12 20.4 5.5 18.5L3.11 11.12Q2.49 9.22 4.11 8.04Z"
        fill={SOFT}
      />
      <path
        d="M11.17 5.38Q12 4.51 12.85 5.36L17.05 9.54Q17.9 10.39 17.65 11.56L16.48 16.96Q16.23 18.13 15.07 17.81L10.34 16.51Q9.18 16.19 8.64 15.12L6.83 11.53Q6.29 10.46 7.12 9.59Z"
        fill={ACCENT}
      />
    </IconFrame>
  );
}

/** Bubble: scatter with a third dimension; the accent bubble is the big one. */
function ChartBubble({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <Axes />
      <circle cx="8.8" cy="14.6" r="2.4" fill={STRONG} />
      <circle cx="13.6" cy="8.6" r="4" fill={ACCENT} />
      <circle cx="18" cy="14.4" r="2.8" fill={STRONG} />
    </IconFrame>
  );
}

/** Histogram: adjacent bins in a bell; the accent bin is the mode. Five bins
 *  do not fit 3.6 wide with a clean gap, so each is 2.4 (two whole pixels)
 *  with a 1.2 gap: 3.6..20.4. Bins that touched merged into stepped blobs. */
function ChartHistogram({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <Baseline />
      <rect x="3.6" y="13.2" width="2.4" height="4.8" rx="1.2" fill={STRONG} />
      <rect x="7.2" y="9.6" width="2.4" height="8.4" rx="1.2" fill={STRONG} />
      <rect x="10.8" y="4.8" width="2.4" height="13.2" rx="1.2" fill={ACCENT} />
      <rect x="14.4" y="8.4" width="2.4" height="9.6" rx="1.2" fill={STRONG} />
      <rect x="18" y="12" width="2.4" height="6" rx="1.2" fill={STRONG} />
    </IconFrame>
  );
}

/** Funnel: centred stages narrowing downward; the accent stage is the one
 *  being examined. */
function ChartFunnel({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="3.6" width="19.2" height="3.6" rx="1.6" fill={STRONG} />
      <rect x="4.8" y="8.4" width="14.4" height="3.6" rx="1.6" fill={STRONG} />
      <rect x="7.2" y="13.2" width="9.6" height="3.6" rx="1.6" fill={ACCENT} />
      <rect x="9.6" y="18" width="4.8" height="3.6" rx="1.6" fill={STRONG} />
    </IconFrame>
  );
}

/** Treemap: nested rectangles by size; the accent tile is the named node. */
function ChartTreemap({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="9.6" height="19.2" rx="2.4" fill={STRONG} />
      <rect x="13.2" y="2.4" width="8.4" height="9.6" rx="2.4" fill={ACCENT} />
      <rect x="13.2" y="13.2" width="3.6" height="8.4" rx="1.6" fill={SOFT} />
      <rect x="18" y="13.2" width="3.6" height="8.4" rx="1.6" fill={SOFT} />
    </IconFrame>
  );
}

/** Stock: three candlesticks, wick behind body; the accent candle is the one
 *  that closed up. The wicks are PIXEL_STROKE lines on the pixel grid
 *  (x 6 / 12 / 18), each centred in a 4.8-wide body. */
function ChartStock({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <Baseline />
      <path d="M6 4.6V16" {...line(STRONG, PIXEL_STROKE)} />
      <rect x="3.6" y="7.2" width="4.8" height="6" rx="1.6" fill={STRONG} />
      <path d="M12 3V12.6" {...line(ACCENT, PIXEL_STROKE)} />
      <rect x="9.6" y="4.8" width="4.8" height="4.8" rx="1.6" fill={ACCENT} />
      <path d="M18 7.6V16.4" {...line(STRONG, PIXEL_STROKE)} />
      <rect x="15.6" y="9.6" width="4.8" height="4.8" rx="1.6" fill={STRONG} />
    </IconFrame>
  );
}

/** Box plot: two boxes with capped whiskers — the caps are what tell it
 *  apart from Stock's candles at a glance. Whiskers and caps are
 *  PIXEL_STROKE lines on the pixel grid (x 7.2 / 16.8), each centred in a
 *  7.2-wide box. */
function ChartBoxPlot({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M5.8 4.8h2.8M7.2 4.8v14.4M5.8 19.2h2.8" {...line(STRONG, PIXEL_STROKE)} />
      <rect x="3.6" y="8.4" width="7.2" height="7.2" rx="1.6" fill={STRONG} />
      <path d="M15.4 3.6h2.8M16.8 3.6v14.4M15.4 18h2.8" {...line(ACCENT, PIXEL_STROKE)} />
      <rect x="13.2" y="7.2" width="7.2" height="7.2" rx="1.6" fill={ACCENT} />
    </IconFrame>
  );
}

/** Sunburst: a strong root, a soft ring of children, the accent child. */
function ChartSunburst({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 4a6 6 0 1 1 0 12 6 6 0 0 1 0-12z"
        fill={SOFT}
      />
      <path d="M12 2A10 10 0 0 1 20.66 17L17.2 15A6 6 0 0 0 12 6z" fill={ACCENT} />
      <circle cx="12" cy="12" r="4.2" fill={STRONG} />
    </IconFrame>
  );
}

/** Pareto: descending strong columns and the accent cumulative line. */
function ChartPareto({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <Baseline />
      <rect x="3.6" y="8.4" width="4.8" height="9.6" rx="1.6" fill={STRONG} />
      <rect x="9.6" y="12" width="4.8" height="6" rx="1.6" fill={STRONG} />
      <rect x="15.6" y="14.4" width="4.8" height="3.6" rx="1.6" fill={STRONG} />
      <path d="M5.8 8C9.5 5.4 13 4.2 18.2 3.4" {...line(ACCENT)} />
    </IconFrame>
  );
}

// ============================================================================
// Furniture: soft body, the accent is the element the icon names
// ============================================================================

/** Chart title: the accent title pill (4.8..19.2 x 2.4..7.2, fully round
 *  ends) over the soft chart body (2.4..21.6 x 9.6..21.6). */
function ChartTitle({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="9.6" width="19.2" height="12" rx="3.2" fill={SOFT} />
      <rect x="4.8" y="2.4" width="14.4" height="4.8" rx="2.4" fill={ACCENT} />
    </IconFrame>
  );
}

/** Gridlines: the accent rules run edge to edge of the soft body, so they
 *  carry no corner radius of their own (the body's rounding is above and
 *  below them). Body 2.4..21.6 square; two rules PIXEL_STROKE (2.4) thick at
 *  7.2 and 14.4 leave three equal 4.8 soft bands, every edge on a multiple
 *  of 2.4 (crisp at 100% and 150%). */
function Gridlines({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="19.2" height="19.2" rx="3.2" fill={SOFT} />
      <rect x="2.4" y="7.2" width="19.2" height="2.4" fill={ACCENT} />
      <rect x="2.4" y="14.4" width="19.2" height="2.4" fill={ACCENT} />
    </IconFrame>
  );
}

/** Legend: the soft chart body above a legend row of two accent keys and a
 *  strong line key (a 2.4 pill), on 4.8 columns with 2.4 gaps like
 *  AxisLabels. */
function Legend({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="19.2" height="12" rx="3.2" fill={SOFT} />
      <rect x="2.4" y="16.8" width="4.8" height="4.8" rx="1.8" fill={ACCENT} />
      <rect x="9.6" y="18" width="4.8" height="2.4" rx="1.2" fill={STRONG} />
      <rect x="16.8" y="16.8" width="4.8" height="4.8" rx="1.8" fill={ACCENT} />
    </IconFrame>
  );
}

/** Axis labels: three accent label pills under the soft chart body, 4.8 wide
 *  with 2.4 gaps (the same columns as Legend's keys). At 1.5-unit gaps the
 *  three read as one striped bar at 20px. */
function AxisLabels({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="19.2" height="13.2" rx="3.2" fill={SOFT} />
      <rect x="2.4" y="18" width="4.8" height="3.6" rx="1.8" fill={ACCENT} />
      <rect x="9.6" y="18" width="4.8" height="3.6" rx="1.8" fill={ACCENT} />
      <rect x="16.8" y="18" width="4.8" height="3.6" rx="1.8" fill={ACCENT} />
    </IconFrame>
  );
}

function DataLabels({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <Baseline />
      <rect x="3.6" y="10.8" width="6" height="7.2" rx="1.7" fill={STRONG} />
      <rect x="14.4" y="8.4" width="6" height="9.6" rx="1.7" fill={STRONG} />
      <rect x="2.4" y="4.8" width="8.4" height="4.8" rx="2.4" fill={ACCENT} />
      <rect x="13.2" y="2.4" width="8.4" height="4.8" rx="2.4" fill={ACCENT} />
    </IconFrame>
  );
}

/** Secondary axis: the soft primary axis on the left, the accent axis on the
 *  right is the one the icon names. Both axes are lines PIXEL_STROKE (2.4)
 *  wide, like the Baseline; the two 3.6 columns between them leave three
 *  equal 2.4 gaps. */
function SecondaryAxis({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="2.4" height="19.2" rx="1.2" fill={SOFT} />
      <rect x="19.2" y="2.4" width="2.4" height="19.2" rx="1.2" fill={ACCENT} />
      <rect x="7.2" y="12" width="3.6" height="9.6" rx="1.6" fill={STRONG} />
      <rect x="13.2" y="7.2" width="3.6" height="14.4" rx="1.6" fill={STRONG} />
    </IconFrame>
  );
}

// ============================================================================
// Grouping and marks
// ============================================================================

function Grouped({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <Baseline />
      <rect x="2.4" y="8.4" width="3.6" height="9.6" rx="1.4" fill={STRONG} />
      <rect x="7.2" y="12" width="3.6" height="6" rx="1.4" fill={ACCENT} />
      <rect x="13.2" y="6" width="3.6" height="12" rx="1.4" fill={STRONG} />
      <rect x="18" y="9.6" width="3.6" height="8.4" rx="1.4" fill={ACCENT} />
    </IconFrame>
  );
}

function Stacked({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <Baseline />
      <rect x="4.8" y="12" width="6" height="6" rx="1.6" fill={STRONG} />
      <rect x="4.8" y="4.8" width="6" height="6" rx="1.6" fill={ACCENT} />
      <rect x="13.2" y="8.4" width="6" height="9.6" rx="1.6" fill={STRONG} />
      <rect x="13.2" y="2.4" width="6" height="4.8" rx="1.6" fill={ACCENT} />
    </IconFrame>
  );
}

function Stacked100({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <Baseline />
      <rect x="4.8" y="9.6" width="6" height="8.4" rx="1.6" fill={STRONG} />
      <rect x="4.8" y="2.4" width="6" height="6" rx="1.6" fill={ACCENT} />
      <rect x="13.2" y="7.2" width="6" height="10.8" rx="1.6" fill={STRONG} />
      <rect x="13.2" y="2.4" width="6" height="3.6" rx="1.6" fill={ACCENT} />
    </IconFrame>
  );
}

function Trendline({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <Axes />
      <path d="M6.8 16L19.5 5" {...line(ACCENT)} />
      <circle cx="9.2" cy="14.2" r="2.5" fill={STRONG} />
      <circle cx="16.6" cy="8" r="2.5" fill={STRONG} />
    </IconFrame>
  );
}

/** Mark options: marks sitting on soft rails; the accent mark is the one
 *  being styled. The rails are lines PIXEL_STROKE (2.4) thick, centred on
 *  the pixel grid at y 6 / 12 / 18, and each mark is centred on its rail. */
function MarkOptions({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="4.8" width="19.2" height="2.4" rx="1.2" fill={SOFT} />
      <rect x="2.4" y="10.8" width="19.2" height="2.4" rx="1.2" fill={SOFT} />
      <rect x="2.4" y="16.8" width="19.2" height="2.4" rx="1.2" fill={SOFT} />
      <circle cx="8" cy="6" r="3.4" fill={ACCENT} />
      <circle cx="16.4" cy="12" r="3.4" fill={STRONG} />
      <circle cx="10.6" cy="18" r="3.4" fill={STRONG} />
    </IconFrame>
  );
}

/** Line shape: straight / smooth / step. The three share a baseline; straight
 *  and smooth pass through the same four points and the step takes the same
 *  first rise and fall, so the only difference you see is the
 *  interpolation, which is the choice being offered. */
function LineStraight({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <Baseline />
      <path d="M4 14L9.4 7.6l5.6 4.4 5-6.4" {...line(ACCENT)} />
    </IconFrame>
  );
}

function LineSmooth({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <Baseline />
      <path d="M4 14C6.4 9 7.6 7.6 9.4 7.6c2.6 0 3 4.4 5.6 4.4 1.8 0 3.2-2.2 5-6.4" {...line(ACCENT)} />
    </IconFrame>
  );
}

/** Step: every run is horizontal or vertical, so it is a PIXEL_STROKE line
 *  whose runs sit on the pixel grid (y 14.4 / 7.2 / 12, x 8.4 / 14.4). */
function LineStep({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <Baseline />
      <path d="M3.8 14.4H8.4V7.2h6v4.8h5.8" {...line(ACCENT, PIXEL_STROKE)} />
    </IconFrame>
  );
}

/** Markers: a strong line whose accent points are the named element. */
function Markers({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <Baseline />
      <path d="M5 14l6-6.4 4.6 4.4 4.6-5.8" {...line(STRONG, 2.6)} />
      <circle cx="5" cy="14" r="2.6" fill={ACCENT} />
      <circle cx="11" cy="7.6" r="2.6" fill={ACCENT} />
      <circle cx="15.6" cy="12" r="2.6" fill={ACCENT} />
      <circle cx="20.2" cy="6.2" r="2.6" fill={ACCENT} />
    </IconFrame>
  );
}

// ============================================================================
// Style and data
// ============================================================================

function Palette({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M12 2.5c5.3 0 9.5 3.9 9.5 8.6 0 2.9-2.3 5.2-5.2 5.2h-1.6c-1 0-1.9.8-1.9 1.9 0 .5.2.9.4 1.2.3.4.5.8.5 1.2 0 1-.8 1.9-1.7 1.9C6.8 22.5 2.5 18.2 2.5 12.5S6.8 2.5 12 2.5z"
        fill={SOFT}
      />
      <circle cx="7.4" cy="12.6" r="2.2" fill={STRONG} />
      <circle cx="10.2" cy="7.6" r="2.2" fill={ACCENT} />
      <circle cx="15.8" cy="7.4" r="2.2" fill={STRONG} />
    </IconFrame>
  );
}

function Series({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="3.6" width="19.2" height="4.8" rx="2" fill={ACCENT} />
      <rect x="2.4" y="9.6" width="19.2" height="4.8" rx="2" fill={SOFT} />
      <rect x="2.4" y="15.6" width="19.2" height="4.8" rx="2" fill={SOFT} />
    </IconFrame>
  );
}

/** The funnel outline, shared with Data's ClearFilter. Its top edge (y 3.6)
 *  and its 4.8-wide stem (x 9.6..14.4) sit on the pixel grid. */
export const FUNNEL =
  "M3.2 3.6h17.6a1.6 1.6 0 0 1 1.2 2.65L14.4 14.1v5.5a1.6 1.6 0 0 1-2.3 1.44l-1.6-.8a1.6 1.6 0 0 1-.9-1.44V14.1L2 6.25A1.6 1.6 0 0 1 3.2 3.6z";

/** Filter: a soft funnel; the accent stem is what passes through it, exactly
 *  as wide as the funnel's stem. */
function Filter({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d={FUNNEL} fill={SOFT} />
      <rect x="9.6" y="12" width="4.8" height="9.6" rx="1.8" fill={ACCENT} />
    </IconFrame>
  );
}

/** Switch row/column (a 30px hero tile): two opposed arrows, the accent one
 *  is the swap. Each shaft is 2.4 and centred on its tip at y 6 / 18, so the
 *  shafts (y 4.8..7.2 and 16.8..19.2) and the heads' flat bases (x 14.4 /
 *  9.6) are on the 2.4 grid, crisp at 20px and at 30px. A tip centred at
 *  7.2 / 16.8 would put the shaft edges on half pixels at 30px. The heads
 *  are 8.4 tall and 7.2 long (1.8..10.2 and 13.8..22.2); only their slanted
 *  sides antialias. */
function SwitchRowCol({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M2.4 4.8H14.4V1.8L21.6 6L14.4 10.2V7.2H2.4z" fill={STRONG} />
      <path d="M21.6 19.2H9.6V22.2L2.4 18L9.6 13.8V16.8H21.6z" fill={ACCENT} />
    </IconFrame>
  );
}

/** Format one data point (a 30px hero tile): soft neighbours, the accent bar
 *  is the point, the strong dot above it is the selection. Columns 4.8 wide
 *  at 2.4 / 9.6 / 16.8 (sides on the 2.4 grid, like ChartColumn). The dot
 *  (1.2..6.8) keeps 1.6 of background above the accent bar (top 8.4) and
 *  1.2 below the frame edge. */
function FormatPoint({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <Baseline />
      <rect x="2.4" y="12" width="4.8" height="6" rx="1.6" fill={SOFT} />
      <rect x="16.8" y="13.2" width="4.8" height="4.8" rx="1.6" fill={SOFT} />
      <rect x="9.6" y="8.4" width="4.8" height="9.6" rx="1.6" fill={ACCENT} />
      <circle cx="12" cy="4" r="2.8" fill={STRONG} />
    </IconFrame>
  );
}

/** Code / spec (JSON): a soft window, strong open bracket, accent close. It is
 *  a 30px hero tile as well as a 20px toggle, and a window centred on 12 has
 *  its top and bottom on the 2.4 grid only when it is 14.4 or 19.2 tall; 14.4
 *  is below the 16-unit short side, so the window is the 19.2 square
 *  2.4..21.6, crisp at both sizes. */
function Code({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.4" width="19.2" height="19.2" rx="3.4" fill={SOFT} />
      <path
        d="M9.4 8a1.7 1.7 0 0 1 0 2.4L7.8 12l1.6 1.6A1.7 1.7 0 1 1 7 16L4.2 13.2a1.7 1.7 0 0 1 0-2.4L7 8a1.7 1.7 0 0 1 2.4 0z"
        fill={STRONG}
      />
      <path
        d="M14.6 8a1.7 1.7 0 0 1 2.4 0l2.8 2.8a1.7 1.7 0 0 1 0 2.4L17 16a1.7 1.7 0 1 1-2.4-2.4l1.6-1.6-1.6-1.6a1.7 1.7 0 0 1 0-2.4z"
        fill={ACCENT}
      />
    </IconFrame>
  );
}

// ============================================================================
// Group export
// ============================================================================

/* eslint-disable @typescript-eslint/naming-convention -- the keys are React component names (PascalCase, which the rule already allows for functions) and a frozen public contract, not Rust-mirrored fields. */
export const CHART_ICONS = {
  // ---- chart types ----------------------------------------------------------
  ChartColumn,
  ChartBar,
  ChartLine,
  ChartArea,
  ChartPie,
  ChartDonut,
  ChartScatter,
  ChartWaterfall,
  ChartCombo,
  ChartRadar,
  ChartBubble,
  ChartHistogram,
  ChartFunnel,
  ChartTreemap,
  ChartStock,
  ChartBoxPlot,
  ChartSunburst,
  ChartPareto,
  // ---- furniture and actions ------------------------------------------------
  ChartTitle,
  Gridlines,
  Legend,
  AxisLabels,
  DataLabels,
  Grouped,
  Stacked,
  Stacked100,
  SecondaryAxis,
  Trendline,
  MarkOptions,
  LineStraight,
  LineSmooth,
  LineStep,
  Markers,
  Palette,
  Series,
  Filter,
  SwitchRowCol,
  EditChart: Pencil,
  SaveImage: Download,
  FormatPoint,
  Code,
} as const;
/* eslint-enable @typescript-eslint/naming-convention */
