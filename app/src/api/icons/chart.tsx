//! FILENAME: app/src/api/icons/chart.tsx
// PURPOSE: The chart glyphs: every chart TYPE and the Canvas tab's other
//          visuals (cards, KPI, gauge), the chart FURNITURE (title, gridlines,
//          legend, labels...) and the chart ACTIONS.
// CONTEXT: Two languages live in this file, one per family.
//
//          - The VISUALS FAMILY: the 18 chart types, Power BI's visuals of the
//            Canvas tab (stacked bars and areas, line and stacked column, Card,
//            Multi-row card, KPI, Gauge), the All Visuals hero, and Chart
//            Design's layout toggle Grouped | Stacked | 100% (Stacked and
//            Stacked100 are also gallery tiles, so the toggle follows them).
//            Redrawn on 2026-10-22 in the owner's chosen direction "Geometric"
//            (ICONS.md section 2.5): every picture is cut from squares,
//            circles, semicircles, quarter circles and sharp polygons, on the
//            sizes of marks.tsx and with its helpers where they fit -- square
//            where a part meets something, a full curve where it ends freely,
//            never an in-between radius -- and its parts are held apart by ONE
//            2.4 cut, which is also the ACCENT's clearance from everything
//            else. Bars and columns are D-marks (square root, semicircle value
//            end) with NO drawn axis: their aligned square roots are the axis
//            (the Histogram, whose adjacent bins make one block, is the one
//            picture that stands on a SOFT baseline). The x/y pictures stand in
//            one SOFT L (PlotAxes), the cards on one SOFT rule (CardRule). The
//            pictures stay monochrome with the ACCENT on exactly one thing (the
//            series, the stacked series, the value, the selected segment): a
//            categorical palette in chrome ignores the skin.
//          - FURNITURE and ACTIONS keep the duotone language of the first
//            redraw (the approved Main.dc.html / Icons.dc.html mockup): a soft
//            chart body with the ACCENT on the element the icon names, rounded
//            rects (rx >= 1.4) and the soft Baseline / Axes ground below. You
//            find "Legend" by looking for the highlighted legend, not by
//            reading the tooltip.
//
//          Pixel grid: every horizontal and vertical edge of a filled shape
//          sits on a multiple of PIXEL_GRID (1.2 units, one device pixel at
//          20px), except one 1.6 run of Palette's freehand outline (y 16.3),
//          so straight edges paint crisp at 100% instead of as a half-covered
//          grey pixel. Where it costs nothing an edge sits on a multiple of
//          2.4, which is also crisp at 150% and at 30px. Only diagonals,
//          curves, round caps, that Palette run and the Card's 2.6 digit
//          strokes antialias; the All Visuals hero is drawn on its own 0.8
//          grid. The Visuals family's straight edges are test-enforced on
//          the 1.2 grid; Palette's are not.
//
//          The HERO tiles of the Chart Design band draw at 30px (0.8 units per
//          device pixel), where, of the multiples of 1.2, only a multiple of
//          2.4 is crisp: the six quick types (Column, Bar, Line, Area, Pie,
//          Scatter), MarkOptions, SwitchRowCol, FormatPoint, Code, EditChart
//          and SaveImage (the last two the generic Pencil and Download),
//          beside generic.tsx's More tile. The Visuals family puts the
//          columns and bars of its three-mark lattice, the plot L and the
//          areas on the 2.4 grid. A cut centred in the 24 box cannot be: a
//          2.4 cut there falls on 10.8 | 13.2, half pixels at 30px and at
//          150%. That costs the pie (the one quick tile that got softer at
//          30px), the donut, the sunburst, and everything on the pair slots
//          at 3.6 / 13.2 (the stacked pairs, Line and stacked column,
//          Grouped's columns and the Box plot's two plots); Table, Treemap,
//          Multi-row card, KPI and Stock have edges on odd multiples of 1.2
//          by construction (ICONS.md 2.5 lists them).
//          MarkOptions' middle rail is another exception (three evenly spaced
//          2.4 rails centred on 12 can never all land on the 2.4 grid), and so
//          are FormatPoint's column ends (two tops at 13.2 and 8.4, all three
//          feet at 18), SaveImage's Download (x 6, 10.8 and 22.8, y 18) and
//          the More tile (its tiles at 10.8 | 13.2, its plus's arm edges at
//          15.6), half pixels at 30px;
//          EditChart's Pencil (x 2.4, y 21.6) is crisp. The gallery (24px) and the band's tall
//          segments (28px) cannot be crisp on this grid: of the multiples of
//          1.2, only 6, 12 and 18 are whole pixels there.
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
import { GAP, PAIR, SERIES, FLOOR, dMark, column, bar, pill, PlotAxes, CardRule } from "./marks";
import { Pencil, Download } from "./generic";

