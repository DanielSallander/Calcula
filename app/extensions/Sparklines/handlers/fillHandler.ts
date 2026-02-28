//! FILENAME: app/extensions/Sparklines/handlers/fillHandler.ts
// PURPOSE: Handles sparkline propagation when the fill handle is used.
// CONTEXT: When the user drags the fill handle from a cell containing a sparkline,
//          this handler creates new sparkline groups for the filled cells with
//          appropriately shifted data ranges.

import type { FillCompletedPayload } from "../../../src/api/events";
import { emitAppEvent, AppEvents } from "../../../src/api/events";
import {
  getSparklineForCell,
  createSparklineGroup,
} from "../store";
import type { SparklineGroup, CellRange } from "../types";

// ============================================================================
// Main handler
// ============================================================================

/**
 * Handle the FILL_COMPLETED event.
 * For each source cell that has a sparkline, create a new sparkline group
 * for the corresponding target cell(s) with shifted data ranges.
 */
export function handleFillCompleted(payload: FillCompletedPayload): void {
  if (!payload) return;

  const { sourceRange, targetRange, direction } = payload;

  // Determine which cells are actually new (not in the source range)
  const isVertical = direction === "down" || direction === "up";
  let created = false;

  if (isVertical) {
    // For vertical fills, iterate columns in source, then rows in target-only area
    for (let c = sourceRange.startCol; c <= sourceRange.endCol; c++) {
      // Collect sparkline info from the source column
      const sourceEntries: Array<{
        sourceRow: number;
        group: SparklineGroup;
      }> = [];

      for (let r = sourceRange.startRow; r <= sourceRange.endRow; r++) {
        const entry = getSparklineForCell(r, c);
        if (entry) {
          sourceEntries.push({ sourceRow: r, group: entry.group });
        }
      }

      if (sourceEntries.length === 0) continue;

      // Determine the target rows (those not in source range)
      const targetRows: number[] = [];
      if (direction === "down") {
        for (let r = sourceRange.endRow + 1; r <= targetRange.endRow; r++) {
          targetRows.push(r);
        }
      } else {
        for (let r = targetRange.startRow; r < sourceRange.startRow; r++) {
          targetRows.push(r);
        }
      }

      // For each target row, find the corresponding source (cyclic)
      const sourceCount = sourceEntries.length;
      for (let i = 0; i < targetRows.length; i++) {
        const targetRow = targetRows[i];
        const srcIdx = i % sourceCount;
        const srcEntry = sourceEntries[srcIdx];
        const rowDelta = targetRow - srcEntry.sourceRow;

        const shifted = shiftDataRange(srcEntry.group.dataRange, rowDelta, 0);
        if (!shifted) continue;

        const location: CellRange = {
          startRow: targetRow,
          startCol: c,
          endRow: targetRow,
          endCol: c,
        };

        const result = createSparklineGroupFromTemplate(
          location,
          shifted,
          srcEntry.group,
        );
        if (result) created = true;
      }
    }
  } else {
    // Horizontal fill (left/right)
    for (let r = sourceRange.startRow; r <= sourceRange.endRow; r++) {
      const sourceEntries: Array<{
        sourceCol: number;
        group: SparklineGroup;
      }> = [];

      for (let c = sourceRange.startCol; c <= sourceRange.endCol; c++) {
        const entry = getSparklineForCell(r, c);
        if (entry) {
          sourceEntries.push({ sourceCol: c, group: entry.group });
        }
      }

      if (sourceEntries.length === 0) continue;

      const targetCols: number[] = [];
      if (direction === "right") {
        for (let c = sourceRange.endCol + 1; c <= targetRange.endCol; c++) {
          targetCols.push(c);
        }
      } else {
        for (let c = targetRange.startCol; c < sourceRange.startCol; c++) {
          targetCols.push(c);
        }
      }

      const sourceCount = sourceEntries.length;
      for (let i = 0; i < targetCols.length; i++) {
        const targetCol = targetCols[i];
        const srcIdx = i % sourceCount;
        const srcEntry = sourceEntries[srcIdx];
        const colDelta = targetCol - srcEntry.sourceCol;

        const shifted = shiftDataRange(srcEntry.group.dataRange, 0, colDelta);
        if (!shifted) continue;

        const location: CellRange = {
          startRow: r,
          startCol: targetCol,
          endRow: r,
          endCol: targetCol,
        };

        const result = createSparklineGroupFromTemplate(
          location,
          shifted,
          srcEntry.group,
        );
        if (result) created = true;
      }
    }
  }

  if (created) {
    emitAppEvent(AppEvents.GRID_REFRESH);
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Shift a data range by the given row/col delta.
 * Returns null if the shifted range goes out of bounds (negative coordinates).
 */
function shiftDataRange(
  dataRange: CellRange,
  rowDelta: number,
  colDelta: number,
): CellRange | null {
  const newStartRow = dataRange.startRow + rowDelta;
  const newStartCol = dataRange.startCol + colDelta;
  const newEndRow = dataRange.endRow + rowDelta;
  const newEndCol = dataRange.endCol + colDelta;

  // Validate: no negative coordinates
  if (newStartRow < 0 || newStartCol < 0 || newEndRow < 0 || newEndCol < 0) {
    return null;
  }

  return {
    startRow: newStartRow,
    startCol: newStartCol,
    endRow: newEndRow,
    endCol: newEndCol,
  };
}

/**
 * Create a sparkline group for a single target cell, copying visual properties
 * from the template (source) group.
 */
function createSparklineGroupFromTemplate(
  location: CellRange,
  dataRange: CellRange,
  template: SparklineGroup,
): boolean {
  const result = createSparklineGroup(
    location,
    dataRange,
    template.type,
    template.color,
    template.negativeColor,
  );

  if (!result.valid || !result.group) return false;

  // Copy visual properties from the template
  const g = result.group;
  g.showMarkers = template.showMarkers;
  g.lineWidth = template.lineWidth;
  g.showHighPoint = template.showHighPoint;
  g.showLowPoint = template.showLowPoint;
  g.showFirstPoint = template.showFirstPoint;
  g.showLastPoint = template.showLastPoint;
  g.showNegativePoints = template.showNegativePoints;
  g.highPointColor = template.highPointColor;
  g.lowPointColor = template.lowPointColor;
  g.firstPointColor = template.firstPointColor;
  g.lastPointColor = template.lastPointColor;
  g.negativePointColor = template.negativePointColor;
  g.markerColor = template.markerColor;

  return true;
}
