//! FILENAME: app/src/shell/registries/panelRegistry.ts
// PURPOSE: Central registry for location-agnostic extension panels
// CONTEXT: ALL panel/tab registrations flow through here. The PanelRegistry is the
// single source of truth. It projects panels into the downstream renderers
// (ActivityBarExtensions for sidebar, ExtensionRegistryImpl for ribbon)
// based on each panel's effective placement.

import React from "react";
import type { PanelDefinition, PanelPlacement, PanelSection, ActivityViewDefinition } from "../../api/uiTypes";
import type { RibbonTabDefinition, RibbonContext } from "./types";
import type { PanelService } from "../../api/ui";
import { usePanelPlacementStore } from "./usePanelPlacementStore";
import { SectionSidebarRenderer, SectionRibbonRenderer } from "../components/SectionRenderers";

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
  private listeners: Set<() => void> = new Set();

  // =========================================================================
  // REGISTRATION
  // =========================================================================

  registerPanel(definition: PanelDefinition): void {
    this.panels.set(definition.id, definition);
    const placement = this.getPlacement(definition.id);
    this.projectPanel(definition, placement);
    this.notifyChange();
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
    let SidebarComponent: React.ComponentType<{ onClose?: () => void; data?: Record<string, unknown> }>;

    if (sections.length === 1 && panel.defaultPlacement === "sidebar") {
      // Sidebar-native single section — render directly without wrapper
      const Section = sections[0].component;
      SidebarComponent = () => React.createElement(Section, { placement: "sidebar" });
    } else {
      // Ribbon-origin panels or multi-section panels — use SectionSidebarRenderer
      // which provides CSS overrides for transposing horizontal ribbon layout to vertical
      SidebarComponent = () => React.createElement(SectionSidebarRenderer, { sections });
    }

    const activityViewDef: ActivityViewDefinition = {
      id: panel.id,
      title: panel.title,
      icon: panel.icon ?? createLetterIcon(panel.title),
      component: SidebarComponent,
      priority: panel.priority ?? 0,
      bottom: panel.sidebarBottom ?? false,
      hidden: false,
    };

    activityBarImpl.registerView(activityViewDef);
  }

  // =========================================================================
  // PROJECTION: Panel → ExtensionRegistry (ribbon)
  // =========================================================================

  private projectToRibbon(panel: PanelDefinition): void {
    const sections = panel.sections;

    let TabComponent: React.ComponentType<{ context: RibbonContext }>;

    if (sections.length === 1) {
      // Single section — render directly
      const Section = sections[0].component;
      TabComponent = () => React.createElement(Section, { placement: "ribbon" });
    } else {
      // Multiple sections — use SectionRibbonRenderer
      TabComponent = () => React.createElement(SectionRibbonRenderer, { sections });
    }

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