// ============================================================================
// Shared ground of the furniture icons
// ============================================================================

/** The soft category axis under a furniture icon's columns (DataLabels,
 *  FormatPoint) and line styles: 2.4..21.6 x 19.2..21.6, a line PIXEL_STROKE
 *  thick (two whole pixels at 20px, three at 30px, so it is crisp at 100% AND
 *  150%; a 3.6 axis always has one edge on a half pixel at 150%). A column
 *  above it stops at 18, so one clean pixel of background separates the two.
 *  The Visuals family draws no axis under its marks (their square roots are
 *  the axis; see marks.tsx), except the Histogram's square-ended baseline. */
function Baseline(): React.ReactElement {
  return <rect x="2.4" y="19.2" width="19.2" height="2.4" rx="1.2" fill={SOFT} />;
}

/** The soft L under Trendline, drawn as ONE path. It was two overlapping
 *  rects, and SOFT is translucent, so the corner painted twice: at the 50%
 *  tint that joint is a dark knot only 2.2:1 from STRONG. Both arms are lines
 *  PIXEL_STROKE thick on the pixel grid, like the Baseline: the vertical arm
 *  is x 2.4..4.8 and rises to 2.4, the horizontal arm is y 19.2..21.6 and runs
 *  to 21.6, so each round end fills exactly one pixel row or column. The
 *  Visuals family's x/y pictures use marks.tsx's PlotAxes instead (square
 *  ends, a crisp corner). */
function Axes(): React.ReactElement {
  return (
    <path
      d="M2.4 3.6A1.2 1.2 0 0 1 4.8 3.6V19.2H20.4A1.2 1.2 0 0 1 20.4 21.6H3.6A1.2 1.2 0 0 1 2.4 20.4Z"
      fill={SOFT}
    />
  );
}

// ============================================================================
// The Visuals family: chart types (2026-10-22, "Geometric")
// ============================================================================
//
// Built on marks.tsx. The stacked pictures (Stacked, ChartBarStacked and their
// 100% twins) share the helpers below: two PAIR marks (7.2) at 3.6 / 13.2, each
// a crisp STRONG root, THE cut, then an ACCENT end segment. Line and stacked
// column draws the same pair by hand, cut short, with a bare SOFT cap for its
// end. Stacked pictures show TWO categories, clustered ones (ChartColumn,
// ChartBar, ChartCombo) THREE whole marks: two split marks against three whole
// ones is what tells them apart at 20px.

/** A stacked mark's END segment: a 2.4 run (as long as THE cut) plus the
 *  pair's 3.6 cap. Equal in every mark of a stacked picture (it is one
 *  series), so only the roots vary. */
const STACK_END = GAP + PAIR / 2;

/** A stacked column on the floor: a crisp STRONG root `root` tall, THE cut,
 *  then the ACCENT end segment as a D-mark. */
function stackedColumn(x: number, root: number): React.ReactElement {
  return (
    <>
      <rect x={coord(x)} y={coord(FLOOR - root)} width={coord(PAIR)} height={coord(root)} fill={STRONG} />
      {dMark(x, FLOOR - root - GAP - STACK_END, PAIR, STACK_END, "top", ACCENT)}
    </>
  );
}

/** A stacked bar from the field's left edge: Stacked's column turned a
 *  quarter. */
function stackedBar(y: number, root: number): React.ReactElement {
  return (
    <>
      <rect x="2.4" y={coord(y)} width={coord(root)} height={coord(PAIR)} fill={STRONG} />
      {dMark(2.4 + root + GAP, y, STACK_END, PAIR, "right", ACCENT)}
    </>
  );
}

/** A 100% stacked column: the root, THE cut, and the ACCENT up to the
 *  field's top (y 2.4) -- every total the same, the splits different. The
 *  value end stays a D: square ends made the pair four tiles, close to the
 *  Treemap. */
function stackedColumn100(x: number, root: number): React.ReactElement {
  return (
    <>
      <rect x={coord(x)} y={coord(FLOOR - root)} width={coord(PAIR)} height={coord(root)} fill={STRONG} />
      {dMark(x, 2.4, PAIR, FLOOR - root - GAP - 2.4, "top", ACCENT)}
    </>
  );
}

/** A 100% stacked bar: stackedColumn100 turned a quarter (the ACCENT runs to
 *  x 21.6). */
function stackedBar100(y: number, root: number): React.ReactElement {
  return (
    <>
      <rect x="2.4" y={coord(y)} width={coord(root)} height={coord(PAIR)} fill={STRONG} />
      {dMark(2.4 + root + GAP, y, FLOOR - 2.4 - root - GAP, PAIR, "right", ACCENT)}
    </>
  );
}

