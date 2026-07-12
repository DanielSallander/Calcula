// FILENAME: app/src/api/distribution.ts
// PURPOSE: API facade for the .calp distribution system.
// CONTEXT: Extensions import from here — never directly from @tauri-apps/api.

import { invokeBackend } from "./backend";
import {
  collectDistributableObjects,
  materializePulledObjects,
  type DistributableObjectPayload,
  type PulledDistributableObject,
} from "./distributableObjects";

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
  /** Custom objects contributed by distributable-object providers (brick 4).
   *  publishPackage fills this automatically from registered providers. */
  customObjects?: DistributableObjectPayload[];
  /** Opt-in for carrying threaded comments (Wave B). Comments are internal
   * discussion, so they stay private unless this is explicitly true
   * (default false). Scenarios and outlines always publish. */
  includeComments?: boolean;
}

export interface PublishResponse {
  packageName: string;
  version: string;
  sheetsPublished: number;
  tablesPublished: number;
  namedRangesPublished: number;
  scriptsPublished: number;
  modulesPublished: number;
  notebooksPublished: number;
  /** Transparency report: everything that shipped and everything present in
   * the workbook that packages cannot carry yet (no silent drops). */
  report: PublishReport;
  /** Publish-time disclosure warnings — e.g. a dropdown pane control whose
   * CellRange item source references a sheet outside the published selection
   * (the artifact is unchanged; these only warn). */
  warnings: string[];
}

/** One line of the publish transparency report. */
export interface PublishReportItem {
  category: string;
  count: number;
  detail: string;
}

/** What a publish did (or, for the preview, would) carry — and what stays
 * behind, with a reason per line. */
export interface PublishReport {
  included: PublishReportItem[];
  excluded: PublishReportItem[];
}

export interface PublishPreviewResponse {
  /** Names of the sheets the preview covered, in package order. */
  sheetNames: string[];
  report: PublishReport;
  /** The SAME disclosure warnings a real publish of this selection would emit
   * — e.g. a dropdown pane control whose CellRange item source references a
   * sheet outside the selection. Non-blocking. */
  warnings: string[];
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
  /** Number of object scripts materialized (restricted, consent-gated). */
  scriptsPulled: number;
  /** Publisher display name from the verified manifest (S5 phase 2). */
  publisherName: string;
  /** "firstUse" (publisher key newly pinned) or "verified" (matched a pin). */
  trustStatus: string;
  /** Custom objects of kinds NOT handled Rust-side (brick 4), for frontend
   *  provider materialization. pullPackage dispatches these automatically. */
  customObjects?: PulledDistributableObject[];
}

/** Contents of a package version, for pre-pull review. */
export interface PackageInspection {
  packageName: string;
  resolvedVersion: string;
  sheets: SheetInfo[];
  scripts: InspectedScript[];
  dataSources: InspectedDataSource[];
  writebackRegionCount: number;
  tableCount: number;
  namedRangeCount: number;
  /** Names of the tables the package carries (per-object transparency). */
  tableNames: string[];
  /** Names of the named ranges the package carries. */
  namedRangeNames: string[];
  chartCount: number;
  sparklineCount: number;
  pivotCount: number;
  /** Sheets carrying cell-anchored controls (buttons/checkboxes). */
  controlSheetCount: number;
  /** Pane controls (Controls pane widgets) the package carries. */
  paneControlCount: number;
  /** Names of the pane controls the package carries. */
  paneControlNames: string[];
  /** Slicers on the published sheets (Wave A). */
  slicerCount: number;
  /** Ribbon filters the package carries (workbook-scoped, BI-only; Wave A). */
  ribbonFilterCount: number;
  /** Saved pivot layouts the package carries (Wave A). */
  pivotLayoutCount: number;
  /** Whether the package carries a document theme (applied only if the
   * subscriber's theme is still the default). */
  hasDocumentTheme: boolean;
  /** Extension-data keys the package carries (merged additively; keys the
   * subscriber already has are never overwritten). */
  extensionDataCount: number;
  /** Their key names (per-object transparency, like namedRangeNames). */
  extensionDataKeys: string[];
  /** Sheets carrying threaded comments (Wave B). Non-zero only when the
   * publisher explicitly opted in via "Include comments" at publish. */
  commentSheetCount: number;
  /** Verified publisher display name (S5 phase 2). */
  publisherName: string;
  /** "firstUse" or "verified"; failed verification returns an error instead. */
  trustStatus: string;
}

