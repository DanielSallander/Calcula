//! FILENAME: app/extensions/TimelineSlicer/manifest.ts
// PURPOSE: Timeline slicer extension manifest and registration definitions.

import type {
  AddInManifest,
  DialogDefinition,
  DialogProps,
} from "@api";
import type { PanelDefinition } from "@api/ui";
import { RibbonIcon, type RibbonIconProps } from "@api/ribbonIcons";
import { ICON_SIZE_MD, ICON_SIZE_SM } from "@api/layout";
import React from "react";
import { InsertTimelineDialog } from "./components/InsertTimelineDialog";
import { TimelineSlicerSettingsDialog } from "./components/TimelineSlicerSettingsDialog";
import {
  TimelineLevelSection,
  TimelineFilterSection,
  TimelineActionsSection,
} from "./components/TimelineSlicerOptionsTab";

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
// Contextual Timeline Panel (ribbon-placed by default)
// ============================================================================

/**
 * Contextual-tab accent: the skin's slicer accent (a timeline IS a slicer),
 * with the tab's historical blue as the fallback when a skin predates the
 * token.
 */
const TIMELINE_TAB_COLOR = "var(--tab-accent-slicer, #4472C4)";
const TIMELINE_TAB_ORDER = 500;

export const TIMELINE_OPTIONS_TAB_ID = "timeline-slicer-options";

/** A section icon at the launcher / sidebar-header size (24). */
function sectionIcon(Icon: React.ComponentType<RibbonIconProps>): React.ReactElement {
  return React.createElement(Icon, { size: ICON_SIZE_MD });
}

/**
 * Location-agnostic panel replacing the old monolithic contextual ribbon tab.
 * One section per former RibbonGroup; collapsePriority carries the old
 * collapseOrder semantics (lower demotes to a launcher first under width
 * pressure). The shell owns group chrome and collapse measurement.
 */
export const TimelineOptionsPanelDefinition: PanelDefinition = {
  id: TIMELINE_OPTIONS_TAB_ID,
  title: "Timeline",
  icon: React.createElement(RibbonIcon.Timeline, { size: ICON_SIZE_SM }),
  sections: [
    {
      id: `${TIMELINE_OPTIONS_TAB_ID}.level`,
      label: "Level",
      icon: sectionIcon(RibbonIcon.Calendar),
      component: TimelineLevelSection,
      collapsePriority: 3,
    },
    {
      id: `${TIMELINE_OPTIONS_TAB_ID}.filter`,
      label: "Filter",
      icon: sectionIcon(RibbonIcon.Filter),
      component: TimelineFilterSection,
      collapsePriority: 2,
    },
    {
      id: `${TIMELINE_OPTIONS_TAB_ID}.timeline`,
      label: "Timeline",
      icon: sectionIcon(RibbonIcon.Timeline),
      component: TimelineActionsSection,
      collapsePriority: 1,
    },
  ],
  defaultPlacement: "ribbon",
  ribbonOrder: TIMELINE_TAB_ORDER,
  ribbonColor: TIMELINE_TAB_COLOR,
  priority: 1000 - TIMELINE_TAB_ORDER,
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
