// FILENAME: app/src/api/linkedSheets.ts
// PURPOSE: API facade for the Linked Sheet distribution system.
// CONTEXT: Provides TypeScript types and backend wrappers for linked sheet operations.
// Extensions import from here — never directly from @tauri-apps/api.

import { invokeBackend } from "./backend";

// ============================================================================
// Types (mirror Rust API types with camelCase)
// ============================================================================

/** Information about a published sheet available at a publication directory. */
export interface PublishedSheetInfo {
  id: string;
  name: string;
  description: string;
  version: number;
  publishedAt: string;
  checksum: string;
}

/** Published BI connection with parameterized connection string. */
export interface PublishedConnection {
  name: string;
  connectionType: string;
  connectionStringTemplate: string;
  modelPath?: string;
}

/** A connection parameter extracted from connection strings. */
export interface ConnectionParameter {
  name: string;
  description: string;
  secret: boolean;
}

/** Publish manifest — what's published at a directory. */
export interface PublishManifestInfo {
  formatVersion: number;
  name: string;
  publishedAt: string;
  publishedBy: string;
  sheets: PublishedSheetInfo[];
  connections: PublishedConnection[];
  parameters: ConnectionParameter[];
  /** Available environment names (e.g., ["DEV", "TEST", "PROD"]). */
  environments: string[];
}

/** BI connection info provided for publishing. */
export interface ConnectionInput {
  name: string;
  connectionType: string;
  connectionString: string;
  modelPath?: string;
}

/** Result of publishing sheets. */
export interface PublishSheetsResult {
  sheetsPublished: number;
  pubDir: string;
}

/** Result of linking sheets into the workbook. */
export interface LinkResult {
  linkedSheetIndices: number[];
  linkedSheetNames: string[];
}

/** Result of refreshing a linked sheet. */
export interface RefreshResult {
  sheetIndex: number;
  updated: boolean;
  oldVersion: number;
  newVersion: number;
  warnings: string[];
}

/** Sync state of a linked sheet. */
export type LinkState = "upToDate" | "stale" | "sourceUnavailable";

/** Status of a linked sheet. */
export interface LinkedSheetStatus {
  sheetIndex: number;
  state: LinkState;
  localVersion: number;
  remoteVersion: number | null;
  message: string;
}

/** Linked sheet info stored in the workbook. */
export interface LinkedSheetInfo {
  sheetIndex: number;
  publishedSheetId: string;
  syncedVersion: number;
  sourcePath: string;
  lastRefreshed: string;
}

// ============================================================================
// Author-side operations
// ============================================================================

/** Publish selected sheets from the current workbook to a publication directory. */
export async function publishSheets(
  pubDir: string,
  sheetIndices: number[],
  author: string,
  descriptions: string[] = [],
  connections: ConnectionInput[] = [],
  environments: Record<string, Record<string, string>> = {}
): Promise<PublishSheetsResult> {
  return invokeBackend<PublishSheetsResult>("publish_sheets", {
    request: { pubDir, sheetIndices, descriptions, author, connections, environments },
  });
}

/** Get information about what's already published at a directory. */
export async function getPublishInfo(
  pubDir: string
): Promise<PublishManifestInfo | null> {
  return invokeBackend<PublishManifestInfo | null>("get_publish_info", {
    pubDir,
  });
}

/** Remove a published sheet from the publication directory. */
export async function unpublishSheet(
  pubDir: string,
  sheetId: string
): Promise<void> {
  return invokeBackend<void>("unpublish_sheet", { pubDir, sheetId });
}

// ============================================================================
// Consumer-side operations
// ============================================================================

/** Browse published sheets available at a publication directory. */
export async function browsePublishedSheets(
  pubDir: string
): Promise<PublishedSheetInfo[]> {
  return invokeBackend<PublishedSheetInfo[]>("browse_published_sheets", {
    pubDir,
  });
}

/** Link published sheets into the current workbook. */
export async function linkPublishedSheets(
  pubDir: string,
  sheetIds: string[],
  environment?: string
): Promise<LinkResult> {
  return invokeBackend<LinkResult>("link_published_sheets", {
    request: { pubDir, sheetIds, environment },
  });
}

/** Refresh a single linked sheet from its published source. */
export async function refreshLinkedSheet(
  sheetIndex: number
): Promise<RefreshResult> {
  return invokeBackend<RefreshResult>("refresh_linked_sheet", { sheetIndex });
}

/** Refresh all linked sheets in the workbook. */
export async function refreshAllLinkedSheets(): Promise<RefreshResult[]> {
  return invokeBackend<RefreshResult[]>("refresh_all_linked_sheets", {});
}

/** Convert a linked sheet to a regular sheet (removes protection and metadata). */
export async function unlinkSheet(sheetIndex: number): Promise<void> {
  return invokeBackend<void>("unlink_sheet", { sheetIndex });
}

/** Check the sync status of a linked sheet. */
export async function getLinkedSheetStatus(
  sheetIndex: number
): Promise<LinkedSheetStatus> {
  return invokeBackend<LinkedSheetStatus>("get_linked_sheet_status", {
    sheetIndex,
  });
}

/** Get all linked sheets in the current workbook. */
export async function getLinkedSheets(): Promise<LinkedSheetInfo[]> {
  return invokeBackend<LinkedSheetInfo[]>("get_linked_sheets", {});
}
