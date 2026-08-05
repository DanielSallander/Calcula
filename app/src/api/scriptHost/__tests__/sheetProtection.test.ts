//! FILENAME: app/src/api/scriptHost/__tests__/sheetProtection.test.ts
// PURPOSE: Wave 3 item 8 — api.protectSheet / unprotectSheet /
//          getProtectionStatus over the protection.rs commands.
// COVERS:  (1) validator matrices, including the LOUD scriptsCanEdit refusal
//              (UserInterfaceOnly is deferred, not silently swallowed);
//          (2) allowlist wiring: unlocked-tier ONLY, no capability, honest
//              classes — a distributed (restricted) script can never lock the
//              user out of a sheet nor lift a protection;
//          (3) executor behaviour: defaults merged like the Protect Sheet
//              dialog, password plumbed, wrong password answers FALSE (never
//              throws), already-unprotected answers true, real errors throw;
//          (4) the round-trip: protect -> status -> unprotect(wrong) = false ->
//              unprotect(right) = true -> status, over a stateful backend
//              emulator mirroring protection.rs;
//          (5) the worker shim dispatch.

import { describe, it, expect, vi } from "vitest";
import {
  vProtectSheet,
  vUnprotectSheet,
  vProtectionStatus,
  SHEET_PROTECTION_OPTION_KEYS,
} from "../validators";
import { ALLOWLIST } from "../allowlist";
import {
  executeProtectSheet,
  executeUnprotectSheet,
  type ScriptProtectSheetOptions,
} from "../host";
import { buildWorkerContext, type WorkerRuntime } from "../worker/contextShims";
import type { MountSpec, W2H } from "../protocol";

// ============================================================================
// (1) validators
// ============================================================================

describe("vProtectSheet", () => {
  it("accepts nothing, a password, partial flags, and a sheet ref", () => {
    expect(vProtectSheet([])).toBe(true);
    expect(vProtectSheet([undefined])).toBe(true);
    expect(vProtectSheet([{}])).toBe(true);
    expect(vProtectSheet([{ password: "s3cret" }])).toBe(true);
    expect(vProtectSheet([{ allowSort: true, allowFormatCells: true }])).toBe(true);
    expect(vProtectSheet([{ password: "x", allowAutoFilter: true }, "Data"])).toBe(true);
    expect(vProtectSheet([{}, 0])).toBe(true);
  });

  it("REFUSES scriptsCanEdit with the deferral spelled out", () => {
    const verdict = vProtectSheet([{ scriptsCanEdit: true }]);
    expect(verdict).not.toBe(true);
    expect(String(verdict)).toContain("scriptsCanEdit");
    expect(String(verdict)).toContain("not supported");
  });

  it("rejects unknown flags (with the allowed set), non-boolean flags and bad passwords", () => {
    const verdict = vProtectSheet([{ allowEverything: true }]);
    expect(verdict).not.toBe(true);
    expect(String(verdict)).toContain("allowSelectLockedCells");
    expect(vProtectSheet([{ allowSort: "yes" }])).not.toBe(true);
    expect(vProtectSheet([{ password: 123 }])).not.toBe(true);
    expect(vProtectSheet([{ password: "x".repeat(300) }])).not.toBe(true);
    expect(vProtectSheet(["protect"])).not.toBe(true);
    expect(vProtectSheet([{}, true])).not.toBe(true);
  });

  it("its flag enumeration matches the backend option set key for key", () => {
    // Mirrors SheetProtectionOptions in api/backend.ts (and protection.rs).
    expect([...SHEET_PROTECTION_OPTION_KEYS].sort()).toEqual([
      "allowAutoFilter", "allowDeleteColumns", "allowDeleteRows",
      "allowEditObjects", "allowEditScenarios",
      "allowFormatCells", "allowFormatColumns", "allowFormatRows",
      "allowInsertColumns", "allowInsertHyperlinks", "allowInsertRows",
      "allowPivotTables", "allowSelectLockedCells", "allowSelectUnlockedCells",
      "allowSort",
    ]);
  });
});

