// FILENAME: app/extensions/CommandLine/cli/appGateway.ts
// PURPOSE: The app CLI domain's single doorway to the workbook: a narrow,
//          typed gateway interface plus its live implementation, which is
//          PURE DELEGATION to the public @api facade (the same functions the
//          ribbon and dialogs call, so undo/events/persistence come free).
// CONTEXT: Tests substitute a recording mock for the whole interface; nothing
//          in readers/writers touches @api directly. `cancelUndoTransaction`
//          is DELIBERATELY absent from this interface: it discards the undo
//          record WITHOUT reverting the grid (core/engine/src/undo.rs), which
//          would strand a failed batch's partial edits as un-undoable. The
//          batch strategy commits instead (kept-partial, one undo step).

import {
  addSheet,
  beginUndoTransaction,
  calculateNow,
  clearRangeWithOptions,
  commitUndoTransaction,
  createNamedRange,
  deleteNamedRange,
  deleteSheet,
  getAllNamedRanges,
  getRangeCellsTyped,
  getSheets,
  getUsedRange,
  hideSheet,
  redo,
  renameNamedRange,
  renameSheet,
  resolveNamedRangeCoords,
  setActiveSheet,
  setTabColor,
  sortRangeByColumn,
  undo,
  unhideSheet,
  updateCell,
} from "@api/lib";
import type {
  NamedRange,
  NamedRangeCoords,
  NamedRangeResult,
  SheetsResult,
  TypedCellData,
  UndoResult,
} from "@api/lib";
import { getAllPivotTables, getAllTables } from "@api/backend";
import type { ClearApplyTo, Table } from "@api/backend";
import type { CellData, UsedRangeResult } from "@api/types";
import { navigateToRange } from "@api/grid";
import { CommandRegistry, CoreCommands } from "@api/commands";
import { listWorkbookScriptRecords } from "@api/workbookScripts";
import { macroEntriesFrom } from "./macroProvenance";
import type { MacroEntry } from "./macroProvenance";
import { hasMacroRunProvider, requireMacroRunProvider } from "@api/macroRunService";
import type { MacroRunOutcome } from "@api/macroRunService";
import type { PivotTableInfo } from "@api/pivotTypes";

/** Everything the app CLI domain may do to the workbook. */
export interface AppCliGateway {
  // --- Sheets --------------------------------------------------------------
  getSheets(): Promise<SheetsResult>;
  addSheet(name?: string): Promise<SheetsResult>;
  deleteSheet(index: number): Promise<SheetsResult>;
  renameSheet(index: number, newName: string): Promise<SheetsResult>;
  hideSheet(index: number, level?: "hidden" | "veryHidden"): Promise<SheetsResult>;
  unhideSheet(index: number): Promise<SheetsResult>;
  setTabColor(index: number, color: string): Promise<SheetsResult>;
  setActiveSheet(index: number): Promise<SheetsResult>;
  getUsedRange(sheetIndex?: number): Promise<UsedRangeResult>;

  // --- Cells / ranges (ACTIVE sheet, like the backing commands) ------------
  /** The input string is the cell's raw input, passed VERBATIM ("42" is a
   *  literal, "=SUM(B:B)" is a formula) — exactly what typing into the cell
   *  would send, so recalc/undo/validation behave identically. */
  updateCell(row: number, col: number, input: string): Promise<unknown>;
  getRangeCellsTyped(
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    sheetIndex?: number,
  ): Promise<TypedCellData[]>;
  clearRange(
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    applyTo: ClearApplyTo,
  ): Promise<unknown>;
  /** `sortColumn` is the ABSOLUTE 0-based column index (the @api function
   *  converts it to the range-relative key itself: key = sortColumn - startCol). */
  sortRangeByColumn(
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    sortColumn: number,
    ascending: boolean,
    hasHeaders: boolean,
  ): Promise<unknown>;
  calculateNow(): Promise<CellData[]>;

