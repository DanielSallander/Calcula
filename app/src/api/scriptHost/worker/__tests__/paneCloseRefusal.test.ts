//! FILENAME: app/src/api/scriptHost/worker/__tests__/paneCloseRefusal.test.ts
// PURPOSE: The SHIM half of `pane.close()` (M3c). The host refuses the call for
//          a form the user EMBEDDED on a sheet — the surface stays up — so the
//          `form.pane` facet must still be pointing at it afterwards.
// CONTEXT: `close()` used to clear `paneState.currentId` unconditionally, right
//          after a FIRE-AND-FORGET `callFire`. `callFire` only console-warns a
//          rejection, so on the refusal path the surface stayed on screen while
//          the shim forgot its id: every later `pane.update` / `setBadge` /
//          `control(...).set(...)` went out naming the EMPTY id (refused again,
//          warned again) and `pane.isOpen` / `pane.values` reported a closed
//          pane while the user was typing in the open one. The refusal sentence
//          names `pane.update(...)` as the remedy, and the clear was what made
//          `pane.update` stop naming a surface.
//
//          The host side of that refusal is pinned by
//          `__tests__/embeddedFormSessions.test.ts` ("refuses pane.close, and
//          the refusal names what the script CAN do"), which drives the broker
//          row directly with a stub worker and therefore never observes the
//          shim's own state. This file is the other half: the REAL shim, driven
//          through `context.form.pane`, with the host's answer supplied by hand.

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildWorkerContext, getExposedHandler, applyMirror, type WorkerRuntime } from "../contextShims";
import type { MountSpec, W2H } from "../../protocol";

/**
 * The sentence `closeScriptPane` throws for an embedded session
 * (`scriptHost/scriptPanes.ts`). Repeated as a literal on purpose: this file
 * asserts what the SHIM does with a rejected close, and it must keep doing it
 * whoever rewrites the wording. `embeddedFormSessions.test.ts` is what pins the
 * wording itself against the host.
 */
const EMBEDDED_REFUSAL =
  "this form is embedded on a sheet: a script cannot remove a surface the user placed. " +
  "Use pane.update(...) to change what it shows; the user deletes it from the sheet.";

interface PostedCall {
  callId: number;
  method: string;
  args: unknown[];
}

/** The members of `context.pane` this file drives (the shim's own facet is untyped). */
interface PaneFacet {
  dock(options?: { initial?: Record<string, unknown>; key?: string }): Promise<{
    paneId: string;
    opened: boolean;
    placement: string;
  }>;
  update(patch: Record<string, unknown>): void;
  setBadge(badge: string | null): void;
  close(): void;
  control(name: string): { setText(text: string): void };
  readonly paneId: string | null;
  readonly values: Record<string, unknown>;
  readonly isOpen: boolean;
}

/** A restricted form mount with `ui.pane`, wired to a host that answers by hand. */
function formContext(): {
  pane: PaneFacet;
  rt: WorkerRuntime;
  calls: PostedCall[];
} {
  const spec: MountSpec = {
    protocolVersion: 1,
    scriptId: "s1",
    objectType: "form",
    instanceId: "form-1",
    tier: "restricted",
    capabilities: ["ui.pane"],
    apiVersion: "1.0",
    source: "",
    scriptName: "Report",
    snapshot: {},
  };
  const calls: PostedCall[] = [];
  const { context, rt } = buildWorkerContext(spec, (msg: W2H) => {
    if (msg.t === "call") calls.push({ callId: msg.callId, method: msg.method, args: msg.args });
  });
  return { pane: (context as unknown as { pane: PaneFacet }).pane, rt, calls };
}

/** The host's `__pane_opened` relay: how an EMBEDDED surface hands the shim its id. */
function relayOpened(rt: WorkerRuntime, paneId: string): void {
  const handler = getExposedHandler(rt, "__pane_opened");
  if (!handler) throw new Error("the shim no longer exposes __pane_opened");
  handler({ paneId });
}

/** The host's `__pane_closed` relay: the ONLY thing that may clear the facet's id. */
function relayClosed(rt: WorkerRuntime, paneId: string, reason: string): void {
  const handler = getExposedHandler(rt, "__pane_closed");
  if (!handler) throw new Error("the shim no longer exposes __pane_closed");
  handler({ paneId, reason });
}

