//! FILENAME: app/src/api/__tests__/objectScriptRunner.test.ts
// PURPOSE: `runObjectScriptOnce` is a real, complete execution: the mount is
//          awaited, the realm is always torn down, failures reach the caller,
//          and a killed run cannot leave an undo transaction open.
// CONTEXT: This primitive exists because the object-script vocabulary
//          (`context.api`) had no execution path that did not require owning an
//          on-grid object — which is why "Run" in the macro library could not be
//          implemented and was disabled instead. Everything the macro library
//          promises now rests on the properties pinned here.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ExplicitRunEnd } from "../scriptHost/host";

const hostMountScript = vi.fn(async (_d: unknown) => undefined);
const hostUnmountScript = vi.fn((_id: string) => undefined);
/**
 * How a run with cell access ENDED (owner decision B, follow-up F9), as the host
 * answers it once the realm is gone: null for every other run.
 */
const hostSettleExplicitRun = vi.fn(async (_id: string): Promise<ExplicitRunEnd | null> => null);
const mountedIds = new Set<string>();
const workerAvailable = { value: true };

vi.mock("../scriptHost/host", () => ({
  hostMountScript: (d: unknown) => hostMountScript(d),
  hostUnmountScript: (id: string) => {
    mountedIds.delete(id);
    return hostUnmountScript(id);
  },
  hostIsMounted: (id: string) => mountedIds.has(id),
  workerRealmAvailable: () => workerAvailable.value,
  hostCloseBatchLeftOpen: (id: string) => hostCloseBatchLeftOpen(id),
  hostSettleExplicitRun: (id: string) => hostSettleExplicitRun(id),
}));

/**
 * The backend's one transaction slot, and WHO opened it: `ownBatch` is true
 * only while the RUN's script holds a batch its own beginBatch opened -- what
 * the host records from the begin's answer. A transaction a user's gesture
 * opens is `open` without being the run's.
 */
const undo = { open: false, ownBatch: false };
const cancelUndoTransaction = vi.fn(async () => {
  undo.open = false;
  undo.ownBatch = false;
});
/** The script's api.beginBatch, as the host answers it. */
function scriptBeginsBatch(): void {
  if (!undo.open) {
    undo.open = true;
    undo.ownBatch = true;
  }
}
/** The host's close of the run's OWN batch (cancelled; see host.ts). */
const hostCloseBatchLeftOpen = vi.fn(async (_id: string) => {
  if (!undo.ownBatch) return false;
  await cancelUndoTransaction();
  return true;
});

vi.mock("../lib", () => ({
  getUndoState: async () => ({ transactionOpen: undo.open }),
  cancelUndoTransaction: () => cancelUndoTransaction(),
}));

/**
 * The workbook's MODULE STORE — the ONLY authority on whose code a run is about
 * to execute. `core/calp/src/pull.rs` stamps `source_package` on every module a
 * `.calp` ships and `materialize_distributed_scripts` writes it into this map,
 * so a record carrying one is a publisher's.
 *
 * Doubled as the backend really behaves: `list_scripts` returns id+name only and
 * `get_script` fetches one full record — and `get_script` can FAIL for a module
 * the listing showed, which is the case the resolver has to refuse rather than
 * read as "not a package".
 */
interface StoredRecord {
  id: string;
  name: string;
  description: string | null;
  source: string;
  sourcePackage: string | null;
}
const moduleStore: StoredRecord[] = [];
/** Module ids that are LISTED but whose full record will not load. */
const unreadable = new Map<string, string>();

const listWorkbookScripts = vi.fn(async () =>
  moduleStore.map((r) => ({ id: r.id, name: r.name })),
);
const getWorkbookScript = vi.fn(async (id: string) => {
  const failure = unreadable.get(id);
  if (failure) throw new Error(failure);
  const record = moduleStore.find((r) => r.id === id);
  if (!record) throw new Error(`Script '${id}' not found`);
  return record;
});

vi.mock("../workbookScripts", () => ({
  listWorkbookScripts: () => listWorkbookScripts(),
  getWorkbookScript: (id: string) => getWorkbookScript(id),
}));

/**
 * The backend door — present only so the modules this file pulls in transitively
 * have one, and so the tests below can assert what it was NEVER asked.
 *
 * THE CONSENT GATE IS NOT CALLED FROM HERE ANY MORE. Round 3 taught this runner
 * to call `check_distributed_module_consent` itself; round 4 found the door that
 * copy did not cover (`hostStartModuleScriptDebugSession` — the Object Script
 * Editor's Run and Debug). The requirement now lives at the boundary where a
 * realm is created, `hostMountScript`, which will not mount a distributed
 * definition for an application the user has not approved. This file's job is
 * the half that boundary cannot do: deciding whose artifact a loose source
 * string IS.
 */
const invokeBackend = vi.fn(async (_cmd: string, _args?: unknown) => undefined);

vi.mock("../backend", () => ({
  invokeBackend: (cmd: string, args?: unknown) => invokeBackend(cmd, args),
}));

function storeModule(record: Partial<StoredRecord> & { id: string; source: string }): void {
  moduleStore.push({
    name: record.id,
    description: null,
    sourcePackage: null,
    ...record,
  });
}

/** A module that the listing shows but `get_script` refuses to hand over. */
function storeUnreadableModule(id: string, why = "the module could not be decoded"): void {
  storeModule({ id, source: "" });
  unreadable.set(id, why);
}

import { runObjectScriptOnce } from "../objectScriptRunner";
import { claimExplicitMacroRun, mintExplicitMacroRun } from "../explicitMacroRun";

/** The mount definition the last run handed the host. */
function lastMount(): Record<string, unknown> {
  return hostMountScript.mock.calls[hostMountScript.mock.calls.length - 1][0] as Record<
    string,
    unknown
  >;
}

