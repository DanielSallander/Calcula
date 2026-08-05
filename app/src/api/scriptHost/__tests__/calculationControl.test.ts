//! FILENAME: app/src/api/scriptHost/__tests__/calculationControl.test.ts
// PURPOSE: Wave 3 item 7 — api.getCalculationMode / setCalculationMode /
//          recalculate, and above all THE RESTORE DISCIPLINE: a script that
//          set "manual" and then dies must never leave the workbook silently
//          uncalculating. The tracking + restore helpers are exported from
//          host.ts for exactly this test (jsdom cannot spawn a worker realm);
//          the wiring into hostUnmountScript / hostResetAll is pinned by
//          source scan, the same way applicationParity.test.ts pins the
//          clipboard sweeps.

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

vi.mock("../../grid", () => ({
  refreshGridData: vi.fn(),
  refreshGridDimensions: vi.fn(),
  convertFormulaStyle: vi.fn(async (f: string) => f),
}));
vi.mock("../../../core/lib/cellEvents", () => ({
  cellEvents: { emitBatch: vi.fn() },
  cellToChange: vi.fn((c: unknown) => c),
}));

import {
  executeSetCalculationMode,
  releaseManualCalculation,
  resetManualCalculationTracking,
  scriptsHoldingManualCalculation,
  executeRecalculate,
} from "../host";
import { ALLOWLIST } from "../allowlist";
import {
  vCalculationMode,
  vRecalculate,
  vNone,
  SCRIPT_CALCULATION_MODES,
} from "../validators";

const hostSrc = fs.readFileSync(path.resolve(__dirname, "../host.ts"), "utf8");

