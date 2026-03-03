//! FILENAME: app/extensions/BuiltIn/ZoomSlider/index.ts
// PURPOSE: Zoom Slider extension module entry point.
// CONTEXT: Registers a status bar widget that provides an Excel-style zoom slider
//          with +/- buttons, a draggable slider, and a clickable percentage that
//          opens a preset zoom menu.

import type { ExtensionModule } from "../../../src/api/contract";
import { registerStatusBarItem, unregisterStatusBarItem } from "../../../src/api/ui";
import { ZoomSliderWidget } from "./ZoomSliderWidget";

const STATUS_BAR_ITEM_ID = "calcula.statusbar.zoom";

let isActivated = false;

function activate(): void {
  if (isActivated) {
    console.warn("[ZoomSlider] Already activated, skipping.");
    return;
  }

  console.log("[ZoomSlider] Activating...");

  registerStatusBarItem({
    id: STATUS_BAR_ITEM_ID,
    component: ZoomSliderWidget,
    alignment: "right",
    priority: 10, // Lower priority = rendered later (rightmost)
  });

  isActivated = true;
  console.log("[ZoomSlider] Activated successfully.");
}

function deactivate(): void {
  if (!isActivated) return;

  console.log("[ZoomSlider] Deactivating...");
  unregisterStatusBarItem(STATUS_BAR_ITEM_ID);
  isActivated = false;
  console.log("[ZoomSlider] Deactivated.");
}

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.builtin.zoom-slider",
    name: "Zoom Slider",
    version: "1.0.0",
    description: "Provides an Excel-style zoom slider control in the status bar with preset zoom levels and custom zoom input.",
  },
  activate,
  deactivate,
};

export default extension;