beforeEach(() => {
  hostMountScript.mockReset().mockResolvedValue(undefined);
  hostUnmountScript.mockReset();
  hostSettleExplicitRun.mockReset().mockResolvedValue(null);
  cancelUndoTransaction.mockClear();
  hostCloseBatchLeftOpen.mockClear();
  moduleStore.length = 0;
  unreadable.clear();
  listWorkbookScripts.mockClear();
  getWorkbookScript.mockClear();
  mountedIds.clear();
  undo.open = false;
  undo.ownBatch = false;
  workerAvailable.value = true;
  invokeBackend.mockClear();
});

describe("runObjectScriptOnce", () => {
  it("mounts the source as an unlocked workbook script by default", async () => {
    await runObjectScriptOnce({ name: "Macro1426", source: "function setup(c){}" });

    expect(hostMountScript).toHaveBeenCalledTimes(1);
    const spec = hostMountScript.mock.calls[0][0] as Record<string, unknown>;
    expect(spec).toMatchObject({
      name: "Macro1426",
      source: "function setup(c){}",
      objectType: "workbook",
      instanceId: null,
      accessLevel: "unlocked",
      provenance: "local",
    });
    // The id is unique per run and cannot collide with a user's own script.
    expect(String(spec.id)).toMatch(/^__calcula_run-once_/);
  });

  it("carries the source's @capability pragmas as the R19 ceiling", async () => {
    // A recorded model macro declares `// @capability bi.model`. Without this
    // in the mount definition the run-once ceiling was EMPTY, so the JIT
    // consent prompt was suppressed and the broker denied the gateway call —
    // the macro could record model edits it could never replay.
    await runObjectScriptOnce({
      name: "Model macro",
      source: "// @capability bi.model\nfunction setup(c){}",
    });
    const spec = hostMountScript.mock.calls[0][0] as { declaredCapabilities?: string[] };
    expect(spec.declaredCapabilities).toEqual(["bi.model"]);
  });

  it("a pragma-free source declares nothing (empty ceiling, no prompts)", async () => {
    await runObjectScriptOnce({ name: "Plain", source: "function setup(c){}" });
    const spec = hostMountScript.mock.calls[0][0] as { declaredCapabilities?: string[] };
    expect(spec.declaredCapabilities).toEqual([]);
  });

  it("gives every run a distinct id", async () => {
    await runObjectScriptOnce({ name: "A", source: "" });
    await runObjectScriptOnce({ name: "A", source: "" });
    const first = (hostMountScript.mock.calls[0][0] as { id: string }).id;
    const second = (hostMountScript.mock.calls[1][0] as { id: string }).id;
    expect(first).not.toBe(second);
  });

  it("tears the realm down after a successful run", async () => {
    hostMountScript.mockImplementation(async (d) => {
      mountedIds.add((d as { id: string }).id);
    });
    await runObjectScriptOnce({ name: "A", source: "" });
    expect(hostUnmountScript).toHaveBeenCalledTimes(1);
    expect(mountedIds.size).toBe(0);
  });

  it("propagates the script's own error — a run that failed is not a success", async () => {
    hostMountScript.mockRejectedValueOnce(new Error("ReferenceError: api is not defined"));
    await expect(
      runObjectScriptOnce({ name: "A", source: "" }),
    ).rejects.toThrow(/api is not defined/);
  });

  it("translates the mount deadline into language a Run user can act on", async () => {
    hostMountScript.mockRejectedValueOnce(new Error("Script mount timed out (10s)"));
    await expect(
      runObjectScriptOnce({ name: "Macro1426", source: "" }),
    ).rejects.toThrow(/still running after 10 seconds/);
  });

  it("refuses clearly when there is no worker realm at all", async () => {
    workerAvailable.value = false;
    await expect(runObjectScriptOnce({ name: "A", source: "" })).rejects.toThrow(
      /worker realm/i,
    );
    expect(hostMountScript).not.toHaveBeenCalled();
  });

  it("closes an undo transaction the run left open", async () => {
    // A recorded macro opens one in beginBatch. Killed before commitBatch, the
    // open group would swallow every later edit the user makes and quietly
    // break their Ctrl+Z.
    hostMountScript.mockImplementationOnce(async () => {
      scriptBeginsBatch();
      throw new Error("Script mount timed out (10s)");
    });

    await expect(runObjectScriptOnce({ name: "A", source: "" })).rejects.toThrow();
    expect(cancelUndoTransaction).toHaveBeenCalledTimes(1);
    expect(undo.open).toBe(false);
  });

  it("leaves a transaction that was ALREADY open alone", async () => {
    undo.open = true;
    await runObjectScriptOnce({ name: "A", source: "" });
    expect(cancelUndoTransaction).not.toHaveBeenCalled();
    expect(undo.open).toBe(true);
  });

  it("does not cancel anything when the run closed its own transaction", async () => {
    hostMountScript.mockImplementationOnce(async () => {
      scriptBeginsBatch(); // beginBatch
      undo.open = false; // commitBatch
      undo.ownBatch = false;
    });
    await runObjectScriptOnce({ name: "A", source: "" });
    expect(cancelUndoTransaction).not.toHaveBeenCalled();
  });

  it("leaves a transaction ANOTHER caller opened while the run was going alone (X6)", async () => {
    // A user's gesture (or another script) opened the slot during the run;
    // the run's own script never began a batch. Cancelling it would strip the
    // opener's writes of their undo step.
    hostMountScript.mockImplementationOnce(async () => {
      undo.open = true;
    });
    await runObjectScriptOnce({ name: "A", source: "" });
    expect(cancelUndoTransaction, "the run cancelled a transaction it did not open").not.toHaveBeenCalled();
    expect(undo.open).toBe(true);
  });

  it("closes the run's batch BEFORE the realm is unmounted, and asks for the run's own id", async () => {
    const order: string[] = [];
    hostMountScript.mockImplementationOnce(async (d: unknown) => {
      mountedIds.add(String((d as { id: string }).id));
      scriptBeginsBatch();
    });
    hostCloseBatchLeftOpen.mockImplementationOnce(async () => {
      order.push("close");
      await cancelUndoTransaction();
      return true;
    });
    hostUnmountScript.mockImplementationOnce(() => {
      order.push("unmount");
    });
    await runObjectScriptOnce({ name: "A", source: "" });
    expect(order).toEqual(["close", "unmount"]);
    expect(hostCloseBatchLeftOpen).toHaveBeenCalledWith(String(lastMount().id));
  });
});

