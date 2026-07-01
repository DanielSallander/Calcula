//! FILENAME: app/extensions/Animation/lib/animationEngine.ts
// PURPOSE: The singleton animation engine — one PlaybackClock plus driver
//          configuration. This is the surface the timeline panel and status-bar
//          transport subscribe to and drive. Keeping it a module singleton (not a
//          React store) lets the rAF/async loop live outside React while the UI
//          reflects its state via subscribe().

import { createPlaybackClock, type ClockState } from "./playbackClock";
import { createClockCellDriver, type ClockCellConfig } from "../drivers/clockCellDriver";
import { createChartParamDriver } from "../drivers/chartParamDriver";
import { createScenarioDriver } from "../drivers/scenarioDriver";
import { createMonteCarloDriver } from "../drivers/monteCarloDriver";
import { mcReset, mcDeactivate } from "./monteCarloStore";
import { toA1 } from "./a1";
import type { AnimationSpec, ChartParamSpec, ScenarioSpec, MonteCarloSpec } from "../types";

const clock = createPlaybackClock();

/** What a GIF export should capture for the current driver. */
export type ExportSourceHint = { kind: "chart"; chartId: string } | { kind: "grid" } | null;
let exportSource: ExportSourceHint = null;

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
    mcDeactivate();
    exportSource = { kind: "grid" };
    await clock.setDriver(createClockCellDriver(cfg));
  },

  /** Configure (and restore any prior) a chart-param driver. Leaves playback idle. */
  async setChartParamDriver(cfg: ChartParamSpec): Promise<void> {
    mcDeactivate();
    exportSource = { kind: "chart", chartId: cfg.chartId };
    await clock.setDriver(createChartParamDriver(cfg));
  },

  /** Configure a scenario keyframe-tween driver. Leaves playback idle. */
  async setScenarioDriver(cfg: ScenarioSpec): Promise<void> {
    mcDeactivate();
    exportSource = { kind: "grid" };
    await clock.setDriver(createScenarioDriver(cfg));
  },

  /** Configure a Monte Carlo driver (activates the histogram). Leaves playback idle. */
  async setMonteCarloDriver(cfg: MonteCarloSpec): Promise<void> {
    mcReset(toA1(cfg.outcomeRow, cfg.outcomeCol));
    exportSource = null;
    await clock.setDriver(createMonteCarloDriver(cfg));
  },

  /** Load a saved AnimationSpec into the engine (restores any prior driver). */
  async loadSpec(spec: AnimationSpec): Promise<void> {
    if (spec.driver === "clockCell" && spec.clockCell) {
      mcDeactivate();
      exportSource = { kind: "grid" };
      await clock.setDriver(createClockCellDriver({ sheetIndex: spec.sheetIndex, ...spec.clockCell }));
    } else if (spec.driver === "chartParam" && spec.chartParam) {
      mcDeactivate();
      exportSource = { kind: "chart", chartId: spec.chartParam.chartId };
      await clock.setDriver(createChartParamDriver(spec.chartParam));
    } else if (spec.driver === "scenario" && spec.scenario) {
      mcDeactivate();
      exportSource = { kind: "grid" };
      await clock.setDriver(createScenarioDriver(spec.scenario));
    } else if (spec.driver === "monteCarlo" && spec.monteCarlo) {
      mcReset(toA1(spec.monteCarlo.outcomeRow, spec.monteCarlo.outcomeCol));
      exportSource = null;
      await clock.setDriver(createMonteCarloDriver(spec.monteCarlo));
    } else {
      return;
    }
    clock.setFps(spec.playback.fps);
    clock.setLoop(spec.playback.loop);
    if (spec.playback.rangeStart != null && spec.playback.rangeEnd != null) {
      clock.setRange(spec.playback.rangeStart, spec.playback.rangeEnd);
    }
  },

  /** What a GIF export should capture for the current driver (null = no driver). */
  getExportSource(): ExportSourceHint {
    return exportSource;
  },

  /** Drop the current driver, restoring the model first. */
  async clearDriver(): Promise<void> {
    mcDeactivate();
    exportSource = null;
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
