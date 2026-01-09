// FILENAME: app/src/components/GridCanvas.tsx
// PURPOSE: Canvas component for rendering the spreadsheet grid.
// CONTEXT: This component manages the HTML5 Canvas element used for
// high-performance grid rendering. It handles device pixel ratio scaling,
// automatic resizing, fetching cell data from the backend, and delegates
// actual grid drawing to the gridRenderer module. Phase 3.3 adds text
// rendering by fetching viewport cells and passing them to the renderer.
// Updated: Added marching ants animation for clipboard selection.
// Updated: Added sheet:formulaModeSwitch event listener for cross-sheet formula references.

import React, { useRef, useEffect, useCallback, useImperativeHandle, forwardRef, useState } from "react";
import { renderGrid, DEFAULT_THEME, calculateVisibleRange } from "../../lib/gridRenderer";
import { getViewportCells } from "../../lib/tauri-api";
import type { GridConfig, Viewport, Selection, EditingCell, CellDataMap, FormulaReference, DimensionOverrides, StyleDataMap, ClipboardMode } from "../../types";
import { cellKey, createEmptyDimensionOverrides } from "../../types";
import type { GridTheme } from "../../lib/gridRenderer";

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
  /** Clipboard selection for marching ants */
  clipboardSelection?: Selection | null;
  /** Clipboard mode (none, copy, cut) */
  clipboardMode?: ClipboardMode;
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
      clipboardSelection,
      clipboardMode = "none",
      theme = DEFAULT_THEME,
      onMouseDown,
      onMouseMove,
      onMouseUp,
      className,
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
     */
    const calculateFetchRange = useCallback(() => {
      if (canvasSize.width === 0 || canvasSize.height === 0) {
        return null;
      }

      const range = calculateVisibleRange(viewport, config, canvasSize.width, canvasSize.height, dims);

      // Add buffer zone around visible area
      const startRow = Math.max(0, range.startRow - CELL_BUFFER);
      const endRow = Math.min(config.totalRows - 1, range.endRow + CELL_BUFFER);
      const startCol = Math.max(0, range.startCol - CELL_BUFFER);
      const endCol = Math.min(config.totalCols - 1, range.endCol + CELL_BUFFER);

      return { startRow, endRow, startCol, endCol };
    }, [viewport, config, canvasSize.width, canvasSize.height, dims]);

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

        // Debug: log cell info
        if (cellData.length > 0) {
          const firstCell = cellData[0];
          console.log(`[Cells] Fetched ${cellData.length} cells. First cell: row=${firstCell.row}, col=${firstCell.col}, display="${firstCell.display}", style_index=${firstCell.styleIndex}`);
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
      lastFetchRef.current = null;
      await fetchCells(true);
    }, [fetchCells]);

    /**
     * Clear the canvas.
     */
    const clear = useCallback(() => {
      if (context && canvasSize.width > 0 && canvasSize.height > 0) {
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvasSize.width, canvasSize.height);
      }
    }, [context, canvasSize.width, canvasSize.height]);

    /**
     * Draw the grid content using the grid renderer.
     * Accepts optional animation offset for marching ants.
     */
    const draw = useCallback((animationOffset: number = 0) => {
      if (!context || canvasSize.width === 0 || canvasSize.height === 0) {
        return;
      }

      // Clear the canvas
      clear();

      // Render the grid with cell data, formula references, style cache, fill preview, and clipboard
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
        clipboardSelection,
        clipboardMode,
        animationOffset
      );
    }, [context, canvasSize.width, canvasSize.height, config, viewport, selection, editing, cells, theme, formulaReferences, dims, styleCache, fillPreviewRange, clipboardSelection, clipboardMode, clear]);

    /**
     * Animation loop for marching ants effect.
     */
    useEffect(() => {
      // Only animate when clipboard has content
      const shouldAnimate = clipboardSelection && clipboardMode !== "none";

      if (!shouldAnimate) {
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

        // Update offset based on time (60fps = ~16.67ms per frame)
        // Speed is in pixels per frame at 60fps
        animationOffsetRef.current += MARCHING_ANTS_SPEED * (deltaTime / 16.67);

        // Wrap around at pattern length to prevent float overflow
        if (animationOffsetRef.current >= DASH_PATTERN_LENGTH) {
          animationOffsetRef.current -= DASH_PATTERN_LENGTH;
        }

        // Redraw with current offset
        draw(animationOffsetRef.current);

        // Continue animation
        animationFrameRef.current = requestAnimationFrame(animate);
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
    }, [clipboardSelection, clipboardMode, draw]);

    /**
     * Fetch cells when viewport changes.
     */
    useEffect(() => {
      fetchCells();
    }, [fetchCells]);

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
     * Redraw when dependencies change (but not during animation).
     * Animation loop handles redraws when clipboard is active.
     */
    useEffect(() => {
      // Only do manual redraw when not animating
      const shouldAnimate = clipboardSelection && clipboardMode !== "none";
      if (!shouldAnimate) {
        draw(0);
      }
    }, [draw, clipboardSelection, clipboardMode]);

    /**
     * Expose imperative methods via ref.
     */
    useImperativeHandle(
      ref,
      () => ({
        redraw: () => draw(animationOffsetRef.current),
        getCanvas: () => canvasRef.current,
        getContext: () => context,
        refreshCells,
      }),
      [draw, context, refreshCells]
    );

    return (
      <div
        ref={containerRef}
        className={className}
        style={containerStyles}
      >
        <canvas
          ref={canvasRef}
          style={canvasStyles}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
        />
      </div>
    );
  }
);

/**
 * Styles for the canvas container.
 * Positioned to fill parent but below scroll layer (z-index: 0).
 */
const containerStyles: React.CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  overflow: "hidden",
  zIndex: 0,
};

/**
 * Styles for the canvas element.
 */
const canvasStyles: React.CSSProperties = {
  display: "block",
  position: "absolute",
  top: 0,
  left: 0,
};

export default GridCanvas;