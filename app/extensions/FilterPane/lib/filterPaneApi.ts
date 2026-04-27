//! FILENAME: app/extensions/FilterPane/lib/filterPaneApi.ts
// PURPOSE: Tauri command wrappers for ribbon filter backend operations.

import { invokeBackend } from "@api/backend";
import type {
  RibbonFilter,
  SlicerItem,
  CreateRibbonFilterParams,
  UpdateRibbonFilterParams,
  RibbonFilterScope,
} from "./filterPaneTypes";

export async function createRibbonFilter(
  params: CreateRibbonFilterParams,
): Promise<RibbonFilter> {
  return invokeBackend<RibbonFilter>("create_ribbon_filter", { params });
}

export async function deleteRibbonFilter(filterId: number): Promise<void> {
  return invokeBackend<void>("delete_ribbon_filter", { filterId });
}

export async function updateRibbonFilter(
  filterId: number,
  params: UpdateRibbonFilterParams,
): Promise<RibbonFilter> {
  return invokeBackend<RibbonFilter>("update_ribbon_filter", {
    filterId,
    params,
  });
}

export async function updateRibbonFilterSelection(
  filterId: number,
  selectedItems: string[] | null,
): Promise<void> {
  return invokeBackend<void>("update_ribbon_filter_selection", {
    filterId,
    selectedItems,
  });
}

export async function getAllRibbonFilters(): Promise<RibbonFilter[]> {
  return invokeBackend<RibbonFilter[]>("get_all_ribbon_filters");
}

export async function getRibbonFiltersByScope(
  scope: RibbonFilterScope,
  sheetIndex?: number,
): Promise<RibbonFilter[]> {
  return invokeBackend<RibbonFilter[]>("get_ribbon_filters_by_scope", {
    scope,
    sheetIndex: sheetIndex ?? null,
  });
}

export async function getRibbonFilterItems(
  filterId: number,
): Promise<SlicerItem[]> {
  return invokeBackend<SlicerItem[]>("get_ribbon_filter_items", { filterId });
}

// ============================================================================
// BI Connection helpers
// ============================================================================

export interface BiConnectionInfo {
  id: number;
  name: string;
  description: string;
  isConnected: boolean;
  modelPath: string | null;
}

export interface BiModelInfo {
  tables: Array<{
    name: string;
    columns: Array<{ name: string; dataType: string; isNumeric: boolean }>;
  }>;
  measures: Array<{ name: string }>;
  relationships: Array<{
    name: string;
    fromTable: string;
    fromColumn: string;
    toTable: string;
    toColumn: string;
  }>;
}

export async function getBiConnections(): Promise<BiConnectionInfo[]> {
  return invokeBackend<BiConnectionInfo[]>("bi_get_connections");
}

export async function getBiModelInfo(
  connectionId: number,
): Promise<BiModelInfo> {
  return invokeBackend<BiModelInfo>("bi_get_model_info", { connectionId });
}

export async function getBiColumnValues(
  connectionId: number,
  table: string,
  column: string,
): Promise<string[]> {
  return invokeBackend<string[]>("bi_get_column_values", {
    connectionId,
    table,
    column,
  });
}
