//! FILENAME: app/extensions/ScriptNotebook/lib/notebookApi.ts
// PURPOSE: TypeScript bindings for the Tauri notebook commands.
// CONTEXT: Uses the API facade (src/api/backend.ts) for sandboxed backend access.

import { invokeBackend } from "../../../src/api/backend";
import type {
  NotebookDocument,
  NotebookSummary,
  NotebookCellResponse,
  RunNotebookCellRequest,
  RewindNotebookRequest,
} from "../types";

// ============================================================================
// Notebook CRUD
// ============================================================================

/** Create a new empty notebook with one cell. */
export async function createNotebook(
  id: string,
  name: string,
): Promise<NotebookDocument> {
  return invokeBackend<NotebookDocument>("notebook_create", { id, name });
}

/** Save (create or update) a notebook document. */
export async function saveNotebook(
  notebook: NotebookDocument,
): Promise<void> {
  return invokeBackend<void>("notebook_save", { notebook });
}

/** Load a notebook by ID. */
export async function loadNotebook(id: string): Promise<NotebookDocument> {
  return invokeBackend<NotebookDocument>("notebook_load", { id });
}

/** List all notebooks (lightweight summaries). */
export async function listNotebooks(): Promise<NotebookSummary[]> {
  return invokeBackend<NotebookSummary[]>("notebook_list");
}

/** Delete a notebook by ID. */
export async function deleteNotebook(id: string): Promise<void> {
  return invokeBackend<void>("notebook_delete", { id });
}

// ============================================================================
// Notebook Cell Execution
// ============================================================================

/** Run a single notebook cell. */
export async function runNotebookCell(
  request: RunNotebookCellRequest,
): Promise<NotebookCellResponse> {
  return invokeBackend<NotebookCellResponse>("notebook_run_cell", { request });
}

/** Run all cells in a notebook sequentially. */
export async function runAllCells(
  notebookId: string,
): Promise<NotebookCellResponse[]> {
  return invokeBackend<NotebookCellResponse[]>("notebook_run_all", {
    notebookId,
  });
}

/** Rewind to just before a specific cell. */
export async function rewindNotebook(
  request: RewindNotebookRequest,
): Promise<NotebookCellResponse[]> {
  return invokeBackend<NotebookCellResponse[]>("notebook_rewind", { request });
}

/** Rewind to a cell and run from it onwards. */
export async function runFromCell(
  request: RewindNotebookRequest,
): Promise<NotebookCellResponse[]> {
  return invokeBackend<NotebookCellResponse[]>("notebook_run_from", {
    request,
  });
}

/** Reset the notebook runtime (destroy session and checkpoints). */
export async function resetNotebookRuntime(): Promise<void> {
  return invokeBackend<void>("notebook_reset_runtime");
}
