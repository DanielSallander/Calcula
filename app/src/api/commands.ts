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
  PASTE_VALUES: "core.clipboard.pasteValues",
  PASTE_FORMULAS: "core.clipboard.pasteFormulas",
  PASTE_FORMATTING: "core.clipboard.pasteFormatting",
  PASTE_LINK: "core.clipboard.pasteLink",

  // Edit
  UNDO: "core.edit.undo",
  REDO: "core.edit.redo",
  FIND: "core.edit.find",
  REPLACE: "core.edit.replace",
  CLEAR_CONTENTS: "core.edit.clearContents",
  CLEAR_FORMATTING: "core.edit.clearFormatting",
  CLEAR_COMMENTS: "core.edit.clearComments",
  CLEAR_HYPERLINKS: "core.edit.clearHyperlinks",
  CLEAR_ALL: "core.edit.clearAll",

  // Fill
  FILL_DOWN: "core.edit.fillDown",
  FILL_RIGHT: "core.edit.fillRight",
  FILL_UP: "core.edit.fillUp",
  FILL_LEFT: "core.edit.fillLeft",

  // Format
  FORMAT_CELLS: "core.format.cells",
  FORMAT_PAINTER: "core.format.painter",
  FORMAT_PAINTER_LOCK: "core.format.painterLock",
  INCREASE_INDENT: "core.format.increaseIndent",
  DECREASE_INDENT: "core.format.decreaseIndent",

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

/** Registration options for commands. */
export interface CommandOptions {
  /**
   * Opt-in flag: object scripts may only execute commands registered with
   * scriptSafe: true (sandbox design §5, R6). Opt-in (not opt-out) so every
   * future command fails closed for scripts unless its author deliberately
   * audits it. UI/menu execution is unaffected by this flag.
   */
  scriptSafe?: boolean;
}

export interface ICommandRegistry {
  /** Run a command and return its handler's result (undefined if the handler
   *  returns nothing or the command bridges to a grid command). */
  execute(commandId: string, args?: unknown): Promise<unknown>;
  register(commandId: string, handler: (args?: unknown) => unknown, options?: CommandOptions): void;
  unregister(commandId: string): void;
  has(commandId: string): boolean;
  /** Whether object scripts may execute this command (scriptSafe opt-in). */
  isScriptSafe(commandId: string): boolean;
  /** Return all registered command IDs (local handlers + grid command bridge). */
  getAll(): string[];
}

// ============================================================================
// Mapping from CoreCommands to GridCommand names
// ============================================================================

const GRID_COMMAND_MAP: Record<string, GridCommand> = {
  [CoreCommands.CUT]: "cut",
  [CoreCommands.COPY]: "copy",
  [CoreCommands.PASTE]: "paste",
  [CoreCommands.CLEAR_CONTENTS]: "clearContents",
  [CoreCommands.CLEAR_FORMATTING]: "clearFormatting",
  [CoreCommands.CLEAR_COMMENTS]: "clearComments",
  [CoreCommands.CLEAR_HYPERLINKS]: "clearHyperlinks",
  [CoreCommands.CLEAR_ALL]: "clearAll",
  [CoreCommands.INSERT_ROW]: "insertRow",
  [CoreCommands.INSERT_COLUMN]: "insertColumn",
  [CoreCommands.DELETE_ROW]: "deleteRow",
  [CoreCommands.DELETE_COLUMN]: "deleteColumn",
  [CoreCommands.MERGE_CELLS]: "mergeCells",
  [CoreCommands.UNMERGE_CELLS]: "unmergeCells",
  [CoreCommands.FILL_DOWN]: "fillDown",
  [CoreCommands.FILL_RIGHT]: "fillRight",
  [CoreCommands.FILL_UP]: "fillUp",
  [CoreCommands.FILL_LEFT]: "fillLeft",
};

