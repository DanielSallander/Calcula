// FILENAME: app/extensions/ModelEditor/lib/openModelEditorWindow.ts
// PURPOSE: Creates and manages the Model Editor Tauri window (VBA-style
//          standalone editor). Follows Charts/lib/openSpecEditorWindow.ts,
//          hardened per review: re-attaches to an existing window after a
//          main-webview reload (getByLabel), coalesces concurrent opens, and
//          never lets the created-fallback suppress the real ready handshake.

import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emitOpenWithConnection, onEditorReady } from "./crossWindowEvents";

const WINDOW_LABEL = "model-editor";

let editorWindow: WebviewWindow | null = null;
let opening: Promise<void> | null = null;

/**
 * Open the Model Editor in its own window. If already open (including a
 * window that survived a main-webview reload), focus it and — when given —
 * switch it to the requested connection.
 */
export function openModelEditorWindow(connectionId?: string | null): Promise<void> {
  // Coalesce: a second click while the window is being created joins the
  // first open instead of racing it into a duplicate-label error.
  opening ??= doOpen(connectionId ?? null).finally(() => {
    opening = null;
  });
  return opening;
}

async function doOpen(connectionId: string | null): Promise<void> {
  // Re-attach to a window that outlived our module state (e.g. the main
  // webview reloaded while the editor stayed open).
  if (!editorWindow) {
    const existing = await WebviewWindow.getByLabel(WINDOW_LABEL);
    if (existing) {
      editorWindow = existing;
      existing.once("tauri://destroyed", () => {
        editorWindow = null;
      });
    }
  }

  if (editorWindow) {
    try {
      await editorWindow.setFocus();
      await emitOpenWithConnection(connectionId);
      return;
    } catch {
      // Window was closed externally; recreate below.
      editorWindow = null;
    }
  }

  editorWindow = new WebviewWindow(WINDOW_LABEL, {
    url: "/modelEditor.html",
    title: "Calcula - Model Editor",
    width: 1150,
    height: 780,
    minWidth: 760,
    minHeight: 520,
    resizable: true,
    center: true,
  });

  // The EDITOR_READY signal is authoritative (the editor's listeners are
  // registered by then) and ALWAYS sends; the created-event fallback only
  // fires when no ready signal arrived — a slow mount must not have its
  // handover suppressed by an earlier listener-less fallback send. The
  // editor-side handler is idempotent, so a rare double-send is harmless.
  let fallbackNeeded = true;
  const send = () => emitOpenWithConnection(connectionId);
  onEditorReady(() => {
    fallbackNeeded = false;
    void send();
  }).then((unlisten) => {
    setTimeout(unlisten, 15_000);
  });
  editorWindow.once("tauri://created", () => {
    setTimeout(() => {
      if (fallbackNeeded) void send();
    }, 3000);
  });

  editorWindow.once("tauri://error", (e) => {
    console.error("[ModelEditor] Failed to create window:", e);
    editorWindow = null;
  });
  editorWindow.once("tauri://destroyed", () => {
    editorWindow = null;
  });
}

/** Whether the Model Editor window is currently open. */
export function isModelEditorWindowOpen(): boolean {
  return editorWindow !== null;
}