  // --- Named ranges ---------------------------------------------------------
  getAllNamedRanges(): Promise<NamedRange[]>;
  createNamedRange(
    name: string,
    sheetIndex: number | null,
    refersTo: string,
  ): Promise<NamedRangeResult>;
  renameNamedRange(oldName: string, newName: string): Promise<NamedRangeResult>;
  deleteNamedRange(name: string): Promise<NamedRangeResult>;
  resolveNamedRangeCoords(name: string): Promise<NamedRangeCoords>;

  // --- Grid tables / pivots (read-only in the CLI) --------------------------
  getAllTables(): Promise<Table[]>;
  getAllPivotTables(): Promise<PivotTableInfo[]>;

  // --- Undo ------------------------------------------------------------------
  undo(): Promise<UndoResult>;
  redo(): Promise<UndoResult>;
  beginUndoTransaction(description: string): Promise<void>;
  commitUndoTransaction(): Promise<void>;

  // --- Navigation ------------------------------------------------------------
  navigateToRange(startRow: number, startCol: number, endRow: number, endCol: number): void;

  // --- Command registry -------------------------------------------------------
  executeCommand(commandId: string, args?: unknown): Promise<unknown>;
  hasCommand(commandId: string): boolean;
  listCommands(): string[];

  // --- Macros (workbook module scripts, run through the macroRunService seam) -
  /**
   * Every module script, WITH the origin derived from its own record.
   *
   * There is deliberately no origin-less listing on this interface. The summary
   * call `list_scripts` drops `source_package`, so a gateway method returning
   * summaries is a door through which a surface can list a publisher's module as
   * if it were the user's own — which is exactly what `ls macros` and `run` did.
   * One door, and it always carries provenance.
   */
  listMacros(): Promise<MacroEntry[]>;
  hasMacroRunProvider(): boolean;
  runMacroByRef(macroId: string): Promise<MacroRunOutcome>;
}

/**
 * Run a restore through the COMMAND the rest of the app reaches it by, falling
 * back to the raw IPC call only when no grid has registered that command (a
 * headless harness).
 *
 * WHY THE INDIRECTION IS THE POINT. The `@api/lib` `undo`/`redo` are the IPC leg
 * alone: they restore the data and return. Everything the user sees afterwards
 * -- following the backend's sheet switch, selecting the restored range,
 * scrolling it into view, re-reading dimensions after a structural restore --
 * lives in the command's handler. A second caller that skips it is a second
 * implementation of undo that silently drifts from the first; that is what
 * §18a closed for TestRunner's `ctx.undo()`, and this was the last one left.
 *
 * TWO DISTINCT FAILURES, AND THEY NEED DIFFERENT ANSWERS.
 *
 * A REFUSAL is an ordinary outcome: the undo stack is empty, so the backend
 * returns `UndoResult { success: false }` and nothing is wrong. It must not
 * throw — but it must not print "Undone." either, which is what happened while
 * nothing inspected `.success`.
 *
 * A CRASH is not: the handler swallows its own exceptions (Ctrl+Z must never
 * throw at the user) and returns `undefined`. That is surfaced as a rejection
 * rather than retried — a retry would pop a SECOND step off the stack on any
 * error that left the first one applied.
 *
 * The caller distinguishes them by reading `success`, which is why this returns
 * the whole result rather than a boolean.
 */
async function throughCommand(
  commandId: string,
  fallback: () => Promise<UndoResult>,
  label: string
): Promise<UndoResult> {
  if (!CommandRegistry.has(commandId)) return fallback();
  const result = (await CommandRegistry.execute(commandId)) as UndoResult | undefined;
  if (!result) throw new Error(`${label} failed`);
  return result;
}

