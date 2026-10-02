//! FILENAME: app/src/api/scriptHost/__tests__/explicitRunNotFromScripts.test.ts
// PURPOSE: Owner decision B (2026-09-30): "Standing object scripts, and any run
//          a script starts on its own, stay restricted." The door a SCRIPT uses
//          to start a macro -- `api.runMacro` -- must therefore never carry an
//          explicit-run pass to the macro-run seam, whatever the script sends.
// CONTEXT: The pass is a live object (explicitMacroRun.ts), so nothing a realm
//          posts can BE one; this file pins the other half -- that the script
//          door never hands the seam anything but the macro id. `vRunMacro`
//          validates args[0] only and does NOT refuse extra arguments: what
//          drops them is the dispatcher (`case "api.runMacro"` in host.ts
//          executeImpl), which calls `executeRunMacro(ref)` with the ref alone,
//          and `executeRunMacro` calls the provider with the resolved id alone.
//          Both are driven for real here through a mounted realm, then pinned by
//          source so a refactor cannot quietly start forwarding.
//
//          Only the Tauri boundary is doubled (as in explicitRunAdmission.test.ts);
//          the realm is a fake Worker that posts each message as its own task.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../../backend", () => ({
  invokeBackend: vi.fn(async (cmd: string, args?: { phase?: string; explicitRun?: unknown }) => {
    // A granted run marks its undo savepoint before it runs (owner decision B,
    // follow-up F9): answered as Rust does when nothing else holds the slot.
    if (cmd === "begin_undo_savepoint") return { ticket: 41, savepoint: { transaction: 41, changes: 0 } };
    if (cmd !== "check_distributed_mount_consent") return null;
    await new Promise<void>((r) => setTimeout(r, 1));
    // The Rust gate grants cell access on `runAdmitted` for the claim it is
    // shown (owner decision B, F3).
    if (args?.phase === "runAdmitted" && args.explicitRun) {
      return { recheckWhileRunning: false, cellAccess: true, grantId: 1 };
    }
    return { recheckWhileRunning: false };
  }),
  getWorkbookProperties: vi.fn().mockRejectedValue(new Error("no backend in test")),
  emitTauriEvent: vi.fn().mockResolvedValue(undefined),
  listenTauriEvent: vi.fn().mockResolvedValue(() => undefined),
}));
// The granted run's step closes through the grid library's ticketed doors.
vi.mock("../../lib", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  commitUndoTransaction: vi.fn(async () => undefined),
  cancelUndoTransaction: vi.fn(async () => undefined),
}));
vi.mock("../capabilities", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  restoreAndSyncGrants: vi.fn().mockResolvedValue(undefined),
  revokeBackendCapabilities: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../mountGate", () => ({
  assertMountAllowed: vi.fn(async () => undefined),
}));
vi.mock("../../workbookScripts", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listWorkbookScripts: vi.fn(async () => [{ id: "macro-x", name: "Macro X" }]),
}));

import { executeRunMacro, type HostMountDefinition } from "../host";
import { registerMacroRunProvider, resetMacroRunProvider } from "../../macroRunService";
import { mintExplicitMacroRun } from "../../explicitMacroRun";
import { explicitRunRefusalMessage } from "../explicitRunGrant";

// ---------------------------------------------------------------------------
// A scripted fake realm: on mount it runs a small program that makes broker
// calls and awaits their results, then reports "mounted".
// ---------------------------------------------------------------------------

type Msg = { t: string; [k: string]: unknown };

class FakeWorker {
  static all: FakeWorker[] = [];
  static program: (w: FakeWorker) => Promise<void> = async (w) => w.send({ t: "mounted", ok: true });
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  terminated = false;
  received: Msg[] = [];
  private nextCallId = 1;
  private waiting = new Map<number, (m: Msg) => void>();
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(msg: Msg): void {
    if (this.terminated) return;
    this.received.push(msg);
    if (msg.t === "mount") {
      setTimeout(() => {
        void FakeWorker.program(this);
      }, 0);
    }
    if (msg.t === "callResult") {
      const resolve = this.waiting.get(msg.callId as number);
      if (resolve) {
        this.waiting.delete(msg.callId as number);
        resolve(msg);
      }
    }
  }
  send(data: Msg): void {
    setTimeout(() => {
      if (!this.terminated) this.onmessage?.({ data } as MessageEvent);
    }, 0);
  }
  /** Make one broker call from inside the realm and await the host's answer. */
  call(method: string, args: unknown[]): Promise<Msg> {
    const callId = this.nextCallId++;
    const answer = new Promise<Msg>((resolve) => this.waiting.set(callId, resolve));
    this.send({ t: "call", callId, method, args });
    return answer;
  }
  terminate(): void {
    this.terminated = true;
  }
}

const g = globalThis as unknown as Record<string, unknown>;
const originalWorker = g.Worker;

/** What the capturing provider was called with, argument list by argument list. */
let providerCalls: unknown[][] = [];
let unregister: () => void = () => undefined;
let seq = 0;

function definition(overrides: Partial<HostMountDefinition>): HostMountDefinition {
  seq += 1;
  return {
    id: `__calcula_not_from_scripts_${seq}`,
    name: "Caller",
    objectType: "workbook",
    instanceId: null,
    source: "function setup(context) {}\n",
    accessLevel: "unlocked",
    provenance: "local",
    declaredCapabilities: [],
    apiVersion: "1.0.0",
    ...overrides,
  };
}

