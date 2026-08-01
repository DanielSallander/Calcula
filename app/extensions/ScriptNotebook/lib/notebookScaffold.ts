//! FILENAME: app/extensions/ScriptNotebook/lib/notebookScaffold.ts
// PURPOSE: The "scaffold a notebook" door — how another surface (today the
//          Model Editor's "Test in notebook") hands the notebook a set of cells
//          to drop in, across windows.
// CONTEXT: The Model Editor is a SEPARATE Tauri window, so a DOM CustomEvent
//          (the channel MACRO_TO_NOTEBOOK_EVENT uses) cannot reach the notebook.
//          This uses the sanctioned cross-window door — emitTauriEvent /
//          listenTauriEvent from @api/backend — with the event name and payload
//          shape defined here and mirrored in
//          ModelEditor/lib/notebookBridge.ts. (Design doc Phase 3 calls for an
//          @api `requestNotebookScaffold` wrapper; app/src/api is outside this
//          change's ownership, so the contract lives in these two leaf modules
//          for now — see the CROSS-FILE REQUESTS note in the design doc.)
//
// SECURITY: the payload only ever becomes CELL SOURCE — text sitting in an
//           editor. Nothing here executes it; cells run when the user runs them,
//           and a model.* call inside one still faces the notebook's own
//           per-capability consent gate. Sandboxed scripts cannot reach this
//           channel: the broker exposes `api.emitEvent` / `ext.emitEvent`, which
//           emit DOM app events auto-namespaced to `userscript:*`
//           (host.ts scriptEmitEventName) — there is no allowlisted method that
//           emits a raw Tauri event. The payload is still re-validated below,
//           because it arrives as untyped IPC.

import type { NotebookCellKind } from "./cellKind";
import { withMarkdownMarker } from "./cellKind";

/** Cross-window event: "please drop these cells into a notebook". */
export const NOTEBOOK_SCAFFOLD_EVENT = "calcula:notebook-scaffold";

/** One cell of a scaffold request. */
export interface ScaffoldCell {
  kind: NotebookCellKind;
  /** For `markdown`, the prose body WITHOUT the marker line. */
  source: string;
}

/** A request to append cells to a notebook. */
export interface NotebookScaffoldRequest {
  /** Notebook to create when none is open (a name, not an id). */
  notebookName: string;
  /** A short label for the toast / log — e.g. `Measure "Revenue"`. */
  title: string;
  cells: ScaffoldCell[];
}

/** Hard caps: a scaffold is an editor convenience, not a data channel. */
const MAX_CELLS = 12;
const MAX_CELL_CHARS = 20_000;

/**
 * Validate an untyped cross-window payload into a scaffold request.
 * Returns null when the payload is not a well-formed request.
 */
export function normalizeScaffoldRequest(raw: unknown): NotebookScaffoldRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<NotebookScaffoldRequest>;
  if (!Array.isArray(r.cells) || r.cells.length === 0) return null;

  const cells: ScaffoldCell[] = [];
  for (const c of r.cells.slice(0, MAX_CELLS)) {
    if (!c || typeof c !== "object") continue;
    const kind: NotebookCellKind = (c as ScaffoldCell).kind === "markdown" ? "markdown" : "code";
    const source = (c as ScaffoldCell).source;
    if (typeof source !== "string") continue;
    cells.push({ kind, source: source.slice(0, MAX_CELL_CHARS) });
  }
  if (cells.length === 0) return null;

  const notebookName =
    typeof r.notebookName === "string" && r.notebookName.trim() !== ""
      ? r.notebookName.trim().slice(0, 120)
      : "Model analysis";
  const title =
    typeof r.title === "string" && r.title.trim() !== "" ? r.title.trim().slice(0, 200) : "Scaffold";

  return { notebookName, title, cells };
}

/** Render a scaffold cell to the source a notebook cell actually stores. */
export function scaffoldCellSource(cell: ScaffoldCell): string {
  return cell.kind === "markdown" ? withMarkdownMarker(cell.source) : cell.source;
}