function makeLib(initialMode: "automatic" | "manual" = "automatic") {
  let mode: string = initialMode;
  const lib = {
    getCalculationMode: vi.fn(async () => mode),
    setCalculationMode: vi.fn(async (next: string) => {
      mode = next;
      return next;
    }),
    calculateSheet: vi.fn(async () => []),
    calculateNow: vi.fn(async () => []),
  };
  return { lib, currentMode: () => mode };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asLib = (l: unknown) => l as any;

beforeEach(() => {
  resetManualCalculationTracking();
  vi.clearAllMocks();
});

// ============================================================================
// validators + allowlist wiring
// ============================================================================

describe("calculation-control validators", () => {
  it("vCalculationMode accepts exactly the two canonical modes", () => {
    expect([...SCRIPT_CALCULATION_MODES].sort()).toEqual(["automatic", "manual"]);
    expect(vCalculationMode(["automatic"])).toBe(true);
    expect(vCalculationMode(["manual"])).toBe(true);
    for (const bad of ["auto", "MANUAL", "xlCalculationManual", 1, undefined, null]) {
      expect(vCalculationMode([bad]), String(bad)).toContain("automatic, manual");
    }
  });

  it("vRecalculate accepts nothing, {} and { full: boolean } — and only that", () => {
    expect(vRecalculate([])).toBe(true);
    expect(vRecalculate([undefined])).toBe(true);
    expect(vRecalculate([{}])).toBe(true);
    expect(vRecalculate([{ full: true }])).toBe(true);
    expect(vRecalculate([{ full: false }])).toBe(true);
    expect(vRecalculate([{ full: "yes" }])).not.toBe(true);
    expect(vRecalculate([{ sheet: 2 }])).not.toBe(true);
    expect(vRecalculate(["full"])).not.toBe(true);
  });

  it("the rows are unlocked-tier, no capability, honestly classed", () => {
    expect(ALLOWLIST["api.getCalculationMode"]).toMatchObject({ tier: "unlocked", class: "read" });
    expect(ALLOWLIST["api.getCalculationMode"].validate).toBe(vNone);
    expect(ALLOWLIST["api.setCalculationMode"]).toMatchObject({ tier: "unlocked", class: "mutate" });
    expect(ALLOWLIST["api.setCalculationMode"].validate).toBe(vCalculationMode);
    expect(ALLOWLIST["api.recalculate"]).toMatchObject({ tier: "unlocked", class: "mutate" });
    expect(ALLOWLIST["api.recalculate"].validate).toBe(vRecalculate);
    for (const m of ["api.getCalculationMode", "api.setCalculationMode", "api.recalculate"]) {
      expect(ALLOWLIST[m].capability, m).toBeUndefined();
    }
  });
});

// ============================================================================
// the setter + the restore discipline
// ============================================================================

describe("executeSetCalculationMode tracking", () => {
  it("a script flipping automatic -> manual is tracked as owing a restore", async () => {
    const { lib, currentMode } = makeLib("automatic");
    const applied = await executeSetCalculationMode(asLib(lib), "script-a", "manual");
    expect(applied).toBe("manual");
    expect(currentMode()).toBe("manual");
    expect([...scriptsHoldingManualCalculation()]).toEqual(["script-a"]);
  });

  it("a script setting manual when the USER already had manual owes nothing", async () => {
    const { lib } = makeLib("manual");
    await executeSetCalculationMode(asLib(lib), "script-a", "manual");
    // Its unmount must not override the user's own choice.
    expect(scriptsHoldingManualCalculation().size).toBe(0);
  });

  it("a script that hands automatic back itself clears its own debt", async () => {
    const { lib } = makeLib("automatic");
    await executeSetCalculationMode(asLib(lib), "script-a", "manual");
    await executeSetCalculationMode(asLib(lib), "script-a", "automatic");
    expect(scriptsHoldingManualCalculation().size).toBe(0);
  });
});

describe("releaseManualCalculation (the unmount/fault/debug-stop restore)", () => {
  it("restores automatic when the LAST holder goes away", async () => {
    const { lib, currentMode } = makeLib("automatic");
    await executeSetCalculationMode(asLib(lib), "script-a", "manual");
    await releaseManualCalculation(asLib(lib), "script-a");
    expect(currentMode()).toBe("automatic");
    expect(scriptsHoldingManualCalculation().size).toBe(0);
  });

  it("does NOT restore while another live script still holds manual", async () => {
    const { lib, currentMode } = makeLib("automatic");
    await executeSetCalculationMode(asLib(lib), "script-a", "manual");
    await executeSetCalculationMode(asLib(lib), "script-b", "manual");
    lib.setCalculationMode.mockClear();
    await releaseManualCalculation(asLib(lib), "script-a");
    expect(lib.setCalculationMode).not.toHaveBeenCalled();
    expect(currentMode()).toBe("manual");
    // ...and the second script's departure hands it back.
    await releaseManualCalculation(asLib(lib), "script-b");
    expect(currentMode()).toBe("automatic");
  });

  it("is a no-op for a script that never flipped the mode", async () => {
    const { lib } = makeLib("manual");
    await releaseManualCalculation(asLib(lib), "innocent-bystander");
    expect(lib.setCalculationMode).not.toHaveBeenCalled();
  });
});

describe("the restore is WIRED into every way a script ends (source pins)", () => {
  it("hostUnmountScript fires the release for a tracked script", () => {
    const unmount = hostSrc.slice(hostSrc.indexOf("export function hostUnmountScript"));
    const body = unmount.slice(0, unmount.indexOf("\n}\n"));
    expect(body).toContain("manualCalcHolders.has(scriptId)");
    expect(body).toContain("releaseManualCalculation(lib, scriptId)");
  });

  it("hostResetAll (workbook swap) restores DIRECTLY, not via the racing microtasks", () => {
    const reset = hostSrc.slice(hostSrc.indexOf("export function hostResetAll"));
    const body = reset.slice(0, reset.indexOf("\n}\n"));
    expect(body).toContain("resetManualCalculationTracking()");
    expect(body).toContain('setCalculationMode("automatic")');
  });

  it("both crash paths route through hostUnmountScript (which is what covers faults)", () => {
    // The onerror handler unmounts before respawning AND on the second-crash
    // fault — so the release above covers a crashed script too.
    const onerror = hostSrc.slice(hostSrc.indexOf("mw.worker.onerror"));
    const body = onerror.slice(0, onerror.indexOf("\n}\n"));
    expect(body).toContain("hostUnmountScript(mw.definition.id)");
    expect(body).toContain("hostUnmountScript(definition.id)");
  });
});

// ============================================================================
// executeRecalculate
// ============================================================================

describe("executeRecalculate", () => {
  it("default recalculates the ACTIVE SHEET and reports the cell count", async () => {
    const { lib } = makeLib();
    lib.calculateSheet.mockResolvedValueOnce([{ row: 0, col: 0 }, { row: 1, col: 0 }] as never);
    const result = await executeRecalculate(asLib(lib));
    expect(lib.calculateSheet).toHaveBeenCalledTimes(1);
    expect(lib.calculateNow).not.toHaveBeenCalled();
    expect(result).toEqual({ cellsUpdated: 2 });
  });

  it("{ full: true } recalculates the whole workbook (calculate_now / F9)", async () => {
    const { lib } = makeLib();
    await executeRecalculate(asLib(lib), { full: true });
    expect(lib.calculateNow).toHaveBeenCalledTimes(1);
    expect(lib.calculateSheet).not.toHaveBeenCalled();
  });

  it("{ full: false } stays a sheet recalc", async () => {
    const { lib } = makeLib();
    await executeRecalculate(asLib(lib), { full: false });
    expect(lib.calculateSheet).toHaveBeenCalledTimes(1);
  });
});
