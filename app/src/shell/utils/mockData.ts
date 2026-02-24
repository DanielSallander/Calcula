//! FILENAME: app/src/shell/utils/mockData.ts
// PURPOSE: Mock data loader for development and testing
// CONTEXT: Populates the grid with sample CSV data when launched with --mockdata flag
// DELETE THIS FILE: To remove mock data feature, delete this file and mockData.csv.ts

import { updateCellsBatch, type CellUpdateInput } from "../../core/lib/tauri-api";
import { MOCK_CSV_DATA } from "./mockData.csv";

/**
 * Parses CSV text into a 2D array of values.
 * Simple parser that handles basic CSV format.
 *
 * @param csvText - Raw CSV text with newline-separated rows
 * @returns 2D array where each inner array represents a row
 */
function parseCSV(csvText: string): string[][] {
  const lines = csvText.trim().split('\n');
  return lines.map(line => line.split(',').map(cell => cell.trim()));
}

/**
 * Converts a 2D array of values into CellUpdateInput format.
 * Starts at row 0, col 0 (A1 in spreadsheet notation).
 *
 * @param data - 2D array of cell values
 * @returns Array of cell update inputs ready for batch update
 */
function convertToUpdates(data: string[][]): CellUpdateInput[] {
  const updates: CellUpdateInput[] = [];

  data.forEach((row, rowIndex) => {
    row.forEach((value, colIndex) => {
      updates.push({
        row: rowIndex,
        col: colIndex,
        value: value
      });
    });
  });

  return updates;
}

/**
 * Loads mock data into the grid.
 * Parses the CSV data and uses batch update to populate cells efficiently.
 *
 * @returns Promise that resolves when data is loaded
 */
export async function loadMockData(): Promise<void> {
  console.log("[MockData] Loading mock data...");

  try {
    const t0 = performance.now();

    // Parse CSV and convert to cell updates
    const parsedData = parseCSV(MOCK_CSV_DATA);
    const updates = convertToUpdates(parsedData);

    console.log(`[MockData] Parsed ${parsedData.length} rows, ${updates.length} total cells`);

    // Send to backend in a single batch
    const result = await updateCellsBatch(updates);

    const dt = performance.now() - t0;
    console.log(`[MockData] Loaded successfully | ${result.length} cells updated | ${dt.toFixed(1)}ms`);

    // Dispatch "grid:refresh" to force the canvas to re-fetch cell data from backend
    // Note: "app:grid-refresh" only repaints; "grid:refresh" actually re-fetches data
    window.dispatchEvent(new Event("grid:refresh"));
  } catch (error) {
    console.error("[MockData] Failed to load mock data:", error);
  }
}

/**
 * Checks if mock data should be loaded based on environment variable.
 * Returns true if VITE_LOAD_MOCK_DATA is set to "true".
 */
export function shouldLoadMockData(): boolean {
  return import.meta.env.VITE_LOAD_MOCK_DATA === "true";
}