describe("vUnprotectSheet / vProtectionStatus", () => {
  it("accept an optional password and an optional sheet ref", () => {
    expect(vUnprotectSheet([])).toBe(true);
    expect(vUnprotectSheet(["pw"])).toBe(true);
    expect(vUnprotectSheet([null])).toBe(true);
    expect(vUnprotectSheet(["pw", "Data"])).toBe(true);
    expect(vUnprotectSheet([42])).not.toBe(true);
    expect(vProtectionStatus([])).toBe(true);
    expect(vProtectionStatus(["Data"])).toBe(true);
    expect(vProtectionStatus([true])).not.toBe(true);
  });
});

// ============================================================================
// (2) allowlist wiring
// ============================================================================

describe("protection allowlist rows", () => {
  it("are unlocked-tier ONLY — a distributed script can never reach them", () => {
    expect(ALLOWLIST["api.protectSheet"]).toMatchObject({ tier: "unlocked", class: "mutate" });
    expect(ALLOWLIST["api.unprotectSheet"]).toMatchObject({ tier: "unlocked", class: "mutate" });
    expect(ALLOWLIST["api.getProtectionStatus"]).toMatchObject({ tier: "unlocked", class: "read" });
    for (const m of ["api.protectSheet", "api.unprotectSheet", "api.getProtectionStatus"]) {
      expect(ALLOWLIST[m].capability, m).toBeUndefined();
    }
    expect(ALLOWLIST["api.protectSheet"].validate).toBe(vProtectSheet);
    expect(ALLOWLIST["api.unprotectSheet"].validate).toBe(vUnprotectSheet);
    expect(ALLOWLIST["api.getProtectionStatus"].validate).toBe(vProtectionStatus);
  });

  it("there is deliberately NO sheet.* protection twin", () => {
    for (const m of Object.keys(ALLOWLIST)) {
      expect(m.startsWith("sheet.") && /rotect/.test(m), m).toBe(false);
    }
  });
});

// ============================================================================
// A stateful backend emulator mirroring protection.rs
// ============================================================================

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

