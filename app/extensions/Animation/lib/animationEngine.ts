//! FILENAME: app/extensions/Animation/lib/animationEngine.ts
// PURPOSE: The singleton animation engine — one PlaybackClock plus driver
//          configuration. This is the surface the timeline panel and status-bar
//          transport subscribe to and drive. Keeping it a module singleton (not a
//          React store) lets the rAF/async loop live outside React while the UI
//          reflects its state via subscribe().

import { createPlaybackClock, type ClockState } from "./playbackClock";
import { createClockCellDriver, type ClockCellConfig } from "../drivers/clockCellDriver";
import type { AnimationSpec } from "../types";

const clock = createPlaybackClock();

export type { ClockState } from "./playbackClock";

export const playbackEngine = {
  getState: clock.getState,
  subscribe: clock.subscribe,

  play: clock.play,
  pause: clock.pause,
  stop: clock.stop,
  step: clock.step,
  seek: clock.seek,
  setFps: clock.setFps,
  setLoop: clock.setLoop,
  setRange: clock.setRange,

  /** Configure (and restore any prior) a clock-cell driver. Leaves playback idle. */
  async setClockCellDriver(cfg: ClockCellConfig): Promise<void> {
    await clock.setDriver(createClockCellDriver(cfg));
  },

  /** Load a saved AnimationSpec into the engine (restores any prior driver). */
  async loadSpec(spec: AnimationSpec): Promise<void> {
    if (spec.driver === "clockCell" && spec.clockCell) {
      await clock.setDriver(createClockCellDriver({ sheetIndex: spec.sheetIndex, ...spec.clockCell }));
      clock.setFps(spec.playback.fps);
      clock.setLoop(spec.playback.loop);
      if (spec.playback.rangeStart != null && spec.playback.rangeEnd != null) {
        clock.setRange(spec.playback.rangeStart, spec.playback.rangeEnd);
      }
    }
  },

  /** Drop the current driver, restoring the model first. */
  async clearDriver(): Promise<void> {
    await clock.setDriver(null);
  },

  /** Force-stop and restore the model. Wired to file/sheet lifecycle events. */
  async stopAndRestore(): Promise<void> {
    await clock.stop();
  },

  dispose: clock.dispose,
};

export type AnimationEngine = typeof playbackEngine;
export type { ClockCellConfig } from "../drivers/clockCellDriver";
export type EngineState = ClockState;
