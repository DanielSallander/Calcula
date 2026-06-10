//! FILENAME: app/src/shell/registries/usePanelPlacementStore.ts
// PURPOSE: Zustand store for persisting user panel placement preferences
// CONTEXT: Part of the location-agnostic panel system. Stores which panels
// the user has moved from their default placement.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { PanelPlacement } from "../../api/uiTypes";

/**
 * Panel placement store state.
 * Only user-overridden placements are stored.
 * Panels without overrides use their PanelDefinition.defaultPlacement.
 */
export interface PanelPlacementState {
  /** User-overridden placements (panelId -> placement) */
  placements: Record<string, PanelPlacement>;
}

export interface PanelPlacementActions {
  /** Set a user placement override for a panel */
  setPlacement: (panelId: string, placement: PanelPlacement) => void;
  /** Remove a user placement override (revert to default) */
  resetPlacement: (panelId: string) => void;
  /** Get the effective placement for a panel, falling back to the provided default */
  getPlacement: (panelId: string, defaultPlacement: PanelPlacement) => PanelPlacement;
}

export const usePanelPlacementStore = create<PanelPlacementState & PanelPlacementActions>()(
  persist(
    (set, get) => ({
      placements: {},

      setPlacement: (panelId: string, placement: PanelPlacement) => {
        set((state) => ({
          placements: { ...state.placements, [panelId]: placement },
        }));
      },

      resetPlacement: (panelId: string) => {
        set((state) => {
          const { [panelId]: _, ...rest } = state.placements;
          return { placements: rest };
        });
      },

      getPlacement: (panelId: string, defaultPlacement: PanelPlacement): PanelPlacement => {
        return get().placements[panelId] ?? defaultPlacement;
      },
    }),
    {
      name: "calcula-panel-placements",
    }
  )
);
