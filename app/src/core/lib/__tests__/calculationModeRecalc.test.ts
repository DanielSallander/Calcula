//! FILENAME: app/src/core/lib/__tests__/calculationModeRecalc.test.ts
// PURPOSE: Leaving manual for automatic is a recalculation (Excel [LIVE]:
//          `Application.Calculation = xlAutomatic` recalculates and
//          CalculationState becomes xlDone). The backend now runs that
//          Calculate Now inside `set_calculation_mode` and answers the cells it
//          repainted, so EVERY caller of the lib wrapper -- the Formulas menu,
//          a script's setCalculationMode("automatic"), the release when a
//          script holding manual ends, the workbook-swap sweep -- must show
//          them and announce the pass. Only the menu used to, by chaining
//          calculateNow itself. Only Tauri's `invoke` is doubled.

import { describe, it, expect, beforeEach, vi } from "vitest";

let reply: unknown = null;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    if (cmd === "set_calculation_mode") return Promise.resolve(reply);
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
  listen: vi.fn(async () => () => {}),
}));

import { setCalculationMode } from "../tauri-api";
import { cellEvents } from "../cellEvents";
import { AppEvents } from "../events";

describe("setCalculationMode paints the recalculation leaving manual runs", () => {
  let painted: Array<{ row: number; col: number; newValue: unknown }>;
  let completed: unknown[];
  let refreshes: number;
  const onComplete = (e: Event) => completed.push((e as CustomEvent).detail);
  const onRefresh = () => {
    refreshes += 1;
  };

  beforeEach(() => {
    painted = [];
    completed = [];
    refreshes = 0;
    window.removeEventListener(AppEvents.RECALCULATION_COMPLETED, onComplete);
    window.removeEventListener("grid:refresh", onRefresh);
    window.addEventListener(AppEvents.RECALCULATION_COMPLETED, onComplete);
    window.addEventListener("grid:refresh", onRefresh);
  });

  it("shows the recalculated cells and announces the workbook pass", async () => {
    const off = cellEvents.subscribe((e) => painted.push({ row: e.row, col: e.col, newValue: e.newValue }));
    reply = {
      mode: "automatic",
      recalculated: [{ row: 0, col: 1, display: "10", formula: "=A1*2", styleIndex: 0 }],
    };
    const mode = await setCalculationMode("automatic");
    off();
    expect(mode).toBe("automatic");
    expect(painted).toEqual([{ row: 0, col: 1, newValue: "10" }]);
    expect(refreshes).toBe(1);
    expect(completed).toHaveLength(1);
    expect((completed[0] as { scope: string; cellsUpdated: number }).scope).toBe("workbook");
    expect((completed[0] as { scope: string; cellsUpdated: number }).cellsUpdated).toBe(1);
  });

  it("paints and announces nothing when nothing was recalculated", async () => {
    const off = cellEvents.subscribe((e) => painted.push({ row: e.row, col: e.col, newValue: e.newValue }));
    reply = { mode: "manual", recalculated: null };
    const mode = await setCalculationMode("manual");
    off();
    expect(mode).toBe("manual");
    expect(painted).toEqual([]);
    expect(refreshes).toBe(0);
    expect(completed).toHaveLength(0);
  });
});
