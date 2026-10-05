//! FILENAME: app/src/api/commands.ts
// PURPOSE: Central registry of Command IDs and the CommandRegistry singleton.
// CONTEXT: Extensions use CoreCommands IDs to link Menu Items to Actions.
//          The CommandRegistry bridges to core/lib/gridCommands for grid operations.

import { gridCommands, type GridCommand } from "../core/lib/gridCommands";
import { commandRefusalFor } from "./commandRefusals";
import { showToast } from "./notifications";

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
  // Excel's Merge menu (2026-10-02): the Home tab's split button runs
  // MERGE_CENTER (a toggle: it unmerges while the selection holds a merge);
  // MERGE_ACROSS merges each row of the selection on its own.
  MERGE_CENTER: "core.grid.mergeCenter",
  MERGE_ACROSS: "core.grid.mergeAcross",
  FREEZE_PANES: "core.grid.freeze",
  INSERT_ROW: "core.grid.insertRow",
  INSERT_COLUMN: "core.grid.insertColumn",
  DELETE_ROW: "core.grid.deleteRow",
  DELETE_COLUMN: "core.grid.deleteColumn",

  // ---- Excel's Home tab (2026-10-04) --------------------------------------
  // The ids below are the contract between the Home ribbon and the code that
  // owns each command (the Seam Rule: the ribbon says WHAT, the owner decides
  // HOW). Every value here is core.*; the extension-owned ids the ribbon also
  // runs live in ExtensionCommands below, because CoreCommands is the core.*
  // namespace (api-contracts and the constants snapshot pin that).

  // Paste variants (PasteSpecial extension). Keep Source Formatting is PASTE.
  PASTE_FORMULAS_AND_NUMBER_FORMATS: "core.clipboard.pasteFormulasAndNumberFormats",
  PASTE_NO_BORDERS: "core.clipboard.pasteNoBorders",
  PASTE_KEEP_SOURCE_COLUMN_WIDTHS: "core.clipboard.pasteKeepSourceColumnWidths",
  PASTE_TRANSPOSE: "core.clipboard.pasteTranspose",
  PASTE_VALUES_AND_NUMBER_FORMATS: "core.clipboard.pasteValuesAndNumberFormats",
  PASTE_VALUES_AND_SOURCE_FORMATTING: "core.clipboard.pasteValuesAndSourceFormatting",

  // Clear menu: Excel's Remove Hyperlinks (the links AND their formatting).
  REMOVE_HYPERLINKS: "core.edit.removeHyperlinks",

  // Cells group: Insert / Delete. INSERT and DELETE are the split buttons'
  // main halves (Excel decides rows, columns or cells from the selection);
  // INSERT_CELLS / DELETE_CELLS take `{ shift }` and open the Insert / Delete
  // dialog when called without it (InsertDeleteCells extension).
  INSERT: "core.grid.insert",
  DELETE: "core.grid.delete",
  INSERT_CELLS: "core.grid.insertCells",
  DELETE_CELLS: "core.grid.deleteCells",

  // Cells group: the Format menu. Each acts on the rows / columns the
  // selection spans, as Excel's do.
  ROW_HEIGHT: "core.format.rowHeight",
  COLUMN_WIDTH: "core.format.columnWidth",
  DEFAULT_WIDTH: "core.format.defaultWidth",
  AUTOFIT_ROW_HEIGHT: "core.format.autoFitRowHeight",
  AUTOFIT_COLUMN_WIDTH: "core.format.autoFitColumnWidth",
  HIDE_ROWS: "core.format.hideRows",
  HIDE_COLUMNS: "core.format.hideColumns",
  UNHIDE_ROWS: "core.format.unhideRows",
  UNHIDE_COLUMNS: "core.format.unhideColumns",

  // Sheets (the shell, which owns the sheet tabs). SHEET_TAB_COLOR takes
  // `{ color: string | null }` (null = No Color).
  SHEET_INSERT: "core.sheet.insert",
  SHEET_DELETE: "core.sheet.delete",
  SHEET_RENAME: "core.sheet.rename",
  SHEET_HIDE: "core.sheet.hide",
  SHEET_UNHIDE: "core.sheet.unhide",
  SHEET_TAB_COLOR: "core.sheet.setTabColor",
  SHEET_MOVE_OR_COPY: "core.sheet.moveOrCopy",

  // Editing group: More Functions... opens the fx dialog (the formula bar's
  // host, which stays mounted while the bar is hidden).
  INSERT_FUNCTION: "core.formula.insertFunction",
} as const;

// ============================================================================
// Well-known EXTENSION command ids (Excel's Home tab, 2026-10-04)
// ============================================================================

