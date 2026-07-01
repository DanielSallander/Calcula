//! FILENAME: app/extensions/Animation/types.ts
// PURPOSE: The persisted AnimationSpec — a named, saved animation configuration.
// CONTEXT: Specs round-trip through the .cala workbook via the A5 per-extension
//          persistence tier (see lib/animationStore.ts). Slice 2 ships the
//          "clockCell" driver; the other driver shapes are reserved for later
//          slices (chartParam / scenario / monteCarlo) and added as optional
//          discriminated fields then.

export type DriverKind = "clockCell" | "chartParam" | "scenario" | "monteCarlo";

/** Tween across named Scenario Manager scenarios as keyframes. */
export interface ScenarioSpec {
  sheetIndex: number;
  /** Scenario names, in visiting order. */
  keyframes: string[];
  /** Frames to spend tweening between adjacent keyframes (linear mode). */
  framesPerSegment: number;
  /** "step" snaps between scenarios; "linear" lerps numeric changing cells. */
  interpolate: "step" | "linear";
}

/** Repeatedly re-roll volatile (RAND) cells and accumulate an outcome distribution. */
export interface MonteCarloSpec {
  sheetIndex: number;
  outcomeRow: number;
  outcomeCol: number;
  trials: number;
  /** Histogram bin count (default 20). */
  bins?: number;
}

export interface ClockCellSpec {
  /** Driver cell (0-based). */
  row: number;
  col: number;
  /** Sweep range and step. */
  from: number;
  to: number;
  step: number;
}

/** The values a chart-param sweep visits: a numeric range or an explicit option list. */
export type ChartParamSequence =
  | { kind: "range"; from: number; to: number; step: number }
  | { kind: "options"; options: (string | number)[] };

export interface ChartParamSpec {
  chartId: string;
  paramName: string;
  sequence: ChartParamSequence;
}

export interface PlaybackSettings {
  fps: number;
  loop: boolean;
  /** Optional play sub-range within [0, frameCount-1]; absent = full range. */
  rangeStart?: number;
  rangeEnd?: number;
}

export interface AnimationSpec {
  id: string;
  name: string;
  sheetIndex: number;
  driver: DriverKind;
  playback: PlaybackSettings;
  clockCell?: ClockCellSpec;
  chartParam?: ChartParamSpec;
  scenario?: ScenarioSpec;
  monteCarlo?: MonteCarloSpec;
}
