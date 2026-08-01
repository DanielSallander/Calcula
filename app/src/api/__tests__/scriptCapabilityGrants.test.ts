//! FILENAME: app/src/api/__tests__/scriptCapabilityGrants.test.ts
// PURPOSE: Cover the persisted "Always allow in this workbook" capability grants
//          for LOCAL worker-realm scripts (F1) — the half of the Trusted-Documents
//          work that was still session-only, and the direct cause of the
//          scheduler's conditionally-true consent string (§7.10).
// CONTEXT: Every test here is a SECURITY property, not a convenience one:
//            * the grant survives a simulated relaunch (that is the feature);
//            * editing the script LAPSES it and the next prompt shows a DIFF;
//            * a capability (or a net.fetch origin) the script never held is an
//              escalation and is never restored;
//            * a grant is never restored above the script's declared ceiling;
//            * trusting a workbook to RUN its scripts grants NO capability;
//            * distributed (.calp) code never persists here — it keeps its own
//              per-package consent, which lives inside the workbook;
//            * revoke works, per capability and per script, and stops the live
//              + authoritative backend grant, not just the next launch;
//            * nothing is EVER written into the workbook (the tripwire is a
//              createVirtualFile spy that must stay untouched).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Backend double. createVirtualFile is the tripwire proving a grant can never
// ride inside a .cala / .calp to another machine.
// ---------------------------------------------------------------------------
const invokeMock = vi.fn(async () => undefined as unknown);
const createVirtualFileMock = vi.fn();
const readVirtualFileMock = vi.fn(async () => {
  throw new Error("no such virtual file");
});
vi.mock("../backend", () => ({
  invokeBackend: (...args: unknown[]) => invokeMock(...(args as [])),
  createVirtualFile: (...args: unknown[]) => createVirtualFileMock(...args),
  readVirtualFile: (...args: unknown[]) => readVirtualFileMock(...args),
}));

// The open workbook's path — the only input to the trust key.
let currentPath: string | null = "C:\\Books\\Q4 Report.cala";
vi.mock("../../core/lib/file-api", () => ({
  getCurrentFilePath: async () => currentPath,
}));

// scriptSecurity dynamic-imports this for run-trust; irrelevant to script grants
// (which is itself one of the properties under test).
interface FakeUnit {
  surfaceId: string;
  id: string;
  name: string;
  source: string;
  provenance: "local" | "distributed";
}
let inventory: FakeUnit[] = [];
vi.mock("../codeInventory", () => ({
  getWorkbookCodeUnits: async () => inventory,
}));

import {
  getScriptCapabilityGrant,
  persistScriptCapabilityGrant,
  restorePersistedScriptCapabilityGrant,
  revokeScriptCapability,
  revokeScriptCapabilityGrants,
  revokeWorkbookTrustEntirely,
  revokeAllWorkbookTrust,
  listWorkbookTrust,
  trustCurrentWorkbook,
  invalidateTrustCache,
  countPersistedScriptGrants,
} from "../scriptSecurity";
import {
  getGrantSet,
  getScriptGrants,
  hasFetchOrigin,
  persistAlwaysGrant,
  restoreAndSyncGrants,
  requestCapabilityGrant,
  resolveCapabilityRequest,
  resetAllGrants,
  consumeLapsedGrantNotice,
} from "../scriptHost/capabilities";
import type { CapabilityId } from "../scriptHost/capabilityIds";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KEY = "c:/books/q4 report.cala";
const SCRIPT_ID = "btn-1";
const SCRIPT_NAME = "Refresh Button";

const SRC = [
  "// @capability net.fetch https://api.example.com",
  "// @capability schedule",
  "function setup(shape){ shape.onClick(function(){ shape.text = 'hi'; }); }",
].join("\n");

const SRC_EDITED = [
  "// @capability net.fetch https://api.example.com",
  "// @capability schedule",
  "function setup(shape){ shape.onClick(function(){ exfiltrate(); }); }",
].join("\n");

/** The R19 ceiling the broker derives for SRC (pragmas + auto ui.html). */
const CEILING: CapabilityId[] = ["net.fetch", "schedule", "ui.html"];

