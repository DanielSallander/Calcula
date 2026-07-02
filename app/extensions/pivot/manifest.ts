//! FILENAME: app/extensions/pivot/manifest.ts
// PURPOSE: Pivot table extension manifest and registration definitions.
// CONTEXT: Defines what the pivot extension contributes to the application.

import type {
  AddInManifest,
  TaskPaneViewDefinition,
  DialogDefinition,
  OverlayDefinition,
} from "@api";
import { emitAppEvent } from "@api";
import type { PanelDefinition } from "@api/uiTypes";
import { PivotEditorView } from "./components/PivotEditorView";
import {
  DesignNameSection,
  DesignGrandTotalsSection,
  DesignStylesSection,
  DesignReportLayoutSection,
  DesignDisplaySection,
} from "./components/PivotDesignSections";
import {
  AnalyzePivotTableSection,
  AnalyzeDataSection,
  AnalyzeActionsSection,
  AnalyzeCalculationsSection,
} from "./components/PivotAnalyzeSections";
import { CreatePivotDialog } from "./components/CreatePivotDialog";
import { GroupDialog } from "./components/GroupDialog";
import { FieldSettingsDialog } from "./components/FieldSettingsDialog";
import { PivotOptionsDialog } from "./components/PivotOptionsDialog";
import DrillThroughBehaviorDialog from "./components/DrillThroughBehaviorDialog";
import { FilterDropdown } from "./components/FilterDropdown";
import { PivotHeaderFilterDropdown } from "./components/PivotHeaderFilterDropdown";
import type { HeaderFieldSummary } from "./lib/pivot-api";
import type { DialogProps, OverlayProps } from "@api";
import React from "react";
import { PivotEvents } from "../_shared/lib/pivotEvents";

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

// Accent color for pivot contextual tabs (Excel-style green)
const PIVOT_TAB_COLOR = "#217346";

// "Pivot Table" analyze contextual panel - registered dynamically when a pivot
// is selected. One section per former ribbon group; collapsePriority mirrors
// the old collapseOrder values (lower demotes to a launcher first under width
// pressure). Sections are band-designed big-button/info widgets → "inline".
export const PIVOT_ANALYZE_TAB_ID = "pivot-analyze";
export const PivotAnalyzePanelDefinition: PanelDefinition = {
  id: PIVOT_ANALYZE_TAB_ID,
  title: "Pivot Table",
  icon: null,
  sections: [
    {
      id: "pivot-analyze.pivotTable",
      label: "PivotTable",
      icon: "📊",
      component: AnalyzePivotTableSection,
      ribbonPresentation: "inline",
      collapsePriority: 1,
    },
    {
      id: "pivot-analyze.data",
      label: "Data",
      icon: "↻",
      component: AnalyzeDataSection,
      ribbonPresentation: "inline",
      collapsePriority: 3,
    },
    {
      id: "pivot-analyze.actions",
      label: "Actions",
      icon: "⚡",
      component: AnalyzeActionsSection,
      ribbonPresentation: "inline",
      collapsePriority: 2,
    },
    {
      id: "pivot-analyze.calculations",
      label: "Calculations",
      icon: "fx",
      component: AnalyzeCalculationsSection,
      ribbonPresentation: "inline",
      collapsePriority: 4,
    },
  ],
  defaultPlacement: "ribbon",
  ribbonOrder: 499,
  ribbonColor: PIVOT_TAB_COLOR,
  priority: 1000 - 499,
};

// "Pivot Table Design" contextual panel - registered dynamically when a pivot
// is selected. The styles gallery was never width-collapsed in the old tab
// (it shrinks itself via its own ResizeObserver) → highest collapsePriority so
// it demotes last; the gallery widget is band-designed → "inline".
export const PIVOT_DESIGN_TAB_ID = "pivot-design";
export const PivotDesignPanelDefinition: PanelDefinition = {
  id: PIVOT_DESIGN_TAB_ID,
  title: "Pivot Table Design",
  icon: null,
  sections: [
    {
      id: "pivot-design.name",
      label: "PivotTable Name",
      icon: "⚙",
      component: DesignNameSection,
      collapsePriority: 1,
    },
    {
      id: "pivot-design.grandTotals",
      label: "Grand Totals",
      icon: "Σ",
      component: DesignGrandTotalsSection,
      collapsePriority: 2,
    },
    {
      id: "pivot-design.styles",
      label: "PivotTable Styles",
      component: DesignStylesSection,
      ribbonPresentation: "inline",
      collapsePriority: 100,
      flyoutWidth: 480,
    },
    {
      id: "pivot-design.reportLayout",
      label: "Report Layout",
      icon: "☰",
      component: DesignReportLayoutSection,
      collapsePriority: 3,
    },
    {
      id: "pivot-design.display",
      label: "Display",
      icon: "▣",
      component: DesignDisplaySection,
      collapsePriority: 4,
    },
  ],
  defaultPlacement: "ribbon",
  ribbonOrder: 500,
  ribbonColor: PIVOT_TAB_COLOR,
  priority: 1000 - 500,
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
    onCreated: (pivotId: string) => {
      // Emit pivot created event using the canonical event name
      emitAppEvent(PivotEvents.PIVOT_CREATED, { pivotId });
      props.onClose();
    },
    selection: props.data?.selection as
      | { startRow: number; startCol: number; endRow: number; endCol: number }
      | undefined,
    tableName: props.data?.tableName as string | undefined,
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

export const PIVOT_DRILL_BEHAVIOR_DIALOG_ID = "pivot:drillBehaviorDialog";

function DrillThroughBehaviorDialogWrapper(props: DialogProps): React.ReactElement {
  return React.createElement(DrillThroughBehaviorDialog, {
    isOpen: props.isOpen,
    onClose: props.onClose,
    data: props.data,
  });
}

export const DrillThroughBehaviorDialogDefinition: DialogDefinition = {
  id: PIVOT_DRILL_BEHAVIOR_DIALOG_ID,
  component: DrillThroughBehaviorDialogWrapper,
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
    pivotId: (data.pivotId as string) ?? "",
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
