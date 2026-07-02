// FILENAME: app/extensions/ModelEditor/index.ts
// PURPOSE: In-app BI Model Editor — a VBA-style STANDALONE WINDOW hosting the
//          model authoring UI (measures, tables/columns, calculated columns,
//          relationships, hierarchies, KPIs, security roles, calculation
//          groups, schema import, blank models). Edits land on the live
//          shared engine, persist with the workbook, and distribute via
//          "Publish Model as Package".

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { IconDataModel, emitAppEvent, recalcWithCube } from "@api";
import { openModelEditorWindow } from "./lib/openModelEditorWindow";
import { onModelChanged } from "./lib/crossWindowEvents";

let isActivated = false;
const cleanupFns: (() => void)[] = [];

function activate(context: ExtensionContext): void {
  if (isActivated) return;

  // Entry point next to the other model surfaces in External Data.
  context.ui.menus.registerItem("externalData", {
    id: "externalData:modelEditor",
    label: "Model Editor...",
    icon: IconDataModel,
    action: () => void openModelEditorWindow(),
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
