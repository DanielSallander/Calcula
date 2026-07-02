//! FILENAME: app/src/shell/registries/panelRegistry.ts
// PURPOSE: Central registry for location-agnostic extension panels
// CONTEXT: ALL panel/tab registrations flow through here. The PanelRegistry is the
// single source of truth. It projects panels into the downstream renderers
// (ActivityBarExtensions for sidebar, ExtensionRegistryImpl for ribbon)
// based on each panel's effective placement.

import React from "react";
import type { PanelDefinition, PanelPlacement, ActivityViewDefinition } from "../../api/uiTypes";
import type { RibbonTabDefinition, RibbonContext } from "./types";
import type { PanelService } from "../../api/ui";
import { usePanelPlacementStore } from "./usePanelPlacementStore";
import { SectionSidebarRenderer, SectionRibbonRenderer } from "../components/SectionRenderers";
import { emitAppEvent, onAppEvent } from "../../api/events";

/**
 * Generate a letter-based fallback icon from a panel title.
 * Used when ribbon tabs (which have no icon) are moved to the sidebar.
 */
function createLetterIcon(title: string): React.ReactElement {
  const letter = title.charAt(0).toUpperCase();
  return React.createElement(
    "svg",
    { width: 24, height: 24, viewBox: "0 0 24 24" },
    React.createElement("text", {
      x: "12",
      y: "17",
      textAnchor: "middle",
      fontSize: "14",
      fontWeight: "600",
      fontFamily: "'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif",
      fill: "currentColor",
    }, letter)
  );
}

/** All placements, used as the default when a panel doesn't restrict itself. */
const ALL_PLACEMENTS: PanelPlacement[] = ["sidebar", "ribbon"];

/**
 * The surfaces a panel declares itself best suited for. This is a SOFT
 * product-intent hint (shown on the move affordance), never a hard lock:
 * layout safety on any surface is guaranteed by the section renderers
 * (too-tall ribbon sections demote to launcher flyouts). Unset/empty means
 * "equally at home on both".
 */
export function getSupportedPlacements(panel: PanelDefinition): PanelPlacement[] {
  const declared = panel.supportedPlacements;
  return declared && declared.length > 0 ? declared : ALL_PLACEMENTS;
}

// These are set during bootstrap to avoid circular imports.
// PanelRegistry projects into these downstream registries.
let activityBarImpl: {
  registerView: (def: ActivityViewDefinition) => void;
  unregisterView: (id: string) => void;
};
let extensionRegistryImpl: {
  registerRibbonTab: (tab: RibbonTabDefinition) => void;
  unregisterRibbonTab: (tabId: string) => void;
};
let activityBarStoreGetter: () => {
  openView: (viewId: string, data?: Record<string, unknown>) => void;
  close: () => void;
  activeViewId: string | null;
};

/** Called by bootstrap.ts to inject downstream dependencies. */
export function initPanelRegistry(deps: {
  activityBar: typeof activityBarImpl;
  extensionRegistry: typeof extensionRegistryImpl;
  getActivityBarStore: typeof activityBarStoreGetter;
}): void {
  activityBarImpl = deps.activityBar;
  extensionRegistryImpl = deps.extensionRegistry;
  activityBarStoreGetter = deps.getActivityBarStore;

  // Listen for action events from panel scripts
  onAppEvent("panel:open", (detail) => {
    const { panelId } = detail as { panelId: string };
    panelRegistry.openPanel(panelId);
  });

  onAppEvent("panel:close", (detail) => {
    const { panelId } = detail as { panelId: string };
    panelRegistry.closePanel(panelId);
  });

  onAppEvent("panel:moveTo", (detail) => {
    const { panelId, placement } = detail as { panelId: string; placement: PanelPlacement };
    panelRegistry.setPlacement(panelId, placement);
  });

  onAppEvent("panel:setBadge", (detail) => {
    const { panelId, text } = detail as { panelId: string; text: string };
    panelRegistry.setBadge(panelId, text);
  });
}

