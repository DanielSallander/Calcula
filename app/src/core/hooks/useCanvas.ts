//! FILENAME: app/src/core/hooks/useCanvas.ts
// PURPOSE: Custom hook for managing HTML5 Canvas setup and context.
// CONTEXT: This hook provides canvas management functionality including:
// - Setting up the 2D rendering context with proper device pixel ratio
// - Handling canvas resizing when container dimensions change
// - Providing access to the canvas context for rendering operations
// - Managing high-DPI display support for crisp rendering

import { useRef, useEffect, useCallback, useState } from "react";

/**
 * Configuration options for the canvas setup.
 */
export interface CanvasConfig {
  /** Whether to use device pixel ratio for high-DPI displays */
  useDevicePixelRatio?: boolean;
  /** Background color to clear the canvas with */
  backgroundColor?: string;
}

/**
 * Default canvas configuration.
 */
const DEFAULT_CANVAS_CONFIG: CanvasConfig = {
  useDevicePixelRatio: true,
  backgroundColor: "#ffffff",
};

/**
 * Return type for the useCanvas hook.
 */
export interface UseCanvasReturn {
  /** Reference to attach to the canvas element */
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  /** The 2D rendering context (null until canvas is mounted) */
  context: CanvasRenderingContext2D | null;
  /** Current canvas width in CSS pixels */
  width: number;
  /** Current canvas height in CSS pixels */
  height: number;
  /** Current device pixel ratio being used */
  pixelRatio: number;
  /** Force a resize recalculation */
  forceResize: () => void;
  /** Clear the canvas with the background color */
  clear: () => void;
}

/**
 * Hook for managing HTML5 Canvas setup and rendering context.
 * Handles high-DPI displays and automatic resizing.
 *
 * @param containerRef - Reference to the container element for sizing
 * @param config - Optional configuration options
 * @returns Object containing canvas management functions and state
 */
export function useCanvas(
  containerRef: React.RefObject<HTMLElement | null>,
  config: CanvasConfig = {}
): UseCanvasReturn {
  const mergedConfig = { ...DEFAULT_CANVAS_CONFIG, ...config };
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [context, setContext] = useState<CanvasRenderingContext2D | null>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [pixelRatio, setPixelRatio] = useState(1);

  /**
   * Set up the canvas context with proper scaling for device pixel ratio.
   */
  const setupContext = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return null;
    }

    const ctx = canvas.getContext("2d", {
      alpha: false, // Disable alpha for better performance
      desynchronized: true, // Hint for smoother rendering
    });

    if (!ctx) {
      console.error("Failed to get 2D rendering context");
      return null;
    }

    return ctx;
  }, []);

  /**
   * Resize the canvas to match container dimensions.
   * Handles device pixel ratio for crisp rendering on high-DPI displays.
   */
  const resize = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;

    if (!canvas || !container) {
      return;
    }

    // Get the device pixel ratio
    const dpr = mergedConfig.useDevicePixelRatio ? window.devicePixelRatio || 1 : 1;
    setPixelRatio(dpr);

    // Get container dimensions
    const rect = container.getBoundingClientRect();
    const width = Math.floor(rect.width);
    const height = Math.floor(rect.height);

    // Only resize if dimensions actually changed
    if (dimensions.width === width && dimensions.height === height) {
      return;
    }

    // Set the canvas size in CSS pixels
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    // Set the canvas buffer size accounting for device pixel ratio
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);

    // Get or create the context
    let ctx = context;
    if (!ctx) {
      ctx = setupContext();
      if (ctx) {
        setContext(ctx);
      }
    }

    // Scale the context to account for device pixel ratio
    if (ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0); // Reset transform
      ctx.scale(dpr, dpr);
    }

    setDimensions({ width, height });
  }, [containerRef, context, dimensions, mergedConfig.useDevicePixelRatio, setupContext]);

  /**
   * Clear the canvas with the background color.
   */
  const clear = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = context;

    if (!canvas || !ctx) {
      return;
    }

    // Save current transform
    ctx.save();

    // Reset transform to clear the entire canvas
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // Clear with background color
    ctx.fillStyle = mergedConfig.backgroundColor || "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Restore transform (including pixel ratio scaling)
    ctx.restore();
  }, [context, mergedConfig.backgroundColor]);

  /**
   * Force a resize recalculation.
   */
  const forceResize = useCallback(() => {
    // Reset dimensions to force recalculation
    setDimensions({ width: 0, height: 0 });
  }, []);

  /**
   * Set up ResizeObserver to handle container size changes.
   */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    // Initial resize
    resize();

    // Set up ResizeObserver
    const resizeObserver = new ResizeObserver(() => {
      resize();
    });

    resizeObserver.observe(container);

    // Also listen for window resize (for device pixel ratio changes)
    const handleWindowResize = () => {
      forceResize();
    };

    window.addEventListener("resize", handleWindowResize);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", handleWindowResize);
    };
  }, [containerRef, resize, forceResize]);

  /**
   * Handle device pixel ratio changes (e.g., moving window between displays).
   */
  useEffect(() => {
    if (!mergedConfig.useDevicePixelRatio) {
      return;
    }

    const mediaQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);

    const handleChange = () => {
      forceResize();
    };

    mediaQuery.addEventListener("change", handleChange);

    return () => {
      mediaQuery.removeEventListener("change", handleChange);
    };
  }, [mergedConfig.useDevicePixelRatio, forceResize]);

  return {
    canvasRef,
    context,
    width: dimensions.width,
    height: dimensions.height,
    pixelRatio,
    forceResize,
    clear,
  };
}

/**
 * Utility function to set up common canvas text rendering settings.
 *
 * @param ctx - The canvas rendering context
 * @param fontFamily - Font family to use
 * @param fontSize - Font size in pixels
 */
export function setupTextRendering(
  ctx: CanvasRenderingContext2D,
  fontFamily: string = "system-ui, -apple-system, sans-serif",
  fontSize: number = 13
): void {
  ctx.font = `${fontSize}px ${fontFamily}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
}

/**
 * Utility function to draw text with ellipsis if it exceeds max width.
 *
 * @param ctx - The canvas rendering context
 * @param text - Text to draw
 * @param x - X position
 * @param y - Y position
 * @param maxWidth - Maximum width before truncation
 */
export function drawTextWithEllipsis(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number
): void {
  const metrics = ctx.measureText(text);

  if (metrics.width <= maxWidth) {
    ctx.fillText(text, x, y);
    return;
  }

  // Truncate with ellipsis
  const ellipsis = "...";
  const ellipsisWidth = ctx.measureText(ellipsis).width;
  const availableWidth = maxWidth - ellipsisWidth;

  if (availableWidth <= 0) {
    ctx.fillText(ellipsis, x, y);
    return;
  }

  // Binary search for the right truncation point
  let low = 0;
  let high = text.length;

  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const truncated = text.substring(0, mid);
    const width = ctx.measureText(truncated).width;

    if (width <= availableWidth) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  const truncated = text.substring(0, low) + ellipsis;
  ctx.fillText(truncated, x, y);
}