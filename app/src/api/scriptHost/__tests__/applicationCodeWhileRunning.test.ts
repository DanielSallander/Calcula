//! FILENAME: app/src/api/scriptHost/__tests__/applicationCodeWhileRunning.test.ts
// PURPOSE: Two halves of the application-code run gate (phase 3 of BUG-0257)
//          that live on the HOST side of the mount door:
//
//          1. AN EXPLICIT RUN IS RECORDED ONLY ONCE IT IS ADMITTED. The one-off
//             runner (Developer > Macros > Run, the CLI, a button) asks the Rust
//             gate `runCheck` BEFORE Script Security -- every refusal recorded,
//             no run row -- and `runAdmitted` only AFTER Script Security let it
//             through, which writes the always-on run row. Asking once, before
//             Script Security, wrote "ran" for runs Script Security then
//             refused; a standing mount is asked once (`mount`).
//
//          2. THE PRIVATE-SHEET RULE HOLDS WHILE A REALM RUNS. It used to be
//             judged only when a realm mounted; a distributed object script that
//             mounted in a clean working copy kept running after a private sheet
//             appeared, and its timers and handlers could read it and write it
//             into an application sheet the next push ships. A realm the gate
//             marks `recheckWhileRunning` now asks `standing` before every broker
//             call and every event, in arrival order, and a refusal ENDS it --
//             nothing more is delivered to it, and it gets no answer.
//
// CONTEXT: The Rust half (what each phase records, and the rule itself) is
//          pinned in app/src-tauri/src/scripting/application_code_gate_tests.rs.
//          Here only the Tauri boundary is doubled: the backend door, the
//          Script Security gate and the toast sink, around a fake realm.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { H2W, W2H } from "../protocol";
import { AppEvents, emitAppEvent } from "../../events";

const h = vi.hoisted(() => ({
  /** The gate's answer to the MOUNT question. */
  mountAnswer: { recheckWhileRunning: true } as Record<string, unknown> | null,
  /** How the gate answers a STANDING question. */
  standing: "allow" as "allow" | "refuse" | "stopAsking",
  /** Script Security admits the mount. */
  scriptSecurity: true,
  /** Every question, in order: the gate's phases and "scriptSecurity". */
  asked: [] as string[],
  toasts: [] as { message: string; variant?: string }[],
}));

const REFUSAL =
  'APPLICATION_CODE_BESIDE_PRIVATE_SHEETS: "macro-report" came with the application "sales". ' +
  'This workbook is a working copy of "sales" and also holds sheets that are not part of it (Salaries).';

vi.mock("../../backend", () => ({
  invokeBackend: vi.fn(async (cmd: string, args?: { phase?: string }) => {
    if (cmd !== "check_distributed_mount_consent") return null;
    const phase = args?.phase ?? "(none)";
    h.asked.push(phase);
    if (phase === "standing") {
      if (h.standing === "refuse") throw new Error(REFUSAL);
      return { recheckWhileRunning: h.standing === "allow" };
    }
    return h.mountAnswer;
  }),
  getWorkbookProperties: vi.fn().mockRejectedValue(new Error("no backend in test")),
  emitTauriEvent: vi.fn().mockResolvedValue(undefined),
  listenTauriEvent: vi.fn().mockResolvedValue(() => undefined),
}));
vi.mock("../capabilities", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  restoreAndSyncGrants: vi.fn().mockResolvedValue(undefined),
  revokeBackendCapabilities: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../mountGate", () => ({
  assertMountAllowed: vi.fn(async (name: string) => {
    h.asked.push("scriptSecurity");
    if (!h.scriptSecurity) throw new Error(`Script "${name}" was blocked by the Script Security setting.`);
  }),
}));
vi.mock("../../notifications", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  showToast: (message: string, options?: { variant?: string }) => {
    h.toasts.push({ message, variant: options?.variant });
  },
}));

class FakeWorker {
  static last: FakeWorker | null = null;
  onmessage: ((e: MessageEvent<W2H>) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  received: H2W[] = [];
  terminated = false;

  constructor() {
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

  call(callId: number): void {
    this.emit({ t: "call", callId, method: "base.log", args: [`call ${callId}`] });
  }

  answered(): number[] {
    return this.received
      .filter((m): m is Extract<H2W, { t: "callResult" }> => m.t === "callResult")
      .map((m) => m.callId);
  }

  events(hook: string): unknown[] {
    return this.received
      .filter((m): m is Extract<H2W, { t: "event" }> => m.t === "event" && m.hook === hook)
      .map((m) => m.payload);
  }
}

const globalScope = globalThis as unknown as Record<string, unknown>;
const originalWorker = globalScope.Worker;
type HostModule = typeof import("../host");
let host: HostModule;

const SOURCE = "function setup(context) { context.onSheetAdd(() => {}); }";
const DEFINITION = {
  id: "app-watcher",
  name: "Report watcher",
  objectType: "workbook",
  instanceId: null,
  source: SOURCE,
  accessLevel: "restricted",
  provenance: "distributed",
  packageName: "sales",
  consentSurface: "object-script" as const,
  consentArtifacts: [{ id: "macro-report", source: SOURCE }],
  apiVersion: "1.0.0",
};

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
  h.mountAnswer = { recheckWhileRunning: true };
  h.standing = "allow";
  h.scriptSecurity = true;
  h.asked.length = 0;
  h.toasts.length = 0;
  FakeWorker.last = null;
  globalScope.Worker = FakeWorker as unknown as typeof Worker;
  // NO resetModules: the static `emitAppEvent` import must reach the host's
  // subscriptions (see eventBackpressure.test.ts).
  host = await import("../host");
});

