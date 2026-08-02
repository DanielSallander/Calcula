//! FILENAME: app/src/api/__tests__/workbookTrust.test.ts
// PURPOSE: Cover the persistent, revocable per-workbook trust store (the
//          Trusted-Documents analog) that stops the "prompt" Script Security
//          level from re-asking on every app restart.
// CONTEXT: The properties under test are the security-critical ones, not the
//          convenience: trust survives a restart; a source edit LAPSES it and
//          yields a diff; a capability escalation re-prompts; revoke takes
//          effect; distributed (.calp) code is never covered; and nothing is
//          ever written into the workbook (trust must not travel with the file).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Backend double. distributedConsent imports readVirtualFile/createVirtualFile
// from the SAME module, so the mock must supply all three exports — and
// createVirtualFile doubles as the tripwire proving trust never touches the
// workbook's virtual filesystem.
// ---------------------------------------------------------------------------
const invokeMock = vi.fn();
const createVirtualFileMock = vi.fn();
const readVirtualFileMock = vi.fn(async () => {
  throw new Error("no such virtual file");
});
vi.mock("../backend", () => ({
  invokeBackend: (...args: unknown[]) => invokeMock(...args),
  createVirtualFile: (...args: unknown[]) => createVirtualFileMock(...args),
  readVirtualFile: (...args: unknown[]) => readVirtualFileMock(...args),
}));

// The open workbook's path — the trust key's only input.
let currentPath: string | null = "C:\\Books\\Q4 Report.cala";
vi.mock("../../core/lib/file-api", () => ({
  getCurrentFilePath: async () => currentPath,
}));

// The workbook's code inventory (scriptSecurity dynamic-imports this).
interface FakeUnit {
  surfaceId: string;
  id: string;
  name: string;
  source: string;
  provenance: "local" | "distributed";
}
let inventory: FakeUnit[] = [];
/** When set, the inventory FAILS instead of returning — the case the gate used
 *  to swallow (see "the inventory cannot be taken" below). */
let inventoryError: Error | null = null;
vi.mock("../codeInventory", () => ({
  getWorkbookCodeUnits: async () => {
    if (inventoryError) throw inventoryError;
    return inventory;
  },
}));

import {
  ensureScriptsAllowed,
  evaluateWorkbookTrust,
  evaluateCurrentWorkbookTrust,
  collectLocalWorkbookScripts,
  trustCurrentWorkbook,
  listWorkbookTrust,
  getWorkbookTrustRecord,
  revokeWorkbookRunTrust,
  revokeWorkbookTrustEntirely,
  revokeAllWorkbookTrust,
  invalidateTrustCache,
  workbookTrustKeyFromPath,
  persistNotebookCapabilityGrant,
  isNotebookCapabilityPersisted,
  rehydrateNotebookCapabilityGrants,
  revokeNotebookCapabilityGrants,
  describeTrustLapse,
  notebookScriptId,
} from "../scriptSecurity";
import type { WorkbookTrustRecord } from "../scriptSecurity";
import { sha256Hex } from "../distributedConsent";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KEY = "c:/books/q4 report.cala";

const SCRIPT_SRC = "function setup(shape){ shape.onClick(function(){ shape.text = 'hi'; }); }";
const SCRIPT_SRC_EDITED =
  "function setup(shape){ shape.onClick(function(){ shape.text = 'PWNED'; }); }";

const localUnit = (source: string): FakeUnit => ({
  surfaceId: "object-script",
  id: "btn-1",
  name: "Button 1",
  source,
  provenance: "local",
});

const distributedUnit = (): FakeUnit => ({
  surfaceId: "object-script",
  id: "pkg-script",
  name: "Vendor Script",
  source: "// @capability net.fetch\nfunction setup(){}",
  provenance: "distributed",
});

/** Route backend calls by command name so tests don't depend on call ORDER. */
function backend(status: "allowed" | "disabled" | "needsApproval") {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "script_execution_status") return status;
    return undefined;
  });
}

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  createVirtualFileMock.mockReset();
  currentPath = "C:\\Books\\Q4 Report.cala";
  inventory = [localUnit(SCRIPT_SRC)];
  inventoryError = null;
  invalidateTrustCache();
  backend("needsApproval");
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
describe("workbook identity", () => {
  it("normalizes a Windows path into one case-insensitive key", () => {
    expect(workbookTrustKeyFromPath("C:\\Books\\Q4 Report.cala")).toBe(KEY);
    expect(workbookTrustKeyFromPath("c:/BOOKS/q4 report.cala")).toBe(KEY);
  });

  it("has NO key for an unsaved workbook — it cannot be persistently trusted", async () => {
    expect(workbookTrustKeyFromPath(null)).toBeNull();
    expect(workbookTrustKeyFromPath("   ")).toBeNull();
    currentPath = null;
    expect(await trustCurrentWorkbook()).toBe(false);
    expect(listWorkbookTrust()).toEqual([]);
  });
});

