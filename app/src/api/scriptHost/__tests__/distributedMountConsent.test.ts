//! FILENAME: app/src/api/scriptHost/__tests__/distributedMountConsent.test.ts
// PURPOSE: The distributed-consent requirement lives at the BOUNDARY WHERE A
//          REALM IS CREATED, not at the callers — so a new caller gets it by
//          construction instead of by being remembered.
//
// CONTEXT: This is the fourth round of the same defect. Code that arrived inside
//          a distributed application (`.calp`) ran without the consent
//          distribution requires, and each round fixed the callers it knew
//          about:
//
//            round 1  the macro library's Run
//            round 2  macro-linked buttons
//            round 3  `runObjectScriptOnce` (the one-off runner)
//            round 4  `hostStartModuleScriptDebugSession` — the Object Script
//                     Editor's Run AND Debug, which mounted a publisher's macro
//                     in a REAL worker realm, correctly capped at the restricted
//                     tier and correctly stamped with the publisher's
//                     provenance, and never asked whether the user had approved
//                     that application at all.
//
//          RESTRICTED IS NOT CONSENTED. The tier bounds what the code can REACH;
//          consent is the user agreeing to run it AT ALL. A sandbox around code
//          nobody said yes to is a different protection.
//
//          The shape under test is therefore not "one more remembered call".
//          `mountWorker` — the ONLY function that spawns a mounted realm —
//          cannot be called without a `MountAdmission`, and the only producer of
//          one runs both gates. `hostMountScript` is the only exported route to
//          it. A fifth route either passes through here or does not compile.
//
//          AND DISTRIBUTED CODE MUST STILL RUN. The positive controls below are
//          load-bearing: once the application is consented, the publisher's
//          module mounts, debugs and runs. "Distributed code never runs" would
//          pass every refusal test in this file and be a broken product.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { H2W, W2H } from "../protocol";

// ---------------------------------------------------------------------------
// The backend door. `check_distributed_mount_consent` is the ONE gate; every
// other command the mount path touches answers null.
//
// It replaced `check_distributed_module_consent` on this path because that
// command asks about the SOURCE and answers "allow" for anything that is not a
// stored module — which is every COMPOSED realm source. The mount gate now asks
// the module question AND "has this workbook approved that application's code?".
// The per-route consequences are pinned in distributedMountApplicationConsent.test.ts.
// ---------------------------------------------------------------------------
/** How the Rust gate answers the next mount. */
const gate = {
  /** Refuse with the Rust sentinel, naming this module. */
  refuse: null as string | null,
  /** The gate itself could not be reached (IPC down, command missing). */
  unreachable: null as string | null,
};

const invokeBackend = vi.fn(async (cmd: string, _args?: unknown): Promise<unknown> => {
  if (cmd !== "check_distributed_mount_consent") return null;
  if (gate.unreachable) throw new Error(gate.unreachable);
  if (gate.refuse) {
    throw new Error(
      `DISTRIBUTED_SCRIPT_NOT_CONSENTED: '${gate.refuse}' arrived in the package ` +
        "'Acme Finance Pack' and you have not approved that package's code, so it will not run.",
    );
  }
  return null;
});

vi.mock("../../backend", () => ({
  invokeBackend: (cmd: string, args?: unknown) => invokeBackend(cmd, args),
  getWorkbookProperties: vi.fn().mockRejectedValue(new Error("no backend in test")),
  emitTauriEvent: vi.fn().mockResolvedValue(undefined),
  listenTauriEvent: vi.fn().mockResolvedValue(() => undefined),
}));

vi.mock("../capabilities", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  restoreAndSyncGrants: vi.fn().mockResolvedValue(undefined),
  revokeBackendCapabilities: vi.fn().mockResolvedValue(undefined),
}));

/** The global Script Security gate — the OTHER mount gate, spied to pin order. */
const assertMountAllowed = vi.fn(async (_name: string) => undefined);
vi.mock("../mountGate", () => ({
  assertMountAllowed: (name: string) => assertMountAllowed(name),
}));

