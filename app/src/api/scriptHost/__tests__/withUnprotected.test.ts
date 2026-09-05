//! FILENAME: app/src/api/scriptHost/__tests__/withUnprotected.test.ts
// PURPOSE: api.withUnprotected — the sanctioned replacement for VBA's
//          UserInterfaceOnly:=True, and above all ITS CRASH GUARANTEE: a sheet
//          whose protection a script lifted must be re-protected however that
//          script ends, including ways that never run the worker's own
//          `finally` (kill, fault, debugger stop, workbook close).
// COVERS:  (1) the validator matrices for the two broker rows;
//          (2) allowlist wiring: unlocked-tier only, no capability, honest
//              classes — a distributed (restricted) script can no more borrow
//              a protection than it can lift one;
//          (3) begin: an UNPROTECTED sheet is left alone (no surprise
//              protection), a WRONG password refuses before anything runs, the
//              prior options are captured verbatim BEFORE the unprotect;
//          (4) end: restores the EXACT prior password + flags (never
//              DEFAULT_PROTECTION_OPTIONS), and re-activates the held sheet
//              when the script navigated away inside `fn`;
//          (5) nesting/concurrency: a second caller JOINS (one unprotect, one
//              restore, the FIRST options), and must prove the same password;
//          (6) the crash guarantee: releaseUnprotectedSheets restores for a
//              departing script, is wired into hostUnmountScript and
//              hostResetAll (source pins), and AUDITS the restore it made;
//          (7) THE ORPHAN WINDOW: a script that dies while its begin is still
//              in flight is swept BEFORE its hold exists, so the begin itself
//              must put the protection back rather than record a hold nothing
//              will ever release;
//          (8) the worker shim: begin -> fn -> end, with end reached when `fn`
//              THROWS, and skipped when the sheet was never protected.

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

import {
  executeBeginUnprotected,
  executeEndUnprotected,
  releaseUnprotectedSheets,
  restoreAllUnprotected,
  allUnprotectedHolds,
  scriptOwesUnprotectRestore,
  scriptsHoldingUnprotected,
  resetUnprotectedTracking,
  noteScriptDeparture,
  scriptDepartureEpoch,
} from "../host";
import { ALLOWLIST } from "../allowlist";
import { vBeginUnprotected, vEndUnprotected } from "../validators";
import { getAuditTail, clearAudit } from "../auditRing";
import { buildWorkerContext, type WorkerRuntime } from "../worker/contextShims";
import type { MountSpec, W2H } from "../protocol";

const hostSrc = fs.readFileSync(path.resolve(__dirname, "../host.ts"), "utf8");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asLib = (l: unknown) => l as any;

const SHEETS = [
  { index: 0, name: "Sheet1" },
  { index: 1, name: "Data" },
];

/** The flags the sheet in these tests was protected with — deliberately NOT
 *  the dialog defaults, so "restored the defaults" is distinguishable from
 *  "restored what was there". */
const PRIOR_OPTIONS = {
  allowSelectLockedCells: false,
  allowSelectUnlockedCells: true,
  allowFormatCells: true,
  allowFormatColumns: false,
  allowFormatRows: false,
  allowInsertColumns: false,
  allowInsertRows: true,
  allowInsertHyperlinks: false,
  allowDeleteColumns: false,
  allowDeleteRows: false,
  allowSort: true,
  allowAutoFilter: true,
  allowPivotTables: false,
  allowEditObjects: false,
  allowEditScenarios: false,
};

const DEFAULT_OPTIONS = {
  allowSelectLockedCells: true,
  allowSelectUnlockedCells: true,
  allowFormatCells: false,
  allowFormatColumns: false,
  allowFormatRows: false,
  allowInsertColumns: false,
  allowInsertRows: false,
  allowInsertHyperlinks: false,
  allowDeleteColumns: false,
  allowDeleteRows: false,
  allowSort: false,
  allowAutoFilter: false,
  allowPivotTables: false,
  allowEditObjects: false,
  allowEditScenarios: false,
};

/**
 * A stateful protection emulator mirroring protection.rs closely enough for the
 * contracts under test: one protection record for the ACTIVE sheet, a password
 * that must match to unprotect, and a status read that reports DEFAULTS while
 * the sheet is open (which is exactly why begin must capture before it lifts).
 */
