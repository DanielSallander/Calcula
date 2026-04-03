//! FILENAME: app/extensions/Slicer/lib/slicer-api.ts
// PURPOSE: Tauri command wrappers for slicer backend operations.

import { invokeBackend } from "@api/backend";
import type {
  Slicer,
  SlicerItem,
  CreateSlicerParams,
  UpdateSlicerParams,
  SlicerComputedPropertyResult,
} from "./slicerTypes";

export async function createSlicer(params: CreateSlicerParams): Promise<Slicer> {
  return invokeBackend<Slicer>("create_slicer", { params });
}

export async function deleteSlicer(slicerId: number): Promise<void> {
  return invokeBackend<void>("delete_slicer", { slicerId });
}

export async function updateSlicer(
  slicerId: number,
  params: UpdateSlicerParams,
): Promise<Slicer> {
  return invokeBackend<Slicer>("update_slicer", { slicerId, params });
}

export async function updateSlicerPosition(
  slicerId: number,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<void> {
  return invokeBackend<void>("update_slicer_position", {
    slicerId,
    x,
    y,
    width,
    height,
  });
}

export async function updateSlicerSelection(
  slicerId: number,
  selectedItems: string[] | null,
): Promise<void> {
  return invokeBackend<void>("update_slicer_selection", {
    slicerId,
    selectedItems,
  });
}

export async function getAllSlicers(): Promise<Slicer[]> {
  return invokeBackend<Slicer[]>("get_all_slicers");
}

export async function getSlicersForSheet(sheetIndex: number): Promise<Slicer[]> {
  return invokeBackend<Slicer[]>("get_slicers_for_sheet", { sheetIndex });
}

export async function getSlicerItems(slicerId: number): Promise<SlicerItem[]> {
  return invokeBackend<SlicerItem[]>("get_slicer_items", { slicerId });
}

// ============================================================================
// Slicer Computed Properties
// ============================================================================

export async function getSlicerComputedProperties(
  slicerId: number,
): Promise<SlicerComputedPropertyResult> {
  return invokeBackend<SlicerComputedPropertyResult>(
    "get_slicer_computed_properties",
    { slicerId },
  );
}

export async function getSlicerAvailableAttributes(): Promise<string[]> {
  return invokeBackend<string[]>("get_slicer_available_attributes");
}

export async function addSlicerComputedProperty(
  slicerId: number,
  attribute: string,
  formula: string,
): Promise<SlicerComputedPropertyResult> {
  return invokeBackend<SlicerComputedPropertyResult>(
    "add_slicer_computed_property",
    { slicerId, attribute, formula },
  );
}

export async function updateSlicerComputedProperty(
  propId: number,
  attribute?: string,
  formula?: string,
): Promise<SlicerComputedPropertyResult> {
  return invokeBackend<SlicerComputedPropertyResult>(
    "update_slicer_computed_property",
    { propId, attribute, formula },
  );
}

export async function removeSlicerComputedProperty(
  propId: number,
): Promise<SlicerComputedPropertyResult> {
  return invokeBackend<SlicerComputedPropertyResult>(
    "remove_slicer_computed_property",
    { propId },
  );
}

export async function getSlicerComputedAttributes(
  slicerId: number,
): Promise<string[]> {
  return invokeBackend<string[]>("get_slicer_computed_attributes", { slicerId });
}
