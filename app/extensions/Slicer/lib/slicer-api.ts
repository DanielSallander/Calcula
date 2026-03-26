//! FILENAME: app/extensions/Slicer/lib/slicer-api.ts
// PURPOSE: Tauri command wrappers for slicer backend operations.

import { invokeBackend } from "../../../src/api/backend";
import type {
  Slicer,
  SlicerItem,
  CreateSlicerParams,
  UpdateSlicerParams,
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
