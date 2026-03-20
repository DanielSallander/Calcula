//! FILENAME: app/src/shell/ActivityBar/useActivityBarStore.ts
// PURPOSE: Zustand store for Activity Bar state management
// CONTEXT: Manages side panel visibility, width, and active view selection

import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Activity Bar store state.
 */
export interface ActivityBarState {
  /** Whether the side panel is expanded */
  isOpen: boolean;
  /** Currently selected activity view ID */
  activeViewId: string | null;
  /** Side panel width in pixels */
  width: number;
  /** Minimum width constraint */
  minWidth: number;
  /** Maximum width constraint */
  maxWidth: number;
}

/**
 * Activity Bar store actions.
 */
export interface ActivityBarActions {
  /** Open the side panel with the given view */
  openView: (viewId: string, data?: Record<string, unknown>) => void;
  /** Close the side panel */
  close: () => void;
  /** Toggle the side panel. If viewId is provided and differs from active, switch to it. */
  toggle: (viewId?: string) => void;
  /** Set the panel width */
  setWidth: (width: number) => void;
  /** Reset all state */
  reset: () => void;
}

const DEFAULT_WIDTH = 280;
const MIN_WIDTH = 200;
const MAX_WIDTH = 480;

const initialState: ActivityBarState = {
  isOpen: false,
  activeViewId: null,
  width: DEFAULT_WIDTH,
  minWidth: MIN_WIDTH,
  maxWidth: MAX_WIDTH,
};

/**
 * Activity Bar store with persistence.
 * VS Code toggle behavior: clicking same icon toggles, clicking different icon switches.
 */
export const useActivityBarStore = create<ActivityBarState & ActivityBarActions>()(
  persist(
    (set, get) => ({
      ...initialState,

      openView: (viewId: string) => {
        set({
          isOpen: true,
          activeViewId: viewId,
        });
      },

      close: () => set({ isOpen: false }),

      toggle: (viewId?: string) => {
        const state = get();
        if (viewId && viewId !== state.activeViewId) {
          // Different view: switch to it and ensure open
          set({ activeViewId: viewId, isOpen: true });
        } else if (viewId && viewId === state.activeViewId && state.isOpen) {
          // Same view, currently open: close
          set({ isOpen: false });
        } else if (viewId) {
          // Same view, currently closed: open
          set({ isOpen: true });
        } else {
          // No viewId: simple toggle
          set({ isOpen: !state.isOpen });
        }
      },

      setWidth: (width: number) => {
        const { minWidth, maxWidth } = get();
        set({ width: Math.max(minWidth, Math.min(maxWidth, width)) });
      },

      reset: () => set(initialState),
    }),
    {
      name: "calcula-activity-bar",
      partialize: (state) => ({
        width: state.width,
        // Don't persist: isOpen, activeViewId (fresh start each session)
      }),
    }
  )
);
