// FILENAME: app/extensions/ModelEditor/lib/useRememberWindowGeometry.ts
// PURPOSE: Capture the editor window's size and position as the user changes
//          them, so the next open lands where they left it.
// CONTEXT: Runs INSIDE the model-editor window; the restore half lives in
//          openModelEditorWindow.ts, which runs in the main window. They share
//          localStorage because Tauri windows of one app share an origin.
//
//          Uses only the resize/move EVENT PAYLOADS, never the window getters,
//          so it needs nothing beyond `core:event:allow-listen` — already in
//          capabilities/model-editor.json. Capability files are baked at build
//          time, so a permission this needed would mean a rebuild.

import { useEffect } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { toLogical, writeGeometry } from "./windowGeometry";
import type { WindowGeometry } from "./windowGeometry";

/** Resize fires per animation frame while dragging an edge; persist on a
 *  trailing edge so one drag is one write, not four hundred. */
const SETTLE_MS = 400;

export function useRememberWindowGeometry(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    // Size and position arrive on SEPARATE events, so neither is a complete
    // geometry on its own. Accumulate, and only write once both are known —
    // otherwise a move before any resize would persist a zero size.
    const pending: Partial<WindowGeometry> = {};

    const schedule = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const { width, height, x, y } = pending;
        if (width === undefined || height === undefined || x === undefined || y === undefined) {
          return;
        }
        writeGeometry({ width, height, x, y });
      }, SETTLE_MS);
    };

    const appWindow = getCurrentWebviewWindow();
    const unlisteners: Array<() => void> = [];

    // The payloads are PHYSICAL pixels; the constructor that restores them
    // takes LOGICAL. devicePixelRatio is the scale factor and needs no
    // permission. Read it per event, because a window dragged to a monitor
    // with different scaling changes it mid-session.
    void appWindow
      .onResized(({ payload }) => {
        const scale = window.devicePixelRatio;
        pending.width = toLogical(payload.width, scale);
        pending.height = toLogical(payload.height, scale);
        schedule();
      })
      .then((un) => {
        if (disposed) un();
        else unlisteners.push(un);
      })
      .catch(() => {});

    void appWindow
      .onMoved(({ payload }) => {
        const scale = window.devicePixelRatio;
        pending.x = toLogical(payload.x, scale);
        pending.y = toLogical(payload.y, scale);
        schedule();
      })
      .then((un) => {
        if (disposed) un();
        else unlisteners.push(un);
      })
      .catch(() => {});

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      for (const un of unlisteners) un();
    };
  }, []);
}