/**
 * Commands an EXTENSION registers that other features run by id -- the Home
 * ribbon's menus first of all. They are named here once so that the
 * registering extension and every caller spell them the same way (a typo in
 * either is a button that silently does nothing: `execute` takes a string).
 * They are not CoreCommands because they are not core.*: the namespace says
 * who owns the handler.
 */
export const ExtensionCommands = {
  // Protection extension.
  PROTECT_SHEET_TOGGLE: "protection.toggleProtectSheet",
  LOCK_CELL_TOGGLE: "protection.toggleLockCell",

  // Editing group. AUTOSUM takes `{ fn: "SUM" | "AVERAGE" | "COUNT" | "MAX" |
  // "MIN" }` (AutoSum extension); FILL_SERIES opens the Series dialog
  // (FillSeries extension); FLASH_FILL is the FlashFill extension's.
  AUTOSUM: "autosum.insert",
  FILL_SERIES: "fill.series",
  FLASH_FILL: "flashfill.execute",

  // Sort & Filter (Sorting and AutoFilter extensions).
  SORT_ASCENDING: "sort.ascending",
  SORT_DESCENDING: "sort.descending",
  SORT_CUSTOM: "sort.customDialog",
  FILTER_TOGGLE: "autofilter.toggle",
  FILTER_CLEAR: "autofilter.clear",
  FILTER_REAPPLY: "autofilter.reapply",

  // Find & Select (GoToSpecial extension). GO_TO_SPECIAL_SELECT takes
  // `{ criteria }` and selects the matching cells directly (Excel's
  // Formulas / Notes / Conditional Formatting / Constants / Data Validation).
  GO_TO: "navigate.goTo",
  GO_TO_SPECIAL: "view.goToSpecial",
  GO_TO_SPECIAL_SELECT: "goToSpecial.select",

  // Styles group: Format as Table takes `{ styleId }` (Table extension).
  FORMAT_AS_TABLE: "table.formatAsTable",
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
  [CoreCommands.MERGE_CENTER]: "mergeCenter",
  [CoreCommands.MERGE_ACROSS]: "mergeAcross",
  [CoreCommands.FILL_DOWN]: "fillDown",
  [CoreCommands.FILL_RIGHT]: "fillRight",
  [CoreCommands.FILL_UP]: "fillUp",
  [CoreCommands.FILL_LEFT]: "fillLeft",
  // Excel's Home tab (2026-10-04). The AutoFit pair take `{ growOnly?: boolean }`
  // (the bridge below forwards args) and are NOT script-safe (see
  // SCRIPT_SAFE_GRID_COMMANDS); Remove Hyperlinks clears each linked cell's
  // link AND formatting in one undo step.
  [CoreCommands.AUTOFIT_ROW_HEIGHT]: "autoFitRowHeight",
  [CoreCommands.AUTOFIT_COLUMN_WIDTH]: "autoFitColumnWidth",
  [CoreCommands.REMOVE_HYPERLINKS]: "removeHyperlinks",
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
  // Since 2026-10-04 this also clears NOTES (Excel's "Clear Comments and
  // Notes"); the unlocked API already deletes notes.
  CoreCommands.CLEAR_COMMENTS,
  CoreCommands.CLEAR_HYPERLINKS,
  CoreCommands.CLEAR_ALL,
  // Clear Formats + Clear Hyperlinks over the linked cells only: no reach
  // beyond the two commands above.
  CoreCommands.REMOVE_HYPERLINKS,
  // Since 2026-10-04 these act on the rows / columns ANY selection spans
  // (Excel's Insert / Delete Sheet Rows / Columns), not only on whole-row /
  // whole-column selections -- the same reach a script already had by
  // selecting whole rows first, and the unlocked API's insertRows/deleteRows.
  CoreCommands.INSERT_ROW,
  CoreCommands.INSERT_COLUMN,
  CoreCommands.DELETE_ROW,
  CoreCommands.DELETE_COLUMN,
  // NOT AUTOFIT_ROW_HEIGHT / AUTOFIT_COLUMN_WIDTH (review finding (e),
  // 2026-10-04). A full fit UNHIDES the user-hidden rows / columns inside the
  // selection, as Excel's does, and un-hiding is the UNLOCKED API's
  // setRowsHidden reach -- while this set is the ONLY gate of the restricted
  // script doors (`ext.executeCommand`: restricted tier, no capability, no
  // consent, no JIT grant; an object script's executeCommand). Listed here, a
  // sandboxed add-in with no capability could bring back, over Select All, the
  // rows a user hid to keep working data out of a distributed report. Scripts
  // size rows and columns through the unlocked API's autoFit / setRowHeight /
  // setColumnWidth, which are gated as such. Re-admit them only behind a
  // capability, or with grow-only as the only form a script door can run.
  CoreCommands.MERGE_CELLS,
  CoreCommands.UNMERGE_CELLS,
  // The same reach as MERGE_CELLS plus a horizontal alignment, which the
  // unlocked format API already grants; like MERGE_CELLS they now raise
  // Excel's data-loss confirmation when a merge would discard values.
  CoreCommands.MERGE_CENTER,
  CoreCommands.MERGE_ACROSS,
  CoreCommands.FILL_DOWN,
  CoreCommands.FILL_RIGHT,
  CoreCommands.FILL_UP,
  CoreCommands.FILL_LEFT,
]);