// ============================================================================
// PROVENANCE IS DERIVED FROM THE ARTIFACT, NEVER ASSERTED BY THE CALLER.
//
// A `.calp` may ship module scripts. `core/calp/src/pull.rs` materializes them
// into the subscriber's workbook stamped with `source_package`, on the stated
// promise that they "run only on explicit user action, sandboxed". This runner
// USED to hard-code `provenance: "local"` and default the tier to `"unlocked"`,
// so pressing Run on a publisher's macro executed it at the TOP tier under the
// user's own identity — which also routes its capability requests to the local
// just-in-time prompt instead of application consent.
// ============================================================================

const PUBLISHER_SOURCE = "function setup(c){ return c.api.setCellValue(0,0,'owned'); }";

describe("a module that arrived in an application", () => {
  it("runs RESTRICTED, not unlocked, even with no tier requested", async () => {
    storeModule({
      id: "macro-quarter-close",
      source: PUBLISHER_SOURCE,
      sourcePackage: "Acme Finance Pack",
    });

    await runObjectScriptOnce({
      name: "Quarter close",
      source: PUBLISHER_SOURCE,
      scriptId: "macro-quarter-close",
    });

    expect(lastMount().accessLevel).toBe("restricted");
  });

  it("mounts under a PACKAGE provenance, so it is not same-origin with the user's code", async () => {
    storeModule({
      id: "macro-quarter-close",
      source: PUBLISHER_SOURCE,
      sourcePackage: "Acme Finance Pack",
    });

    await runObjectScriptOnce({
      name: "Quarter close",
      source: PUBLISHER_SOURCE,
      scriptId: "macro-quarter-close",
    });

    const spec = lastMount();
    expect(spec.provenance).toBe("distributed");
    expect(spec.packageName).toBe("Acme Finance Pack");
  });

  it("REFUSES a caller that explicitly claims the unlocked tier for it", async () => {
    storeModule({
      id: "macro-quarter-close",
      source: PUBLISHER_SOURCE,
      sourcePackage: "Acme Finance Pack",
    });

    await expect(
      runObjectScriptOnce({
        name: "Quarter close",
        source: PUBLISHER_SOURCE,
        scriptId: "macro-quarter-close",
        accessLevel: "unlocked",
      }),
    ).rejects.toThrow(/Acme Finance Pack[\s\S]*unlocked tier/);
    // Nothing was mounted: the refusal happens before any realm is spawned.
    expect(hostMountScript).not.toHaveBeenCalled();
  });

  it("is still distributed when the caller omits the id — the SOURCE gives it away", async () => {
    storeModule({
      id: "macro-quarter-close",
      source: PUBLISHER_SOURCE,
      sourcePackage: "Acme Finance Pack",
    });

    await runObjectScriptOnce({ name: "Quarter close", source: PUBLISHER_SOURCE });

    expect(lastMount().accessLevel).toBe("restricted");
    expect(lastMount().provenance).toBe("distributed");
  });

  it("is still distributed when the SOURCE was edited — the id gives it away", async () => {
    // The macro library's Run sends the textarea's current text. Editing a
    // publisher's macro does not make it yours; the stored record still says
    // whose it is.
    storeModule({
      id: "macro-quarter-close",
      source: PUBLISHER_SOURCE,
      sourcePackage: "Acme Finance Pack",
    });

    await runObjectScriptOnce({
      name: "Quarter close",
      source: `${PUBLISHER_SOURCE}\n// edited by the subscriber`,
      scriptId: "macro-quarter-close",
    });

    expect(lastMount().accessLevel).toBe("restricted");
    expect(lastMount().provenance).toBe("distributed");
  });

  it("names the publisher as a package even when the stamp is blank", async () => {
    storeModule({ id: "m", source: PUBLISHER_SOURCE, sourcePackage: "   " });
    await runObjectScriptOnce({ name: "m", source: PUBLISHER_SOURCE, scriptId: "m" });
    // A whitespace-only stamp is a stamp with no usable name, not an absent one:
    // Rust's `distributed_module_refusal` reads the same `Option<String>` and
    // holds any `Some(..)` to be a publisher's code. This test used to assert
    // the opposite — UNLOCKED and LOCAL for a record the backend gate treats as
    // distributed — which is exactly the tier a publisher must never be handed
    // by leaving a field blank.
    expect(lastMount().accessLevel).toBe("restricted");
    expect(lastMount().provenance).toBe("distributed");
    expect(lastMount().packageName).toBe("(unknown package)");
  });
});

// ============================================================================
// CONSENT — NOT THE SAME THING AS THE TIER, AND NOT THIS FILE'S DECISION.
//
// A stored module has TWO run routes and the route is chosen by the module's
// DESCRIPTION, which a `.calp` ships with the module: publisher content
// (`macroRunRoute`, app/extensions/MacroRecorder/lib/macroLibrary.ts).
//
//   runtime=notebook / unmarked -> run_script, which calls
//                                  require_distributed_module_consent and
//                                  refuses an unapproved application's code;
//   runtime=objectScript        -> HERE, which derived the package origin and
//                                  the restricted tier correctly and then asked
//                                  for consent NOWHERE.
//
// The tier bounds what the code can REACH; consent is agreeing to run it AT
// ALL. A sandbox around code nobody said yes to is not the same protection.
//
// ROUND 3 FIXED THAT BY CALLING THE GATE FROM HERE. ROUND 4 FOUND THE NEXT DOOR
// (`hostStartModuleScriptDebugSession` — the editor's Run and Debug), because a
// per-caller fix only ever covers the callers someone remembered. The gate now
// lives at the boundary where a realm is CREATED, so what this file must get
// right is the ORIGIN it hands that boundary — and what it must NOT do is keep a
// second copy of the decision. The gate's own behaviour is pinned in
// app/src/api/scriptHost/__tests__/distributedMountConsent.test.ts.
// ============================================================================