function makeProtectionLib() {
  const state = {
    protected: false,
    password: null as string | null,
    options: { ...DEFAULT_OPTIONS },
  };
  const lib = {
    DEFAULT_PROTECTION_OPTIONS: { ...DEFAULT_OPTIONS },
    protectSheet: vi.fn(async (params: { password?: string; options?: typeof DEFAULT_OPTIONS }) => {
      // protection.rs protect_sheet: already protected is a refusal.
      if (state.protected) return { success: false, error: "Sheet is already protected" };
      state.protected = true;
      state.password = params.password && params.password.length > 0 ? params.password : null;
      if (params.options) state.options = { ...params.options };
      return { success: true };
    }),
    unprotectSheet: vi.fn(async (password?: string) => {
      // protection.rs unprotect_sheet, message for message.
      if (!state.protected) return { success: false, error: "Sheet is not protected" };
      if (state.password !== null && (password ?? "") !== state.password) {
        return { success: false, error: "Incorrect password" };
      }
      state.protected = false;
      state.password = null;
      return { success: true };
    }),
    getProtectionStatus: vi.fn(async () => ({
      isProtected: state.protected,
      hasPassword: state.password !== null,
      options: { ...state.options },
      allowEditRangeCount: 0,
    })),
  };
  return { lib, state };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asLib = (l: unknown) => l as any;

// ============================================================================
// (3) + (4) executor behaviour and the round-trip
// ============================================================================

describe("executeProtectSheet", () => {
  it("merges partial flags over the dialog's defaults and plumbs the password", async () => {
    const { lib } = makeProtectionLib();
    const result = await executeProtectSheet(asLib(lib), {
      password: "s3cret",
      allowSort: true,
    } as ScriptProtectSheetOptions);
    expect(result).toEqual({ protected: true, hasPassword: true });
    expect(lib.protectSheet).toHaveBeenCalledWith({
      password: "s3cret",
      options: { ...DEFAULT_OPTIONS, allowSort: true },
    });
  });

  it("an empty call protects with the defaults and no password", async () => {
    const { lib } = makeProtectionLib();
    const result = await executeProtectSheet(asLib(lib));
    expect(result).toEqual({ protected: true, hasPassword: false });
    expect(lib.protectSheet).toHaveBeenCalledWith({
      password: undefined,
      options: DEFAULT_OPTIONS,
    });
  });

  it("an empty-string password is NO password (matching the backend's rule)", async () => {
    const { lib, state } = makeProtectionLib();
    const result = await executeProtectSheet(asLib(lib), { password: "" });
    expect(result.hasPassword).toBe(false);
    expect(state.password).toBeNull();
  });

  it("protecting an already-protected sheet surfaces the backend refusal", async () => {
    const { lib } = makeProtectionLib();
    await executeProtectSheet(asLib(lib));
    await expect(executeProtectSheet(asLib(lib))).rejects.toThrow(/already protected/);
  });
});

describe("executeUnprotectSheet — the wrong-password contract", () => {
  it("answers FALSE for a wrong password, and never throws for it", async () => {
    const { lib, state } = makeProtectionLib();
    await executeProtectSheet(asLib(lib), { password: "right" });
    await expect(executeUnprotectSheet(asLib(lib), "wrong")).resolves.toBe(false);
    expect(state.protected).toBe(true); // still protected
  });

  it("answers true for the right password (and for no password when none is set)", async () => {
    const { lib, state } = makeProtectionLib();
    await executeProtectSheet(asLib(lib), { password: "right" });
    await expect(executeUnprotectSheet(asLib(lib), "right")).resolves.toBe(true);
    expect(state.protected).toBe(false);
    await executeProtectSheet(asLib(lib));
    await expect(executeUnprotectSheet(asLib(lib))).resolves.toBe(true);
  });

  it("answers true for an already-unprotected sheet (it is in the asked-for state)", async () => {
    const { lib } = makeProtectionLib();
    await expect(executeUnprotectSheet(asLib(lib))).resolves.toBe(true);
  });

  it("throws for a refusal that is neither of those", async () => {
    const { lib } = makeProtectionLib();
    lib.unprotectSheet.mockResolvedValueOnce({ success: false, error: "Workbook is corrupted" } as never);
    await expect(executeUnprotectSheet(asLib(lib), "x")).rejects.toThrow(/corrupted/);
  });
});

describe("the full round-trip", () => {
  it("protect -> status -> wrong password false -> right password true -> status", async () => {
    const { lib } = makeProtectionLib();
    await executeProtectSheet(asLib(lib), { password: "pw", allowAutoFilter: true });

    let status = await lib.getProtectionStatus();
    expect(status.isProtected).toBe(true);
    expect(status.hasPassword).toBe(true);
    expect(status.options.allowAutoFilter).toBe(true);
    expect(status.options.allowSort).toBe(false);

    await expect(executeUnprotectSheet(asLib(lib), "nope")).resolves.toBe(false);
    await expect(executeUnprotectSheet(asLib(lib), "pw")).resolves.toBe(true);

    status = await lib.getProtectionStatus();
    expect(status.isProtected).toBe(false);
    expect(status.hasPassword).toBe(false);
  });
});

// ============================================================================
// (5) worker shim dispatch
// ============================================================================

describe("worker shim: protection methods", () => {
  it("dispatch the api.* rows verbatim", () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const spec = {
      protocolVersion: 1,
      scriptId: "wave3-protection-test",
      objectType: "sheet",
      instanceId: null,
      tier: "unlocked",
      capabilities: [],
      apiVersion: "1.0.0",
      scriptName: "Wave3Protection",
      packageInfo: null,
      snapshot: {},
      source: "",
    } as unknown as MountSpec;
    const { context, rt } = buildWorkerContext(spec, (msg: W2H) => {
      if (msg.t === "call") calls.push({ method: msg.method, args: msg.args });
    });
    const api = (context as Record<string, unknown>).api as Record<string, unknown>;
    void (api.protectSheet as (...a: unknown[]) => Promise<unknown>)({ password: "pw" });
    void (api.unprotectSheet as (...a: unknown[]) => Promise<unknown>)("pw", "Data");
    void (api.getProtectionStatus as (...a: unknown[]) => Promise<unknown>)();
    expect(calls.map((c) => [c.method, ...c.args])).toEqual([
      ["api.protectSheet", { password: "pw" }, undefined],
      ["api.unprotectSheet", "pw", "Data"],
      ["api.getProtectionStatus", undefined],
    ]);
    for (const entry of (rt as WorkerRuntime).pending.values()) clearTimeout(entry.timer);
    (rt as WorkerRuntime).pending.clear();
  });
});
