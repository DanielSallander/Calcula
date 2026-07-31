//! FILENAME: app/src/api/scriptHost/__tests__/scriptDialogs.test.ts
// PURPOSE: The awaitable half of the ui.dialog capability — resolution,
//          dismissal, and the three abuse guards.
// CONTEXT: The invariant worth the most here is that a shown dialog ALWAYS
//          settles. A script that awaits `caps.dialog.confirm(...)` and never
//          gets an answer is a hung script with a modal on screen, so every
//          exit — answer, dismiss, deadline, unmount, workbook reset — is
//          asserted to resolve, and dismissal is asserted to resolve as a "no"
//          rather than as anything a caller might read as consent.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  requestScriptDialog,
  resolveScriptDialog,
  dismissScriptDialog,
  getActiveScriptDialog,
  isScriptDialogMuted,
  resetScriptDialogs,
  revokeScriptDialogs,
  MAX_CONSECUTIVE_DISMISSALS,
  SCRIPT_DIALOG_REQUEST_EVENT,
  SCRIPT_DIALOG_CANCELLED_EVENT,
  type ScriptDialogRequestPayload,
} from "../scriptDialogs";
import {
  CALL_TIMEOUT_MS,
  CLASS_DEADLINES_MS,
  METHOD_DEADLINES_MS,
  UI_DIALOG_DEADLINE_MS,
  callDeadlineMs,
} from "../protocol";
import { ALLOWLIST } from "../allowlist";
import { BrokerError } from "../broker";

/** Capture the request the trusted renderer would receive. */
function captureRequests(): { seen: ScriptDialogRequestPayload[]; stop: () => void } {
  const seen: ScriptDialogRequestPayload[] = [];
  const handler = (e: Event) => seen.push((e as CustomEvent).detail as ScriptDialogRequestPayload);
  window.addEventListener(SCRIPT_DIALOG_REQUEST_EVENT, handler);
  return { seen, stop: () => window.removeEventListener(SCRIPT_DIALOG_REQUEST_EVENT, handler) };
}

const ASK = {
  scriptId: "s1",
  scriptName: "Month-end close",
  scriptOrigin: "local",
  kind: "confirm" as const,
  message: "Delete 40 rows?",
};

describe("scriptDialogs — request/answer round trip", () => {
  let capture: ReturnType<typeof captureRequests>;

  beforeEach(() => {
    resetScriptDialogs();
    capture = captureRequests();
  });
  afterEach(() => {
    capture.stop();
    resetScriptDialogs();
  });

  it("emits a data-only request carrying HOST-supplied identity", async () => {
    const promise = requestScriptDialog(ASK);
    expect(capture.seen).toHaveLength(1);
    const request = capture.seen[0];
    expect(request.scriptName).toBe("Month-end close");
    expect(request.scriptOrigin).toBe("local");
    expect(request.kind).toBe("confirm");
    expect(request.message).toBe("Delete 40 rows?");
    expect(request.requestId).toBeTruthy();

    resolveScriptDialog(request.requestId, { dismissed: false, value: null });
    await expect(promise).resolves.toEqual({ dismissed: false, value: null });
  });

  it("resolves with the value the renderer reports", async () => {
    const promise = requestScriptDialog({ ...ASK, kind: "prompt", message: "Name?" });
    resolveScriptDialog(capture.seen[0].requestId, { dismissed: false, value: "Ada" });
    await expect(promise).resolves.toEqual({ dismissed: false, value: "Ada" });
  });

  it("resolves a form answer object", async () => {
    const promise = requestScriptDialog({ ...ASK, kind: "form", message: undefined });
    resolveScriptDialog(capture.seen[0].requestId, { dismissed: false, value: { rate: 1.5 } });
    await expect(promise).resolves.toEqual({ dismissed: false, value: { rate: 1.5 } });
  });

  it("dismissal RESOLVES (never rejects, never hangs)", async () => {
    const promise = requestScriptDialog(ASK);
    dismissScriptDialog(capture.seen[0].requestId);
    await expect(promise).resolves.toEqual({ dismissed: true });
  });

  it("ignores a second resolution — one settle per request", async () => {
    const promise = requestScriptDialog(ASK);
    const { requestId } = capture.seen[0];
    resolveScriptDialog(requestId, { dismissed: false, value: "first" });
    resolveScriptDialog(requestId, { dismissed: false, value: "second" });
    dismissScriptDialog(requestId);
    await expect(promise).resolves.toEqual({ dismissed: false, value: "first" });
  });

  it("resolving an unknown requestId is a no-op, not a throw", () => {
    expect(() => resolveScriptDialog("scriptdlg-nope", { dismissed: true })).not.toThrow();
  });

  it("clears the active slot once answered, so the next request can show", async () => {
    const first = requestScriptDialog(ASK);
    expect(getActiveScriptDialog()?.scriptName).toBe("Month-end close");
    resolveScriptDialog(capture.seen[0].requestId, { dismissed: false, value: null });
    await first;
    expect(getActiveScriptDialog()).toBeNull();
    const second = requestScriptDialog(ASK);
    expect(capture.seen).toHaveLength(2);
    dismissScriptDialog(capture.seen[1].requestId);
    await second;
  });
});

