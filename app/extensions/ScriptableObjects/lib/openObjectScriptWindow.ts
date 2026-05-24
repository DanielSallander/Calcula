//! FILENAME: app/extensions/ScriptableObjects/lib/openObjectScriptWindow.ts
// PURPOSE: Creates and manages the Object Script Editor Tauri window.
// CONTEXT: Launches a separate OS window with the full Object Script Editor,
//          reuses it if already open.

import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emitOpenWithScript } from "./crossWindowEvents";

// ============================================================================
// State
// ============================================================================

const WINDOW_LABEL = "object-script-editor";

let editorWindow: WebviewWindow | null = null;

// ============================================================================
// Public API
// ============================================================================

/**
 * Open the Object Script Editor in a separate OS window.
 * If the window is already open, focuses it and navigates to the given script.
 *
 * @param scriptId - Optional script ID to open/navigate to
 */
export async function openObjectScriptEditor(scriptId?: string): Promise<void> {
  // If window already exists, focus it and transfer script selection
  if (editorWindow) {
    try {
      await editorWindow.setFocus();
      await emitOpenWithScript(scriptId);
      return;
    } catch {
      // Window was closed externally, clean up reference
      editorWindow = null;
    }
  }

  // Create new window
  editorWindow = new WebviewWindow(WINDOW_LABEL, {
    url: "/objectScript.html",
    title: "Calcula - Object Script Editor",
    width: 1060,
    height: 740,
    minWidth: 600,
    minHeight: 420,
    resizable: true,
    center: true,
  });

  // Send initial script ID once the window has created and React has mounted
  editorWindow.once("tauri://created", () => {
    setTimeout(async () => {
      await emitOpenWithScript(scriptId);
    }, 600);
  });

  editorWindow.once("tauri://error", (e) => {
    console.error("[ObjectScriptEditor] Failed to create editor window:", e);
    editorWindow = null;
  });

  // Clean up reference when window is destroyed
  editorWindow.once("tauri://destroyed", () => {
    editorWindow = null;
  });
}

/**
 * Check if the Object Script Editor window is currently open.
 */
export function isObjectScriptEditorOpen(): boolean {
  return editorWindow !== null;
}
