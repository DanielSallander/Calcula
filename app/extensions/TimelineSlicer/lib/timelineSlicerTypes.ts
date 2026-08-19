//! FILENAME: app/extensions/TimelineSlicer/lib/timelineSlicerTypes.ts
// PURPOSE: TypeScript interfaces mirroring Rust timeline slicer types.

export type TimelineSourceType = "pivot";

/** Granularity level for the timeline display. */
export type TimelineLevel = "years" | "quarters" | "months" | "days";

export interface TimelineSlicer {
  // Entity ids cross IPC as 36-char UUID STRINGS (core/identity). This said
  // `number` while `sourceId` and `connectedPivotIds` in the same interface were
  // already `string` — the file contradicted itself, and any round-trip proof
  // built on the number would have been meaningless.
  id: string;
  name: string;
  headerText: string | null;
  sheetIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  sourceType: TimelineSourceType;
  sourceId: string;
  fieldName: string;
  level: TimelineLevel;
  selectionStart: string | null;
  selectionEnd: string | null;
  showHeader: boolean;
  showLevelSelector: boolean;
  showScrollbar: boolean;
  stylePreset: string;
  connectedPivotIds: string[];
}

export interface TimelinePeriod {
  label: string;
  groupLabel: string;
  startDate: string;
  endDate: string;
  hasData: boolean;
  isSelected: boolean;
  index: number;
}

export interface TimelineDataResponse {
  minDate: string;
  maxDate: string;
  periods: TimelinePeriod[];
  level: TimelineLevel;
  totalPeriods: number;
}

export interface CreateTimelineParams {
  name: string;
  sheetIndex: number;
  x: number;
  y: number;
  width?: number;
  height?: number;
  sourceId: string;
  fieldName: string;
  level?: TimelineLevel;
  stylePreset?: string;
}

export interface UpdateTimelineParams {
  name?: string;
  headerText?: string | null;
  showHeader?: boolean;
  showLevelSelector?: boolean;
  showScrollbar?: boolean;
  level?: TimelineLevel;
  stylePreset?: string;
}

export interface UpdateTimelineSelectionParams {
  timelineId: string;
  selectionStart: string | null;
  selectionEnd: string | null;
}

export interface UpdateTimelineConnectionsParams {
  timelineId: string;
  connectedPivotIds: string[];
}