/** Column (a 30px hero tile): three MARK D-columns at x 2.4 / 9.6 / 16.8,
 *  tops 9.6 / 2.4 / 6 (heights 12, 19.2, 15.6), the tallest ACCENT. Their
 *  square feet on y 21.6 are the baseline. Every straight edge is on the 2.4
 *  grid, so the tile is crisp at 20px and at 30px. */
function ChartColumn({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {column(2.4, 9.6, STRONG)}
      {column(9.6, 2.4, ACCENT)}
      {column(16.8, 6, STRONG)}
    </IconFrame>
  );
}

/** Bar (a 30px hero tile): ChartColumn turned a quarter. Three MARK D-bars at
 *  y 2.4 / 9.6 / 16.8 growing from x 2.4 (lengths 12, 19.2, 15.6), the
 *  longest ACCENT; their square roots are the axis. On the 2.4 grid like the
 *  column. */
function ChartBar({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {bar(2.4, 12, STRONG)}
      {bar(9.6, 19.2, ACCENT)}
      {bar(16.8, 15.6, STRONG)}
    </IconFrame>
  );
}

/** Line (a 30px hero tile): the SOFT plot L and one SERIES (3.6) ACCENT
 *  zigzag that turns at right angles: two parallel up-strokes round one
 *  perpendicular down-stroke, every segment 6.46 long, THE gap clear of the L.
 *  The series-line rule of the family: no turn sharper than a right angle
 *  (every interior angle 90 degrees or more) and no segment shorter than 5.6,
 *  so the background inside every turn stays open. The first drawing's
 *  45-degree down-stroke (3.39 long, 79-degree turns) put the up-strokes 3.33
 *  apart, less than the 3.6 stroke, and they merged into one kinked worm. */
function ChartLine({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <PlotAxes />
      <path d="M9 15L11.4 9L17.4 11.4L19.8 5.4" {...line(ACCENT, SERIES)} />
    </IconFrame>
  );
}

/** Area (a 30px hero tile): the plot L and one ACCENT area standing on y 16.8
 *  (THE gap above the L) across the plot x 7.2..21.6. Its sharp top is the
 *  rising zigzag (7.2,12) (12,6) (16.8,9.6) (21.6,3.6) on the stacked areas'
 *  x rhythm, every turn wider than 90 degrees so its valley stays open: the
 *  line's rhythm, filled. */
function ChartArea({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <PlotAxes />
      <path d="M7.2 16.8V12L12 6L16.8 9.6L21.6 3.6V16.8Z" fill={ACCENT} />
    </IconFrame>
  );
}

/** Pie (a 30px hero tile): the EXPLODED quarter. A STRONG three-quarter disc
 *  (R 8.4 on 10.8, 13.2) whose notch is a true right angle at its centre, and
 *  its ACCENT quarter of the same radius moved out by THE gap on both axes,
 *  so both cuts have horizontal and vertical edges (x and y 10.8 | 13.2,
 *  whole pixels at 20px) and the pair spans the field (2R + GAP = 19.2).
 *  Rings are CUT in place (Donut, Gauge) and pies EXPLODED, so the two differ
 *  by silhouette as well as by the hole. */
function ChartPie({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M19.2 13.2A8.4 8.4 0 1 1 10.8 4.8V13.2Z" fill={STRONG} />
      <path d="M13.2 10.8V2.4A8.4 8.4 0 0 1 21.6 10.8Z" fill={ACCENT} />
    </IconFrame>
  );
}

/** Donut: a ring one MARK thick (R 9.6, r 4.8 on 12, 12) CUT in place by
 *  three GAP-wide radial cuts at 12, 3 and 6 o'clock: the ACCENT quarter, a
 *  STRONG quarter and a STRONG half. Each cut is a parallel-sided band, so
 *  every cut edge is horizontal or vertical on x or y 10.8 | 13.2 (the end
 *  points below are that construction to three decimals). With a single
 *  cut-off quarter the STRONG three-quarter ring read as a "C". */
function ChartDonut({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M13.2 2.475A9.6 9.6 0 0 1 21.525 10.8H16.648A4.8 4.8 0 0 0 13.2 7.352Z" fill={ACCENT} />
      <path d="M21.525 13.2A9.6 9.6 0 0 1 13.2 21.525V16.648A4.8 4.8 0 0 0 16.648 13.2Z" fill={STRONG} />
      <path d="M10.8 21.525A9.6 9.6 0 0 1 10.8 2.475V7.352A4.8 4.8 0 0 0 10.8 16.648Z" fill={STRONG} />
    </IconFrame>
  );
}

/** Scatter (a 30px hero tile): the plot L and four equal 4.8 dots (r 2.4,
 *  centres on the 1.2 grid, THE gap apart and from the L) rising to the
 *  right, the highest ACCENT. Equal dots are what tell it from ChartBubble's
 *  sized ones. */