// ============================================================================
// Macro-recorder observation hook
// ----------------------------------------------------------------------------
// Slice 2 of the recorder: cell writes alone produce disappointing macros, so
// the registry reports every command dispatch too. The hook is called with a
// PHASE rather than once at the end, because the recorder needs a scope, not a
// notification:
//
//   before  -> a handler is about to run
//   after   -> it ran and returned
//   failed  -> it threw (the error still propagates to the caller)
//   unhandled -> no handler and no grid bridge; nothing happened
//
// The scope matters because most CoreCommands ultimately reach the IPC bridge,
// where the macro recorder ALREADY observes the operation with explicit
// coordinates (see setGridRecorderHook in core/lib/tauri-api.ts). Recording
// both would replay the action twice. With begin/end phases the recorder can
// decide per command which representation wins and suppress the other, instead
// of this registry having to know anything about macros.
//
// Zero cost when no recorder is installed: one null check per execute().
// ============================================================================

/** Where in a command's dispatch the recorder is being told about it. */
export type CommandRecordPhase = "before" | "after" | "failed" | "unhandled";

/** Best-effort observer of command dispatches. At most one is installed (by the
 *  macro recorder while recording); pass null to uninstall. A failing hook never
 *  affects the command. */
export type CommandRecorderHook = (
  commandId: string,
  phase: CommandRecordPhase,
  args?: unknown,
) => void;

let commandRecorderHook: CommandRecorderHook | null = null;

/** Installed by the macro recorder while recording; pass null to uninstall. */
export function setCommandRecorderHook(hook: CommandRecorderHook | null): void {
  commandRecorderHook = hook;
}

function recordCommand(
  commandId: string,
  phase: CommandRecordPhase,
  args?: unknown,
): void {
  if (!commandRecorderHook) return;
  try {
    commandRecorderHook(commandId, phase, args);
  } catch (e) {
    console.warn("[recorder] command hook failed; ignoring", e);
  }
}

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
   * Priority: 0) a command refusal, 1) Local handlers, 2) GridCommands bridge
   * @param commandId The command ID to execute
   * @param args Optional arguments to pass to the handler
   */
  async execute(commandId: string, args?: unknown): Promise<unknown> {
    // 0. A REFUSED command (`@api/commandRefusals`) runs nothing from ANY door.
    // Only the keyboard dispatcher asked the refusals, so Undo on the ribbon,
    // the Edit menu or the Quick Access Toolbar while a slicer click was still
    // landing reached the backend -- and could overtake the gesture's own
    // start, taking back the step BEFORE the click (found live 2026-09-29, e2e
    // fixall-edit W15). A refused keystroke never gets here: the dispatcher
    // refuses it itself, so the sentence is shown once per press either way.
    const refusal = commandRefusalFor(commandId);
    if (refusal !== null) {
      // Nothing ran, so nothing is recorded (like an unknown command): an
      // unpaired "unhandled" would close an ENCLOSING command's recorder scope.
      try {
        showToast(refusal, { variant: "info" });
      } catch {
        console.warn(`[CommandRegistry] ${refusal}`);
      }
      return undefined;
    }

    // 1. Check local handlers first — return the handler's result.
    const handler = this.handlers.get(commandId);
    if (handler) {
      recordCommand(commandId, "before", args);
      try {
        const result = await handler(args);
        recordCommand(commandId, "after", args);
        return result;
      } catch (e) {
        recordCommand(commandId, "failed", args);
        throw e;
      }
    }

    // 2. Bridge to gridCommands for grid-specific commands. `args` travels on
    // (the AutoFit commands read `{ growOnly }`); it used to be dropped here,
    // so a grid command could take no options at all.
    const gridCommand = GRID_COMMAND_MAP[commandId];
    if (gridCommand) {
      recordCommand(commandId, "before", args);
      let executed: boolean;
      try {
        executed = await gridCommands.execute(gridCommand, args);
      } catch (e) {
        recordCommand(commandId, "failed", args);
        throw e;
      }
      if (executed) {
        recordCommand(commandId, "after", args);
        return undefined;
      }
      // The bridge exists but nothing ran (no handler mounted, or a guard
      // refused): close the scope as "nothing happened", not as a success.
      recordCommand(commandId, "unhandled", args);
      console.warn(`[CommandRegistry] No handler registered for command: ${commandId}`);
      return undefined;
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