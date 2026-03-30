//! FILENAME: app/extensions/GoToSpecial/index.ts
// PURPOSE: Go To Special extension entry point.
// CONTEXT: Registers the dialog for selecting cells by type.

import {
  DialogExtensions,
} from "../../src/api";
import { GoToSpecialDialog } from "./components/GoToSpecialDialog";

const cleanupFns: (() => void)[] = [];

export function registerGoToSpecialExtension(): void {
  console.log("[GoToSpecial] Registering...");

  DialogExtensions.registerDialog({
    id: "go-to-special",
    component: GoToSpecialDialog,
    priority: 100,
  });
  cleanupFns.push(() => DialogExtensions.unregisterDialog("go-to-special"));

  console.log("[GoToSpecial] Registered successfully.");
}

export function unregisterGoToSpecialExtension(): void {
  console.log("[GoToSpecial] Unregistering...");
  for (const fn of cleanupFns) {
    try { fn(); } catch (err) { console.error("[GoToSpecial] Cleanup error:", err); }
  }
  cleanupFns.length = 0;
}