describe("the distributed-consent gate belongs to the mount, not to this runner", () => {
  function storePublisherModule(): void {
    storeModule({
      id: "macro-quarter-close",
      source: PUBLISHER_SOURCE,
      sourcePackage: "Acme Finance Pack",
    });
  }

  it("hands the boundary a definition it will gate: publisher provenance, exact source", async () => {
    // This is the whole contribution. `hostMountScript` reads `provenance` to
    // decide whether to ask about an application at all, and asks with the
    // source it is about to run — so a run that resolves to a package origin is
    // gated BECAUSE of what this function derived.
    storePublisherModule();

    await runObjectScriptOnce({
      name: "Quarter close",
      source: PUBLISHER_SOURCE,
      scriptId: "macro-quarter-close",
    });

    expect(lastMount().provenance).toBe("distributed");
    expect(lastMount().packageName).toBe("Acme Finance Pack");
    expect(lastMount().source).toBe(PUBLISHER_SOURCE);
    expect(lastMount().accessLevel).toBe("restricted");
  });

  // Phase 3 of BUG-0257: the button a click claims reaches the mount gate,
  // which verifies it against the backend's store and names it on the audit
  // row. No trigger, no field -- a run nobody clicked a button for.
  //
  // SABOTAGE: drop `consentTrigger: options.trigger` from the hostMountScript
  // call in runObjectScriptOnce (src/api/objectScriptRunner.ts).
  it("hands the boundary the button a click claims, and nothing when none did", async () => {
    storePublisherModule();
    const trigger = { kind: "buttonControl" as const, sheetIndex: 1, row: 3, col: 2 };

    await runObjectScriptOnce({
      name: "Quarter close",
      source: PUBLISHER_SOURCE,
      scriptId: "macro-quarter-close",
      trigger,
    });
    expect(lastMount().consentTrigger).toEqual(trigger);

    await runObjectScriptOnce({
      name: "Quarter close",
      source: PUBLISHER_SOURCE,
      scriptId: "macro-quarter-close",
    });
    expect(lastMount().consentTrigger).toBeUndefined();
  });

  it("keeps NO second copy of the gate — one decision, one place", async () => {
    // Two copies of a consent decision is precisely how the two run routes came
    // to differ. If this call reappears here, it will drift from the boundary's.
    storePublisherModule();

    await runObjectScriptOnce({
      name: "Quarter close",
      source: PUBLISHER_SOURCE,
      scriptId: "macro-quarter-close",
    });

    expect(invokeBackend).not.toHaveBeenCalledWith(
      "check_distributed_module_consent",
      expect.anything(),
    );
    // ...nor the mount gate that replaced it on the boundary's side. The runner
    // derives the ORIGIN; the boundary decides consent. Two copies of that
    // decision is how the run routes came to differ in the first place.
    expect(invokeBackend).not.toHaveBeenCalledWith(
      "check_distributed_mount_consent",
      expect.anything(),
    );
  });

  it("surfaces the boundary's refusal unchanged, and leaves nothing behind", async () => {
    // The mount is what refuses now, so what this run must do is not swallow it,
    // not relabel it as a timeout, and not leave an undo transaction or a realm
    // behind on the way out.
    storePublisherModule();
    hostMountScript.mockRejectedValueOnce(
      new Error(
        "DISTRIBUTED_SCRIPT_NOT_CONSENTED: 'macro-quarter-close' arrived in the package " +
          "'Acme Finance Pack' and you have not approved that package's code, so it will not run.",
      ),
    );

    await expect(
      runObjectScriptOnce({
        name: "Quarter close",
        source: PUBLISHER_SOURCE,
        scriptId: "macro-quarter-close",
      }),
    ).rejects.toThrow(/DISTRIBUTED_SCRIPT_NOT_CONSENTED[\s\S]*Acme Finance Pack/);

    expect(hostUnmountScript).not.toHaveBeenCalled();
    expect(mountedIds.size).toBe(0);
  });

  it("surfaces an unreachable-gate refusal from the boundary too", async () => {
    storePublisherModule();
    hostMountScript.mockRejectedValueOnce(
      new Error(
        '"Quarter close" was not mounted: it arrived inside the application ' +
          '"Acme Finance Pack", and whether you have approved that application\'s code ' +
          "could not be established. IPC channel closed",
      ),
    );

    await expect(
      runObjectScriptOnce({
        name: "Quarter close",
        source: PUBLISHER_SOURCE,
        scriptId: "macro-quarter-close",
      }),
    ).rejects.toThrow(/could not be established[\s\S]*IPC channel closed/);
  });

  it("a local copy of the publisher's source mounts as LOCAL, so nothing is asked", async () => {
    // The documented way to adapt distributed content: the copy is the user's
    // own record, so the origin is local, the mount carries no package, and the
    // boundary has nothing to ask about — the same escape hatch
    // `distributed_module_refusal` keeps open in Rust.
    storeModule({ id: "theirs", source: PUBLISHER_SOURCE, sourcePackage: "Acme Finance Pack" });
    storeModule({ id: "mine", source: PUBLISHER_SOURCE, sourcePackage: null });

    await runObjectScriptOnce({ name: "Mine", source: PUBLISHER_SOURCE });

    expect(hostMountScript).toHaveBeenCalledTimes(1);
    expect(lastMount().provenance).toBe("local");
    expect(lastMount().packageName).toBeUndefined();
  });
});