/** A relaunch: every in-memory grant is gone, only localStorage survives. */
function simulateRelaunch(): void {
  resetAllGrants();
  invalidateTrustCache();
  invokeMock.mockClear();
}

/** The mount-time restore, with the authoritative pieces a real mount passes. */
async function mountRestore(
  source: string,
  ceiling: CapabilityId[] = CEILING,
  origin = "local",
): Promise<void> {
  await restoreAndSyncGrants({
    scriptId: SCRIPT_ID,
    scriptName: SCRIPT_NAME,
    source,
    origin,
    declaredCapabilities: ceiling,
  });
}

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  invokeMock.mockImplementation(async () => undefined);
  createVirtualFileMock.mockReset();
  currentPath = "C:\\Books\\Q4 Report.cala";
  inventory = [];
  resetAllGrants();
  invalidateTrustCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
describe("a grant survives a restart", () => {
  it("restores the capability into the live set AND the authoritative Rust store", async () => {
    await persistAlwaysGrant({
      scriptId: SCRIPT_ID,
      scriptName: SCRIPT_NAME,
      source: SRC,
      origin: "local",
      capability: "schedule",
    });

    simulateRelaunch();
    // A fresh process starts with nothing — that is the bug this closes.
    expect(getGrantSet(SCRIPT_ID).has("schedule")).toBe(false);

    await mountRestore(SRC);

    expect(getGrantSet(SCRIPT_ID).has("schedule")).toBe(true);
    // The Rust store is the authority; the restore goes through the SAME grant
    // command a fresh consent uses, so its allowlist still validates the id.
    expect(invokeMock).toHaveBeenCalledWith("grant_script_capability", {
      scriptId: SCRIPT_ID,
      capability: "schedule",
    });
  });

  it("restores a net.fetch grant with its EXACT origin", async () => {
    await persistAlwaysGrant({
      scriptId: SCRIPT_ID,
      scriptName: SCRIPT_NAME,
      source: SRC,
      origin: "local",
      capability: "net.fetch",
      netOrigin: "https://api.example.com",
    });

    simulateRelaunch();
    await mountRestore(SRC);

    expect(getGrantSet(SCRIPT_ID).has("net.fetch")).toBe(true);
    expect(hasFetchOrigin(SCRIPT_ID, "https://api.example.com")).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("grant_script_net_origin", {
      scriptId: SCRIPT_ID,
      origin: "https://api.example.com",
    });
  });

  it("a RESTORED scheduled job needs no prompt: the grant is live before the spec is built", async () => {
    // §7.10's caveat in one assertion. host.ts's JIT gate is
    // `if (handle.grants.has(cap)) return;` and scheduler.rs gates every firing
    // on cap_store.is_granted(scriptId, "schedule"). After a relaunch + restore
    // BOTH are already satisfied, so the restored job fires silently.
    await persistAlwaysGrant({
      scriptId: SCRIPT_ID,
      scriptName: SCRIPT_NAME,
      source: SRC,
      origin: "local",
      capability: "schedule",
    });
    simulateRelaunch();
    await mountRestore(SRC);

    expect(getGrantSet(SCRIPT_ID).has("schedule")).toBe(true);
    const mirrored = invokeMock.mock.calls.filter(
      (c) => (c as unknown[])[0] === "grant_script_capability",
    );
    expect(mirrored).toContainEqual([
      "grant_script_capability",
      { scriptId: SCRIPT_ID, capability: "schedule" },
    ]);
    // Nothing asked the user anything.
    expect(consumeLapsedGrantNotice(SCRIPT_ID)).toBeNull();
  });

  it("is stored ONLY in local user state — never inside the workbook", async () => {
    await persistAlwaysGrant({
      scriptId: SCRIPT_ID,
      scriptName: SCRIPT_NAME,
      source: SRC,
      origin: "local",
      capability: "schedule",
    });
    expect(createVirtualFileMock).not.toHaveBeenCalled();
    const raw = localStorage.getItem("calcula.scriptTrust.v1") ?? "";
    expect(raw).toContain(SCRIPT_ID);
    expect(raw).toContain("schedule");
  });

  it("an unsaved workbook cannot persist a grant (stays session-only)", async () => {
    currentPath = null;
    expect(
      await persistScriptCapabilityGrant({
        scriptId: SCRIPT_ID,
        scriptName: SCRIPT_NAME,
        source: SRC,
        capability: "schedule",
      }),
    ).toBe(false);
    expect(listWorkbookTrust()).toEqual([]);
  });
});

