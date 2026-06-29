//! FILENAME: app/extensions/TimelineSlicer/lib/timeline-slicer-api.ts
// PURPOSE: Tauri command wrappers for timeline slicer backend operations.

import { timelineBackend } from "./timelineBackend";
import type {
  TimelineSlicer,
  TimelineDataResponse,
  CreateTimelineParams,
  UpdateTimelineParams,
  UpdateTimelineSelectionParams,
  UpdateTimelineConnectionsParams,
} from "./timelineSlicerTypes";

export async function createTimelineSlicer(
  params: CreateTimelineParams,
): Promise<TimelineSlicer> {
  return timelineBackend.invoke<TimelineSlicer>("create_timeline_slicer", { params });
}

export async function deleteTimelineSlicer(timelineId: number): Promise<void> {
  return timelineBackend.invoke<void>("delete_timeline_slicer", { timelineId });
}

export async function updateTimelineSlicer(
  timelineId: number,
  params: UpdateTimelineParams,
): Promise<TimelineSlicer> {
  return timelineBackend.invoke<TimelineSlicer>("update_timeline_slicer", {
    timelineId,
    params,
  });
}

export async function updateTimelinePosition(
  timelineId: number,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<void> {
  return timelineBackend.invoke<void>("update_timeline_position", {
    timelineId,
    x,
    y,
    width,
    height,
  });
}

export async function updateTimelineSelection(
  params: UpdateTimelineSelectionParams,
): Promise<void> {
  return timelineBackend.invoke<void>("update_timeline_selection", { params });
}

export async function updateTimelineScroll(
  timelineId: number,
  scrollPosition: number,
): Promise<void> {
  return timelineBackend.invoke<void>("update_timeline_scroll", {
    timelineId,
    scrollPosition,
  });
}

export async function updateTimelineConnections(
  params: UpdateTimelineConnectionsParams,
): Promise<void> {
  return timelineBackend.invoke<void>("update_timeline_connections", { params });
}

export async function getAllTimelineSlicers(): Promise<TimelineSlicer[]> {
  return timelineBackend.invoke<TimelineSlicer[]>("get_all_timeline_slicers");
}

export async function getTimelineSlicersForSheet(
  sheetIndex: number,
): Promise<TimelineSlicer[]> {
  return timelineBackend.invoke<TimelineSlicer[]>("get_timeline_slicers_for_sheet", {
    sheetIndex,
  });
}

export async function getTimelineData(
  timelineId: number,
): Promise<TimelineDataResponse> {
  return timelineBackend.invoke<TimelineDataResponse>("get_timeline_data", {
    timelineId,
  });
}

export async function getTimelineSelectedItems(
  timelineId: number,
): Promise<string[] | null> {
  return timelineBackend.invoke<string[] | null>("get_timeline_selected_items", {
    timelineId,
  });
}

export async function getPivotDateFields(
  pivotId: string,
): Promise<string[]> {
  return timelineBackend.invoke<string[]>("get_pivot_date_fields", { pivotId });
}
