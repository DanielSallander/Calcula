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
//          glyphs are drawn here in the same language. The Canvas tab's
//          Visuals gallery (2026-10-08) added Power BI's chart variants and
//          visuals -- stacked bars and areas, line and stacked column, Card,
//          Multi-row card, KPI, Gauge -- and the All Visuals hero, in
//          Power BI's compositions; their section says where each departs.
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
  coord,
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

/** The soft category axis of a bar-family chart, Baseline turned a quarter:
 *  2.4..4.8 x 2.4..21.6, PIXEL_STROKE wide. Bars start at x 7.2, one 2.4 gap
 *  to its right. Shared by ChartBar and the two stacked bar pictures, so the
 *  three bar tiles of the Visuals gallery stand on one axis. */
function BarAxis(): React.ReactElement {
  return <rect x="2.4" y="2.4" width="2.4" height="19.2" rx="1.2" fill={SOFT} />;
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
      <BarAxis />
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

/** Stacked (the Chart Design toggle Grouped | Stacked | 100%, and Power BI's
 *  "Stacked column" tile): two 6-wide columns, each a STRONG body under a
 *  1.2 gap and an ACCENT top segment, the stacked series. Redrawn 2026-10-08
 *  for the Visuals gallery, where it sits beside Stacked100: the left column
 *  topped out at 4.8 and the right at 2.4, 2 px apart at 20px, so the two
 *  tiles read as one picture. The left column now stops at 8.4 (STRONG
 *  14.4..18, ACCENT 8.4..13.2), Power BI's proportion: a short and a tall
 *  category, against Stacked100's two full-height ones. The right column is
 *  unchanged. The 6 width stays (a 4.8 pair on the 2.4 grid read as two thin
 *  "i"s); ribbonIcons.test.tsx holds the 4 px difference. */
function Stacked({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <Baseline />
      <rect x="4.8" y="14.4" width="6" height="3.6" rx="1.6" fill={STRONG} />
      <rect x="4.8" y="8.4" width="6" height="4.8" rx="1.6" fill={ACCENT} />
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
// Power BI's Visualizations pane (2026-10-08, the Canvas tab's Visuals gallery)
// ============================================================================
//
// The Canvas tab mirrors Power BI Desktop's report authoring, and its Visuals
// gallery shows Power BI's pane: six pictures to a row, every one a small
// chart. These keys borrow Power BI's COMPOSITIONS and paint them in this
// set's channels: Power BI's blue is ACCENT (the one series or value the
// picture is about), its grey is SOFT, its white-with-a-dark-outline marks are
// STRONG (filled, never outlined). Two things Power BI does could not be
// copied, and each drawing below says how it departs:
//
// - Power BI's coloured parts touch the grey ones; ours keep 1.2 of
//   background between ACCENT and every grey (frame.tsx), so a line that
//   CROSSES columns rides above them instead, and a gauge needle stands in
//   its own gap.
// - Power BI's KPI is a green AND a red triangle. ACCENT and DANGER never
//   share an icon (and red means "delete" here), so the red one is STRONG
//   (owner decision 2026-10-08).
//
// The family language is ChartColumn's and ChartBar's: column pictures stand
// on the soft Baseline and stop at 18, bar pictures grow from BarAxis at 7.2,
// marks are filled rx 1.6. A stacked mark is a STRONG first part, a 1.2 gap,
// and an ACCENT last part (Stacked's idiom), so in every stacked picture the
// accent is "the stacked series". Stacked pictures show TWO categories, the
// clustered ones (ChartColumn, ChartBar) three whole marks: two split marks
// against three whole ones is what tells the two apart at 20px. A 100%
// picture differs from its stacked twin by SHAPE: every mark reaches the same
// end (ribbonIcons.test.tsx measures it). Every key measures 0 accent contact.

/** Stacked bar (Power BI's first tile): Stacked turned a quarter. Two bars
 *  off BarAxis, 6 thick (Stacked's column width) at y 4.8..10.8 and
 *  13.2..19.2, a 2.4 gap centred on 12. Top bar, the short category: STRONG
 *  7.2..10.8, ACCENT 12..15.6 -- it ends 6.0 short of the long bar, Stacked's
 *  own shortfall (the first drawing's ACCENT ran to 16.8, 4.8 short, and its
 *  whole difference from ChartBarStacked100 was one 4 x 5 px corner; review
 *  1 of 2026-10-08). The accent stays at the 3.6 part floor. Bottom bar:
 *  STRONG 7.2..15.6, ACCENT 16.8..21.6. Every edge is on the 1.2 grid; 10.8 /
 *  13.2 / 15.6 are half pixels at 30px, the price of Stacked's 6 width (a 7.2
 *  bar read as two heavy blocks and a 4.8 bar as pills). Power BI draws white
 *  outlined bodies with a grey second segment on one bar; both last segments
 *  are ACCENT here, as in Stacked. */
function ChartBarStacked({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <BarAxis />
      <rect x="7.2" y="4.8" width="3.6" height="6" rx="1.6" fill={STRONG} />
      <rect x="12" y="4.8" width="3.6" height="6" rx="1.6" fill={ACCENT} />
      <rect x="7.2" y="13.2" width="8.4" height="6" rx="1.6" fill={STRONG} />
      <rect x="16.8" y="13.2" width="4.8" height="6" rx="1.6" fill={ACCENT} />
    </IconFrame>
  );
}

/** 100% stacked bar: both bars run the full length to 21.6, split at
 *  different points. Top: STRONG 7.2..10.8, ACCENT 12..21.6 (mostly the
 *  series); bottom: STRONG 7.2..16.8, ACCENT 18..21.6. The splits follow
 *  Power BI's picture (top mostly blue, bottom mostly white) rather than
 *  Stacked100 turned literally: the larger contrast between the two splits
 *  reads "same length, different shares" better at 20px. */
function ChartBarStacked100({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <BarAxis />
      <rect x="7.2" y="4.8" width="3.6" height="6" rx="1.6" fill={STRONG} />
      <rect x="12" y="4.8" width="9.6" height="6" rx="1.6" fill={ACCENT} />
      <rect x="7.2" y="13.2" width="9.6" height="6" rx="1.6" fill={STRONG} />
      <rect x="18" y="13.2" width="3.6" height="6" rx="1.6" fill={ACCENT} />
    </IconFrame>
  );
}

/** Stacked area: a STRONG lower series, and the ACCENT series as a band
 *  riding on it (Power BI's blue zigzag band between two zigzags). The lower
 *  series' top is the zigzag (2.4,15.6) (7.2,12) (12,14.4) (16.8,10.8)
 *  (21.6,13.2), down the sides to 18 with r 1.2 bottom corners. The band's
 *  top is the same zigzag 7.8 higher; its bottom is that zigzag offset 1.8
 *  PERPENDICULAR (mitred, cut at x 2.4 and 21.6, written to two decimals).
 *  The lower series sat 1.2 higher until review 0 of 2026-10-08: in Power BI
 *  the lower series is the light one and the blue band is what you see
 *  first, and ours read as a dark mountain with a thin green ridge. Lowering
 *  the body (and the band's lower edge with it, so the cut is unchanged)
 *  made the band 1.2 deeper and the body 1.2 lighter; the band's top did not
 *  move, so the zigzag top still tells it from ChartAreaStacked100's flat
 *  one. The cut is 1.8, not the minimum 1.2: on a diagonal a
 *  1.2 gap paints as one row of half-covered pixels and the band smears into
 *  the body at 20px; 1.8 was the first width that stayed a clean line in
 *  Light and Dark at 100% and 150%. Power BI's lower area is white with an
 *  outline on an L axis; ours is a filled STRONG body on the Baseline. A SOFT
 *  body was rendered and refused: a soft area with a green top is ChartArea's
 *  picture, so the two would differ only by the band's thickness. */
function ChartAreaStacked({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <Baseline />
      <path
        d="M2.4 15.6L7.2 12L12 14.4L16.8 10.8L21.6 13.2V16.8A1.2 1.2 0 0 1 20.4 18H3.6A1.2 1.2 0 0 1 2.4 16.8Z"
        fill={STRONG}
      />
      <path
        d="M2.4 7.8L7.2 4.2L12 6.6L16.8 3L21.6 5.4L21.6 11.19L16.61 8.69L11.81 12.29L7.01 9.89L2.4 13.35Z"
        fill={ACCENT}
      />
    </IconFrame>
  );
}

/** 100% stacked area: the ACCENT series fills from the FLAT top of the plot
 *  (y 2.4, r 1.6 corners) down to a zigzag, the STRONG series fills below it
 *  -- Power BI's picture exactly. The flat top reaching the frame is what
 *  separates it from ChartAreaStacked. Lower zigzag (2.4,12) (7.2,8.4) (12,12)
 *  (16.8,7.2) (21.6,10.8) down to 18; the accent's bottom edge is that zigzag
 *  offset 1.8 perpendicular, as in ChartAreaStacked. The heaviest picture in
 *  the family (like Power BI's); the white zigzag cut is what it reads by. */
function ChartAreaStacked100({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <Baseline />
      <path
        d="M2.4 12L7.2 8.4L12 12L16.8 7.2L21.6 10.8V16.8A1.2 1.2 0 0 1 20.4 18H3.6A1.2 1.2 0 0 1 2.4 16.8Z"
        fill={STRONG}
      />
      <path
        d="M2.4 4A1.6 1.6 0 0 1 4 2.4H20A1.6 1.6 0 0 1 21.6 4L21.6 8.55L16.63 4.82L11.83 9.62L7.2 6.15L2.4 9.75Z"
        fill={ACCENT}
      />
    </IconFrame>
  );
}

/** One stacked column of ChartComboStacked: a `width`-wide STRONG body from
 *  `split` down to 18, rounded r 1.6 at the bottom only, with a SOFT cap from
 *  `top` to `split` laid FLUSH on it, rounded at the top only. Soft against
 *  strong needs no gap (the 1.2 rule is about ACCENT; STRONG is 3:1 above
 *  SOFT), and they abut, never overlap. */
function stackedColumn(x: number, top: number, split: number, width: number): React.ReactElement {
  return (
    <>
      <path
        d={`M${coord(x)} ${coord(split)}H${coord(x + width)}V16.4A1.6 1.6 0 0 1 ${coord(x + width - 1.6)} 18H${coord(x + 1.6)}A1.6 1.6 0 0 1 ${coord(x)} 16.4Z`}
        fill={STRONG}
      />
      <path
        d={`M${coord(x)} ${coord(top + 1.6)}A1.6 1.6 0 0 1 ${coord(x + 1.6)} ${coord(top)}H${coord(x + width - 1.6)}A1.6 1.6 0 0 1 ${coord(x + width)} ${coord(top + 1.6)}V${coord(split)}H${coord(x)}Z`}
        fill={SOFT}
      />
    </>
  );
}

/** Line and stacked column: Stacked's TWO 6-wide columns (x 4.8..10.8 and
 *  13.2..19.2) under ChartCombo's line. Each column is a STRONG body with a
 *  SOFT cap (Power BI's grey upper segment): left cap 10.8..14.4 on a body
 *  14.4..18, right cap 9.6..13.2 on a body 13.2..18. The ACCENT line, a
 *  3-unit zigzag, rides above them, its top edge at 2.4 and at least 1.2
 *  clear of every cap. Until review 0 of 2026-10-08 this drew ChartCombo's
 *  THREE 4.8 columns with caps, and at 20px it was ChartCombo with soft tops:
 *  the family rule above (two split marks against three whole ones, Power
 *  BI's pane row 2, tiles 5 and 6) is what tells it apart now, and
 *  ribbonIcons.test.tsx pins the columns to Stacked's. Power BI's line
 *  CROSSES the columns; ours cannot (a crossing accent line needs 1.2 cut out
 *  of every column it crosses, and the crossing version with a STRONG line
 *  read as noise at 20px; Power BI's own colours -- green segments under a
 *  dark line -- read as a table). The caps sit flush because the line above
 *  leaves the columns 7.2..8.4 tall: with a 1.2 gap every column became the
 *  same two blocks and the picture read as a table. The two-tone, flat-capped
 *  columns survive high contrast (SOFT is a solid mid-grey there). */
function ChartComboStacked({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <Baseline />
      {stackedColumn(4.8, 10.8, 14.4, 6)}
      {stackedColumn(13.2, 9.6, 13.2, 6)}
      <path d="M3.8 7.4L9 3.9l5.8 2.7 5.4-2.7" {...line(ACCENT)} />
    </IconFrame>
  );
}

/** Card: Power BI's card, a large "123" over a grey caption rule (Power BI's
 *  lightning badge only means "new" and is dropped). The ACCENT digits are
 *  Paste Values' PASTE_DIGITS (home.tsx) moved by (-2.4, -7.2), written out
 *  because a PIXEL_STROKE path may not sit in a transform;
 *  ribbonIcons.test.tsx fails if the two drift. Their ink is 4.8..19.2 x
 *  4.8..14.4. Under them, 2.4 clear, the SOFT caption rule 4.8..19.2 x
 *  16.8..19.2: Power BI's grey, and the same SOFT rule KPI draws on the same
 *  gallery row. Ink 4.8..19.2 both ways, centred on 12.
 *
 *  No frame. The first Card held the digits in a hole cut in a SOFT card
 *  1.2..22.8 wide with the rule (STRONG, on the grey wall) in its bottom band;
 *  both reviews of 2026-10-08 read it as a monitor or calculator with a chin,
 *  it was among the heaviest pictures in the gallery (ink 211 against 115-150
 *  for its neighbours) and it broke the 2.4 margins. Review 0 kept a frame (a
 *  square card, the rule SOFT in the hole: ink 214, 40 half-covered pixels);
 *  review 1 dropped it (ink 90, 24 half-covered). Settled on the 20px pixel
 *  map (scratch icons-fix/cand-row1.png): the frameless value over a rule
 *  reads as the card and matches KPI, which draws no box for the same reason;
 *  the rule is SOFT, review 0's colour, because Power BI's rule is grey and
 *  on the background it no longer needs to be STRONG to show. It differs
 *  from Paste Values (a clipboard with the digits in its corner) by shape. */
function ChartCard({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M6 6V13.2M9.6 6H12V9.6H9.6V13.2H12M15.6 6H18V13.2H15.6M15.6 9.6H18" {...line(ACCENT, PIXEL_STROKE)} />
      <rect x="4.8" y="16.8" width="14.4" height="2.4" rx="1.2" fill={SOFT} />
    </IconFrame>
  );
}

/** Multi-row card (older Power BI's; the current pane replaced it with the
 *  new Card, so the composition is the survey's): three records at y 2.4 /
 *  9.6 / 16.8, 4.8 tall with 2.4 gaps. Each is a 2.4 x 4.8 card bar on the left
 *  (Power BI's "accent bar" option, so the ACCENT names a real feature: the
 *  first record's bar; the others SOFT), a STRONG value bar 2.4 tall from 7.2
 *  (lengths 8.4 / 13.2 / 10.8) and, directly under it, a SOFT label bar to
 *  21.6 (strong and soft abut). The accent bar keeps 2.4 to its record. No
 *  enclosing card: an accent inside a soft card needs a hole with 2.4 walls,
 *  and three records do not fit 19.2 that way. It differs by shape from
 *  Slicer (three centred pills in a panel), PivotFields (square ticks with one
 *  bar each) and Table (a 3 x 3 grid). */
function ChartMultiRowCard({ size }: RibbonIconProps): React.ReactElement {
  const records = [
    { y: 2.4, value: 8.4, bar: ACCENT },
    { y: 9.6, value: 13.2, bar: SOFT },
    { y: 16.8, value: 10.8, bar: SOFT },
  ];
  return (
    <IconFrame size={size}>
      {records.map(({ y, value, bar }) => (
        <React.Fragment key={y}>
          <rect x="2.4" y={y} width="2.4" height="4.8" rx="1.2" fill={bar} />
          <rect x="7.2" y={y} width={value} height="2.4" rx="1.2" fill={STRONG} />
          <rect x="7.2" y={coord(y + 2.4)} width="14.4" height="2.4" rx="1.2" fill={SOFT} />
        </React.Fragment>
      ))}
    </IconFrame>
  );
}

/** KPI: Power BI's up and down triangles over a grey rule. Power BI's green
 *  up triangle is ACCENT and its red down triangle STRONG (owner decision
 *  2026-10-08; ACCENT and DANGER never share an icon). The ACCENT triangle
 *  (7.8,3.6) (13.2,15.6) (2.4,15.6) and the STRONG one (10.8,3.6) (21.6,3.6)
 *  (16.2,15.6), corners rounded r 1.0, INTERLOCK: their facing edges are
 *  parallel and 2.74 apart. Power BI's stand apart, but drawn that way they
 *  were 4-6 px marks lost in a 20px box; interlocked each is 9 x 10 px. The
 *  SOFT rule 2.4..21.6 x 18..20.4 sits 2.4 under the up triangle's base. No
 *  box: the pair over a rule is its own shape, and ChartCard beside it is the
 *  same "value over a SOFT rule" without one (ribbonIcons.test.tsx holds
 *  both). */
function ChartKpi({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M6.89 5.63A1 1 0 0 1 8.71 5.63L12.57 14.19A1 1 0 0 1 11.65 15.6L3.95 15.6A1 1 0 0 1 3.03 14.19Z"
        fill={ACCENT}
      />
      <path
        d="M11.43 5.01A1 1 0 0 1 12.35 3.6L20.05 3.6A1 1 0 0 1 20.97 5.01L17.11 13.57A1 1 0 0 1 15.29 13.57Z"
        fill={STRONG}
      />
      <rect x="2.4" y="18" width="19.2" height="2.4" rx="1.2" fill={SOFT} />
    </IconFrame>
  );
}

/** Gauge: Power BI's half ring with a coloured part and a dark needle from
 *  the base centre. The ring is a half annulus centred (12, 15.6), R 9.6 and r
 *  4.8, its feet flat on y 15.6. The STRONG needle is a 2.6 line at 60 degrees
 *  from the centre to radius 9, on a STRONG pivot dot r 2.4 (4.8 wide, above
 *  the 4.3 dot floor). The ring is CUT along two lines parallel to the needle,
 *  2.5 either side (half the needle's 2.6 plus the 1.2 rule), so the needle
 *  stands in a gap of constant width that touches neither colour: ACCENT from
 *  the left foot to the near cut (the value, filled from the minimum, the way
 *  the gauge mark paints it), SOFT from the far cut to the right foot. Power
 *  BI colours the right side of an outlined arc. A needle pointing into the
 *  soft part (the survey's sketch) painted needle, ring and soft part as one
 *  grey knot at 20px; a vertical PIXEL_STROKE needle at 50% was crisp but read
 *  as a split arch with a peg. Ink y 6..18: a gauge is a strip, centred. */
function ChartGauge({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M18.8 8.82A9.6 9.6 0 0 1 21.6 15.6H16.8A4.8 4.8 0 0 0 16.21 13.3Z" fill={SOFT} />
      <path d="M2.4 15.6A9.6 9.6 0 0 1 14.47 6.32L11.88 10.8A4.8 4.8 0 0 0 7.2 15.6Z" fill={ACCENT} />
      <path d="M12 15.6L16.5 7.81" {...line(STRONG, 2.6)} />
      <circle cx="12" cy="15.6" r="2.4" fill={STRONG} />
    </IconFrame>
  );
}

/** All Visuals (the hero that opens the gallery): the gallery itself, four
 *  kinds of visual in a 2 x 2 -- two STRONG columns (top left), a STRONG
 *  three-quarter pie with its ACCENT quarter pulled out by (+1.2, -1.2) so
 *  both straight edges keep exactly 1.2 (top right), a STRONG area with a
 *  zigzag top (bottom left) and a SOFT donut, ring 2.4 (bottom right). It
 *  echoes More's 2 x 2 ("more of these") and differs from it by shape. A
 *  plain accent disc read as a dot, a mini line as a caret. Power BI has no
 *  picture for it (its "..." tile means "get more visuals").
 *
 *  HERO ONLY: drawn for 30px, where one pixel is 0.8 units, and NOT for 20 or
 *  24 (at 20px 4 parts in 19.2 are busy, and half its pixels are half
 *  covered). The columns are 3.2 wide at x 2.4..5.6 and 7.2..10.4, tops 6.4
 *  and 2.4, feet 10.4 (3..7 and 9..13 px wide, 3..13 px tall at 30px), and
 *  the area's right edge is on 10.4 with them; rx 1.0 because they are 4 px
 *  marks. Until review 1 of 2026-10-08 they were 3.6 wide on the 1.2 grid,
 *  whose 6.0 and 10.8 are 7.5 and 13.5 px at 30px: crisp at the size it is
 *  never shown at, soft at the one it is (ribbonIcons.test.tsx now holds the
 *  rects on the 0.8 grid). Two columns and a gap cannot all be 2.4 multiples
 *  (whole at both sizes) inside an 8.4 quadrant. */
function AllVisuals({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="6.4" width="3.2" height="4" rx="1" fill={STRONG} />
      <rect x="7.2" y="2.4" width="3.2" height="8" rx="1" fill={STRONG} />
      <path d="M16.2 3.6A4.2 4.2 0 1 0 20.4 7.8H16.2Z" fill={STRONG} />
      <path d="M17.4 2.4A4.2 4.2 0 0 1 21.6 6.6H17.4Z" fill={ACCENT} />
      <path
        d="M2.4 20.4V17.6L5.4 14.4L7.8 17L10.4 13.2V20.4A1.2 1.2 0 0 1 9.2 21.6H3.6A1.2 1.2 0 0 1 2.4 20.4Z"
        fill={STRONG}
      />
      <path
        d="M17.4 13.2a4.2 4.2 0 1 0 0 8.4a4.2 4.2 0 1 0 0-8.4zm0 2.4a1.8 1.8 0 1 1 0 3.6a1.8 1.8 0 1 1 0-3.6z"
        fill={SOFT}
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
  // ---- Power BI's Visualizations pane (2026-10-08, the Canvas tab) ----------
  ChartBarStacked,
  ChartBarStacked100,
  ChartAreaStacked,
  ChartAreaStacked100,
  ChartComboStacked,
  ChartCard,
  ChartMultiRowCard,
  ChartKpi,
  ChartGauge,
  AllVisuals,
} as const;
/* eslint-enable @typescript-eslint/naming-convention */
