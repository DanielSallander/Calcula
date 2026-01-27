//! FILENAME: app/src/core/hooks/useMouseSelection/constants.ts
// PURPOSE: Configuration constants for mouse selection behavior.
// CONTEXT: Contains default values for auto-scroll behavior during drag
// operations, extracted for easy tuning and testing.

import type { AutoScrollConfig } from "./types";

/**
 * Default configuration for auto-scroll behavior during drag selection.
 * These values provide smooth scrolling at approximately 60fps with
 * progressive speed increase near viewport edges.
 */
export const DEFAULT_AUTO_SCROLL_CONFIG: AutoScrollConfig = {
  edgeThreshold: 40,
  baseSpeed: 8,
  maxSpeedMultiplier: 4,
  intervalMs: 16, // ~60fps
};