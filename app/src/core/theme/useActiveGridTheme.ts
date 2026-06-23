//! FILENAME: app/src/core/theme/useActiveGridTheme.ts
// PURPOSE: React hook exposing the active skin's merged GridTheme to the Canvas.
// CONTEXT: Core/pure. Subscribes to skinLoader; returns a stable GridTheme
//          reference that only changes when the active skin changes — so the
//          GridCanvas draw dep-array trips exactly once per skin switch.

import { useSyncExternalStore } from "react";
import { subscribe, getActiveGridTheme } from "./skinLoader";

/** Returns the active skin's merged GridTheme, re-rendering on skin change. */
export function useActiveGridTheme() {
  return useSyncExternalStore(subscribe, getActiveGridTheme, getActiveGridTheme);
}
