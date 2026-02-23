//! FILENAME: app/src/api/notifications.ts
// PURPOSE: Public notification API for extensions.
// CONTEXT: Extensions call showToast() to display ephemeral messages.

import { useToastStore } from "../shell/Toast/useToastStore";

export interface ToastOptions {
  variant?: "info" | "success" | "warning" | "error";
  /** Auto-dismiss delay in ms. Default: 5000. Use 0 to require manual dismiss. */
  duration?: number;
}

/**
 * Show a toast notification.
 * @param message - The message to display
 * @param options - Optional variant and duration
 */
export function showToast(message: string, options: ToastOptions = {}): void {
  useToastStore.getState().addToast({
    message,
    variant: options.variant ?? "info",
    duration: options.duration ?? 5000,
  });
}
