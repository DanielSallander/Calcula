//! FILENAME: app/extensions/Charts/lib/openSpecEditorWindow.ts
// PURPOSE: Creates and manages the Chart Spec Editor Tauri window.
// CONTEXT: Launches a separate window for editing ChartSpec JSON with a live preview.
//          Follows the same pattern as ScriptEditor/lib/openEditorWindow.ts.

import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { ChartSpec, ParsedChartData } from "../types";
import { emitOpenWithSpec } from "./crossWindowEvents";

// ============================================================================
// State
// ============================================================================

const WINDOW_LABEL = "chart-spec-editor";

let specEditorWindow: WebviewWindow | null = null;

// ============================================================================
// Public API
// ============================================================================

/**
 * Open the Chart Spec Editor in a separate window.
 * If the window is already open, focuses it and sends the updated spec.
 */
export async function openSpecEditorWindow(
  spec: ChartSpec,
  previewData: ParsedChartData | null,
): Promise<void> {
  // If window already exists, focus it and transfer spec
  if (specEditorWindow) {
    try {
      await specEditorWindow.setFocus();
      await emitOpenWithSpec(spec, previewData);
      return;
    } catch {
      // Window was closed externally, clean up reference
      specEditorWindow = null;
    }
  }

  // Create new window
  specEditorWindow = new WebviewWindow(WINDOW_LABEL, {
    url: "/chartSpecEditor.html",
    title: "Calcula - Chart Spec Editor",
    width: 1100,
    height: 750,
    minWidth: 700,
    minHeight: 500,
    resizable: true,
    center: true,
  });

  // Send spec once the window has been created and React has mounted
  specEditorWindow.once("tauri://created", () => {
    setTimeout(async () => {
      await emitOpenWithSpec(spec, previewData);
    }, 600);
  });

  specEditorWindow.once("tauri://error", (e) => {
    console.error("[ChartSpecEditor] Failed to create window:", e);
    specEditorWindow = null;
  });

  specEditorWindow.once("tauri://destroyed", () => {
    specEditorWindow = null;
  });
}

/**
 * Check if the Chart Spec Editor window is currently open.
 */
export function isSpecEditorWindowOpen(): boolean {
  return specEditorWindow !== null;
}

/**
 * Close the Chart Spec Editor window if open.
 */
export async function closeSpecEditorWindow(): Promise<void> {
  if (specEditorWindow) {
    try {
      await specEditorWindow.close();
    } catch {
      // Already closed
    }
    specEditorWindow = null;
  }
}
