//! FILENAME: app/extensions/Reports/index.ts
// PURPOSE: Reports extension entry point. A report is a design-query (pivot-layout
//   DSL) materialized into a range of grid cells — "a report directly into the
//   grid," no pivot table. Slice 1: create a report from the Data menu.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import {
  registerDialog,
  unregisterDialog,
  showDialog,
  registerMenuItem,
  ExtensionRegistry,
  getSheets,
} from "@api";
import { CreateReportDialog } from "./components/CreateReportDialog";
import { reportsBackend } from "./lib/reportsBackend";

const DIALOG_ID = "create-report-dialog";

const cleanupFns: (() => void)[] = [];

interface Selection {
  startRow: number;
  startCol: number;
}
let currentSelection: Selection | null = null;

async function openCreateReportDialog(): Promise<void> {
  // Default the destination to the active cell / selection top-left.
  let anchorRow = 0;
  let anchorCol = 0;
  if (currentSelection) {
    anchorRow = Math.max(0, currentSelection.startRow);
    anchorCol = Math.max(0, currentSelection.startCol);
  }
  let sheetIndex = 0;
  try {
    const sheets = await getSheets();
    sheetIndex = sheets.activeIndex ?? 0;
  } catch {
    /* default sheet 0 */
  }
  showDialog(DIALOG_ID, { sheetIndex, anchorRow, anchorCol });
}

function activate(context: ExtensionContext): void {
  // Bind the capability-scoped backend door (A3).
  reportsBackend.set(context.invokeBackend);

  registerDialog({
    id: DIALOG_ID,
    component: CreateReportDialog,
    priority: 50,
  });
  cleanupFns.push(() => unregisterDialog(DIALOG_ID));

  const unsub = ExtensionRegistry.onSelectionChange((sel) => {
    currentSelection = sel
      ? { startRow: Math.min(sel.startRow, sel.endRow), startCol: Math.min(sel.startCol, sel.endCol) }
      : null;
  });
  cleanupFns.push(unsub);

  registerMenuItem("data", {
    id: "data:createReport",
    label: "Report from Design Query...",
    action: () => openCreateReportDialog(),
  });
}

function deactivate(): void {
  for (const fn of cleanupFns) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
  cleanupFns.length = 0;
  currentSelection = null;
}

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.reports",
    name: "Reports",
    version: "1.0.0",
    description: "Materialize a design-query (pivot-layout DSL) directly into the grid as a report.",
  },
  activate,
  deactivate,
};
export default extension;
