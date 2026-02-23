//! FILENAME: app/src/shell/Toast/useToastStore.ts
// PURPOSE: Zustand store for toast notification state.
// CONTEXT: Manages a queue of toast messages displayed at the bottom-right of the app.

import { create } from "zustand";

export interface ToastItem {
  id: string;
  message: string;
  variant: "info" | "success" | "warning" | "error";
  /** Auto-dismiss delay in ms (0 = no auto-dismiss) */
  duration: number;
}

interface ToastState {
  toasts: ToastItem[];
  addToast: (toast: Omit<ToastItem, "id">) => void;
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
  },
  removeToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    })),
}));
