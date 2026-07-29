// FILENAME: app/extensions/Distribution/lib/openPackageInspectorWindow.ts
// PURPOSE: Creates and manages the Package Inspector Tauri window (standalone
//          read-only .calp browser). Follows the hardened ModelEditor opener:
//          re-attaches to an existing window after a main-webview reload
//          (getByLabel), coalesces concurrent opens, and never lets the
//          created-fallback suppress the real ready handshake.

import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  emitOpenPackage,
  onInspectorReady,
  type InspectorOpenPayload,
} from "./inspectorWindowEvents";

const WINDOW_LABEL = "package-inspector";

let inspectorWindow: WebviewWindow | null = null;
let opening: Promise<void> | null = null;

/**
 * Open the Package Inspector in its own window. If already open (including a
 * window that survived a main-webview reload), focus it and — when given —
 * point it at the requested package.
 */
export function openPackageInspectorWindow(
  payload: InspectorOpenPayload | null = null,
): Promise<void> {
  // Coalesce: a second click while the window is being created joins the
  // first open instead of racing it into a duplicate-label error.
  opening ??= doOpen(payload).finally(() => {
    opening = null;
  });
  return opening;
}

async function doOpen(payload: InspectorOpenPayload | null): Promise<void> {
  // Re-attach to a window that outlived our module state (e.g. the main
  // webview reloaded while the inspector stayed open).
  if (!inspectorWindow) {
    const existing = await WebviewWindow.getByLabel(WINDOW_LABEL);
    if (existing) {
      inspectorWindow = existing;
      existing.once("tauri://destroyed", () => {
        inspectorWindow = null;
      });
    }
  }

  if (inspectorWindow) {
    try {
      await inspectorWindow.setFocus();
      if (payload) {
        // The window may still be MOUNTING (opened moments ago, listeners not
        // registered yet) — Tauri events are not queued for future listeners,
        // so an immediate emit alone can silently drop the payload. Register a
        // one-shot ready listener that resends THIS payload, then also emit
        // immediately: an already-mounted window gets the emit (and the ready
        // listener simply never fires again); a mounting window gets the
        // handover on ready. The inspector-side handler is idempotent.
        armReadyResend(inspectorWindow, payload);
        await emitOpenPackage(payload);
      }
      return;
    } catch {
      // Window was closed externally; recreate below.
      inspectorWindow = null;
    }
  }

  inspectorWindow = new WebviewWindow(WINDOW_LABEL, {
    url: "/packageInspector.html",
    title: "Calcula - Package Inspector",
    width: 1150,
    height: 780,
    minWidth: 760,
    minHeight: 520,
    resizable: true,
    center: true,
  });

  // The INSPECTOR_READY signal is authoritative (the inspector's listeners
  // are registered by then) and ALWAYS sends; the created-event fallback only
  // fires when no ready signal arrived — a slow mount must not have its
  // handover suppressed by an earlier listener-less fallback send. The
  // inspector-side handler is idempotent, so a rare double-send is harmless.
  let fallbackNeeded = true;
  armReadyResend(inspectorWindow, payload, () => {
    fallbackNeeded = false;
  });
  inspectorWindow.once("tauri://created", () => {
    setTimeout(() => {
      if (fallbackNeeded) void emitOpenPackage(payload);
    }, 3000);
  });

  inspectorWindow.once("tauri://error", (e) => {
    console.error("[PackageInspector] Failed to create window:", e);
    inspectorWindow = null;
  });
  inspectorWindow.once("tauri://destroyed", () => {
    inspectorWindow = null;
  });
}

/**
 * Send `payload` when the inspector next signals ready, exactly once. The
 * listener's lifetime is tied to the WINDOW, not a wall-clock timer: it
 * self-unlistens after its first fire and is torn down when the window is
 * destroyed — a listener that outlives its open would resend a STALE payload
 * into the next window's ready signal (open A, close, reopen B → A loads too).
 */
function armReadyResend(
  win: WebviewWindow,
  payload: InspectorOpenPayload | null,
  onFired?: () => void,
): void {
  let unlistenReady: (() => void) | null = null;
  let fired = false;
  void onInspectorReady(() => {
    if (fired) return;
    fired = true;
    onFired?.();
    void emitOpenPackage(payload);
    unlistenReady?.();
  }).then((unlisten) => {
    unlistenReady = unlisten;
    if (fired) unlisten();
  });
  void win.once("tauri://destroyed", () => {
    unlistenReady?.();
  });
}
