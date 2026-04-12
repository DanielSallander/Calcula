//! FILENAME: app/extensions/ScriptEditor/lib/crossWindowEvents.ts
// PURPOSE: Cross-window event bridge for the Advanced Script Editor.
// CONTEXT: Uses Tauri events (not DOM CustomEvents) to communicate between
//          the main window and the separate Monaco editor window.

import { emitTauriEvent, listenTauriEvent } from "@api/backend";
import type { UnlistenFn } from "@api/backend";

// ============================================================================
// Event Names
// ============================================================================

export const ScriptEditorEvents = {
  /** Main -> Editor: transfer script source code when opening */
  OPEN_WITH_CODE: "script-editor:open-with-code",
  /** Editor -> Main: script modified cells, main window should refresh grid */
  GRID_NEEDS_REFRESH: "script-editor:grid-needs-refresh",
  /** Editor -> Main: editor window was closed */
  EDITOR_CLOSED: "script-editor:editor-closed",
  /** Editor -> Main: script produced bookmark mutations */
  BOOKMARK_MUTATIONS: "script-editor:bookmark-mutations",
} as const;

// ============================================================================
// Payloads
// ============================================================================

export interface OpenWithCodePayload {
  source: string;
}

export interface GridNeedsRefreshPayload {
  cellsModified: number;
}

// ============================================================================
// Emit Functions (type-safe wrappers)
// ============================================================================

export async function emitOpenWithCode(source: string): Promise<void> {
  await emitTauriEvent(ScriptEditorEvents.OPEN_WITH_CODE, { source } satisfies OpenWithCodePayload);
}

export async function emitGridNeedsRefresh(cellsModified: number): Promise<void> {
  await emitTauriEvent(ScriptEditorEvents.GRID_NEEDS_REFRESH, { cellsModified } satisfies GridNeedsRefreshPayload);
}

export async function emitBookmarkMutations(mutations: unknown[]): Promise<void> {
  await emitTauriEvent(ScriptEditorEvents.BOOKMARK_MUTATIONS, { mutations });
}

export async function emitEditorClosed(): Promise<void> {
  await emitTauriEvent(ScriptEditorEvents.EDITOR_CLOSED);
}

// ============================================================================
// Listen Functions (type-safe wrappers)
// ============================================================================

export function onOpenWithCode(
  callback: (payload: OpenWithCodePayload) => void,
): Promise<UnlistenFn> {
  return listenTauriEvent<OpenWithCodePayload>(ScriptEditorEvents.OPEN_WITH_CODE, callback);
}

export function onGridNeedsRefresh(
  callback: (payload: GridNeedsRefreshPayload) => void,
): Promise<UnlistenFn> {
  return listenTauriEvent<GridNeedsRefreshPayload>(ScriptEditorEvents.GRID_NEEDS_REFRESH, callback);
}

export function onBookmarkMutations(
  callback: (payload: { mutations: unknown[] }) => void,
): Promise<UnlistenFn> {
  return listenTauriEvent<{ mutations: unknown[] }>(ScriptEditorEvents.BOOKMARK_MUTATIONS, callback);
}

export function onEditorClosed(
  callback: () => void,
): Promise<UnlistenFn> {
  return listenTauriEvent(ScriptEditorEvents.EDITOR_CLOSED, callback);
}
