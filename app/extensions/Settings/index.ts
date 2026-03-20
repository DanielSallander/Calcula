//! FILENAME: app/extensions/Settings/index.ts
// PURPOSE: Settings extension - registers Activity Bar view with wrench icon
// CONTEXT: Bottom section of Activity Bar, provides user preferences panel

import React from "react";
import { registerActivityView, unregisterActivityView, toggleActivityView } from "../../src/api";
import { SettingsView } from "./SettingsView";

const cleanupFns: Array<() => void> = [];

/** SVG wrench/gear icon for the Activity Bar */
const SettingsIcon = React.createElement(
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
  // Gear/cog icon
  React.createElement("circle", { cx: 12, cy: 12, r: 3 }),
  React.createElement("path", {
    d: "M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.32 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z",
  }),
);

export function registerSettingsExtension(): void {
  registerActivityView({
    id: "settings",
    title: "Settings",
    icon: SettingsIcon,
    component: SettingsView,
    priority: 5,
    bottom: true,
  });
  cleanupFns.push(() => unregisterActivityView("settings"));

  // Keyboard shortcut: Ctrl+,
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey && !e.shiftKey && e.key === ",") {
      e.preventDefault();
      toggleActivityView("settings");
    }
  };
  window.addEventListener("keydown", handleKeyDown, true);
  cleanupFns.push(() => window.removeEventListener("keydown", handleKeyDown, true));

  console.log("[Settings] Extension registered");
}

export function unregisterSettingsExtension(): void {
  cleanupFns.forEach((fn) => fn());
  cleanupFns.length = 0;
  console.log("[Settings] Extension unregistered");
}
