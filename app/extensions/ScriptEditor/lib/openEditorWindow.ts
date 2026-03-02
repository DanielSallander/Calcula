//! FILENAME: app/extensions/ScriptEditor/lib/openEditorWindow.ts
// PURPOSE: Creates and manages the Advanced Script Editor Tauri window.
// CONTEXT: Launches a second window with Monaco editor, reuses it if already open.

import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emitOpenWithCode } from "./crossWindowEvents";

// ============================================================================
// State
// ============================================================================

const WINDOW_LABEL = "script-editor";

let editorWindow: WebviewWindow | null = null;

// ============================================================================
// Public API
// ============================================================================

/**
 * Open the Advanced Script Editor in a separate window.
 * If the window is already open, focuses it and sends the new code.
 *
 * @param sourceCode - The script source to load in the editor
 */
export async function openAdvancedEditor(sourceCode: string): Promise<void> {
  // If window already exists, focus it and transfer code
  if (editorWindow) {
    try {
      await editorWindow.setFocus();
      if (sourceCode) {
        await emitOpenWithCode(sourceCode);
      }
      return;
    } catch {
      // Window was closed externally, clean up reference
      editorWindow = null;
    }
  }

  // Create new window
  editorWindow = new WebviewWindow(WINDOW_LABEL, {
    url: "/editor.html",
    title: "Calcula - Advanced Script Editor",
    width: 960,
    height: 720,
    minWidth: 600,
    minHeight: 400,
    resizable: true,
    center: true,
  });

  // Send code once the window has been created and React has mounted
  editorWindow.once("tauri://created", () => {
    // Delay to ensure the React app in the new window has mounted
    // and set up its Tauri event listener
    setTimeout(async () => {
      if (sourceCode) {
        await emitOpenWithCode(sourceCode);
      }
    }, 600);
  });

  editorWindow.once("tauri://error", (e) => {
    console.error("[ScriptEditor] Failed to create editor window:", e);
    editorWindow = null;
  });

  // Clean up reference when window is destroyed
  editorWindow.once("tauri://destroyed", () => {
    editorWindow = null;
  });
}

/**
 * Check if the Advanced Script Editor window is currently open.
 */
export function isEditorWindowOpen(): boolean {
  return editorWindow !== null;
}
