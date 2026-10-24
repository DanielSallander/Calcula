//! FILENAME: app/src/api/notifications.ts
// PURPOSE: Public notification API for extensions.
// CONTEXT: Extensions call showToast() to display ephemeral messages.
//          The API owns the contract; the Shell provides the implementation by
//          registering a sink (registerToastSink) at startup — the API never
//          imports the Shell (layering: shell -> api -> core).
//
//          A TOAST CAN BE TAKEN BACK (review round 9, F4). showToast returns a
//          ToastHandle whose dismiss() takes the card down at once, so a notice
//          that is true only while a condition lasts -- AutoRecover skipping
//          recovery copies -- can stay up exactly that long, instead of timing
//          out while the condition still holds or staying up after it ended.
//          The sink returns the id it gave the toast, and the Shell registers
//          the matching dismisser beside it.

export interface ToastOptions {
  variant?: "info" | "success" | "warning" | "error";
  /** Alias for `variant` — either name works. */
  type?: "info" | "success" | "warning" | "error";
  /** Auto-dismiss delay in ms. Default: 5000. Use 0 to require manual dismiss. */
  duration?: number;
}

/** A resolved toast, as handed to the registered sink. */
export interface ToastPayload {
  message: string;
  variant: "info" | "success" | "warning" | "error";
  duration: number;
}

/**
 * The toast renderer. It RETURNS THE ID it gave the toast, which is what lets
 * `ToastHandle.dismiss` take that one toast back. A sink that returns nothing
 * (a test's recorder) still shows toasts; they then end only by timing out or
 * by the user's own dismiss.
 */
export type ToastSink = ((toast: ToastPayload) => string) | ((toast: ToastPayload) => void);

/** Takes down the toast the sink gave `id`; nothing when it is already gone. */
export type ToastDismisser = (id: string) => void;

/** What `showToast` returns: the one toast it showed, to take back when it stops being true. */
export interface ToastHandle {
  /**
   * Take the toast down now. A no-op once it is gone (timed out, dismissed by
   * the user, or dismissed before), and when no renderer was registered.
   */
  dismiss(): void;
}

let toastSink: ToastSink | null = null;
let toastDismisser: ToastDismisser | null = null;

/** The handle of a toast nothing can take back. */
const NOTHING_TO_DISMISS: ToastHandle = { dismiss() {} };

/**
 * Register the toast renderer. Called once by the Shell at startup. Inverts the
 * dependency so the API facade never imports the Shell's Toast store.
 *
 * `dismiss` takes down a toast by the id the sink returned; without it, a
 * handle's `dismiss()` does nothing.
 */
export function registerToastSink(sink: ToastSink, dismiss?: ToastDismisser): void {
  toastSink = sink;
  toastDismisser = dismiss ?? null;
}

/**
 * Show a toast notification.
 * @param message - The message to display
 * @param options - Optional variant and duration
 * @returns The toast's handle: `dismiss()` takes it down when what it says
 *          stops being true. Callers that ignore it behave exactly as before.
 */
export function showToast(message: string, options: ToastOptions = {}): ToastHandle {
  const payload: ToastPayload = {
    message,
    variant: options.variant ?? options.type ?? "info",
    duration: options.duration ?? 5000,
  };
  if (!toastSink) {
    // No renderer mounted yet (e.g. very early startup). Don't lose the message.
    console.warn("[notifications] showToast before a sink was registered:", message);
    return NOTHING_TO_DISMISS;
  }
  const id = toastSink(payload);
  // The dismisser registered WITH this sink: the id is that sink's to resolve.
  const dismissWith = toastDismisser;
  if (typeof id !== "string" || id === "" || dismissWith === null) return NOTHING_TO_DISMISS;
  let dismissed = false;
  return {
    dismiss() {
      if (dismissed) return;
      dismissed = true;
      dismissWith(id);
    },
  };
}