function makeLib(opts?: {
  protected?: boolean;
  password?: string | null;
  options?: typeof PRIOR_OPTIONS;
  activeSheet?: number;
}) {
  const state = {
    isProtected: opts?.protected ?? true,
    password: opts?.password === undefined ? "s3cret" : opts.password,
    options: { ...(opts?.options ?? PRIOR_OPTIONS) },
    active: opts?.activeSheet ?? 0,
  };
  const lib = {
    DEFAULT_PROTECTION_OPTIONS: { ...DEFAULT_OPTIONS },
    getActiveSheet: vi.fn(async () => state.active),
    setActiveSheet: vi.fn(async (index: number) => {
      state.active = index;
      return { sheets: SHEETS, activeIndex: index };
    }),
    getSheets: vi.fn(async () => ({ sheets: SHEETS, activeIndex: state.active })),
    getProtectionStatus: vi.fn(async () => ({
      isProtected: state.isProtected,
      hasPassword: state.isProtected && state.password !== null,
      options: state.isProtected ? { ...state.options } : { ...DEFAULT_OPTIONS },
    })),
    unprotectSheet: vi.fn(async (password?: string) => {
      if (!state.isProtected) return { success: false, error: "Sheet is not protected" };
      if (state.password !== null && (password ?? "") !== state.password) {
        return { success: false, error: "Incorrect password" };
      }
      state.isProtected = false;
      return { success: true, error: null };
    }),
    protectSheet: vi.fn(
      async (params: { password?: string; options: typeof PRIOR_OPTIONS }) => {
        if (state.isProtected) return { success: false, error: "Sheet is already protected" };
        state.isProtected = true;
        state.password = params.password ?? null;
        state.options = { ...params.options };
        return { success: true, error: null };
      },
    ),
  };
  return { lib, state };
}

beforeEach(() => {
  resetUnprotectedTracking();
  clearAudit();
  vi.clearAllMocks();
});

// ============================================================================
// (1) validators
// ============================================================================

describe("vBeginUnprotected / vEndUnprotected", () => {
  it("begin accepts nothing, a password, and a sheet ref", () => {
    expect(vBeginUnprotected([])).toBe(true);
    expect(vBeginUnprotected([undefined])).toBe(true);
    expect(vBeginUnprotected(["s3cret"])).toBe(true);
    expect(vBeginUnprotected([null, 0])).toBe(true);
    expect(vBeginUnprotected(["s3cret", "Data"])).toBe(true);
  });

  it("begin rejects a non-string password, an over-long one, and a bad sheet ref", () => {
    expect(vBeginUnprotected([123])).not.toBe(true);
    expect(vBeginUnprotected(["x".repeat(300)])).not.toBe(true);
    expect(vBeginUnprotected(["s3cret", true])).not.toBe(true);
  });

  it("end accepts a token and the null 'nothing was lifted' answer", () => {
    expect(vEndUnprotected(["unprot-1"])).toBe(true);
    expect(vEndUnprotected([null])).toBe(true);
    expect(vEndUnprotected([])).toBe(true);
  });

  it("end rejects an empty or non-string token", () => {
    expect(vEndUnprotected([""])).not.toBe(true);
    expect(vEndUnprotected([7])).not.toBe(true);
  });
});

// ============================================================================
// (2) allowlist wiring
// ============================================================================

describe("the withUnprotected rows", () => {
  it("are unlocked-tier, no capability, honestly classed as mutations", () => {
    for (const m of ["api.beginUnprotected", "api.endUnprotected"]) {
      expect(ALLOWLIST[m], m).toMatchObject({ tier: "unlocked", class: "mutate" });
      expect(ALLOWLIST[m].capability, m).toBeUndefined();
    }
    expect(ALLOWLIST["api.beginUnprotected"].validate).toBe(vBeginUnprotected);
    expect(ALLOWLIST["api.endUnprotected"].validate).toBe(vEndUnprotected);
  });

  it("sit at the SAME tier as the protect/unprotect rows they compose", () => {
    // A distributed (restricted) script must not be able to borrow a
    // protection any more than it can lift one.
    expect(ALLOWLIST["api.beginUnprotected"].tier).toBe(ALLOWLIST["api.unprotectSheet"].tier);
    expect(ALLOWLIST["api.endUnprotected"].tier).toBe(ALLOWLIST["api.protectSheet"].tier);
  });

  it("say in plain words that the restore is guaranteed — that IS the consent", () => {
    expect(ALLOWLIST["api.beginUnprotected"].desc).toMatch(/crashes/i);
    expect(ALLOWLIST["api.endUnprotected"].desc).toMatch(/before/i);
  });
});

// ============================================================================
// (3) begin
// ============================================================================