const lastCall = (calls: PostedCall[], method: string): unknown[] | undefined =>
  [...calls].reverse().find((c) => c.method === method)?.args;

/** Let the `callFire` catch (and any awaited settlement) run. */
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pane.close() on an EMBEDDED surface: the facet keeps the id the host refused to close", () => {
  it("keeps addressing the surface — update, setBadge and control() all still name it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { pane, rt, calls } = formContext();

    // The user placed this form on a sheet; the host opened its session and
    // relayed the id (there was no dock() to return one).
    relayOpened(rt, "pane-7");
    expect(pane.paneId).toBe("pane-7");

    // A "Done" button handler calls close(). The call goes out naming the
    // surface...
    pane.close();
    const closeCall = calls.find((c) => c.method === "pane.close");
    expect(closeCall?.args).toEqual(["pane-7"]);

    // ...and the host REFUSES it, because the user owns that surface.
    rt.settleCall(closeCall!.callId, false, undefined, { code: "HostError", message: EMBEDDED_REFUSAL });
    await flush();

    // The rejection really was delivered (otherwise the rest of this test would
    // be asserting against a call nobody answered).
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("embedded on a sheet");

    // THE DEFECT: the surface is still on screen, so the facet must still name
    // it. An empty id here is a script that can never speak to its own form
    // again — refused by `owned()` with "this script has no pane \"\"", and
    // refused only to the console.
    expect(pane.paneId).toBe("pane-7");

    pane.update({ message: "hi" });
    expect(lastCall(calls, "pane.update")).toEqual(["pane-7", { message: "hi" }]);

    pane.setBadge("3");
    expect(lastCall(calls, "pane.setBadge")).toEqual(["pane-7", "3"]);

    pane.control("total").setText("x");
    expect(lastCall(calls, "pane.update")).toEqual(["pane-7", { controls: { total: { text: "x" } } }]);
  });

  it("does not lie about the surface: isOpen and values keep mirroring the live pane", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { pane, rt, calls } = formContext();
    relayOpened(rt, "pane-7");
    applyMirror(rt, "pane.isOpen.pane-7", true);
    applyMirror(rt, "pane.values.pane-7", { total: 42 });

    pane.close();
    const closeCall = calls.find((c) => c.method === "pane.close")!;
    rt.settleCall(closeCall.callId, false, undefined, { code: "HostError", message: EMBEDDED_REFUSAL });
    await flush();

    // The user is typing in it. Both mirrors are keyed on the facet's id, so a
    // forgotten id turns them into a closed, empty pane that does not exist.
    expect(pane.isOpen).toBe(true);
    expect(pane.values).toEqual({ total: 42 });
  });
});

describe("pane.close() on a DOCKED pane: the host's relay is what clears the facet", () => {
  it("clears the id when the close ACTUALLY happened, not when it was merely asked for", async () => {
    const { pane, rt, calls } = formContext();

    // dock() resolves with the id the host minted.
    const docking = pane.dock();
    const dockCall = calls.find((c) => c.method === "pane.dock")!;
    rt.settleCall(dockCall.callId, true, { paneId: "pane-1", opened: true, placement: "sidebar" }, undefined);
    await docking;
    expect(pane.paneId).toBe("pane-1");
    applyMirror(rt, "pane.isOpen.pane-1", true);

    pane.close();
    const closeCall = calls.find((c) => c.method === "pane.close")!;
    expect(closeCall.args).toEqual(["pane-1"]);
    rt.settleCall(closeCall.callId, true, undefined, undefined);
    await flush();

    // `endSession` mirrors the pane shut and relays `__pane_closed` — THAT is
    // the clear. It fires for every close the pane's document survives (the
    // band's X and an unmount included), which is why the shim needs none of
    // its own.
    applyMirror(rt, "pane.isOpen.pane-1", false);
    relayClosed(rt, "pane-1", "script");
    expect(pane.paneId).toBeNull();
    expect(pane.isOpen).toBe(false);
  });
});
