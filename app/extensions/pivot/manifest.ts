//! FILENAME: app/extensions/pivot/manifest.ts
// PURPOSE: Pivot table extension manifest and registration definitions.
// CONTEXT: Defines what the pivot extension contributes to the application.

import type {
  AddInManifest,
  TaskPaneViewDefinition,
  DialogDefinition,
  OverlayDefinition,
} from "../../src/api";
import { emitAppEvent } from "../../src/api";
import { PivotEditorView } from "./components/PivotEditorView";
import { PivotDesignTab } from "./components/PivotDesignTab";
import { CreatePivotDialog } from "./components/CreatePivotDialog";
import { GroupDialog } from "./components/GroupDialog";
import { FieldSettingsDialog } from "./components/FieldSettingsDialog";
import { PivotOptionsDialog } from "./components/PivotOptionsDialog";
import { FilterDropdown } from "./components/FilterDropdown";
import { PivotHeaderFilterDropdown } from "./components/PivotHeaderFilterDropdown";
import type { HeaderFieldSummary } from "./lib/pivot-api";
import type { DialogProps, OverlayProps } from "../../src/api";
import React from "react";
import { PivotEvents } from "./lib/pivotEvents";

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

// Design ribbon tab - registered dynamically when pivot is selected
export const PIVOT_DESIGN_TAB_ID = "pivot-design";
export const PivotDesignTabDefinition = {
  id: PIVOT_DESIGN_TAB_ID,
  label: "Design",
  order: 500,
  component: PivotDesignTab,
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
      // Emit pivot created event using the canonical event name
      emitAppEvent(PivotEvents.PIVOT_CREATED, { pivotId });
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
// Group Dialog Registration
// ============================================================================

export const PIVOT_GROUP_DIALOG_ID = "pivot:groupDialog";

function GroupDialogWrapper(props: DialogProps): React.ReactElement {
  return React.createElement(GroupDialog, {
    isOpen: props.isOpen,
    onClose: props.onClose,
    data: props.data,
  });
}

export const PivotGroupDialogDefinition: DialogDefinition = {
  id: PIVOT_GROUP_DIALOG_ID,
  component: GroupDialogWrapper,
  priority: 100,
};

// ============================================================================
// Field Settings Dialog Registration
// ============================================================================

export const PIVOT_FIELD_SETTINGS_DIALOG_ID = "pivot:fieldSettingsDialog";

function FieldSettingsDialogWrapper(props: DialogProps): React.ReactElement {
  return React.createElement(FieldSettingsDialog, {
    isOpen: props.isOpen,
    onClose: props.onClose,
    data: props.data,
  });
}

export const PivotFieldSettingsDialogDefinition: DialogDefinition = {
  id: PIVOT_FIELD_SETTINGS_DIALOG_ID,
  component: FieldSettingsDialogWrapper,
  priority: 100,
};

// ============================================================================
// PivotTable Options Dialog Registration
// ============================================================================

export const PIVOT_OPTIONS_DIALOG_ID = "pivot:pivotOptionsDialog";

function PivotOptionsDialogWrapper(props: DialogProps): React.ReactElement {
  return React.createElement(PivotOptionsDialog, {
    isOpen: props.isOpen,
    onClose: props.onClose,
    data: props.data,
  });
}

export const PivotOptionsDialogDefinition: DialogDefinition = {
  id: PIVOT_OPTIONS_DIALOG_ID,
  component: PivotOptionsDialogWrapper,
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

// ============================================================================
// Header Filter Overlay (Row Labels / Column Labels dropdown)
// ============================================================================

export const PIVOT_HEADER_FILTER_OVERLAY_ID = "pivot:headerFilterDropdown";

function HeaderFilterDropdownWrapper(props: OverlayProps): React.ReactElement {
  const data = props.data ?? {};
  const onApply = () => {
    // Close the overlay and refresh the grid
    props.onClose();
    window.dispatchEvent(new CustomEvent("pivot:refresh"));
  };
  return React.createElement(PivotHeaderFilterDropdown, {
    zone: (data.zone as 'row' | 'column') ?? 'row',
    fields: (data.fields as HeaderFieldSummary[]) ?? [],
    pivotId: (data.pivotId as number) ?? 0,
    anchorRect: props.anchorRect ?? { x: 0, y: 0, width: 260, height: 0 },
    onClose: props.onClose,
    onApply,
  });
}

export const PivotHeaderFilterOverlayDefinition: OverlayDefinition = {
  id: PIVOT_HEADER_FILTER_OVERLAY_ID,
  component: HeaderFilterDropdownWrapper,
  layer: "dropdown",
};