/** Mount a realm whose setup makes ONE api.runMacro call; resolve with the host's answer. */
async function runMacroFromRealm(def: HostMountDefinition, args: unknown[]): Promise<Msg> {
  let answer: Msg | null = null;
  FakeWorker.program = async (w) => {
    answer = await w.call("api.runMacro", args);
    w.send({ t: "mounted", ok: true });
  };
  await (await import("../host")).hostMountScript(def);
  expect(answer, "the realm's call was never answered").not.toBeNull();
  return answer as unknown as Msg;
}

beforeEach(() => {
  providerCalls = [];
  FakeWorker.all = [];
  g.Worker = FakeWorker as unknown as typeof Worker;
  unregister = registerMacroRunProvider({
    runMacroByRef: async (...args: unknown[]) => {
      providerCalls.push(args);
      return { status: "ran", name: "Macro X" };
    },
  });
});
afterEach(async () => {
  unregister();
  resetMacroRunProvider();
  (await import("../host")).hostResetAll();
  g.Worker = originalWorker;
});

describe("a script's api.runMacro never hands the seam a pass", () => {
  it("executeRunMacro calls the provider with the macro id and NOTHING else", async () => {
    await expect(executeRunMacro("macro-x")).resolves.toEqual({ name: "Macro X" });
    expect(providerCalls).toEqual([["macro-x"]]);
    expect(providerCalls[0]).toHaveLength(1);
  });

  // SABOTAGE (c): make executeRunMacro pass
  // `{ explicitRun: mintExplicitMacroRun("button", resolved.id) }` to the
  // provider -> the provider sees a second argument and this goes red.
  it("an unlocked script's api.runMacro reaches the provider with the id alone -- extra arguments are dropped", async () => {
    // What a realm could try to smuggle: a pass-shaped object, and options.
    const answer = await runMacroFromRealm(definition({}), [
      "macro-x",
      { door: "macrosDialog", macroId: "macro-x" },
      { explicitRun: { door: "macrosDialog", macroId: "macro-x" } },
    ]);
    expect(answer.ok, JSON.stringify(answer)).toBe(true);
    expect(providerCalls).toEqual([["macro-x"]]);
  });

  it("a RESTRICTED script cannot start a macro at all (refused at the tier; nothing runs)", async () => {
    const answer = (await runMacroFromRealm(definition({ accessLevel: "restricted" }), ["macro-x"])) as {
      ok: boolean;
      error?: { code: string; message: string };
    };
    expect(answer.ok).toBe(false);
    expect(answer.error?.code).toBe("PermissionDenied");
    expect(answer.error?.message).toBe("api.runMacro requires unlocked access; this script is restricted");
    expect(providerCalls).toEqual([]);
  });

  it("a realm HOLDING cell access cannot start another macro with it (refused; nothing runs)", async () => {
    const SRC = "function setup(context) { return context.api.runMacro('macro-x'); }\n";
    const pass = mintExplicitMacroRun("macrosDialog", "macro-b");
    const answer = (await runMacroFromRealm(
      definition({
        source: SRC,
        accessLevel: "restricted",
        provenance: "distributed",
        packageName: "Sales",
        consentSurface: "object-script",
        consentArtifacts: [{ id: "macro-b", source: SRC }],
        consentRun: true,
        explicitRun: pass,
      }),
      ["macro-x"],
    )) as { ok: boolean; error?: { code: string; message: string } };
    // PRECONDITION: this realm really was granted -- otherwise the refusal below
    // would be the plain tier refusal and prove nothing about the grant.
    const spec = FakeWorker.all[FakeWorker.all.length - 1].received.find((m) => m.t === "mount")?.spec as
      | Record<string, unknown>
      | undefined;
    expect(spec?.explicitRunCells, "precondition: the realm was granted cell access").toBe(true);
    expect(answer.ok).toBe(false);
    expect(answer.error?.code).toBe("PermissionDenied");
    expect(answer.error?.message).toBe(explicitRunRefusalMessage("api.runMacro"));
    expect(providerCalls).toEqual([]);
  });
});

describe("source pins: the script door forwards the reference and nothing else", () => {
  const HOST = readFileSync(join(__dirname, "..", "host.ts"), "utf8");
  const code = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it('the dispatcher\'s `case "api.runMacro"` takes the ref alone and passes it alone', () => {
    const start = HOST.indexOf('case "api.runMacro": {');
    expect(start, 'case "api.runMacro" not found in host.ts').toBeGreaterThan(-1);
    const end = HOST.indexOf("\n    }\n", start);
    const body = code(HOST.slice(start, end))
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
    expect(body).toEqual([
      'case "api.runMacro": {',
      "const [ref] = args as [string];",
      "return executeRunMacro(ref);",
    ]);
  });

  it("executeRunMacro hands the provider the resolved id alone, and mints nothing", () => {
    const start = HOST.indexOf("export async function executeRunMacro(");
    expect(start).toBeGreaterThan(-1);
    const body = code(HOST.slice(start, HOST.indexOf("\n}\n", start)));
    expect(body).toContain("export async function executeRunMacro(ref: string)");
    expect(body).toContain(".runMacroByRef(resolved.id);");
    expect(body).not.toContain("explicitRun");
    expect(body).not.toContain("mintExplicitMacroRun");
  });
});
