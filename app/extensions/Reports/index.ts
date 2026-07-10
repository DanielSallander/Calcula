//! FILENAME: app/extensions/Reports/index.ts
// PURPOSE: Reports extension entry point. A report is a design-query (pivot-layout
//   DSL) materialized into a range of grid cells — "a report directly into the
//   grid," no pivot table. Create + manage reports from the Data menu; reports
//   with @Control filter params auto-refresh when a Controls-pane value changes.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import {
  registerDialog,
  unregisterDialog,
  showDialog,
  registerMenuItem,
  ExtensionRegistry,
  getSheets,
} from "@api";
import { onControlValueChange } from "@api/controlValues";
import { CreateReportDialog } from "./components/CreateReportDialog";
import { ManageReportsDialog } from "./components/ManageReportsDialog";
import { reportsBackend } from "./lib/reportsBackend";
import { clearReportModelCache, refreshControlBoundReports } from "./lib/reportRefresh";
import { registerReportDistribution } from "./lib/reportDistribution";

const CREATE_DIALOG_ID = "create-report-dialog";
const MANAGE_DIALOG_ID = "manage-reports-dialog";

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
  registerMenuItem("data", {
    id: "data:manageReports",
    label: "Manage Reports...",
    action: () => showDialog(MANAGE_DIALOG_ID, {}),
  });

  // Auto-refresh reports bound (via @Name) to the controls / ribbon filters that
  // actually changed. Skip transient (mid-drag) previews; debounce bursts and
  // accumulate the changed names across the debounce window.
  let refreshTimer: number | undefined;
  let changedNames = new Set<string>();
  const unsubControls = onControlValueChange((detail) => {
    if (detail.transient) return;
    changedNames.add(detail.name);
    if (refreshTimer) window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      const names = changedNames;
      changedNames = new Set();
      void refreshControlBoundReports(names);
    }, 150);
  });
  cleanupFns.push(() => {
    if (refreshTimer) window.clearTimeout(refreshTimer);
    unsubControls();
  });

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
