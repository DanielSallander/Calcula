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
//          actions are the mockup's drawings verbatim. The remaining types
//          (Waterfall ... Pareto), SecondaryAxis and the four line-style
//          glyphs are drawn here in the same language.
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
  line,
  type RibbonIconProps,
} from "./frame";
import { Pencil, Download } from "./generic";

// ============================================================================
// Shared ground
// ============================================================================

/** The soft category axis under a column-family chart. */
function Baseline(): React.ReactElement {
  return <rect x="3" y="18.5" width="18" height="3" rx="1.5" fill={SOFT} />;
}

/** The soft L of an x/y chart (line, scatter, bubble, trendline). The two
 *  rects overlap in the corner; the mockup accepts the slightly darker joint
 *  because it reads as the origin. */
function Axes(): React.ReactElement {
  return (
    <>
      <rect x="2.5" y="3" width="3" height="18" rx="1.5" fill={SOFT} />
      <rect x="2.5" y="18" width="18.5" height="3" rx="1.5" fill={SOFT} />
    </>
  );
}

// ============================================================================
// Chart types
// ============================================================================

function ChartColumn({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <Baseline />
      <rect x="3.5" y="10" width="5" height="8" rx="1.6" fill={STRONG} />
      <rect x="9.5" y="4" width="5" height="14" rx="1.6" fill={ACCENT} />
      <rect x="15.5" y="7" width="5" height="11" rx="1.6" fill={STRONG} />
    </IconFrame>
  );
}

