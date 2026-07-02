// FILENAME: app/extensions/ModelEditor/manifest.ts
// PURPOSE: Model Editor extension manifest + UI ids/definitions.

import type { DialogDefinition, DialogProps } from "@api";
import React from "react";
import { MeasureEditorDialog } from "./components/MeasureEditorDialog";

export const MODEL_EDITOR_EXTENSION_ID = "calcula.model-editor";
export const MODEL_EDITOR_PANEL_ID = "modelEditor:panel";
export const MEASURE_EDITOR_DIALOG_ID = "modelEditor:measureEditorDialog";

export const MeasureEditorDialogDefinition: DialogDefinition = {
  id: MEASURE_EDITOR_DIALOG_ID,
  component: MeasureEditorDialog as React.ComponentType<DialogProps>,
  priority: 100,
};
