//! FILENAME: app/extensions/Reports/index.ts
// PURPOSE: Reports extension entry point. A report is a design-query (pivot-layout
//   DSL) materialized into a range of grid cells — "a report directly into the
//   grid," no pivot table. Create + manage reports from the Data menu, edit them
//   from the right-click menu / contextual Report ribbon tab; reports with
//   @Control filter params auto-refresh when a bound control / ribbon filter
//   changes.

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
import { ManageReportsDialog } from "./components/ManageReportsDialog";
import { EditReportDialog } from "./components/EditReportDialog";
import { CREATE_DIALOG_ID, EDIT_DIALOG_ID, MANAGE_DIALOG_ID } from "./dialogIds";
import { reportsBackend } from "./lib/reportsBackend";
import { clearReportModelCache } from "./lib/reportRefresh";
import { registerReportQueryProvider } from "./lib/reportQueryProvider";
import { registerReportDistribution } from "./lib/reportDistribution";
import { registerReportContextMenu } from "./lib/reportContextMenu";
import {
  refreshReportRegions,
  refreshReportRegionsDebounced,
  resetReportRegions,
  setReportRegionsChangedCallback,
} from "./lib/reportRegions";
import {
  handleReportSelectionChange,
  reevaluateActiveReport,
  resetReportSelectionHandler,
} from "./lib/reportSelectionHandler";

const cleanupFns: (() => void)[] = [];

interface Selection {
  startRow: number;
  startCol: number;
}
let currentSelection: Selection | null = null;

async function openCreateReportDialog(): Promise<void> {
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
  showDialog(CREATE_DIALOG_ID, { sheetIndex, anchorRow, anchorCol });
}

function activate(context: ExtensionContext): void {
  // Bind the capability-scoped backend door (A3).
  reportsBackend.set(context.invokeBackend);

  registerDialog({ id: CREATE_DIALOG_ID, component: CreateReportDialog, priority: 50 });
  cleanupFns.push(() => unregisterDialog(CREATE_DIALOG_ID));
  registerDialog({ id: MANAGE_DIALOG_ID, component: ManageReportsDialog, priority: 50 });
  cleanupFns.push(() => unregisterDialog(MANAGE_DIALOG_ID));
  registerDialog({ id: EDIT_DIALOG_ID, component: EditReportDialog, priority: 50 });
  cleanupFns.push(() => unregisterDialog(EDIT_DIALOG_ID));

  // Selection tracking: create-dialog anchor + the contextual Report tab.
  const unsub = ExtensionRegistry.onSelectionChange((sel) => {
    currentSelection = sel
      ? { startRow: Math.min(sel.startRow, sel.endRow), startCol: Math.min(sel.startCol, sel.endCol) }
      : null;
    handleReportSelectionChange(
      sel ? { startRow: sel.startRow, startCol: sel.startCol } : null,
    );
  });
  cleanupFns.push(unsub);

  registerMenuItem("data", {
    id: "data:createReport",
    label: "Report from Design Query...",
    action: () => openCreateReportDialog(),
  });
  registerMenuItem("data", {
    id: "data:manageReports",
    label: "Manage Reports...",
    action: () => showDialog(MANAGE_DIALOG_ID, {}),
  });

  // Region cache for sync hit-testing (context menu, Report tab): initial load,
  // re-check the tab after every cache refresh, refresh on sheet switches and —
  // debounced — on the raw grid:refresh that fires after cell-data changes
  // (covers undo/redo of report operations).
  setReportRegionsChangedCallback(reevaluateActiveReport);
  void refreshReportRegions();
  const onSheetActivated = () => void refreshReportRegions();
  const onGridRefresh = () => refreshReportRegionsDebounced();
  window.addEventListener("sheet:activated", onSheetActivated);
  window.addEventListener("grid:refresh", onGridRefresh);
  cleanupFns.push(() => {
    window.removeEventListener("sheet:activated", onSheetActivated);
    window.removeEventListener("grid:refresh", onGridRefresh);
    resetReportRegions();
    resetReportSelectionHandler();
  });

  // Right-click menu on report regions (Edit Query / Refresh / Delete / Manage).
  cleanupFns.push(registerReportContextMenu());

  // Auto-refresh on control / ribbon-filter changes: the SHARED query-object
  // refresh service owns the subscription, debounce, targeting and coalescing —
  // this extension only contributes its provider.
  cleanupFns.push(registerReportQueryProvider());

  // The per-connection BI model cache must not outlive the model: drop it when a
  // connection or its data changes. Window-event names from the BI extension —
  // listened to by string (same cross-extension pattern as Charts' "pivot:refresh").
  const onBiChanged = () => clearReportModelCache();
  const BI_EVENTS = [
    "app:bi-refreshed",
    "app:bi-connection-created",
    "app:bi-connection-updated",
    "app:bi-connection-deleted",
  ];
  for (const ev of BI_EVENTS) window.addEventListener(ev, onBiChanged);
  cleanupFns.push(() => {
    for (const ev of BI_EVENTS) window.removeEventListener(ev, onBiChanged);
  });

  // Publish/subscribe reports in .calp packages via the distributable-object channel.
  cleanupFns.push(registerReportDistribution());
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
