//! FILENAME: app/extensions/TimelineSlicer/lib/timelineSlicerTypes.ts
// PURPOSE: TypeScript interfaces mirroring Rust timeline slicer types.

export type TimelineSourceType = "pivot";

/** Granularity level for the timeline display. */
export type TimelineLevel = "years" | "quarters" | "months" | "days";

export interface TimelineSlicer {
  id: number;
  name: string;
  headerText: string | null;
  sheetIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  sourceType: TimelineSourceType;
  sourceId: number;
  fieldName: string;
  level: TimelineLevel;
  selectionStart: string | null;
  selectionEnd: string | null;
  showHeader: boolean;
  showLevelSelector: boolean;
  showScrollbar: boolean;
  stylePreset: string;
  scrollPosition: number;
  connectedPivotIds: number[];
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
  sourceId: number;
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
  timelineId: number;
  selectionStart: string | null;
  selectionEnd: string | null;
}

export interface UpdateTimelineConnectionsParams {
  timelineId: number;
  connectedPivotIds: number[];
}
