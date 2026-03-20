//! FILENAME: app/extensions/Search/index.ts
// PURPOSE: Search extension - registers an Activity Bar view for search/replace
// CONTEXT: Panel-oriented search UI that shares state with FindReplaceDialog

import React from "react";
import { registerActivityView, unregisterActivityView, toggleActivityView } from "../../src/api";
import { SearchView } from "./SearchView";

const cleanupFns: Array<() => void> = [];

/** SVG magnifying glass icon for the Activity Bar */
const SearchIcon = React.createElement(
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
  React.createElement("circle", { cx: 11, cy: 11, r: 7 }),
  React.createElement("path", { d: "M21 21l-4.35-4.35" })
);

export function registerSearchExtension(): void {
  registerActivityView({
    id: "search",
    title: "Search",
    icon: SearchIcon,
    component: SearchView,
    priority: 90,
  });
  cleanupFns.push(() => unregisterActivityView("search"));

  // Keyboard shortcut: Ctrl+Shift+H
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey && e.shiftKey && e.key === "H") {
      e.preventDefault();
      toggleActivityView("search");
    }
  };
  window.addEventListener("keydown", handleKeyDown, true);
  cleanupFns.push(() => window.removeEventListener("keydown", handleKeyDown, true));

  console.log("[Search] Extension registered");
}

export function unregisterSearchExtension(): void {
  cleanupFns.forEach((fn) => fn());
  cleanupFns.length = 0;
  console.log("[Search] Extension unregistered");
}
