//! FILENAME: app/extensions/ScriptNotebook/types.ts
// PURPOSE: TypeScript types for the notebook system.
// CONTEXT: Mirrors Rust types in app/src-tauri/src/scripting/types.rs.

/** A notebook document containing ordered cells for sequential execution. */
export interface NotebookDocument {
  id: string;
  name: string;
  cells: NotebookCell[];
}

/** A single cell in a notebook. */
export interface NotebookCell {
  id: string;
  source: string;
  lastOutput: string[];
  lastError: string | null;
  cellsModified: number;
  durationMs: number;
  executionIndex: number | null;
}

/** Lightweight notebook summary for listing. */
export interface NotebookSummary {
  id: string;
  name: string;
  cellCount: number;
}

/** Request to run a single notebook cell. */
export interface RunNotebookCellRequest {
  notebookId: string;
  cellId: string;
  source: string;
}

/** Request to rewind a notebook. */
export interface RewindNotebookRequest {
  notebookId: string;
  targetCellId: string;
}

/** A deferred action from Application object methods/properties. */
export type DeferredAction =
  | { action: "goto"; row: number; col: number; sheetIndex: number }
  | { action: "calculate" }
  | { action: "setStatusBar"; message: string | null };

/** Response from notebook cell execution. */
export type NotebookCellResponse =
  | {
      type: "success";
      output: string[];
      cellsModified: number;
      durationMs: number;
      executionIndex: number;
      /** Application.screenUpdating value at end of cell execution */
      screenUpdating: boolean;
      /** Application.enableEvents value at end of cell execution */
      enableEvents: boolean;
      /** Deferred actions from Application object (goto, calculate, statusBar) */
      deferredActions?: DeferredAction[];
    }
  | {
      type: "error";
      message: string;
      output: string[];
    };
