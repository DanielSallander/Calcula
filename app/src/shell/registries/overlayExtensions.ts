//! FILENAME: app/src/shell/registries/overlayExtensions.ts
// PURPOSE: Registry for overlays (dropdowns, tooltips, popovers) that extensions can register.
// CONTEXT: Allows extensions to contribute overlay UI without shell hardcoding.
// NOTE: Moved from core/registry to shell/registries per microkernel architecture.

// Type definitions are canonical in api/uiTypes.ts (the API contract layer).
import type { AnchorRect, OverlayProps, OverlayLayer, OverlayDefinition } from "../../api/uiTypes";
export type { AnchorRect, OverlayProps, OverlayLayer, OverlayDefinition };

interface OverlayState {
  isVisible: boolean;
  data?: Record<string, unknown>;
  anchorRect?: AnchorRect;
}

interface OverlayRegistry {
  overlays: Map<string, OverlayDefinition>;
  overlayStates: Map<string, OverlayState>;
  listeners: Set<() => void>;
}

const registry: OverlayRegistry = {
  overlays: new Map(),
  overlayStates: new Map(),
  listeners: new Set(),
};

function notifyListeners(): void {
  registry.listeners.forEach((listener) => listener());
}

// Layer priority for z-index ordering
const LAYER_PRIORITY: Record<OverlayLayer, number> = {
  dropdown: 100,
  popover: 200,
  modal: 300,
  tooltip: 400,
};

/**
 * Overlay Extensions API.
 * Extensions use this to register overlays that can be shown programmatically.
 */
export const OverlayExtensions = {
  /**
   * Register an overlay definition.
   * @param definition - The overlay to register
   */
  registerOverlay(definition: OverlayDefinition): void {
    registry.overlays.set(definition.id, definition);
    registry.overlayStates.set(definition.id, { isVisible: false });
    notifyListeners();
  },

  /**
   * Unregister an overlay.
   * @param overlayId - The overlay ID to unregister
   */
  unregisterOverlay(overlayId: string): void {
    registry.overlays.delete(overlayId);
    registry.overlayStates.delete(overlayId);
    notifyListeners();
  },

  /**
   * Show an overlay by ID.
   * @param overlayId - The overlay ID to show
   * @param props - Optional props including data and anchor position
   */
  showOverlay(
    overlayId: string,
    props?: { data?: Record<string, unknown>; anchorRect?: AnchorRect }
  ): void {
    const definition = registry.overlays.get(overlayId);
    if (definition) {
      registry.overlayStates.set(overlayId, {
        isVisible: true,
        data: props?.data,
        anchorRect: props?.anchorRect,
      });
      notifyListeners();
    } else {
      console.warn(`[OverlayExtensions] Overlay not found: ${overlayId}`);
    }
  },

  /**
   * Hide an overlay by ID.
   * @param overlayId - The overlay ID to hide
   */
  hideOverlay(overlayId: string): void {
    const state = registry.overlayStates.get(overlayId);
    if (state) {
      registry.overlayStates.set(overlayId, { isVisible: false });
      notifyListeners();
    }
  },

  /**
   * Hide all overlays.
   */
  hideAllOverlays(): void {
    for (const [id] of registry.overlayStates) {
      registry.overlayStates.set(id, { isVisible: false });
    }
    notifyListeners();
  },

  /**
   * Get an overlay definition by ID.
   * @param overlayId - The overlay ID to get
   */
  getOverlay(overlayId: string): OverlayDefinition | undefined {
    return registry.overlays.get(overlayId);
  },

  /**
   * Get all visible overlays with their state.
   */
  getVisibleOverlays(): Array<{
    definition: OverlayDefinition;
    state: OverlayState;
  }> {
    const visible: Array<{ definition: OverlayDefinition; state: OverlayState }> = [];

    for (const [id, definition] of registry.overlays) {
      const state = registry.overlayStates.get(id);
      if (state?.isVisible) {
        visible.push({ definition, state });
      }
    }

    // Sort by layer priority
    return visible.sort(
      (a, b) =>
        LAYER_PRIORITY[a.definition.layer ?? "dropdown"] -
        LAYER_PRIORITY[b.definition.layer ?? "dropdown"]
    );
  },

  /**
   * Get all registered overlays (for debugging).
   */
  getAllOverlays(): OverlayDefinition[] {
    return Array.from(registry.overlays.values());
  },

  /**
   * Subscribe to registry changes.
   * @param listener - Callback when overlays change
   * @returns Cleanup function
   */
  onChange(listener: () => void): () => void {
    registry.listeners.add(listener);
    return () => registry.listeners.delete(listener);
  },
};