//! FILENAME: app/extensions/ScriptNotebook/lib/notebookApi.ts
// PURPOSE: TypeScript bindings for the Tauri notebook commands.
// CONTEXT: Uses the API facade (src/api/backend.ts) for sandboxed backend access.

import { notebookBackend } from "./notebookBackend";
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
  return notebookBackend.invoke<NotebookDocument>("notebook_create", { id, name });
}

/** Save (create or update) a notebook document. */
export async function saveNotebook(
  notebook: NotebookDocument,
): Promise<void> {
  return notebookBackend.invoke<void>("notebook_save", { notebook });
}

/** Load a notebook by ID. */
export async function loadNotebook(id: string): Promise<NotebookDocument> {
  return notebookBackend.invoke<NotebookDocument>("notebook_load", { id });
}

/** List all notebooks (lightweight summaries). */
export async function listNotebooks(): Promise<NotebookSummary[]> {
  return notebookBackend.invoke<NotebookSummary[]>("notebook_list");
}

/** Delete a notebook by ID. */
export async function deleteNotebook(id: string): Promise<void> {
  return notebookBackend.invoke<void>("notebook_delete", { id });
}

// ============================================================================
// Notebook Cell Execution
// ============================================================================

/**
 * Handle the Script Security gate around notebook execution calls. When the
 * level is "prompt", the backend refuses with a sentinel error until the user
 * approves script execution once for the session; this shows the confirmation,
 * grants the session approval, and retries.
 */
async function withScriptSecurityPrompt<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("SCRIPT_PROMPT_REQUIRED")) {
      const ok = window.confirm(
        "This notebook wants to run a script cell.\n\n" +
        "Allow script execution for this session?\n" +
        "(Script Security is set to 'prompt'. Set it to 'enabled' or 'disabled' to stop asking.)",
      );
      if (ok) {
        await notebookBackend.invoke<void>("grant_script_session_approval");
        return run();
      }
    }
    throw err;
  }
}

/** Run a single notebook cell. */
export async function runNotebookCell(
  request: RunNotebookCellRequest,
): Promise<NotebookCellResponse> {
  return withScriptSecurityPrompt(() =>
    notebookBackend.invoke<NotebookCellResponse>("notebook_run_cell", { request }),
  );
}

/** Run all cells in a notebook sequentially. */
export async function runAllCells(
  notebookId: string,
): Promise<NotebookCellResponse[]> {
  return withScriptSecurityPrompt(() =>
    notebookBackend.invoke<NotebookCellResponse[]>("notebook_run_all", {
      notebookId,
    }),
  );
}

/** Rewind to just before a specific cell. */
export async function rewindNotebook(
  request: RewindNotebookRequest,
): Promise<NotebookCellResponse[]> {
  return notebookBackend.invoke<NotebookCellResponse[]>("notebook_rewind", { request });
}

/** Rewind to a cell and run from it onwards. */
export async function runFromCell(
  request: RewindNotebookRequest,
): Promise<NotebookCellResponse[]> {
  return withScriptSecurityPrompt(() =>
    notebookBackend.invoke<NotebookCellResponse[]>("notebook_run_from", {
      request,
    }),
  );
}

/** Reset the notebook runtime (destroy session and checkpoints). */
export async function resetNotebookRuntime(): Promise<void> {
  return notebookBackend.invoke<void>("notebook_reset_runtime");
}
