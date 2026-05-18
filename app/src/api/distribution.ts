// FILENAME: app/src/api/distribution.ts
// PURPOSE: API facade for the .calp distribution system.
// CONTEXT: Extensions import from here — never directly from @tauri-apps/api.

import { invokeBackend } from "./backend";

// ============================================================================
// Types
// ============================================================================

export interface PublishParams {
  registryPath: string;
  packageName: string;
  version: string;
  kind: string;
  sheetIndices: number[];
  publishedBy: string;
}

export interface PublishResponse {
  packageName: string;
  version: string;
  sheetsPublished: number;
  tablesPublished: number;
  namedRangesPublished: number;
}

export interface PullParams {
  registryPath: string;
  packageName: string;
  versionPin: string;
}

export interface PullResponse {
  packageName: string;
  resolvedVersion: string;
  sheetsPulled: number;
  tablesPulled: number;
}

export interface PackageInfo {
  name: string;
  description: string;
  kind: string;
  author: string;
  versions: VersionInfo[];
}

export interface VersionInfo {
  version: string;
  publishedAt: string;
  publishedBy: string;
  sheets: SheetInfo[];
}

export interface SheetInfo {
  name: string;
  description: string;
}

export interface SubscriptionManifest {
  formatVersion: number;
  subscriptions: Subscription[];
}

export interface Subscription {
  packageName: string;
  registryUrl: string;
  versionPin: string;
  resolvedVersion: string;
  resolvedAt: string;
  sheets: SubscribedSheet[];
}

export interface SubscribedSheet {
  packageSheetId: string;
  localSheetId: string;
  localName: string;
}

// Override types
export interface OverrideLayer {
  formatVersion: number;
  overrides: CellOverride[];
}

export interface CellOverride {
  sheetId: string;
  cellId: string;
  position: [number, number];
  baseline: OverrideValue;
  current: OverrideValue;
  createdAt: string;
  modifiedAt: string;
  author: string;
  conflict: boolean;
  upstreamNew: OverrideValue | null;
}

export type OverrideValue =
  | { type: "value"; display: string }
  | { type: "formula"; formula: string }
  | { type: "empty" };

export interface OverridePatch {
  formatVersion: number;
  packageName: string;
  baselineVersion: string;
  overrides: CellOverride[];
  exportedAt: string;
}

// Refresh types
export interface RefreshPreview {
  subscriptionPreviews: SubscriptionPreview[];
  totalCellsChanged: number;
  totalSheetsAdded: number;
  totalSheetsRemoved: number;
  totalOverridesConflicted: number;
  totalOverridesAutoCleared: number;
}

export interface SubscriptionPreview {
  packageName: string;
  currentVersion: string;
  newVersion: string;
  sheetsAdded: SheetChangeInfo[];
  sheetsRemoved: SheetChangeInfo[];
  sheetsUpdated: SheetChangeInfo[];
  cellsChanged: number;
  overridesConflicted: number;
  overridesAutoCleared: number;
}

export interface SheetChangeInfo {
  sheetId: string;
  name: string;
  overrideCount: number;
}

export interface RefreshResult {
  subscriptionsRefreshed: number;
  sheetsAdded: number;
  sheetsRemoved: number;
  sheetsUpdated: number;
  conflictsCreated: number;
  overridesAutoCleared: number;
  structuralConflicts: StructuralConflict[];
}

export interface StructuralConflict {
  sheetId: string;
  sheetName: string;
  overrideCount: number;
}

// ============================================================================
// Backend Wrappers
// ============================================================================

export function publishPackage(params: PublishParams): Promise<PublishResponse> {
  return invokeBackend("calp_publish", { params });
}

export function pullPackage(params: PullParams): Promise<PullResponse> {
  return invokeBackend("calp_pull", { params });
}

export function browseRegistry(registryPath: string): Promise<PackageInfo[]> {
  return invokeBackend("calp_browse_registry", { registryPath });
}

export function getSubscriptions(): Promise<SubscriptionManifest> {
  return invokeBackend("calp_get_subscriptions");
}

export function getOverrides(): Promise<OverrideLayer> {
  return invokeBackend("calp_get_overrides");
}

export function revertOverride(sheetId: string, cellId: string): Promise<boolean> {
  return invokeBackend("calp_revert_override", { sheetId, cellId });
}

export function acceptUpstream(sheetId: string, cellId: string): Promise<boolean> {
  return invokeBackend("calp_accept_upstream", { sheetId, cellId });
}

export function keepOverride(sheetId: string, cellId: string): Promise<boolean> {
  return invokeBackend("calp_keep_override", { sheetId, cellId });
}

export function exportOverrides(packageName: string): Promise<OverridePatch> {
  return invokeBackend("calp_export_overrides", { packageName });
}

export function importOverrides(patchJson: string): Promise<number> {
  return invokeBackend("calp_import_overrides", { patchJson });
}

export function refreshPreview(registryPath: string): Promise<RefreshPreview> {
  return invokeBackend("calp_refresh_preview", { registryPath });
}

export function refreshApply(registryPath: string): Promise<RefreshResult> {
  return invokeBackend("calp_refresh_apply", { registryPath });
}

export function detach(): Promise<void> {
  return invokeBackend("calp_detach");
}
