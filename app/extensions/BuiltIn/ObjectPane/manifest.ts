//! FILENAME: app/extensions/BuiltIn/ObjectPane/manifest.ts
// PURPOSE: The object pane's task-pane view definition and the extension's
//          manifest.

import React from "react";
import type { ExtensionManifest } from "@api/contract";
import type { TaskPaneViewDefinition } from "@api/uiTypes";
import { RibbonIcon } from "@api/ribbonIcons";
import { OBJECT_PANE_ID, OBJECT_PANE_TITLE } from "@api/objectPane";
import { ObjectPaneView } from "./components/ObjectPaneView";

export const ObjectPaneManifest: ExtensionManifest = {
  id: "calcula.object-pane",
  name: "Object Pane",
  version: "1.0.0",
  description:
    "ONE side pane for the selected floating object: its family's build tabs (a pivot's Fields and Design, a chart's " +
    "Data, a slicer's Settings, a control's Properties) and the shared Power BI-style Format tab (Properties, Title, " +
    "Effects, Data format), every field bindable to a formula. Opens at a click on a canvas object and through Ctrl+1, " +
    "Format... and View > Show",
};

/**
 * THE object pane. No `onUpdate`: the Shell runs a view's own onUpdate only,
 * and this view has nothing to announce. Shown under the "object" context key
 * (a floating object with a pane is selected), so View > Show lists it.
 */
export const ObjectPanePaneDefinition: TaskPaneViewDefinition = {
  id: OBJECT_PANE_ID,
  title: OBJECT_PANE_TITLE,
  icon: React.createElement(RibbonIcon.Panel, { size: 16 }),
  component: ObjectPaneView,
  contextKeys: ["object"],
  priority: 50,
  closable: true,
};