function ChartScatter({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <PlotAxes />
      <circle cx="9.6" cy="14.4" r="2.4" fill={STRONG} />
      <circle cx="16.8" cy="13.2" r="2.4" fill={STRONG} />
      <circle cx="12" cy="7.2" r="2.4" fill={STRONG} />
      <circle cx="19.2" cy="4.8" r="2.4" fill={ACCENT} />
    </IconFrame>
  );
}

/** Waterfall: three MARK marks on the column lattice. A STRONG start
 *  D-column 9.6 tall, the ACCENT step floating from its top (y 12) up to 2.4
 *  as a PILL (both of its ends are values), and the STRONG total D-column
 *  19.2 tall: start + step = total, and the step floats clear of the floor. */
function ChartWaterfall({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {column(2.4, 12, STRONG)}
      {pill(9.6, 2.4, 4.8, 9.6, ACCENT)}
      {column(16.8, 2.4, STRONG)}
    </IconFrame>
  );
}

/** Line and clustered column: three MARK D-columns cut short (heights 8.4 /
 *  9.6 / 10.8, rising) under a SERIES ACCENT wave (4.2,7.8) (9.6,4.2)
 *  (14.4,7.2) (19.8,4.2). Not ChartLine's zigzag but a flatter wave (interior
 *  angles 114 and 119 degrees) that fits above the columns; the heights were
 *  fitted by measurement so the wave's edge stays at least THE gap from every
 *  dome (3.38 at the closest). */
function ChartCombo({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {column(2.4, 13.2, STRONG)}
      {column(9.6, 12, STRONG)}
      {column(16.8, 10.8, STRONG)}
      <path d="M4.2 7.8L9.6 4.2L14.4 7.2L19.8 4.2" {...line(ACCENT, SERIES)} />
    </IconFrame>
  );
}

/** Radar: a SOFT 2.4 hexagon web that fills the field (its vertical sides
 *  crisp on x 2.4 | 21.6, its tips on y 2.4 | 21.6; one path, the inner
 *  hexagon wound the other way) and an irregular ACCENT series, one vertex per
 *  axis, kept THE gap inside the web (each vertex reaches at most the hexagon
 *  inset 4.8 from the web, measured per axis; three decimals). A regular
 *  triangle or pentagon series read as a warning sign or a house at 20px. */
function ChartRadar({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path
        d="M12 2.4L21.6 7.2V16.8L12 21.6L2.4 16.8V7.2ZM4.8 8.683V15.317L12 18.917L19.2 15.317V8.683L12 5.083Z"
        fill={SOFT}
      />
      <path d="M12 7.894L14.54 10.73L16.106 14.053L12 14.54L10.095 12.953L7.894 9.947Z" fill={ACCENT} />
    </IconFrame>
  );
}

/** Bubble: the plot L, one big ACCENT bubble (r 4.2) above two STRONG dots
 *  (r 2.4), THE gap between all of them and from the L: Scatter's dots with
 *  one of them sized. */
function ChartBubble({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <PlotAxes />
      <circle cx="14.4" cy="6.6" r="4.2" fill={ACCENT} />
      <circle cx="9.6" cy="14.4" r="2.4" fill={STRONG} />
      <circle cx="19.2" cy="14.4" r="2.4" fill={STRONG} />
    </IconFrame>
  );
}

/** Histogram: four adjacent 4.8 bins (heights 4.8 / 9.6 / 14.4 / 7.2) as ONE
 *  ACCENT stepped block -- adjacent bins have no gap, which is what makes it
 *  a histogram -- standing THE gap above a SOFT baseline on the field's
 *  bottom edge. The inner steps are crisp (each bin meets its neighbour); the
 *  block's two FREE outer shoulders are quarter circles one bin wide, so the
 *  outline is a skewed bell, not a stepped podium. */
function ChartHistogram({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="19.2" width="19.2" height="2.4" fill={SOFT} />
      <path d="M2.4 16.8A4.8 4.8 0 0 1 7.2 12V7.2H12V2.4H16.8V9.6A4.8 4.8 0 0 1 21.6 14.4V16.8Z" fill={ACCENT} />
    </IconFrame>
  );
}

/** Funnel: three centred MARK pills at y 2.4 / 9.6 / 16.8, 19.2 / 13.2 / 7.2
 *  wide (3.0 narrower on each side per stage), the middle stage ACCENT.
 *  Centred and round at both ends, against ChartBar's left-rooted D-bars. */
function ChartFunnel({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {pill(2.4, 2.4, 19.2, 4.8, STRONG)}
      {pill(5.4, 9.6, 13.2, 4.8, ACCENT)}
      {pill(8.4, 16.8, 7.2, 4.8, STRONG)}
    </IconFrame>
  );
}

/** Treemap: one 19.2 x 16.8 block (landscape, centred) cut by THE gap into
 *  four crisp tiles that shrink in turn: STRONG 6 x 16.8, ACCENT 10.8 x 8.4,
 *  STRONG 4.8 x 6, SOFT 3.6 x 6. The tiles meet each other, so every corner
 *  is square. The densest picture of the set, so it takes more cuts rather
 *  than more area. */
