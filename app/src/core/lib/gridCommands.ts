//! FILENAME: app/src/core/lib/gridCommands.ts
// PURPOSE: Command registry and selection utilities for the grid.
// CONTEXT: Core primitives used by the Spreadsheet component to register
// command handlers (cut, copy, paste, etc.) and provide selection utilities.
// Shell and Extensions import these through the API layer.

import type { Selection } from "../types";

// ============================================================================
// Grid Menu Context Type
// ============================================================================

/** Context passed to grid context menu callbacks */
export interface GridMenuContext {
  /** The current selection */
  selection: Selection | null;
  /** The cell that was right-clicked (may differ from selection start) */
  clickedCell: { row: number; col: number } | null;
  /** Whether the clicked cell is within the current selection */
  isWithinSelection: boolean;
  /** Active sheet index */
  sheetIndex: number;
  /** Active sheet name */
  sheetName: string;
}

// ============================================================================
// Command Registry
// ============================================================================

/** Command handler function type */
type CommandHandler = () => void | Promise<void>;

/** Available command names */
export type GridCommand =
  | "cut"
  | "copy"
  | "paste"
  | "clearContents"
  | "insertRow"
  | "insertColumn"
  | "deleteRow"
  | "deleteColumn";

/** Command registry for direct handler invocation */
class GridCommandRegistry {
  private handlers: Map<GridCommand, CommandHandler> = new Map();

  /**
   * Register a command handler.
   * @param command The command name
   * @param handler The handler function
   */
  register(command: GridCommand, handler: CommandHandler): void {
    this.handlers.set(command, handler);
  }

  /**
   * Unregister a command handler.
   * @param command The command name
   */
  unregister(command: GridCommand): void {
    this.handlers.delete(command);
  }

  /**
   * Execute a command if a handler is registered.
   * @param command The command to execute
   * @returns true if the command was executed, false otherwise
   */
  async execute(command: GridCommand): Promise<boolean> {
    const handler = this.handlers.get(command);
    if (handler) {
      await handler();
      return true;
    }
    console.warn(
      `[GridCommands] No handler registered for command: ${command}`
    );
    return false;
  }

  /**
   * Check if a command has a registered handler.
   * @param command The command name
   */
  hasHandler(command: GridCommand): boolean {
    return this.handlers.has(command);
  }

  /**
   * Clear all registered handlers (useful for cleanup/testing).
   */
  clear(): void {
    this.handlers.clear();
  }
}

/** Singleton command registry instance */
export const gridCommands = new GridCommandRegistry();

// ============================================================================
// Selection Utilities
// ============================================================================

/**
 * Check if a click position (row, col) is within the given selection.
 */
export function isClickWithinSelection(
  row: number,
  col: number,
  selection: Selection | null
): boolean {
  if (!selection) return false;

  const minRow = Math.min(selection.startRow, selection.endRow);
  const maxRow = Math.max(selection.startRow, selection.endRow);
  const minCol = Math.min(selection.startCol, selection.endCol);
  const maxCol = Math.max(selection.startCol, selection.endCol);

  return row >= minRow && row <= maxRow && col >= minCol && col <= maxCol;
}
