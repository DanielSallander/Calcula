// FILENAME: app/src/api/distribution.ts
// PURPOSE: API facade for the .calp distribution system.
// CONTEXT: Extensions import from here — never directly from @tauri-apps/api.

import { invokeBackend } from "./backend";
import { AppEvents, emitAppEvent } from "./events";
import type {
  WritebackSubmissionNotice,
  WritebackSubmissionReceivedPayload,
} from "./events";
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
 * The manifest `kind` that makes a .calp usable as a SCRIPT LIBRARY — the same
 * string `library_commands.rs` (`LIBRARY_KIND`) and `@api/scriptLibraries`
 * (`LIBRARY_PACKAGE_KIND`) compare against. Re-stated here because this is the
 * publishing side: until now the package manager could CONSUME libraries and no
 * publish path could EMIT one, so a library author had no way to ship.
 */
export const LIBRARY_PACKAGE_KIND = "library";

export interface PublishLibraryParams {
  registryPath: string;
  packageName: string;
  version: string;
  publishedBy: string;
  /** Sheets to ship ALONGSIDE the modules (docs, examples). Omit for the normal
   *  case: a library is code, so it ships zero sheets. */
  sheetIndices?: number[];
}

/**
 * Publish this workbook's standalone module scripts as a `kind: "library"`
 * package — the authoring half of the script package manager.
 *
 * A library's payload is `modules/{id}.json`, not sheets, so this deliberately
 * defaults `sheetIndices` to `[]`. The backend honours that literally for the
 * library kind (`calp_publish`): every other kind reads an empty selection as
 * "all sheets", which for a library would ship the author's entire workbook —
 * data and all — to a shared registry as a side effect of publishing a function
 * library.
 *
 * Everything else is the ordinary publish path: same Ed25519 signature, same
 * TOFU identity, same version manifest, same artifact checksums. A library is
 * an ordinary package with a different `kind`, which is exactly why consuming
 * one needs no second trust root.
 */