// ===========================================================================
describe("a source change LAPSES the grant", () => {
  beforeEach(async () => {
    await persistAlwaysGrant({
      scriptId: SCRIPT_ID,
      scriptName: SCRIPT_NAME,
      source: SRC,
      origin: "local",
      capability: "schedule",
      netOrigin: null,
    });
    simulateRelaunch();
  });

  it("restores nothing when the script was edited", async () => {
    await mountRestore(SRC_EDITED);
    expect(getGrantSet(SCRIPT_ID).has("schedule")).toBe(false);
    expect(invokeMock).not.toHaveBeenCalledWith("grant_script_capability", {
      scriptId: SCRIPT_ID,
      capability: "schedule",
    });
  });

  it("DELETES the stored grant so it can never be revived by reverting the edit", async () => {
    await mountRestore(SRC_EDITED);
    expect(await getScriptCapabilityGrant(SCRIPT_ID)).toBeNull();
    // Even re-mounting the ORIGINAL source restores nothing now.
    await mountRestore(SRC);
    expect(getGrantSet(SCRIPT_ID).has("schedule")).toBe(false);
  });

  it("arms a DIFF that the next prompt must show before asking again", async () => {
    await mountRestore(SRC_EDITED);
    const notice = consumeLapsedGrantNotice(SCRIPT_ID);
    expect(notice).toBeTruthy();
    expect(notice).toContain(SCRIPT_NAME);
    expect(notice).toContain("has CHANGED");
    expect(notice).toContain("schedule");
    // The diff names the line that actually changed, both sides.
    expect(notice).toContain("exfiltrate()");
    expect(notice).toContain("shape.text = 'hi'");
    // Consumed once — it is a notice, not a decision.
    expect(consumeLapsedGrantNotice(SCRIPT_ID)).toBeNull();
  });

  it("the JIT prompt shows the diff first, and declining it denies", async () => {
    await mountRestore(SRC_EDITED);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    const decision = await requestCapabilityGrant({
      scriptId: SCRIPT_ID,
      scriptName: SCRIPT_NAME,
      capability: "schedule",
      origin: null,
    });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toContain("has CHANGED");
    expect(decision).toBe("deny");
  });

  it("acknowledging the diff continues to the normal grant dialog", async () => {
    await mountRestore(SRC_EDITED);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const emitted: unknown[] = [];
    const listener = (e: Event): void => {
      emitted.push((e as CustomEvent).detail);
      const detail = (e as CustomEvent).detail as { requestId: string };
      resolveCapabilityRequest(detail.requestId, "once");
    };
    window.addEventListener("scriptable-objects:capability-request", listener);
    try {
      const decision = await requestCapabilityGrant({
        scriptId: SCRIPT_ID,
        scriptName: SCRIPT_NAME,
        capability: "schedule",
        origin: null,
      });
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(emitted).toHaveLength(1);
      expect(decision).toBe("once");
    } finally {
      window.removeEventListener("scriptable-objects:capability-request", listener);
    }
  });
});