describe("scriptDialogs — abuse guards", () => {
  let capture: ReturnType<typeof captureRequests>;

  beforeEach(() => {
    resetScriptDialogs();
    capture = captureRequests();
  });
  afterEach(() => {
    capture.stop();
    resetScriptDialogs();
  });

  it("guard 1: a script cannot stack a second dialog on the user", async () => {
    const first = requestScriptDialog(ASK);
    await expect(requestScriptDialog(ASK)).rejects.toBeInstanceOf(BrokerError);
    // The rejected attempt must not have reached the renderer.
    expect(capture.seen).toHaveLength(1);
    dismissScriptDialog(capture.seen[0].requestId);
    await first;
  });

  it("guard 2: a BACKGROUND script cannot interpose while another's dialog is up", async () => {
    const first = requestScriptDialog(ASK);
    const attempt = requestScriptDialog({ ...ASK, scriptId: "s2", scriptName: "Background sync" });
    await expect(attempt).rejects.toThrow(/Month-end close/);
    // Rejected, NOT queued: nothing may surface later, detached from context.
    expect(capture.seen).toHaveLength(1);
    dismissScriptDialog(capture.seen[0].requestId);
    await first;
    expect(capture.seen).toHaveLength(1);
  });

  it("guard 3: N consecutive dismissals mute the script; further asks auto-dismiss", async () => {
    for (let i = 0; i < MAX_CONSECUTIVE_DISMISSALS; i++) {
      const promise = requestScriptDialog(ASK);
      dismissScriptDialog(capture.seen[i].requestId);
      await expect(promise).resolves.toEqual({ dismissed: true });
    }
    expect(isScriptDialogMuted("s1")).toBe(true);
    const shown = capture.seen.length;
    // Muted: resolves as dismissed WITHOUT bothering the user again.
    await expect(requestScriptDialog(ASK)).resolves.toEqual({ dismissed: true });
    expect(capture.seen).toHaveLength(shown);
  });

  it("an answered dialog resets the streak, so an engaged user is never muted", async () => {
    for (let i = 0; i < MAX_CONSECUTIVE_DISMISSALS - 1; i++) {
      const p = requestScriptDialog(ASK);
      dismissScriptDialog(capture.seen[capture.seen.length - 1].requestId);
      await p;
    }
    const answered = requestScriptDialog(ASK);
    resolveScriptDialog(capture.seen[capture.seen.length - 1].requestId, { dismissed: false, value: null });
    await answered;

    for (let i = 0; i < MAX_CONSECUTIVE_DISMISSALS - 1; i++) {
      const p = requestScriptDialog(ASK);
      dismissScriptDialog(capture.seen[capture.seen.length - 1].requestId);
      await p;
    }
    expect(isScriptDialogMuted("s1")).toBe(false);
  });

  it("a mute is per script — a well-behaved script is not punished for a noisy one", async () => {
    for (let i = 0; i < MAX_CONSECUTIVE_DISMISSALS; i++) {
      const p = requestScriptDialog(ASK);
      dismissScriptDialog(capture.seen[capture.seen.length - 1].requestId);
      await p;
    }
    expect(isScriptDialogMuted("s1")).toBe(true);
    expect(isScriptDialogMuted("s2")).toBe(false);
    const other = requestScriptDialog({ ...ASK, scriptId: "s2", scriptName: "Other" });
    expect(getActiveScriptDialog()?.scriptName).toBe("Other");
    dismissScriptDialog(capture.seen[capture.seen.length - 1].requestId);
    await other;
  });
});

