//! FILENAME: app/src/api/commands.ts
// PURPOSE: Central registry of Command IDs and the CommandRegistry singleton.
// CONTEXT: Extensions use CoreCommands IDs to link Menu Items to Actions.
//          The CommandRegistry bridges to core/lib/gridCommands for grid operations.

import { gridCommands, type GridCommand } from "../core/lib/gridCommands";

// ============================================================================
// Standard Command IDs (The "Well-Known" commands)
// ============================================================================

export const CoreCommands = {
  // Clipboard
  CUT: "core.clipboard.cut",
  COPY: "core.clipboard.copy",
  PASTE: "core.clipboard.paste",
  PASTE_SPECIAL: "core.clipboard.pasteSpecial",

  // Edit
  UNDO: "core.edit.undo",
  REDO: "core.edit.redo",
  FIND: "core.edit.find",
  REPLACE: "core.edit.replace",
  CLEAR_CONTENTS: "core.edit.clearContents",

  // Format
  FORMAT_CELLS: "core.format.cells",
  FORMAT_PAINTER: "core.format.painter",
  FORMAT_PAINTER_LOCK: "core.format.painterLock",

  // Grid
  MERGE_CELLS: "core.grid.merge",
  UNMERGE_CELLS: "core.grid.unmerge",
  FREEZE_PANES: "core.grid.freeze",
  INSERT_ROW: "core.grid.insertRow",
  INSERT_COLUMN: "core.grid.insertColumn",
  DELETE_ROW: "core.grid.deleteRow",
  DELETE_COLUMN: "core.grid.deleteColumn",
} as const;

// ============================================================================
// Command Registry Interface
// ============================================================================

export interface ICommandRegistry {
  execute(commandId: string, args?: unknown): Promise<void>;
  register(commandId: string, handler: (args?: unknown) => void | Promise<void>): void;
  unregister(commandId: string): void;
  has(commandId: string): boolean;
}

// ============================================================================
// Mapping from CoreCommands to GridCommand names
// ============================================================================

const GRID_COMMAND_MAP: Record<string, GridCommand> = {
  [CoreCommands.CUT]: "cut",
  [CoreCommands.COPY]: "copy",
  [CoreCommands.PASTE]: "paste",
  [CoreCommands.CLEAR_CONTENTS]: "clearContents",
  [CoreCommands.INSERT_ROW]: "insertRow",
  [CoreCommands.INSERT_COLUMN]: "insertColumn",
  [CoreCommands.DELETE_ROW]: "deleteRow",
  [CoreCommands.DELETE_COLUMN]: "deleteColumn",
};

// ============================================================================
// CommandRegistry Implementation
// ============================================================================

type CommandHandler = (args?: unknown) => void | Promise<void>;

class CommandRegistryImpl implements ICommandRegistry {
  private handlers: Map<string, CommandHandler> = new Map();

  /**
   * Register a command handler.
   * @param commandId The command ID (use CoreCommands.* for well-known commands)
   * @param handler The handler function
   */
  register(commandId: string, handler: CommandHandler): void {
    if (this.handlers.has(commandId)) {
      console.warn(`[CommandRegistry] Overwriting handler for command: ${commandId}`);
    }
    this.handlers.set(commandId, handler);
    console.log(`[CommandRegistry] Registered command: ${commandId}`);
  }

  /**
   * Unregister a command handler.
   * @param commandId The command ID to unregister
   */
  unregister(commandId: string): void {
    if (this.handlers.delete(commandId)) {
      console.log(`[CommandRegistry] Unregistered command: ${commandId}`);
    }
  }

  /**
   * Check if a command has a registered handler.
   * @param commandId The command ID to check
   */
  has(commandId: string): boolean {
    // Check local handlers first, then check gridCommands bridge
    if (this.handlers.has(commandId)) {
      return true;
    }
    const gridCommand = GRID_COMMAND_MAP[commandId];
    if (gridCommand) {
      return gridCommands.hasHandler(gridCommand);
    }
    return false;
  }

  /**
   * Execute a command.
   * Priority: 1) Local handlers, 2) GridCommands bridge
   * @param commandId The command ID to execute
   * @param args Optional arguments to pass to the handler
   */
  async execute(commandId: string, args?: unknown): Promise<void> {
    // 1. Check local handlers first
    const handler = this.handlers.get(commandId);
    if (handler) {
      await handler(args);
      return;
    }

    // 2. Bridge to gridCommands for grid-specific commands
    const gridCommand = GRID_COMMAND_MAP[commandId];
    if (gridCommand) {
      const executed = await gridCommands.execute(gridCommand);
      if (executed) {
        return;
      }
    }

    // 3. No handler found
    console.warn(`[CommandRegistry] No handler registered for command: ${commandId}`);
  }

  /**
   * Clear all registered handlers (useful for testing).
   */
  clear(): void {
    this.handlers.clear();
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

/** The global command registry singleton */
export const CommandRegistry: ICommandRegistry = new CommandRegistryImpl();