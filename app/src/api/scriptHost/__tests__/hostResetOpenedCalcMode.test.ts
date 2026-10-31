//! FILENAME: app/src/api/scriptHost/__tests__/hostResetOpenedCalcMode.test.ts
// PURPOSE: The workbook reset's manual-calculation sweep must not override the
//          calculation mode an OPENED file set (rev12B, round 13).
// CONTEXT: A script that called api.setCalculationMode("manual") owes the
//          workbook "automatic" when it ends. File > Open runs open_file --
//          which adopts the mode the file was saved under (calc_mode.json /
//          calcPr) -- and only THEN emits AFTER_OPEN, whose sweep
//          (ScriptableObjects -> resetObjectScriptManager -> hostResetAll) paid
//          that debt by switching the NEW workbook to automatic (a whole
//          Calculate Now since round 12). After an open the debt is forgotten;
//          a close (the workbook is still live and may be saved) and a File >
//          New (which keeps the session's mode) still pay it.

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

vi.mock("../../grid", () => ({
  refreshGridData: vi.fn(),
  refreshGridDimensions: vi.fn(),
  convertFormulaStyle: vi.fn(async (f: string) => f),
  getGridStateSnapshot: vi.fn((): unknown => null),
}));
vi.mock("../../../core/lib/cellEvents", () => ({
  cellEvents: { emitBatch: vi.fn() },
  cellToChange: vi.fn((c: unknown) => c),
}));

/** The backend the host's lazy `getLib()` reaches: just the calculation mode. */
const backend = vi.hoisted(() => ({ mode: "automatic" as string, switches: [] as string[] }));

vi.mock("../../lib", () => ({
  getActiveSheet: vi.fn(async () => 0),
  getCalculationMode: vi.fn(async () => backend.mode),
  setCalculationMode: vi.fn(async (mode: string) => {
    backend.switches.push(mode);
    backend.mode = mode;
    return mode;
  }),
}));

import * as lib from "../../lib";
import {
  executeSetCalculationMode,
  hostResetAll,
  resetManualCalculationTracking,
  scriptsHoldingManualCalculation,
  settleHostResetRestores,
} from "../host";

beforeEach(() => {
  resetManualCalculationTracking();
  backend.mode = "automatic";
  backend.switches = [];
});

/** A script of the OUTGOING workbook switches calculation to manual. */
async function scriptHoldsManual(): Promise<void> {
  await executeSetCalculationMode(lib as never, "script-1", "manual");
  expect(scriptsHoldingManualCalculation().has("script-1")).toBe(true);
  backend.switches = [];
}

describe("the AFTER_OPEN sweep keeps the opened file's calculation mode", () => {
  it("after an open, the script's manual debt is forgotten, not paid over the file's mode", async () => {
    await scriptHoldsManual();
    // open_file adopted the opened file's mode: it was saved under manual.
    backend.mode = "manual";
    hostResetAll({ openedDocument: true });
    await settleHostResetRestores();
    expect(backend.switches, "the sweep switched the opened manual workbook to automatic").toEqual([]);
    expect(backend.mode).toBe("manual");
    expect(scriptsHoldingManualCalculation().size, "the debt is forgotten").toBe(0);
  });

  it("the AFTER_OPEN handler is the one that says so (source pin)", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../../../extensions/ScriptableObjects/index.ts"), "utf8");
    const afterOpen = src.slice(src.indexOf("onAppEvent(AppEvents.AFTER_OPEN"));
    const handler = afterOpen.slice(0, afterOpen.indexOf("onAppEvent(", 10));
    // Round 16 (rev14C): only a REAL open says so -- an Open Application for
    // Editing also announces AFTER_OPEN and pays the debt instead
    // (extensions/ScriptableObjects/lib/afterOpenReset.ts, its own test).
    expect(handler).toContain("resetObjectScriptManager(resetOptionsForAfterOpen(payload))");
    const afterNew = src.slice(src.indexOf("onAppEvent(AppEvents.AFTER_NEW"));
    expect(afterNew.slice(0, afterNew.indexOf("resetObjectScriptManager(") + 40)).toContain("resetObjectScriptManager();");
  });

  it("a close (and a File > New) still pays the debt", async () => {
    await scriptHoldsManual();
    hostResetAll();
    await settleHostResetRestores();
    expect(backend.switches).toEqual(["automatic"]);
    expect(scriptsHoldingManualCalculation().size).toBe(0);
  });
});
