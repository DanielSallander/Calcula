//! FILENAME: app/extensions/Animation/types.ts
// PURPOSE: The persisted AnimationSpec — a named, saved animation configuration.
// CONTEXT: Specs round-trip through the .cala workbook via the A5 per-extension
//          persistence tier (see lib/animationStore.ts). Slice 2 ships the
//          "clockCell" driver; the other driver shapes are reserved for later
//          slices (chartParam / scenario / monteCarlo) and added as optional
//          discriminated fields then.

export type DriverKind = "clockCell"; // future: | "chartParam" | "scenario" | "monteCarlo"

export interface ClockCellSpec {
  /** Driver cell (0-based). */
  row: number;
  col: number;
  /** Sweep range and step. */
  from: number;
  to: number;
  step: number;
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
}