// ===========================================================================
describe("escalation always re-prompts", () => {
  it("only the EXACT capabilities that were approved come back", async () => {
    await persistAlwaysGrant({
      scriptId: SCRIPT_ID,
      scriptName: SCRIPT_NAME,
      source: SRC,
      origin: "local",
      capability: "schedule",
    });
    simulateRelaunch();
    await mountRestore(SRC, ["net.fetch", "schedule", "bi.query", "ui.html"]);

    expect(getGrantSet(SCRIPT_ID).has("schedule")).toBe(true);
    // Never approved -> not in the grant set -> the broker denies and the JIT
    // prompt fires. Persisting one capability cannot smuggle in a sibling.
    expect(getGrantSet(SCRIPT_ID).has("bi.query")).toBe(false);
    expect(getGrantSet(SCRIPT_ID).has("net.fetch")).toBe(false);
  });

  it("a net.fetch grant does NOT carry over to another origin", async () => {
    await persistAlwaysGrant({
      scriptId: SCRIPT_ID,
      scriptName: SCRIPT_NAME,
      source: SRC,
      origin: "local",
      capability: "net.fetch",
      netOrigin: "https://api.example.com",
    });
    simulateRelaunch();
    await mountRestore(SRC);

    expect(hasFetchOrigin(SCRIPT_ID, "https://api.example.com")).toBe(true);
    expect(hasFetchOrigin(SCRIPT_ID, "https://evil.example.net")).toBe(false);
  });

  it("never restores above the script's DECLARED ceiling", async () => {
    await persistAlwaysGrant({
      scriptId: SCRIPT_ID,
      scriptName: SCRIPT_NAME,
      source: SRC,
      origin: "local",
      capability: "schedule",
    });
    simulateRelaunch();
    // The mount reports a ceiling without `schedule` (e.g. the pragma is gone
    // in a build where the hash still matched): the grant must not float free.
    await mountRestore(SRC, ["ui.html"]);
    expect(getGrantSet(SCRIPT_ID).has("schedule")).toBe(false);
  });
});

// ===========================================================================
describe("run-trust is NOT a capability grant", () => {
  it("trusting the workbook restores nothing", async () => {
    inventory = [
      { surfaceId: "object-script", id: SCRIPT_ID, name: SCRIPT_NAME, source: SRC, provenance: "local" },
    ];
    expect(await trustCurrentWorkbook()).toBe(true);
    // The workbook is trusted to RUN its code...
    expect(listWorkbookTrust()[0].runTrust).not.toBeNull();
    // ...and holds zero capability grants.
    expect(listWorkbookTrust()[0].scriptGrants).toEqual([]);
    expect(await countPersistedScriptGrants()).toBe(0);

    simulateRelaunch();
    await mountRestore(SRC);
    expect(getScriptGrants(SCRIPT_ID).caps).toEqual([]);
    expect(invokeMock).not.toHaveBeenCalledWith("grant_script_capability", expect.anything());
  });

  it("the two decisions are independent: revoking one leaves the other", async () => {
    inventory = [
      { surfaceId: "object-script", id: SCRIPT_ID, name: SCRIPT_NAME, source: SRC, provenance: "local" },
    ];
    await trustCurrentWorkbook();
    await persistAlwaysGrant({
      scriptId: SCRIPT_ID,
      scriptName: SCRIPT_NAME,
      source: SRC,
      origin: "local",
      capability: "schedule",
    });

    await revokeScriptCapabilityGrants(KEY, SCRIPT_ID);
    expect(listWorkbookTrust()[0].runTrust).not.toBeNull();
    expect(listWorkbookTrust()[0].scriptGrants).toEqual([]);
  });
});

// ===========================================================================
describe("distributed code keeps its own consent path", () => {
  it("a distributed script never persists a grant here", async () => {
    await persistAlwaysGrant({
      scriptId: "pkg-script",
      scriptName: "Vendor Script",
      source: SRC,
      origin: "Acme Reports", // handle.origin = the package name
      capability: "schedule",
    });
    expect(listWorkbookTrust()).toEqual([]);
  });

  it("a distributed mount never RESTORES from here, even if a record exists", async () => {
    await persistAlwaysGrant({
      scriptId: SCRIPT_ID,
      scriptName: SCRIPT_NAME,
      source: SRC,
      origin: "local",
      capability: "schedule",
    });
    simulateRelaunch();
    await mountRestore(SRC, CEILING, "Acme Reports");
    expect(getGrantSet(SCRIPT_ID).has("schedule")).toBe(false);
  });
});