describe("executeBeginUnprotected", () => {
  it("an UNPROTECTED sheet is left alone: no token, no protection invented", async () => {
    const { lib, state } = makeLib({ protected: false });
    const hold = await executeBeginUnprotected(asLib(lib), "s1", undefined, undefined);
    expect(hold).toEqual({ token: null, wasProtected: false });
    expect(lib.unprotectSheet).not.toHaveBeenCalled();
    expect(lib.protectSheet).not.toHaveBeenCalled();
    expect(state.isProtected).toBe(false);
    // ...and nothing is owed, so no unmount sweep will protect it later either.
    expect(scriptOwesUnprotectRestore("s1")).toBe(false);
  });

  it("lifts a protected sheet and records the debt", async () => {
    const { lib, state } = makeLib();
    const hold = await executeBeginUnprotected(asLib(lib), "s1", "s3cret", undefined);
    expect(hold.wasProtected).toBe(true);
    expect(hold.token).toMatch(/^unprot-\d+$/);
    expect(state.isProtected).toBe(false);
    expect(scriptOwesUnprotectRestore("s1")).toBe(true);
  });

  it("a WRONG password throws and leaves the sheet protected", async () => {
    const { lib, state } = makeLib();
    await expect(
      executeBeginUnprotected(asLib(lib), "s1", "guess", undefined),
    ).rejects.toThrow(/password is wrong/i);
    expect(state.isProtected).toBe(true);
    // Nothing was recorded, so nothing will be "restored" over the top later.
    expect(scriptsHoldingUnprotected().size).toBe(0);
  });

  it("captures the prior options BEFORE lifting (the status lies afterwards)", async () => {
    const { lib } = makeLib();
    await executeBeginUnprotected(asLib(lib), "s1", "s3cret", undefined);
    const hold = allUnprotectedHolds()[0];
    expect(hold.options).toEqual(PRIOR_OPTIONS);
    expect(hold.options).not.toEqual(DEFAULT_OPTIONS);
    expect(hold.password).toBe("s3cret");
    // The status read happened before the unprotect, not after.
    expect(lib.getProtectionStatus.mock.invocationCallOrder[0]).toBeLessThan(
      lib.unprotectSheet.mock.invocationCallOrder[0],
    );
  });

  it("is ACTIVE SHEET only — naming another sheet refuses with the fix", async () => {
    const { lib } = makeLib();
    await expect(
      executeBeginUnprotected(asLib(lib), "s1", "s3cret", "Data"),
    ).rejects.toThrow(/only target the active sheet/i);
    expect(lib.unprotectSheet).not.toHaveBeenCalled();
  });

  it("a sheet protected WITHOUT a password needs none", async () => {
    const { lib, state } = makeLib({ password: null });
    const hold = await executeBeginUnprotected(asLib(lib), "s1", undefined, undefined);
    expect(hold.wasProtected).toBe(true);
    expect(state.isProtected).toBe(false);
    expect(allUnprotectedHolds()[0].password).toBeNull();
  });
});

// ============================================================================
// (4) end — the restore
// ============================================================================

describe("executeEndUnprotected", () => {
  it("restores the EXACT prior password and flags, not the defaults", async () => {
    const { lib, state } = makeLib();
    const hold = await executeBeginUnprotected(asLib(lib), "s1", "s3cret", undefined);
    const out = await executeEndUnprotected(asLib(lib), "s1", hold.token);
    expect(out).toEqual({ reprotected: true });
    expect(state.isProtected).toBe(true);
    expect(state.password).toBe("s3cret");
    expect(state.options).toEqual(PRIOR_OPTIONS);
    expect(lib.protectSheet).toHaveBeenCalledWith({
      password: "s3cret",
      options: PRIOR_OPTIONS,
    });
    expect(scriptsHoldingUnprotected().size).toBe(0);
  });

  it("restores a password-less protection WITHOUT inventing a password", async () => {
    const { lib, state } = makeLib({ password: null });
    const hold = await executeBeginUnprotected(asLib(lib), "s1", undefined, undefined);
    await executeEndUnprotected(asLib(lib), "s1", hold.token);
    expect(state.isProtected).toBe(true);
    expect(state.password).toBeNull();
    expect(lib.protectSheet).toHaveBeenCalledWith({ password: undefined, options: PRIOR_OPTIONS });
  });

  it("a null token (the sheet was never protected) is a clean no-op", async () => {
    const { lib } = makeLib({ protected: false });
    const out = await executeEndUnprotected(asLib(lib), "s1", null);
    expect(out).toEqual({ reprotected: false });
    expect(lib.protectSheet).not.toHaveBeenCalled();
  });

  it("an unknown/stale token does not throw — a finally must not mask the real error", async () => {
    const { lib } = makeLib();
    const out = await executeEndUnprotected(asLib(lib), "s1", "unprot-999");
    expect(out).toEqual({ reprotected: false });
    expect(lib.protectSheet).not.toHaveBeenCalled();
  });

  it("re-activates the held sheet when the script navigated away, then hops back", async () => {
    const { lib, state } = makeLib();
    const hold = await executeBeginUnprotected(asLib(lib), "s1", "s3cret", undefined);
    // ...the script does api.setActiveSheet("Data") inside fn.
    state.active = 1;
    await executeEndUnprotected(asLib(lib), "s1", hold.token);
    // The protection landed on sheet 0 (the one that was lifted)...
    expect(lib.setActiveSheet).toHaveBeenNthCalledWith(1, 0);
    // ...and the user is left looking at the sheet they were on.
    expect(lib.setActiveSheet).toHaveBeenLastCalledWith(1);
    expect(state.active).toBe(1);
    expect(state.isProtected).toBe(true);
  });

  it("does NOT hop when the held sheet is still active", async () => {
    const { lib } = makeLib();
    const hold = await executeBeginUnprotected(asLib(lib), "s1", "s3cret", undefined);
    await executeEndUnprotected(asLib(lib), "s1", hold.token);
    expect(lib.setActiveSheet).not.toHaveBeenCalled();
  });
});