export interface InspectedScript {
  name: string;
  objectType: string;
  description: string | null;
  /** Capability ids the package's manifest declares this script needs (R19). */
  requestedCapabilities: string[];
}

export interface InspectedDataSource {
  name: string;
  connectionType: string;
  server: string;
  database: string;
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
  /** Provenance ledger: every object this subscription materialized
   * (written at pull, updated at refresh). May be absent on subscriptions
   * created before the ledger existed. */
  objects?: SubscribedObject[];
}

/** One object a subscription materialized into the local workbook. */
export interface SubscribedObject {
  /** "table" | "chart" | "pivot" | "namedRange" | "objectScript" |
   * "moduleScript" | "notebook" | "dataSource" | "controlSheet" |
   * "paneControl" | "slicer" | "ribbonFilter" | "pivotLayout" */
  kind: string;
  id: string;
  /** Display name at materialization time; ABSENT when unknown (charts,
   * pivots) — the backend omits empty names from the JSON. */
  name?: string;
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

export async function publishPackage(params: PublishParams): Promise<PublishResponse> {
  // Fill custom objects from registered distributable-object providers (brick 4)
  // unless the caller already supplied them. Built-in cell types are collected
  // Rust-side and merged there — these are the third-party providers' objects.
  const customObjects = params.customObjects ?? (await collectDistributableObjects());
  return invokeBackend("calp_publish", { params: { ...params, customObjects } });
}

/**
 * Dry-run of publishPackage: assemble the exact carrier a publish would use
 * and report what would ship vs stay behind — without writing anything.
 * Omit sheetIndices (or pass []) to preview publishing every sheet.
 * Pass includeComments to mirror the real publish's comment opt-in, so the
 * preview report shows comments exactly where the publish would put them.
 */
export function publishPreview(
  sheetIndices?: number[],
  includeComments?: boolean,
): Promise<PublishPreviewResponse> {
  return invokeBackend("calp_publish_preview", {
    params: {
      sheetIndices: sheetIndices ?? null,
      includeComments: includeComments ?? false,
    },
  });
}

export interface PublishModelParams {
  registryPath: string;
  packageName: string;
  version: string;
  publishedBy: string;
  /** The BI connection whose model to publish (connection id). */
  connectionId: string;
}

/**
 * Publish a single BI model as a MODEL-ONLY package (kind "dataset", zero
 * sheets): the .calp becomes the distribution unit for models — signed,
 * versioned, min-app-gated — instead of hand-carried .json files. Subscribing
 * materializes a live connection (schema only; the subscriber supplies their
 * own credentials, so row-level security is preserved).
 */
export function publishModel(params: PublishModelParams): Promise<PublishResponse> {
  return invokeBackend("calp_publish_model", { params });
}

/** One object connected to a package, resolved against the live workbook. */
export interface PackageObjectInfo {
  kind: string;
  id: string;
  name: string;
  /** Whether the object still exists in the workbook. */
  present: boolean;
  /** The sheet the object lives on, when resolvable. */
  sheetName: string;
}

export interface PackageSheetObjectInfo {
  localName: string;
  localSheetIndex: number | null;
}

export interface PackageObjectsResponse {
  packageName: string;
  resolvedVersion: string;
  registryUrl: string;
  sheets: PackageSheetObjectInfo[];
  objects: PackageObjectInfo[];
}

/** Which sheets and objects are connected to a subscribed package, and
 * whether each still exists in the live workbook (Package Explorer data). */
export function getPackageObjects(packageName: string): Promise<PackageObjectsResponse> {
  return invokeBackend("calp_get_package_objects", { packageName });
}

export async function pullPackage(params: PullParams): Promise<PullResponse> {
  const response = await invokeBackend<PullResponse>("calp_pull", { params });
  // Dispatch custom objects of non-built-in kinds to their frontend providers
  // (brick 4). Built-in kinds (cell types) were already materialized Rust-side.
  if (response.customObjects && response.customObjects.length > 0) {
    await materializePulledObjects(response.customObjects);
  }
  return response;
}

export function browseRegistry(registryPath: string): Promise<PackageInfo[]> {
  return invokeBackend("calp_browse_registry", { registryPath });
}

/** Inspect a package version's contents without materializing anything. */
export function inspectPackage(
  registryPath: string,
  packageName: string,
  versionPin: string,
): Promise<PackageInspection> {
  return invokeBackend("calp_inspect_package", { registryPath, packageName, versionPin });
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

export function refreshPreview(): Promise<RefreshPreview> {
  return invokeBackend("calp_refresh_preview");
}

export function refreshApply(): Promise<RefreshResult> {
  return invokeBackend("calp_refresh_apply");
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
  /** Declared value type, so the commit guard coerces input to the right type
   * instead of sniffing it from the string shape. */
  valueType?: "number" | "integer" | "text" | "date" | "boolean" | "enum";
  /** Whether the region's schema marks values required. */
  required?: boolean;
  /** Submission deadline (ISO 8601) for an until_deadline region. */
  deadline?: string;
  /** Name of a publisher-declared custom validator (advisory, subscriber-side;
   *  distribution brick 3). Run against typed input as an as-you-type check on
   *  top of the authoritative built-in schema. */
  customValidator?: string;
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
  /** Identifiers the publisher expects to respond (completion tracking). */
  expectedRespondents?: string[];
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
  /** Name of a custom validator (distribution brick 3). Rides the schema's
   *  forward-compatible `extra` map on the Rust side — advisory, subscriber-side
   *  UX check layered on the authoritative built-in constraints. */
  customValidator?: string;
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

/** Resolve the stable SheetId for a workbook sheet index. */
export function getSheetIdForIndex(sheetIndex: number): Promise<string> {
  return invokeBackend("calp_get_sheet_id", { sheetIndex });
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
  /** Publisher's approve/reject reason, adopted on reconcile (read-back). */
  reviewReason?: string | null;
  /** Publisher who decided, adopted on reconcile. */
  reviewedBy?: string | null;
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

/** Reconcile local submission states from the registry (the approved/rejected
 * read-back — the return leg of the writeback loop) and return the updated
 * layer. Submitted entries adopt their current registry state; unsent drafts
 * are untouched. This is how a subscriber learns the fate of what they sent. */
export function reconcileWriteback(): Promise<WritebackLayer> {
  return invokeBackend("calp_reconcile_writeback");
}

/** Submit all drafts for a region to the registry of the subscription that
 * declares the region. Returns count submitted. */
export function submitRegion(regionId: string): Promise<number> {
  return invokeBackend("calp_submit_region", { regionId });
}

/** Submit the drafts of EVERY writeback region that has any ("submit all").
 * Returns the total values submitted; surfaces the first region's error. */
export function submitAllRegions(): Promise<number> {
  return invokeBackend("calp_submit_all_regions");
}

/** One value that would leave the machine on submit. */
export interface OutboundValue {
  cellRow: number;
  cellCol: number;
  valueDisplay: string;
  valueKind: "number" | "text" | "boolean" | "empty";
}

/** A read-only preview of exactly what submitRegion would send — destination
 * package + registry, the submitter identity, and each draft value — so the
 * user can review what leaves the machine before it leaves. */
export interface OutboundSubmissionPreview {
  regionId: string;
  packageName: string;
  resolvedVersion: string;
  registryPath: string;
  submitterId: string;
  submitterName: string;
  values: OutboundValue[];
}

/** Preview an outbound writeback submission without sending it. */
export function previewRegionSubmission(
  regionId: string,
): Promise<OutboundSubmissionPreview> {
  return invokeBackend("calp_preview_region_submission", { regionId });
}

/** How to render a package version to self-contained HTML (recipient reach):
 *  `static` = a stacked, print-ready report; `viewer` = a multi-sheet tabbed
 *  viewer with embedded navigation. Both are single offline-openable .html. */
export type HtmlExportMode = "static" | "viewer";

/** Render a published package version to a self-contained HTML string that any
 *  browser/phone/Mac can open WITHOUT Calcula. */
export function exportPackageHtml(
  registryPath: string,
  packageName: string,
  version: string,
  mode: HtmlExportMode,
): Promise<string> {
  return invokeBackend("calp_export_package_html", {
    registryPath,
    packageName,
    version,
    mode,
  });
}

/** Approve, reject, or reset a submitted writeback value (publisher action). */
export function setSubmissionState(
  regionId: string,
  submitterId: string,
  cellRow: number,
  cellCol: number,
  newState: "approved" | "rejected" | "submitted",
  reason?: string | null,
): Promise<void> {
  return invokeBackend("calp_set_submission_state", {
    regionId,
    submitterId,
    cellRow,
    cellCol,
    newState,
    reason: reason ?? null,
  });
}

/** One submission row for the publisher data-collection dashboard (D5). */
export interface RegionSubmission {
  regionId: string;
  cellRow: number;
  cellCol: number;
  submitterId: string;
  submitterName: string;
  valueDisplay: string;
  valueKind: "number" | "text" | "boolean" | "empty";
  state: "draft" | "submitted" | "approved" | "rejected";
  submittedAt: string | null;
  updatedAt: string;
  /** Publisher's reason for the approve/reject decision (if any). */
  reviewReason?: string | null;
  /** Display name of the publisher who decided. */
  reviewedBy?: string | null;
}

/** Load every submission for a writeback region across all submitters — the
 *  publisher's "see all" view (D5). Not filtered by per-subscriber visibility. */
export function loadRegionSubmissions(regionId: string): Promise<RegionSubmission[]> {
  return invokeBackend("calp_load_region_submissions", { regionId });
}

/** Export every submission for a region as CSV text (publisher data-collection
 * output). The caller saves the returned string as a .csv file. */
export function exportRegionSubmissionsCsv(regionId: string): Promise<string> {
  return invokeBackend("calp_export_region_submissions_csv", { regionId });
}

/** Export every submission for a region as Parquet bytes (typed, columnar —
 * directly readable by DuckDB / Snowflake / Spark / pandas / Polars). The caller
 * saves the returned bytes as a .parquet file. */
export function exportRegionSubmissionsParquet(regionId: string): Promise<number[]> {
  return invokeBackend("calp_export_region_submissions_parquet", { regionId });
}

/** Whether the auto-materialized Parquet rollup is enabled for the package
 * owning this region (publisher opt-in, default off). */
export function getWritebackRollup(regionId: string): Promise<boolean> {
  return invokeBackend("calp_get_writeback_rollup", { regionId });
}

/** Publisher-only: enable/disable the auto-materialized Parquet rollup for the
 * package owning this region. Enabling writes the rollup immediately. */
export function setWritebackRollup(regionId: string, enabled: boolean): Promise<void> {
  return invokeBackend("calp_set_writeback_rollup", { regionId, enabled });
}

/** Completion-tracking status: declared expected respondents, who responded,
 * and who is still missing. */
export interface RegionResponseStatus {
  expected: string[];
  responded: string[];
  missing: string[];
}

/** Who has responded vs. who is still expected for a region. */
export function regionResponseStatus(regionId: string): Promise<RegionResponseStatus> {
  return invokeBackend("calp_region_response_status", { regionId });
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
  needsConfiguration: DataSourceNeedsConfig[];
}

/** Info about a data source in the current workbook. */
export interface DataSourceInfo {
  id: string;
  name: string;
  connectionType: string;
  server: string;
  database: string;
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