function ChartBar({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.5" y="3" width="3" height="18" rx="1.5" fill={SOFT} />
      <rect x="6.5" y="4" width="9" height="5" rx="1.6" fill={STRONG} />
      <rect x="6.5" y="9.5" width="15" height="5" rx="1.6" fill={ACCENT} />
      <rect x="6.5" y="15" width="6" height="5" rx="1.6" fill={STRONG} />
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

function ChartArea({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.5" y="18" width="18.5" height="3" rx="1.5" fill={SOFT} />
      <path d="M4.5 18v-4.2l4.2-4.8 4 3 5.3-6.5 2 1.5V18z" fill={SOFT} />
      <path d="M4.5 13.8l4.2-4.8 4 3 5.3-6.5" {...line(ACCENT)} />
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
 *  and the total; the accent step is the change being explained. */
function ChartWaterfall({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <Baseline />
      <rect x="3" y="12" width="4" height="6" rx="1.4" fill={STRONG} />
      <rect x="7.66" y="8" width="4" height="4" rx="1.4" fill={STRONG} />
      <rect x="12.33" y="4" width="4" height="4" rx="1.4" fill={ACCENT} />
      <rect x="17" y="4" width="4" height="14" rx="1.4" fill={STRONG} />
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
      <rect x="3.6" y="12" width="4.4" height="6" rx="1.6" fill={STRONG} />
      <rect x="9.8" y="10.4" width="4.4" height="7.6" rx="1.6" fill={STRONG} />
      <rect x="16" y="11" width="4.4" height="7" rx="1.6" fill={STRONG} />
      <path d="M3.8 9.6L9 5.2l5.8 3.4 5.4-5.2" {...line(ACCENT)} />
    </IconFrame>
  );
}

/** Radar: a soft pentagon web with the accent series polygon inside it. */
function ChartRadar({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M10.38 3.78Q12 2.6 13.62 3.78L19.89 8.33Q21.51 9.51 20.89 11.41L18.5 18.79Q17.88 20.69 15.88 20.69L8.12 20.69Q6.12 20.69 5.5 18.79L3.11 11.41Q2.49 9.51 4.11 8.33Z"
        fill={SOFT}
      />
      <path
        d="M11.17 5.67Q12 4.8 12.85 5.65L17.05 9.83Q17.9 10.68 17.65 11.85L16.48 17.25Q16.23 18.42 15.07 18.1L10.34 16.8Q9.18 16.48 8.64 15.41L6.83 11.82Q6.29 10.75 7.12 9.88Z"
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

/** Histogram: adjacent bins in a bell; the accent bin is the mode. */
function ChartHistogram({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <Baseline />
      <rect x="3" y="13" width="3.12" height="5" rx="1.4" fill={STRONG} />
      <rect x="6.72" y="9" width="3.12" height="9" rx="1.4" fill={STRONG} />
      <rect x="10.44" y="4.5" width="3.12" height="13.5" rx="1.4" fill={ACCENT} />
      <rect x="14.16" y="8" width="3.12" height="10" rx="1.4" fill={STRONG} />
      <rect x="17.88" y="12.5" width="3.12" height="5.5" rx="1.4" fill={STRONG} />
    </IconFrame>
  );
}

/** Funnel: centred stages narrowing downward; the accent stage is the one
 *  being examined. */
function ChartFunnel({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="2.6" width="19.2" height="3.8" rx="1.6" fill={STRONG} />
      <rect x="4.8" y="7.6" width="14.4" height="3.8" rx="1.6" fill={STRONG} />
      <rect x="7.2" y="12.6" width="9.6" height="3.8" rx="1.6" fill={ACCENT} />
      <rect x="9.5" y="17.6" width="5" height="3.8" rx="1.6" fill={STRONG} />
    </IconFrame>
  );
}

/** Treemap: nested rectangles by size; the accent tile is the named node. */
function ChartTreemap({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.5" y="3" width="10" height="18" rx="2.4" fill={STRONG} />
      <rect x="13.5" y="3" width="8" height="9" rx="2.4" fill={ACCENT} />
      <rect x="13.5" y="13" width="3.5" height="8" rx="1.6" fill={SOFT} />
      <rect x="18" y="13" width="3.5" height="8" rx="1.6" fill={SOFT} />
    </IconFrame>
  );
}

/** Stock: three candlesticks, wick behind body; the accent candle is the one
 *  that closed up. */
function ChartStock({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <Baseline />
      <path d="M6 4.6V16" {...line(STRONG, 2.6)} />
      <rect x="3.5" y="7.6" width="5" height="5.4" rx="1.6" fill={STRONG} />
      <path d="M12 3v9.6" {...line(ACCENT, 2.6)} />
      <rect x="9.5" y="5" width="5" height="4.6" rx="1.6" fill={ACCENT} />
      <path d="M18 7.6v8.8" {...line(STRONG, 2.6)} />
      <rect x="15.5" y="9.6" width="5" height="4.6" rx="1.6" fill={STRONG} />
    </IconFrame>
  );
}

/** Box plot: two boxes with capped whiskers — the caps are what tell it
 *  apart from Stock's candles at a glance. */
function ChartBoxPlot({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M5.6 4h2.8M7 4v15M5.6 19h2.8" {...line(STRONG, 2.6)} />
      <rect x="3.6" y="8" width="6.8" height="7" rx="1.6" fill={STRONG} />
      <path d="M15.6 3h2.8M17 3v14.6M15.6 17.6h2.8" {...line(ACCENT, 2.6)} />
      <rect x="13.6" y="6.4" width="6.8" height="7.6" rx="1.6" fill={ACCENT} />
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
      <rect x="3.6" y="8" width="4.4" height="10" rx="1.6" fill={STRONG} />
      <rect x="9.8" y="11.6" width="4.4" height="6.4" rx="1.6" fill={STRONG} />
      <rect x="16" y="14.4" width="4.4" height="3.6" rx="1.6" fill={STRONG} />
      <path d="M5.8 8C9.5 5.4 13 4.2 18.2 3.4" {...line(ACCENT)} />
    </IconFrame>
  );
}

// ============================================================================
// Furniture: soft body, the accent is the element the icon names
// ============================================================================

function ChartTitle({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.5" y="9" width="19" height="12.5" rx="3.2" fill={SOFT} />
      <rect x="5" y="2.5" width="14" height="4.4" rx="2.2" fill={ACCENT} />
    </IconFrame>
  );
}

/** Gridlines: the accent rules run edge to edge of the soft body, so they
 *  carry no corner radius of their own (the body's rounding is above and
 *  below them). */
function Gridlines({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.5" y="3" width="19" height="18" rx="3.2" fill={SOFT} />
      <rect x="2.5" y="8.2" width="19" height="3" fill={ACCENT} />
      <rect x="2.5" y="14.2" width="19" height="3" fill={ACCENT} />
    </IconFrame>
  );
}

function Legend({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.5" y="2.5" width="19" height="12" rx="3.2" fill={SOFT} />
      <rect x="2.5" y="16.6" width="5.4" height="5" rx="1.8" fill={ACCENT} />
      <rect x="9.4" y="17.8" width="5.4" height="2.8" rx="1.4" fill={STRONG} />
      <rect x="16.1" y="16.6" width="5.4" height="5" rx="1.8" fill={ACCENT} />
    </IconFrame>
  );
}

function AxisLabels({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.5" y="2.5" width="19" height="13" rx="3.2" fill={SOFT} />
      <rect x="2.5" y="17.8" width="5.4" height="3.7" rx="1.85" fill={ACCENT} />
      <rect x="9.3" y="17.8" width="5.4" height="3.7" rx="1.85" fill={ACCENT} />
      <rect x="16.1" y="17.8" width="5.4" height="3.7" rx="1.85" fill={ACCENT} />
    </IconFrame>
  );
}

function DataLabels({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <Baseline />
      <rect x="4" y="11.5" width="5.4" height="6.5" rx="1.7" fill={STRONG} />
      <rect x="14.6" y="8.5" width="5.4" height="9.5" rx="1.7" fill={STRONG} />
      <rect x="2.5" y="5.6" width="8.4" height="4.4" rx="2.2" fill={ACCENT} />
      <rect x="13.1" y="2.6" width="8.4" height="4.4" rx="2.2" fill={ACCENT} />
    </IconFrame>
  );
}

/** Secondary axis: the soft primary axis on the left, the accent axis on the
 *  right is the one the icon names. */
function SecondaryAxis({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.5" y="3" width="3" height="18" rx="1.5" fill={SOFT} />
      <rect x="18.5" y="3" width="3" height="18" rx="1.5" fill={ACCENT} />
      <rect x="7.6" y="12" width="4" height="9" rx="1.6" fill={STRONG} />
      <rect x="12.8" y="7" width="4" height="14" rx="1.6" fill={STRONG} />
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
      <rect x="3" y="8.5" width="4" height="9.5" rx="1.4" fill={STRONG} />
      <rect x="7.8" y="11.5" width="4" height="6.5" rx="1.4" fill={ACCENT} />
      <rect x="13.2" y="5.5" width="4" height="12.5" rx="1.4" fill={STRONG} />
      <rect x="18" y="9.5" width="4" height="8.5" rx="1.4" fill={ACCENT} />
    </IconFrame>
  );
}

function Stacked({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <Baseline />
      <rect x="4.5" y="11.5" width="6.5" height="6.5" rx="1.6" fill={STRONG} />
      <rect x="4.5" y="5" width="6.5" height="5.8" rx="1.6" fill={ACCENT} />
      <rect x="13" y="8.5" width="6.5" height="9.5" rx="1.6" fill={STRONG} />
      <rect x="13" y="3" width="6.5" height="4.8" rx="1.6" fill={ACCENT} />
    </IconFrame>
  );
}

function Stacked100({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <Baseline />
      <rect x="4.5" y="9.5" width="6.5" height="8.5" rx="1.6" fill={STRONG} />
      <rect x="4.5" y="2.5" width="6.5" height="6.3" rx="1.6" fill={ACCENT} />
      <rect x="13" y="6.5" width="6.5" height="11.5" rx="1.6" fill={STRONG} />
      <rect x="13" y="2.5" width="6.5" height="3.3" rx="1.6" fill={ACCENT} />
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
 *  being styled. */
function MarkOptions({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.5" y="4.6" width="19" height="3.2" rx="1.6" fill={SOFT} />
      <rect x="2.5" y="10.4" width="19" height="3.2" rx="1.6" fill={SOFT} />
      <rect x="2.5" y="16.2" width="19" height="3.2" rx="1.6" fill={SOFT} />
      <circle cx="8" cy="6.2" r="3.4" fill={ACCENT} />
      <circle cx="16.4" cy="12" r="3.4" fill={STRONG} />
      <circle cx="10.6" cy="17.8" r="3.4" fill={STRONG} />
    </IconFrame>
  );
}

/** Line shape: straight / smooth / step. The three share a baseline and pass
 *  through the same four points, so the only difference you see is the
 *  interpolation — which is the choice being offered. */
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

function LineStep({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <Baseline />
      <path d="M3.8 14.6H8.6V7.6h6v4.6h5.6" {...line(ACCENT)} />
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
      <rect x="2.5" y="3.6" width="19" height="5" rx="2" fill={ACCENT} />
      <rect x="2.5" y="9.6" width="19" height="5" rx="2" fill={SOFT} />
      <rect x="2.5" y="15.6" width="19" height="5" rx="2" fill={SOFT} />
    </IconFrame>
  );
}

/** The funnel outline, shared with Data's ClearFilter. */
export const FUNNEL =
  "M3.2 3.5h17.6a1.6 1.6 0 0 1 1.2 2.65L15.2 14v5.5a1.6 1.6 0 0 1-2.3 1.44l-3-1.5a1.6 1.6 0 0 1-.9-1.44V14L2 6.15A1.6 1.6 0 0 1 3.2 3.5z";

/** Filter: a soft funnel; the accent stem is what passes through it. */
function Filter({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d={FUNNEL} fill={SOFT} />
      <rect x="8.9" y="12" width="6.4" height="9.6" rx="1.8" fill={ACCENT} />
    </IconFrame>
  );
}

/** Switch row/column: two opposed arrows, the accent one is the swap. */
function SwitchRowCol({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M2.5 6.2h12.3V2.8L21.5 7.6l-6.7 4.8V9H2.5z" fill={STRONG} />
      <path d="M21.5 17.8H9.2v3.4L2.5 16.4l6.7-4.8V15h12.3z" fill={ACCENT} />
    </IconFrame>
  );
}

/** Format one data point: soft neighbours, the accent bar is the point, the
 *  strong dot above it is the selection. */
function FormatPoint({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <Baseline />
      <rect x="3.4" y="11.5" width="5" height="6.5" rx="1.6" fill={SOFT} />
      <rect x="15.6" y="13" width="5" height="5" rx="1.6" fill={SOFT} />
      <rect x="9.5" y="7" width="5" height="11" rx="1.6" fill={ACCENT} />
      <circle cx="12" cy="3.4" r="2.8" fill={STRONG} />
    </IconFrame>
  );
}

/** Code / spec (JSON): a soft window, strong open bracket, accent close. */
function Code({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="1.8" y="3.2" width="20.4" height="17.6" rx="3.4" fill={SOFT} />
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