afterEach(() => {
  host.hostResetAll();
  globalScope.Worker = originalWorker;
});

describe("an explicit run is recorded only once it is admitted", () => {
  // SABOTAGE: make the `const admitted = run ? await
  // requireDistributedMountConsent(definition, "runAdmitted", claim) : null;`
  // line in admitMount (host.ts) answer `null` without asking, or ask it
  // BEFORE assertMountAllowed.
  it("asks runCheck, then Script Security, then runAdmitted", async () => {
    await host.hostMountScript({ ...DEFINITION, consentRun: true });
    expect(h.asked).toEqual(["runCheck", "scriptSecurity", "runAdmitted"]);
  });

  it("a run Script Security refuses is never announced as run", async () => {
    h.scriptSecurity = false;
    await expect(host.hostMountScript({ ...DEFINITION, consentRun: true })).rejects.toThrow(/Script Security/);
    expect(h.asked, "the run row was asked for before Script Security admitted it").toEqual([
      "runCheck",
      "scriptSecurity",
    ]);
    expect(FakeWorker.last).toBeNull();
  });

  it("a standing mount is asked once, as a mount", async () => {
    await host.hostMountScript({ ...DEFINITION });
    expect(h.asked).toEqual(["mount", "scriptSecurity"]);
  });
});

describe("the private-sheet rule while a realm runs", () => {
  // SABOTAGE: drop the `if (!(await standingGate(mw))) return;` line from
  // handleCall (host.ts).
  it("asks before every call, and ENDS the realm the moment the rule refuses", async () => {
    await host.hostMountScript({ ...DEFINITION });
    const worker = FakeWorker.last!;
    worker.call(1);
    await settle();
    expect(worker.answered()).toEqual([1]);
    expect(h.asked.filter((p) => p === "standing")).toHaveLength(1);

    // A private sheet appears beside the running code.
    h.standing = "refuse";
    worker.call(2);
    await settle();
    expect(worker.terminated, "the realm kept running beside a private sheet").toBe(true);
    expect(worker.answered(), "the refused call was answered").toEqual([1]);
    expect(host.hostIsMounted(DEFINITION.id)).toBe(false);
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0].variant).toBe("error");
    expect(h.toasts[0].message).toContain("APPLICATION_CODE_BESIDE_PRIVATE_SHEETS");
    expect(h.toasts[0].message).toContain("was stopped");
  });

  // SABOTAGE: post the event directly in postEvent (skip `standingGateThen`).
  it("tells a refused realm nothing: the event waits for the check, and never arrives", async () => {
    await host.hostMountScript({ ...DEFINITION });
    const worker = FakeWorker.last!;
    worker.emit({ t: "hookRegistered", hook: "onSheetAdd" });
    emitAppEvent(AppEvents.SHEET_ADDED, { index: 1, name: "Budget" });
    await settle();
    expect(worker.events("onSheetAdd")).toEqual([{ index: 1, name: "Budget" }]);

    h.standing = "refuse";
    emitAppEvent(AppEvents.SHEET_ADDED, { index: 2, name: "Salaries" });
    await settle();
    expect(worker.events("onSheetAdd"), "a refused realm was told about the private sheet").toHaveLength(1);
    expect(worker.terminated).toBe(true);
  });

  it("keeps the realm's order: calls are answered in the order they were made", async () => {
    await host.hostMountScript({ ...DEFINITION });
    const worker = FakeWorker.last!;
    for (const id of [1, 2, 3, 4, 5]) worker.call(id);
    await settle();
    expect(worker.answered()).toEqual([1, 2, 3, 4, 5]);
  });

  it("asks nothing where the gate said the rule cannot bite, until a checkout re-arms it", async () => {
    h.mountAnswer = { recheckWhileRunning: false };
    await host.hostMountScript({ ...DEFINITION });
    const worker = FakeWorker.last!;
    worker.call(1);
    await settle();
    expect(worker.answered()).toEqual([1]);
    expect(h.asked.filter((p) => p === "standing"), "an ordinary realm paid a round trip per call").toHaveLength(0);

    // A checkout ADDS an application to this workbook (announced as AFTER_OPEN):
    // the running realm may now be in a working copy.
    emitAppEvent(AppEvents.AFTER_OPEN, { path: "", source: "checkout" });
    h.standing = "refuse";
    worker.call(2);
    await settle();
    expect(h.asked.filter((p) => p === "standing")).toHaveLength(1);
    expect(worker.terminated).toBe(true);
  });

  it("stops asking once the gate says the rule no longer applies", async () => {
    await host.hostMountScript({ ...DEFINITION });
    const worker = FakeWorker.last!;
    h.standing = "stopAsking";
    worker.call(1);
    await settle();
    worker.call(2);
    worker.call(3);
    await settle();
    expect(worker.answered()).toEqual([1, 2, 3]);
    expect(h.asked.filter((p) => p === "standing")).toHaveLength(1);
  });

  it("a LOCAL realm is never asked", async () => {
    await host.hostMountScript({
      ...DEFINITION,
      id: "my-own",
      provenance: "local",
      packageName: undefined,
      accessLevel: "unlocked",
    });
    const worker = FakeWorker.last!;
    worker.call(1);
    await settle();
    expect(worker.answered()).toEqual([1]);
    expect(h.asked.filter((p) => p !== "scriptSecurity")).toEqual([]);
  });
});
