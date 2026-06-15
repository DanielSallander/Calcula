//! FILENAME: app/src/api/notebookBackend.ts
// PURPOSE: Stable @api wrappers for the notebook Tauri commands needed to
//          inventory a workbook's code. Notebook listing previously lived only
//          inside the ScriptNotebook extension's lib (notebookApi.ts), which an
//          OTHER extension (the Code-in-This-File inspector) cannot reach
//          without violating the facade rule. Promoting the read path here
//          gives any extension a sanctioned way to enumerate notebooks.
// CONTEXT: Read-only subset (list + load). Full notebook CRUD/execution stays
//          in the ScriptNotebook extension, which owns the notebook surface.

import { invoke } from "@tauri-apps/api/core";

/** One executed/saved cell of a notebook (the rust-quickjs surface). */
export interface NotebookCellData {
  id: string;
  source: string;
  lastOutput: string[];
  lastError: string | null;
  cellsModified: number;
  durationMs: number;
  executionIndex: number | null;
}

/** A notebook document: ordered cells executed in an isolated QuickJS over a
 *  clone of grid state. `sourcePackage` is the .calp it was distributed from
 *  (absent/undefined for local, subscriber-authored notebooks). */
export interface NotebookDocumentData {
  id: string;
  name: string;
  cells: NotebookCellData[];
  sourcePackage?: string;
}

/** Lightweight notebook listing row. */
export interface NotebookSummaryData {
  id: string;
  name: string;
  cellCount: number;
}

/** List all notebooks in the open workbook (lightweight summaries). */
export async function listNotebooks(): Promise<NotebookSummaryData[]> {
  return invoke<NotebookSummaryData[]>("notebook_list");
}

/** Load a notebook by id, including every cell's source. */
export async function loadNotebook(id: string): Promise<NotebookDocumentData> {
  return invoke<NotebookDocumentData>("notebook_load", { id });
}
