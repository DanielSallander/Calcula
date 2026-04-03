//! FILENAME: app/extensions/FileExplorer/index.ts
// PURPOSE: File Explorer extension - registers an Activity Bar view for workbook structure
//          and a Task Pane for viewing virtual files on the right side
// CONTEXT: Shows sheets, tables, and named ranges in a tree view

import React from "react";
import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { cellEvents, AppEvents } from "@api";
import {
  recalculateFormulas,
  listenForEvent,
} from "@api/backend";
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

function activate(context: ExtensionContext): void {
  // Activity Bar view (left side panel)
  context.ui.activityBar.register({
    id: "explorer",
    title: "Explorer",
    icon: FolderIcon,
    component: FileExplorerView,
    priority: 100,
  });
  cleanupFns.push(() => context.ui.activityBar.unregister("explorer"));

  // Task Pane view (right side panel) for full file viewing
  context.ui.taskPanes.register({
    id: FILE_VIEWER_PANE_ID,
    title: "File Viewer",
    component: FileViewerPane,
    contextKeys: ["file-viewer"],
    priority: 5,
    closable: true,
  });
  cleanupFns.push(() => context.ui.taskPanes.unregister(FILE_VIEWER_PANE_ID));

  // Keyboard shortcut: Ctrl+Shift+E
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey && e.shiftKey && e.key === "E") {
      e.preventDefault();
      context.ui.activityBar.toggle("explorer");
    }
  };
  window.addEventListener("keydown", handleKeyDown, true);
  cleanupFns.push(() => window.removeEventListener("keydown", handleKeyDown, true));

  // Listen for virtual file changes and recalculate formulas using FILEREAD/FILELINES/FILEEXISTS
  listenForEvent("virtual-file-changed", () => {
    recalculateFormulas()
      .then((cells) => {
        for (const cell of cells) {
          if (cell.sheetIndex != null) continue;
          cellEvents.emit({
            row: cell.row,
            col: cell.col,
            newValue: cell.display,
            formula: cell.formula ?? null,
          });
        }
        context.events.emit(AppEvents.GRID_REFRESH);
      })
      .catch((err) => {
        console.warn("[FileExplorer] Recalc after file change failed:", err);
      });
  }).then((unlisten) => {
    cleanupFns.push(unlisten);
  });

  console.log("[FileExplorer] Extension activated");
}

function deactivate(): void {
  cleanupFns.forEach((fn) => fn());
  cleanupFns.length = 0;
  console.log("[FileExplorer] Extension deactivated");
}

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.file-explorer",
    name: "File Explorer",
    version: "1.0.0",
    description: "Workbook structure browser and virtual file viewer",
  },
  activate,
  deactivate,
};

export default extension;
