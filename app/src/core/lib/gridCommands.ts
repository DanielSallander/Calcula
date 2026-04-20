//! FILENAME: app/src/core/lib/gridCommands.ts
// PURPOSE: Command registry and selection utilities for the grid.
// CONTEXT: Core primitives used by the Spreadsheet component to register
// command handlers (cut, copy, paste, etc.) and provide selection utilities.
// Shell and Extensions import these through the API layer.

import type { Selection, DimensionOverrides } from "../types";

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
  /** Current dimension overrides (for hidden rows/cols state) */
  dimensions: DimensionOverrides;
}

// ============================================================================
// Command Registry
// ============================================================================

/** Command handler function type */
type CommandHandler = () => void | Promise<void>;

/**
 * Guard function type. Called before a command executes.
 * Receives the current selection so guards can determine which rows/columns
 * would be affected. Return `true` to allow, or a string (error message) to block.
 */
export type CommandGuard = (selection: Selection | null) => boolean | string;

/** Available command names */
export type GridCommand =
  | "cut"
  | "copy"
  | "paste"
  | "clearContents"
  | "clearFormatting"
  | "clearComments"
  | "clearHyperlinks"
  | "clearAll"
  | "insertRow"
  | "insertColumn"
  | "deleteRow"
  | "deleteColumn"
  | "mergeCells"
  | "unmergeCells"
  | "fillDown"
  | "fillRight"
  | "fillUp"
  | "fillLeft";

/** Command registry for direct handler invocation */
class GridCommandRegistry {
  private handlers: Map<GridCommand, CommandHandler> = new Map();
  private guards: Map<GridCommand, CommandGuard[]> = new Map();
  private currentSelection: Selection | null = null;

  /**
   * Update the current selection (called by the Spreadsheet component).
   * Guards use this to determine which rows/columns are affected.
   */
  setSelection(selection: Selection | null): void {
    this.currentSelection = selection;
  }

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
   * Register a guard for one or more commands.
   * Guards are checked before execution. If any guard returns a string,
   * the command is blocked and the string is shown as an alert.
   * @returns An unregister function
   */
  registerGuard(commands: GridCommand[], guard: CommandGuard): () => void {
    for (const cmd of commands) {
      const existing = this.guards.get(cmd) ?? [];
      existing.push(guard);
      this.guards.set(cmd, existing);
    }
    return () => {
      for (const cmd of commands) {
        const arr = this.guards.get(cmd);
        if (arr) {
          const idx = arr.indexOf(guard);
          if (idx >= 0) arr.splice(idx, 1);
        }
      }
    };
  }

  /**
   * Execute a command if a handler is registered.
   * Guards are checked first - if any guard returns a string, the command
   * is blocked and the message is shown as an alert.
   * @param command The command to execute
   * @returns true if the command was executed, false otherwise
   */
  async execute(command: GridCommand): Promise<boolean> {
    // Check guards
    const guards = this.guards.get(command);
    if (guards) {
      for (const guard of guards) {
        const result = guard(this.currentSelection);
        if (typeof result === "string") {
          alert(result);
          return false;
        }
      }
    }

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
   * Clear all registered handlers and guards (useful for cleanup/testing).
   */
  clear(): void {
    this.handlers.clear();
    this.guards.clear();
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
