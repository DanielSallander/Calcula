//! FILENAME: app/src/core/extensions/ExtensionRegistry.ts
// PURPOSE: Central registry for all extension points.
// CONTEXT: Add-ins register their contributions here; core consumes them.

import type {
  Command,
  RibbonTabDefinition,
  RibbonGroupDefinition,
  SelectionChangeCallback,
  CellChangeCallback,
  AddInManifest,
} from "./types";

class ExtensionRegistryImpl {
  // Registered items
  private commands: Map<string, Command> = new Map();
  private ribbonTabs: Map<string, RibbonTabDefinition> = new Map();
  private ribbonGroups: Map<string, RibbonGroupDefinition> = new Map();
  private addins: Map<string, AddInManifest> = new Map();

  // Event subscribers
  private selectionListeners: Set<SelectionChangeCallback> = new Set();
  private cellChangeListeners: Set<CellChangeCallback> = new Set();
  private registryChangeListeners: Set<() => void> = new Set();

  // =========================================================================
  // ADD-IN REGISTRATION
  // =========================================================================

  /**
   * Register an add-in and all its contributions.
   */
  registerAddIn(manifest: AddInManifest): void {
    if (this.addins.has(manifest.id)) {
      console.warn(`[ExtensionRegistry] Add-in "${manifest.id}" already registered, overwriting.`);
    }

    // Check dependencies
    for (const depId of manifest.dependencies ?? []) {
      if (!this.addins.has(depId)) {
        console.warn(`[ExtensionRegistry] Add-in "${manifest.id}" depends on "${depId}" which is not registered.`);
      }
    }

    this.addins.set(manifest.id, manifest);

    // Register all contributions
    manifest.commands?.forEach((cmd) => this.registerCommand(cmd));
    manifest.ribbonTabs?.forEach((tab) => this.registerRibbonTab(tab));
    manifest.ribbonGroups?.forEach((group) => this.registerRibbonGroup(group));

    console.log(`[ExtensionRegistry] Registered add-in: ${manifest.name} (${manifest.id})`);
    this.notifyRegistryChange();
  }

  /**
   * Unregister an add-in and all its contributions.
   */
  unregisterAddIn(addinId: string): void {
    const manifest = this.addins.get(addinId);
    if (!manifest) return;

    manifest.commands?.forEach((cmd) => this.commands.delete(cmd.id));
    manifest.ribbonTabs?.forEach((tab) => this.unregisterRibbonTab(tab.id));
    manifest.ribbonGroups?.forEach((group) => this.ribbonGroups.delete(group.id));

    this.addins.delete(addinId);
    this.notifyRegistryChange();
  }

  // =========================================================================
  // COMMAND REGISTRATION
  // =========================================================================

  registerCommand(command: Command): void {
    if (this.commands.has(command.id)) {
      console.warn(`[ExtensionRegistry] Command "${command.id}" already registered, overwriting.`);
    }
    this.commands.set(command.id, command);
  }

  getCommand(commandId: string): Command | undefined {
    return this.commands.get(commandId);
  }

  getAllCommands(): Command[] {
    return Array.from(this.commands.values());
  }

  // =========================================================================
  // RIBBON REGISTRATION
  // =========================================================================

  registerRibbonTab(tab: RibbonTabDefinition): void {
    if (this.ribbonTabs.has(tab.id)) {
      console.warn(`[ExtensionRegistry] Tab "${tab.id}" already registered, overwriting.`);
    }
    this.ribbonTabs.set(tab.id, tab);
    this.notifyRegistryChange();
  }

  unregisterRibbonTab(tabId: string): void {
    this.ribbonTabs.delete(tabId);
    // Also remove all groups belonging to this tab
    for (const [groupId, group] of this.ribbonGroups) {
      if (group.tabId === tabId) {
        this.ribbonGroups.delete(groupId);
      }
    }
    this.notifyRegistryChange();
  }

  registerRibbonGroup(group: RibbonGroupDefinition): void {
    if (this.ribbonGroups.has(group.id)) {
      console.warn(`[ExtensionRegistry] Group "${group.id}" already registered, overwriting.`);
    }
    this.ribbonGroups.set(group.id, group);
    this.notifyRegistryChange();
  }

  unregisterRibbonGroup(groupId: string): void {
    this.ribbonGroups.delete(groupId);
    this.notifyRegistryChange();
  }

  getRibbonTabs(): RibbonTabDefinition[] {
    return Array.from(this.ribbonTabs.values()).sort((a, b) => a.order - b.order);
  }

  getRibbonTab(tabId: string): RibbonTabDefinition | undefined {
    return this.ribbonTabs.get(tabId);
  }

  getRibbonGroupsForTab(tabId: string): RibbonGroupDefinition[] {
    return Array.from(this.ribbonGroups.values())
      .filter((group) => group.tabId === tabId)
      .sort((a, b) => a.order - b.order);
  }

  // =========================================================================
  // EVENT HOOKS
  // =========================================================================

  onSelectionChange(callback: SelectionChangeCallback): () => void {
    this.selectionListeners.add(callback);
    return () => this.selectionListeners.delete(callback);
  }

  onCellChange(callback: CellChangeCallback): () => void {
    this.cellChangeListeners.add(callback);
    return () => this.cellChangeListeners.delete(callback);
  }

  // Called by core when selection changes
  notifySelectionChange(selection: import("../types").Selection | null): void {
    this.selectionListeners.forEach((cb) => cb(selection));
  }

  // Called by core when a cell changes
  notifyCellChange(row: number, col: number, oldValue: string | null, newValue: string | null): void {
    this.cellChangeListeners.forEach((cb) => cb(row, col, oldValue, newValue));
  }

  // =========================================================================
  // REGISTRY CHANGE SUBSCRIPTION
  // =========================================================================

  onRegistryChange(callback: () => void): () => void {
    this.registryChangeListeners.add(callback);
    return () => this.registryChangeListeners.delete(callback);
  }

  private notifyRegistryChange(): void {
    this.registryChangeListeners.forEach((cb) => cb());
  }

  // =========================================================================
  // UTILITIES
  // =========================================================================

  clear(): void {
    this.commands.clear();
    this.ribbonTabs.clear();
    this.ribbonGroups.clear();
    this.addins.clear();
    this.selectionListeners.clear();
    this.cellChangeListeners.clear();
    this.notifyRegistryChange();
  }

  getRegisteredAddIns(): AddInManifest[] {
    return Array.from(this.addins.values());
  }

  hasAddIn(addinId: string): boolean {
    return this.addins.has(addinId);
  }
}

// Singleton instance
export const ExtensionRegistry = new ExtensionRegistryImpl();