function ChartTreemap({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="2.4" y="3.6" width="6" height="16.8" fill={STRONG} />
      <rect x="10.8" y="3.6" width="10.8" height="8.4" fill={ACCENT} />
      <rect x="10.8" y="14.4" width="4.8" height="6" fill={STRONG} />
      <rect x="18" y="14.4" width="3.6" height="6" fill={SOFT} />
    </IconFrame>
  );
}

/** Stock: three candlesticks on the column lattice (x 2.4 / 9.6 / 16.8),
 *  each a crisp 4.8 body on a 2.4 wick PILL (a wick is free at both ends);
 *  the candle that closed up is ACCENT. */
function ChartStock({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {pill(3.6, 4.8, 2.4, 14.4, STRONG)}
      <rect x="2.4" y="7.2" width="4.8" height="9.6" fill={STRONG} />
      {pill(10.8, 2.4, 2.4, 14.4, ACCENT)}
      <rect x="9.6" y="4.8" width="4.8" height="9.6" fill={ACCENT} />
      {pill(18, 7.2, 2.4, 14.4, STRONG)}
      <rect x="16.8" y="9.6" width="4.8" height="9.6" fill={STRONG} />
    </IconFrame>
  );
}

/** Box and whisker: two plots on the pair's columns (x 3.6 / 13.2), each a
 *  7.2 box cut at its MEDIAN by THE gap (3.6 | 4.8 and 4.8 | 3.6, so the two
 *  medians differ and the plots read as two distributions), 2.4 whiskers and
 *  4.8 x 2.4 PILL caps (a cap is free at both ends; the caps are what Stock's
 *  candles lack). The second plot is ACCENT. One whisker of each plot is 1.2
 *  long where the box needs the room. */
function ChartBoxPlot({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {pill(4.8, 2.4, 4.8, 2.4, STRONG)}
      <rect x="6" y="4.8" width="2.4" height="1.2" fill={STRONG} />
      <rect x="3.6" y="6" width="7.2" height="3.6" fill={STRONG} />
      <rect x="3.6" y="12" width="7.2" height="4.8" fill={STRONG} />
      <rect x="6" y="16.8" width="2.4" height="2.4" fill={STRONG} />
      {pill(4.8, 19.2, 4.8, 2.4, STRONG)}
      {pill(14.4, 2.4, 4.8, 2.4, ACCENT)}
      <rect x="15.6" y="4.8" width="2.4" height="2.4" fill={ACCENT} />
      <rect x="13.2" y="7.2" width="7.2" height="4.8" fill={ACCENT} />
      <rect x="13.2" y="14.4" width="7.2" height="3.6" fill={ACCENT} />
      <rect x="15.6" y="18" width="2.4" height="1.2" fill={ACCENT} />
      {pill(14.4, 19.2, 4.8, 2.4, ACCENT)}
    </IconFrame>
  );
}

/** Sunburst: the EXPLODED RING. The pie's construction on a ring (R 8.4,
 *  r 4.8 on the pie's own centre 10.8, 13.2) round a STRONG centre dot (r 2.4,
 *  the root of the hierarchy): its ACCENT quarter moves out by THE gap on both
 *  axes, as the pie's does, and the rest of the ring is cut once more at 9
 *  o'clock into two STRONG segments. Every cut edge is horizontal or vertical
 *  (three decimals where an edge meets a circle). With the donut cut in place,
 *  pie, donut and sunburst read as one family that differs by shape. */
function ChartSunburst({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <circle cx="10.8" cy="13.2" r="2.4" fill={STRONG} />
      <path d="M19.2 13.2A8.4 8.4 0 0 1 2.486 14.4H6.152A4.8 4.8 0 0 0 15.6 13.2Z" fill={STRONG} />
      <path d="M2.486 12A8.4 8.4 0 0 1 10.8 4.8V8.4A4.8 4.8 0 0 0 6.152 12Z" fill={STRONG} />
      <path d="M13.2 2.4A8.4 8.4 0 0 1 21.6 10.8H18A4.8 4.8 0 0 0 13.2 6Z" fill={ACCENT} />
    </IconFrame>
  );
}

/** Pareto: three descending MARK D-columns (heights 12 / 8.4 / 6) and a
 *  SERIES ACCENT cumulative arc (R 10.8, concave down) that starts beside the
 *  first column's top and rises to the field's top-right corner. Its start
 *  was fitted by measurement to stay THE gap clear of every column. */