/** The live gateway: each method delegates to exactly one @api function. */
export function createLiveAppGateway(): AppCliGateway {
  return {
    getSheets: () => getSheets(),
    addSheet: (name?: string) => addSheet(name),
    deleteSheet: (index: number) => deleteSheet(index),
    renameSheet: (index: number, newName: string) => renameSheet(index, newName),
    hideSheet: (index: number, level?: "hidden" | "veryHidden") => hideSheet(index, level),
    unhideSheet: (index: number) => unhideSheet(index),
    setTabColor: (index: number, color: string) => setTabColor(index, color),
    setActiveSheet: (index: number) => setActiveSheet(index),
    getUsedRange: (sheetIndex?: number) => getUsedRange(sheetIndex),

    updateCell: (row: number, col: number, input: string) => updateCell(row, col, input),
    getRangeCellsTyped: (
      startRow: number,
      startCol: number,
      endRow: number,
      endCol: number,
      sheetIndex?: number,
    ) => getRangeCellsTyped(startRow, startCol, endRow, endCol, sheetIndex),
    clearRange: (
      startRow: number,
      startCol: number,
      endRow: number,
      endCol: number,
      applyTo: ClearApplyTo,
    ) => clearRangeWithOptions(startRow, startCol, endRow, endCol, applyTo),
    sortRangeByColumn: (
      startRow: number,
      startCol: number,
      endRow: number,
      endCol: number,
      sortColumn: number,
      ascending: boolean,
      hasHeaders: boolean,
    ) => sortRangeByColumn(startRow, startCol, endRow, endCol, sortColumn, ascending, hasHeaders),
    calculateNow: () => calculateNow(),

    getAllNamedRanges: () => getAllNamedRanges(),
    createNamedRange: (name: string, sheetIndex: number | null, refersTo: string) =>
      createNamedRange(name, sheetIndex, refersTo),
    renameNamedRange: (oldName: string, newName: string) => renameNamedRange(oldName, newName),
    deleteNamedRange: (name: string) => deleteNamedRange(name),
    resolveNamedRangeCoords: (name: string) => resolveNamedRangeCoords(name),

    getAllTables: () => getAllTables(),
    getAllPivotTables: () => getAllPivotTables<PivotTableInfo[]>(),

    // THROUGH THE COMMAND, not the raw backend call. `undo`/`redo` from
    // `@api/lib` are the IPC leg only: they restore the data and return, so a
    // CLI undo left the grid on the wrong sheet (the backend switches, the view
    // does not follow) and, since open-items 1.4, would also leave the cursor
    // off the range it just restored. `CoreCommands.UNDO` is what Ctrl+Z, the
    // ribbon and Edit > Undo all reach, and routing here means the CLI's undo
    // is the user's undo rather than a second implementation of it -- the same
    // divergence §18a closed for TestRunner's `ctx.undo()`.
    //
    // Falls back to the raw call when the command is not registered, because
    // the CLI must still work in a harness that mounted no grid.
    undo: () => throughCommand(CoreCommands.UNDO, undo, "Undo"),
    redo: () => throughCommand(CoreCommands.REDO, redo, "Redo"),
    beginUndoTransaction: (description: string) => beginUndoTransaction(description),
    commitUndoTransaction: () => commitUndoTransaction(),

    navigateToRange: (startRow: number, startCol: number, endRow: number, endCol: number) =>
      navigateToRange(startRow, startCol, endRow, endCol),

    executeCommand: (commandId: string, args?: unknown) => CommandRegistry.execute(commandId, args),
    hasCommand: (commandId: string) => CommandRegistry.has(commandId),
    listCommands: () => CommandRegistry.getAll(),

    // Through the RECORD inventory, not the summary list: `get_script` is the
    // only backend read that returns `sourcePackage`, and the origin is derived
    // from that field alone (macroEntriesFrom -> scriptOriginForStoredRecord).
    listMacros: async () => macroEntriesFrom(await listWorkbookScriptRecords()),
    hasMacroRunProvider: () => hasMacroRunProvider(),
    runMacroByRef: (macroId: string) => requireMacroRunProvider().runMacroByRef(macroId),
  };
}
