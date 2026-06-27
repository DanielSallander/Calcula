//! FILENAME: app/src/api/notifications.ts
// PURPOSE: Public notification API for extensions.
// CONTEXT: Extensions call showToast() to display ephemeral messages.
//          The API owns the contract; the Shell provides the implementation by
//          registering a sink (registerToastSink) at startup — the API never
//          imports the Shell (layering: shell -> api -> core).

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

export type ToastSink = (toast: ToastPayload) => void;

let toastSink: ToastSink | null = null;

/**
 * Register the toast renderer. Called once by the Shell at startup. Inverts the
 * dependency so the API facade never imports the Shell's Toast store.
 */
export function registerToastSink(sink: ToastSink): void {
  toastSink = sink;
}

/**
 * Show a toast notification.
 * @param message - The message to display
 * @param options - Optional variant and duration
 */
export function showToast(message: string, options: ToastOptions = {}): void {
  const payload: ToastPayload = {
    message,
    variant: options.variant ?? options.type ?? "info",
    duration: options.duration ?? 5000,
  };
  if (toastSink) {
    toastSink(payload);
  } else {
    // No renderer mounted yet (e.g. very early startup). Don't lose the message.
    console.warn("[notifications] showToast before a sink was registered:", message);
  }
}
