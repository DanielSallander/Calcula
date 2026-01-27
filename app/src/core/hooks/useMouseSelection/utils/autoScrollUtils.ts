//! FILENAME: app/src/core/hooks/useMouseSelection/utils/autoScrollUtils.ts
// PURPOSE: Utility functions for calculating auto-scroll behavior.
// CONTEXT: Contains pure functions for determining scroll deltas based on
// mouse position relative to viewport edges during drag operations.

import type { GridConfig } from "../../../types";
import type { AutoScrollConfig, ScrollDelta } from "../types";
import { DEFAULT_AUTO_SCROLL_CONFIG } from "../constants";

/**
 * Calculate scroll delta based on mouse position relative to edges.
 * Returns { deltaX, deltaY } indicating how much to scroll.
 *
 * @param mouseX - Mouse X position relative to container
 * @param mouseY - Mouse Y position relative to container
 * @param rect - Container bounding rectangle
 * @param config - Grid configuration for header dimensions
 * @param autoScrollConfig - Auto-scroll behavior configuration
 * @returns Scroll delta values for X and Y axes
 */
export function calculateAutoScrollDelta(
  mouseX: number,
  mouseY: number,
  rect: DOMRect,
  config: GridConfig,
  autoScrollConfig: AutoScrollConfig = DEFAULT_AUTO_SCROLL_CONFIG
): ScrollDelta {
  const cfg = autoScrollConfig;
  let deltaX = 0;
  let deltaY = 0;

  // Calculate distances from edges (accounting for headers)
  const leftEdge = config.rowHeaderWidth;
  const topEdge = config.colHeaderHeight;
  const rightEdge = rect.width;
  const bottomEdge = rect.height;

  // Left edge
  if (mouseX < leftEdge + cfg.edgeThreshold && mouseX >= leftEdge) {
    const distance = leftEdge + cfg.edgeThreshold - mouseX;
    const multiplier = Math.min(distance / cfg.edgeThreshold, 1) * cfg.maxSpeedMultiplier;
    deltaX = -cfg.baseSpeed * multiplier;
  }
  // Right edge
  else if (mouseX > rightEdge - cfg.edgeThreshold) {
    const distance = mouseX - (rightEdge - cfg.edgeThreshold);
    const multiplier = Math.min(distance / cfg.edgeThreshold, 1) * cfg.maxSpeedMultiplier;
    deltaX = cfg.baseSpeed * multiplier;
  }

  // Top edge
  if (mouseY < topEdge + cfg.edgeThreshold && mouseY >= topEdge) {
    const distance = topEdge + cfg.edgeThreshold - mouseY;
    const multiplier = Math.min(distance / cfg.edgeThreshold, 1) * cfg.maxSpeedMultiplier;
    deltaY = -cfg.baseSpeed * multiplier;
  }
  // Bottom edge
  else if (mouseY > bottomEdge - cfg.edgeThreshold) {
    const distance = mouseY - (bottomEdge - cfg.edgeThreshold);
    const multiplier = Math.min(distance / cfg.edgeThreshold, 1) * cfg.maxSpeedMultiplier;
    deltaY = cfg.baseSpeed * multiplier;
  }

  return { deltaX, deltaY };
}