describe("scriptDialogs — withdrawal paths", () => {
  let capture: ReturnType<typeof captureRequests>;
  let cancelled: string[];
  let cancelHandler: (e: Event) => void;

  beforeEach(() => {
    resetScriptDialogs();
    capture = captureRequests();
    cancelled = [];
    cancelHandler = (e: Event) => cancelled.push(((e as CustomEvent).detail as { requestId: string }).requestId);
    window.addEventListener(SCRIPT_DIALOG_CANCELLED_EVENT, cancelHandler);
  });
  afterEach(() => {
    capture.stop();
    window.removeEventListener(SCRIPT_DIALOG_CANCELLED_EVENT, cancelHandler);
    resetScriptDialogs();
  });

  it("the deadline resolves DISMISSED and tells the renderer to close", async () => {
    vi.useFakeTimers();
    try {
      const promise = requestScriptDialog(ASK);
      const { requestId } = capture.seen[0];
      vi.advanceTimersByTime(UI_DIALOG_DEADLINE_MS + 1);
      await expect(promise).resolves.toEqual({ dismissed: true });
      expect(cancelled).toEqual([requestId]);
      expect(getActiveScriptDialog()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the deadline is far longer than the ordinary 30s call timeout", () => {
    expect(UI_DIALOG_DEADLINE_MS).toBeGreaterThan(30_000);
  });

  it("unmounting the script dismisses its dialog and forgets its mute", async () => {
    const promise = requestScriptDialog(ASK);
    revokeScriptDialogs("s1");
    await expect(promise).resolves.toEqual({ dismissed: true });
    expect(cancelled).toHaveLength(1);
    expect(getActiveScriptDialog()).toBeNull();
    // The dismissal that unmounting caused must not count against the script.
    expect(isScriptDialogMuted("s1")).toBe(false);
  });

  it("a workbook reset settles every pending dialog", async () => {
    const promise = requestScriptDialog(ASK);
    resetScriptDialogs();
    await expect(promise).resolves.toEqual({ dismissed: true });
    expect(getActiveScriptDialog()).toBeNull();
  });
});

// ============================================================================
// Policy pinning: the "ui" method class and its deadline
// ============================================================================
//
// The worker cannot import the ALLOWLIST (policy must not ride into the
// sandbox bundle), so protocol.ts names the long-deadline methods by hand.
// That hand-maintained list is exactly what these tests pin: add a fifth
// ui.dialog method and forget its deadline, and the 30s timer would abandon
// the call while the user was still reading the modal.

describe("ui method class", () => {
  const uiMethods = Object.entries(ALLOWLIST)
    .filter(([, policy]) => policy.class === "ui")
    .map(([method]) => method)
    .sort();

  it("is exactly the ui.dialog family", () => {
    expect(uiMethods).toEqual(["cap.dialogAlert", "cap.dialogConfirm", "cap.dialogForm", "cap.dialogPrompt"]);
  });

  it("every ui method is restricted-tier and gated by the ui.dialog capability", () => {
    for (const method of uiMethods) {
      expect(ALLOWLIST[method].tier, method).toBe("restricted");
      expect(ALLOWLIST[method].capability, method).toBe("ui.dialog");
    }
  });

  it("every ui method carries consent text written for a person", () => {
    for (const method of uiMethods) {
      const desc = ALLOWLIST[method].desc;
      expect(desc.length, method).toBeGreaterThan(20);
      // No method names, no capability ids — the consent line is what the user
      // reads, not what the programmer calls it.
      expect(desc, method).not.toMatch(/cap\.|ui\.dialog|\(\)/);
    }
  });

  it("the per-method worker deadlines cover exactly the ui methods", () => {
    expect(Object.keys(METHOD_DEADLINES_MS).sort()).toEqual(uiMethods);
    for (const method of uiMethods) {
      expect(callDeadlineMs(method), method).toBe(CLASS_DEADLINES_MS.ui);
      expect(callDeadlineMs(method), method).toBe(UI_DIALOG_DEADLINE_MS);
    }
  });

  it("leaves every other method on the ordinary call timeout", () => {
    expect(callDeadlineMs("api.setCellValue")).toBe(CALL_TIMEOUT_MS);
    expect(callDeadlineMs("cap.fetch")).toBe(CALL_TIMEOUT_MS);
    expect(callDeadlineMs("not.a.method")).toBe(CALL_TIMEOUT_MS);
  });
});