// ============================================================================
// (5) nesting and concurrency
// ============================================================================

describe("nested and concurrent holds on one sheet", () => {
  it("a nested call JOINS: one unprotect, one restore, at the outer end", async () => {
    const { lib, state } = makeLib();
    const outer = await executeBeginUnprotected(asLib(lib), "s1", "s3cret", undefined);
    const inner = await executeBeginUnprotected(asLib(lib), "s1", "s3cret", undefined);
    expect(lib.unprotectSheet).toHaveBeenCalledTimes(1);
    expect(inner.wasProtected).toBe(true);

    await executeEndUnprotected(asLib(lib), "s1", inner.token);
    expect(state.isProtected).toBe(false); // the outer hold still owns it
    expect(lib.protectSheet).not.toHaveBeenCalled();

    await executeEndUnprotected(asLib(lib), "s1", outer.token);
    expect(state.isProtected).toBe(true);
    expect(lib.protectSheet).toHaveBeenCalledTimes(1);
  });

  it("two DIFFERENT scripts hold independently; the last one out re-protects", async () => {
    const { lib, state } = makeLib();
    const a = await executeBeginUnprotected(asLib(lib), "script-a", "s3cret", undefined);
    const b = await executeBeginUnprotected(asLib(lib), "script-b", "s3cret", undefined);
    expect(lib.unprotectSheet).toHaveBeenCalledTimes(1);

    await executeEndUnprotected(asLib(lib), "script-a", a.token);
    expect(state.isProtected).toBe(false);
    await executeEndUnprotected(asLib(lib), "script-b", b.token);
    expect(state.isProtected).toBe(true);
  });

  it("a joiner with the WRONG password is refused — a live hold is not a password oracle", async () => {
    const { lib, state } = makeLib();
    await executeBeginUnprotected(asLib(lib), "script-a", "s3cret", undefined);
    await expect(
      executeBeginUnprotected(asLib(lib), "script-b", "guess", undefined),
    ).rejects.toThrow(/already open under a different password/i);
    // The refusal must not disturb the live hold.
    expect(state.isProtected).toBe(false);
    expect(allUnprotectedHolds()).toHaveLength(1);
    // ...and script-b owes nothing, so its unmount will not re-protect early.
    expect(scriptOwesUnprotectRestore("script-b")).toBe(false);
  });

  it("two begins RACING on one sheet unprotect exactly once", async () => {
    const { lib, state } = makeLib();
    // Fired without awaiting between them: both read the status before either
    // records a hold, which is precisely the interleaving the per-sheet chain
    // exists to prevent.
    const [a, b] = await Promise.all([
      executeBeginUnprotected(asLib(lib), "script-a", "s3cret", undefined),
      executeBeginUnprotected(asLib(lib), "script-b", "s3cret", undefined),
    ]);
    expect(lib.unprotectSheet).toHaveBeenCalledTimes(1);
    expect(allUnprotectedHolds()).toHaveLength(1);
    // ...and the single hold still knows the REAL prior options, not the
    // defaults a second status read would have reported.
    expect(allUnprotectedHolds()[0].options).toEqual(PRIOR_OPTIONS);

    await executeEndUnprotected(asLib(lib), "script-a", a.token);
    expect(state.isProtected).toBe(false);
    await executeEndUnprotected(asLib(lib), "script-b", b.token);
    expect(state.isProtected).toBe(true);
    expect(state.options).toEqual(PRIOR_OPTIONS);
    expect(lib.protectSheet).toHaveBeenCalledTimes(1);
  });

  it("a racing begin+end pair leaves the sheet protected, not open", async () => {
    const { lib, state } = makeLib();
    const first = await executeBeginUnprotected(asLib(lib), "script-a", "s3cret", undefined);
    await Promise.all([
      executeEndUnprotected(asLib(lib), "script-a", first.token),
      executeBeginUnprotected(asLib(lib), "script-b", "s3cret", undefined).then((h) =>
        executeEndUnprotected(asLib(lib), "script-b", h.token),
      ),
    ]);
    expect(state.isProtected).toBe(true);
    expect(state.options).toEqual(PRIOR_OPTIONS);
    expect(scriptsHoldingUnprotected().size).toBe(0);
  });

  it("the restore uses the FIRST captured options, never a joiner's re-read", async () => {
    const { lib, state } = makeLib();
    const a = await executeBeginUnprotected(asLib(lib), "script-a", "s3cret", undefined);
    const b = await executeBeginUnprotected(asLib(lib), "script-b", "s3cret", undefined);
    await executeEndUnprotected(asLib(lib), "script-a", a.token);
    await executeEndUnprotected(asLib(lib), "script-b", b.token);
    // The status read a joiner would have done reports DEFAULTS while the
    // sheet is open — restoring those would have silently rewritten the flags.
    expect(state.options).toEqual(PRIOR_OPTIONS);
  });
});

