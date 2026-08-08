//! FILENAME: app/src/core/lib/dialogs.ts
// PURPOSE: The ONLY sanctioned way to ask the user a blocking question. Wraps the
//          three browser dialog globals, which are all broken or unreliable under
//          Tauri, behind awaitable helpers that fail CLOSED.
// CONTEXT: A Core primitive ("ask the user something" is as universal as the
//          undo stack), re-exported verbatim by @api/dialogs so Extensions can
//          reach it through the facade — Core stays importable by Shell and Core
//          itself without inventing a core->api edge. The raw globals are banned
//          by the dialog-globals block in eslint.boundaries.js; this file and its
//          @api re-export are the only exemptions.
//
// =============================================================================
// WHY THIS MODULE EXISTS — the defect it retires
// =============================================================================
// tauri-plugin-dialog injects an init script into every webview that REPLACES two
// of the three globals (verbatim, tauri-plugin-dialog-2.7.0/src/init-iife.js):
//
//   window.alert   = function (m) { invoke("plugin:dialog|message", {...}) }
//   window.confirm = async function (m) { return await invoke("plugin:dialog|confirm", {...}) }
//
// Three separate hazards follow, and each has shipped as a bug in this repo:
//
//   1. confirm() RETURNS A PROMISE. `if (!window.confirm(msg)) return;` therefore
//      tests `!Promise` — an object is always truthy, so `!object` is always
//      FALSE and the guard NEVER fires. Every such site proceeds exactly as
//      though the user had pressed OK. Where the guard protected a destructive
//      action, Cancel deleted; where it was a CONSENT gate, Cancel consented.
//      This defect was found and patched at the call site six times before this
//      module existed, and came back each time.
//
//   2. alert() IS FIRE-AND-FORGET. The shim is NOT async: it starts the IPC call
//      and returns `undefined` immediately, so `await window.alert(msg)` does not
//      wait either — awaiting is not a fix. Execution continues past a message
//      the user has not read yet, and the floating invoke promise rejects
//      unobserved if the dialog call fails. `alertAsync` calls the plugin's
//      `message()` directly and awaits THAT, which does block.
//
//   3. prompt() IS NOT REPLACED AT ALL. Whether it works is decided by the
//      WebView2 embedder's script-dialog policy, not by us, and a suppressed
//      prompt returns null indistinguishably from a user cancelling. Two
//      surfaces in this repo (DimensionInputDialog, ConnectSourceDialog) were
//      already rewritten to get away from it. `promptAsync` renders an in-app
//      modal instead, so the result is ours and is the same in every window.
//
// FAIL-CLOSED IS THE CONTRACT. Every helper resolves to the REFUSING value
// (false / null) when it cannot get a real answer — no window, no dialog
// surface, an IPC failure. A consent gate built on these must be able to treat
// "something went wrong" as "the user did not agree".

import { confirm as tauriConfirm, message as tauriMessage } from "@tauri-apps/plugin-dialog";

/** Presentation options common to `confirmAsync` and `alertAsync`. */
export interface DialogTextOptions {
  /** Window/title-bar text. Defaults to the app name chosen by the platform. */
  title?: string;
  /** Icon + severity styling of the native box. */
  kind?: "info" | "warning" | "error";
}

/** Presentation options for `confirmAsync`. */
export interface ConfirmOptions extends DialogTextOptions {
  /** Label of the affirmative button. Default "Ok". */
  okLabel?: string;
  /** Label of the refusing button. Default "Cancel". */
  cancelLabel?: string;
}

/** Presentation options for `promptAsync`. */
export interface PromptOptions {
  /** Heading above the message. Default "Calcula". */
  title?: string;
  /** Pre-filled text; also the value returned if the user just presses Enter. */
  defaultValue?: string;
  /** Label of the affirmative button. Default "OK". */
  okLabel?: string;
  /** Label of the refusing button. Default "Cancel". */
  cancelLabel?: string;
  /** Renders the field as a password box. */
  password?: boolean;
}

/** True when the Tauri IPC bridge is present (i.e. we are in the real app, not
 *  jsdom or a plain browser). Read lazily: the bridge is installed by an init
 *  script that may land after this module is evaluated. */
