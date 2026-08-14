//! FILENAME: app/src/core/components/Grid/GridCanvas.tsx
// PURPOSE: Canvas component for rendering the spreadsheet grid.
// CONTEXT: This component manages the HTML5 Canvas element used for
// high-performance grid rendering. It handles device pixel ratio scaling,
// automatic resizing, fetching cell data from the backend, and delegates
// actual grid drawing to the gridRenderer module.

import React, { useRef, useEffect, useLayoutEffect, useCallback, useImperativeHandle, forwardRef, useState } from "react";
import { renderGrid, DEFAULT_THEME, calculateVisibleRange } from "../../lib/gridRenderer";
import { getViewportCells, getSpillRanges } from "../../lib/tauri-api";
import type { GridConfig, Viewport, Selection, EditingCell, CellDataMap, FormulaReference, DimensionOverrides, StyleDataMap, ClipboardMode, InsertionAnimation, FreezeConfig, SplitConfig, SpillRangeInfo, ViewMode } from "../../types";
import { cellKey, createEmptyDimensionOverrides, DEFAULT_FREEZE_CONFIG, DEFAULT_SPLIT_CONFIG } from "../../types";
import type { GridTheme } from "../../lib/gridRenderer";
import { getGridRegions, getOverlayRenderers, getPostHeaderOverlayRenderers, onRegionChange } from "../../../api/gridOverlays";
import { getColumnX, getRowY } from "../../lib/gridRenderer/layout/dimensions";
import { setGridCapturer, setGridCanvas, type CaptureRange } from "../../lib/gridCapture";
import {
  markDataCommitted,
  markFetchSettled,
  markFetchStarted,
  markPainted,
  markRefetchQueued,
} from "../../lib/renderSignal";
import {
  registerSheetSwitchPrefetcher,
  takePrefetchedSheetSwitch,
} from "../../lib/sheetSwitchPrefetch";
import * as S from "./GridCanvas.styles";

/**
 * Props for the GridCanvas component.
 */
export interface GridCanvasProps {
  /** Grid configuration for dimensions */
  config: GridConfig;
  /** Current viewport position and size */
  viewport: Viewport;
  /** Current selection (null if nothing selected) */
  selection: Selection | null;
  /** Cell being edited (null if not editing) */
  editing: EditingCell | null;
  /** Formula references to highlight */
  formulaReferences?: FormulaReference[];
  /** Custom column/row dimensions */
  dimensions?: DimensionOverrides;
  /** Style cache for cell formatting (Phase 6) */
  styleCache?: StyleDataMap;
  /** Fill preview range during fill handle drag */
  fillPreviewRange?: Selection | null;
  /** Selection drag preview showing where cells will be moved */
  selectionDragPreview?: Selection | null;
  /** Whether the current drag is a move or copy (Ctrl held) */
  selectionDragMode?: "move" | "copy";
  /** Clipboard selection for marching ants */
  clipboardSelection?: Selection | null;
  /** Clipboard mode (none, copy, cut) */
  clipboardMode?: ClipboardMode;
  /** Freeze panes configuration */
  freezeConfig?: FreezeConfig;
  /** Split window configuration */
  splitConfig?: SplitConfig;
  /** Independent viewport for split window top/left panes */
  splitViewport?: Viewport;
  /** Current view mode */
  viewMode?: ViewMode;
  /** Whether to show raw formulas instead of calculated values */
  showFormulas?: boolean;
  /** Whether to display zero values in cells (when false, zeros appear as blank) */
  displayZeros?: boolean;
  /** Whether to display gridlines (when false, gridlines are hidden) */
  displayGridlines?: boolean;
  /** Whether to display row/column headings (when false, headers are hidden) */
  displayHeadings?: boolean;
  /** Reference style — "R1C1" renders formulas/headers in R1C1 notation */
  referenceStyle?: "A1" | "R1C1";
  /** Optional theme override */
  theme?: GridTheme;
  /** Callback when canvas is clicked */
  onMouseDown?: (event: React.MouseEvent<HTMLCanvasElement>) => void;
  /** Callback when mouse moves over canvas */
  onMouseMove?: (event: React.MouseEvent<HTMLCanvasElement>) => void;
  /** Callback when mouse button is released */
  onMouseUp?: (event: React.MouseEvent<HTMLCanvasElement>) => void;
  /** Optional class name for styling */
  className?: string;
  /** Current sheet name for cross-sheet reference highlighting */
  currentSheetName?: string;
  /** Zoom factor (1.0 = 100%) */
  zoom?: number;
}

/**
 * Imperative handle for the GridCanvas component.
 * Allows parent components to trigger redraws and access canvas internals.
 */
