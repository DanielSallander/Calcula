// FILENAME: app/extensions/ModelEditor/index.ts
// PURPOSE: In-app BI Model Editor (ME-1: measures) — the first slice of
//          bringing Calcula Studio's model authoring inside Calcula. Edits a
//          connection's embedded model in place; edits persist with the
//          workbook and ship via "Publish Model as Package".

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { IconDataModel } from "@api";
import { MeasuresSection } from "./components/MeasuresSection";
import {
  MODEL_EDITOR_PANEL_ID,
  MEASURE_EDITOR_DIALOG_ID,
  MeasureEditorDialogDefinition,
} from "./manifest";

let isActivated = false;
const cleanupFns: (() => void)[] = [];

function activate(context: ExtensionContext): void {
  if (isActivated) return;

  // Model Editor panel (sections API): measures list + lineage per connection.
  context.ui.panels.register({
    id: MODEL_EDITOR_PANEL_ID,
    title: "Model Editor",
    icon: IconDataModel,
    sections: [
      {
        id: `${MODEL_EDITOR_PANEL_ID}.measures`,
        label: "Measures",
        component: MeasuresSection,
      },
    ],
    defaultPlacement: "sidebar",
    priority: 36,
  });
  cleanupFns.push(() => context.ui.panels.unregister(MODEL_EDITOR_PANEL_ID));

  context.ui.dialogs.register(MeasureEditorDialogDefinition);
  cleanupFns.push(() => context.ui.dialogs.unregister(MEASURE_EDITOR_DIALOG_ID));

  // Entry point next to the other model surfaces in External Data. (The menu
  // registry has no unregister — matching the sibling extensions here.)
  context.ui.menus.registerItem("externalData", {
    id: "externalData:modelEditor",
    label: "Edit Model...",
    icon: IconDataModel,
    action: () => context.ui.panels.open(MODEL_EDITOR_PANEL_ID),
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
      "Edit a BI connection's data model in place — measures first (add, edit, delete, validate, lineage).",
  },
  activate,
  deactivate,
};

export default extension;