// ============================================================================
// (6) THE CRASH GUARANTEE
// ============================================================================

describe("releaseUnprotectedSheets (unmount / fault / debugger stop)", () => {
  it("re-protects a sheet its script never closed", async () => {
    const { lib, state } = makeLib();
    await executeBeginUnprotected(asLib(lib), "s1", "s3cret", undefined);
    expect(state.isProtected).toBe(false);

    // The script dies here — no endUnprotected is ever sent.
    await releaseUnprotectedSheets(asLib(lib), "s1");

    expect(state.isProtected).toBe(true);
    expect(state.options).toEqual(PRIOR_OPTIONS);
    expect(state.password).toBe("s3cret");
    expect(scriptsHoldingUnprotected().size).toBe(0);
  });

  it("releases NESTED holds of the departing script in one restore", async () => {
    const { lib, state } = makeLib();
    await executeBeginUnprotected(asLib(lib), "s1", "s3cret", undefined);
    await executeBeginUnprotected(asLib(lib), "s1", "s3cret", undefined);
    await releaseUnprotectedSheets(asLib(lib), "s1");
    expect(state.isProtected).toBe(true);
    expect(lib.protectSheet).toHaveBeenCalledTimes(1);
  });

  it("does NOT restore while another live script still holds the sheet", async () => {
    const { lib, state } = makeLib();
    await executeBeginUnprotected(asLib(lib), "script-a", "s3cret", undefined);
    await executeBeginUnprotected(asLib(lib), "script-b", "s3cret", undefined);
    await releaseUnprotectedSheets(asLib(lib), "script-a");
    expect(state.isProtected).toBe(false);
    expect(lib.protectSheet).not.toHaveBeenCalled();
    // ...and the survivor's departure hands it back.
    await releaseUnprotectedSheets(asLib(lib), "script-b");
    expect(state.isProtected).toBe(true);
  });

  it("is a no-op for a script that never lifted anything", async () => {
    const { lib } = makeLib();
    await releaseUnprotectedSheets(asLib(lib), "innocent-bystander");
    expect(lib.protectSheet).not.toHaveBeenCalled();
  });

  it("a dead script's tokens die with it — a remount cannot end its hold", async () => {
    const { lib, state } = makeLib();
    const hold = await executeBeginUnprotected(asLib(lib), "s1", "s3cret", undefined);
    await releaseUnprotectedSheets(asLib(lib), "s1");
    expect(state.isProtected).toBe(true);
    // A remounted successor replaying the stale token must not unprotect
    // anything, and must not throw either.
    const out = await executeEndUnprotected(asLib(lib), "s1", hold.token);
    expect(out).toEqual({ reprotected: false });
    expect(state.isProtected).toBe(true);
  });

  it("AUDITS the restore it made — an invisible re-protection defeats the design", async () => {
    const { lib } = makeLib();
    await executeBeginUnprotected(asLib(lib), "s1", "s3cret", undefined);
    await releaseUnprotectedSheets(asLib(lib), "s1");
    const entries = getAuditTail().filter((e) => e.method === "api.endUnprotected");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ scriptId: "s1", class: "mutate", ok: true });
  });

  it("AUDITS a FAILED restore rather than swallowing it", async () => {
    const { lib } = makeLib();
    await executeBeginUnprotected(asLib(lib), "s1", "s3cret", undefined);
    lib.protectSheet.mockResolvedValueOnce({ success: false, error: "backend is gone" });
    await releaseUnprotectedSheets(asLib(lib), "s1");
    const entries = getAuditTail().filter((e) => e.method === "api.endUnprotected");
    expect(entries).toHaveLength(1);
    expect(entries[0].ok).toBe(false);
    expect(entries[0].error).toMatch(/backend is gone/);
  });
});

describe("restoreAllUnprotected (workbook swap / BEFORE_CLOSE)", () => {
  it("puts every outstanding hold back", async () => {
    const { lib, state } = makeLib();
    await executeBeginUnprotected(asLib(lib), "script-a", "s3cret", undefined);
    const holds = allUnprotectedHolds();
    resetUnprotectedTracking();
    await restoreAllUnprotected(asLib(lib), holds);
    expect(state.isProtected).toBe(true);
    expect(state.options).toEqual(PRIOR_OPTIONS);
  });
});