function hasTauriBridge(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Ask a yes/no question and WAIT for the answer.
 *
 * Resolves `true` only on an explicit affirmative. Anything else — Cancel, a
 * closed window, an IPC error, no window at all — resolves `false`. Callers may
 * therefore write the natural guard and have it mean what it says:
 *
 *     if (!(await confirmAsync("Delete this?"))) return;
 *
 * NEVER call this without awaiting it; the return value is the whole point.
 */
export async function confirmAsync(message: string, options?: ConfirmOptions): Promise<boolean> {
  if (typeof window === "undefined") return false;

  if (hasTauriBridge()) {
    try {
      // Native modal via the plugin. Returns a real boolean.
      return (
        (await tauriConfirm(message, {
          title: options?.title,
          kind: options?.kind,
          okLabel: options?.okLabel,
          cancelLabel: options?.cancelLabel,
        })) === true
      );
    } catch {
      // The dialog could not be shown. We have no answer, so we do not have
      // consent. Fail closed rather than guess.
      return false;
    }
  }

  // jsdom (unit tests) and the browser-only visual smoke: the platform's own
  // synchronous confirm. Awaiting a boolean is harmless and keeps one code path.
  // eslint-disable-next-line no-restricted-properties, no-restricted-globals
  if (typeof window.confirm !== "function") return false;
  try {
    // eslint-disable-next-line no-restricted-properties, no-restricted-globals
    return (await window.confirm(message)) === true;
  } catch {
    return false;
  }
}

/**
 * Show a message and WAIT until the user has dismissed it.
 *
 * Unlike the raw global this genuinely blocks under Tauri, so a caller that
 * reports a failure and then navigates away cannot race the message off screen.
 * Rejections are swallowed: a message box that could not be shown must never
 * become an unhandled rejection in the caller's handler.
 */
export async function alertAsync(message: string, options?: DialogTextOptions): Promise<void> {
  if (typeof window === "undefined") return;

  if (hasTauriBridge()) {
    try {
      await tauriMessage(message, { title: options?.title, kind: options?.kind });
      return;
    } catch {
      return;
    }
  }

  // eslint-disable-next-line no-restricted-properties, no-restricted-globals
  if (typeof window.alert !== "function") return;
  try {
    // eslint-disable-next-line no-restricted-properties, no-restricted-globals
    window.alert(message);
  } catch {
    /* a headless environment that stubs alert as a thrower must not break the caller */
  }
}

// =============================================================================
// promptAsync — an in-app modal, because there is no native one
// =============================================================================
// Built from raw DOM rather than React on purpose: this has to work identically
// in all five webview entry points (main, Model Editor, Object Script, Package
// Inspector, Chart Spec Editor) without any of them mounting a provider, and it
// has to work in jsdom so the helper itself is testable. It reads the skin's CSS
// custom properties with literal fallbacks, so it is themed where a theme exists
// and legible where one does not.

/** Attribute marking the overlay root, so tests and E2E can find it. */
export const PROMPT_DIALOG_ATTR = "data-calcula-prompt";

export async function promptAsync(message: string, options?: PromptOptions): Promise<string | null> {
  if (typeof document === "undefined" || !document.body) return null;

  const okLabel = options?.okLabel ?? "OK";
  const cancelLabel = options?.cancelLabel ?? "Cancel";

  return new Promise<string | null>((resolve) => {
    const overlay = document.createElement("div");
    overlay.setAttribute(PROMPT_DIALOG_ATTR, "");
    overlay.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:2147483600",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "background:rgba(0,0,0,0.32)",
    ].join(";");

    const box = document.createElement("div");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.style.cssText = [
      "min-width:340px",
      "max-width:520px",
      "padding:16px 18px",
      "border-radius:6px",
      "box-shadow:0 10px 34px rgba(0,0,0,0.35)",
      "font-family:'Segoe UI',system-ui,sans-serif",
      "font-size:13px",
      "background:var(--panel-bg,#ffffff)",
      "color:var(--text-primary,#1a1a1a)",
      "border:1px solid var(--border-color,#d5d5d5)",
    ].join(";");

    const heading = document.createElement("div");
    heading.textContent = options?.title ?? "Calcula";
    heading.style.cssText = "font-weight:600;margin-bottom:10px;";

    const label = document.createElement("label");
    label.textContent = message;
    label.style.cssText = "display:block;white-space:pre-wrap;margin-bottom:10px;";

    const input = document.createElement("input");
    input.type = options?.password ? "password" : "text";
    input.value = options?.defaultValue ?? "";
    input.style.cssText = [
      "width:100%",
      "box-sizing:border-box",
      "padding:5px 7px",
      "font:inherit",
      "border-radius:3px",
      "background:var(--input-bg,#ffffff)",
      "color:var(--text-primary,#1a1a1a)",
      "border:1px solid var(--border-color,#b8b8b8)",
    ].join(";");
    label.appendChild(input);

    const buttons = document.createElement("div");
    buttons.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:14px;";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = cancelLabel;
    cancelBtn.style.cssText =
      "padding:5px 14px;font:inherit;border-radius:3px;cursor:pointer;" +
      "background:transparent;color:var(--text-primary,#1a1a1a);" +
      "border:1px solid var(--border-color,#b8b8b8);";

    const okBtn = document.createElement("button");
    okBtn.type = "button";
    okBtn.textContent = okLabel;
    okBtn.style.cssText =
      "padding:5px 14px;font:inherit;border-radius:3px;cursor:pointer;border:1px solid transparent;" +
      "background:var(--accent-primary,#2563eb);color:#ffffff;";

    buttons.append(cancelBtn, okBtn);
    box.append(heading, label, buttons);
    overlay.appendChild(box);

    let settled = false;
    const settle = (value: string | null) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKeyDown, true);
      overlay.remove();
      resolve(value);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        settle(null);
      } else if (e.key === "Enter" && document.activeElement === input) {
        e.preventDefault();
        e.stopPropagation();
        settle(input.value);
      }
    };

    cancelBtn.addEventListener("click", () => settle(null));
    okBtn.addEventListener("click", () => settle(input.value));
    // Clicking the backdrop is a cancel, matching every other modal in the app.
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) settle(null);
    });
    // Capture phase: the grid installs document-level key handlers and would
    // otherwise steal Escape/Enter while the modal is up.
    document.addEventListener("keydown", onKeyDown, true);

    document.body.appendChild(overlay);
    input.focus();
    input.select();
  });
}