/**
 * PanelRegistry — single source of truth for all panels.
 *
 * All ribbon tabs and sidebar views are registered here as PanelDefinitions
 * with sections. The registry decides where each panel renders based on
 * user preference and projects it into the appropriate downstream renderer.
 */
class PanelRegistryImpl implements PanelService {
  private panels: Map<string, PanelDefinition> = new Map();
  private badges: Map<string, string> = new Map();
  private listeners: Set<() => void> = new Set();

  // =========================================================================
  // REGISTRATION
  // =========================================================================

  registerPanel(definition: PanelDefinition): void {
    this.panels.set(definition.id, definition);
    const placement = this.getPlacement(definition.id);
    this.projectPanel(definition, placement);
    this.notifyChange();

    // Emit metadata for scriptable object contexts
    emitAppEvent("panel:metadata", {
      panelId: definition.id,
      placement,
      movable: definition.movable !== false,
    });
  }

  unregisterPanel(panelId: string): void {
    const panel = this.panels.get(panelId);
    if (!panel) return;

    const placement = this.getPlacement(panelId);
    this.unprojectPanel(panelId, placement);
    this.panels.delete(panelId);
    this.notifyChange();
  }

  getPanel(panelId: string): PanelDefinition | undefined {
    return this.panels.get(panelId);
  }

  getAllPanels(): PanelDefinition[] {
    return Array.from(this.panels.values());
  }

  // =========================================================================
  // PLACEMENT
  // =========================================================================

  getPlacement(panelId: string): PanelPlacement {
    const panel = this.panels.get(panelId);
    const defaultPlacement = panel?.defaultPlacement ?? "sidebar";
    return usePanelPlacementStore.getState().getPlacement(panelId, defaultPlacement);
  }

  /** Whether the user is allowed to move this panel to `placement`. Placement
   *  is TOTAL freedom: only `movable: false` refuses. A panel whose content
   *  cannot fit the target surface is handled by the section renderers
   *  (launcher demotion), not by refusing the move. */
  canMoveTo(panelId: string, placement: PanelPlacement): boolean {
    void placement;
    const panel = this.panels.get(panelId);
    return !!panel && panel.movable !== false;
  }

  /** Soft product-intent hint for the move affordance: when the target surface
   *  is outside the panel's declared supportedPlacements, returns a short
   *  "works best in the …" note; otherwise null. Never blocks the move. */
  getMoveHint(panelId: string, target: PanelPlacement): string | null {
    const panel = this.panels.get(panelId);
    if (!panel || !panel.supportedPlacements || panel.supportedPlacements.length === 0) {
      return null;
    }
    const supported = getSupportedPlacements(panel);
    if (supported.includes(target)) return null;
    return `Works best in the ${supported[0]}`;
  }

  setPlacement(panelId: string, placement: PanelPlacement): void {
    const panel = this.panels.get(panelId);
    if (!panel) return;
    if (panel.movable === false) return;

    const currentPlacement = this.getPlacement(panelId);
    if (currentPlacement === placement) return;

    // Unproject from current location
    this.unprojectPanel(panelId, currentPlacement);

    // Persist user preference
    usePanelPlacementStore.getState().setPlacement(panelId, placement);

    // Project into new location
    this.projectPanel(panel, placement);
    this.notifyChange();

    // Emit placement change event for scriptable object contexts
    emitAppEvent("panel:placementChanged", {
      panelId,
      oldPlacement: currentPlacement,
      newPlacement: placement,
    });
  }

  // =========================================================================
  // OPEN / CLOSE
  // =========================================================================

  openPanel(panelId: string, data?: Record<string, unknown>): void {
    const placement = this.getPlacement(panelId);
    if (placement === "sidebar") {
      activityBarStoreGetter().openView(panelId, data);
    }
  }

