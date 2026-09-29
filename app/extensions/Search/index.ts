//! FILENAME: app/extensions/Search/index.ts
// PURPOSE: Search extension - registers an Activity Bar view for search/replace
// CONTEXT: Panel-oriented search UI that shares state with FindReplaceDialog

import React from "react";
import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { SearchView } from "./SearchView";

const cleanupFns: Array<() => void> = [];

/**
 * Toggle the Search panel -- the command the keybinding registry's
 * `ext.search.findReplace` (Ctrl+Shift+H) runs. The registry named this id
 * long before anything registered it; the key worked only through a window
 * listener here, which a remap in Settings could not move (BUG-0183 class).
 */
export const SEARCH_OPEN_COMMAND = "search.openFindReplace";

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

function activate(context: ExtensionContext): void {
  context.ui.activityBar.register({
    id: "search",
    title: "Search",
    icon: SearchIcon,
    component: SearchView,
    priority: 90,
  });
  cleanupFns.push(() => context.ui.activityBar.unregister("search"));

  // The command the registry's Ctrl+Shift+H runs (the one keyboard path).
  context.commands.register(SEARCH_OPEN_COMMAND, () => context.ui.activityBar.toggle("search"));
  cleanupFns.push(() => context.commands.unregister(SEARCH_OPEN_COMMAND));

  console.log("[Search] Extension activated");
}

function deactivate(): void {
  cleanupFns.forEach((fn) => fn());
  cleanupFns.length = 0;
  console.log("[Search] Extension deactivated");
}

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.search",
    name: "Search",
    version: "1.0.0",
    description: "Search and replace panel in the Activity Bar",
  },
  activate,
  deactivate,
};

export default extension;
