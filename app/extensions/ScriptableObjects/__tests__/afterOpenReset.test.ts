//! FILENAME: app/extensions/ScriptableObjects/__tests__/afterOpenReset.test.ts
// PURPOSE: Collaboration > Open Application for Editing must PAY a script's
//          manual-calculation debt, not forget it (rev14C, round 16).
// CONTEXT: AFTER_OPEN's sweep forgot the debt for every emitter. The checkout
//          emitter ({ path: "", source: "checkout" }) appends sheets to the
//          SAME live workbook and sets no calculation mode, so the workbook
//          stayed in manual calculation after the script that asked for it was
//          unmounted. A File > Open ({ path }) has set the opened file's mode,
//          and there the debt is still forgotten (rev12B, round 13).

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

/** The backend the host's lazy `getLib()` reaches: just the calculation mode. */
const backend = vi.hoisted(() => ({ mode: "automatic" as string, switches: [] as string[] }));

vi.mock("@api/grid", () => ({
  refreshGridData: vi.fn(),
  refreshGridDimensions: vi.fn(),
  convertFormulaStyle: vi.fn(async (f: string) => f),
  getGridStateSnapshot: vi.fn((): unknown => null),
}));
vi.mock("@api/lib", () => ({
  getActiveSheet: vi.fn(async () => 0),
  getCalculationMode: vi.fn(async () => backend.mode),
  setCalculationMode: vi.fn(async (mode: string) => {
    backend.switches.push(mode);
    backend.mode = mode;
    return mode;
  }),
}));

import * as lib from "@api/lib";
import {
  executeSetCalculationMode,
  hostResetAll,
  resetManualCalculationTracking,
  scriptsHoldingManualCalculation,
  settleHostResetRestores,
} from "@api/scriptHost/host";
import { resetOptionsForAfterOpen } from "../lib/afterOpenReset";

beforeEach(() => {
  resetManualCalculationTracking();
  backend.mode = "automatic";
  backend.switches = [];
});

async function scriptHoldsManual(): Promise<void> {
  await executeSetCalculationMode(lib as never, "script-1", "manual");
  expect(scriptsHoldingManualCalculation().has("script-1")).toBe(true);
  backend.switches = [];
}

describe("the AFTER_OPEN sweep: an Open Application for Editing pays the manual debt, a File > Open forgets it", () => {
  it("checkout ({ path: '', source: 'checkout' }): calculation goes back to automatic", async () => {
    await scriptHoldsManual();
    hostResetAll(resetOptionsForAfterOpen({ path: "", source: "checkout" }));
    await settleHostResetRestores();
    expect(backend.switches, "the script is gone but calculation stayed manual").toEqual(["automatic"]);
    expect(backend.mode).toBe("automatic");
    expect(scriptsHoldingManualCalculation().size).toBe(0);
  });

  it("control: File > Open ({ path }) keeps the mode the opened file set", async () => {
    await scriptHoldsManual();
    hostResetAll(resetOptionsForAfterOpen({ path: "C:\\Books\\Saved manual.cala" }));
    await settleHostResetRestores();
    expect(backend.switches).toEqual([]);
    expect(backend.mode).toBe("manual");
  });

  it("the AFTER_OPEN handler asks the payload (source pin)", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../index.ts"), "utf8");
    const afterOpen = src.slice(src.indexOf("onAppEvent(AppEvents.AFTER_OPEN"));
    const handler = afterOpen.slice(0, afterOpen.indexOf("onAppEvent(", 10));
    expect(handler).toContain("resetObjectScriptManager(resetOptionsForAfterOpen(payload))");
  });
});
