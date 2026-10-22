//! FILENAME: app/src/api/icons/marks.tsx
// PURPOSE: The construction kit of the Visuals family: the sizes, the one gap
//          and the few forms every chart, card and table picture is cut from.
// CONTEXT: The Canvas tab's Visuals icons were redrawn on 2026-10-22 in the
//          owner's chosen direction "Geometric" (Direction B of the three-way
//          proposal, docs/design/ICONS.md section 2.5): every picture is cut
//          from squares, circles, semicircles, quarter circles and sharp
//          polygons, its parts held apart by ONE constant cut. The family is
//          the 33 visuals, the All Visuals hero and Chart Design's Grouped
//          toggle (which sits beside Stacked and Stacked100); the rest of the
//          set keeps the duotone rules of frame.tsx. The columns, bars,
//          stacked pairs, pills, D-marks, the plot's L and the cards' rule are
//          drawn with the helpers below; the round pictures, the radar,
//          treemap, histogram, Matrix and the hero are written out on the same
//          sizes (their comments give the construction).
//
//          THE CORNER RULE (the whole family's look, "sharp yet smooth"):
//          - square (rx 0) where a part MEETS something: its root (columns
//            stand on y 21.6, bars grow from x 2.4), THE cut to a neighbour, a
//            cell of the lattice;
//          - a FULL curve where a part ENDS freely: a value end is a semicircle
//            of radius = half the part's thickness (the D-mark), a part free at
//            both ends is a pill, a point is a circle, and the free outer
//            corner of a bent part is a true quarter circle;
//          - never an in-between radius. Polygons and triangles stay sharp.
//
//          THE GAP is 2.4 (two whole pixels at 20px): every cut, every space
//          between marks, and the clearance round the ACCENT, which therefore
//          never touches SOFT or STRONG (the dark-green-on-near-black lumps of
//          the first set were the owner's "blotchy"). `npm run
//          check:icon-contact` holds the family's ACCENT to it. The 30px All
//          Visuals hero draws the same gap in ITS device pixels (1.6 = 2 px at
//          30px). Two recorded exceptions sit closer than THE gap between parts
//          of one ink: the Card's digits (1.2 apart) and one box-plot whisker
//          per plot (1.2 long).
//
//          Every straight edge of a filled shape sits on the 1.2 pixel grid
//          (whole pixels at 20px), and on the 2.4 grid wherever that costs
//          nothing, which is also whole pixels at 150% and at the 30px quick
//          tiles (ribbonIcons.test.tsx holds it). The hero is on its own 0.8
//          grid, and the Card's stroked 2 and 3 antialias like any curve.

import React from "react";
import { SOFT, coord } from "./frame";

/** THE gap: every cut, every space between two marks, the ACCENT's clearance. */
export const GAP = 2.4;
/** A mark: a bar, a column, a ring, a dot (diameter), a table cell. Three
 *  marks and two gaps fill the 19.2 field exactly (x 2.4 / 9.6 / 16.8). */
export const MARK = 4.8;
/** A mark of a stacked PAIR: two pair marks and a gap span 16.8, the pair
 *  centred in the field, so the marks start at x 3.6 and 13.2 (y for bars). */
export const PAIR = 7.2;
/** An axis, a caption or target rule: two whole pixels at 20px. */
export const RULE = 2.4;
/** A series line (round caps and joins): three pixels at 20px. */
export const SERIES = 3.6;
/** The field's far edge: columns stand on it (y 21.6), the 100% bars end on
 *  it (x 21.6), and the plot's L and the cards' rule reach it. The near edge
 *  is 2.4 (the set's margin). */
export const FLOOR = 21.6;

/** Which end of a D-mark is free (the semicircle). */
export type MarkEnd = "top" | "bottom" | "left" | "right";

/**
 * A D-mark: square corners at its root, a semicircle of radius = half its
 * thickness at its free end. `(x, y, w, h)` is the whole mark, cap included.
 */
export function dMark(x: number, y: number, w: number, h: number, end: MarkEnd, paint: string): React.ReactElement {
  const X = coord(x), Y = coord(y), R = coord(x + w), B = coord(y + h);
  let d: string;
  if (end === "top") {
    const r = w / 2;
    d = `M${X} ${B}V${coord(y + r)}A${coord(r)} ${coord(r)} 0 0 1 ${R} ${coord(y + r)}V${B}Z`;
  } else if (end === "bottom") {
    const r = w / 2;
    d = `M${X} ${Y}H${R}V${coord(y + h - r)}A${coord(r)} ${coord(r)} 0 0 1 ${X} ${coord(y + h - r)}Z`;
  } else if (end === "right") {
    const r = h / 2;
    d = `M${X} ${Y}H${coord(x + w - r)}A${coord(r)} ${coord(r)} 0 0 1 ${coord(x + w - r)} ${B}H${X}Z`;
  } else {
    const r = h / 2;
    d = `M${R} ${Y}V${B}H${coord(x + r)}A${coord(r)} ${coord(r)} 0 0 1 ${coord(x + r)} ${Y}Z`;
  }
  return <path d={d} fill={paint} />;
}

/** A column standing on the floor (y 21.6) up to `top`: a D-mark whose cap is
 *  its value end and whose square foot is the baseline (no axis is drawn). */
export function column(x: number, top: number, paint: string, width: number = MARK): React.ReactElement {
  return dMark(x, top, width, FLOOR - top, "top", paint);
}

/** A bar growing from the field's left edge (x 2.4), `length` long: a D-mark
 *  whose square root is the axis. */
export function bar(y: number, length: number, paint: string, thickness: number = MARK): React.ReactElement {
  return dMark(2.4, y, length, thickness, "right", paint);
}

/** A pill: a part free at BOTH ends (a slicer label, a funnel stage, a wick,
 *  a cap), so both ends are full curves: rx = half its short side. */
export function pill(x: number, y: number, w: number, h: number, paint: string): React.ReactElement {
  return (
    <rect x={coord(x)} y={coord(y)} width={coord(w)} height={coord(h)} rx={coord(Math.min(w, h) / 2)} fill={paint} />
  );
}

/** The x/y family's frame (line, area, scatter, bubble): ONE SOFT L of 2.4
 *  rules with a crisp corner and square ends, drawn as one path so the corner
 *  paints once. The plot inside it, THE gap clear, is x 7.2..21.6 and
 *  y 2.4..16.8. */
export function PlotAxes(): React.ReactElement {
  return <path d="M2.4 2.4H4.8V19.2H21.6V21.6H2.4Z" fill={SOFT} />;
}

/** The cards' SOFT caption (or target) rule, on the field's bottom edge
 *  (y 19.2..21.6, where the other pictures end). Card, Multi-row card, KPI
 *  and Gauge share it, and everything above it stands THE gap clear (to
 *  y 16.8); the Card and the Gauge fill y 4.8..16.8. */
export function CardRule(): React.ReactElement {
  return <rect x="2.4" y={coord(FLOOR - RULE)} width="19.2" height={coord(RULE)} fill={SOFT} />;
}
