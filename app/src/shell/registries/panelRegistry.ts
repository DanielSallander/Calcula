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
 * The set of surfaces a panel is allowed to live in. A panel opts into a
 * subset via `supportedPlacements`; when unset (or empty) it supports both.
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
    // Drop a persisted placement that is no longer valid for this panel (e.g.
    // it was moved to the ribbon in a previous session but is now declared
    // sidebar-only). Otherwise getPlacement would keep clamping a stale value.
    const stored = usePanelPlacementStore.getState().placements[definition.id];
    if (stored && !getSupportedPlacements(definition).includes(stored)) {
      usePanelPlacementStore.getState().resetPlacement(definition.id);
    }
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
    const stored = usePanelPlacementStore.getState().getPlacement(panelId, defaultPlacement);
    if (!panel) return stored;
    // Never project a panel into a surface it doesn't support (guards stale
    // persisted overrides and any programmatic placement). Prefer the stored
    // value, then the default, then whatever the panel does support.
    const supported = getSupportedPlacements(panel);
    if (supported.includes(stored)) return stored;
    if (supported.includes(defaultPlacement)) return defaultPlacement;
    return supported[0] ?? "sidebar";
  }

  /** Whether `placement` is a surface this panel is allowed to live in. */
  canPlace(panelId: string, placement: PanelPlacement): boolean {
    const panel = this.panels.get(panelId);
    if (!panel) return false;
    return getSupportedPlacements(panel).includes(placement);
  }

  /** Whether the user is allowed to move this panel to `placement` (movable
   *  AND the target surface is supported). Drives the context-menu affordance. */
  canMoveTo(panelId: string, placement: PanelPlacement): boolean {
    const panel = this.panels.get(panelId);
    if (!panel || panel.movable === false) return false;
    return this.canPlace(panelId, placement);
  }

  setPlacement(panelId: string, placement: PanelPlacement): void {
    const panel = this.panels.get(panelId);
    if (!panel) return;
    if (panel.movable === false) return;
    // Refuse a move to an unsupported surface (e.g. a sidebar-only panel into
    // the ribbon) — the panel has no valid layout there.
    if (!this.canPlace(panelId, placement)) return;

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