/**
 * Grid-bridge commands object scripts may execute: workbook data-plane
 * operations whose reach is equivalent to the unlocked cell APIs. The
 * clipboard group (cut/copy/paste*) is deliberately absent — clipboard
 * contents are ambient-world data.
 */
const SCRIPT_SAFE_GRID_COMMANDS: ReadonlySet<string> = new Set([
  CoreCommands.CLEAR_CONTENTS,
  CoreCommands.CLEAR_FORMATTING,
  CoreCommands.CLEAR_COMMENTS,
  CoreCommands.CLEAR_HYPERLINKS,
  CoreCommands.CLEAR_ALL,
  CoreCommands.INSERT_ROW,
  CoreCommands.INSERT_COLUMN,
  CoreCommands.DELETE_ROW,
  CoreCommands.DELETE_COLUMN,
  CoreCommands.MERGE_CELLS,
  CoreCommands.UNMERGE_CELLS,
  CoreCommands.FILL_DOWN,
  CoreCommands.FILL_RIGHT,
  CoreCommands.FILL_UP,
  CoreCommands.FILL_LEFT,
]);

// ============================================================================
// CommandRegistry Implementation
// ============================================================================

type CommandHandler = (args?: unknown) => unknown;

class CommandRegistryImpl implements ICommandRegistry {
  private handlers: Map<string, CommandHandler> = new Map();
  private scriptSafeIds: Set<string> = new Set();

  /**
   * Register a command handler.
   * @param commandId The command ID (use CoreCommands.* for well-known commands)
   * @param handler The handler function
   * @param options Registration options (scriptSafe opt-in for object scripts)
   */
  register(commandId: string, handler: CommandHandler, options?: CommandOptions): void {
    if (this.handlers.has(commandId)) {
      console.warn(`[CommandRegistry] Overwriting handler for command: ${commandId}`);
    }
    this.handlers.set(commandId, handler);
    if (options?.scriptSafe) {
      this.scriptSafeIds.add(commandId);
    } else {
      this.scriptSafeIds.delete(commandId);
    }
    console.log(`[CommandRegistry] Registered command: ${commandId}`);
  }

  /**
   * Unregister a command handler.
   * @param commandId The command ID to unregister
   */
  unregister(commandId: string): void {
    if (this.handlers.delete(commandId)) {
      this.scriptSafeIds.delete(commandId);
      console.log(`[CommandRegistry] Unregistered command: ${commandId}`);
    }
  }

  /**
   * Whether object scripts may execute this command. Grid-bridge commands
   * are data-plane operations (equivalent reach to the unlocked cell APIs)
   * and count as scriptSafe, EXCEPT the clipboard group — clipboard contents
   * are ambient-world data a script should not be able to read or replace.
   */
  isScriptSafe(commandId: string): boolean {
    if (this.scriptSafeIds.has(commandId)) {
      return true;
    }
    if (SCRIPT_SAFE_GRID_COMMANDS.has(commandId)) {
      return true;
    }
    return false;
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
  async execute(commandId: string, args?: unknown): Promise<unknown> {
    // 1. Check local handlers first — return the handler's result.
    const handler = this.handlers.get(commandId);
    if (handler) {
      return await handler(args);
    }

    // 2. Bridge to gridCommands for grid-specific commands
    const gridCommand = GRID_COMMAND_MAP[commandId];
    if (gridCommand) {
      const executed = await gridCommands.execute(gridCommand);
      if (executed) {
        return undefined;
      }
    }

    // 3. No handler found
    console.warn(`[CommandRegistry] No handler registered for command: ${commandId}`);
    return undefined;
  }

  /**
   * Return all registered command IDs (local handlers + grid command bridge).
   */
  getAll(): string[] {
    const ids = new Set<string>(this.handlers.keys());
    for (const commandId of Object.keys(GRID_COMMAND_MAP)) {
      ids.add(commandId);
    }
    return Array.from(ids).sort();
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