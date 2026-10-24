//! FILENAME: app/src/shell/Toast/useToastStore.ts
// PURPOSE: Zustand store for toast notification state.
// CONTEXT: Manages a queue of toast messages displayed at the bottom-right of the app.

import { create } from "zustand";
import { registerToastSink } from "@api/notifications";
import {
  lifecycleCancelMessage,
  registerLifecycleCancelReporter,
} from "@api/lifecycleGuards";

export interface ToastItem {
  id: string;
  message: string;
  variant: "info" | "success" | "warning" | "error";
  /** Auto-dismiss delay in ms (0 = no auto-dismiss) */
  duration: number;
}

interface ToastState {
  toasts: ToastItem[];
  /** Show a toast; returns the id it was given, which `removeToast` takes back. */
  addToast: (toast: Omit<ToastItem, "id">) => string;
  /** Take a toast down by its id; nothing when it is already gone. */
  removeToast: (id: string) => void;
}

let nextId = 1;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  addToast: (toast) => {
    const id = `toast-${nextId++}`;
    set((state) => ({
      toasts: [...state.toasts, { ...toast, id }],
    }));
    if (toast.duration > 0) {
      setTimeout(() => {
        set((state) => ({
          toasts: state.toasts.filter((t) => t.id !== id),
        }));
      }, toast.duration);
    }
    return id;
  },
  removeToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    })),
}));

// Provide the implementation for the API's showToast() — the Shell owns the
// renderer, the API owns the contract (registerToastSink). Registered at module
// load (the ToastContainer in Layout imports this store at app startup). The
// sink returns the id addToast gave the toast, and the dismisser beside it is
// what a ToastHandle's dismiss() calls, so a caller can take its toast back.
registerToastSink(
  (toast) => useToastStore.getState().addToast(toast),
  (id) => useToastStore.getState().removeToast(id),
);

// A script that cancels a save or a close must be VISIBLE — otherwise Ctrl+S
// looks broken. Core owns the veto choke point but cannot render; the Shell
// supplies the renderer here, the same inversion registerToastSink uses.
registerLifecycleCancelReporter((action, result) => {
  useToastStore.getState().addToast({
    message: lifecycleCancelMessage(action, result),
    variant: "warning",
    duration: 8000,
  });
});
