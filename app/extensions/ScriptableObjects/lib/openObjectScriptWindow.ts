//! FILENAME: app/extensions/ScriptableObjects/lib/openObjectScriptWindow.ts
// PURPOSE: Creates and manages the Object Script Editor Tauri window.
// CONTEXT: Launches a separate OS window with the full Object Script Editor,
//          reuses it if already open.

import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  emitEditorClosed,
  emitOpenWithScript,
  emitOpenWithDraft,
  emitOpenWithModuleMacro,
  onEditorReady,
} from "./crossWindowEvents";
import type { ScriptDraft } from "./crossWindowEvents";
import { editorUrlForDocument } from "./editorTarget";
import { getWorkbookScript } from "@api/workbookScripts";

// ============================================================================
// State
// ============================================================================

const WINDOW_LABEL = "object-script-editor";

let editorWindow: WebviewWindow | null = null;

// ============================================================================
// Public API
// ============================================================================

/**
 * Focus the editor window (creating it if needed) and then hand it whatever it
 * should open. `deliver` runs once the window is guaranteed to be listening.
 *
 * `documentId` is the identity of the document being opened. It is stamped into
 * a NEW window's URL so the editor knows what to select before any event, timer
 * or backend listing lands — see `editorTarget.ts`.
 */
async function withEditorWindow(
  documentId: string | null,
  deliver: () => Promise<void>,
): Promise<void> {
  // If window already exists, focus it and transfer the selection
  if (editorWindow) {
    try {
      await editorWindow.setFocus();
      await deliver();
      return;
    } catch {
      // Window was closed externally, clean up reference
      editorWindow = null;
    }
  }

  // Two triggers can deliver: the editor announcing its listeners are live (the
  // deterministic path), and a timer (so a window that never emits READY — an
  // old build, a failed listen — still gets its payload rather than opening
  // blank).
  //
  // READY IS DEFINITIVE; the timer is not. A timer firing before the editor has
  // registered its listeners delivers into a void and the payload is simply
  // LOST — which is how a slow-booting editor ended up showing whatever sorted
  // first instead of the macro that was double-clicked. So a timer delivery does
  // not close the channel: if READY arrives afterwards, the payload is sent
  // again. Re-delivery is safe by the editor's own contract — opening a document
  // that is already open SELECTS it and keeps its unsaved edits.
  let deliveredBy: "ready" | "timer" | null = null;
  let unlistenReady: (() => void) | null = null;
  const deliverVia = (via: "ready" | "timer"): void => {
    if (deliveredBy === "ready") return;
    if (deliveredBy === via) return;
    deliveredBy = via;
    if (via === "ready" && unlistenReady) {
      unlistenReady();
      unlistenReady = null;
    }
    void deliver();
  };

  // Register the READY listener BEFORE creating the window, so the signal cannot
  // race ahead of us. A cold editor whose React tree mounts well after any fixed
  // timer used to LOSE the open event and show an empty editor; waiting for its
  // own "ready" removes the guesswork.
  void onEditorReady(() => deliverVia("ready")).then((fn) => {
    if (deliveredBy === "ready") fn();
    else unlistenReady = fn;
  });

  // Create new window
  editorWindow = new WebviewWindow(WINDOW_LABEL, {
    url: editorUrlForDocument(documentId),
    title: "Calcula - Object Script Editor",
    width: 1060,
    height: 740,
    minWidth: 600,
    minHeight: 420,
    resizable: true,
    center: true,
  });

  // Fallback only: a generous window for the editor to boot and announce itself.
  editorWindow.once("tauri://created", () => {
    setTimeout(() => deliverVia("timer"), 4000);
  });

  editorWindow.once("tauri://error", (e) => {
    console.error("[ObjectScriptEditor] Failed to create editor window:", e);
    editorWindow = null;
    if (unlistenReady) {
      unlistenReady();
      unlistenReady = null;
    }
  });

  // Clean up when the window is destroyed.
  //
  // THE ANNOUNCEMENT IS MADE HERE, BY THE WINDOW THAT SURVIVES. The editor also
  // emits it from its own `beforeunload`, and in WebView2 under Tauri that
  // handler DOES NOT RUN when the window is closed — measured, not assumed: an
  // e2e probe listening for the announcement (and for a marker emitted from the
  // handler itself) saw neither after a close. So a debug session left open in
  // the editor kept its transient mount alive forever: an unlocked `workbook`
  // realm, in the main window, with no UI left that knew it existed. The main
  // window's own `tauri://destroyed` is the signal that cannot be lost with the
  // webview, because it is delivered to a window that is still running.
  editorWindow.once("tauri://destroyed", () => {
    editorWindow = null;
    if (unlistenReady) {
      unlistenReady();
      unlistenReady = null;
    }
    void emitEditorClosed().catch(() => {
      /* nothing left to tell; the listeners release on teardown as a backstop */
    });
  });
}

/**
 * Open the Object Script Editor in a separate OS window.
 * If the window is already open, focuses it and navigates to the given script.
 *
 * @param scriptId - Optional script ID to open/navigate to
 */
export async function openObjectScriptEditor(scriptId?: string): Promise<void> {
  await withEditorWindow(scriptId ?? null, () => emitOpenWithScript(scriptId));
}

/**
 * Open the Object Script Editor on an AI-authored DRAFT for review.
 *
 * The draft is handed over as data. Nothing on this path saves, registers or
 * mounts it: it becomes a real script only when the human presses Save in the
 * editor, which runs the ordinary compile gate + `save_object_script` path.
 */
export async function openObjectScriptEditorWithDraft(draft: ScriptDraft): Promise<void> {
  // A draft has no stored identity to stamp: it exists only in the payload.
  await withEditorWindow(null, () => emitOpenWithDraft(draft));
}

/**
 * Open the Object Script Editor on a recorded MACRO (a module script).
 *
 * This is the implementation behind the `@api/scriptEditorService`
 * `ScriptEditorProvider.openMacroInEditor` contract — the seam the Macro
 * Recorder reaches through so it never imports this window's internals. The
 * macro's authoritative record is read here (so a deleted macro fails loudly,
 * before a window is even focused) and delivered on its own cross-window channel;
 * the editor re-reads it too and edits it under the module `save_script` store,
 * NOT the object-script store.
 */
export async function openMacroInEditor(macroId: string): Promise<void> {
  // Read the authoritative record up front. A macro deleted out from under the
  // caller must throw here — a caller (a menu action) turns that into a message,
  // never a window that opens on nothing.
  const macro = await getWorkbookScript(macroId);
  await withEditorWindow(macro.id, () =>
    emitOpenWithModuleMacro({
      macroId: macro.id,
      name: macro.name,
      source: macro.source,
      description: macro.description ?? null,
    }),
  );
}

/**
 * Check if the Object Script Editor window is currently open.
 */
export function isObjectScriptEditorOpen(): boolean {
  return editorWindow !== null;
}