describe("a module the user wrote", () => {
  it("keeps the unlocked tier and local provenance", async () => {
    storeModule({ id: "macro-mine", source: PUBLISHER_SOURCE, sourcePackage: null });

    await runObjectScriptOnce({
      name: "Mine",
      source: PUBLISHER_SOURCE,
      scriptId: "macro-mine",
      accessLevel: "unlocked",
    });

    expect(lastMount().accessLevel).toBe("unlocked");
    expect(lastMount().provenance).toBe("local");
  });

  it("a LOCAL copy of a distributed module's source authorises it as local", async () => {
    // The documented way to adapt distributed content, and the same escape
    // hatch `distributed_module_refusal` keeps open in Rust.
    storeModule({ id: "theirs", source: PUBLISHER_SOURCE, sourcePackage: "Acme" });
    storeModule({ id: "mine", source: PUBLISHER_SOURCE, sourcePackage: null });

    await runObjectScriptOnce({
      name: "Mine",
      source: PUBLISHER_SOURCE,
      accessLevel: "unlocked",
    });

    expect(lastMount().accessLevel).toBe("unlocked");
    expect(lastMount().provenance).toBe("local");
  });
});

describe("when provenance cannot be established", () => {
  it("refuses the run rather than assuming it is the user's own", async () => {
    listWorkbookScripts.mockRejectedValueOnce(new Error("no backend"));

    await expect(
      runObjectScriptOnce({ name: "A", source: PUBLISHER_SOURCE }),
    ).rejects.toThrow(/could not be read[\s\S]*yours or arrived inside an application/);
    expect(hostMountScript).not.toHaveBeenCalled();
  });

  it("refuses when the NAMED module is listed but will not load", async () => {
    // The caller says "I am running module m". The store says m exists and then
    // cannot produce it. That record is the one thing that could have said
    // "publisher", so the run has no honest way forward.
    storeUnreadableModule("m", "record checksum mismatch");
    // ...and a DIFFERENT, readable local record happens to hold the same text.
    // That is not an answer to the question the caller asked: identity is the
    // stronger key precisely because an edited publisher macro still belongs to
    // its publisher, so an unreadable named record cannot be waved through by a
    // lookalike sitting next to it.
    storeModule({ id: "a-local-lookalike", source: PUBLISHER_SOURCE, sourcePackage: null });

    await expect(
      runObjectScriptOnce({ name: "m", source: PUBLISHER_SOURCE, scriptId: "m" }),
    ).rejects.toThrow(/could not be read[\s\S]*yours or arrived inside an application/);
    expect(hostMountScript).not.toHaveBeenCalled();
  });

  it("refuses when a module the CONTENT SCAN needed will not load", async () => {
    // No id, so identity cannot answer and the source has to. One record is
    // unreadable — and an unreadable record may be the very package record that
    // holds this source. Before this, its failure was reported as an empty
    // source and a null package, i.e. read as a local script that simply was
    // not a match, and the run mounted as the user's own.
    storeModule({ id: "unrelated", source: "function setup(c){}" });
    storeUnreadableModule("maybe-theirs");

    await expect(
      runObjectScriptOnce({ name: "A", source: PUBLISHER_SOURCE }),
    ).rejects.toThrow(/could not be read[\s\S]*yours or arrived inside an application/);
    expect(hostMountScript).not.toHaveBeenCalled();
  });

  it("names the module it could not read, so the user can go and look at it", async () => {
    storeUnreadableModule("macro-quarter-close", "disk read error");
    await expect(
      runObjectScriptOnce({
        name: "Quarter close",
        source: PUBLISHER_SOURCE,
        scriptId: "macro-quarter-close",
      }),
    ).rejects.toThrow(/macro-quarter-close[\s\S]*disk read error/);
  });

  it("a DEFINITE answer still beats a refusal", async () => {
    // An unreadable record does not veto an identification that was actually
    // made: the publisher's record matches this source, and nothing an
    // unreadable third record could say would make that less true.
    storeUnreadableModule("broken");
    storeModule({ id: "theirs", source: PUBLISHER_SOURCE, sourcePackage: "Acme Finance Pack" });

    await runObjectScriptOnce({ name: "Quarter close", source: PUBLISHER_SOURCE });

    expect(lastMount().provenance).toBe("distributed");
    expect(lastMount().accessLevel).toBe("restricted");
  });

  it("...including the local-copy authorisation", async () => {
    storeUnreadableModule("broken");
    storeModule({ id: "mine", source: PUBLISHER_SOURCE, sourcePackage: null });

    await runObjectScriptOnce({
      name: "Mine",
      source: PUBLISHER_SOURCE,
      accessLevel: "unlocked",
    });

    expect(lastMount().provenance).toBe("local");
    expect(lastMount().accessLevel).toBe("unlocked");
  });
});

// ============================================================================
// COST. Every macro run and every click of a macro-linked button lands here, so
// "download every module in the workbook to identify one of them" is a real
// price on a workbook with many modules — paid on the UI thread's promise chain,
// per click. Identity is asked first and usually ends it; the content scan is
// the fallback, and it is what the id could not settle.
// ============================================================================