describe("the restore is WIRED into every way a script ends (source pins)", () => {
  it("hostUnmountScript fires the release for a script that owes one", () => {
    const unmount = hostSrc.slice(hostSrc.indexOf("export function hostUnmountScript"));
    const body = unmount.slice(0, unmount.indexOf("\n}\n"));
    expect(body).toContain("scriptOwesUnprotectRestore(scriptId)");
    expect(body).toContain("releaseUnprotectedSheets(lib, scriptId)");
  });

  it("hostResetAll RESTORES (it does not merely forget) — BEFORE_CLOSE routes here", () => {
    const reset = hostSrc.slice(hostSrc.indexOf("export function hostResetAll"));
    const body = reset.slice(0, reset.indexOf("\n}\n"));
    expect(body).toContain("allUnprotectedHolds()");
    expect(body).toContain("resetUnprotectedTracking()");
    expect(body).toContain("restoreAllUnprotected(lib, holds)");
  });

  it("hostResetAll snapshots BEFORE clearing, so the clear cannot swallow the restore", () => {
    const reset = hostSrc.slice(hostSrc.indexOf("export function hostResetAll"));
    const body = reset.slice(0, reset.indexOf("\n}\n"));
    expect(body.indexOf("allUnprotectedHolds()")).toBeLessThan(
      body.indexOf("resetUnprotectedTracking()"),
    );
  });

  it("both crash paths route through hostUnmountScript, so a fault is covered", () => {
    // The onerror arrow delegates to `crashWorker`, which the event-stall
    // watchdog reuses — the one function all three crash paths run through.
    const onerror = hostSrc.slice(hostSrc.indexOf("function crashWorker("));
    const body = onerror.slice(0, onerror.indexOf("\n}\n"));
    expect(body).toContain("hostUnmountScript(mw.definition.id)");
    expect(body).toContain("hostUnmountScript(definition.id)");
  });
});

// ============================================================================
// (7) the worker shim
// ============================================================================

interface RecordedCall {
  callId: number;
  method: string;
  args: unknown[];
}

/** A worker realm whose RPCs land in an array the test can answer by hand. */
function makeRealm(): {
  api: Record<string, (...a: unknown[]) => Promise<unknown>>;
  rt: WorkerRuntime;
  calls: RecordedCall[];
  answer: (method: string, value: unknown) => void;
  fail: (method: string, message: string) => void;
  drain: () => void;
} {
  const calls: RecordedCall[] = [];
  const spec = {
    protocolVersion: 1,
    scriptId: "withUnprotected-test",
    objectType: "sheet",
    instanceId: null,
    tier: "unlocked",
    capabilities: [],
    apiVersion: "1.0.0",
    scriptName: "WithUnprotected",
    packageInfo: null,
    snapshot: {},
    source: "",
  } as unknown as MountSpec;
  const { context, rt } = buildWorkerContext(spec, (msg: W2H) => {
    if (msg.t === "call") calls.push({ callId: msg.callId, method: msg.method, args: msg.args });
  });
  const find = (method: string): RecordedCall => {
    const call = [...calls].reverse().find((c) => c.method === method);
    if (!call) throw new Error(`no ${method} call was sent (sent: ${calls.map((c) => c.method).join(", ") || "nothing"})`);
    return call;
  };
  return {
    api: (context as Record<string, unknown>).api as Record<string, (...a: unknown[]) => Promise<unknown>>,
    rt,
    calls,
    answer: (method, value) => rt.settleCall(find(method).callId, true, value),
    fail: (method, message) =>
      rt.settleCall(find(method).callId, false, undefined, { code: "PermissionDenied", message }),
    drain: () => {
      for (const entry of rt.pending.values()) clearTimeout(entry.timer);
      rt.pending.clear();
    },
  };
}

/** Let the shim's awaits run to the next RPC. */
const tick = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

const sent = (calls: RecordedCall[], method: string): boolean =>
  calls.some((c) => c.method === method);