// ===========================================================================
describe("trust persists across a restart", () => {
  it("a trusted workbook mounts with NO prompt after a simulated relaunch", async () => {
    // 1. First run: user is asked, approves, and chooses to trust.
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    expect(await ensureScriptsAllowed("Run scripts?")).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(2); // run prompt + trust offer
    expect(getWorkbookTrustRecord(KEY)?.runTrust).not.toBeNull();

    // 2. RESTART: throw away every module instance (and therefore the session
    //    cache and the backend's in-memory session grant). localStorage — the
    //    only place trust lives — survives, exactly like a real relaunch.
    confirm.mockClear();
    vi.resetModules();
    const fresh = await import("../scriptSecurity");
    backend("needsApproval");

    expect(await fresh.ensureScriptsAllowed("Run scripts?")).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    // The session approval was granted silently so the Rust-side gate agrees.
    expect(invokeMock).toHaveBeenCalledWith("grant_script_session_approval");
  });

  it("trust is stored ONLY on this machine — never written into the workbook", async () => {
    await trustCurrentWorkbook();
    expect(createVirtualFileMock).not.toHaveBeenCalled();
    // and it really is in localStorage, the host-side store
    expect(localStorage.getItem("calcula.scriptTrust.v1")).toContain(KEY);
  });

  it("a workbook opened from a DIFFERENT path is not trusted (trust never travels)", async () => {
    await trustCurrentWorkbook();
    currentPath = "D:\\Downloads\\Q4 Report.cala"; // same file, arrived by email
    invalidateTrustCache();
    const trust = await evaluateCurrentWorkbookTrust();
    expect(trust?.evaluation.status).toBe("untrusted");
  });
});

// ===========================================================================
describe("a source edit lapses trust and shows a diff", () => {
  it("lapses with reason sourceChanged and a usable old->new diff", async () => {
    await trustCurrentWorkbook();

    inventory = [localUnit(SCRIPT_SRC_EDITED)];
    invalidateTrustCache();
    const trust = await evaluateCurrentWorkbookTrust();

    expect(trust?.evaluation.status).toBe("lapsed");
    expect(trust?.evaluation.reason).toBe("sourceChanged");
    expect(trust?.evaluation.changedScripts).toHaveLength(1);
    expect(trust?.evaluation.changedScripts[0].oldSource).toBe(SCRIPT_SRC);
    expect(trust?.evaluation.changedScripts[0].newSource).toBe(SCRIPT_SRC_EDITED);

    const description = describeTrustLapse(trust!.evaluation);
    expect(description).toContain("trust has lapsed");
    expect(description).toContain("PWNED"); // the added line is shown
    expect(description).toMatch(/^\s*\+/m);
    expect(description).toMatch(/^\s*-/m);
  });

  it("re-prompts (with the diff) instead of silently running the edited code", async () => {
    await trustCurrentWorkbook();
    inventory = [localUnit(SCRIPT_SRC_EDITED)];
    invalidateTrustCache();

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    expect(await ensureScriptsAllowed("Run scripts?")).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toContain("trust has lapsed");
    expect(invokeMock).not.toHaveBeenCalledWith("grant_script_session_approval");
  });

  it("a NEW script lapses trust even when every previously-trusted script is untouched", async () => {
    await trustCurrentWorkbook();
    inventory = [
      localUnit(SCRIPT_SRC),
      { surfaceId: "one-off-script", id: "new", name: "New", source: "evil()", provenance: "local" },
    ];
    invalidateTrustCache();
    const trust = await evaluateCurrentWorkbookTrust();
    expect(trust?.evaluation.status).toBe("lapsed");
    expect(trust?.evaluation.reason).toBe("scriptAdded");
    expect(describeTrustLapse(trust!.evaluation)).toContain("NEW CODE");
  });

  it("REMOVING a script does not lapse trust (less code cannot be more dangerous)", async () => {
    inventory = [
      localUnit(SCRIPT_SRC),
      { surfaceId: "one-off-script", id: "extra", name: "Extra", source: "noop()", provenance: "local" },
    ];
    await trustCurrentWorkbook();
    inventory = [localUnit(SCRIPT_SRC)];
    invalidateTrustCache();
    expect((await evaluateCurrentWorkbookTrust())?.evaluation.status).toBe("trusted");
  });
});

