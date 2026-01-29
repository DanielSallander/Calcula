//! FILENAME: app/extensions/pivot/manifest.ts
// PURPOSE: Pivot table extension manifest and registration definitions.
// CONTEXT: Defines what the pivot extension contributes to the application.

import type {
  AddInManifest,
  TaskPaneViewDefinition,
  DialogDefinition,
  OverlayDefinition,
} from "../../src/api";
import { PivotEditorView } from "./components/PivotEditorView";
import { CreatePivotDialog } from "./components/CreatePivotDialog";
import { FilterDropdown } from "./components/FilterDropdown";
import type { DialogProps, OverlayProps } from "../../src/api";
import React from "react";

// ============================================================================
// Extension Manifest
// ============================================================================

export const PIVOT_EXTENSION_ID = "calcula.pivot";

export const PivotManifest: AddInManifest = {
  id: PIVOT_EXTENSION_ID,
  name: "Pivot Tables",
  version: "1.0.0",
  description: "PivotTable functionality for Calcula",
  ribbonTabs: [],
  ribbonGroups: [],
  commands: [],
};

// ============================================================================
// Task Pane Registration
// ============================================================================

export const PIVOT_PANE_ID = "pivot-editor";

export const PivotPaneDefinition: TaskPaneViewDefinition = {
  id: PIVOT_PANE_ID,
  title: "PivotTable Fields",
  icon: "[P]",
  component: PivotEditorView,
  contextKeys: ["pivot"],
  priority: 100,
  closable: true,
};

// ============================================================================
// Dialog Registration
// ============================================================================

export const PIVOT_DIALOG_ID = "pivot:createDialog";

// Wrapper component to adapt CreatePivotDialog to DialogProps interface
function CreatePivotDialogWrapper(props: DialogProps): React.ReactElement {
  return React.createElement(CreatePivotDialog, {
    isOpen: props.isOpen,
    onClose: props.onClose,
    onCreated: (pivotId: number) => {
      // Emit pivot:created event
      window.dispatchEvent(
        new CustomEvent("pivot:created", { detail: { pivotId } })
      );
      props.onClose();
    },
    selection: props.data?.selection as
      | { startRow: number; startCol: number; endRow: number; endCol: number }
      | undefined,
  });
}

export const PivotDialogDefinition: DialogDefinition = {
  id: PIVOT_DIALOG_ID,
  component: CreatePivotDialogWrapper,
  priority: 100,
};

// ============================================================================
// Overlay Registration
// ============================================================================

export const PIVOT_FILTER_OVERLAY_ID = "pivot:filterDropdown";

// Wrapper component to adapt FilterDropdown to OverlayProps interface
function FilterDropdownWrapper(props: OverlayProps): React.ReactElement {
  const data = props.data ?? {};
  return React.createElement(FilterDropdown, {
    fieldName: (data.fieldName as string) ?? "",
    fieldIndex: (data.fieldIndex as number) ?? 0,
    uniqueValues: (data.uniqueValues as string[]) ?? [],
    selectedValues: (data.selectedValues as string[]) ?? [],
    anchorRect: props.anchorRect ?? { x: 0, y: 0, width: 150, height: 24 },
    onApply: (data.onApply as (
      fieldIndex: number,
      selectedValues: string[],
      hiddenItems: string[]
    ) => Promise<void>) ?? (async () => {}),
    onClose: props.onClose,
  });
}

export const PivotFilterOverlayDefinition: OverlayDefinition = {
  id: PIVOT_FILTER_OVERLAY_ID,
  component: FilterDropdownWrapper,
  layer: "dropdown",
};