export interface GridCanvasHandle {
  /** Force a redraw of the canvas */
  redraw: () => void;
  /** Get the canvas element */
  getCanvas: () => HTMLCanvasElement | null;
  /** Get the rendering context */
  getContext: () => CanvasRenderingContext2D | null;
  /** Refresh cell data from backend - returns Promise for sequencing */
  refreshCells: () => Promise<void>;
  /** * Animate row insertion with smooth "flow" effect.
   * Call AFTER backend operation and refreshCells() complete.
   * @param index - Row index where insertion starts (0-based)
   * @param count - Number of rows being inserted
   * @param durationMs - Animation duration in milliseconds (default: 200)
   * @returns Promise that resolves when animation completes
   */
  animateRowInsertion: (index: number, count: number, durationMs?: number) => Promise<void>;
  /**
   * Animate column insertion with smooth "flow" effect.
   * Call AFTER backend operation and refreshCells() complete.
   * @param index - Column index where insertion starts (0-based)
   * @param count - Number of columns being inserted
   * @param durationMs - Animation duration in milliseconds (default: 200)
   * @returns Promise that resolves when animation completes
   */
  animateColumnInsertion: (index: number, count: number, durationMs?: number) => Promise<void>;
  /**
   * Animate row deletion with smooth "collapse" effect.
   * Call AFTER backend operation and refreshCells() complete.
   * @param index - Row index where deletion starts (0-based)
   * @param count - Number of rows that were deleted
   * @param durationMs - Animation duration in milliseconds (default: 200)
   * @returns Promise that resolves when animation completes
   */
  animateRowDeletion: (index: number, count: number, durationMs?: number) => Promise<void>;
  /**
   * Animate column deletion with smooth "collapse" effect.
   * Call AFTER backend operation and refreshCells() complete.
   * @param index - Column index where deletion starts (0-based)
   * @param count - Number of columns that were deleted
   * @param durationMs - Animation duration in milliseconds (default: 200)
   * @returns Promise that resolves when animation completes
   */
  animateColumnDeletion: (index: number, count: number, durationMs?: number) => Promise<void>;
}

/**
 * Buffer zone around visible area for prefetching cells.
 * This reduces cell loading during small scroll movements.
 */
const CELL_BUFFER = 2;

/**
 * Animation speed for marching ants (pixels per frame at 60fps).
 * Lower = slower march. 0.5 gives a nice subtle effect.
 */
const MARCHING_ANTS_SPEED = 0.5;

/**
 * Total length of dash pattern (dash + gap) for animation wrap.
 */
const DASH_PATTERN_LENGTH = 8; // 4px dash + 4px gap

/**
 * Default duration for insertion/deletion animations in milliseconds.
 */
const DEFAULT_ANIMATION_DURATION = 200;

/**
 * Easing function for smooth animation (ease-out cubic).
 * Starts fast, slows down at the end for a natural feel.
 */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * GridCanvas component - renders the spreadsheet grid using HTML5 Canvas.
 * Uses forwardRef to expose imperative methods to parent components.
 */
