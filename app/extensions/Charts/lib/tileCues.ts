//! FILENAME: app/extensions/Charts/lib/tileCues.ts
// PURPOSE: The Insights cue host's half of contract §4.2: a title-only tile
//          (Card, Multi-row card, KPI, Gauge) shows no insight cues.
// CONTEXT: Insights (@api/chartCues) decides WHICH datums deserve a ring; Charts
//          decides where a ring can be DRAWN. A ring hugs a datum's bar or
//          point. A tile has no such shape — its hit rect is the whole card or
//          the whole gauge — so a ring there would outline the visual and read
//          as a claim about a value nobody can see. Every Charts place that
//          paints or hit-tests cues (chartRenderer's paint, hover and lens;
//          the PNG export in chartRaster; the click in index.ts) asks this one
//          function, so no path can disagree with another.
//
//          Insights itself should also hide its "points of interest" quick
//          action on these marks — it can ask `chartMarkFurniture` in
//          @api/chartMarks; Charts does not own that extension.

import { markFurniture } from "../types";

/** The cues a chart of `mark` may show: all of them, or none on a tile. */
export function cuesShownOn<T>(mark: string, cues: readonly T[]): readonly T[] {
  return markFurniture(mark) === "titleOnly" ? NO_CUES : cues;
}

const NO_CUES: readonly never[] = Object.freeze([]);
