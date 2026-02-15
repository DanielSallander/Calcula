//! FILENAME: app/src/shell/TaskPane/useTaskPaneStore.ts
// PURPOSE: Zustand store for Task Pane state management
// CONTEXT: Manages visibility, width, active view, and registered views

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { TaskPaneContextKey } from "../../api/ui";

/**
 * Data associated with an open pane instance.
 */
export interface OpenPaneInstance {
  viewId: string;
  data?: Record<string, unknown>;
  /** Timestamp when opened, for ordering */
  openedAt: number;
}

/**
 * Task Pane store state.
 */
export interface TaskPaneState {
  /** Whether the task pane container is visible */
  isOpen: boolean;
  /** Current width in pixels */
  width: number;
  /** Minimum width constraint */
  minWidth: number;
  /** Maximum width constraint */
  maxWidth: number;
  /** ID of the currently active/visible view */
  activeViewId: string | null;
  /** Currently open pane instances (supports multiple tabs) */
  openPanes: OpenPaneInstance[];
  /** Current active context keys (what's selected) */
  activeContextKeys: TaskPaneContextKey[];
  /** Dock mode: docked compresses grid, floating overlays */
  dockMode: "docked" | "floating";
  /** Views that were manually closed by the user (won't auto-open) - stored as array for serialization */
  manuallyClosed: string[];
}

/**
 * Task Pane store actions.
 */
export interface TaskPaneActions {
  /** Open the task pane */
  open: () => void;
  /** Close the task pane */
  close: () => void;
  /** Toggle the task pane visibility */
  toggle: () => void;
  /** Set the pane width */
  setWidth: (width: number) => void;
  /** Set the active view by ID */
  setActiveView: (viewId: string | null) => void;
  /** Open a specific pane view with optional data */
  openPane: (viewId: string, data?: Record<string, unknown>) => void;
  /** Close a specific pane view */
  closePane: (viewId: string) => void;
  /** Update the active context keys */
  setActiveContextKeys: (keys: TaskPaneContextKey[]) => void;
  /** Set the dock mode */
  setDockMode: (mode: "docked" | "floating") => void;
  /** Mark a view as manually closed */
  markManuallyClosed: (viewId: string) => void;
  /** Clear manually closed state for a view */
  clearManuallyClosed: (viewId: string) => void;
  /** Add a context key to the active set (no-op if already present) */
  addActiveContextKey: (key: TaskPaneContextKey) => void;
  /** Remove a context key from the active set (no-op if not present) */
  removeActiveContextKey: (key: TaskPaneContextKey) => void;
  /** Reset all state */
  reset: () => void;
}

const DEFAULT_WIDTH = 320;
const MIN_WIDTH = 240;
const MAX_WIDTH = 600;

const initialState: TaskPaneState = {
  isOpen: false,
  width: DEFAULT_WIDTH,
  minWidth: MIN_WIDTH,
  maxWidth: MAX_WIDTH,
  activeViewId: null,
  openPanes: [],
  activeContextKeys: [],
  dockMode: "docked",
  manuallyClosed: [],
};

/**
 * Task Pane store with persistence.
 */
export const useTaskPaneStore = create<TaskPaneState & TaskPaneActions>()(
  persist(
    (set, get) => ({
      ...initialState,

      open: () => set({ isOpen: true }),

      close: () => set({ isOpen: false }),

      toggle: () => set((state) => ({ isOpen: !state.isOpen })),

      setWidth: (width: number) => {
        const { minWidth, maxWidth } = get();
        const clampedWidth = Math.max(minWidth, Math.min(maxWidth, width));
        set({ width: clampedWidth });
      },

      setActiveView: (viewId: string | null) => {
        set({ activeViewId: viewId });
      },

      openPane: (viewId: string, data?: Record<string, unknown>) => {
        console.log("[TaskPane] openPane called:", { viewId, data });
        const state = get();
        const existingIndex = state.openPanes.findIndex(
          (p) => p.viewId === viewId
        );

        if (existingIndex >= 0) {
          // Update existing pane's data and make it active
          const newPanes = [...state.openPanes];
          newPanes[existingIndex] = {
            ...newPanes[existingIndex],
            data: data ?? newPanes[existingIndex].data,
          };
          console.log("[TaskPane] Updating existing pane, setting isOpen=true");
          set({
            openPanes: newPanes,
            activeViewId: viewId,
            isOpen: true,
          });
        } else {
          // Add new pane
          const newPane: OpenPaneInstance = {
            viewId,
            data,
            openedAt: Date.now(),
          };
          console.log("[TaskPane] Adding new pane, setting isOpen=true");
          set({
            openPanes: [...state.openPanes, newPane],
            activeViewId: viewId,
            isOpen: true,
          });
        }

        // Clear manually closed state when explicitly opening (array filter)
        const newManuallyClosed = state.manuallyClosed.filter((id) => id !== viewId);
        set({ manuallyClosed: newManuallyClosed });
      },

      closePane: (viewId: string) => {
        const state = get();
        const newPanes = state.openPanes.filter((p) => p.viewId !== viewId);

        // If we're closing the active view, switch to another open pane
        let newActiveViewId = state.activeViewId;
        if (state.activeViewId === viewId) {
          newActiveViewId = newPanes.length > 0 ? newPanes[0].viewId : null;
        }

        // If no panes left, close the task pane
        const shouldClose = newPanes.length === 0;

        set({
          openPanes: newPanes,
          activeViewId: newActiveViewId,
          isOpen: shouldClose ? false : state.isOpen,
        });
      },

      setActiveContextKeys: (keys: TaskPaneContextKey[]) => {
        set({ activeContextKeys: keys });
      },

      setDockMode: (mode: "docked" | "floating") => {
        set({ dockMode: mode });
      },

      markManuallyClosed: (viewId: string) => {
        const current = get().manuallyClosed;
        if (!current.includes(viewId)) {
          set({ manuallyClosed: [...current, viewId] });
        }
      },

      clearManuallyClosed: (viewId: string) => {
        const current = get().manuallyClosed;
        set({ manuallyClosed: current.filter((id) => id !== viewId) });
      },

      addActiveContextKey: (key: TaskPaneContextKey) => {
        const current = get().activeContextKeys;
        if (!current.includes(key)) {
          set({ activeContextKeys: [...current, key] });
        }
      },

      removeActiveContextKey: (key: TaskPaneContextKey) => {
        const current = get().activeContextKeys;
        if (current.includes(key)) {
          set({ activeContextKeys: current.filter((k) => k !== key) });
        }
      },

      reset: () => {
        set({
          ...initialState,
          manuallyClosed: [],
        });
      },
    }),
    {
      name: "calcula-task-pane",
      partialize: (state) => ({
        width: state.width,
        dockMode: state.dockMode,
        // Don't persist: isOpen, activeViewId, openPanes, activeContextKeys, manuallyClosed
      }),
    }
  )
);

/**
 * Selector hooks for common state slices.
 */
export const useTaskPaneIsOpen = () => useTaskPaneStore((state) => state.isOpen);
export const useTaskPaneWidth = () => useTaskPaneStore((state) => state.width);
export const useTaskPaneActiveViewId = () =>
  useTaskPaneStore((state) => state.activeViewId);
export const useTaskPaneOpenPanes = () =>
  useTaskPaneStore((state) => state.openPanes);