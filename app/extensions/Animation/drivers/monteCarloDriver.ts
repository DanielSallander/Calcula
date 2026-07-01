//! FILENAME: app/extensions/Animation/drivers/monteCarloDriver.ts
// PURPOSE: The Monte Carlo driver — each frame is one trial: force a full recalc
//          (re-rolls RAND/RANDBETWEEN) and read the outcome cell, accumulating the
//          distribution into the monteCarloStore (the panel renders a histogram).
//          Nothing to "restore" (RAND is volatile); a final grid:refresh syncs the
//          frontend grid to the last roll.
import type { Driver } from "../lib/driver";
import type { MonteCarloSpec } from "../types";
import { animRerollAndRead } from "../lib/animationBackend";
import { mcReset, mcPush } from "../lib/monteCarloStore";
import { toA1 } from "../lib/a1";
import { emitAppEvent } from "@api/events";

export function createMonteCarloDriver(cfg: MonteCarloSpec): Driver {
  const label = toA1(cfg.outcomeRow, cfg.outcomeCol);
  return {
    frameCount: Math.max(1, Math.floor(cfg.trials)),

    async snapshot(): Promise<void> {
      mcReset(label); // fresh run
    },

    async applyFrame(): Promise<void> {
      const res = await animRerollAndRead(cfg.sheetIndex, cfg.outcomeRow, cfg.outcomeCol);
      if (res.value != null && Number.isFinite(res.value)) mcPush(res.value);
    },

    async restore(): Promise<void> {
      // RAND cells are volatile — no meaningful "original" to restore. Sync the
      // grid view to the final roll.
      emitAppEvent("grid:refresh");
    },

    frameLabel(t: number): string {
      return `trial ${t + 1}`;
    },
  };
}
