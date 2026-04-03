//! FILENAME: app/extensions/Subtotals/lib/subtotalEngine.ts
// PURPOSE: Core logic for inserting automatic subtotals into the grid.
// CONTEXT: Reads the data range, detects group boundaries, inserts subtotal rows
//          with SUBTOTAL formulas, and creates outline groups.

import {
  getCell,
  insertRows,
  updateCellsBatch,
  indexToCol,
  beginUndoTransaction,
  commitUndoTransaction,
  groupRows,
  AppEvents,
  emitAppEvent,
} from "@api";
import type { SubtotalConfig } from "../types";
import { SUBTOTAL_FUNCTIONS } from "../types";

/** Represents a group of contiguous rows sharing the same value in the group-by column. */
interface DataGroup {
  groupValue: string;
  startRow: number;
  endRow: number;
}

/**
 * Applies automatic subtotals to the specified data range.
 *
 * Algorithm:
 * 1. Scan the group-by column to detect contiguous groups
 * 2. Insert subtotal rows bottom-up (preserves upper row indices)
 * 3. Fill each subtotal row with SUBTOTAL() formulas
 * 4. Insert grand total row at the bottom
 * 5. Create outline groups for the collapsible hierarchy
 */
export async function applySubtotals(config: SubtotalConfig): Promise<void> {
  const { groupByCol, subtotalCols, functionCode, startRow, endRow } = config;

  const funcInfo = SUBTOTAL_FUNCTIONS.find((f) => f.code === functionCode);
  if (!funcInfo) return;

  // Step 1: Detect groups (assumes data starts at startRow, which is the first data row after header)
  const groups = await detectGroups(groupByCol, startRow, endRow);
  if (groups.length === 0) return;

  await beginUndoTransaction("Subtotals");

  try {
    // Step 2: Insert subtotal rows bottom-up.
    // Working bottom-up means earlier group indices stay stable.
    // Track how many rows we've inserted so far (for adjusting later group positions).
    let totalInserted = 0;

    // We'll collect the final subtotal row positions for grouping later.
    const subtotalRowPositions: { dataStart: number; dataEnd: number; subtotalRow: number }[] = [];

    for (let i = groups.length - 1; i >= 0; i--) {
      const group = groups[i];

      // Adjust for rows already inserted below this group
      const adjustedEndRow = group.endRow + totalInserted;
      const adjustedStartRow = group.startRow + totalInserted;

      // Insert a blank row right after this group's last data row
      const insertAt = adjustedEndRow + 1;
      await insertRows(insertAt, 1);
      totalInserted++;

      // Build cell updates for this subtotal row
      const updates = [];

      // Label in the group-by column: e.g. "North Sum"
      updates.push({
        row: insertAt,
        col: groupByCol,
        value: `${group.groupValue} ${funcInfo.name}`,
      });

      // SUBTOTAL formulas for each subtotal column
      for (const col of subtotalCols) {
        const colLetter = indexToCol(col);
        // Row numbers in formulas are 1-based
        const formulaStartRow = adjustedStartRow + 1;
        const formulaEndRow = adjustedEndRow + 1;
        updates.push({
          row: insertAt,
          col,
          value: `=SUBTOTAL(${functionCode},${colLetter}${formulaStartRow}:${colLetter}${formulaEndRow})`,
        });
      }

      await updateCellsBatch(updates);

      // Record for grouping (will be applied after all inserts)
      subtotalRowPositions.unshift({
        dataStart: adjustedStartRow,
        dataEnd: adjustedEndRow,
        subtotalRow: insertAt,
      });
    }

    // Step 3: Insert grand total row at the very end
    const grandTotalRow = endRow + totalInserted + 1;
    await insertRows(grandTotalRow, 1);

    const grandTotalUpdates = [
      {
        row: grandTotalRow,
        col: groupByCol,
        value: "Grand Total",
      },
    ];

    for (const col of subtotalCols) {
      const colLetter = indexToCol(col);
      // Grand total covers the full data range including subtotal rows (SUBTOTAL ignores nested SUBTOTALs)
      const gtStartRow = startRow + 1; // 1-based
      const gtEndRow = grandTotalRow; // 1-based (the row just before grand total)
      grandTotalUpdates.push({
        row: grandTotalRow,
        col,
        value: `=SUBTOTAL(${functionCode},${colLetter}${gtStartRow}:${colLetter}${gtEndRow})`,
      });
    }

    await updateCellsBatch(grandTotalUpdates);

    // Step 4: Create outline groups for each data section
    for (const pos of subtotalRowPositions) {
      try {
        await groupRows({ startRow: pos.dataStart, endRow: pos.dataEnd });
      } catch (e) {
        console.warn("[Subtotals] Failed to group rows:", e);
      }
    }

    await commitUndoTransaction();
    emitAppEvent(AppEvents.GRID_REFRESH);
  } catch (err) {
    console.error("[Subtotals] Error applying subtotals:", err);
    await commitUndoTransaction();
  }
}

/**
 * Detects groups of contiguous rows with the same value in the group-by column.
 */
async function detectGroups(
  groupByCol: number,
  startRow: number,
  endRow: number,
): Promise<DataGroup[]> {
  const groups: DataGroup[] = [];
  let currentValue: string | null = null;
  let groupStart = startRow;

  for (let row = startRow; row <= endRow; row++) {
    const cell = await getCell(row, groupByCol);
    const value = cell?.display ?? "";

    if (currentValue === null) {
      currentValue = value;
      groupStart = row;
    } else if (value !== currentValue) {
      groups.push({
        groupValue: currentValue,
        startRow: groupStart,
        endRow: row - 1,
      });
      currentValue = value;
      groupStart = row;
    }
  }

  // Close the last group
  if (currentValue !== null) {
    groups.push({
      groupValue: currentValue,
      startRow: groupStart,
      endRow: endRow,
    });
  }

  return groups;
}
