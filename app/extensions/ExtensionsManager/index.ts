//! FILENAME: app/extensions/ExtensionsManager/index.ts
// PURPOSE: Extensions Manager extension - registers an Activity Bar view for managing extensions
// CONTEXT: Lists all loaded extensions with status badges

import React from "react";
import { registerActivityView, unregisterActivityView, toggleActivityView } from "../../src/api";
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

export function registerExtensionsManagerExtension(): void {
  registerActivityView({
    id: "extensions",
    title: "Extensions",
    icon: ExtensionsIcon,
    component: ExtensionsListView,
    priority: 10,
    bottom: true,
  });
  cleanupFns.push(() => unregisterActivityView("extensions"));

  // Keyboard shortcut: Ctrl+Shift+X
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey && e.shiftKey && e.key === "X") {
      e.preventDefault();
      toggleActivityView("extensions");
    }
  };
  window.addEventListener("keydown", handleKeyDown, true);
  cleanupFns.push(() => window.removeEventListener("keydown", handleKeyDown, true));

  console.log("[ExtensionsManager] Extension registered");
}

export function unregisterExtensionsManagerExtension(): void {
  cleanupFns.forEach((fn) => fn());
  cleanupFns.length = 0;
  console.log("[ExtensionsManager] Extension unregistered");
}
