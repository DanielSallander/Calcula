//! FILENAME: app/src/core/lib/gridRenderer/styles/styleUtils.ts
//PURPOSE: Style cache management and color validation utilities
//CONTEXT: Handles style data retrieval and CSS color validation

import type { DimensionOverrides, StyleData, StyleDataMap } from "../../../types";
import { createEmptyDimensionOverrides, DEFAULT_STYLE } from "../../../types";

/**
 * Ensure dimensions object is valid, returning default if not.
 */
export function ensureDimensions(dimensions?: DimensionOverrides | null): DimensionOverrides {
  if (!dimensions || !dimensions.columnWidths || !dimensions.rowHeights) {
    return createEmptyDimensionOverrides();
  }
  return dimensions;
}

/**
 * Ensure style cache is valid, returning a default cache if not.
 */
export function ensureStyleCache(styleCache?: StyleDataMap | null): StyleDataMap {
  if (!styleCache || styleCache.size === 0) {
    const defaultCache = new Map<number, StyleData>();
    defaultCache.set(0, DEFAULT_STYLE);
    return defaultCache;
  }
  return styleCache;
}

/**
 * Get style data from cache, returning default if not found.
 */
export function getStyleFromCache(styleCache: StyleDataMap, styleIndex: number): StyleData {
  const style = styleCache.get(styleIndex);
  if (style) {
    return style;
  }
  // Fall back to index 0, then to DEFAULT_STYLE
  return styleCache.get(0) || DEFAULT_STYLE;
}

/**
 * Check if a string is a valid CSS color.
 * Handles hex colors (with or without #), rgb/rgba, and named colors.
 */
export function isValidColor(color: string | undefined | null): boolean {
  if (!color || typeof color !== "string") {
    return false;
  }
  
  const trimmed = color.trim();
  if (trimmed === "") {
    return false;
  }
  
  // Check for hex colors (3, 4, 6, or 8 digits, with or without #)
  // With #
  if (/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/i.test(trimmed)) {
    return true;
  }
  // Without # (backend might send without it in some cases)
  if (/^([0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/i.test(trimmed)) {
    return true;
  }
  
  // Check for rgb/rgba
  if (/^rgba?\s*\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(,\s*[\d.]+\s*)?\)$/i.test(trimmed)) {
    return true;
  }
  
  // Check for named colors (basic validation - common named colors)
  const namedColors = [
    "black", "white", "red", "green", "blue", "yellow", "cyan", "magenta",
    "gray", "grey", "orange", "pink", "purple", "brown", "transparent"
  ];
  if (namedColors.includes(trimmed.toLowerCase())) {
    return true;
  }
  
  return false;
}

/**
 * Check if a color is effectively "default" (black for text).
 * Only returns true for exact black matches.
 */
export function isDefaultTextColor(color: string | undefined | null): boolean {
  if (!color) return true;
  
  const normalized = color.toLowerCase().trim();
  
  // Check various representations of black
  if (normalized === "#000000" || normalized === "#000" || normalized === "000000") {
    return true;
  }
  if (normalized === "black") {
    return true;
  }
  if (normalized === "rgb(0, 0, 0)" || normalized === "rgb(0,0,0)") {
    return true;
  }
  if (normalized === "rgba(0, 0, 0, 1)" || normalized === "rgba(0,0,0,1)") {
    return true;
  }
  
  return false;
}

/**
 * Check if a background color is effectively "default" (white/transparent).
 */
export function isDefaultBackgroundColor(color: string | undefined | null): boolean {
  if (!color) return true;
  
  const normalized = color.toLowerCase().trim();
  
  // Check various representations of white
  if (normalized === "#ffffff" || normalized === "#fff" || normalized === "ffffff") {
    return true;
  }
  if (normalized === "white") {
    return true;
  }
  if (normalized === "transparent") {
    return true;
  }
  if (normalized === "rgb(255, 255, 255)" || normalized === "rgb(255,255,255)") {
    return true;
  }
  if (normalized === "rgba(255, 255, 255, 1)" || normalized === "rgba(255,255,255,1)") {
    return true;
  }
  if (normalized === "rgba(0, 0, 0, 0)" || normalized === "rgba(0,0,0,0)") {
    return true;
  }
  
  return false;
}