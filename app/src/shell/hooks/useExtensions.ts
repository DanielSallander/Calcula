//! FILENAME: app/src/shell/hooks/useExtensions.ts
// PURPOSE: React hook for subscribing to ExtensionManager state.
// CONTEXT: Used by Shell components to re-render when extensions load/change.
// UPDATED: Now calls bootstrapShell before initializing extensions.

import { useState, useEffect, useSyncExternalStore, useCallback } from "react";
import { ExtensionManager, type LoadedExtension } from "../registries/ExtensionManager";
import { bootstrapShell } from "../bootstrap";

// ============================================================================
// useExtensions Hook
// ============================================================================

/**
 * React hook that subscribes to ExtensionManager state.
 * Re-renders the component when extensions are loaded or change status.
 */
export function useExtensions(): {
  extensions: LoadedExtension[];
  isInitialized: boolean;
  activeCount: number;
  errorCount: number;
} {
  const subscribe = useCallback((callback: () => void) => {
    return ExtensionManager.subscribe(callback);
  }, []);

  const getSnapshot = useCallback(() => {
    return ExtensionManager.getExtensions();
  }, []);

  const extensions = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const isInitialized = ExtensionManager.isInitialized();
  const activeCount = extensions.filter((ext) => ext.status === "active").length;
  const errorCount = extensions.filter((ext) => ext.status === "error").length;

  return {
    extensions,
    isInitialized,
    activeCount,
    errorCount,
  };
}

// ============================================================================
// useExtensionInitializer Hook
// ============================================================================

/**
 * Hook that initializes the ExtensionManager on mount.
 * Should be called once at the root of the application.
 * 
 * IMPORTANT: This now calls bootstrapShell() first to register all
 * Shell service implementations with the API layer before loading extensions.
 */
export function useExtensionInitializer(): {
  isLoading: boolean;
  isReady: boolean;
  error: Error | null;
} {
  const [isLoading, setIsLoading] = useState(true);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let mounted = true;

    async function init() {
      try {
        // CRITICAL: Bootstrap Shell services BEFORE initializing extensions
        // This registers all Shell implementations with the API layer
        bootstrapShell();

        // Now initialize extensions (they can safely use the API)
        await ExtensionManager.initialize();
        
        if (mounted) {
          setIsReady(true);
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        if (mounted) {
          setIsLoading(false);
        }
      }
    }

    init();

    return () => {
      mounted = false;
    };
  }, []);

  return { isLoading, isReady, error };
}