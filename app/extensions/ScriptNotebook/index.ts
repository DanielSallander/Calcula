//! FILENAME: app/extensions/ScriptNotebook/index.ts
// PURPOSE: Script Notebook extension entry point.
// CONTEXT: Registers the activity sidebar view and Developer menu item.
//          Notebooks provide Jupyter-style multi-cell scripting with shared
//          variables and snapshot-based rewind.

import React from "react";
import {
  registerActivityView,
  unregisterActivityView,
  toggleActivityView,
  registerMenuItem,
} from "../../src/api";
import { NotebookPanel } from "./components/NotebookPanel";

// ============================================================================
// Constants
// ============================================================================

const VIEW_ID = "script-notebook";

// ============================================================================
// Icon
// ============================================================================

// Notebook icon (book with cells)
const NotebookIcon = React.createElement(
  "svg",
  {
    width: 24,
    height: 24,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  },
  // Book outline
  React.createElement("rect", {
    x: 4,
    y: 2,
    width: 16,
    height: 20,
    rx: 2,
  }),
  // Spine
  React.createElement("line", { x1: 8, y1: 2, x2: 8, y2: 22 }),
  // Cell dividers
  React.createElement("line", { x1: 8, y1: 8, x2: 20, y2: 8 }),
  React.createElement("line", { x1: 8, y1: 14, x2: 20, y2: 14 }),
  // Play triangle in first cell
  React.createElement("path", { d: "M12 4.5l3 1.5-3 1.5V4.5", fill: "currentColor", stroke: "none" }),
);

// ============================================================================
// Cleanup tracking
// ============================================================================

const cleanupFns: (() => void)[] = [];

// ============================================================================
// Registration
// ============================================================================

export function registerScriptNotebookExtension(): void {
  console.log("[ScriptNotebook] Registering...");

  // 1. Register activity sidebar view
  registerActivityView({
    id: VIEW_ID,
    title: "Notebook",
    icon: NotebookIcon,
    component: NotebookPanel,
    priority: 45,
  });
  cleanupFns.push(() => unregisterActivityView(VIEW_ID));

  // 2. Register Developer menu item
  registerMenuItem("developer", {
    id: "developer:notebook",
    label: "Notebook",
    action: () => {
      toggleActivityView(VIEW_ID);
    },
  });

  // 3. Keyboard shortcut: Ctrl+Shift+N to toggle notebook
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey && e.shiftKey && e.key === "N") {
      e.preventDefault();
      toggleActivityView(VIEW_ID);
    }
  };
  window.addEventListener("keydown", handleKeyDown, true);
  cleanupFns.push(() =>
    window.removeEventListener("keydown", handleKeyDown, true),
  );

  console.log("[ScriptNotebook] Registered successfully.");
}

// ============================================================================
// Unregistration
// ============================================================================

export function unregisterScriptNotebookExtension(): void {
  console.log("[ScriptNotebook] Unregistering...");

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[ScriptNotebook] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  console.log("[ScriptNotebook] Unregistered.");
}