// ---------------------------------------------------------------------------
// The workbook's MODULE store — where a recorded macro, and a macro a `.calp`
// shipped, actually live. `source_package` is stamped by core/calp/src/pull.rs.
// ---------------------------------------------------------------------------
interface StoredModule {
  id: string;
  name: string;
  description: string | null;
  source: string;
  sourcePackage?: string | null;
}
const moduleStore = new Map<string, StoredModule>();
const getWorkbookScript = vi.fn(async (id: string) => {
  const found = moduleStore.get(id);
  if (!found) throw new Error(`Script '${id}' not found`);
  return found;
});
vi.mock("../../workbookScripts", () => ({
  getWorkbookScript: (id: string) => getWorkbookScript(id),
}));

// ---------------------------------------------------------------------------
// A minimal realm that answers the mount handshake and nothing else.
// ---------------------------------------------------------------------------
class FakeWorker {
  static instances: FakeWorker[] = [];
  static last: FakeWorker | null = null;
  onmessage: ((e: MessageEvent<W2H>) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  received: H2W[] = [];
  terminated = false;

  constructor() {
    FakeWorker.instances.push(this);
    FakeWorker.last = this;
  }

  postMessage(msg: H2W): void {
    this.received.push(msg);
    if (msg.t === "mount") this.emit({ t: "mounted", ok: true });
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(data: W2H): void {
    this.onmessage?.({ data } as MessageEvent<W2H>);
  }

  /** The mount spec this realm was handed. */
  spec(): { tier: string; source: string; packageInfo?: { name: string } } {
    const msg = this.received.find((m) => m.t === "mount") as unknown as {
      spec: { tier: string; source: string; packageInfo?: { name: string } };
    };
    return msg.spec;
  }
}

const globalScope = globalThis as unknown as Record<string, unknown>;
const originalWorker = globalScope.Worker;

type HostModule = typeof import("../host");
let host: HostModule;

const PUBLISHER_SOURCE = [
  "function vendorClose(api) { return api.setCellValue(0, 0, 'owned'); }",
  "function setup(context) { return vendorClose(context.api); }",
].join("\n");

/** A macro a `.calp` shipped: the store stamped it with the publisher's name. */
const DISTRIBUTED_MODULE: StoredModule = {
  id: "macro-vendor-close",
  name: "Vendor close",
  description: "Recorded macro · runtime=objectScript",
  source: PUBLISHER_SOURCE,
  sourcePackage: "Acme Finance Pack",
};

/** The user's own macro, byte-identical in shape. */
const LOCAL_MODULE: StoredModule = {
  id: "macro-monthly-close",
  name: "Monthly close",
  description: "Recorded macro · runtime=objectScript",
  source: "function setup(context) { return context.api.setCellValue(0, 0, 1); }",
  sourcePackage: null,
};

/** A mount definition as a `.calp`-sourced artifact produces one. */
function distributedDefinition(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-vendor-close",
    name: "Vendor close",
    objectType: "workbook",
    instanceId: null,
    source: PUBLISHER_SOURCE,
    accessLevel: "restricted",
    provenance: "distributed",
    packageName: "Acme Finance Pack",
    apiVersion: "1.0.0",
    ...overrides,
  };
}

/** The same, authored in this workbook. */
function localDefinition(overrides: Record<string, unknown> = {}) {
  return {
    id: "local-script",
    name: "My script",
    objectType: "workbook",
    instanceId: null,
    source: LOCAL_MODULE.source,
    accessLevel: "unlocked",
    provenance: "local",
    apiVersion: "1.0.0",
    ...overrides,
  };
}

/** Calls the consent gate actually received. */
function gateCalls(): Array<{ packageName: string; source: string }> {
  return invokeBackend.mock.calls
    .filter(([cmd]) => cmd === "check_distributed_mount_consent")
    .map(([, args]) => args as { packageName: string; source: string });
}

/** Just the sources, for the assertions that are only about the code. */
function gateSources(): string[] {
  return gateCalls().map((c) => c.source);
}

beforeEach(async () => {
  FakeWorker.instances = [];
  FakeWorker.last = null;
  moduleStore.clear();
  gate.refuse = null;
  gate.unreachable = null;
  invokeBackend.mockClear();
  getWorkbookScript.mockClear();
  assertMountAllowed.mockClear().mockResolvedValue(undefined);
  globalScope.Worker = FakeWorker as unknown as typeof Worker;
  vi.resetModules();
  host = await import("../host");
});

afterEach(() => {
  host.hostResetAll();
  globalScope.Worker = originalWorker;
});

// ============================================================================
// DOOR 1 — hostMountScript, the public mount entry every mount route uses.
// ============================================================================

describe("hostMountScript — the mount boundary asks about the publisher", () => {
  it("asks the ONE Rust gate, with the exact source that would run AND the application", async () => {
    await host.hostMountScript(distributedDefinition());

    expect(gateSources()).toEqual([PUBLISHER_SOURCE]);
    // The application is what makes the question answerable for a composed
    // realm source; a source-only question could not refuse one at all.
    expect(gateCalls()[0].packageName).toBe("Acme Finance Pack");
  });

  it("REFUSES to create a realm for an application the user never approved", async () => {
    gate.refuse = DISTRIBUTED_MODULE.id;

    await expect(host.hostMountScript(distributedDefinition())).rejects.toThrow(
      /DISTRIBUTED_SCRIPT_NOT_CONSENTED/,
    );
    // The property that matters is not the message: NO REALM EXISTS.
    expect(FakeWorker.instances).toHaveLength(0);
    expect(host.hostIsMounted("run-vendor-close")).toBe(false);
  });

  it("refuses when the gate cannot be reached at all, and names the application", async () => {
    // "I could not find out whether you approved this publisher's code" is not
    // approval — and this is the path that spawns a real realm for a stranger's
    // JavaScript.
    gate.unreachable = "IPC channel closed";

    await expect(host.hostMountScript(distributedDefinition())).rejects.toThrow(
      /Acme Finance Pack[\s\S]*could not be established[\s\S]*IPC channel closed/,
    );
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it("asks BEFORE the Script Security prompt, so a refused mount mints no session approval", async () => {
    // `assertMountAllowed` can show a modal whose "yes" allows scripts for the
    // whole SESSION. Asking for that on behalf of code we are about to refuse
    // would make the user answer twice to be told no — and would hand out a
    // session-wide approval for a run that never happens.
    gate.refuse = DISTRIBUTED_MODULE.id;

    await expect(host.hostMountScript(distributedDefinition())).rejects.toThrow();
    expect(assertMountAllowed).not.toHaveBeenCalled();
  });

  it("does not ask about the user's own code", async () => {
    await host.hostMountScript(localDefinition());

    expect(gateCalls()).toEqual([]);
    expect(host.hostIsMounted("local-script")).toBe(true);
  });

  it("an omitted provenance is local, and is not asked about either", async () => {
    const definition = localDefinition({ id: "unstamped" });
    delete (definition as Record<string, unknown>).provenance;

    await host.hostMountScript(definition);

    expect(gateCalls()).toEqual([]);
    expect(host.hostIsMounted("unstamped")).toBe(true);
  });

  // ---- THE POSITIVE CONTROL -------------------------------------------------
  it("MOUNTS the publisher's code once the application IS consented", async () => {
    await host.hostMountScript(distributedDefinition());

    expect(host.hostIsMounted("run-vendor-close")).toBe(true);
    expect(FakeWorker.instances).toHaveLength(1);
    const spec = FakeWorker.last!.spec();
    expect(spec.source).toBe(PUBLISHER_SOURCE);
    expect(spec.tier).toBe("restricted");
    expect(spec.packageInfo?.name).toBe("Acme Finance Pack");
  });

  it("Script Security still governs a consented application's code", async () => {
    // The two gates are independent: consent says "this publisher", the setting
    // says "scripts, here, now". Neither substitutes for the other.
    assertMountAllowed.mockRejectedValueOnce(new Error("Script Security is disabled"));

    await expect(host.hostMountScript(distributedDefinition())).rejects.toThrow(
      /Script Security/,
    );
    expect(FakeWorker.instances).toHaveLength(0);
  });
});

// ============================================================================
// DOOR 2 — the Object Script Editor's Run and Debug. THE DOOR THIS ROUND FOUND.
// ============================================================================

describe("hostStartModuleScriptDebugSession — Run/Debug on a stored module", () => {
  it("asks the gate with the STORED record's source, not with anything a caller sent", async () => {
    moduleStore.set(DISTRIBUTED_MODULE.id, DISTRIBUTED_MODULE);

    await host.hostStartModuleScriptDebugSession(DISTRIBUTED_MODULE.id, [2]);

    expect(gateSources()).toEqual([PUBLISHER_SOURCE]);
  });

  it("REFUSES the session for an application the user never approved", async () => {
    moduleStore.set(DISTRIBUTED_MODULE.id, DISTRIBUTED_MODULE);
    gate.refuse = DISTRIBUTED_MODULE.id;

    await expect(
      host.hostStartModuleScriptDebugSession(DISTRIBUTED_MODULE.id, [2]),
    ).rejects.toThrow(/DISTRIBUTED_SCRIPT_NOT_CONSENTED/);

    // No realm, no session, and no debugger-owned mount marker left behind —
    // a leftover marker is exactly the ambient state nothing would ever revoke.
    expect(FakeWorker.instances).toHaveLength(0);
    expect(host.hostIsMounted(DISTRIBUTED_MODULE.id)).toBe(false);
    expect(host.getDebugSession(DISTRIBUTED_MODULE.id)).toBeNull();
    expect(host.hostTransientDebugMountIds()).toEqual([]);
  });

  it("refuses when the gate is unreachable", async () => {
    moduleStore.set(DISTRIBUTED_MODULE.id, DISTRIBUTED_MODULE);
    gate.unreachable = "no backend";

    await expect(
      host.hostStartModuleScriptDebugSession(DISTRIBUTED_MODULE.id, [2]),
    ).rejects.toThrow(/could not be established/);
    expect(FakeWorker.instances).toHaveLength(0);
    expect(host.hostTransientDebugMountIds()).toEqual([]);
  });

  it("does not ask about the user's own module", async () => {
    moduleStore.set(LOCAL_MODULE.id, LOCAL_MODULE);

    await host.hostStartModuleScriptDebugSession(LOCAL_MODULE.id, [1]);

    expect(gateCalls()).toEqual([]);
    expect(host.hostIsMounted(LOCAL_MODULE.id)).toBe(true);
  });

  // ---- THE POSITIVE CONTROL -------------------------------------------------
  it("DEBUGS the publisher's module once the application IS consented", async () => {
    moduleStore.set(DISTRIBUTED_MODULE.id, DISTRIBUTED_MODULE);

    const session = await host.hostStartModuleScriptDebugSession(DISTRIBUTED_MODULE.id, [2]);

    expect(session.scriptId).toBe(DISTRIBUTED_MODULE.id);
    expect(host.hostIsMounted(DISTRIBUTED_MODULE.id)).toBe(true);
    // Still restricted, still the publisher's provenance — consent does not
    // promote it, it only permits it.
    expect(FakeWorker.last!.spec().tier).toBe("restricted");
    expect(FakeWorker.last!.spec().packageInfo?.name).toBe("Acme Finance Pack");
  });
});

// ============================================================================
// A REMOUNT IS NOT A NEW MOUNT. The admission the mount already holds is
// re-presented, so recovery and the debugger never re-prompt — and never let a
// refusal that came later un-run code the user is already running.
// ============================================================================

describe("remount paths re-present the admission instead of re-gating", () => {
  it("opening a debug session on a standing distributed mount asks once, not twice", async () => {
    await host.hostMountScript(distributedDefinition());
    expect(gateCalls()).toHaveLength(1);

    await host.hostStartDebugSession("run-vendor-close", [1]);

    expect(gateCalls()).toHaveLength(1);
    expect(FakeWorker.instances).toHaveLength(2); // remounted instrumented
  });

  it("stopping the session returns it to its production mount without re-asking", async () => {
    await host.hostMountScript(distributedDefinition());
    await host.hostStartDebugSession("run-vendor-close", [1]);
    invokeBackend.mockClear();

    await host.hostStopDebugSession("run-vendor-close");

    expect(gateCalls()).toEqual([]);
    expect(host.hostIsMounted("run-vendor-close")).toBe(true);
  });

  it("a crash respawn relaunches admitted code without re-asking", async () => {
    await host.hostMountScript(distributedDefinition());
    const crashed = FakeWorker.last!;
    invokeBackend.mockClear();

    crashed.onerror?.({ message: "Worker crashed" });
    // The respawn is a detached promise chain; let it settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(gateCalls()).toEqual([]);
    expect(host.hostIsMounted("run-vendor-close")).toBe(true);
    expect(FakeWorker.instances.length).toBeGreaterThan(1);
  });
});

// ============================================================================
// THE DOOR CENSUS. The point of this round is that closing two named doors is
// not a fix. These guards fail when a NEW door appears unclassified.
// ============================================================================

const APP_ROOT = join(__dirname, "..", "..", "..", "..");
const HOST_PATH = join(APP_ROOT, "src", "api", "scriptHost", "host.ts");

/** Strip line and block comments so prose about a call is not read as one. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * The argument text of every CALL to `fn`, bracket-matched.
 *
 * The declaration is skipped explicitly (`function fn(`) — counting it as a call
 * is exactly the off-by-one that makes a census guard lie about how many doors
 * there are.
 */
function callArguments(code: string, fn: string): string[] {
  const out: string[] = [];
  const needle = `${fn}(`;
  for (let at = code.indexOf(needle); at !== -1; at = code.indexOf(needle, at + 1)) {
    if (/\bfunction\s+$/.test(code.slice(0, at))) continue;
    let depth = 0;
    let i = at + needle.length - 1;
    for (; i < code.length; i++) {
      if (code[i] === "(") depth++;
      else if (code[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(code.slice(at + needle.length, i));
  }
  return out;
}

/** Split an argument list on its TOP-LEVEL commas. */
function topLevelArgs(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of args) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

describe("the realm-creation doors are enumerated, not discovered one per round", () => {
  it("every mounted realm is spawned by mountWorker, which cannot run without an admission", () => {
    const code = stripComments(readFileSync(HOST_PATH, "utf8"));

    // `spawnWorker()` is the only expression that creates a realm, and there are
    // exactly three call sites. Two of them are deliberately ungated and say so
    // in `spawnWorker`'s own header: hostValidateScript (parses, never executes)
    // and hostPreviewScript (a dry run over a substituted backend, same-origin
    // with nothing, registered nowhere). The third is the mount.
    const spawnSites = callArguments(code, "spawnWorker");
    expect(
      spawnSites,
      "a new spawnWorker() call site is a new way to create a script realm — classify it " +
        "in spawnWorker's header and gate it, or explain why it needs no gate",
    ).toHaveLength(3);

    // Nothing else in the app may reach for the realm bootstrap directly.
    const bootstrapRefs = code.match(/worker\/bootstrap/g) ?? [];
    expect(bootstrapRefs).toHaveLength(1);
  });

  it("mountWorker is called only with an admission, and only admitMount mints one", () => {
    const code = stripComments(readFileSync(HOST_PATH, "utf8"));

    // Every call passes a second argument. (The compiler enforces this too —
    // the parameter is required — but the census is what a reader checks.)
    const calls = callArguments(code, "mountWorker");
    expect(calls.length, "the mountWorker call scanner found nothing").toBeGreaterThan(2);
    for (const args of calls) {
      const parts = topLevelArgs(args);
      expect(parts.length, `mountWorker(${args}) must present an admission`).toBe(2);
      expect(parts[1], `mountWorker(${args}) must present an admission`).not.toBe("");
    }

    // ONE producer of the brand. A second one is a second policy.
    // The interface DECLARES the brand once; exactly one place WRITES it.
    const brandWrites = code.match(/\[MOUNT_ADMISSION_BRAND\]:\s*true as const/g) ?? [];
    expect(
      brandWrites,
      "a MountAdmission may be minted in exactly one place (admitMount), because minting " +
        "one IS the claim that both mount gates ran",
    ).toHaveLength(1);

    // ...and that producer runs both gates.
    const admit = code.slice(
      code.indexOf("async function admitMount("),
      code.indexOf("\n}\n", code.indexOf("async function admitMount(")),
    );
    expect(admit).toContain("requireDistributedMountConsent(definition)");
    expect(admit).toContain("assertMountAllowed(definition.name)");
  });

  it("hostMountScript is the only exported route to an admission", () => {
    const code = stripComments(readFileSync(HOST_PATH, "utf8"));
    // `admitMount` is module-private and `MountAdmission` is never exported, so
    // no caller outside this file can hold one — the only thing they can obtain
    // is a mount.
    expect(code).not.toMatch(/export\s+(async\s+)?function\s+admitMount/);
    expect(code).not.toMatch(/export\s+interface\s+MountAdmission/);
    expect(code).not.toMatch(/export\s+(const|type)\s+MOUNT_ADMISSION_BRAND/);
    const admitSites = code.match(/\badmitMount\(/g) ?? [];
    // Its declaration, plus hostMountScript and the module debug session.
    expect(admitSites).toHaveLength(3);
  });

  it("the one-off runner no longer keeps its own copy of the gate", () => {
    // Round 3 taught `runObjectScriptOnce` to call the gate. Round 4 found the
    // door it did not cover. Two copies of a consent decision is how the run
    // routes came to differ; the runner now derives the ORIGIN and the mount
    // boundary decides consent.
    const runner = stripComments(
      readFileSync(join(APP_ROOT, "src", "api", "objectScriptRunner.ts"), "utf8"),
    );
    expect(runner).not.toContain("check_distributed_module_consent");
    expect(runner).not.toContain("check_distributed_mount_consent");
    // ...but it still derives the artifact's origin, which is what makes the
    // boundary's gate fire at all.
    expect(runner).toContain("resolveArtifactOrigin(");
    expect(runner).toContain("mountProvenanceForOrigin(origin)");
  });

  it("the mount boundary asks the MOUNT gate, and asks it about the application", () => {
    // The regression this guards is not a missing call — it is the WRONG
    // QUESTION. `check_distributed_module_consent` resolves ownership by exact
    // source equality and returns "allow" for anything that is not a stored
    // module, which is every composed realm source; asking it from here gated
    // five of the six mount routes not at all.
    const code = stripComments(readFileSync(HOST_PATH, "utf8"));
    expect(code).toContain('invoke<void>("check_distributed_mount_consent"');
    expect(code).not.toContain('"check_distributed_module_consent"');
    const gateBody = code.slice(
      code.indexOf("async function requireDistributedMountConsent("),
      code.indexOf("\n}\n", code.indexOf("async function requireDistributedMountConsent(")),
    );
    // The application, derived through scriptOriginForMount — never the raw
    // `definition.packageName`, which a local definition may also carry.
    expect(gateBody).toContain("packageName: origin.name");
    expect(gateBody).toContain("source: definition.source");
    // The surface and the artifacts are passed THROUGH, never filled in: a
    // missing surface or an empty artifact list is Rust's refusal to make.
    expect(gateBody).toContain("surface: definition.consentSurface ?? null");
    expect(gateBody).toContain("artifacts: definition.consentArtifacts ?? null");
  });
});