function ChartPareto({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {column(2.4, 9.6, STRONG)}
      {column(9.6, 13.2, STRONG)}
      {column(16.8, 15.6, STRONG)}
      <path d="M10.8 9A10.8 10.8 0 0 1 19.8 4.2" {...line(ACCENT, SERIES)} />
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
//
// Grouped, Stacked and Stacked100 are Chart Design's layout toggle, and Stacked
// and Stacked100 are also Visuals gallery tiles, so all three are drawn in the
// Visuals family (2026-10-22). Trendline and the mark and line-style pictures
// below them are furniture and keep the duotone language.

/** Grouped (the Chart Design toggle Grouped | Stacked | 100%): two WHOLE PAIR
 *  columns on Stacked's two slots (x 3.6 and 13.2), a short STRONG one (top
 *  9.6, shorter than Stacked's first column) and a tall ACCENT one (top 2.4),
 *  side by side: two series beside each other, where Stacked splits each
 *  column into a root and an end. Two whole pair columns, so it differs from
 *  ChartColumn's three MARK columns by shape; four thinner columns in two
 *  groups were tried first and read as a signal-strength meter beside the
 *  toggle's bold pairs. Drawn on 2026-10-22 when the family was adopted (the
 *  proposal showed no Grouped). */
function Grouped({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {column(3.6, 9.6, STRONG, PAIR)}
      {column(13.2, 2.4, ACCENT, PAIR)}
    </IconFrame>
  );
}

/** Stacked (the Chart Design toggle Grouped | Stacked | 100%, and Power BI's
 *  "Stacked column" tile): two PAIR columns on the floor, each a crisp STRONG
 *  root (6, then 10.8), THE cut, and the equal ACCENT end segment; the totals
 *  14.4 and 19.2 rise left to right, 4 px apart at 20px. "The same end
 *  segment on different totals", against Stacked100's "the same total, split
 *  differently": the two differ by shape (ribbonIcons.test.tsx holds it). */
function Stacked({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {stackedColumn(3.6, 6)}
      {stackedColumn(13.2, 10.8)}
    </IconFrame>
  );
}

/** 100% stacked column: Stacked's pair with both columns the full 19.2 --
 *  STRONG roots 4.8 and 10.8, THE cut, ACCENT D tops 12 and 6. The second
 *  column is Stacked's own tall column. */
function Stacked100({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {stackedColumn100(3.6, 4.8)}
      {stackedColumn100(13.2, 10.8)}
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
// Power BI's Visualizations pane (the Canvas tab's Visuals gallery)
// ============================================================================
//
// The Canvas tab mirrors Power BI Desktop's report authoring, and its Visuals
// gallery shows Power BI's pane: six pictures to a row, every one a small
// chart. First drawn on 2026-10-08 in Power BI's compositions; redrawn on
// 2026-10-22 in the Visuals family's language (marks.tsx). Power BI's blue is
// ACCENT (the one series or value the picture is about), its grey SOFT, its
// white marks STRONG and filled. Two things Power BI does are not copied:
//
// - Power BI's coloured parts touch the grey ones; ours keep THE gap (2.4) of
//   background between the ACCENT and everything else, so a line that CROSSES
//   columns rides above them instead, and a gauge needle stands in its own
//   cuts. `npm run check:icon-contact` measures it (2.4 for the family, 1.6
//   for the 30px hero).
// - Power BI's KPI is a green AND a red triangle. ACCENT and DANGER never
//   share an icon (and red means "delete" here), so the down half is STRONG
//   (owner decision 2026-10-08).

/** Stacked bar (Power BI's first tile): two PAIR bars from x 2.4, the LONGER
 *  on top: each a crisp STRONG root (10.8, then 6), THE cut, and the equal
 *  ACCENT end segment; totals 19.2 and 14.4. With the short bar on top, the
 *  left-aligned roots and the two D ends drew a stencil capital "B" (whose
 *  smaller bowl is the upper one); longest first reads as two sorted bars.
 *  The stacked COLUMN keeps its rising order. */
function ChartBarStacked({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {stackedBar(3.6, 10.8)}
      {stackedBar(13.2, 6)}
    </IconFrame>
  );
}

/** 100% stacked bar: ChartBarStacked's pair with every bar the full 19.2:
 *  STRONG roots 4.8 and 10.8, THE cut, ACCENT D ends 12 and 6. The same
 *  total split differently, where its twin has the same end segment on
 *  different totals. */
function ChartBarStacked100({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {stackedBar100(3.6, 4.8)}
      {stackedBar100(13.2, 10.8)}
    </IconFrame>
  );
}

/** Stacked area: the plot L, a STRONG lower series whose top is the zigzag
 *  (7.2,13.2) (12,10.8) (16.8,13.2) (21.6,9.6), and the ACCENT series as a
 *  band riding on it. The band's top is that zigzag 7.2 higher; its lower
 *  edge is the zigzag offset THE gap PERPENDICULAR (mitred and cut at x 7.2
 *  and 21.6, written to three decimals), so the cut is a constant 2.4 (the
 *  band thins from 4.0 to 3.4 on the steep last segment). The band has ONE
 *  highest point, the top-right corner, which is what tells it from
 *  ChartAreaStacked100's flat top. */
function ChartAreaStacked({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <PlotAxes />
      <path d="M7.2 16.8V13.2L12 10.8L16.8 13.2L21.6 9.6V16.8Z" fill={STRONG} />
      <path d="M7.2 6L12 3.6L16.8 6L21.6 2.4V6.6L16.547 10.39L12 8.117L7.2 10.517Z" fill={ACCENT} />
    </IconFrame>
  );
}

/** 100% stacked area: ChartAreaStacked's lower series and cut unchanged, with
 *  the ACCENT filling up to the plot's FLAT top at y 2.4. The flat top is the
 *  whole difference from its twin. (The 100% bars are told from theirs by
 *  their aligned ends, but their roots change as well: 4.8 / 10.8 against
 *  ChartBarStacked's 10.8 / 6.) */
function ChartAreaStacked100({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <PlotAxes />
      <path d="M7.2 16.8V13.2L12 10.8L16.8 13.2L21.6 9.6V16.8Z" fill={STRONG} />
      <path d="M7.2 2.4H21.6V6.6L16.547 10.39L12 8.117L7.2 10.517Z" fill={ACCENT} />
    </IconFrame>
  );
}

/** Line and stacked column: Stacked's two PAIR columns (x 3.6..10.8 and
 *  13.2..20.4) cut short under a SERIES ACCENT wave (4.2,8.4) (8.4,4.2)
 *  (13.2,7.2) (19.8,4.2): STRONG roots 3.6 and 4.8 tall, THE cut, and as end
 *  segment the bare cap, a SOFT semicircle (Power BI's grey upper segment).
 *  Two split columns against ChartCombo's three whole ones is what tells the
 *  two apart (ribbonIcons.test.tsx pins the columns to Stacked's); the
 *  heights were fitted by measurement so the wave keeps THE gap from both
 *  caps. Power BI's line CROSSES the columns; ours rides above them, because
 *  a crossing accent line would need a gap cut out of every column it
 *  crosses. */
function ChartComboStacked({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <rect x="3.6" y="18" width="7.2" height="3.6" fill={STRONG} />
      <path d="M3.6 15.6A3.6 3.6 0 0 1 10.8 15.6Z" fill={SOFT} />
      <rect x="13.2" y="16.8" width="7.2" height="4.8" fill={STRONG} />
      <path d="M13.2 14.4A3.6 3.6 0 0 1 20.4 14.4Z" fill={SOFT} />
      <path d="M4.2 8.4L8.4 4.2L13.2 7.2L19.8 4.2" {...line(ACCENT, SERIES)} />
    </IconFrame>
  );
}

/** Card: Power BI's card, a big "123" over the cards' SOFT rule (Power BI's
 *  lightning badge only means "new" and is dropped). Geometric ACCENT digits
 *  stand THE gap above the rule, in y 4.8..16.8: the 1 is a filled 2.4 bar on
 *  the 2.4 grid whose top is cut on a slant from (2.4, 8.4) up to (4.8, 4.8)
 *  -- a flag drawn inside its own width, so the digits do not read as "I23"
 *  -- and the 2 and the 3 are 2.6 strokes on bowls of one centre-line radius
 *  (2.3), which antialias like any curve (the 2's foot has its top edge at
 *  14.2). The digits sit closer than THE gap (the 1 and the 2 are 1.2 apart,
 *  the 2 and the 3 about 1.6 at their closest): they are one value.
 *  No frame: a framed card read as a monitor with a chin (2026-10-08). Until
 *  2026-10-22 the digits were Paste Values' pixel digits moved; the two no
 *  longer share a drawing. */
function ChartCard({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M2.4 8.4L4.8 4.8V16.8H2.4Z" fill={ACCENT} />
      <path d="M7.3 8.4A2.3 2.3 0 1 1 11.865 8.799L7.3 15.5H11.9" {...line(ACCENT, 2.6)} />
      <path d="M16.008 7.35A2.3 2.3 0 1 1 18 10.8A2.3 2.3 0 1 1 16.008 14.25" {...line(ACCENT, 2.6)} />
      <CardRule />
    </IconFrame>
  );
}

/** Multi-row card: two records, each the cards' "value over a rule": a 3.6
 *  value PILL (a value is free at both ends; the first record's ACCENT, the
 *  second's STRONG), THE cut, and a SOFT 2.4 label rule, the second one on
 *  the field's bottom edge like the Card's. It differs by shape from the
 *  Slicer (dots and pills) and the Table (rows cut into cells). */
function ChartMultiRowCard({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      {pill(2.4, 2.4, 12, 3.6, ACCENT)}
      <rect x="2.4" y="8.4" width="19.2" height="2.4" fill={SOFT} />
      {pill(2.4, 13.2, 15.6, 3.6, STRONG)}
      <CardRule />
    </IconFrame>
  );
}

/** KPI: Power BI's up and down indicator as a square turned 45 degrees,
 *  widened to 19.2 x 14.4 and cut once across its middle by THE gap: the
 *  ACCENT upper triangle points up (above target), the STRONG lower triangle
 *  points down (Power BI's red one: ACCENT and DANGER never share an icon,
 *  owner decision 2026-10-08), both cut edges on whole pixels (y 8.4 | 10.8).
 *  It stands on the cards' SOFT rule, like the Card beside it. The first
 *  "Geometric" drawing, a lens of two arcs cut the same way, read as an acorn
 *  rather than as up and down; the 2026-10-08 drawing interlocked two
 *  triangles side by side. */
function ChartKpi({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M12 2.4L20 8.4H4Z" fill={ACCENT} />
      <path d="M4 10.8H20L12 16.8Z" fill={STRONG} />
      <CardRule />
    </IconFrame>
  );
}

/** Gauge: Power BI's half ring with a coloured part and a dark needle,
 *  standing in the cards' value box over their SOFT rule. The ring is R 9.6,
 *  r 4.8 (one MARK thick) on (12, 14.4), its feet cut flat 2.4 below the
 *  centre at y 16.8: ACCENT from the left foot up to the needle (the value,
 *  filled from the minimum, the way the gauge mark paints it), SOFT after it.
 *  The STRONG needle is a hub (r 2.4) with a sharp tip at 1 o'clock, its
 *  sides tangent to the hub; the ring is cut along lines parallel to each
 *  side, THE gap away, so the needle touches neither colour (three decimals
 *  from that construction). Power BI colours the right side of an outlined
 *  arc. */
function ChartGauge({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M2.705 16.8A9.6 9.6 0 0 1 14.56 5.148L8.634 10.978A4.8 4.8 0 0 0 7.843 16.8Z" fill={ACCENT} />
      <path d="M18.733 7.557A9.6 9.6 0 0 1 21.295 16.8H16.157A4.8 4.8 0 0 0 16.646 15.605Z" fill={SOFT} />
      <path d="M16.5 6.606L14.323 15.002A2.4 2.4 0 1 1 10.317 12.689Z" fill={STRONG} />
      <CardRule />
    </IconFrame>
  );
}

/** All Visuals (the hero that opens the gallery): the gallery itself, four
 *  kinds of visual in a 2 x 2, drawn in the band's own DEVICE pixels at 30px,
 *  where one pixel is 0.8 units: marks of 4 px (3.2), THE 2 px cut (1.6),
 *  four 10 px tiles with 4 px gutters, every straight edge on the 0.8 grid.
 *  Top left two D-columns (the tall one ACCENT); top right the exploded pie in
 *  miniature (R 3.2); bottom left two D-bars; bottom right a SOFT ring (a 3 px
 *  wall round a 4 px hole, the inner circle wound the other way). Each tile's
 *  own cut is half its gutter, so the four group as four. It echoes More's
 *  2 x 2 ("more of these") and differs from it by shape; Power BI has no
 *  picture for it (its "..." tile means "get more visuals").
 *
 *  HERO ONLY: drawn for 30px and NOT for 20 or 24 (the 2 px cut would be 1.3
 *  px at 20px). At 2.4 units -- 3 px at 30px -- the 9 px pie collapsed into an
 *  "L" plus a fleck and the tiles did not group. ribbonIcons.test.tsx holds
 *  its points on the 0.8 grid. */
function AllVisuals({ size }: RibbonIconProps): React.ReactElement {
  return (
    <IconFrame size={size}>
      <path d="M2.4 10.4V7.2A1.6 1.6 0 0 1 5.6 7.2V10.4Z" fill={STRONG} />
      <path d="M7.2 10.4V4A1.6 1.6 0 0 1 10.4 4V10.4Z" fill={ACCENT} />
      <path d="M20 7.2A3.2 3.2 0 1 1 16.8 4V7.2Z" fill={STRONG} />
      <path d="M18.4 5.6V2.4A3.2 3.2 0 0 1 21.6 5.6Z" fill={STRONG} />
      <path d="M2.4 13.6H8.8A1.6 1.6 0 0 1 8.8 16.8H2.4Z" fill={STRONG} />
      <path d="M2.4 18.4H5.6A1.6 1.6 0 0 1 5.6 21.6H2.4Z" fill={STRONG} />
      <path
        d="M17.6 13.6A4 4 0 1 1 17.6 21.6A4 4 0 1 1 17.6 13.6ZM17.6 16A1.6 1.6 0 1 0 17.6 19.2A1.6 1.6 0 1 0 17.6 16Z"
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
