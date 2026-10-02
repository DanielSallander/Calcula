//! FILENAME: app/src/api/scriptHost/__tests__/mountedAfterGatedCalls.test.ts
// PURPOSE: BUG-0267. A realm's "mounted" must not overtake a call it made
//          BEFORE it -- the host's own rule is that calls and events are
//          handled in arrival order.
//
//          In a working copy the mount gate answers `recheckWhileRunning`, so
//          every call the realm makes waits for a `standing` round trip. The
//          host used to handle "mounted" at once anyway: the one-off runner
//          (Developer > Macros > Run, the CLI, a button) then unmounted in its
//          `finally`, the standing answer arrived for a terminated realm, and
//          the call -- `context.notify` in setup, here -- was discarded with no
//          toast, no refusal and no log, while the always-on audit row already
//          said the macro RAN. Found live by calp-macro-buttons.spec.ts M4-3
//          (E2E run 9, 2026-09-30).
//
//          The two controls pin that the fix changes nothing where nothing
//          waits: a LOCAL module, and a distributed one whose gate answers
//          `recheckWhileRunning: false` (a subscriber that is not a working
//          copy), both keep today's synchronous "mounted".
//
// CONTEXT: Only the Tauri boundary is doubled: the backend door (answering in a
//          LATER task, as real IPC does -- the one thing the older
//          applicationCodeWhileRunning.test.ts double does not do, which is why
//          it passed against the bug), the Script Security gate, the capability
//          sync and the toast sink. The realm is a fake that posts setup's call
//          and then "mounted" as two separate tasks, as a MessagePort does.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  asked: [] as string[],
  toasts: [] as { message: string; variant?: string }[],
  mountAnswer: { recheckWhileRunning: true } as Record<string, unknown> | null,
  standing: "allow" as "allow" | "refuse",
  log: [] as string[],
}));

vi.mock("../../backend", () => ({
  invokeBackend: vi.fn(async (cmd: string, args?: { phase?: string }) => {
    if (cmd !== "check_distributed_mount_consent") return null;
    const phase = args?.phase ?? "(none)";
    h.asked.push(phase);
    h.log.push(`gate:${phase}:ask`);
    // A real Tauri IPC round trip resolves in a LATER task, never synchronously.
    await new Promise<void>((r) => setTimeout(r, 1));
    h.log.push(`gate:${phase}:answer`);
    if (phase === "standing") {
      if (h.standing === "refuse") throw new Error("APPLICATION_CODE_BESIDE_PRIVATE_SHEETS: refused while running");
      return { recheckWhileRunning: true };
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
  revokeBackendCapabilities: vi.fn(async (id: string) => {
    h.log.push(`revoke:${id}`);
  }),
}));
vi.mock("../mountGate", () => ({
  assertMountAllowed: vi.fn(async () => undefined),
}));
vi.mock("../../notifications", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  showToast: (message: string, options?: { variant?: string }) => {
    h.log.push(`toast:${message}`);
    h.toasts.push({ message, variant: options?.variant });
  },
}));

const TOAST = "M43-OBJ-1";
const SRC = `function setup(context) {\n  context.notify(${JSON.stringify(TOAST)}, "info");\n}\n`;
const store = { sourcePackage: "sales" as string | null };
vi.mock("../../workbookScripts", () => ({
  listWorkbookScripts: async () => [{ id: "macro-1", name: "M43" }],
  getWorkbookScript: async (id: string) => ({
    id,
    name: "M43",
    description: "runtime=objectScript",
    source: SRC,
    sourcePackage: store.sourcePackage,
  }),
}));

/** Behaves like the real realm: setup's call is posted as its own message
 *  BEFORE "mounted", each in a separate task (MessagePort ordering). */
class RealisticWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  terminated = false;
  postMessage(msg: { t: string }): void {
    if (this.terminated) return;
    if (msg.t === "mount") {
      setTimeout(() => {
        if (this.terminated) return;
        h.log.push("worker->call base.notify");
        this.onmessage?.({ data: { t: "call", callId: 1, method: "base.notify", args: [TOAST, "info"] } } as MessageEvent);
      }, 0);
      setTimeout(() => {
        if (this.terminated) return;
        h.log.push("worker->mounted");
        this.onmessage?.({ data: { t: "mounted", ok: true } } as MessageEvent);
      }, 0);
    }
  }
  terminate(): void {
    h.log.push("worker.terminate");
    this.terminated = true;
  }
}

const g = globalThis as unknown as Record<string, unknown>;
const originalWorker = g.Worker;

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setTimeout(r, 5));
}

async function runOnce(): Promise<void> {
  const { runObjectScriptOnce } = await import("../../objectScriptRunner");
  await runObjectScriptOnce({ name: "M43", source: SRC, scriptId: "macro-1", idPrefix: "macro_macro-1" });
  await settle();
}

beforeEach(() => {
  h.asked.length = 0;
  h.toasts.length = 0;
  h.log.length = 0;
  h.mountAnswer = { recheckWhileRunning: true };
  h.standing = "allow";
  g.Worker = RealisticWorker as unknown as typeof Worker;
});
afterEach(async () => {
  const host = await import("../host");
  host.hostResetAll();
  g.Worker = originalWorker;
});

describe("BUG-0267: \"mounted\" never overtakes a call the realm made before it", () => {
  it("a distributed one-off run in a WORKING COPY delivers setup's notify before the runner unmounts", async () => {
    store.sourcePackage = "sales";
    await runOnce();
    expect(h.asked, "precondition: the realm was under the standing recheck").toContain("standing");
    expect(h.toasts.map((t) => t.message), `the call was discarded; host log: ${JSON.stringify(h.log)}`).toContain(TOAST);
    // ORDER: the toast lands before the realm is torn down.
    const toastAt = h.log.indexOf(`toast:${TOAST}`);
    const terminateAt = h.log.indexOf("worker.terminate");
    expect(toastAt, "no toast in the host log").toBeGreaterThanOrEqual(0);
    expect(terminateAt, "the runner never unmounted").toBeGreaterThan(toastAt);
  });

  it("a standing REFUSAL still ends the realm: the held call is not delivered, and the run says it was stopped", async () => {
    store.sourcePackage = "sales";
    h.standing = "refuse";
    const { runObjectScriptOnce } = await import("../../objectScriptRunner");
    await expect(
      runObjectScriptOnce({ name: "M43", source: SRC, scriptId: "macro-1", idPrefix: "macro_macro-1" }),
    ).rejects.toThrow();
    await settle();
    expect(h.toasts.map((t) => t.message), "a refused realm's call was delivered").not.toContain(TOAST);
    expect(
      h.toasts.some((t) => t.variant === "error" && /was stopped/.test(t.message)),
      `the refusal was silent; toasts: ${JSON.stringify(h.toasts)}`,
    ).toBe(true);
  });

  it("CONTROL: a LOCAL module keeps today's timing and shows the toast", async () => {
    store.sourcePackage = null;
    await runOnce();
    expect(h.asked, "a local run never asks the standing question").not.toContain("standing");
    expect(h.toasts.map((t) => t.message)).toContain(TOAST);
  });

  it("CONTROL: a distributed module that is NOT under the recheck (a plain subscriber) shows the toast", async () => {
    store.sourcePackage = "sales";
    h.mountAnswer = { recheckWhileRunning: false };
    await runOnce();
    expect(h.asked, "precondition: no standing question for an unrechecked realm").not.toContain("standing");
    expect(h.toasts.map((t) => t.message)).toContain(TOAST);
  });
});
