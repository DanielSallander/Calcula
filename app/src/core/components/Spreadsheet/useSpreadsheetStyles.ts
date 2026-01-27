//! FILENAME: app/src/core/components/Spreadsheet/useSpreadsheetStyles.ts
// PURPOSE: Manages style data, caching, and backend synchronization.
// CONTEXT: Handles fetching styles from the Rust backend and updating the React state cache.
// FIX: Improved immediate style visibility by ensuring selected cell is refreshed

import { useState, useCallback, useEffect, useRef } from "react";
import { getAllStyles } from "../../lib/tauri-api";
import type { GridCanvasHandle } from "../Grid";
import type { StyleDataMap, StyleData } from "../../types";
import { DEFAULT_STYLE } from "../../types";

/**
 * Create a default style cache with the default style at index 0.
 */
function createDefaultStyleCache(): StyleDataMap {
  const cache = new Map<number, StyleData>();
  cache.set(0, DEFAULT_STYLE);
  return cache;
}

export function useSpreadsheetStyles(canvasRef: React.RefObject<GridCanvasHandle | null>) {
  // Style cache for rendering cell formatting
  const [styleCache, setStyleCache] = useState<StyleDataMap>(() => createDefaultStyleCache());
  
  // Track style cache version for forcing re-renders
  const [styleCacheVersion, setStyleCacheVersion] = useState(0);
  
  // Ref to track if initial load is complete
  const initialLoadComplete = useRef(false);

  /**
   * Fetch all styles from the backend and update the style cache.
   * Returns a promise that resolves when styles are loaded.
   */
  const refreshStyles = useCallback(async (): Promise<StyleDataMap> => {
    try {
      const styles = await getAllStyles();
      const newCache = new Map<number, StyleData>();
      
      // Add all styles from backend - array index corresponds to style index
      styles.forEach((style, index) => {
        newCache.set(index, style);
      });
      
      // Ensure we have at least a default style
      if (newCache.size === 0) {
        newCache.set(0, DEFAULT_STYLE);
      }
      
      console.log(`[Styles] Loaded ${newCache.size} styles from backend`);
      
      // Debug: log non-default styles with more detail (using camelCase properties)
      newCache.forEach((style, index) => {
        if (index > 0) {
          console.log(`[Styles] Style ${index}:`, JSON.stringify({
            bold: style.bold,
            italic: style.italic,
            underline: style.underline,
            textColor: style.textColor,
            backgroundColor: style.backgroundColor,
            numberFormat: style.numberFormat,
          }));
        }
      });
      
      return newCache;
    } catch (error) {
      console.error("[Styles] Failed to fetch styles:", error);
      // On error, return a default style cache
      const fallbackCache = new Map<number, StyleData>();
      fallbackCache.set(0, DEFAULT_STYLE);
      return fallbackCache;
    }
  }, []);

  /**
   * Fetch styles on component mount.
   */
  useEffect(() => {
    refreshStyles().then((cache) => {
      setStyleCache(cache);
      setStyleCacheVersion(v => v + 1);
      initialLoadComplete.current = true;
    });
  }, [refreshStyles]);

  /**
   * Handle cells updated from Ribbon formatting.
   * FIX: Immediate refresh without waiting for next render cycle.
   */
  const handleCellsUpdated = useCallback(async () => {
    console.log("[Styles] handleCellsUpdated called - refreshing styles...");
    
    try {
      // Fetch fresh styles from backend
      const newCache = await refreshStyles();
      
      // Update state synchronously
      setStyleCache(newCache);
      setStyleCacheVersion(v => v + 1);
      
      console.log("[Styles] Style cache updated, triggering immediate refresh");
      
      // FIX: Immediate refresh instead of deferred
      // Refresh cells immediately in the current frame
      const canvas = canvasRef.current;
      if (canvas) {
        // First refresh the cells to get latest data from backend
        await canvas.refreshCells();
        
        // Then immediately redraw to show the new styles
        // This ensures the user sees the style change right away
        canvas.redraw();
        
        console.log("[Styles] Cells refreshed and redrawn");
      }
    } catch (error) {
      console.error("[Styles] Failed to refresh styles:", error);
    }
  }, [refreshStyles, canvasRef]);

  return {
    styleCache,
    styleCacheVersion,
    handleCellsUpdated,
    refreshStyles
  };
}