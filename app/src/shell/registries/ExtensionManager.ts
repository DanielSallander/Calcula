//! FILENAME: app/src/shell/registries/ExtensionManager.ts
// PURPOSE: Manages extension lifecycle (loading, activation, deactivation).
// CONTEXT: Loads built-in extensions from manifest.ts and supports runtime loading.
// NOTE: Uses vanilla listener pattern instead of RxJS for simplicity.

import type { ExtensionModule, ExtensionContext } from "../../api/contract";
import { CommandRegistry } from "../../api/commands";
import { builtInExtensions } from "../../../extensions/manifest";

// ============================================================================
// Types
// ============================================================================

export type ExtensionStatus = "pending" | "active" | "error" | "inactive";

export interface LoadedExtension {
  id: string;
  name: string;
  version: string;
  status: ExtensionStatus;
  module: ExtensionModule;
  error?: Error;
}

type ChangeListener = () => void;

// ============================================================================
// ExtensionManager Implementation
// ============================================================================

class ExtensionManagerImpl {
  private extensions: Map<string, LoadedExtension> = new Map();
  private listeners: Set<ChangeListener> = new Set();
  private initialized = false;

  // Cached array for useSyncExternalStore - MUST return same reference if data unchanged
  private cachedExtensionsArray: LoadedExtension[] = [];

  /**
   * The context passed to all extensions during activation.
   * This is our Dependency Injection container.
   */
  private readonly context: ExtensionContext = {
    commands: CommandRegistry,
    // Future: Add more API surfaces as needed
    // ribbon: RibbonRegistry,
    // menus: MenuRegistry,
  };

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  /**
   * Initialize the extension manager and load all built-in extensions.
   * Safe to call multiple times (only initializes once).
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      console.log("[ExtensionManager] Already initialized, skipping.");
      return;
    }

    console.log("[ExtensionManager] Initializing...");
    this.initialized = true;

    // Load all built-in extensions from the manifest
    for (const module of builtInExtensions) {
      await this.activateExtension(module);
    }

    console.log(
      `[ExtensionManager] Initialization complete. ${this.extensions.size} extensions loaded.`
    );
  }

  /**
   * Check if the manager has been initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  // --------------------------------------------------------------------------
  // Extension Activation
  // --------------------------------------------------------------------------

  /**
   * Activate an extension module.
   */
  private async activateExtension(module: ExtensionModule): Promise<void> {
    const { id, name, version } = module.manifest;

    // Check for duplicate
    if (this.extensions.has(id)) {
      console.warn(`[ExtensionManager] Extension '${id}' already loaded, skipping.`);
      return;
    }

    // Add as pending
    const entry: LoadedExtension = {
      id,
      name,
      version,
      status: "pending",
      module,
    };
    this.extensions.set(id, entry);
    this.updateCachedArray();
    this.notifyChange();

    try {
      console.log(`[ExtensionManager] Activating extension: ${id} (${name} v${version})`);
      await module.activate(this.context);

      entry.status = "active";
      console.log(`[ExtensionManager] Extension '${id}' activated successfully.`);
    } catch (error) {
      entry.status = "error";
      entry.error = error instanceof Error ? error : new Error(String(error));
      console.error(`[ExtensionManager] Failed to activate extension '${id}':`, error);
    }

    this.updateCachedArray();
    this.notifyChange();
  }

  // --------------------------------------------------------------------------
  // Runtime Extension Loading
  // --------------------------------------------------------------------------

  /**
   * Load an extension from a URL at runtime.
   * This enables "drag and drop" installation of extensions.
   * @param url The URL to the extension's JavaScript module
   */
  async loadRuntimeExtension(url: string): Promise<void> {
    try {
      console.log(`[ExtensionManager] Loading runtime extension from: ${url}`);

      // Dynamic import (Vite/browser native ESM support)
      const module = (await import(/* @vite-ignore */ url)) as ExtensionModule;

      // Validate the module has required exports
      if (!module.manifest) {
        throw new Error(`Extension at ${url} does not export a 'manifest' object.`);
      }
      if (!module.activate) {
        throw new Error(`Extension at ${url} does not export an 'activate' function.`);
      }

      await this.activateExtension(module);
    } catch (error) {
      console.error(`[ExtensionManager] Runtime load failed for ${url}:`, error);
      throw error;
    }
  }

  // --------------------------------------------------------------------------
  // Extension Deactivation
  // --------------------------------------------------------------------------

  /**
   * Deactivate an extension by ID.
   */
  async deactivateExtension(id: string): Promise<void> {
    const entry = this.extensions.get(id);
    if (!entry) {
      console.warn(`[ExtensionManager] Cannot deactivate unknown extension: ${id}`);
      return;
    }

    if (entry.status !== "active") {
      console.warn(`[ExtensionManager] Extension '${id}' is not active (status: ${entry.status})`);
      return;
    }

    try {
      if (entry.module.deactivate) {
        console.log(`[ExtensionManager] Deactivating extension: ${id}`);
        entry.module.deactivate();
      }
      entry.status = "inactive";
      console.log(`[ExtensionManager] Extension '${id}' deactivated.`);
    } catch (error) {
      console.error(`[ExtensionManager] Error deactivating extension '${id}':`, error);
      entry.status = "error";
      entry.error = error instanceof Error ? error : new Error(String(error));
    }

    this.updateCachedArray();
    this.notifyChange();
  }

  // --------------------------------------------------------------------------
  // Accessors
  // --------------------------------------------------------------------------

  /**
   * Update the cached array. Call this whenever extensions Map changes.
   * This ensures getExtensions() returns a stable reference for useSyncExternalStore.
   */
  private updateCachedArray(): void {
    this.cachedExtensionsArray = Array.from(this.extensions.values());
  }

  /**
   * Get all loaded extensions.
   * Returns a cached array reference for useSyncExternalStore compatibility.
   */
  getExtensions(): LoadedExtension[] {
    return this.cachedExtensionsArray;
  }

  /**
   * Get a specific extension by ID.
   */
  getExtension(id: string): LoadedExtension | undefined {
    return this.extensions.get(id);
  }

  /**
   * Get all active extensions.
   */
  getActiveExtensions(): LoadedExtension[] {
    return this.cachedExtensionsArray.filter((ext) => ext.status === "active");
  }

  /**
   * Get count of loaded extensions.
   */
  getExtensionCount(): number {
    return this.extensions.size;
  }

  // --------------------------------------------------------------------------
  // Change Subscription (Vanilla Listener Pattern)
  // --------------------------------------------------------------------------

  /**
   * Subscribe to extension state changes.
   * @param callback Called whenever extensions are added, removed, or change status
   * @returns Unsubscribe function
   */
  subscribe(callback: ChangeListener): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  /**
   * Notify all listeners of a change.
   */
  private notifyChange(): void {
    this.listeners.forEach((cb) => {
      try {
        cb();
      } catch (error) {
        console.error("[ExtensionManager] Error in change listener:", error);
      }
    });
  }

  // --------------------------------------------------------------------------
  // Utility
  // --------------------------------------------------------------------------

  /**
   * Reset the manager (for testing).
   */
  reset(): void {
    // Deactivate all extensions
    for (const [id, entry] of this.extensions) {
      if (entry.status === "active" && entry.module.deactivate) {
        try {
          entry.module.deactivate();
        } catch (error) {
          console.error(`[ExtensionManager] Error during reset deactivation of '${id}':`, error);
        }
      }
    }
    this.extensions.clear();
    this.initialized = false;
    this.updateCachedArray();
    this.notifyChange();
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

export const ExtensionManager = new ExtensionManagerImpl();