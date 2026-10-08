//! FILENAME: app/extensions/CanvasSheet/components/canvasHooks.ts
// PURPOSE: The two hooks every Canvas-tab group reads: the canvas store and
//          Design Mode.
// CONTEXT: Every mounted copy of a group (band, launcher flyout, sidebar) reads
//          the same store, lib/canvasSheetStore.ts, through
//          useSyncExternalStore, so a layout changed by a script or an MCP
//          tool shows in every copy the moment its announcement is re-read.
//          Kept apart from the components so their files export components
//          only (React Fast Refresh).

import { useEffect, useState, useSyncExternalStore } from "react";
import { getDesignMode, onDesignModeChange } from "@api";
import { getCanvasSheetSnapshot, subscribeCanvasSheets, type CanvasSheetSnapshot } from "../lib/canvasSheetStore";

/** The canvas store, live. */
export function useCanvasSheet(): CanvasSheetSnapshot {
  return useSyncExternalStore(subscribeCanvasSheets, getCanvasSheetSnapshot, getCanvasSheetSnapshot);
}

/** Design mode (Core's session flag), live. */
export function useDesignMode(): boolean {
  const [on, setOn] = useState(getDesignMode());
  useEffect(() => onDesignModeChange(setOn), []);
  return on;
}