export const GridCanvas = forwardRef<GridCanvasHandle, GridCanvasProps>(
  function GridCanvas(props, ref) {
    const {
      config,
      viewport,
      selection,
      editing,
      formulaReferences = [],
      dimensions,
      styleCache,
      fillPreviewRange,
      selectionDragPreview,
      selectionDragMode = "move",
      clipboardSelection,
      clipboardMode = "none",
      freezeConfig = DEFAULT_FREEZE_CONFIG,
      splitConfig = DEFAULT_SPLIT_CONFIG,
      splitViewport,
      viewMode = "normal",
      showFormulas = false,
      displayZeros = true,
      displayGridlines = true,
      displayHeadings = true,
      referenceStyle = "A1",
      theme = DEFAULT_THEME,
      onMouseDown,
      onMouseMove,
      onMouseUp,
      className,
      currentSheetName,
      zoom = 1,
    } = props;

    const containerRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [context, setContext] = useState<CanvasRenderingContext2D | null>(null);
    const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

    // Cell data cache
    const [cells, setCells] = useState<CellDataMap>(new Map());

    // Spill ranges for blue dashed border rendering
    const [spillRanges, setSpillRanges] = useState<SpillRangeInfo[]>([]);

    // Track the last fetched range to avoid redundant fetches
    const lastFetchRef = useRef<{
      startRow: number;
      endRow: number;
      startCol: number;
      endCol: number;
    } | null>(null);

    // Track if a fetch is in progress
    const fetchingRef = useRef<boolean>(false);
    // Track if a fetch was requested while another was in progress.
    // When set, the finally block will invalidate the cache and bump
    // fetchGeneration so the effect re-runs with the current viewport.
    const pendingRefreshRef = useRef<boolean>(false);
    // Generation counter: incremented to force the fetch effect to re-run
    // after a deferred fetch completes (works around stale-closure issues).
    const [fetchGeneration, setFetchGeneration] = useState(0);

    // BUG-0052: which sheet the cell cache describes, as an epoch. Bumped by
    // every `sheet:normalSwitch`; a fetch that was in flight ACROSS the bump
    // fetched under the previous sheet's identity and must not be committed
    // over the new sheet's cells (the backend answers `get_viewport_cells`
    // for whatever sheet is active WHEN IT SERVES the call, so a response
    // that straddles a switch is undecidable — discard and re-fetch).
    const sheetEpochRef = useRef(0);
    // BUG-0052: a prefetched sheet switch was just committed to state, and the
    // canvas owes a SYNCHRONOUS repaint in the same flush (layout effect
    // below), so the bold tab and the new cells reach the screen in one paint.
    const syncPaintOwedRef = useRef(false);

    // Animation state for marching ants
    const animationFrameRef = useRef<number | null>(null);
    const animationOffsetRef = useRef<number>(0);

    // Animation state for row/column insertion/deletion
    const [insertionAnimation, setInsertionAnimation] = useState<InsertionAnimation | null>(null);
    const insertionAnimationRef = useRef<{
      startTime: number;
      duration: number;
      resolve: () => void;
    } | null>(null);

    // Ensure we have valid dimensions
    const dims = dimensions || createEmptyDimensionOverrides();

    /**
     * Initialize canvas and set up resize observer.
     */
    useEffect(() => {
      const container = containerRef.current;
      const canvas = canvasRef.current;

      if (!container || !canvas) {
        return;
      }

      // Set up the canvas context
      const ctx = canvas.getContext("2d");
      if (ctx) {
        setContext(ctx);
      }

      // Handle resize
      const updateSize = () => {
        const rect = container.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const width = Math.floor(rect.width);
        const height = Math.floor(rect.height);

        if (width > 0 && height > 0) {
          canvas.width = width * dpr;
          canvas.height = height * dpr;
          canvas.style.width = `${width}px`;
          canvas.style.height = `${height}px`;

          if (ctx) {
            ctx.scale(dpr, dpr);
          }

          setCanvasSize({ width, height });
        }
      };

      // Initial size
      updateSize();

      // Set up resize observer
      const resizeObserver = new ResizeObserver(() => {
        updateSize();
      });

      resizeObserver.observe(container);

      return () => {
        resizeObserver.disconnect();
      };
    }, []);

    /**
     * Calculate the cell range to fetch (visible range + buffer).
     * With freeze panes, we need to fetch frozen cells plus scrollable cells.
     */
    const calculateFetchRange = useCallback(() => {
      if (canvasSize.width === 0 || canvasSize.height === 0) {
        return null;
      }

      const range = calculateVisibleRange(viewport, config, canvasSize.width / zoom, canvasSize.height / zoom, dims);

      // Calculate the base range from scroll position
      let startRow = Math.max(0, range.startRow - CELL_BUFFER);
      let endRow = Math.min(config.totalRows - 1, range.endRow + CELL_BUFFER);
      let startCol = Math.max(0, range.startCol - CELL_BUFFER);
      let endCol = Math.min(config.totalCols - 1, range.endCol + CELL_BUFFER);

      // With freeze panes, always include frozen rows/cols in fetch
      if (freezeConfig.freezeRow !== null && freezeConfig.freezeRow > 0) {
        startRow = 0; // Always fetch from row 0 to include frozen rows
      }
      if (freezeConfig.freezeCol !== null && freezeConfig.freezeCol > 0) {
        startCol = 0; // Always fetch from col 0 to include frozen columns
      }

      // With split window, expand fetch range to cover both panes' visible content
      const hasSplitRows = splitConfig.splitRow !== null && splitConfig.splitRow > 0;
      const hasSplitCols = splitConfig.splitCol !== null && splitConfig.splitCol > 0;
      if ((hasSplitRows || hasSplitCols) && splitViewport) {
        // Calculate visible range for split viewport panes
        const splitRange = calculateVisibleRange(splitViewport, config, canvasSize.width / zoom, canvasSize.height / zoom, dims);
        startRow = Math.min(startRow, Math.max(0, splitRange.startRow - CELL_BUFFER));
        endRow = Math.max(endRow, Math.min(config.totalRows - 1, splitRange.endRow + CELL_BUFFER));
        startCol = Math.min(startCol, Math.max(0, splitRange.startCol - CELL_BUFFER));
        endCol = Math.max(endCol, Math.min(config.totalCols - 1, splitRange.endCol + CELL_BUFFER));
      } else if (hasSplitRows || hasSplitCols) {
        // Fallback: no splitViewport yet, fetch from 0
        if (hasSplitRows) startRow = 0;
        if (hasSplitCols) startCol = 0;
      }

      return { startRow, endRow, startCol, endCol };
    }, [viewport, config, canvasSize.width, canvasSize.height, dims, freezeConfig, splitConfig, splitViewport, zoom]);

    /**
     * Check if we need to fetch new cells based on scroll position.
     */
    const needsFetch = useCallback((newRange: { startRow: number; endRow: number; startCol: number; endCol: number } | null): boolean => {
      if (!newRange) {
        return false;
      }

      const lastFetch = lastFetchRef.current;
      if (!lastFetch) {
        return true;
      }

      // Only fetch if we've scrolled outside the buffered range
      return (
        newRange.startRow < lastFetch.startRow ||
        newRange.endRow > lastFetch.endRow ||
        newRange.startCol < lastFetch.startCol ||
        newRange.endCol > lastFetch.endCol
      );
    }, []);

    /**
     * Fetch cell data for the visible viewport from the backend.
     * Returns a Promise that resolves when fetch is complete.
     */
    const fetchCells = useCallback(async (force: boolean = false): Promise<void> => {
      const fetchRange = calculateFetchRange();
      if (!fetchRange) {
        markRefetchQueued(false);
        return;
      }

      // Check if we need to fetch
      if (!force && !needsFetch(fetchRange)) {
        // Nothing owed: the cache already covers the viewport. Clearing the
        // "a re-fetch is owed" flag here is what stops it latching forever when
        // the deferred request turns out to be redundant — and it is safe
        // BECAUSE the deferral path nulls `lastFetchRef`, so the re-issued call
        // always finds `needsFetch` true and reaches the fetch below.
        markRefetchQueued(false);
        return;
      }

      // Prevent concurrent fetches — if another fetch is needed while one is
      // in progress, mark it as pending so we re-fetch once it completes.
      // This is critical for scroll-triggered fetches: without it, scrolling
      // back while a fetch is in flight silently drops the new request,
      // leaving previously-visible rows blank.
      if (fetchingRef.current) {
        console.log(`[GridCanvas] fetchCells(force=${force}) deferred — fetch in progress, will retry after`);
        pendingRefreshRef.current = true;
        markRefetchQueued(true);
        return;
      }

      fetchingRef.current = true;
      // The re-fetch this call may have been scheduled BY is now under way, so
      // the debt is discharged by the in-flight count from here on.
      markRefetchQueued(false);
      markFetchStarted();
      const perfT0 = performance.now();
      // BUG-0052: remember which sheet this fetch was issued FOR.
      const epochAtStart = sheetEpochRef.current;

      try {
        const cellData = await getViewportCells(
          fetchRange.startRow,
          fetchRange.startCol,
          fetchRange.endRow,
          fetchRange.endCol
        );

        // BUG-0052: a sheet switch landed while this fetch was in flight. The
        // response may describe EITHER sheet (whichever was active when the
        // backend served it), so committing it could paint the old sheet's
        // cells over the new sheet's — the exact tear this epoch exists to
        // close. Discard, and schedule a re-fetch under the current epoch via
        // the existing deferral machinery (the finally block below).
        if (epochAtStart !== sheetEpochRef.current) {
          console.log(
            "[GridCanvas] fetchCells result discarded - sheet switched while in flight; re-fetching",
          );
          pendingRefreshRef.current = true;
          return;
        }
        const perfT1Ipc = performance.now();

        // Update last fetch reference
        lastFetchRef.current = {
          startRow: fetchRange.startRow,
          endRow: fetchRange.endRow,
          startCol: fetchRange.startCol,
          endCol: fetchRange.endCol,
        };

        // Convert array to map for fast lookup
        const newCells: CellDataMap = new Map();
        for (const cell of cellData) {
          newCells.set(cellKey(cell.row, cell.col), cell);
        }

        // Debug: log cell info including merge spans
        if (cellData.length > 0) {
          const firstCell = cellData[0];
          console.log(`[Cells] Fetched ${cellData.length} cells. First cell: row=${firstCell.row}, col=${firstCell.col}, display="${firstCell.display}", styleIndex=${firstCell.styleIndex}, rowSpan=${firstCell.rowSpan}, colSpan=${firstCell.colSpan}`);

          // Log any merged cells (cells with span > 1)
          const mergedCells = cellData.filter(c => (c.rowSpan && c.rowSpan > 1) || (c.colSpan && c.colSpan > 1));
          if (mergedCells.length > 0) {
            console.log(`[Cells] Found ${mergedCells.length} merged master cells:`, mergedCells.map(c => `(${c.row},${c.col}) ${c.rowSpan}x${c.colSpan}`));
          }
        }

        setCells(newCells);

        // Fetch spill ranges for blue border rendering (lightweight call)
        try {
          const ranges = await getSpillRanges();
          setSpillRanges(ranges);
        } catch {
          // Non-critical: silently ignore spill range fetch failures
        }

        // Announce the commit AFTER the spill ranges, not after `setCells`:
        // both feed the same paint, and a capture that resumed between them
        // would photograph cells without their spill borders.
        markDataCommitted();

        const perfT2Total = performance.now();
        console.log(
          `[PERF] fetchCells range=(${fetchRange.startRow},${fetchRange.startCol})-(${fetchRange.endRow},${fetchRange.endCol}) ` +
          `count=${cellData.length} | ipc=${(perfT1Ipc - perfT0).toFixed(1)}ms map=${(perfT2Total - perfT1Ipc).toFixed(1)}ms TOTAL=${(perfT2Total - perfT0).toFixed(1)}ms`
        );
      } catch (error) {
        console.error("Failed to fetch cells:", error);
      } finally {
        fetchingRef.current = false;
        markFetchSettled();

        // If another fetch was requested while we were fetching (scroll or
        // forced refresh), invalidate the cache and bump the generation
        // counter so the useEffect re-runs with the CURRENT viewport.
        // We avoid calling fetchCells(true) here because this closure may
        // capture a stale viewport, causing it to re-fetch the wrong range.
        if (pendingRefreshRef.current) {
          console.log('[GridCanvas] Fetch was deferred during in-flight request — scheduling re-fetch');
          pendingRefreshRef.current = false;
          lastFetchRef.current = null;
          // `refetchQueued` deliberately stays SET across this gap: the state
          // bump below reaches `fetchCells` in a later tick, and a capture that
          // polled in between would otherwise see a quiescent grid that is
          // about to change.
          setFetchGeneration(g => g + 1);
        }
      }
    }, [calculateFetchRange, needsFetch]);

    /**
     * Force refresh cells from backend (clears cache).
     * Returns a Promise for proper sequencing.
     */
    const refreshCells = useCallback(async (): Promise<void> => {
      console.log('[GridCanvas] refreshCells called');
      lastFetchRef.current = null;
      await fetchCells(true);
    }, [fetchCells]);

    /**
     * Draw the grid content using the grid renderer.
     * Accepts optional animation offset for marching ants and insertion animation.
     */
    const draw = useCallback((animationOffset: number = 0, currentInsertionAnimation: InsertionAnimation | null = null) => {
      if (!context || canvasSize.width === 0 || canvasSize.height === 0) {
        return;
      }

      const perfDrawStart = performance.now();

      // Apply zoom + DPR transform before drawing
      const dpr = window.devicePixelRatio || 1;
      context.setTransform(dpr * zoom, 0, 0, dpr * zoom, 0, 0);

      // Effective logical dimensions at this zoom level
      const effectiveWidth = canvasSize.width / zoom;
      const effectiveHeight = canvasSize.height / zoom;

      // Clear the canvas at effective dimensions
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, effectiveWidth, effectiveHeight);

      // Render the grid with cell data, formula references, style cache, fill preview, selection drag preview, clipboard, insertion animation, freeze config, and sheet context
      renderGrid(
        context,
        effectiveWidth,
        effectiveHeight,
        config,
        viewport,
        selection,
        editing,
        cells,
        theme,
        formulaReferences,
        dims,
        styleCache,
        fillPreviewRange,
        selectionDragPreview,
        selectionDragMode,
        clipboardSelection,
        clipboardMode,
        animationOffset,
        currentInsertionAnimation,
        freezeConfig,
        getGridRegions(),
        getOverlayRenderers(),
        currentSheetName,
        getPostHeaderOverlayRenderers(),
        spillRanges,
        splitConfig,
        splitViewport,
        viewMode,
        undefined, // pageSetup
        showFormulas,
        displayZeros,
        displayGridlines,
        displayHeadings,
        referenceStyle,
      );

      // The frame is on the canvas. Stamp it, so a capture can tell "painted
      // since the data last changed" from "merely idle" (see lib/renderSignal).
      markPainted();

      const perfDrawMs = performance.now() - perfDrawStart;
      if (perfDrawMs > 5) {
        console.log(`[PERF] draw ms=${perfDrawMs.toFixed(1)}`, new Error().stack?.split('\n').slice(1, 4).join(' <- '));
      }
    }, [context, canvasSize.width, canvasSize.height, config, viewport, selection, editing, cells, theme, formulaReferences, dims, styleCache, fillPreviewRange, selectionDragPreview, selectionDragMode, clipboardSelection, clipboardMode, freezeConfig, splitConfig, splitViewport, viewMode, showFormulas, displayZeros, displayGridlines, displayHeadings, referenceStyle, currentSheetName, zoom, spillRanges]);

    /**
     * Start row insertion animation.
     * Should be called AFTER backend operation and refreshCells() complete.
     */
    const animateRowInsertion = useCallback((index: number, count: number, durationMs: number = DEFAULT_ANIMATION_DURATION): Promise<void> => {
      return new Promise((resolve) => {
        const targetSize = config.defaultCellHeight || 20;
        
        // Set initial animation state - progress starts at 0
        setInsertionAnimation({
          type: "row",
          direction: "insert",
          index,
          count,
          progress: 0,
          targetSize,
        });

        insertionAnimationRef.current = {
          startTime: performance.now(),
          duration: durationMs,
          resolve,
        };
      });
    }, [config.defaultCellHeight]);

    /**
     * Start column insertion animation.
     * Should be called AFTER backend operation and refreshCells() complete.
     */
    const animateColumnInsertion = useCallback((index: number, count: number, durationMs: number = DEFAULT_ANIMATION_DURATION): Promise<void> => {
      return new Promise((resolve) => {
        const targetSize = config.defaultCellWidth || 100;
        
        // Set initial animation state - progress starts at 0
        setInsertionAnimation({
          type: "column",
          direction: "insert",
          index,
          count,
          progress: 0,
          targetSize,
        });

        insertionAnimationRef.current = {
          startTime: performance.now(),
          duration: durationMs,
          resolve,
        };
      });
    }, [config.defaultCellWidth]);

    /**
     * Start row deletion animation.
     * Should be called AFTER backend operation and refreshCells() complete.
     */
    const animateRowDeletion = useCallback((index: number, count: number, durationMs: number = DEFAULT_ANIMATION_DURATION): Promise<void> => {
      return new Promise((resolve) => {
        const targetSize = config.defaultCellHeight || 20;
        
        // Set initial animation state - progress starts at 0
        setInsertionAnimation({
          type: "row",
          direction: "delete",
          index,
          count,
          progress: 0,
          targetSize,
        });

        insertionAnimationRef.current = {
          startTime: performance.now(),
          duration: durationMs,
          resolve,
        };
      });
    }, [config.defaultCellHeight]);

    /**
     * Start column deletion animation.
     * Should be called AFTER backend operation and refreshCells() complete.
     */
    const animateColumnDeletion = useCallback((index: number, count: number, durationMs: number = DEFAULT_ANIMATION_DURATION): Promise<void> => {
      return new Promise((resolve) => {
        const targetSize = config.defaultCellWidth || 100;
        
        // Set initial animation state - progress starts at 0
        setInsertionAnimation({
          type: "column",
          direction: "delete",
          index,
          count,
          progress: 0,
          targetSize,
        });

        insertionAnimationRef.current = {
          startTime: performance.now(),
          duration: durationMs,
          resolve,
        };
      });
    }, [config.defaultCellWidth]);

    /**
     * Combined animation loop for marching ants and insertion/deletion animations.
     *
     * REDUCED MOTION. `document.documentElement.dataset.reducedMotion` is the
     * app's own accessibility switch: `skinLoader.apply()` stamps it from
     * `a11y.reducedMotion`, which is the OS `prefers-reduced-motion` query OR
     * the explicit toggle in Settings > Appearance. Until now NOTHING read it —
     * the toggle was inert — and the marching ants are the one piece of motion
     * in the product that never stops on its own, which makes them exactly what
     * a user asking for reduced motion is asking to be rid of. When it is on,
     * the dashed border is still drawn (the range you copied must stay visible;
     * reduced motion removes the MOTION, not the information) at a fixed phase,
     * and no animation frame is scheduled for it at all.
     *
     * It also makes the border deterministic, which the E2E capture helpers
     * depend on: `screenshotGates.ts` names the marching-ants border as the one
     * non-deterministic element in either suite, because its dash phase is
     * wall-clock driven. Playwright's `animations: "disabled"` freezes CSS
     * animations and cannot see canvas motion; this switch is the equivalent
     * lever for a canvas app, and `takeGridScreenshot` turns it on.
     *
     * The flag is read PER FRAME rather than when the effect runs. That costs
     * one `dataset` read per frame, and only while a marquee is actually up,
     * and it buys the thing an effect-time read cannot: turning reduced motion
     * ON stops a marquee that is ALREADY marching, within one frame, instead of
     * at the next copy. A preference that only takes effect after you do
     * something else is a preference users report as broken — and the capture
     * helpers would have hit exactly that, since the copy in a spec happens
     * before the screenshot that needs the border still.
     *
     * The insertion/deletion animation is deliberately NOT covered: it is
     * bounded, self-terminating and resolves a promise the caller awaits, so
     * suppressing it means completing it instantly rather than skipping it —
     * a different change, with a different failure mode, and it does not
     * affect any capture because the grid is settled by the time one is taken.
     */
    useEffect(() => {
      const prefersReducedMotion = (): boolean =>
        typeof document !== "undefined" &&
        document.documentElement.dataset.reducedMotion === "true";
      const hasClipboardMarquee = clipboardSelection && clipboardMode !== "none";
      const shouldAnimateClipboard = hasClipboardMarquee && !prefersReducedMotion();
      const shouldAnimateInsertion = insertionAnimation !== null;

      if (!shouldAnimateClipboard && !shouldAnimateInsertion) {
        // Cancel any existing animation
        if (animationFrameRef.current !== null) {
          cancelAnimationFrame(animationFrameRef.current);
          animationFrameRef.current = null;
        }
        // Reset offset
        animationOffsetRef.current = 0;
        return;
      }

      let lastTime = performance.now();

      const animate = (currentTime: number) => {
        // Calculate time delta for smooth animation regardless of frame rate
        const deltaTime = currentTime - lastTime;
        lastTime = currentTime;

        // Update marching ants offset. Re-read the preference each frame so
        // that switching reduced motion on parks a LIVE marquee at phase 0
        // rather than waiting for the next copy — see the note above.
        const marchThisFrame = hasClipboardMarquee && !prefersReducedMotion();
        if (marchThisFrame) {
          animationOffsetRef.current += MARCHING_ANTS_SPEED * (deltaTime / 16.67);
          if (animationOffsetRef.current >= DASH_PATTERN_LENGTH) {
            animationOffsetRef.current -= DASH_PATTERN_LENGTH;
          }
        } else if (hasClipboardMarquee) {
          animationOffsetRef.current = 0;
        }

        // Update insertion/deletion animation progress
        let currentInsertionAnim = insertionAnimation;
        if (shouldAnimateInsertion && insertionAnimationRef.current) {
          const { startTime, duration, resolve } = insertionAnimationRef.current;
          const elapsed = currentTime - startTime;
          const rawProgress = Math.min(elapsed / duration, 1);
          const easedProgress = easeOutCubic(rawProgress);

          if (rawProgress >= 1) {
            // Animation complete
            currentInsertionAnim = null;
            setInsertionAnimation(null);
            insertionAnimationRef.current = null;
            resolve();
          } else {
            // Update progress
            currentInsertionAnim = {
              ...insertionAnimation!,
              progress: easedProgress,
            };
            setInsertionAnimation(currentInsertionAnim);
          }
        }

        // Redraw with current animation states
        draw(animationOffsetRef.current, currentInsertionAnim);

        // Continue animation if still needed. `marchThisFrame` and not
        // `shouldAnimateClipboard`, so the loop STOPS the frame after reduced
        // motion is switched on instead of spinning forever redrawing an
        // unchanging border.
        if (marchThisFrame || (currentInsertionAnim !== null)) {
          animationFrameRef.current = requestAnimationFrame(animate);
        }
      };

      // Start animation
      animationFrameRef.current = requestAnimationFrame(animate);

      // Cleanup on unmount or when animation should stop
      return () => {
        if (animationFrameRef.current !== null) {
          cancelAnimationFrame(animationFrameRef.current);
          animationFrameRef.current = null;
        }
      };
    }, [clipboardSelection, clipboardMode, insertionAnimation, draw]);

    /**
     * Fetch cells when viewport changes or after a deferred fetch completes.
     * fetchGeneration is bumped when a fetch was dropped due to a concurrent
     * in-flight request, ensuring we re-fetch with the current viewport.
     */
    useEffect(() => {
      fetchCells();
    }, [fetchCells, fetchGeneration]);

    /**
     * Refetch cells when freeze config changes to ensure frozen cells are loaded.
     */
    useEffect(() => {
      // Force refetch when freeze config changes to ensure frozen cells are in cache
      lastFetchRef.current = null;
      fetchCells(true);
    }, [freezeConfig.freezeRow, freezeConfig.freezeCol]);

    /**
     * Refetch cells when split config changes to ensure split pane cells are loaded.
     */
    useEffect(() => {
      lastFetchRef.current = null;
      fetchCells(true);
    }, [splitConfig.splitRow, splitConfig.splitCol]);

    /**
     * Listen for grid:refresh events (from MenuBar merge/unmerge, undo/redo, etc.).
     * This ensures the canvas refreshes its cells when data changes externally.
     */
    useEffect(() => {
      const handleGridRefresh = async () => {
        console.log('[GridCanvas] grid:refresh event received - refreshing cells');
        await refreshCells();
        // Redraw after refresh to show updated data
        draw(animationOffsetRef.current, insertionAnimation);
      };

      window.addEventListener('grid:refresh', handleGridRefresh);

      return () => {
        window.removeEventListener('grid:refresh', handleGridRefresh);
      };
    }, [refreshCells, draw, insertionAnimation]);

    /**
     * Listen for app:grid-refresh events (from extensions via emitAppEvent).
     * Extensions use AppEvents.GRID_REFRESH to request a canvas redraw after
     * overlay state changes (e.g., chart selection, async render completion).
     * This only redraws—no cell data refresh needed since overlays don't change cells.
     */
    useEffect(() => {
      const handleAppGridRefresh = () => {
        draw(animationOffsetRef.current, insertionAnimation);
      };

      window.addEventListener('app:grid-refresh', handleAppGridRefresh);

      return () => {
        window.removeEventListener('app:grid-refresh', handleAppGridRefresh);
      };
    }, [draw, insertionAnimation]);

    /**
     * Listen for sheet switch events during formula mode.
     * When user switches sheets while editing a formula (Point Mode),
     * we need to refresh cells to show the new sheet's data.
     */
    useEffect(() => {
      const handleFormulaModeSheetSwitch = async (event: Event) => {
        const customEvent = event as CustomEvent<{
          newSheetIndex: number;
          newSheetName: string;
        }>;
        console.log(`[GridCanvas] Formula mode sheet switch to: ${customEvent.detail.newSheetName}`);
        
        // Clear the fetch cache and reload cells from the new active sheet
        lastFetchRef.current = null;
        await fetchCells(true);
      };

      window.addEventListener("sheet:formulaModeSwitch", handleFormulaModeSheetSwitch);

      return () => {
        window.removeEventListener("sheet:formulaModeSwitch", handleFormulaModeSheetSwitch);
      };
    }, [fetchCells]);

    /**
     * BUG-0052: the prefetcher a switch initiator uses to fetch the TARGET
     * sheet's viewport before the visible swap. Runs after the backend has
     * switched, so `getViewportCells` answers about the new sheet; the range
     * is the same one `fetchCells` would compute, so the payload is exactly
     * what the post-switch fetch used to commit — just fetched earlier.
     * The renderSignal in-flight bracket lives in `primeSheetSwitch` itself.
     */
    useEffect(() => {
      return registerSheetSwitchPrefetcher(async () => {
        const fetchRange = calculateFetchRange();
        if (!fetchRange) {
          return null;
        }
        const cellData = await getViewportCells(
          fetchRange.startRow,
          fetchRange.startCol,
          fetchRange.endRow,
          fetchRange.endCol
        );
        let prefetchedSpills: SpillRangeInfo[] = [];
        try {
          prefetchedSpills = await getSpillRanges();
        } catch {
          // Non-critical: same tolerance as fetchCells.
        }
        return { fetchRange, cells: cellData, spillRanges: prefetchedSpills };
      });
    }, [calculateFetchRange]);

    /**
     * Listen for normal sheet switch events (non-formula mode).
     * This replaces the page reload with a proper cell refresh.
     *
     * BUG-0052: when the initiator primed this switch (fetched the target
     * sheet's viewport BEFORE dispatching), commit the payload SYNCHRONOUSLY,
     * inside the same dispatch turn as the sheet-context change. React batches
     * both into one flush, and the layout effect below repaints the canvas in
     * that same flush — so the bold tab and the new sheet's cells hit the
     * screen in ONE paint instead of the strip leading the canvas by the
     * length of a backend round trip. Without a primed payload (formula-mode
     * bar switches, a prime that failed, no canvas), fall back to the old
     * fetch-after-swap path, which is the old two-frame tear but never a
     * wrong or missing paint.
     */
    useEffect(() => {
      const handleNormalSheetSwitch = async (event: Event) => {
        const customEvent = event as CustomEvent<{
          newSheetIndex: number;
          newSheetName: string;
        }>;
        console.log(`[GridCanvas] Normal sheet switch to: ${customEvent.detail.newSheetName}`);

        // Whatever happens next, a fetch that is IN FLIGHT right now was
        // issued for the previous sheet and must not be committed (see the
        // epoch check in fetchCells).
        sheetEpochRef.current += 1;

        const prefetched = takePrefetchedSheetSwitch(customEvent.detail.newSheetIndex);
        if (prefetched) {
          lastFetchRef.current = { ...prefetched.fetchRange };
          const newCells: CellDataMap = new Map();
          for (const cell of prefetched.cells) {
            newCells.set(cellKey(cell.row, cell.col), cell);
          }
          setCells(newCells);
          setSpillRanges(prefetched.spillRanges);
          syncPaintOwedRef.current = true;
          markDataCommitted();
          return;
        }

        // Clear the fetch cache and reload cells from the new active sheet
        lastFetchRef.current = null;
        await fetchCells(true);
      };

      window.addEventListener("sheet:normalSwitch", handleNormalSheetSwitch);

      return () => {
        window.removeEventListener("sheet:normalSwitch", handleNormalSheetSwitch);
      };
    }, [fetchCells]);

    /**
     * BUG-0052: the synchronous half of a prefetched sheet switch. Layout
     * effects run after React commits the DOM (the tab strip's bold weight)
     * but BEFORE the browser paints, so drawing here puts the new sheet's
     * cells on the canvas in the SAME paint as the new sheet's tab. Only runs
     * when a prefetched commit owes it — every other repaint keeps the
     * ordinary post-paint path.
     */
    useLayoutEffect(() => {
      if (!syncPaintOwedRef.current) {
        return;
      }
      syncPaintOwedRef.current = false;
      draw(animationOffsetRef.current, insertionAnimation);
    }, [draw, insertionAnimation]);

    /**
     * Redraw when dependencies change (but not during animation).
     * Animation loop handles redraws when clipboard is active or insertion is animating.
     */
    useEffect(() => {
      // Only do manual redraw when not animating
      const shouldAnimateClipboard = clipboardSelection && clipboardMode !== "none";
      const shouldAnimateInsertion = insertionAnimation !== null;
      if (!shouldAnimateClipboard && !shouldAnimateInsertion) {
        draw(0, null);
      }
    }, [draw, clipboardSelection, clipboardMode, insertionAnimation]);

    /**
     * Listen for overlay region changes (e.g., table created/resized/deleted)
     * and trigger a redraw so the overlay renderers pick up the new data.
     */
    useEffect(() => {
      const cleanup = onRegionChange(() => {
        draw(animationOffsetRef.current, insertionAnimation);
      });
      return cleanup;
    }, [draw, insertionAnimation]);

    /**
     * Register a capturer so out-of-tree consumers (e.g. animation GIF export)
     * can grab the pixels of a cell range from the live canvas. Re-registers when
     * the mapping inputs change so it always reflects current scroll/zoom/sizes.
     */
    const captureRange = useCallback(
      (range: CaptureRange): ImageData | null => {
        const canvas = canvasRef.current;
        if (!canvas) return null;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        const capDims = dimensions ?? createEmptyDimensionOverrides();
        const scale = (window.devicePixelRatio || 1) * zoom;
        const sX = viewport.scrollX || 0;
        const sY = viewport.scrollY || 0;
        const left = getColumnX(range.startCol, config, capDims, 0, -sX);
        const top = getRowY(range.startRow, config, capDims, 0, -sY);
        const right = getColumnX(range.endCol + 1, config, capDims, 0, -sX);
        const bottom = getRowY(range.endRow + 1, config, capDims, 0, -sY);
        const px = Math.max(0, Math.round(left * scale));
        const py = Math.max(0, Math.round(top * scale));
        const pw = Math.min(Math.round((right - left) * scale), canvas.width - px);
        const ph = Math.min(Math.round((bottom - top) * scale), canvas.height - py);
        if (pw <= 0 || ph <= 0) return null;
        try {
          return ctx.getImageData(px, py, pw, ph);
        } catch {
          return null;
        }
      },
      [config, dimensions, viewport, zoom],
    );

    useEffect(() => {
      setGridCapturer(captureRange);
      return () => setGridCapturer(null);
    }, [captureRange]);

    // Register the live canvas element for captureStream-based recording (WebM).
    useEffect(() => {
      setGridCanvas(canvasRef.current);
      return () => setGridCanvas(null);
    }, []);

    /**
     * Expose imperative methods via ref.
     */
    useImperativeHandle(
      ref,
      () => ({
        redraw: () => draw(animationOffsetRef.current, insertionAnimation),
        getCanvas: () => canvasRef.current,
        getContext: () => context,
        refreshCells,
        animateRowInsertion,
        animateColumnInsertion,
        animateRowDeletion,
        animateColumnDeletion,
      }),
      [draw, context, refreshCells, animateRowInsertion, animateColumnInsertion, animateRowDeletion, animateColumnDeletion, insertionAnimation]
    );

    return (
      <S.GridContainer
        ref={containerRef}
        className={className}
      >
        <S.StyledCanvas
          ref={canvasRef}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
        />
      </S.GridContainer>
    );
  }
);

export default GridCanvas;