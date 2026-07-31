//! FILENAME: app/src/api/scriptHost/scriptDialogs.ts
// PURPOSE: The host half of the `ui.dialog` capability — the awaitable,
//          free-standing MODAL a script uses to ask the user something and
//          branch on the answer (VBA's MsgBox / InputBox / UserForm, minus the
//          machine access). Owns the pending-request registry, the abuse
//          guards, and the deadline. The dialog is PAINTED by trusted app code
//          (ScriptableObjects/components/ScriptDialogPrompt.tsx), which this
//          module reaches the same way the JIT capability prompt does: emit an
//          app event carrying a data-only request, await resolveScriptDialog.
//
// SECURITY
//  * Identity is HOST-supplied. scriptName / scriptOrigin come from the mount
//    handle, never from call arguments, and the renderer states them in chrome
//    the script cannot address. A script-supplied `title` is body content, so a
//    dialog can never present itself as the application itself.
//  * The payload is DATA (see scriptDialogSpec.ts) — no markup crosses, so
//    there is nothing to sanitize and no second sandbox to maintain.
//  * A dismissal ALWAYS resolves (false / null). Escape, the overlay, the close
//    button, a workbook reset and the deadline all land on the same path, so a
//    script awaiting a dialog can never hang on one.
//
// ABUSE GUARDS (§4 of the task; all three are enforced here, not in the UI)
//  1. ONE dialog per script. A second concurrent request from the same script
//     is rejected, not queued — a script cannot stack modals on the user.
//  2. ONE dialog app-wide. A background script (an onDataChange handler, say)
//     cannot interpose a modal while another script's dialog is on screen, and
//     the dialog on screen unambiguously belongs to the script named in it.
//     Rejected, not queued: a queued prompt would surface later, detached from
//     whatever the user was doing — which is precisely the hijack to avoid.
//  3. A DISMISSAL STREAK mutes the script. Three consecutive dialogs the user
//     refused (dismiss/cancel, no confirmation in between) and the script is
//     muted for the session: further requests resolve immediately as dismissed.
//     This is the "prevent this page from creating additional dialogs" escape
//     hatch, applied automatically so the user never has to fight a loop.

import { BrokerError } from "./broker";
import { emitAppEvent } from "../events";
import { UI_DIALOG_DEADLINE_MS } from "./protocol";
import type {
  ScriptDialogFormSpec,
  ScriptDialogPromptOptions,
  ScriptDialogTextOptions,
} from "./scriptDialogSpec";

// ============================================================================
// Wire shapes (host -> renderer -> host)
// ============================================================================

export type ScriptDialogKind = "alert" | "confirm" | "prompt" | "form";

/** The data-only request the trusted renderer receives. */
export interface ScriptDialogRequestPayload {
  requestId: string;
  /** Authoritative identity — from the mount handle, never from the script. */
  scriptId: string;
  scriptName: string;
  /** "local", or the package name for a distributed script. */
  scriptOrigin: string;
  kind: ScriptDialogKind;
  /** alert / confirm / prompt: the question. Absent for a form. */
  message?: string;
  /** alert / confirm presentation. */
  textOptions?: ScriptDialogTextOptions;
  /** prompt presentation + default. */
  promptOptions?: ScriptDialogPromptOptions;
  /** form: the declarative field spec. */
  form?: ScriptDialogFormSpec;
}

/**
 * What the user did. `dismissed` covers Cancel, Escape, the overlay, the close
 * button, the deadline and a workbook reset — one path, so every caller has to
 * handle exactly one "no answer" case.
 */
export type ScriptDialogAnswer =
  | { dismissed: true }
  | { dismissed: false; value: string | Record<string, unknown> | null };

/** The app event the trusted renderer listens for. */
export const SCRIPT_DIALOG_REQUEST_EVENT = "scriptable-objects:script-dialog-request";
/** Emitted by the host when a request stops being showable (deadline / reset),
 *  so the renderer can close a dialog whose answer no longer has anywhere to go. */
export const SCRIPT_DIALOG_CANCELLED_EVENT = "scriptable-objects:script-dialog-cancelled";

// ============================================================================
// Registry + guards
// ============================================================================

/** Consecutive refusals after which a script is muted for the session. */
export const MAX_CONSECUTIVE_DISMISSALS = 3;