describe("the store is read no harder than it has to be", () => {
  /** Nine other modules, so a full scan is unmistakable in the call count. */
  function storeManyModules(): void {
    for (let i = 0; i < 9; i++) {
      storeModule({ id: `other-${i}`, source: `function setup(c){ return ${i}; }` });
    }
  }

  it("a named PACKAGE module costs one record fetch, not the whole store", async () => {
    storeManyModules();
    storeModule({
      id: "macro-quarter-close",
      source: PUBLISHER_SOURCE,
      sourcePackage: "Acme Finance Pack",
    });

    await runObjectScriptOnce({
      name: "Quarter close",
      source: PUBLISHER_SOURCE,
      scriptId: "macro-quarter-close",
    });

    expect(lastMount().provenance).toBe("distributed");
    expect(getWorkbookScript).toHaveBeenCalledTimes(1);
    expect(getWorkbookScript).toHaveBeenCalledWith("macro-quarter-close");
    expect(listWorkbookScripts).toHaveBeenCalledTimes(1);
  });

  it("a named LOCAL module running its own stored text costs one too", async () => {
    storeManyModules();
    storeModule({ id: "macro-mine", source: PUBLISHER_SOURCE, sourcePackage: null });

    await runObjectScriptOnce({
      name: "Mine",
      source: PUBLISHER_SOURCE,
      scriptId: "macro-mine",
      accessLevel: "unlocked",
    });

    expect(lastMount().provenance).toBe("local");
    expect(getWorkbookScript).toHaveBeenCalledTimes(1);
  });

  it("but an EDITED local module still gets the full content scan", async () => {
    // The identity says "yours", the text says something else, and the text is
    // what will execute — so the scan runs, and it is still the scan that
    // catches a publisher's source arriving under a local id.
    storeManyModules();
    storeModule({ id: "macro-mine", source: "function setup(c){}", sourcePackage: null });
    storeModule({ id: "theirs", source: PUBLISHER_SOURCE, sourcePackage: "Acme Finance Pack" });

    await runObjectScriptOnce({
      name: "Mine",
      source: PUBLISHER_SOURCE,
      scriptId: "macro-mine",
    });

    expect(lastMount().provenance).toBe("distributed");
    expect(lastMount().packageName).toBe("Acme Finance Pack");
    expect(getWorkbookScript.mock.calls.length).toBeGreaterThan(1);
  });

  it("an id that names nothing falls back to the scan", async () => {
    storeModule({ id: "theirs", source: PUBLISHER_SOURCE, sourcePackage: "Acme Finance Pack" });

    await runObjectScriptOnce({
      name: "Quarter close",
      source: PUBLISHER_SOURCE,
      scriptId: "deleted-long-ago",
    });

    expect(lastMount().provenance).toBe("distributed");
  });
});

// ============================================================================
// OWNER DECISION B (2026-09-30): the person's pass travels to the mount, and a
// macro that reaches beyond cell access is refused BEFORE anything runs.
// ============================================================================

