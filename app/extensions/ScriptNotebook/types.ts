//! FILENAME: app/extensions/ScriptNotebook/types.ts
// PURPOSE: TypeScript types for the notebook system.
// CONTEXT: Mirrors Rust types in app/src-tauri/src/scripting/types.rs.

import type { DeferredAction } from "@api/workbookScripts";

/** A notebook document containing ordered cells for sequential execution. */
export interface NotebookDocument {
  id: string;
  name: string;
  cells: NotebookCell[];
  /** The .calp package this notebook was distributed from (C8 provenance).
   *  Absent for local/subscriber-authored notebooks. */
  sourcePackage?: string;
}

/** A structured output item from cell execution (mirrors Rust ScriptOutputItem). */
export type NotebookOutputItem =
  | { kind: "text"; text: string }
  | {
      kind: "table";
      /** Column headers; empty = render without a header row. */
      columns: string[];
      rows: string[][];
      /** True when rows were dropped to fit the per-item row cap. */
      truncated: boolean;
      /** Row count before truncation. */
      totalRows: number;
    };

/** A single cell in a notebook.
 *
 *  There is deliberately no `kind` field: a cell is prose when its source
 *  starts with `//!markdown` (see lib/cellKind.ts for why, and
 *  notebook_commands.rs::is_markdown_source for the authoritative half of the
 *  same rule). Keeping the kind in the bytes keeps the .cala/.calp notebook
 *  record at one shape across all three persistence layers. */
export interface NotebookCell {
  id: string;
  source: string;
  lastOutput: NotebookOutputItem[];
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

/**
 * A deferred action from Application object methods/properties.
 * The canonical union lives in @api so every script surface (notebook cells,
 * `run_script` from a button, bookmark scripts) speaks one shape; re-exported
 * here because the notebook response embeds it.
 */
export type { DeferredAction };

/** Response from notebook cell execution. */
export type NotebookCellResponse =
  | {
      type: "success";
      output: NotebookOutputItem[];
      cellsModified: number;
      durationMs: number;
      executionIndex: number;
      /** Application.screenUpdating value at end of cell execution */
      screenUpdating: boolean;
      /** Deferred actions from Application object (goto, calculate, statusBar) */
      deferredActions?: DeferredAction[];
    }
  | {
      type: "error";
      message: string;
      output: NotebookOutputItem[];
    };
