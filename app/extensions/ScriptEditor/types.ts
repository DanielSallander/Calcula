//! FILENAME: app/extensions/ScriptEditor/types.ts
// PURPOSE: Frontend types for the Script Editor extension.
// CONTEXT: Mirrors the Rust scripting types from app/src-tauri/src/scripting/types.rs.

// ============================================================================
// Request / Response
// ============================================================================

/** Request payload sent to the run_script Tauri command. */
export interface RunScriptRequest {
  /** The JavaScript source code to execute */
  source: string;
  /** Display name for error messages */
  filename: string;
}

/** A bookmark mutation produced by a script. */
export interface BookmarkMutation {
  action: "addCellBookmark" | "removeCellBookmark" | "createViewBookmark" | "deleteViewBookmark" | "activateViewBookmark";
  row?: number;
  col?: number;
  sheetIndex?: number;
  label?: string;
  color?: string;
  id?: string;
  dimensionsJson?: string;
}

/** Successful script execution result. */
export interface ScriptSuccess {
  type: "success";
  /** Console output lines collected during execution */
  output: string[];
  /** Number of cells the script modified */
  cellsModified: number;
  /** Execution time in milliseconds */
  durationMs: number;
  /** Bookmark mutations to apply on the frontend */
  bookmarkMutations?: BookmarkMutation[];
}

/** Script execution error result. */
export interface ScriptError {
  type: "error";
  /** The error message */
  message: string;
  /** Console output collected before the error */
  output: string[];
}

/** Union type for script execution results. */
export type RunScriptResponse = ScriptSuccess | ScriptError;

// ============================================================================
// Script Module Types
// ============================================================================

/** Lightweight script summary (for listing without source code). */
export interface ScriptSummary {
  id: string;
  name: string;
}

/** Full script module stored in the workbook. */
export interface WorkbookScript {
  id: string;
  name: string;
  description: string | null;
  source: string;
}
