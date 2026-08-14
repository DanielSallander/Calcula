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
import { CommandRegistry } from "@api/commands";
import { listWorkbookScripts } from "@api/workbookScripts";
import type { ScriptSummary } from "@api/workbookScripts";
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
  listWorkbookScripts(): Promise<ScriptSummary[]>;
  hasMacroRunProvider(): boolean;
  runMacroByRef(macroId: string): Promise<MacroRunOutcome>;
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

    undo: () => undo(),
    redo: () => redo(),
    beginUndoTransaction: (description: string) => beginUndoTransaction(description),
    commitUndoTransaction: () => commitUndoTransaction(),

    navigateToRange: (startRow: number, startCol: number, endRow: number, endCol: number) =>
      navigateToRange(startRow, startCol, endRow, endCol),

    executeCommand: (commandId: string, args?: unknown) => CommandRegistry.execute(commandId, args),
    hasCommand: (commandId: string) => CommandRegistry.has(commandId),
    listCommands: () => CommandRegistry.getAll(),

    listWorkbookScripts: () => listWorkbookScripts(),
    hasMacroRunProvider: () => hasMacroRunProvider(),
    runMacroByRef: (macroId: string) => requireMacroRunProvider().runMacroByRef(macroId),
  };
}
