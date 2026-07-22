// FILENAME: app/extensions/ModelEditor/index.ts
// PURPOSE: In-app BI Model Editor — a VBA-style STANDALONE WINDOW hosting the
//          model authoring UI (measures, tables/columns, calculated columns,
//          relationships, hierarchies, KPIs, security roles, calculation
//          groups, schema import, blank models). Edits land on the live
//          shared engine, persist with the workbook, and distribute via
//          "Publish Model as Package".

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import {
  IconDataModel,
  IconImport,
  IconExport,
  emitAppEvent,
  recalcWithCube,
  biGetConnections,
  biModelExportToFile,
  biModelImportFromFile,
  showToast,
} from "@api";
import { openModelEditorWindow } from "./lib/openModelEditorWindow";
import { onModelChanged } from "./lib/crossWindowEvents";
import { ExportModelDialog } from "./components/ExportModelDialog";

const EXPORT_MODEL_DIALOG_ID = "modelEditor:exportModelDialog";

let isActivated = false;
const cleanupFns: (() => void)[] = [];

// Same import flow as the editor window's Import... button, but run from the
// main window: no cross-window bridge needed, so notify this window's model
// surfaces (CUBE cells, Connections pane, pivot editors) directly.
async function importModelFromMenu(): Promise<void> {
  try {
    const conn = await biModelImportFromFile();
    if (!conn) return; // user cancelled the file dialog
    emitAppEvent("bi:model-changed", { connectionId: conn.id });
    void recalcWithCube();
    showToast(`Model "${conn.name}" imported`, { type: "success" });
  } catch (err) {
    showToast(`Import failed: ${err}`, { type: "error" });
  }
}

// One connection exports directly (the native save dialog is confirmation
// enough); several open the chooser dialog.
async function exportModelFromMenu(context: ExtensionContext): Promise<void> {
  try {
    const conns = await biGetConnections();
    if (conns.length === 0) {
      showToast("This workbook has no model connections to export.", { type: "info" });
      return;
    }
    if (conns.length === 1) {
      const path = await biModelExportToFile(conns[0].id, conns[0].name);
      if (path) showToast(`Model "${conns[0].name}" exported to ${path}`, { type: "success" });
      return;
    }
    context.ui.dialogs.show(EXPORT_MODEL_DIALOG_ID);
  } catch (err) {
    showToast(`Export failed: ${err}`, { type: "error" });
  }
}

function activate(context: ExtensionContext): void {
  if (isActivated) return;

  // Entry point at the top of the consolidated Model menu.
  context.ui.menus.registerItem("model", {
    id: "model:modelEditor",
    label: "Model Editor...",
    icon: IconDataModel,
    order: 10,
    action: () => void openModelEditorWindow(),
  });

  // Whole-model file I/O — the same commands the Model Editor window offers
  // in its toolbar, surfaced here for quick access (they exist in BOTH places).
  context.ui.dialogs.register({
    id: EXPORT_MODEL_DIALOG_ID,
    component: ExportModelDialog,
    priority: 100,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister(EXPORT_MODEL_DIALOG_ID));

  context.ui.menus.registerItem("model", {
    id: "model:importModel",
    label: "Import Model...",
    icon: IconImport,
    order: 12,
    action: () => void importModelFromMenu(),
  });
  context.ui.menus.registerItem("model", {
    id: "model:exportModel",
    label: "Export Model...",
    icon: IconExport,
    order: 13,
    action: () => void exportModelFromMenu(context),
  });

  // Bridge: edits made in the editor window must reach THIS window's
  // surfaces — CUBE cells re-evaluate and the model-aware panes refresh.
  let unlistenModelChanged: (() => void) | null = null;
  void onModelChanged(({ connectionId }) => {
    emitAppEvent("bi:model-changed", { connectionId });
    void recalcWithCube();
  }).then((off) => {
    unlistenModelChanged = off;
  });
  cleanupFns.push(() => {
    unlistenModelChanged?.();
    unlistenModelChanged = null;
  });

  isActivated = true;
}

function deactivate(): void {
  if (!isActivated) return;
  for (const fn of cleanupFns.splice(0)) {
    fn();
  }
  isActivated = false;
}

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.model-editor",
    name: "Model Editor",
    version: "1.0.0",
    description:
      "Author BI data models in a standalone editor window — measures, tables, relationships, hierarchies, KPIs, roles, calculation groups, and schema import.",
  },
  activate,
  deactivate,
};

export default extension;
