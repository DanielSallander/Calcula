//! FILENAME: app/src/shell/registries/ExtensionManager.ts
// PURPOSE: Manages extension lifecycle (loading, activation, deactivation).
// CONTEXT: Loads built-in extensions from manifest.ts and supports runtime loading.
// NOTE: Uses vanilla listener pattern instead of RxJS for simplicity.

import type { ExtensionModule, ExtensionContext } from "../../api/contract";
import { CommandRegistry } from "../../api/commands";
import { API_VERSION } from "../../api/version";
import { builtInExtensions } from "../../../extensions/manifest";

// Import free functions from API to wire into the context object
import {
  registerMenu,
  registerMenuItem,
  getMenus,
  subscribeToMenus,
  notifyMenusChanged,
  registerTaskPane,
  unregisterTaskPane,
  openTaskPane,
  closeTaskPane,
  getTaskPane,
  showTaskPaneContainer,
  hideTaskPaneContainer,
  isTaskPaneContainerOpen,
  getTaskPaneManuallyClosed,
  markTaskPaneManuallyClosed,
  clearTaskPaneManuallyClosed,
  addTaskPaneContextKey,
  removeTaskPaneContextKey,
  registerDialog,
  unregisterDialog,
  showDialog,
  hideDialog,
  registerOverlay,
  unregisterOverlay,
  showOverlay,
  hideOverlay,
  hideAllOverlays,
  registerStatusBarItem,
  unregisterStatusBarItem,
  registerActivityView,
  unregisterActivityView,
  openActivityView,
  closeActivityView,
  toggleActivityView,
} from "../../api/ui";
import { emitAppEvent, onAppEvent } from "../../api/events";
import { showToast } from "../../api/notifications";
import {
  registerCellDecoration,
  unregisterCellDecoration,
} from "../../api/cellDecorations";
import {
  registerStyleInterceptor,
  unregisterStyleInterceptor,
  markRangeDirty,
  markSheetDirty,
} from "../../api/styleInterceptors";
import { registerGridOverlay } from "../../api/gridOverlays";
import { registerEditGuard } from "../../api/editGuards";
import { registerCellClickInterceptor } from "../../api/cellClickInterceptors";
import { registerCellDoubleClickInterceptor } from "../../api/cellDoubleClickInterceptors";

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
// API Version Compatibility Check
// ============================================================================

/**
 * Parse a version string into [major, minor, patch].
 */
function parseVersion(version: string): [number, number, number] {
  const parts = version.replace(/^[^0-9]*/, "").split(".").map(Number);
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

/**
 * Check if the host API version satisfies the extension's required version.
 * Supports caret ranges (^1.2.3 means >=1.2.3 and <2.0.0).
 * If no prefix, treats as exact major match (1.x compatible with 1.y).
 */
function isApiVersionCompatible(required: string, host: string): boolean {
  const isCaret = required.startsWith("^");
  const [reqMajor, reqMinor, reqPatch] = parseVersion(required);
  const [hostMajor, hostMinor, hostPatch] = parseVersion(host);

  if (isCaret) {
    // ^1.2.3 means >=1.2.3 and <2.0.0
    if (hostMajor !== reqMajor) return false;
    if (hostMinor < reqMinor) return false;
    if (hostMinor === reqMinor && hostPatch < reqPatch) return false;
    return true;
  }

  // Default: same major version is compatible
  return hostMajor === reqMajor;
}

// ============================================================================
// Build the ExtensionContext (DI wiring)
// ============================================================================

function buildContext(): ExtensionContext {
  return {
    commands: CommandRegistry,
    ui: {
      menus: {
        register: registerMenu,
        registerItem: registerMenuItem,
        getAll: getMenus,
        subscribe: subscribeToMenus,
        notifyChanged: notifyMenusChanged,
      },
      taskPanes: {
        register: registerTaskPane,
        unregister: unregisterTaskPane,
        open: openTaskPane,
        close: closeTaskPane,
        getView: getTaskPane,
        showContainer: showTaskPaneContainer,
        hideContainer: hideTaskPaneContainer,
        isContainerOpen: isTaskPaneContainerOpen,
        addContextKey: addTaskPaneContextKey,
        removeContextKey: removeTaskPaneContextKey,
        getManuallyClosed: getTaskPaneManuallyClosed,
        markManuallyClosed: markTaskPaneManuallyClosed,
        clearManuallyClosed: clearTaskPaneManuallyClosed,
      },
      dialogs: {
        register: registerDialog,
        unregister: unregisterDialog,
        show: showDialog,
        hide: hideDialog,
      },
      overlays: {
        register: registerOverlay,
        unregister: unregisterOverlay,
        show: showOverlay,
        hide: hideOverlay,
        hideAll: hideAllOverlays,
      },
      statusBar: {
        register: registerStatusBarItem,
        unregister: unregisterStatusBarItem,
      },
      activityBar: {
        register: registerActivityView,
        unregister: unregisterActivityView,
        open: openActivityView,
        close: closeActivityView,
        toggle: toggleActivityView,
      },
      notifications: {
        showToast,
      },
    },
    events: {
      emit: emitAppEvent,
      on: onAppEvent,
    },
    grid: {
      decorations: {
        register: registerCellDecoration,
        unregister: unregisterCellDecoration,
      },
      styleInterceptors: {
        register: registerStyleInterceptor,
        unregister: unregisterStyleInterceptor,
        markRangeDirty,
        markSheetDirty,
      },
      overlays: {
        register: registerGridOverlay,
      },
      editGuards: {
        register: registerEditGuard,
      },
      cellClicks: {
        registerClickInterceptor: registerCellClickInterceptor,
        registerDoubleClickInterceptor: registerCellDoubleClickInterceptor,
      },
    },
  };
}

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
  private readonly context: ExtensionContext = buildContext();

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

    // Check API version compatibility
    if (module.manifest.apiVersion) {
      if (!isApiVersionCompatible(module.manifest.apiVersion, API_VERSION)) {
        entry.status = "error";
        entry.error = new Error(
          `Extension '${id}' requires API ${module.manifest.apiVersion} but host is ${API_VERSION}`
        );
        console.error(`[ExtensionManager] ${entry.error.message}`);
        this.updateCachedArray();
        this.notifyChange();
        return;
      }
    }

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
