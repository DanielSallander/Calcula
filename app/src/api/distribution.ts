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

// ============================================================================
// Phase 6: Author Workflow
// ============================================================================

export interface DevSubscribeParams {
  /** Absolute path to a local .cala file. */
  sourcePath: string;
  /** Sheet names to pull; empty array means all sheets. */
  sheetNames: string[];
}

/**
 * Subscribe to a local .cala file in dev mode.
 * Sheets are materialized into the workbook like a normal pull but resolve
 * against the file directly instead of a registry version.
 */
export function devSubscribe(params: DevSubscribeParams): Promise<PullResponse> {
  return invokeBackend("calp_dev_subscribe", { params });
}

/**
 * Re-pull from the dev source, refreshing HEAD sheets in place.
 * Finds the dev subscription automatically from the current workbook state.
 */
export function devRefresh(): Promise<PullResponse> {
  return invokeBackend("calp_dev_refresh");
}

/**
 * Rename a stable CellId (author-facing).
 * Returns false if the old ID was not found.
 * Currently deferred pending full IdRegistry integration into AppState.
 */
export function renameCellId(
  sheetId: string,
  oldCellId: string,
  newCellId: string,
): Promise<boolean> {
  return invokeBackend("calp_rename_cell_id", { sheetId, oldCellId, newCellId });
}

/**
 * Merge two stable CellIds (author-facing).
 * The absorbed ID is consumed by the survivor.
 * Currently deferred pending full IdRegistry integration into AppState.
 */
export function mergeCellIds(
  sheetId: string,
  survivorCellId: string,
  absorbedCellId: string,
): Promise<boolean> {
  return invokeBackend("calp_merge_cell_ids", { sheetId, survivorCellId, absorbedCellId });
}

/**
 * Suggest the next version string for a package given a bump level.
 * @param registryPath - Absolute path to the local registry directory.
 * @param packageName  - Package name inside the registry.
 * @param bump         - One of "major", "minor", or "patch".
 * @returns The suggested next version string, e.g. "1.3.0".
 */
export function nextVersion(
  registryPath: string,
  packageName: string,
  bump: "major" | "minor" | "patch",
): Promise<string> {
  return invokeBackend("calp_next_version", { registryPath, packageName, bump });
}

// ============================================================================
// Phase 7: Audit Log
// ============================================================================

export interface AuditEntry {
  timestamp: string;
  event: string;
  description: string;
  user: string;
}

export interface AuditLog {
  formatVersion: number;
  enabled: boolean;
  maxEntries: number;
  entries: AuditEntry[];
}

/** Return the full audit log for the current workbook. */
export function getAuditLog(): Promise<AuditLog> {
  return invokeBackend("calp_get_audit_log");
}

/**
 * Enable or disable audit logging and configure the rolling window.
 * @param enabled    - Whether to enable audit logging.
 * @param maxEntries - Maximum entries to keep (0 = unlimited).
 */
export function setAuditEnabled(enabled: boolean, maxEntries: number): Promise<void> {
  return invokeBackend("calp_set_audit_enabled", { enabled, maxEntries });
}

/** Discard all audit log entries. */
export function clearAuditLog(): Promise<void> {
  return invokeBackend("calp_clear_audit_log");
}

// ============================================================================
// Phase 9: Writeback Readiness
// ============================================================================

/** A writeback region entry from the backend index (flat format). */
export interface WritebackRegionEntry {
  sheetId: string;
  sheetIndex: number;
  regionId: string;
  rowStart: number;
  rowEnd: number;
  colStart: number;
  colEnd: number;
}

/** Fetch the current writeback regions from the backend. */
export function getWritebackRegions(): Promise<WritebackRegionEntry[]> {
  return invokeBackend("calp_get_writeback_regions");
}

/** Subscriber identity attached to writeback submissions. */
export interface SubmitterIdentity {
  displayName: string;
  id: string;
}

/** Get the current subscriber identity (creates one on first call). */
export function getSubscriberIdentity(): Promise<SubmitterIdentity> {
  return invokeBackend("calp_get_subscriber_identity");
}

// ============================================================================
// Phase 12: Author UI — Writeback Region Designation
// ============================================================================

/** A writeback region declaration (author-side draft or published). */
export interface WritebackRegionDeclaration {
  id: string;
  selector: RegionSelector;
  mode?: "per_subscriber" | "list_object";
  schema?: ValueSchemaConfig;
  visibility?: "own_only" | "own_plus_aggregate" | "transparent";
  submissionPolicy?: "immediate" | "on_submit" | "on_approval";
  versionBinding?: "strict" | "lenient";
  lifecycle?: LifecyclePolicyConfig;
  aggregationHint?: string;
}

