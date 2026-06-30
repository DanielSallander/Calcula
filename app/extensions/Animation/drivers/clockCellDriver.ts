//! FILENAME: app/extensions/Animation/drivers/clockCellDriver.ts
// PURPOSE: The "clock-cell" driver — the core mode. A designated driver cell
//          advances over [from, to] by `step`; the whole model recalculates and
//          charts/cells repaint each frame. The driver value reaches the model
//          transiently (anim_apply_frame), and the cell is restored on stop.

import type { Driver } from "../lib/driver";
import { repaintFromCells } from "../lib/repaint";
import { animSnapshot, animApplyFrame, animRestore } from "../lib/animationBackend";

export interface ClockCellConfig {
  sheetIndex: number;
  row: number;
  col: number;
  from: number;
  to: number;
  step: number;
}

let driverSeq = 0;

/** Number of frames a [from, to] sweep by `step` produces (always >= 1). */
export function computeFrameCount(from: number, to: number, step: number): number {
  if (!Number.isFinite(step) || step === 0) return 1;
  const span = to - from;
  if (Math.sign(span) !== Math.sign(step) && span !== 0) return 1; // step points away from `to`
  const n = Math.floor(Math.abs(span) / Math.abs(step) + 1e-9) + 1;
  return Math.max(1, n);
}

/** The driver value at frame `t`, FP-noise rounded. */
export function valueAtFrame(cfg: ClockCellConfig, t: number): number {
  const raw = cfg.from + t * cfg.step;
  return Math.round(raw * 1e9) / 1e9;
}

export function createClockCellDriver(cfg: ClockCellConfig): Driver {
  const token = `anim-clock-${cfg.sheetIndex}-${cfg.row}-${cfg.col}-${++driverSeq}`;
  const frameCount = computeFrameCount(cfg.from, cfg.to, cfg.step);

  return {
    frameCount,

    async snapshot(): Promise<void> {
      await animSnapshot(token, cfg.sheetIndex, [[cfg.row, cfg.col]]);
    },

    async applyFrame(t: number): Promise<void> {
      const value = valueAtFrame(cfg, t);
      const res = await animApplyFrame(cfg.sheetIndex, [
        { row: cfg.row, col: cfg.col, value: String(value) },
      ]);
      repaintFromCells(res.updatedCells);
    },

    async restore(): Promise<void> {
      const res = await animRestore(token, cfg.sheetIndex);
      repaintFromCells(res.updatedCells);
    },

    frameLabel(t: number): string {
      return String(valueAtFrame(cfg, t));
    },
  };
}