// ===========================================================================
describe("revoke", () => {
  beforeEach(async () => {
    await persistAlwaysGrant({
      scriptId: SCRIPT_ID,
      scriptName: SCRIPT_NAME,
      source: SRC,
      origin: "local",
      capability: "schedule",
    });
    await persistAlwaysGrant({
      scriptId: SCRIPT_ID,
      scriptName: SCRIPT_NAME,
      source: SRC,
      origin: "local",
      capability: "net.fetch",
      netOrigin: "https://api.example.com",
    });
    simulateRelaunch();
    await mountRestore(SRC);
    invokeMock.mockClear();
  });

  it("per capability: drops the persisted decision and the live grant, keeps the sibling", async () => {
    await revokeScriptCapability(KEY, SCRIPT_ID, "net.fetch");

    const grant = await getScriptCapabilityGrant(SCRIPT_ID);
    expect(grant?.capabilities).toEqual(["schedule"]);
    expect(grant?.netOrigins).toEqual([]);
    // Live grant is gone NOW (revoked means stop, not "stop next launch")...
    expect(getGrantSet(SCRIPT_ID).has("net.fetch")).toBe(false);
    expect(hasFetchOrigin(SCRIPT_ID, "https://api.example.com")).toBe(false);
    // ...and the sibling capability survives, in memory and in Rust.
    expect(getGrantSet(SCRIPT_ID).has("schedule")).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("revoke_script_capabilities", {
      scriptId: SCRIPT_ID,
    });
    expect(invokeMock).toHaveBeenCalledWith("grant_script_capability", {
      scriptId: SCRIPT_ID,
      capability: "schedule",
    });
  });

  it("per script: forgets every capability and nothing returns after a restart", async () => {
    await revokeScriptCapabilityGrants(KEY, SCRIPT_ID);
    expect(await getScriptCapabilityGrant(SCRIPT_ID)).toBeNull();

    simulateRelaunch();
    await mountRestore(SRC);
    expect(getScriptGrants(SCRIPT_ID).caps).toEqual([]);
  });

  it("forgetting the workbook forgets its script grants too", async () => {
    revokeWorkbookTrustEntirely(KEY);
    expect(listWorkbookTrust()).toEqual([]);
    simulateRelaunch();
    await mountRestore(SRC);
    expect(getScriptGrants(SCRIPT_ID).caps).toEqual([]);
  });

  it("clear-all wipes script grants", async () => {
    revokeAllWorkbookTrust();
    expect(listWorkbookTrust()).toEqual([]);
    expect(await countPersistedScriptGrants()).toBe(0);
  });
});

// ===========================================================================
describe("store robustness", () => {
  it("a script grant with no source hash is dropped at read time (fails CLOSED)", async () => {
    localStorage.setItem(
      "calcula.scriptTrust.v1",
      JSON.stringify({
        version: 1,
        records: [
          {
            workbookKey: KEY,
            displayPath: KEY,
            runTrust: null,
            notebookGrants: [],
            scriptGrants: [{ scriptId: SCRIPT_ID, capabilities: ["schedule"] }],
          },
        ],
      }),
    );
    invalidateTrustCache();
    // The unusable entry is discarded at READ time — it can never be matched
    // against live code, so it must never be offered to a mount.
    expect(listWorkbookTrust()[0].scriptGrants).toEqual([]);
    await mountRestore(SRC);
    expect(getGrantSet(SCRIPT_ID).has("schedule")).toBe(false);
  });

  it("re-approving after an edit REPLACES the old grant instead of merging", async () => {
    await persistAlwaysGrant({
      scriptId: SCRIPT_ID,
      scriptName: SCRIPT_NAME,
      source: SRC,
      origin: "local",
      capability: "net.fetch",
      netOrigin: "https://api.example.com",
    });
    // The script is edited and the user approves a DIFFERENT capability.
    await persistAlwaysGrant({
      scriptId: SCRIPT_ID,
      scriptName: SCRIPT_NAME,
      source: SRC_EDITED,
      origin: "local",
      capability: "schedule",
    });
    const grant = await getScriptCapabilityGrant(SCRIPT_ID);
    expect(grant?.capabilities).toEqual(["schedule"]);
    expect(grant?.netOrigins).toEqual([]);
  });

  it("restorePersistedScriptCapabilityGrant answers empty for an unknown script", async () => {
    const restored = await restorePersistedScriptCapabilityGrant({
      scriptId: "nope",
      source: SRC,
      declaredCapabilities: CEILING,
    });
    expect(restored).toEqual({ capabilities: [], netOrigins: [], lapseNotice: null });
  });
});