  closePanel(panelId: string): void {
    const placement = this.getPlacement(panelId);
    if (placement === "sidebar") {
      const store = activityBarStoreGetter();
      if (store.activeViewId === panelId) {
        store.close();
      }
    }
  }

  // =========================================================================
  // BADGES
  // =========================================================================

  setBadge(panelId: string, text: string): void {
    if (text) {
      this.badges.set(panelId, text);
    } else {
      this.badges.delete(panelId);
    }
    this.notifyChange();
  }

  getBadge(panelId: string): string {
    return this.badges.get(panelId) || "";
  }

  // =========================================================================
  // CHANGE SUBSCRIPTION
  // =========================================================================

  onRegistryChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyChange(): void {
    this.listeners.forEach((cb) => cb());
  }

  // =========================================================================
  // PROJECTION: Panel → ActivityBar (sidebar)
  // =========================================================================

  private projectToSidebar(panel: PanelDefinition): void {
    const sections = panel.sections;
    // SectionSidebarRenderer handles both shapes: a single section fills the
    // panel directly (no chrome), multiple sections stack collapsibly. It also
    // provides the vertical SurfaceLayout geometry and forwards the host's
    // onClose/data into the section components.
    const SidebarComponent: React.ComponentType<{ onClose?: () => void; data?: Record<string, unknown> }> =
      ({ onClose, data }) => React.createElement(SectionSidebarRenderer, { sections, onClose, data });

    const activityViewDef: ActivityViewDefinition = {
      id: panel.id,
      title: panel.title,
      icon: panel.icon ?? createLetterIcon(panel.title),
      component: SidebarComponent,
      priority: panel.priority ?? 0,
      bottom: panel.sidebarBottom ?? false,
      hidden: panel.hidden ?? false,
    };

    activityBarImpl.registerView(activityViewDef);
  }

  // =========================================================================
  // PROJECTION: Panel → ExtensionRegistry (ribbon)
  // =========================================================================

  private projectToRibbon(panel: PanelDefinition): void {
    // Hidden panels have no tab-strip presence (the ribbon has no notion of a
    // registered-but-invisible tab); they stay reachable programmatically via
    // their sidebar projection.
    if (panel.hidden) return;

    const sections = panel.sections;
    // Always render through SectionRibbonRenderer so every section — including
    // a single one — is measured and demoted to a launcher if it cannot fit
    // the band. A fully-demoted single-section panel renders one launcher
    // carrying the panel's own title/icon (Excel's collapsed-group idiom).
    const TabComponent: React.ComponentType<{ context: RibbonContext }> = () =>
      React.createElement(SectionRibbonRenderer, {
        sections,
        panelId: panel.id,
        panelTitle: panel.title,
        panelIcon: panel.icon,
      });

    const tabDef: RibbonTabDefinition = {
      id: panel.id,
      label: panel.title,
      order: panel.ribbonOrder ?? 999,
      component: TabComponent,
      color: panel.ribbonColor,
    };

    extensionRegistryImpl.registerRibbonTab(tabDef);
  }

  // =========================================================================
  // PROJECTION MANAGEMENT
  // =========================================================================

  private projectPanel(panel: PanelDefinition, placement: PanelPlacement): void {
    if (placement === "sidebar") {
      this.projectToSidebar(panel);
    } else {
      this.projectToRibbon(panel);
    }
  }

  private unprojectPanel(panelId: string, placement: PanelPlacement): void {
    if (placement === "sidebar") {
      activityBarImpl.unregisterView(panelId);
    } else {
      extensionRegistryImpl.unregisterRibbonTab(panelId);
    }
  }

  // =========================================================================
  // UTILITIES
  // =========================================================================

  /** Get the PanelDefinition for a downstream registry ID. */
  getPanelByDownstreamId(downstreamId: string): PanelDefinition | undefined {
    return this.panels.get(downstreamId);
  }

  clear(): void {
    this.panels.clear();
    this.notifyChange();
  }
}

// Singleton instance
export const panelRegistry = new PanelRegistryImpl();