export interface RegionSelector {
  sheetId: string;
  rowStart: number;
  rowEnd: number;
  colStart: number;
  colEnd: number;
}

export interface ValueSchemaConfig {
  valueType: "number" | "integer" | "text" | "date" | "boolean" | "enum";
  required?: boolean;
  min?: number;
  max?: number;
  enumValues?: string[];
  maxLength?: number;
  pattern?: string;
}

export interface LifecyclePolicyConfig {
  policy: "always" | "until_deadline" | "never" | "requires_unlock";
  deadline?: string;
}

/** Get all draft writeback regions for the current workbook (author mode). */
export function getWritebackDraftRegions(): Promise<WritebackRegionDeclaration[]> {
  return invokeBackend("calp_get_writeback_draft_regions");
}

/** Add a new draft writeback region. */
export function addWritebackRegion(region: WritebackRegionDeclaration): Promise<void> {
  return invokeBackend("calp_add_writeback_region", { region });
}

/** Remove a draft writeback region by ID. */
export function removeWritebackRegion(regionId: string): Promise<boolean> {
  return invokeBackend("calp_remove_writeback_region", { regionId });
}

/** Update an existing draft writeback region (replace by ID). */
export function updateWritebackRegion(region: WritebackRegionDeclaration): Promise<void> {
  return invokeBackend("calp_update_writeback_region", { region });
}

/** Look up the CellId at a position without minting. */
export function getCellId(sheetId: string, row: number, col: number): Promise<string | null> {
  return invokeBackend("calp_get_cell_id", { sheetId, row, col });
}

// ============================================================================
// Phase 14: Writeback Submission
// ============================================================================

export type SubmissionState = "draft" | "submitted" | "approved" | "rejected";

export interface SubmissionValue {
  type: "number" | "text" | "boolean" | "empty";
  value?: number | string | boolean;
}

export interface WritebackSubmission {
  id: string;
  regionId: string;
  cellRow: number;
  cellCol: number;
  cellId?: string;
  submitter: SubmitterIdentity;
  value: SubmissionValue;
  state: SubmissionState;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
}

export interface WritebackLayer {
  formatVersion: number;
  drafts: WritebackSubmission[];
}

/** Save a writeback draft for a cell. */
export function saveWritebackDraft(
  regionId: string,
  sheetId: string,
  row: number,
  col: number,
  value: SubmissionValue,
): Promise<void> {
  return invokeBackend("calp_save_writeback_draft", { regionId, sheetId, row, col, value });
}

/** Get the current writeback layer (all drafts). */
export function getWritebackLayer(): Promise<WritebackLayer> {
  return invokeBackend("calp_get_writeback_layer");
}

/** Submit all drafts for a region to the registry. Returns count submitted. */
export function submitRegion(regionId: string, registryPath: string): Promise<number> {
  return invokeBackend("calp_submit_region", { regionId, registryPath });
}

// ============================================================================
// Live Data Sources
// ============================================================================

/** A data source that needs manual configuration (SSPI failed). */
export interface DataSourceNeedsConfig {
  dataSourceId: string;
  name: string;
  server: string;
  database: string;
  connectionType: string;
}

/** Result of a data refresh operation. */
export interface DataRefreshResponse {
  sourcesRefreshed: number;
  queriesExecuted: number;
  cellsUpdated: number;
  needsConfiguration: DataSourceNeedsConfig[];
}

/** Info about a data source in the current workbook. */
export interface DataSourceInfo {
  id: string;
  name: string;
  connectionType: string;
  server: string;
  database: string;
  queryCount: number;
  isConfigured: boolean;
  packageName: string;
}

/**
 * Refresh all data sources for the current workbook's subscriptions.
 * Tries SSPI first, then uses saved credentials, or reports which
 * data sources need manual configuration.
 */
export function refreshData(): Promise<DataRefreshResponse> {
  return invokeBackend("calp_refresh_data");
}

/**
 * Save connection credentials for a data source.
 * Stored in the subscriber's local .cala file, never in the registry.
 */
export function saveDataSourceConfig(
  dataSourceId: string,
  connectionString: string,
): Promise<void> {
  return invokeBackend("calp_save_data_source_config", { dataSourceId, connectionString });
}

/** Get all data sources for the current workbook's subscriptions. */
export function getDataSources(): Promise<DataSourceInfo[]> {
  return invokeBackend("calp_get_data_sources");
}
