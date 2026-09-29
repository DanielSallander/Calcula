//! FILENAME: app/src/api/scriptHost/__tests__/hostResetCloseWait.test.ts
// PURPOSE: A CLOSE waits for the protection a workbook reset puts back (E8,
//          BUG-0200 close parts).
// CONTEXT: BEFORE_CLOSE routes through hostResetAll, which re-protects every
//          sheet a script lifted with api.withUnprotected. The re-protect is an
//          async backend write, fired and forgotten -- and the close prompt's
//          Save wrote the file the moment BEFORE_CLOSE returned, so the file
//          could be saved with the user's sheet still OPEN. The host now tracks
//          the restores its reset starts, and a close preparation
//          (@api/lifecycleGuards) holds the save and the window until they
//          have landed.

import { describe, it, expect, vi, beforeEach } from "vitest";

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

const SHEETS = [{ index: 0, name: "Sheet1" }];
const OPTIONS = { selectLockedCells: true, selectUnlockedCells: true };

/** The backend the host's lazy `getLib()` reaches: one protected sheet, a re-protect the test holds. */
const backend = vi.hoisted(() => ({
  isProtected: true,
  protectHold: null as null | Promise<void>,
  protectCalls: 0,
}));

vi.mock("../../lib", () => ({
  DEFAULT_PROTECTION_OPTIONS: {},
  getActiveSheet: vi.fn(async () => 0),
  setActiveSheet: vi.fn(async (index: number) => ({ sheets: SHEETS, activeIndex: index })),
  getSheets: vi.fn(async () => ({ sheets: SHEETS, activeIndex: 0 })),
  getProtectionStatus: vi.fn(async () => ({
    isProtected: backend.isProtected,
    hasPassword: false,
    options: OPTIONS,
  })),
  unprotectSheet: vi.fn(async () => {
    backend.isProtected = false;
    return { success: true, error: null };
  }),
  protectSheet: vi.fn(async () => {
    backend.protectCalls += 1;
    if (backend.protectHold) await backend.protectHold;
    backend.isProtected = true;
    return { success: true, error: null };
  }),
  setCalculationMode: vi.fn(async () => {}),
}));

import * as lib from "../../lib";
import { executeBeginUnprotected, hostResetAll, resetUnprotectedTracking, settleHostResetRestores } from "../host";
import { closePreparationCount, runClosePreparations } from "../../lifecycleGuards";

async function drain(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

beforeEach(() => {
  resetUnprotectedTracking();
  backend.isProtected = true;
  backend.protectHold = null;
  backend.protectCalls = 0;
});

describe("the close waits for the reset's re-protect (E8)", () => {
  it("the host registers its close preparation at load", () => {
    expect(closePreparationCount()).toBeGreaterThanOrEqual(1);
  });

  it("a sheet a script left unprotected is protected again BEFORE the close's preparations resolve", async () => {
    await executeBeginUnprotected(lib as never, "script-1");
    expect(backend.isProtected).toBe(false);

    let release: () => void = () => {};
    backend.protectHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    // BEFORE_CLOSE's teardown (ScriptableObjects -> resetObjectScriptManager).
    hostResetAll();
    let prepared = false;
    const closing = runClosePreparations().then(() => {
      prepared = true;
    });
    await drain();
    expect(backend.protectCalls, "the reset never started the re-protect").toBe(1);
    expect(prepared, "the close went on with the sheet still unprotected").toBe(false);

    release();
    await closing;
    expect(prepared).toBe(true);
    expect(backend.isProtected).toBe(true);
  });

  it("with nothing to restore the host's preparation resolves at once", async () => {
    await expect(settleHostResetRestores()).resolves.toBeUndefined();
  });
});
