//! FILENAME: app/extensions/Charts/lib/crossFilterPress.ts
// PURPOSE: The LIFE of a cross-filter press (P4, G4, S6): a press on a canvas
//          design-query chart's datum, legend entry or (while it has a
//          selection) background, outside Design Mode -- CONTENT in the chart's
//          zone answer (`part: "crossFilter"`, lib/chartZoneAt.ts). It is armed
//          at Core's `floatingObject:bodyDragStart` and acts only when it is
//          RELEASED over the SAME datum (index.ts `handleMouseUp` ->
//          `releaseCrossFilter`); a drag off the datum cancels, as a Windows
//          button does, and never moves the chart.
// CONTEXT: The press keeps ITS OWN record -- the chart, the point and the hit
//          it was armed over, whether the chart was selected before the press
//          -- because the pending click the cue code used to read is cleared
//          at the press (it would otherwise ALSO advance the selection ladder),
//          and a pending click exists only for an already-selected chart
//          anyway (review A5). The next press, a move with the primary button
//          UP (a release this page never heard), the release itself and the
//          extension's deactivation end it.

import type { ChartHitResult } from "../types";

/** A held cross-filter press. */
export interface CrossFilterPressState {
  chartId: string;
  /** The grid region Core pressed (the chart's), or null when Core named none. */
  regionId: string | null;
  /** The press point, logical canvas px. */
  canvasX: number;
  canvasY: number;
  /** The press point, chart-local px (the basis the hit test and the cue use). */
  localX: number;
  localY: number;
  /** What the press landed on: a datum, a legend entry, or the background. */
  hit: ChartHitResult;
  /** Ctrl (or Cmd) was held at the press. */
  ctrl: boolean;
  /** The chart was selected BEFORE this press (Core selects it at the press). */
  wasSelected: boolean;
}

let held: CrossFilterPressState | null = null;

/** Arm a cross-filter press. One still held (its release never came) ends first, doing nothing. */
export function beginCrossFilterPress(press: CrossFilterPressState): void {
  held = press;
}

/** The RELEASE: end the press and hand it back. Null when none is held. */
export function takeCrossFilterPress(): CrossFilterPressState | null {
  const p = held;
  held = null;
  return p;
}

/** End a held press WITHOUT acting (the next press, a lost release, deactivation). */
export function cancelCrossFilterPress(): void {
  held = null;
}

/** Whether a cross-filter press is held. */
export function isCrossFilterPressActive(): boolean {
  return held !== null;
}

/**
 * The identity of what a hit landed on, for "released over the SAME datum":
 * a datum by its series and point, a legend entry by its index, anything else
 * as the background.
 */
export function crossFilterHitIdentity(hit: ChartHitResult | null | undefined, isMember: (h: ChartHitResult) => boolean): string {
  if (!hit || !isMember(hit)) return "background";
  if (hit.element === "legendEntry") return `legend:${hit.seriesIndex ?? -1}`;
  return `datum:${hit.seriesIndex ?? -1}:${hit.pointIndex ?? -1}`;
}
