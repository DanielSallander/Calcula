//! FILENAME: app/extensions/FileExplorer/index.ts
// PURPOSE: File Explorer extension - registers an Activity Bar view for workbook structure
//          and a Task Pane for viewing virtual files on the right side
// CONTEXT: Shows sheets, tables, and named ranges in a tree view

import React from "react";
import {
  registerActivityView,
  unregisterActivityView,
  toggleActivityView,
  registerTaskPane,
  unregisterTaskPane,
} from "../../src/api";
import { FileExplorerView } from "./FileExplorerView";
import { FileViewerPane } from "./FileViewerPane";
import { FILE_VIEWER_PANE_ID } from "./constants";

const cleanupFns: Array<() => void> = [];

/** SVG folder icon for the Activity Bar */
const FolderIcon = React.createElement(
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
    d: "M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z",
  })
);

export function registerFileExplorerExtension(): void {
  // Activity Bar view (left side panel)
  registerActivityView({
    id: "explorer",
    title: "Explorer",
    icon: FolderIcon,
    component: FileExplorerView,
    priority: 100,
  });
  cleanupFns.push(() => unregisterActivityView("explorer"));

  // Task Pane view (right side panel) for full file viewing
  registerTaskPane({
    id: FILE_VIEWER_PANE_ID,
    title: "File Viewer",
    component: FileViewerPane,
    contextKeys: ["file-viewer"],
    priority: 5,
    closable: true,
  });
  cleanupFns.push(() => unregisterTaskPane(FILE_VIEWER_PANE_ID));

  // Keyboard shortcut: Ctrl+Shift+E
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey && e.shiftKey && e.key === "E") {
      e.preventDefault();
      toggleActivityView("explorer");
    }
  };
  window.addEventListener("keydown", handleKeyDown, true);
  cleanupFns.push(() => window.removeEventListener("keydown", handleKeyDown, true));

  console.log("[FileExplorer] Extension registered");
}

export function unregisterFileExplorerExtension(): void {
  cleanupFns.forEach((fn) => fn());
  cleanupFns.length = 0;
  console.log("[FileExplorer] Extension unregistered");
}