interface PendingScriptDialog {
  request: ScriptDialogRequestPayload;
  settle: (answer: ScriptDialogAnswer) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** requestId -> pending. At most one entry (guard 2) but keyed for clarity. */
const pending = new Map<string, PendingScriptDialog>();
/** scriptId -> requestId, so guard 1 is a lookup rather than a scan. */
const pendingByScript = new Map<string, string>();
/** scriptId -> consecutive refusals (guard 3). */
const dismissStreak = new Map<string, number>();
/** Scripts muted for the rest of the session (guard 3 tripped). */
const muted = new Set<string>();

let requestSeq = 0;

/** The DISMISSED answer, in one place so every guard resolves identically. */
const DISMISSED: ScriptDialogAnswer = { dismissed: true };

function clearPending(entry: PendingScriptDialog): void {
  clearTimeout(entry.timer);
  pending.delete(entry.request.requestId);
  if (pendingByScript.get(entry.request.scriptId) === entry.request.requestId) {
    pendingByScript.delete(entry.request.scriptId);
  }
}

/** Record whether the user engaged or refused, and trip the mute at the limit. */
function recordOutcome(scriptId: string, answer: ScriptDialogAnswer): void {
  if (answer.dismissed) {
    const streak = (dismissStreak.get(scriptId) ?? 0) + 1;
    dismissStreak.set(scriptId, streak);
    if (streak >= MAX_CONSECUTIVE_DISMISSALS) muted.add(scriptId);
    return;
  }
  dismissStreak.set(scriptId, 0);
}

/** True while `scriptId` is muted (its dialogs auto-dismiss). */
export function isScriptDialogMuted(scriptId: string): boolean {
  return muted.has(scriptId);
}

/** The request currently on screen, if any (transparency / tests). */
export function getActiveScriptDialog(): ScriptDialogRequestPayload | null {
  for (const entry of pending.values()) return entry.request;
  return null;
}

/**
 * Show a modal and await the user's answer. Rejects (BrokerError) only when a
 * guard refuses to SHOW the dialog; once shown it always resolves.
 */
export function requestScriptDialog(args: {
  scriptId: string;
  scriptName: string;
  scriptOrigin: string;
  kind: ScriptDialogKind;
  message?: string;
  textOptions?: ScriptDialogTextOptions;
  promptOptions?: ScriptDialogPromptOptions;
  form?: ScriptDialogFormSpec;
}): Promise<ScriptDialogAnswer> {
  // Guard 3 — muted: resolve as dismissed rather than throwing, so a loop that
  // ignores errors still gets a definite "no" and stops asking usefully.
  if (muted.has(args.scriptId)) {
    return Promise.resolve(DISMISSED);
  }
  // Guard 1 — one per script.
  if (pendingByScript.has(args.scriptId)) {
    return Promise.reject(
      new BrokerError(
        "HostError",
        "this script already has a dialog open; await the first one before opening another",
      ),
    );
  }
  // Guard 2 — one app-wide.
  const active = getActiveScriptDialog();
  if (active) {
    return Promise.reject(
      new BrokerError(
        "HostError",
        `another script ("${active.scriptName}") is showing a dialog; try again once the user has answered it`,
      ),
    );
  }

  const requestId = `scriptdlg-${++requestSeq}`;
  const request: ScriptDialogRequestPayload = {
    requestId,
    scriptId: args.scriptId,
    scriptName: args.scriptName,
    scriptOrigin: args.scriptOrigin,
    kind: args.kind,
    message: args.message,
    textOptions: args.textOptions,
    promptOptions: args.promptOptions,
    form: args.form,
  };

  return new Promise<ScriptDialogAnswer>((resolve) => {
    let settled = false;
    const settle = (answer: ScriptDialogAnswer): void => {
      if (settled) return;
      settled = true;
      const entry = pending.get(requestId);
      if (entry) clearPending(entry);
      recordOutcome(args.scriptId, answer);
      resolve(answer);
    };

    // The deadline resolves DISMISSED — it never rejects. A user who walked
    // away and a user who pressed Cancel mean the same thing to the script.
    const timer = setTimeout(() => {
      if (pending.has(requestId)) {
        emitAppEvent(SCRIPT_DIALOG_CANCELLED_EVENT, { requestId });
      }
      settle(DISMISSED);
    }, UI_DIALOG_DEADLINE_MS);

    pending.set(requestId, { request, settle, timer });
    pendingByScript.set(args.scriptId, requestId);
    emitAppEvent(SCRIPT_DIALOG_REQUEST_EVENT, request);
  });
}

/** Called by the trusted renderer when the user answers or dismisses. */
export function resolveScriptDialog(requestId: string, answer: ScriptDialogAnswer): void {
  pending.get(requestId)?.settle(answer);
}

/** Convenience for the "closed without answering" path (Escape / overlay / X). */
export function dismissScriptDialog(requestId: string): void {
  resolveScriptDialog(requestId, DISMISSED);
}

/**
 * Drop a script's dialog state on unmount: any dialog it has on screen is
 * dismissed (so the awaiting call settles rather than leaking), and its mute /
 * streak are forgotten — a remounted script starts clean.
 */
export function revokeScriptDialogs(scriptId: string): void {
  const requestId = pendingByScript.get(scriptId);
  if (requestId !== undefined) {
    emitAppEvent(SCRIPT_DIALOG_CANCELLED_EVENT, { requestId });
    dismissScriptDialog(requestId);
  }
  dismissStreak.delete(scriptId);
  muted.delete(scriptId);
}

/** Forget everything (workbook reset / tests). Pending dialogs are dismissed. */
export function resetScriptDialogs(): void {
  for (const requestId of [...pending.keys()]) {
    emitAppEvent(SCRIPT_DIALOG_CANCELLED_EVENT, { requestId });
    dismissScriptDialog(requestId);
  }
  pending.clear();
  pendingByScript.clear();
  dismissStreak.clear();
  muted.clear();
}