export function publishLibrary(params: PublishLibraryParams): Promise<PublishResponse> {
  return publishPackage({
    registryPath: params.registryPath,
    packageName: params.packageName,
    version: params.version,
    kind: LIBRARY_PACKAGE_KIND,
    sheetIndices: params.sheetIndices ?? [],
    publishedBy: params.publishedBy,
  });
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

/**
 * Dispatch a pull's custom objects of non-built-in kinds to their frontend
 * providers (brick 4). Built-in kinds (cell types) were already materialized
 * Rust-side.
 *
 * Exported because there are now TWO callers: `pullPackage` (the Subscribe
 * dialog's path) and the script broker's `cap.pkgPull` handler, which receives
 * the very same `PullResponse` from the Rust distribution gateway. One
 * implementation on purpose — a second copy is how a scripted pull would start
 * quietly dropping the objects an interactive pull materializes.
 */
export async function applyPulledCustomObjects(response: PullResponse): Promise<void> {
  if (response.customObjects && response.customObjects.length > 0) {
    await materializePulledObjects(response.customObjects);
  }
}

export async function pullPackage(params: PullParams): Promise<PullResponse> {
  const response = await invokeBackend<PullResponse>("calp_pull", { params });
  await applyPulledCustomObjects(response);
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

export interface ResetSubscriptionResponse {
  sheetsReset: number;
  overridesCleared: number;
  pivotsReset: number;
  resolvedVersion: string;
}

/**
 * Reset a subscription's sheets to the pristine published content of the
 * currently resolved version, discarding local edits (cells, formatting,
 * sizes, merges, overrides) on those sheets AND restoring the package's
 * published pivot definitions (layout changes revert). One undo step.
 */
export function resetSubscription(
  registryUrl: string,
  packageName: string,
): Promise<ResetSubscriptionResponse> {
  return invokeBackend("calp_reset_subscription", {
    params: { registryUrl, packageName },
  });
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

/**
 * App event fired whenever the writeback region index is re-read (subscribe,
 * refresh, detach, region designation). Anything holding a cached copy of the
 * index listens for it — notably the script host, which uses its own copy to
 * route a script's grid write into the same validated draft path a human
 * keystroke takes without paying one IPC per cell.
 */
export const WRITEBACK_INDEX_CHANGED_EVENT = "distribution:writeback-index-changed";

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
  /** The validator's JS function-expression BODY, published alongside the name.
   *  Required whenever `customValidator` is set: the subscriber's machine has
   *  no catalogue of the publisher's validators, so the name alone cannot be
   *  run — and the Rust submit gate FAILS CLOSED on a name without a body
   *  ("declares the custom validator '…' but ships no validator code"). Always
   *  set both together via `writebackValidatorSchemaExtra(name)`. */
  customValidatorSource?: string;
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
  /** The publisher-shipped custom validator that WILL judge this submission,
   *  when the region declares one. The body is read from the Ed25519-verified
   *  manifest, so what the user reviews here is byte-identical to what the
   *  backend executes. Mirrors `OutboundValidator` in calp_commands.rs. */
  validator?: {
    name: string;
    source: string;
    sourceHash: string;
    consented: boolean;
  };
  /** Set when the region declares a validator NAME but the package ships no
   *  BODY for it — the submission WILL be refused (fail-closed) until the
   *  publisher republishes with the validator body included. */
  validatorError?: string;
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

/** Approve, reject, or reset a submitted writeback value (publisher action).
 * Pass the `submissionId` shown in the dashboard so the decision targets
 * exactly the reviewed submission — if a newer one arrived in the meantime the
 * backend refuses with a "superseded" error instead of deciding blind. */
export function setSubmissionState(
  regionId: string,
  submitterId: string,
  cellRow: number,
  cellCol: number,
  newState: "approved" | "rejected" | "submitted",
  reason?: string | null,
  submissionId?: string | null,
): Promise<void> {
  return invokeBackend("calp_set_submission_state", {
    regionId,
    submitterId,
    cellRow,
    cellCol,
    newState,
    reason: reason ?? null,
    submissionId: submissionId ?? null,
  });
}

/** One submission row for the publisher data-collection dashboard (D5). */
export interface RegionSubmission {
  /** The submission event id this row shows — pass back on approve/reject. */
  submissionId: string;
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
// Submission watch (§5.5): the honest push behind WRITEBACK_SUBMISSION_RECEIVED
// ============================================================================
//
// THE PROBLEM. A subscriber submits by APPENDING to a registry on disk (or a
// share) from THEIR machine. The publisher's Calcula is not in that path and
// receives nothing — so until now a publisher learned about answers by opening
// the Responses pane and looking, and a script could not react at all.
//
// WHAT A REAL PUSH WOULD NEED, and why it does not exist: an OS file watcher on
// the registry, plus a way to know which of its thousands of files matter. The
// registry is an append-only event log that Rust folds on read; there is no
// change feed, no sequence cursor, and no per-region "latest" marker to watch.
// So a true push is not available, and inventing an event that never fires
// would be worse than none.
//
// WHAT THIS IS INSTEAD, stated plainly: a POLL, wearing an event. It is
// acceptable here only because all three of these hold:
//
//  1. DEMAND-DRIVEN. Nothing polls until something subscribes. The script host
//     acquires a watch when a script subscribes to the event and releases it at
//     unmount; the Responses pane acquires one while it is open. Refcount zero
//     = timer cleared = zero cost, which is the default state of every workbook.
//  2. BOUNDED. One pass every SUBMISSION_POLL_INTERVAL_MS, sequential, one IPC
//     per PUBLISHER-OWNED region. A region that refuses the publisher gate is
//     recorded and never polled again this session, so a subscriber-only
//     workbook settles at ONE region-list call per interval and no inbox reads.
//     Passes never overlap (a slow pass skips the next tick).
//  3. DISCLOSED. getSubmissionWatchStatus() reports the refcount, the interval,
//     which regions are watched, when the last pass ran and what it cost, so the
//     poll can be shown to the user rather than merely documented here.
//
// AUTHORIZATION IS NOT THIS FILE'S. Every inbox read goes through
// calp_load_region_submissions, which re-proves Ed25519 publisher-key
// possession in Rust on every call. The watcher cannot see a submission the
// caller was not already entitled to fetch by hand.

/** How often a pass runs while at least one watcher is registered. */
export const SUBMISSION_POLL_INTERVAL_MS = 60_000;

/** Per-event cap on the `submissions` array (the count is always exact). */
export const MAX_REPORTED_SUBMISSIONS = 50;

/** Live state of the submission watch, for disclosure surfaces. */
export interface SubmissionWatchStatus {
  /** How many holders currently want the watch (0 = nothing is polling). */
  refCount: number;
  running: boolean;
  intervalMs: number;
  /** Regions polled on the last pass (publisher-owned ones only). */
  watchedRegionIds: string[];
  /** Regions skipped for the rest of the session: not published by this
   *  machine, so their inbox is not ours to read. */
  skippedRegionIds: string[];
  /** ISO 8601 timestamp of the last completed pass, or null. */
  lastPollAt: string | null;
  /** Backend calls the last pass made (1 region list + 1 per watched region). */
  lastPollCalls: number;
  /** Failure of the last pass, if any (never thrown — a poll must not break
   *  the app, and a permanently failing poll must be visible, not silent). */
  lastError: string | null;
}

let watchRefCount = 0;
let watchTimer: ReturnType<typeof setInterval> | null = null;
/** The pass currently running, so two never overlap (a slow pass makes the next
 *  tick a no-op rather than stacking a second walk of the registry). */
let inFlightPass: Promise<void> | null = null;
/** regionId -> submission ids already reported (replaced each pass, so this is
 *  bounded by the region's live slot count rather than by history). */
const seenSubmissionIds = new Map<string, Set<string>>();
/** Regions whose inbox this machine may not read (not the publisher). */
const nonPublisherRegions = new Set<string>();
let lastPollAt: string | null = null;
let lastPollCalls = 0;
let lastWatchError: string | null = null;
let watchedRegionIds: string[] = [];

/** True when the failure is the publisher gate refusing, rather than a
 *  transient I/O problem. Only this class disables a region for the session —
 *  a missing network share must be retried, a missing signing key never
 *  succeeds. Mirrors require_publisher's message in calp_commands.rs. */
function isPublisherRefusal(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /only the publisher of/i.test(msg) || /can view or manage its writeback submissions/i.test(msg);
}

/**
 * Run ONE pass. `announce` false primes the seen-sets without emitting — used
 * on the first pass after the watch starts, because "this submission exists"
 * is not "this submission just arrived", and a publisher whose script starts
 * on a full inbox must not be told the whole history is new.
 */
async function doSubmissionPass(announce: boolean): Promise<void> {
  let calls = 0;
  // Pass-local, then published once at the end. Assigning lastWatchError as we
  // go and clearing it on success loses a per-region failure the moment any
  // other region succeeds — which is exactly the case worth reporting.
  let passError: string | null = null;
  try {
    const regions = await getWritebackRegions();
    calls += 1;
    const liveRegionIds = new Set(regions.map((r) => r.regionId));
    // Forget state for regions that no longer exist (unsubscribed package).
    for (const id of [...seenSubmissionIds.keys()]) {
      if (!liveRegionIds.has(id)) seenSubmissionIds.delete(id);
    }
    for (const id of [...nonPublisherRegions]) {
      if (!liveRegionIds.has(id)) nonPublisherRegions.delete(id);
    }

    const watched: string[] = [];
    for (const region of regions) {
      const regionId = region.regionId;
      if (nonPublisherRegions.has(regionId)) continue;
      let rows: RegionSubmission[];
      try {
        rows = await loadRegionSubmissions(regionId);
        calls += 1;
      } catch (err) {
        calls += 1;
        if (isPublisherRefusal(err)) {
          // Not ours to read. Record it so this is a one-time cost per region.
          nonPublisherRegions.add(regionId);
          seenSubmissionIds.delete(regionId);
        } else {
          passError = err instanceof Error ? err.message : String(err);
        }
        continue;
      }
      watched.push(regionId);

      // Only "submitted" counts as ARRIVED. An approve/reject is the
      // publisher's own action and re-folds to a new record; announcing it
      // would tell a publisher their own click was an incoming answer.
      const current = new Set<string>();
      const fresh: WritebackSubmissionNotice[] = [];
      const previous = seenSubmissionIds.get(regionId);
      for (const row of rows) {
        if (row.state !== "submitted") continue;
        current.add(row.submissionId);
        if (announce && previous && !previous.has(row.submissionId)) {
          fresh.push({
            submissionId: row.submissionId,
            submitterId: row.submitterId,
            submitterName: row.submitterName,
            cellRow: row.cellRow,
            cellCol: row.cellCol,
            submittedAt: row.submittedAt ?? null,
          });
        }
      }
      // Replacing (not merging) keeps this bounded by the live slot count.
      seenSubmissionIds.set(regionId, current);

      if (fresh.length > 0) {
        const payload: WritebackSubmissionReceivedPayload = {
          regionId,
          count: fresh.length,
          submissions: fresh.slice(0, MAX_REPORTED_SUBMISSIONS),
          truncated: fresh.length > MAX_REPORTED_SUBMISSIONS,
          observedAt: new Date().toISOString(),
        };
        emitAppEvent(AppEvents.WRITEBACK_SUBMISSION_RECEIVED, payload);
      }
    }
    watchedRegionIds = watched;
  } catch (err) {
    // A poll must never break the caller. It must also never fail invisibly —
    // that is what lastError and the disclosure surface are for.
    passError = err instanceof Error ? err.message : String(err);
  } finally {
    lastWatchError = passError;
    lastPollCalls = calls;
    lastPollAt = new Date().toISOString();
  }
}

/** Start a pass, or join the one already running. Never two at once. */
function runSubmissionPass(announce: boolean): Promise<void> {
  if (inFlightPass) return inFlightPass;
  const pass = doSubmissionPass(announce).finally(() => {
    inFlightPass = null;
  });
  inFlightPass = pass;
  return pass;
}

/** Resolve when no pass is running. The priming pass a watch starts is
 *  fire-and-forget by design (acquiring must not block a subscription); this is
 *  how a caller — or a test — waits for it. */
export function whenSubmissionWatchSettled(): Promise<void> {
  return inFlightPass ?? Promise.resolve();
}

/**
 * Register interest in WRITEBACK_SUBMISSION_RECEIVED and start the poll if this
 * is the first holder. Returns a release function; the watch stops when the
 * last holder releases. The release is idempotent, so a cleanup array that runs
 * twice cannot drive the count negative and strand the timer.
 */
export function acquireSubmissionWatch(): () => void {
  watchRefCount += 1;
  if (watchRefCount === 1) {
    // Prime first (no announcements), then poll on the interval.
    void runSubmissionPass(false);
    watchTimer = setInterval(() => {
      void runSubmissionPass(true);
    }, SUBMISSION_POLL_INTERVAL_MS);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    watchRefCount = Math.max(0, watchRefCount - 1);
    if (watchRefCount === 0 && watchTimer !== null) {
      clearInterval(watchTimer);
      watchTimer = null;
      watchedRegionIds = [];
    }
  };
}

/** Disclosure: exactly what the submission watch is doing and what it costs. */
export function getSubmissionWatchStatus(): SubmissionWatchStatus {
  return {
    refCount: watchRefCount,
    running: watchTimer !== null,
    intervalMs: SUBMISSION_POLL_INTERVAL_MS,
    watchedRegionIds: [...watchedRegionIds],
    skippedRegionIds: [...nonPublisherRegions],
    lastPollAt,
    lastPollCalls,
    lastError: lastWatchError,
  };
}

/**
 * Run a pass NOW without waiting for the interval — used by the Responses pane
 * so "Refresh" also advances the watch, and by tests. Announces like a normal
 * pass (the priming pass has already happened if a watch is held).
 */
export function pollSubmissionsNow(): Promise<void> {
  return runSubmissionPass(watchRefCount > 0);
}

/** Test/reset hook: drop every watcher, timer and remembered id. */
export function resetSubmissionWatch(): void {
  if (watchTimer !== null) clearInterval(watchTimer);
  watchTimer = null;
  watchRefCount = 0;
  inFlightPass = null;
  seenSubmissionIds.clear();
  nonPublisherRegions.clear();
  watchedRegionIds = [];
  lastPollAt = null;
  lastPollCalls = 0;
  lastWatchError = null;
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

// ============================================================================
// Package Inspector (standalone window) — read-only deep inspection of a
// published package version. Nothing is subscribed or materialized; every
// call re-verifies the manifest signature + TOFU pin, and artifacts are only
// readable via the signed manifest's checksum keys.
// ============================================================================

export interface InspectorVersionEntry {
  version: string;
  publishedAt: string;
  publishedBy: string;
}

export interface InspectorPackageInfo {
  name: string;
  description: string;
  kind: string;
  author: string;
  created: string;
  versions: InspectorVersionEntry[];
}

export interface InspectorManifestInfo {
  formatVersion: number;
  kind: string;
  publishedAt: string;
  publishedBy: string;
  publisherName: string;
  /** Lowercase hex Ed25519 public key of the verified signer. */
  publisherKey: string;
  minAppVersion: string;
  /** "firstUse" | "verified" (TOFU outcome for this inspection). */
  trustStatus: string;
  /** Whether THIS machine holds the publisher signing key. */
  isPublisher: boolean;
  artifactCount: number;
}

export interface InspectorSheetSummary {
  sheetId: string;
  name: string;
  description: string;
  cellCount: number;
  formulaCount: number;
  mergedCount: number;
  noteCount: number;
  hyperlinkCount: number;
  hiddenRowCount: number;
  hiddenColCount: number;
  hasFreeze: boolean;
  tabColor: string;
  visibility: string;
  hasPageSetup: boolean;
  showGridlines: boolean;
}

export interface InspectorTableInfo {
  id: string;
  name: string;
  sheetName: string;
  range: string;
  columns: string[];
}

export interface InspectorNamedRangeInfo {
  name: string;
  refersTo: string;
  sheetName: string | null;
}

export interface InspectorChartInfo {
  id: string;
  sheetName: string;
  title: string | null;
}

export interface InspectorPivotInfo {
  id: string;
  sourceType: string;
  name: string | null;
}

export interface InspectorSlicerInfo {
  name: string;
  sheetName: string;
  fieldName: string;
}

export interface InspectorPaneControlInfo {
  id: string;
  name: string;
  controlType: string;
}

export interface InspectorRibbonFilterInfo {
  name: string;
  fieldName: string;
}

export interface InspectorPivotLayoutInfo {
  name: string;
  sourceType: string;
  description: string | null;
}

export interface InspectorCustomObjectInfo {
  kind: string;
  id: string;
  name: string;
  sheetName: string | null;
  payloadPath: string;
}

export interface InspectorObjectScriptInfo {
  id: string;
  name: string;
  objectType: string;
  instanceId: string | null;
  description: string | null;
  /** R19 declared-capability ceiling from the SIGNED manifest. */
  capabilities: string[];
}

export interface InspectorModuleScriptInfo {
  id: string;
  name: string;
  scope: string;
  description: string | null;
}

export interface InspectorNotebookInfo {
  id: string;
  name: string;
  cellCount: number;
}

export interface InspectorBindingInfo {
  modelTable: string;
  schema: string;
  sourceTable: string;
  hasQuery: boolean;
}

export interface InspectorSnapshotRef {
  table: string;
  path: string;
}

export interface InspectorDataSourceInfo {
  id: string;
  name: string;
  connectionType: string;
  server: string;
  database: string;
  modelPath: string;
  bindings: InspectorBindingInfo[];
  calculatedTableSnapshots: InspectorSnapshotRef[];
  hasWritebackHistory: boolean;
}

export interface InspectorArtifactEntry {
  path: string;
  sha256: string;
}

export interface InspectorOverview {
  package: InspectorPackageInfo;
  resolvedVersion: string;
  manifest: InspectorManifestInfo;
  sheets: InspectorSheetSummary[];
  tables: InspectorTableInfo[];
  namedRanges: InspectorNamedRangeInfo[];
  charts: InspectorChartInfo[];
  sparklineSheets: string[];
  pivots: InspectorPivotInfo[];
  slicers: InspectorSlicerInfo[];
  paneControls: InspectorPaneControlInfo[];
  ribbonFilters: InspectorRibbonFilterInfo[];
  pivotLayouts: InspectorPivotLayoutInfo[];
  conditionalFormatSheets: string[];
  dataValidationSheets: string[];
  controlSheets: string[];
  commentSheets: string[];
  scenarioSheets: string[];
  outlineSheets: string[];
  hasTheme: boolean;
  themeName: string | null;
  extensionDataKeys: string[];
  customObjects: InspectorCustomObjectInfo[];
  objectScripts: InspectorObjectScriptInfo[];
  /** Excludes the reserved Custom Functions library module (see
   * customFunctionCount). */
  moduleScripts: InspectorModuleScriptInfo[];
  notebooks: InspectorNotebookInfo[];
  /** Functions in the reserved Custom Functions library, 0 when absent. */
  customFunctionCount: number;
  dataSources: InspectorDataSourceInfo[];
  writebackRegionCount: number;
  modelWritebackCount: number;
  lockedSheetCount: number;
  lockedCellCount: number;
  artifacts: InspectorArtifactEntry[];
}

export interface InspectorCell {
  a1: string;
  row: number;
  col: number;
  /** "s" | "n" | "b" | "e" | "l" | "d" | "x". */
  cellType: string;
  display: string;
  /** Formula WITHOUT the leading '='. */
  formula: string | null;
  styleIndex: number | null;
  hasRichText: boolean;
}

export interface InspectorUsedRange {
  minRow: number;
  maxRow: number;
  minCol: number;
  maxCol: number;
}

export interface InspectorMergedRegion {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export interface InspectorSheetMetadata {
  mergedRegions: InspectorMergedRegion[];
  freezeRow: number | null;
  freezeCol: number | null;
  hiddenRowCount: number;
  hiddenColCount: number;
  tabColor: string;
  visibility: string;
  noteCount: number;
  hyperlinkCount: number;
  hasPageSetup: boolean;
  showGridlines: boolean;
}

export interface InspectorSheetDetail {
  sheetId: string;
  name: string;
  cells: InspectorCell[];
  totalCellCount: number;
  formulaCount: number;
  truncated: boolean;
  usedRange: InspectorUsedRange | null;
  columnWidths: Record<string, number>;
  rowHeights: Record<string, number>;
  styleCount: number;
  styledCellCount: number;
  metadata: InspectorSheetMetadata;
}

export interface InspectorObjectScriptDetail {
  id: string;
  name: string;
  objectType: string;
  instanceId: string | null;
  description: string | null;
  capabilities: string[];
  source: string;
}

export interface InspectorModuleScriptDetail {
  id: string;
  name: string;
  scope: string;
  description: string | null;
  source: string;
}

export interface InspectorNotebookCell {
  id: string;
  source: string;
}

export interface InspectorNotebookDetail {
  id: string;
  name: string;
  cells: InspectorNotebookCell[];
}

export interface InspectorCustomFunctions {
  functionNames: string[];
  capabilities: string[];
}

export interface InspectorScripts {
  objectScripts: InspectorObjectScriptDetail[];
  moduleScripts: InspectorModuleScriptDetail[];
  notebooks: InspectorNotebookDetail[];
  customFunctions: InspectorCustomFunctions | null;
}

export interface InspectorModelColumn {
  name: string;
  dataType: string;
}

export interface InspectorModelTable {
  name: string;
  columns: InspectorModelColumn[];
}

export interface InspectorModelMeasure {
  name: string;
  /** Measure group, when the model organizes measures into groups. */
  group: string | null;
  expression: string;
}

export interface InspectorModelRelationship {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

export interface InspectorSnapshotDetail {
  table: string;
  path: string;
  sizeBytes: number;
}

export interface InspectorModel {
  dataSourceId: string;
  name: string;
  modelFormatVersion: number | null;
  tables: InspectorModelTable[];
  measures: InspectorModelMeasure[];
  relationships: InspectorModelRelationship[];
  calculatedColumnCount: number;
  hierarchyCount: number;
  calculationGroupCount: number;
  kpiCount: number;
  securityRoleCount: number;
  globalVariableCount: number;
  scriptFunctionCount: number;
  contextCount: number;
  dateTable: string | null;
  calculatedTableSnapshots: InspectorSnapshotDetail[];
  hasWritebackHistory: boolean;
}

export interface InspectorWritebackRegion {
  id: string;
  sheetName: string;
  range: string;
  mode: string | null;
  valueType: string | null;
  visibility: string | null;
  submissionPolicy: string | null;
  versionBinding: string | null;
  lifecycle: string | null;
  aggregationHint: string | null;
  expectedRespondents: string[];
}

export interface InspectorModelWriteback {
  id: string;
  dataSourceId: string;
  table: string;
  column: string;
  keyColumns: string[];
  kind: string;
  valueType: string | null;
  allowedEditors: string[];
  submissionPolicy: string | null;
}

export interface InspectorRegionStats {
  regionId: string;
  submissionCount: number;
  submitterCount: number;
  approved: number;
  rejected: number;
  pending: number;
}

export interface InspectorSubmissionDetail {
  regionId: string;
  submitterName: string;
  cellRow: number;
  cellCol: number;
  modelKey: string[] | null;
  valueDisplay: string;
  valueKind: string;
  state: string;
  updatedAt: string;
  /** Publisher's approve/reject feedback, when a decision exists. */
  reviewReason: string | null;
  reviewedBy: string | null;
}

export interface InspectorWriteback {
  regions: InspectorWritebackRegion[];
  modelWritebacks: InspectorModelWriteback[];
  /** Response activity (stats, counts, values, rollup) is PUBLISHER-ONLY —
   * even aggregates would bypass a region's visibility policy. Empty/zero
   * unless this machine holds the signing key. */
  regionStats: InspectorRegionStats[];
  totalSubmissions: number;
  reviewEventCount: number;
  isPublisher: boolean;
  submissions: InspectorSubmissionDetail[];
  /** Derived Parquet rollup at submissions/_rollup.parquet (publisher-only). */
  rollupPresent: boolean;
  rollupSizeBytes: number | null;
}

export interface InspectorArtifact {
  path: string;
  sizeBytes: number;
  sha256: string;
  expectedSha256: string;
  verified: boolean;
  /** "json" | "text" | "binary". */
  contentKind: string;
  text: string | null;
  truncated: boolean;
}

export interface InspectorArtifactVerification {
  path: string;
  /** "ok" | "mismatch" | "missing". */
  status: string;
  sizeBytes: number;
}

export interface InspectorVerifyReport {
  signatureOk: boolean;
  trustStatus: string;
  publisherName: string;
  artifacts: InspectorArtifactVerification[];
  unlisted: string[];
  allOk: boolean;
}

export interface ResolvedRegistryLocation {
  /** The registry ROOT to browse (walked up from whatever was picked). */
  registryPath: string;
  /** Set when the picked folder was a package (or version) directory. */
  packageName: string | null;
  /** Set when the picked folder was a specific version directory. */
  version: string | null;
}

/** Walk a picked folder up to its registry root (package/version dirs are
 * recognized and pre-selected). Unrecognized paths pass through unchanged. */
export function inspectorResolveLocation(path: string): Promise<ResolvedRegistryLocation> {
  return invokeBackend("calp_inspector_resolve_location", { path });
}

/** Deep overview of a package version (Package Inspector landing payload). */
export function inspectorOverview(
  registryPath: string,
  packageName: string,
  versionPin: string,
): Promise<InspectorOverview> {
  return invokeBackend("calp_inspector_overview", { registryPath, packageName, versionPin });
}

/** Full cell-level view of one published sheet. */
export function inspectorSheet(
  registryPath: string,
  packageName: string,
  versionPin: string,
  sheetId: string,
  maxCells?: number,
): Promise<InspectorSheetDetail> {
  return invokeBackend("calp_inspector_sheet", {
    registryPath,
    packageName,
    versionPin,
    sheetId,
    maxCells: maxCells ?? null,
  });
}

/** Every line of code the package carries, with full source. */
export function inspectorScripts(
  registryPath: string,
  packageName: string,
  versionPin: string,
): Promise<InspectorScripts> {
  return invokeBackend("calp_inspector_scripts", { registryPath, packageName, versionPin });
}

/** Summary of one embedded BI model (schema only, never credentials). */
export function inspectorModel(
  registryPath: string,
  packageName: string,
  versionPin: string,
  dataSourceId: string,
): Promise<InspectorModel> {
  return invokeBackend("calp_inspector_model", {
    registryPath,
    packageName,
    versionPin,
    dataSourceId,
  });
}

/** Writeback declarations + folded post-publish response activity. */
export function inspectorWriteback(
  registryPath: string,
  packageName: string,
  versionPin: string,
): Promise<InspectorWriteback> {
  return invokeBackend("calp_inspector_writeback", { registryPath, packageName, versionPin });
}

/** Raw view of one signed artifact (pretty JSON / text / binary summary). */
export function inspectorArtifact(
  registryPath: string,
  packageName: string,
  versionPin: string,
  artifactPath: string,
): Promise<InspectorArtifact> {
  return invokeBackend("calp_inspector_artifact", {
    registryPath,
    packageName,
    versionPin,
    artifactPath,
  });
}

/** Full integrity audit: per-artifact hash verification report. */
export function inspectorVerifyArtifacts(
  registryPath: string,
  packageName: string,
  versionPin: string,
): Promise<InspectorVerifyReport> {
  return invokeBackend("calp_inspector_verify_artifacts", {
    registryPath,
    packageName,
    versionPin,
  });
}