describe("an explicit run of an application's macro (owner decision B)", () => {
  const CELLS_ONLY =
    'async function m(api) { await api.beginBatch("M"); await api.setCellValue(0, 0, "OWNER-B"); await api.commitBatch(); }\n' +
    "function setup(context) { if (!context.api) return; return m(context.api); }\n";
  const FORMATS =
    'async function m(api) { await api.setCellValue(0, 0, "OWNER-B"); await api.setRangeFormat(0, 0, 0, 0, { bold: true }); }\n' +
    "function setup(context) { return m(context.api); }\n";

  it("(a)+(c) forwards the SAME pass to the mount, at the restricted tier", async () => {
    storeModule({ id: "macro-b", source: CELLS_ONLY, sourcePackage: "Sales" });
    const pass = mintExplicitMacroRun("macrosDialog", "macro-b");
    await runObjectScriptOnce({
      name: "B",
      source: CELLS_ONLY,
      scriptId: "macro-b",
      accessLevel: "restricted",
      explicitRun: pass,
    });
    expect(hostMountScript).toHaveBeenCalledTimes(1);
    expect(lastMount().explicitRun).toBe(pass);
    expect(lastMount().accessLevel).toBe("restricted");
    expect(lastMount().provenance).toBe("distributed");
  });

  // SABOTAGE: delete the pre-flight block in runObjectScriptOnce -> the
  // formatting macro is mounted (hostMountScript called) and this goes red.
  it("(b) refuses a macro that also calls methods outside cell access -- before mounting -- and spends the pass", async () => {
    storeModule({ id: "macro-f", source: FORMATS, sourcePackage: "Sales" });
    const pass = mintExplicitMacroRun("macrosDialog", "macro-f");
    let message = "";
    try {
      await runObjectScriptOnce({
        name: "Formats",
        source: FORMATS,
        scriptId: "macro-f",
        accessLevel: "restricted",
        explicitRun: pass,
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("api.setRangeFormat");
    expect(message).toContain("Nothing was changed");
    expect(message).toContain('"Sales"');
    expect(hostMountScript).not.toHaveBeenCalled();
    expect(claimExplicitMacroRun(pass), "a refused run left its pass usable").toBeNull();
    // ON THE PERSISTENT TRAIL (follow-up F8): the stored macro, the source that
    // was about to run, the calls named -- Rust reads the application itself.
    // SABOTAGE: drop the `recordRefusedBeforeRun(` call from the pre-flight
    // block in runObjectScriptOnce -> red.
    expect(invokeBackend).toHaveBeenCalledWith("audit_explicit_run_refusal", {
      scriptId: "macro-f",
      source: FORMATS,
      methods: ["api.setRangeFormat"],
    });
    expect(message, "a recorded refusal claimed it was not recorded").not.toContain("could not be recorded");
  });

  // SABOTAGE: make recordRefusedBeforeRun return null in its catch -> the
  // user is told nothing about the missing row, and this goes red.
  it("(b2) a refusal the trail cannot take still refuses -- and says it was not recorded", async () => {
    storeModule({ id: "macro-f", source: FORMATS, sourcePackage: "Sales" });
    invokeBackend.mockImplementationOnce(async (cmd: string) => {
      if (cmd === "audit_explicit_run_refusal") throw new Error("the trail is unavailable");
      return undefined;
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const pass = mintExplicitMacroRun("macrosDialog", "macro-f");
      await expect(
        runObjectScriptOnce({ name: "Formats", source: FORMATS, scriptId: "macro-f", accessLevel: "restricted", explicitRun: pass }),
      ).rejects.toThrow(/Nothing was changed.*could not be recorded on the audit trail: the trail is unavailable/s);
      expect(hostMountScript).not.toHaveBeenCalled();
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  // REVIEW OF M6b: the pre-flight runs before the mount gate asks about the
  // approval. When Rust finds the macro's code NOT approved, that is the reason
  // -- recorded `notConsented` -- and the person reads the approval's refusal,
  // never "when you run such a macro yourself it may read and change cells ...
  // adapt it into a macro of your own", which speaks of approved code.
  // SABOTAGE: drop the `if (recorded?.notApproved) throw ...` line -> the
  // pre-flight's sentence is read instead.
  it("(b3) an UNAPPROVED macro is refused for its approval, in the approval's words -- not as outside cell access", async () => {
    storeModule({ id: "macro-f", source: FORMATS, sourcePackage: "Sales" });
    const approval =
      "DISTRIBUTED_SCRIPT_NOT_CONSENTED: 'macro-f' arrived in the application 'Sales', and its code is not approved.";
    invokeBackend.mockImplementationOnce(async (cmd: string) =>
      cmd === "audit_explicit_run_refusal" ? { reason: "notConsented", message: approval } : undefined,
    );
    const pass = mintExplicitMacroRun("macrosDialog", "macro-f");
    const err = await runObjectScriptOnce({
      name: "Formats",
      source: FORMATS,
      scriptId: "macro-f",
      accessLevel: "restricted",
      explicitRun: pass,
    }).catch((e: Error) => e);
    expect(String(err)).toBe(`Error: ${approval}`);
    expect(String(err)).not.toContain("adapt it into a macro of your own");
    expect(String(err)).not.toContain("may read and change cells");
    expect(hostMountScript).not.toHaveBeenCalled();
    expect(claimExplicitMacroRun(pass), "a refused run left its pass usable").toBeNull();
    // CONTROL: an approved macro's refusal (the door says outsideCellAccess)
    // keeps the pre-flight's own sentence.
    invokeBackend.mockImplementationOnce(async (cmd: string) =>
      cmd === "audit_explicit_run_refusal" ? { reason: "outsideCellAccess", message: null } : undefined,
    );
    const approved = await runObjectScriptOnce({
      name: "Formats",
      source: FORMATS,
      scriptId: "macro-f",
      accessLevel: "restricted",
      explicitRun: mintExplicitMacroRun("macrosDialog", "macro-f"),
    }).catch((e: Error) => e);
    expect(String(approved)).toContain("When you run such a macro yourself it may read and change cells");
    expect(String(approved)).not.toContain("NOT_CONSENTED");
  });

  it("(d) the user's OWN macro is never pre-flighted: it mounts unlocked, formatting and all", async () => {
    storeModule({ id: "macro-mine", source: FORMATS, sourcePackage: null });
    const pass = mintExplicitMacroRun("macrosDialog", "macro-mine");
    await runObjectScriptOnce({ name: "Mine", source: FORMATS, scriptId: "macro-mine", explicitRun: pass });
    expect(hostMountScript).toHaveBeenCalledTimes(1);
    expect(lastMount().accessLevel).toBe("unlocked");
  });

  it("(e) an application macro run WITHOUT a pass is mounted restricted exactly as before -- no pre-flight", async () => {
    storeModule({ id: "macro-f", source: FORMATS, sourcePackage: "Sales" });
    await runObjectScriptOnce({ name: "Formats", source: FORMATS, scriptId: "macro-f", accessLevel: "restricted" });
    expect(hostMountScript).toHaveBeenCalledTimes(1);
    expect(lastMount().accessLevel).toBe("restricted");
    expect(lastMount().explicitRun).toBeUndefined();
    // Nothing was refused, so nothing is recorded as refused.
    expect(invokeBackend).not.toHaveBeenCalledWith("audit_explicit_run_refusal", expect.anything());
  });

  it("a run refused before the mount (an unreadable store) spends the pass too", async () => {
    storeUnreadableModule("macro-b");
    const pass = mintExplicitMacroRun("macrosDialog", "macro-b");
    await expect(
      runObjectScriptOnce({ name: "B", source: CELLS_ONLY, scriptId: "macro-b", explicitRun: pass }),
    ).rejects.toThrow(/could not be read/);
    expect(hostMountScript).not.toHaveBeenCalled();
    expect(claimExplicitMacroRun(pass)).toBeNull();
  });
});

// ============================================================================
// OWNER DECISION B, follow-up F9: a run with cell access that stops part-way
// is taken back whole, and the person who started it is told -- by the time
// they read it -- that nothing was changed (or why its changes could not be
// undone). The host decides and does the taking back; this runner waits for it
// AFTER the realm is gone and says it.
// ============================================================================

describe("a run with cell access that stops part-way (F9)", () => {
  const TAKEN_BACK: ExplicitRunEnd = {
    completed: false,
    undoable: true,
    rolledBack: true,
    notUndoneBecause: null,
    othersUndone: 0,
  };

  // SABOTAGE: return `error` unchanged from describeRunFailure (drop the
  // taken-back branch) -> the person reads only "boom", not that nothing changed.
  it("says it stopped and that NOTHING WAS CHANGED, after the realm is gone and the step was taken back", async () => {
    const order: string[] = [];
    hostMountScript.mockImplementationOnce(async (d: unknown) => {
      mountedIds.add(String((d as { id: string }).id));
      throw new Error("boom after two writes");
    });
    hostUnmountScript.mockImplementationOnce(() => {
      order.push("unmount");
    });
    hostSettleExplicitRun.mockImplementationOnce(async () => {
      order.push("settle");
      return TAKEN_BACK;
    });
    await expect(runObjectScriptOnce({ name: "Owner B", source: "" })).rejects.toThrow(
      '"Owner B" stopped before it finished: boom after two writes. Every change it had made was undone, so nothing was changed.',
    );
    // Its ending is asked for the run's own realm, once that realm is torn down.
    expect(order).toEqual(["unmount", "settle"]);
    expect(hostSettleExplicitRun).toHaveBeenCalledWith(String(lastMount().id));
  });

  it("the 10-second deadline: stopped, and taken back -- no 'stays in the sheet'", async () => {
    hostMountScript.mockRejectedValueOnce(new Error("Script mount timed out (10s)"));
    hostSettleExplicitRun.mockResolvedValueOnce(TAKEN_BACK);
    const err = await runObjectScriptOnce({ name: "Owner B", source: "" }).catch((e: Error) => e);
    expect(String(err)).toContain('"Owner B" was still running after 10 seconds and was stopped.');
    expect(String(err)).toContain("Every change it had made was undone, so nothing was changed.");
    expect(String(err)).not.toContain("stays in the sheet");
  });

  it("a crash sentence that already says it stopped is not said twice", async () => {
    hostMountScript.mockRejectedValueOnce(
      new Error('"Owner B" stopped: the script crashed while it was running (kaput). It was not started again -- a run happens once, when you start it -- so run it again if you want to.'),
    );
    hostSettleExplicitRun.mockResolvedValueOnce(TAKEN_BACK);
    const err = await runObjectScriptOnce({ name: "Owner B", source: "" }).catch((e: Error) => e);
    expect(String(err)).not.toContain("stopped before it finished");
    expect(String(err)).toMatch(/run it again if you want to\. Every change it had made was undone, so nothing was changed\.$/);
  });

  it("when it could NOT be taken back, it says why and that the cells need checking", async () => {
    hostMountScript.mockRejectedValueOnce(new Error("boom"));
    hostSettleExplicitRun.mockResolvedValueOnce({
      completed: false,
      undoable: true,
      rolledBack: false,
      notUndoneBecause: "the undo step it was recorded in is no longer open",
      othersUndone: 0,
    });
    const err = await runObjectScriptOnce({ name: "Owner B", source: "" }).catch((e: Error) => e);
    expect(String(err)).toContain(
      "Its changes could not be undone automatically (the undo step it was recorded in is no longer open), so check the cells it changed.",
    );
    expect(String(err)).not.toContain("nothing was changed");
  });

  it("CONTROL: a run with no cell grant (no ending) keeps its own error and its old deadline sentence", async () => {
    hostMountScript.mockRejectedValueOnce(new Error("boom"));
    await expect(runObjectScriptOnce({ name: "A", source: "" })).rejects.toThrow(/^boom$/);
    hostMountScript.mockRejectedValueOnce(new Error("Script mount timed out (10s)"));
    await expect(runObjectScriptOnce({ name: "A", source: "" })).rejects.toThrow(/stays in the sheet/);
  });

  it("a run that never got its undo step (it did not start) passes its own refusal through", async () => {
    const refusal = '"Owner B" did not start: a macro you run with cell access is undone as a whole if it stops part-way, and that could not be arranged here (x). Nothing was changed.';
    hostMountScript.mockRejectedValueOnce(new Error(refusal));
    hostSettleExplicitRun.mockResolvedValueOnce({
      completed: false,
      undoable: false,
      rolledBack: false,
      notUndoneBecause: "x",
      othersUndone: 0,
    });
    await expect(runObjectScriptOnce({ name: "Owner B", source: "" })).rejects.toThrow(refusal);
  });

  it("a run that completed resolves -- after its step was committed", async () => {
    hostSettleExplicitRun.mockResolvedValueOnce({
      completed: true,
      undoable: true,
      rolledBack: false,
      notUndoneBecause: null,
      othersUndone: 0,
    });
    await expect(runObjectScriptOnce({ name: "Owner B", source: "" })).resolves.toBeUndefined();
    expect(hostSettleExplicitRun).toHaveBeenCalledTimes(1);
  });

  // REVIEW OF M6b: the rollback takes back everything recorded after the
  // run's savepoint -- a cell the person typed meanwhile too. "Nothing was
  // changed" would hide that their own edit was reverted.
  // SABOTAGE: make describeRolledBack ignore othersUndone -> red.
  it("when the rollback took back OTHER changes made while it ran, it says how many -- never only 'nothing was changed'", async () => {
    for (const [n, said] of [
      [1, "and so was 1 other cell change made while it ran (yours or another script's)"],
      [3, "and so were 3 other cell changes made while it ran (yours or another script's)"],
    ] as const) {
      hostMountScript.mockRejectedValueOnce(new Error("boom"));
      hostSettleExplicitRun.mockResolvedValueOnce({ ...TAKEN_BACK, othersUndone: n });
      const err = String(await runObjectScriptOnce({ name: "Owner B", source: "" }).catch((e: Error) => e));
      expect(err, String(n)).toContain('"Owner B" stopped before it finished: boom.');
      expect(err, String(n)).toContain("Every change it had made was undone");
      expect(err, String(n)).toContain(said);
      expect(err, String(n)).toContain(n === 1 ? "Check that cell." : "Check those cells.");
      expect(err, String(n)).not.toContain("nothing was changed");
    }
    // CONTROL: only its own writes taken back -> nothing was changed.
    hostMountScript.mockRejectedValueOnce(new Error("boom"));
    hostSettleExplicitRun.mockResolvedValueOnce(TAKEN_BACK);
    const own = String(await runObjectScriptOnce({ name: "Owner B", source: "" }).catch((e: Error) => e));
    expect(own).toContain("Every change it had made was undone, so nothing was changed.");
    expect(own).not.toContain("other cell");
  });
});
