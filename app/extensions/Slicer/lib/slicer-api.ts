//! FILENAME: app/extensions/Slicer/lib/slicer-api.ts
// PURPOSE: Tauri command wrappers for slicer backend operations.

import { slicerBackend } from "./slicerBackend";
import type {
  Slicer,
  SlicerItem,
  CreateSlicerParams,
  UpdateSlicerParams,
  SlicerComputedPropertyResult,
} from "./slicerTypes";

export async function createSlicer(params: CreateSlicerParams): Promise<Slicer> {
  return slicerBackend.invoke<Slicer>("create_slicer", { params });
}

export async function deleteSlicer(slicerId: string): Promise<void> {
  return slicerBackend.invoke<void>("delete_slicer", { slicerId });
}

export async function updateSlicer(
  slicerId: string,
  params: UpdateSlicerParams,
): Promise<Slicer> {
  return slicerBackend.invoke<Slicer>("update_slicer", { slicerId, params });
}

export async function updateSlicerPosition(
  slicerId: string,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<void> {
  return slicerBackend.invoke<void>("update_slicer_position", {
    slicerId,
    x,
    y,
    width,
    height,
  });
}

export async function updateSlicerSelection(
  slicerId: string,
  selectedItems: string[] | null,
): Promise<void> {
  return slicerBackend.invoke<void>("update_slicer_selection", {
    slicerId,
    selectedItems,
  });
}

export async function getAllSlicers(): Promise<Slicer[]> {
  return slicerBackend.invoke<Slicer[]>("get_all_slicers");
}

export async function getSlicersForSheet(sheetIndex: number): Promise<Slicer[]> {
  return slicerBackend.invoke<Slicer[]>("get_slicers_for_sheet", { sheetIndex });
}

export async function getSlicer(slicerId: string): Promise<Slicer> {
  return slicerBackend.invoke<Slicer>("get_slicer", { slicerId });
}

export async function getSlicerItems(slicerId: string): Promise<SlicerItem[]> {
  return slicerBackend.invoke<SlicerItem[]>("get_slicer_items", { slicerId });
}

export async function clearSlicerFilter(slicerId: string): Promise<void> {
  return slicerBackend.invoke<void>("clear_slicer_filter", { slicerId });
}

export async function setSlicerItemSelected(
  slicerId: string,
  value: string,
  selected: boolean,
): Promise<void> {
  return slicerBackend.invoke<void>("set_slicer_item_selected", {
    slicerId,
    value,
    selected,
  });
}

// ============================================================================
// Slicer Computed Properties
// ============================================================================

export async function getSlicerComputedProperties(
  slicerId: string,
): Promise<SlicerComputedPropertyResult> {
  return slicerBackend.invoke<SlicerComputedPropertyResult>(
    "get_slicer_computed_properties",
    { slicerId },
  );
}

export async function getSlicerAvailableAttributes(): Promise<string[]> {
  return slicerBackend.invoke<string[]>("get_slicer_available_attributes");
}

export async function addSlicerComputedProperty(
  slicerId: string,
  attribute: string,
  formula: string,
): Promise<SlicerComputedPropertyResult> {
  return slicerBackend.invoke<SlicerComputedPropertyResult>(
    "add_slicer_computed_property",
    { slicerId, attribute, formula },
  );
}

export async function updateSlicerComputedProperty(
  propId: string,
  attribute?: string,
  formula?: string,
): Promise<SlicerComputedPropertyResult> {
  return slicerBackend.invoke<SlicerComputedPropertyResult>(
    "update_slicer_computed_property",
    { propId, attribute, formula },
  );
}

export async function removeSlicerComputedProperty(
  propId: string,
): Promise<SlicerComputedPropertyResult> {
  return slicerBackend.invoke<SlicerComputedPropertyResult>(
    "remove_slicer_computed_property",
    { propId },
  );
}

export async function getSlicerComputedAttributes(
  slicerId: string,
): Promise<string[]> {
  return slicerBackend.invoke<string[]>("get_slicer_computed_attributes", { slicerId });
}
