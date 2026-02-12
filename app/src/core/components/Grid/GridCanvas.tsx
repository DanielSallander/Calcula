//! FILENAME: app/src/core/components/Grid/GridCanvas.tsx
// PURPOSE: Canvas component for rendering the spreadsheet grid.
// CONTEXT: This component manages the HTML5 Canvas element used for
// high-performance grid rendering. It handles device pixel ratio scaling,
// automatic resizing, fetching cell data from the backend, and delegates
// actual grid drawing to the gridRenderer module.

import React, { useRef, useEffect, useCallback, useImperativeHandle, forwardRef, useState } from "react";
import { renderGrid, DEFAULT_THEME, calculateVisibleRange } from "../../lib/gridRenderer";
import { getViewportCells } from "../../lib/tauri-api";
import type { GridConfig, Viewport, Selection, EditingCell, CellDataMap, FormulaReference, DimensionOverrides, StyleDataMap, ClipboardMode, InsertionAnimation, FreezeConfig } from "../../types";
import { cellKey, createEmptyDimensionOverrides, DEFAULT_FREEZE_CONFIG } from "../../types";
import type { GridTheme } from "../../lib/gridRenderer";
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
  /** Clipboard selection for marching ants */
  clipboardSelection?: Selection | null;
  /** Clipboard mode (none, copy, cut) */
  clipboardMode?: ClipboardMode;
  /** Freeze panes configuration */
  freezeConfig?: FreezeConfig;
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
      clipboardSelection,
      clipboardMode = "none",
      freezeConfig = DEFAULT_FREEZE_CONFIG,
      theme = DEFAULT_THEME,
      onMouseDown,
      onMouseMove,
      onMouseUp,
      className,
      currentSheetName,
    } = props;

    const containerRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [context, setContext] = useState<CanvasRenderingContext2D | null>(null);
    const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

    // Cell data cache
    const [cells, setCells] = useState<CellDataMap>(new Map());

    // Track the last fetched range to avoid redundant fetches
    const lastFetchRef = useRef<{
      startRow: number;
      endRow: number;
      startCol: number;
      endCol: number;
    } | null>(null);

    // Track if a fetch is in progress
    const fetchingRef = useRef<boolean>(false);

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

      const range = calculateVisibleRange(viewport, config, canvasSize.width, canvasSize.height, dims);

      // Calculate the base range from scroll position
      let startRow = Math.max(0, range.startRow - CELL_BUFFER);
      const endRow = Math.min(config.totalRows - 1, range.endRow + CELL_BUFFER);
      let startCol = Math.max(0, range.startCol - CELL_BUFFER);
      const endCol = Math.min(config.totalCols - 1, range.endCol + CELL_BUFFER);

      // With freeze panes, always include frozen rows/cols in fetch
      if (freezeConfig.freezeRow !== null && freezeConfig.freezeRow > 0) {
        startRow = 0; // Always fetch from row 0 to include frozen rows
      }
      if (freezeConfig.freezeCol !== null && freezeConfig.freezeCol > 0) {
        startCol = 0; // Always fetch from col 0 to include frozen columns
      }

      return { startRow, endRow, startCol, endCol };
    }, [viewport, config, canvasSize.width, canvasSize.height, dims, freezeConfig]);

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
        return;
      }

      // Check if we need to fetch
      if (!force && !needsFetch(fetchRange)) {
        return;
      }

      // Prevent concurrent fetches
      if (fetchingRef.current) {
        return;
      }

      fetchingRef.current = true;

      try {
        const cellData = await getViewportCells(
          fetchRange.startRow,
          fetchRange.startCol,
          fetchRange.endRow,
          fetchRange.endCol
        );

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
      } catch (error) {
        console.error("Failed to fetch cells:", error);
      } finally {
        fetchingRef.current = false;
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
     * Clear the canvas.
     */
    const clear = useCallback(() => {
      if (context && canvasSize.width > 0 && canvasSize.height > 0) {
        // Use theme background if available, otherwise default to white.
        // Note: Canvas API requires explicit color strings, we are not using CSS vars here for performance/logic reasons.
        // Ideally this should map to theme.backgroundColor.
        context.fillStyle = "#ffffff"; 
        context.fillRect(0, 0, canvasSize.width, canvasSize.height);
      }
    }, [context, canvasSize.width, canvasSize.height]);

    /**
     * Draw the grid content using the grid renderer.
     * Accepts optional animation offset for marching ants and insertion animation.
     */
    const draw = useCallback((animationOffset: number = 0, currentInsertionAnimation: InsertionAnimation | null = null) => {
      if (!context || canvasSize.width === 0 || canvasSize.height === 0) {
        return;
      }

      // Clear the canvas
      clear();

      // Render the grid with cell data, formula references, style cache, fill preview, selection drag preview, clipboard, insertion animation, freeze config, and sheet context
      renderGrid(
        context,
        canvasSize.width,
        canvasSize.height,
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
        clipboardSelection,
        clipboardMode,
        animationOffset,
        currentInsertionAnimation,
        freezeConfig,
        [], // overlayRegions
        [], // overlayRenderers
        currentSheetName, // FIX: Pass current sheet for cross-sheet reference highlighting
      );
    }, [context, canvasSize.width, canvasSize.height, config, viewport, selection, editing, cells, theme, formulaReferences, dims, styleCache, fillPreviewRange, selectionDragPreview, clipboardSelection, clipboardMode, freezeConfig, clear, currentSheetName]);

    /**
     * Start row insertion animation.
     * Should be called AFTER backend operation and refreshCells() complete.
     */
    const animateRowInsertion = useCallback((index: number, count: number, durationMs: number = DEFAULT_ANIMATION_DURATION): Promise<void> => {
      return new Promise((resolve) => {
        const targetSize = config.defaultCellHeight || 24;
        
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
        const targetSize = config.defaultCellHeight || 24;
        
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
     */
    useEffect(() => {
      const shouldAnimateClipboard = clipboardSelection && clipboardMode !== "none";
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

        // Update marching ants offset
        if (shouldAnimateClipboard) {
          animationOffsetRef.current += MARCHING_ANTS_SPEED * (deltaTime / 16.67);
          if (animationOffsetRef.current >= DASH_PATTERN_LENGTH) {
            animationOffsetRef.current -= DASH_PATTERN_LENGTH;
          }
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

        // Continue animation if still needed
        if (shouldAnimateClipboard || (currentInsertionAnim !== null)) {
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
     * Fetch cells when viewport or freeze config changes.
     */
    useEffect(() => {
      fetchCells();
    }, [fetchCells]);

    /**
     * Refetch cells when freeze config changes to ensure frozen cells are loaded.
     */
    useEffect(() => {
      // Force refetch when freeze config changes to ensure frozen cells are in cache
      lastFetchRef.current = null;
      fetchCells(true);
    }, [freezeConfig.freezeRow, freezeConfig.freezeCol]);

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
     * Listen for normal sheet switch events (non-formula mode).
     * This replaces the page reload with a proper cell refresh.
     */
    useEffect(() => {
      const handleNormalSheetSwitch = async (event: Event) => {
        const customEvent = event as CustomEvent<{
          newSheetIndex: number;
          newSheetName: string;
        }>;
        console.log(`[GridCanvas] Normal sheet switch to: ${customEvent.detail.newSheetName}`);

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