// ===========================================================================
describe("capability escalation re-prompts", () => {
  /** A record whose hashes match the live source but whose consented capability
   *  set is narrower — i.e. the code now declares something new. Built directly
   *  so the escalation is isolated from the source-hash guard. */
  async function recordDeclaring(
    source: string,
    consentedCaps: string[],
  ): Promise<WorkbookTrustRecord> {
    return {
      workbookKey: KEY,
      displayPath: "C:\\Books\\Q4 Report.cala",
      runTrust: {
        scripts: [{ id: "object-script:btn-1", sourceHash: await sha256Hex(source), source }],
        declaredCapabilities: consentedCaps as never,
        trustedAt: new Date().toISOString(),
      },
      notebookGrants: [],
    };
  }

  it("lapses when the code declares a capability it did not declare at trust time", async () => {
    const source = "// @capability net.fetch\nfunction setup(){}";
    const record = await recordDeclaring(source, []);
    const evaluation = await evaluateWorkbookTrust(record, [
      { id: "object-script:btn-1", name: "Button 1", source },
    ]);
    expect(evaluation.status).toBe("lapsed");
    expect(evaluation.reason).toBe("capabilityEscalation");
    expect(evaluation.addedCapabilities).toEqual(["net.fetch"]);
    expect(describeTrustLapse(evaluation)).toContain("net.fetch");
  });

  it("does NOT lapse when the declared set is unchanged", async () => {
    const source = "// @capability storage\nfunction setup(){}";
    const record = await recordDeclaring(source, ["storage"]);
    const evaluation = await evaluateWorkbookTrust(record, [
      { id: "object-script:btn-1", name: "Button 1", source },
    ]);
    expect(evaluation.status).toBe("trusted");
  });

  it("does NOT lapse when the code drops a capability (de-escalation is safe)", async () => {
    const source = "function setup(){}";
    const record = await recordDeclaring(source, ["storage", "net.fetch"]);
    const evaluation = await evaluateWorkbookTrust(record, [
      { id: "object-script:btn-1", name: "Button 1", source },
    ]);
    expect(evaluation.status).toBe("trusted");
  });

  it("trusting a workbook grants NO capability — it only records the baseline", async () => {
    inventory = [localUnit("// @capability net.fetch\n// @capability bi.sql\nfunction setup(){}")];
    await trustCurrentWorkbook();
    const runTrust = getWorkbookTrustRecord(KEY)!.runTrust!;
    expect(runTrust.declaredCapabilities).toEqual(["bi.sql", "net.fetch"]);
    // The baseline is NOT a grant: nothing was mirrored into the backend store.
    expect(invokeMock).not.toHaveBeenCalledWith("grant_script_capability", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("grant_script_net_origin", expect.anything());
  });
});

// ===========================================================================
describe("revoke", () => {
  it("revoking run-trust makes the very next gate check prompt again", async () => {
    await trustCurrentWorkbook();
    invalidateTrustCache();
    expect((await evaluateCurrentWorkbookTrust())?.evaluation.status).toBe("trusted");

    revokeWorkbookRunTrust(KEY);

    // No invalidateTrustCache() here on purpose: revoking must invalidate by
    // itself, or "revoked" would not mean "stop" until the next restart.
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    expect(await ensureScriptsAllowed("Run scripts?")).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(listWorkbookTrust()).toEqual([]);
  });

  it("revoking run-trust keeps notebook grants (they are a separate decision)", async () => {
    await trustCurrentWorkbook();
    await persistNotebookCapabilityGrant("nb-1", "bi.query");
    revokeWorkbookRunTrust(KEY);
    const record = getWorkbookTrustRecord(KEY)!;
    expect(record.runTrust).toBeNull();
    expect(record.notebookGrants).toHaveLength(1);
  });

  it("'forget workbook' removes run-trust and every notebook grant", async () => {
    await trustCurrentWorkbook();
    await persistNotebookCapabilityGrant("nb-1", "bi.query");
    revokeWorkbookTrustEntirely(KEY);
    expect(getWorkbookTrustRecord(KEY)).toBeNull();
  });

  it("'clear all' empties the store", async () => {
    await trustCurrentWorkbook();
    currentPath = "C:\\Books\\Other.cala";
    await trustCurrentWorkbook();
    expect(listWorkbookTrust()).toHaveLength(2);
    revokeAllWorkbookTrust();
    expect(listWorkbookTrust()).toEqual([]);
  });
});

// ===========================================================================
describe("distributed (.calp) code is unaffected", () => {
  it("is excluded from the trusted set entirely", async () => {
    inventory = [localUnit(SCRIPT_SRC), distributedUnit()];
    const collected = await collectLocalWorkbookScripts();
    expect(collected.map((s) => s.id)).toEqual(["object-script:btn-1"]);

    await trustCurrentWorkbook();
    const runTrust = getWorkbookTrustRecord(KEY)!.runTrust!;
    expect(runTrust.scripts).toHaveLength(1);
    // The package script declares net.fetch; trust must not absorb that.
    expect(runTrust.declaredCapabilities).toEqual([]);
  });

  it("changing a package script does not lapse workbook trust (its own consent governs it)", async () => {
    inventory = [localUnit(SCRIPT_SRC), distributedUnit()];
    await trustCurrentWorkbook();
    inventory = [
      localUnit(SCRIPT_SRC),
      { ...distributedUnit(), source: "// @capability bi.sql\nfunction setup(){ steal(); }" },
    ];
    invalidateTrustCache();
    expect((await evaluateCurrentWorkbookTrust())?.evaluation.status).toBe("trusted");
  });

  it("trust never writes to the package consent store", async () => {
    inventory = [localUnit(SCRIPT_SRC), distributedUnit()];
    await trustCurrentWorkbook();
    expect(createVirtualFileMock).not.toHaveBeenCalled();
  });
});

// ===========================================================================
describe("the global level still wins", () => {
  it("'disabled' blocks even a trusted workbook, with no prompt", async () => {
    await trustCurrentWorkbook();
    backend("disabled");
    const confirm = vi.spyOn(window, "confirm");
    expect(await ensureScriptsAllowed("Run scripts?")).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("'enabled' short-circuits before trust is even consulted", async () => {
    backend("allowed");
    const confirm = vi.spyOn(window, "confirm");
    expect(await ensureScriptsAllowed("Run scripts?")).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("declining the trust offer still allows this session only", async () => {
    const confirm = vi
      .spyOn(window, "confirm")
      .mockReturnValueOnce(true) // run this time
      .mockReturnValueOnce(false); // but do not trust
    expect(await ensureScriptsAllowed("Run scripts?")).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(listWorkbookTrust()).toEqual([]);
  });
});

// ===========================================================================
describe("notebook capability grants", () => {
  it("persist per workbook + notebook and re-mirror on rehydrate", async () => {
    expect(await persistNotebookCapabilityGrant("nb-1", "bi.query")).toBe(true);
    expect(await isNotebookCapabilityPersisted("nb-1", "bi.query")).toBe(true);

    invokeMock.mockClear();
    expect(await rehydrateNotebookCapabilityGrants()).toBe(1);
    expect(invokeMock).toHaveBeenCalledWith("grant_script_capability", {
      scriptId: notebookScriptId("nb-1"),
      capability: "bi.query",
    });
  });

  it("an ESCALATION is not covered — a capability the user never approved reads false", async () => {
    await persistNotebookCapabilityGrant("nb-1", "bi.query");
    expect(await isNotebookCapabilityPersisted("nb-1", "bi.sql")).toBe(false);
    // ...and only the approved id is re-mirrored.
    invokeMock.mockClear();
    await rehydrateNotebookCapabilityGrants();
    expect(invokeMock).not.toHaveBeenCalledWith("grant_script_capability", {
      scriptId: notebookScriptId("nb-1"),
      capability: "bi.sql",
    });
  });

  it("is scoped to ONE notebook and ONE workbook", async () => {
    await persistNotebookCapabilityGrant("nb-1", "bi.query");
    expect(await isNotebookCapabilityPersisted("nb-2", "bi.query")).toBe(false);
    currentPath = "C:\\Books\\Other.cala";
    expect(await isNotebookCapabilityPersisted("nb-1", "bi.query")).toBe(false);
  });

  it("revoke drops the persisted grant AND the live backend mirror", async () => {
    await persistNotebookCapabilityGrant("nb-1", "bi.query");
    invokeMock.mockClear();
    await revokeNotebookCapabilityGrants(KEY, "nb-1");
    expect(await isNotebookCapabilityPersisted("nb-1", "bi.query")).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith("revoke_script_capabilities", {
      scriptId: notebookScriptId("nb-1"),
    });
    // Nothing left to restore after a restart.
    expect(await rehydrateNotebookCapabilityGrants()).toBe(0);
  });

  it("an unsaved workbook cannot persist a grant (session-only)", async () => {
    currentPath = null;
    expect(await persistNotebookCapabilityGrant("nb-1", "bi.query")).toBe(false);
    expect(listWorkbookTrust()).toEqual([]);
  });
});

// ===========================================================================
describe("store robustness", () => {
  it("a corrupt store fails CLOSED (no trust) instead of throwing into a mount", async () => {
    localStorage.setItem("calcula.scriptTrust.v1", "{not json");
    expect(listWorkbookTrust()).toEqual([]);
    invalidateTrustCache();
    expect((await evaluateCurrentWorkbookTrust())?.evaluation.status).toBe("untrusted");
  });

  it("a record with a malformed runTrust reads as untrusted", async () => {
    localStorage.setItem(
      "calcula.scriptTrust.v1",
      JSON.stringify({
        version: 1,
        records: [{ workbookKey: KEY, displayPath: KEY, runTrust: { scripts: "all of them" } }],
      }),
    );
    invalidateTrustCache();
    expect((await evaluateCurrentWorkbookTrust())?.evaluation.status).toBe("untrusted");
  });
});

// ===========================================================================
// The inventory itself failing — the ASYMMETRY that made the gate fail OPEN
// ===========================================================================
//
// The store side of this module already failed closed (see "store robustness"
// above). The INVENTORY side did the opposite: collectLocalWorkbookScripts
// caught every error and returned `[]`, and `[]` is not "no code" — it is "the
// same code as every stored record", because a REMOVED script never lapses
// trust (less code cannot be more dangerous). So a trusted workbook whose
// inventory failed evaluated as `trusted`, and ensureScriptsAllowed granted the
// session approval with no human in the loop.
//
// Trust is a CHANGE-DETECTION gate. "I could not look" must lapse it.
describe("the inventory cannot be taken", () => {
  const boom = (): Error => new Error("codeInventory: backend call timed out");

  it("LAPSES a trusted workbook instead of reporting it trusted", async () => {
    await trustCurrentWorkbook();
    invalidateTrustCache();
    expect((await evaluateCurrentWorkbookTrust())?.evaluation.status).toBe("trusted");

    inventoryError = boom();
    invalidateTrustCache();
    const trust = await evaluateCurrentWorkbookTrust();
    expect(trust?.evaluation.status).toBe("lapsed");
    expect(trust?.evaluation.reason).toBe("inventoryUnavailable");
  });

  it("ASKS the user rather than auto-granting the session approval", async () => {
    // The security property, stated as the security property: the gate must
    // reach a human, and must NOT hand out grant_script_session_approval on its
    // own the way it did when the empty inventory read as "nothing changed".
    await trustCurrentWorkbook();
    inventoryError = boom();
    invalidateTrustCache();
    invokeMock.mockClear();
    backend("needsApproval");

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    expect(await ensureScriptsAllowed("Run scripts?")).toBe(false);
    expect(confirm, "the user must be asked").toHaveBeenCalled();
    expect(
      invokeMock.mock.calls.map((c) => c[0]),
      "no session approval may be granted without an answer",
    ).not.toContain("grant_script_session_approval");
  });

  it("explains the lapse honestly — it does not claim the code changed", async () => {
    await trustCurrentWorkbook();
    inventoryError = boom();
    invalidateTrustCache();
    const trust = await evaluateCurrentWorkbookTrust();
    const message = describeTrustLapse(trust!.evaluation);
    expect(message).toContain("could not read its scripts");
    expect(
      message,
      "we do not know that anything changed — saying so would send the user hunting for a diff that is not there",
    ).not.toContain("its code changed");
  });

  it("REFUSES to record trust from an inventory that failed", async () => {
    // A baseline taken from a failed inventory says "this workbook has no code"
    // and would silently trust whatever the inventory could not see.
    inventoryError = boom();
    expect(await trustCurrentWorkbook()).toBe(false);
    expect(getWorkbookTrustRecord(KEY)?.runTrust ?? null).toBeNull();
  });

  it("does NOT cache the failure — a transient error must not stick all session", async () => {
    await trustCurrentWorkbook();
    inventoryError = boom();
    invalidateTrustCache();
    expect((await evaluateCurrentWorkbookTrust())?.evaluation.status).toBe("lapsed");

    inventoryError = null;
    // No invalidateTrustCache(): the failed evaluation must never have been
    // cached in the first place.
    expect((await evaluateCurrentWorkbookTrust())?.evaluation.status).toBe("trusted");
  });
});
