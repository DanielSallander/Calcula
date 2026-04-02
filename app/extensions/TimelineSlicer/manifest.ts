//! FILENAME: app/extensions/TimelineSlicer/manifest.ts
// PURPOSE: Timeline slicer extension manifest and registration definitions.

import type {
  AddInManifest,
  DialogDefinition,
  DialogProps,
} from "../../src/api";
import React from "react";
import { InsertTimelineDialog } from "./components/InsertTimelineDialog";
import { TimelineSlicerSettingsDialog } from "./components/TimelineSlicerSettingsDialog";
import { TimelineSlicerOptionsTab } from "./components/TimelineSlicerOptionsTab";

// ============================================================================
// Extension Manifest
// ============================================================================

export const TIMELINE_SLICER_EXTENSION_ID = "calcula.timelineSlicer";

export const TimelineSlicerManifest: AddInManifest = {
  id: TIMELINE_SLICER_EXTENSION_ID,
  name: "Timeline Slicers",
  version: "1.0.0",
  description: "Date-specific visual filter controls for PivotTables",
  ribbonTabs: [],
  ribbonGroups: [],
  commands: [],
};

// ============================================================================
// Contextual Ribbon Tab
// ============================================================================

const TIMELINE_TAB_COLOR = "#4472C4"; // Blue accent

export const TIMELINE_OPTIONS_TAB_ID = "timeline-slicer-options";
export const TimelineOptionsTabDefinition = {
  id: TIMELINE_OPTIONS_TAB_ID,
  label: "Timeline",
  order: 500,
  component: TimelineSlicerOptionsTab,
  color: TIMELINE_TAB_COLOR,
};

// ============================================================================
// Dialog Registration
// ============================================================================

export const INSERT_TIMELINE_DIALOG_ID = "timelineSlicer:insertDialog";
export const TIMELINE_SETTINGS_DIALOG_ID = "timelineSlicer:settingsDialog";

export const InsertTimelineDialogDefinition: DialogDefinition = {
  id: INSERT_TIMELINE_DIALOG_ID,
  component: InsertTimelineDialog as React.ComponentType<DialogProps>,
  priority: 100,
};

export const TimelineSettingsDialogDefinition: DialogDefinition = {
  id: TIMELINE_SETTINGS_DIALOG_ID,
  component: TimelineSlicerSettingsDialog as React.ComponentType<DialogProps>,
  priority: 100,
};