describe("the api.withUnprotected worker shim", () => {
  it("runs begin -> fn -> end, and answers what fn answered", async () => {
    const realm = makeRealm();
    const ran: string[] = [];

    const promise = realm.api.withUnprotected("s3cret", async () => {
      ran.push("fn");
      return 42;
    });
    expect(realm.calls[0]).toMatchObject({
      method: "api.beginUnprotected",
      args: ["s3cret", undefined],
    });
    realm.answer("api.beginUnprotected", { token: "unprot-1", wasProtected: true });
    await tick();

    expect(sent(realm.calls, "api.endUnprotected"), "end must follow fn").toBe(true);
    expect(realm.calls.find((c) => c.method === "api.endUnprotected")!.args).toEqual(["unprot-1"]);
    realm.answer("api.endUnprotected", { reprotected: true });

    await expect(promise).resolves.toBe(42);
    expect(ran).toEqual(["fn"]);
    realm.drain();
  });

  it("still sends end when fn THROWS, and re-throws fn's error unchanged", async () => {
    const realm = makeRealm();

    const promise = realm.api.withUnprotected("s3cret", async () => {
      throw new Error("the write failed");
    });
    realm.answer("api.beginUnprotected", { token: "unprot-1", wasProtected: true });
    await tick();

    expect(
      sent(realm.calls, "api.endUnprotected"),
      "a throwing fn must still put the protection back",
    ).toBe(true);
    realm.answer("api.endUnprotected", { reprotected: true });

    await expect(promise).rejects.toThrow("the write failed");
    realm.drain();
  });

  it("skips end when the sheet was never protected (token null)", async () => {
    const realm = makeRealm();
    const promise = realm.api.withUnprotected(undefined, async () => "done");
    realm.answer("api.beginUnprotected", { token: null, wasProtected: false });
    await expect(promise).resolves.toBe("done");
    expect(sent(realm.calls, "api.endUnprotected")).toBe(false);
    realm.drain();
  });

  it("never runs fn when begin rejects (wrong password)", async () => {
    const realm = makeRealm();
    let ran = false;

    const promise = realm.api.withUnprotected("guess", async () => {
      ran = true;
    });
    realm.fail("api.beginUnprotected", "withUnprotected: the password is wrong for sheet 0");

    await expect(promise).rejects.toThrow(/password is wrong/);
    expect(ran).toBe(false);
    // ...and no end is sent for a hold that was never opened.
    expect(sent(realm.calls, "api.endUnprotected")).toBe(false);
    realm.drain();
  });

  it("takes the options-bag spelling ({ password, sheet }) as well as a bare password", () => {
    const realm = makeRealm();
    void realm.api.withUnprotected({ password: "s3cret", sheet: "Data" }, async () => 0);
    expect(realm.calls[0]).toMatchObject({ args: ["s3cret", "Data"] });
    realm.drain();
  });

  it("the explicit third argument wins over the bag's sheet", () => {
    const realm = makeRealm();
    void realm.api.withUnprotected({ password: "s3cret", sheet: "Data" }, async () => 0, 0);
    expect(realm.calls[0]).toMatchObject({ args: ["s3cret", 0] });
    realm.drain();
  });

  it("a non-function fn is refused, and the protection is still put back", async () => {
    const realm = makeRealm();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const promise = realm.api.withUnprotected("s3cret", 42 as any);
    realm.answer("api.beginUnprotected", { token: "unprot-1", wasProtected: true });
    await tick();
    expect(sent(realm.calls, "api.endUnprotected")).toBe(true);
    realm.answer("api.endUnprotected", { reprotected: true });
    await expect(promise).rejects.toThrow(/fn must be a function/);
    realm.drain();
  });
});

// ============================================================================
// (7) the orphan window: a script that departs mid-begin
// ============================================================================
//
// releaseUnprotectedSheets can only release holds that are RECORDED. A script
// killed while its unprotect is still in flight is swept before the hold
// exists, and will never be swept again — so without a departure check the
// hold recorded a moment later belongs to nobody, and the sheet stays open for
// the rest of the session. That is exactly the leak withUnprotected exists to
// prevent, arrived at from the other end.

/** A lib whose unprotectSheet BLOCKS until released, so a departure can be
 *  injected into the window between "decided to lift" and "the sheet is open". */
function makeGatedLib() {
  const { lib, state } = makeLib();
  let openGate!: () => void;
  const reachedUnprotect = new Promise<void>((r) => (openGate = r));
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const inner = lib.unprotectSheet;
  lib.unprotectSheet = vi.fn(async (password?: string) => {
    openGate();
    await held;
    return inner(password);
  });
  return { lib, state, reachedUnprotect, release: () => release() };
}

