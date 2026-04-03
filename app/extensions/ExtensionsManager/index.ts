//! FILENAME: app/extensions/ExtensionsManager/index.ts
// PURPOSE: Extensions Manager extension - registers an Activity Bar view for managing extensions
// CONTEXT: Lists all loaded extensions with status badges

import React from "react";
import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { ExtensionsListView } from "./ExtensionsListView";

const cleanupFns: Array<() => void> = [];

/** SVG puzzle piece icon for the Activity Bar */
const ExtensionsIcon = React.createElement(
  "svg",
  {
    width: 24,
    height: 24,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  },
  React.createElement("path", {
    d: "M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z",
  })
);

function activate(context: ExtensionContext): void {
  context.ui.activityBar.register({
    id: "extensions",
    title: "Extensions",
    icon: ExtensionsIcon,
    component: ExtensionsListView,
    priority: 10,
    bottom: true,
  });
  cleanupFns.push(() => context.ui.activityBar.unregister("extensions"));

  // Keyboard shortcut: Ctrl+Shift+X
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey && e.shiftKey && e.key === "X") {
      e.preventDefault();
      context.ui.activityBar.toggle("extensions");
    }
  };
  window.addEventListener("keydown", handleKeyDown, true);
  cleanupFns.push(() => window.removeEventListener("keydown", handleKeyDown, true));

  console.log("[ExtensionsManager] Extension activated");
}

function deactivate(): void {
  cleanupFns.forEach((fn) => fn());
  cleanupFns.length = 0;
  console.log("[ExtensionsManager] Extension deactivated");
}

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.extensions-manager",
    name: "Extensions Manager",
    version: "1.0.0",
    description: "Activity Bar panel for managing loaded extensions",
  },
  activate,
  deactivate,
};

export default extension;
