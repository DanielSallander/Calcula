//! FILENAME: app/extensions/ControlsPane/lib/controlsPaneApi.ts
// PURPOSE: Tauri command wrappers for pane control backend operations.
// CONTEXT: Pane controls reuse the extension's capability-scoped backend
//          channel (bound once in activate(), see filterPaneBackend.ts).
//          Commands mirror app/src-tauri/src/pane_control/commands.rs.

import { filterPaneBackend } from "./filterPaneBackend";
import type {
  PaneControl,
  CreatePaneControlParams,
  UpdatePaneControlParams,
  ControlValue,
} from "./controlsPaneTypes";

export async function createPaneControl(
  params: CreatePaneControlParams,
): Promise<PaneControl> {
  return filterPaneBackend.invoke<PaneControl>("create_pane_control", { params });
}

export async function deletePaneControl(controlId: string): Promise<void> {
  return filterPaneBackend.invoke<void>("delete_pane_control", { controlId });
}

export async function updatePaneControl(
  controlId: string,
  params: UpdatePaneControlParams,
): Promise<PaneControl> {
  return filterPaneBackend.invoke<PaneControl>("update_pane_control", {
    controlId,
    params,
  });
}

export async function setPaneControlValue(
  controlId: string,
  value: ControlValue,
): Promise<void> {
  return filterPaneBackend.invoke<void>("set_pane_control_value", {
    controlId,
    value,
  });
}

export async function getAllPaneControls(): Promise<PaneControl[]> {
  return filterPaneBackend.invoke<PaneControl[]>("get_all_pane_controls");
}

export async function getPaneControl(controlId: string): Promise<PaneControl> {
  return filterPaneBackend.invoke<PaneControl>("get_pane_control", { controlId });
}