describe("a script that departs while its begin is in flight", () => {
  it("puts the protection back instead of recording a hold nobody owns", async () => {
    const { lib, state, reachedUnprotect, release } = makeGatedLib();
    const begin = executeBeginUnprotected(asLib(lib), "script-1", "s3cret", 0);
    await reachedUnprotect;

    // The script dies HERE, in the same order hostUnmountScript does it: the
    // departure is noted first, and only then is the sweep consulted.
    noteScriptDeparture("script-1");
    expect(
      scriptOwesUnprotectRestore("script-1"),
      "precondition: the hold does not exist yet, so the sweep has nothing to find",
    ).toBe(false);
    await releaseUnprotectedSheets(asLib(lib), "script-1");

    release();
    await expect(begin).rejects.toThrow(/ended while the protection on sheet 0 was being lifted/);

    expect(state.isProtected, "the sheet must not be left open").toBe(true);
    expect(scriptsHoldingUnprotected().size, "no orphan hold may remain").toBe(0);
    // ...and restored to what was really there, not the dialog defaults.
    expect(state.options).toEqual(PRIOR_OPTIONS);
    expect(state.password).toBe("s3cret");
  });

  it("audits that host-made restore, so the ring shows the sheet was closed again", async () => {
    const { lib, reachedUnprotect, release } = makeGatedLib();
    const begin = executeBeginUnprotected(asLib(lib), "script-1", "s3cret", 0);
    await reachedUnprotect;
    noteScriptDeparture("script-1");
    await releaseUnprotectedSheets(asLib(lib), "script-1");
    release();
    await begin.catch(() => {});

    const entries = getAuditTail(20).filter((e) => e.method === "api.endUnprotected");
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatchObject({ scriptId: "script-1", class: "mutate", ok: true });
  });

  it("says so LOUDLY when that restore itself fails", async () => {
    const { lib, reachedUnprotect, release } = makeGatedLib();
    lib.protectSheet = vi.fn(async () => ({ success: false, error: "backend gone" }));
    const begin = executeBeginUnprotected(asLib(lib), "script-1", "s3cret", 0);
    await reachedUnprotect;
    noteScriptDeparture("script-1");
    await releaseUnprotectedSheets(asLib(lib), "script-1");
    release();
    await begin.catch(() => {});

    const entries = getAuditTail(20).filter((e) => e.method === "api.endUnprotected");
    expect(entries.length).toBe(1);
    expect(entries[0].ok).toBe(false);
    expect(entries[0].error).toMatch(/backend gone/);
    // The hold is still not recorded: a failed restore must not become a debt
    // attributed to a script that is already gone.
    expect(scriptsHoldingUnprotected().size).toBe(0);
  });

  it("refuses WITHOUT touching the sheet when it departed before the lift", async () => {
    const { lib, state } = makeLib();
    // Departure lands while assertActiveSheet is still resolving the ref.
    lib.getSheets = vi.fn(async () => {
      noteScriptDeparture("script-1");
      return { sheets: SHEETS, activeIndex: state.active };
    });

    await expect(
      executeBeginUnprotected(asLib(lib), "script-1", "s3cret", "Sheet1"),
    ).rejects.toThrow(/ended before the protection on sheet 0 was lifted/);

    expect(lib.unprotectSheet, "nothing may be lifted").not.toHaveBeenCalled();
    expect(lib.protectSheet, "and nothing put back — it was never opened").not.toHaveBeenCalled();
    expect(state.isProtected).toBe(true);
    expect(scriptsHoldingUnprotected().size).toBe(0);
  });

  it("does not JOIN a live hold on behalf of a script that already departed", async () => {
    const { lib, state } = makeLib();
    // A real hold, opened by someone still running.
    await executeBeginUnprotected(asLib(lib), "owner", "s3cret", 0);
    expect(state.isProtected).toBe(false);

    lib.getSheets = vi.fn(async () => {
      noteScriptDeparture("latecomer");
      return { sheets: SHEETS, activeIndex: state.active };
    });
    await expect(
      executeBeginUnprotected(asLib(lib), "latecomer", "s3cret", "Sheet1"),
    ).rejects.toThrow(/ended before the protection/);

    // The owner's hold is untouched: exactly one holder, and it is the owner.
    const hold = scriptsHoldingUnprotected().get(0);
    expect(hold?.holders.size).toBe(1);
    expect(hold?.holders.has("owner")).toBe(true);
    // ...so when the OWNER lets go, the sheet still closes.
    await releaseUnprotectedSheets(asLib(lib), "owner");
    expect(state.isProtected).toBe(true);
  });

  it("leaves an ordinary begin alone (the guard is not always-on)", async () => {
    const { lib, state } = makeLib();
    const hold = await executeBeginUnprotected(asLib(lib), "script-1", "s3cret", 0);
    expect(hold.token).not.toBeNull();
    expect(state.isProtected).toBe(false);
    expect(scriptsHoldingUnprotected().size).toBe(1);
  });

  it("counts departures per script and never rewinds", () => {
    const before = scriptDepartureEpoch("counter-probe");
    noteScriptDeparture("counter-probe");
    noteScriptDeparture("counter-probe");
    expect(scriptDepartureEpoch("counter-probe")).toBe(before + 2);
    // Deliberately NOT cleared by the tracking reset: a begin samples the epoch
    // and compares it later, so zeroing between those two points would make a
    // departure that DID happen compare equal — the orphan this guard catches.
    resetUnprotectedTracking();
    expect(scriptDepartureEpoch("counter-probe")).toBe(before + 2);
  });

  it("hostUnmountScript notes the departure BEFORE it consults the sweep", () => {
    // Source pin: the ordering IS the fix. If the sweep ran first, an in-flight
    // begin would still land afterwards and record its orphan.
    const note = hostSrc.indexOf("noteScriptDeparture(scriptId);");
    const sweep = hostSrc.indexOf("scriptOwesUnprotectRestore(scriptId)");
    expect(note).toBeGreaterThan(-1);
    expect(sweep).toBeGreaterThan(-1);
    expect(note).toBeLessThan(sweep);
  });
});
