//! FILENAME: app/extensions/ScriptNotebook/lib/cellKind.ts
// PURPOSE: Cell KIND (code | markdown) for notebook cells — the Phase 2
//          "literate notebook" primitive.
// CONTEXT: The kind is carried IN THE CELL SOURCE as a first-line marker
//          (`//!markdown`) rather than as a new persisted field. That choice is
//          deliberate:
//            * the .cala / .calp notebook record (Rust NotebookCell ->
//              SavedNotebookCell -> NotebookCellDef) keeps ONE shape, so no
//              format version, no three-layer mirror, no migration;
//            * the marker is a JS line comment, so the file stays honest — a
//              reader who never heard of markdown cells sees a commented cell
//              that does nothing;
//            * "what kind is this cell" stays derivable from the bytes that are
//              actually persisted, instead of from a sidecar field that a
//              round-trip through an older writer could silently drop.
//          The RUNNER agrees server-side: notebook_commands.rs::is_markdown_source
//          applies the same rule, so a text cell can never be handed to QuickJS
//          even if a frontend forgot to filter it.

import type { NotebookCell } from "../types";

/** The kind of a notebook cell. */
export type NotebookCellKind = "code" | "markdown";

/** The canonical first line that marks a cell as prose. */
export const MARKDOWN_MARKER = "//!markdown";

/** Matches the marker line: optional indent, `//!`, optional space, `markdown`. */
const MARKER_RE = /^[ \t]*\/\/![ \t]*markdown[ \t]*$/i;

/** The kind of a cell, derived from its source. */
export function cellKindOf(source: string): NotebookCellKind {
  if (typeof source !== "string") return "code";
  const firstLine = source.split("\n", 1)[0] ?? "";
  return MARKER_RE.test(firstLine.replace(/\r$/, "")) ? "markdown" : "code";
}

/** True when this cell holds prose rather than executable JavaScript. */
export function isMarkdownCell(cell: Pick<NotebookCell, "source">): boolean {
  return cellKindOf(cell.source) === "markdown";
}

/** The prose body of a markdown cell (everything after the marker line).
 *  Returns the whole source for a code cell. */
export function markdownBodyOf(source: string): string {
  if (cellKindOf(source) !== "markdown") return source;
  const nl = source.indexOf("\n");
  return nl === -1 ? "" : source.slice(nl + 1);
}

/** Re-attach the marker to an edited prose body. */
export function withMarkdownMarker(body: string): string {
  return `${MARKDOWN_MARKER}\n${body}`;
}

/** The starting source for a newly added cell of the given kind. */
export function emptySourceForKind(kind: NotebookCellKind): string {
  return kind === "markdown" ? withMarkdownMarker("") : "";
}
