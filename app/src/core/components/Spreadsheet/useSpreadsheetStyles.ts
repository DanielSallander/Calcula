//! FILENAME: app/src/core/components/Spreadsheet/useSpreadsheetStyles.ts
// PURPOSE: Manages style data, caching, and backend synchronization.
// CONTEXT: Handles fetching styles from the Rust backend and updating the React state cache.

import { useState, useCallback, useEffect, useRef } from "react";
import { getAllStyles, getStyleCount } from "../../lib/tauri-api";
import { AppEvents, onAppEvent } from "../../lib/events";
import type { GridCanvasHandle } from "../Grid";
import type { StyleDataMap, StyleData, StyleEntry } from "../../types";
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

  // The cache as the last committed render saw it. The two listeners below run
  // outside React's render cycle and must not reason from a captured state
  // value: two formatting commands in one tick would make the second one merge
  // into the FIRST one's starting cache and drop the first one's entry.
  const styleCacheRef = useRef<StyleDataMap>(styleCache);

  /** Replace the cache, keeping the ref that the listeners read in step. */
  const commitStyleCache = useCallback((next: StyleDataMap): void => {
    styleCacheRef.current = next;
    setStyleCache(next);
    setStyleCacheVersion(v => v + 1);
  }, []);

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
      commitStyleCache(cache);
      initialLoadComplete.current = true;
    });
  }, [refreshStyles, commitStyleCache]);

  /**
   * PRIME. A formatting command MINTS a registry index, and the renderer's
   * lookup (`getStyleFromCache`) falls back to index 0 -- the document default
   * -- for an index the cache does not hold. So a cell formatted through any
   * route that refreshes CELLS but not the STYLE TABLE painted unformatted
   * while `get_style` reported the format correctly. Measured on the running
   * app (BUG-0076): Ctrl+B on a cell with a background fill turned it WHITE and
   * left it unbolded -- 2,277 fill pixels went to 0 -- while `get_style`
   * reported bold AND the colour.
   *
   * `apply_formatting` / `apply_border_preset` already return the entries they
   * used or created, and their tauri-api wrappers now announce them (see
   * `announceStyleEntries`). Merging them here is the cache learning about the
   * mint from the command that performed it -- no IPC, and it lands before the
   * repaint, so no frame is ever painted with the wrong style.
   */
  useEffect(() => {
    return onAppEvent<{ styles: StyleEntry[] }>(
      AppEvents.STYLE_ENTRIES_UPDATED,
      (payload) => {
        const entries = payload?.styles;
        if (!entries || entries.length === 0) return;
        const next = new Map(styleCacheRef.current);
        for (const entry of entries) {
          next.set(entry.index, entry.style);
        }
        commitStyleCache(next);
      },
    );
  }, [commitStyleCache]);

  /**
   * HEAL. Not every mint goes through a frontend wrapper: an MCP tool
   * (`mcp/tools.rs` format_range), a `.calp` pull and a backend recalculation
   * mint styles in Rust and announce nothing but `grid:refresh`. Those routes
   * have no result to prime from, so the cache is checked against the registry
   * COUNT -- a scalar IPC, next to the viewport cell fetch `grid:refresh` is
   * already paying for -- and re-read in full only when the two disagree.
   *
   * `!==` and not `>`: a document replaced under the frontend (a `.calp`
   * refresh, an AutoRecover restore) can leave the registry SHORTER, and a
   * cache with entries the backend no longer has is just as wrong.
   */
  const verifyingRef = useRef(false);
  useEffect(() => {
    const handler = (): void => {
      if (verifyingRef.current) return;
      verifyingRef.current = true;
      void (async () => {
        try {
          const count = await getStyleCount();
          if (count !== styleCacheRef.current.size) {
            console.log(
              `[Styles] registry has ${count} styles, cache has ` +
              `${styleCacheRef.current.size} - re-reading`,
            );
            commitStyleCache(await refreshStyles());
          }
        } catch (error) {
          console.error("[Styles] style-count check failed:", error);
        } finally {
          verifyingRef.current = false;
        }
      })();
    };
    // Two triggers, one check. `grid:refresh` is every out-of-band mutation;
    // `sheet:normalSwitch` is the other moment the viewport's cells are
    // replaced wholesale -- and the one where an index minted while ANOTHER
    // sheet was active first becomes visible.
    window.addEventListener(AppEvents.GRID_DATA_REFRESH, handler);
    window.addEventListener("sheet:normalSwitch", handler);
    return () => {
      window.removeEventListener(AppEvents.GRID_DATA_REFRESH, handler);
      window.removeEventListener("sheet:normalSwitch", handler);
    };
  }, [commitStyleCache, refreshStyles]);

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
      commitStyleCache(newCache);
      
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
  }, [refreshStyles, canvasRef, commitStyleCache]);

  /**
   * Listen for "styles:refresh" events dispatched by extensions (e.g., FormatCellsDialog)
   * or undo/redo to keep the style cache in sync with the backend.
   */
  useEffect(() => {
    const handler = () => {
      handleCellsUpdated();
    };
    window.addEventListener("styles:refresh", handler);
    return () => window.removeEventListener("styles:refresh", handler);
  }, [handleCellsUpdated]);

  return {
    styleCache,
    styleCacheVersion,
    handleCellsUpdated,
    refreshStyles
  };
}