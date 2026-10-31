//! FILENAME: app/src/core/lib/__tests__/calculationModeOrder.test.ts
// PURPOSE: Calculation-mode switches are applied ONE AT A TIME, IN CALL ORDER.
// CONTEXT: Round-13 fix lane "whatif3" (2026-10-30). `set_calculation_mode` is
//          an async command: two switches sent close together (Manual, then
//          Automatic) started their bodies on pool threads in either order, so
//          the backend could end in the EARLIER click's mode while the
//          Formulas menu showed the later one. The lib wrapper now sends a
//          switch only once the previous one has settled, so the last call is
//          the last applied, and answers the mode in effect, which the menu
//          adopts. Only Tauri's `invoke` is doubled.

import { describe, it, expect, vi } from "vitest";

type Pending = { mode: string; resolve: (v: unknown) => void; reject: (e: unknown) => void };
const sent: Pending[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: { mode: string }) => {
    if (cmd !== "set_calculation_mode") return Promise.resolve(null);
    return new Promise((resolve, reject) => sent.push({ mode: args.mode, resolve, reject }));
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
  listen: vi.fn(async () => () => {}),
}));

import { setCalculationMode } from "../tauri-api";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("setCalculationMode applies switches in call order", () => {
  it("sends the second switch only after the first has settled", async () => {
    sent.length = 0;
    const first = setCalculationMode("manual");
    const second = setCalculationMode("automatic");
    await flush();
    expect(sent.map((p) => p.mode), "both switches were sent at once, so they could apply in either order").toEqual([
      "manual",
    ]);

    sent[0].resolve({ mode: "manual", recalculated: null });
    expect(await first).toBe("manual");
    await flush();
    expect(sent.map((p) => p.mode)).toEqual(["manual", "automatic"]);
    sent[1].resolve({ mode: "automatic", recalculated: [] });
    expect(await second).toBe("automatic");
  });

  it("a switch that fails does not hold up the next one", async () => {
    sent.length = 0;
    const first = setCalculationMode("manual");
    const second = setCalculationMode("automatic");
    await flush();
    sent[0].reject(new Error("refused"));
    await expect(first).rejects.toThrow("refused");
    await flush();
    expect(sent.map((p) => p.mode)).toEqual(["manual", "automatic"]);
    sent[1].resolve({ mode: "automatic", recalculated: null });
    expect(await second).toBe("automatic");
  });
});