// ---------------------------------------------------------------------------
// Tampered local storage (Wave F integration review)
// ---------------------------------------------------------------------------
//
// localStorage is host state on the user's own machine, so writing to it is not
// a remote attack — but "the store is trusted because it is local" is exactly
// the assumption that turns one bug elsewhere (a stray write, a shared profile,
// a synced roaming directory) into a capability grant. The store is untrusted
// input on read, and these pin that it is treated as such.

describe("persisted grants: the trust store is untrusted input", () => {
  const write = (record: unknown): void => {
    localStorage.setItem(
      "calcula.scriptTrust.v1",
      JSON.stringify({ version: 1, records: [record] }),
    );
    invalidateTrustCache();
  };

  it("an INVENTED capability id in storage never reaches the grant flow", async () => {
    write({
      workbookKey: KEY,
      displayPath: "C:/Books/Q4 Report.cala",
      runTrust: null,
      notebookGrants: [],
      scriptGrants: [
        {
          scriptId: SCRIPT_ID,
          scriptName: SCRIPT_NAME,
          // The hash of SRC is unknown to the attacker here; use the real one so
          // the test exercises the CAPABILITY filter rather than the hash gate.
          sourceHash: await (
            await import("../distributedConsent")
          ).sha256Hex(SRC),
          source: SRC,
          capabilities: ["net.fetch", "machine.pwn", "fs.write", 42, null],
          netOrigins: ["https://api.example.com"],
          grantedAt: new Date().toISOString(),
        },
      ],
    });
    const grant = await getScriptCapabilityGrant(SCRIPT_ID);
    // Dropped at READ time, before anything downstream can see them.
    expect(grant?.capabilities).toEqual(["net.fetch"]);

    const restored = await restorePersistedScriptCapabilityGrant({
      scriptId: SCRIPT_ID,
      source: SRC,
      declaredCapabilities: CEILING,
    });
    expect(restored.capabilities).toEqual(["net.fetch"]);
  });

  it("an invented capability id in a NOTEBOOK grant never reaches grant_script_capability", async () => {
    write({
      workbookKey: KEY,
      displayPath: "C:/Books/Q4 Report.cala",
      runTrust: null,
      notebookGrants: [{ notebookId: "nb-1", capabilities: ["bi.query", "machine.pwn"] }],
      scriptGrants: [],
    });
    const { rehydrateNotebookCapabilityGrants } = await import("../scriptSecurity");
    invokeMock.mockClear();
    await rehydrateNotebookCapabilityGrants();
    const granted = invokeMock.mock.calls
      .filter((c) => c[0] === "grant_script_capability")
      .map((c) => (c[1] as { capability: string }).capability);
    // The notebook path has NO declared ceiling in front of it — this filter is
    // the only thing between tampered storage and the backend grant command.
    expect(granted).toEqual(["bi.query"]);
  });

  it("a grant record with no sourceHash is dropped rather than matching anything", async () => {
    write({
      workbookKey: KEY,
      displayPath: "C:/Books/Q4 Report.cala",
      runTrust: null,
      notebookGrants: [],
      scriptGrants: [
        {
          scriptId: SCRIPT_ID,
          scriptName: SCRIPT_NAME,
          capabilities: ["net.fetch"],
          netOrigins: ["https://evil.example"],
          grantedAt: new Date().toISOString(),
        },
      ],
    });
    expect(await getScriptCapabilityGrant(SCRIPT_ID)).toBeNull();
    const restored = await restorePersistedScriptCapabilityGrant({
      scriptId: SCRIPT_ID,
      source: SRC,
      declaredCapabilities: CEILING,
    });
    expect(restored).toEqual({ capabilities: [], netOrigins: [], lapseNotice: null });
  });
});
