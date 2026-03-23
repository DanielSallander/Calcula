//! FILENAME: app/src/api/distribution.ts
// PURPOSE: API facade for the Report Distribution system.
// CONTEXT: Provides TypeScript types and backend wrappers for package operations.
// Extensions import from here — never directly from @tauri-apps/api.

import { invokeBackend } from "./backend";

// ============================================================================
// Package Types (mirror Rust API types with camelCase)
// ============================================================================

/** Package metadata returned from parsing a .calp file. */
export interface PackageInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  tags: string[];
  contents: PackageContent[];
  dataSources: DataSourceDeclaration[];
  requiredExtensions: string[];
}

/** Describes one object included in a package. */
export interface PackageContent {
  type: "sheet" | "table" | "chart" | "pivot" | "file";
  path: string;
  name: string;
  description?: string;
}

/** Abstract data dependency declared by a package. */
export interface DataSourceDeclaration {
  id: string;
  name: string;
  description: string;
  type: "range" | "table" | "bi-connection";
  columns: DataSourceColumn[];
  internalRef: string;
}

/** Column schema for a data source. */
export interface DataSourceColumn {
  name: string;
  type: "text" | "number" | "date" | "boolean";
  required: boolean;
}

/** Result of importing a package. */
export interface ImportResult {
  importedSheets: string[];
  importedTables: string[];
  importedFiles: string[];
}

// ============================================================================
// Registry Provider Interface
// ============================================================================

/** Query parameters for searching a registry. */
export interface RegistryQuery {
  text?: string;
  tags?: string[];
  author?: string;
  offset: number;
  limit: number;
  sortBy?: "name" | "updated" | "downloads";
}

/** Search results from a registry. */
export interface RegistrySearchResult {
  packages: PackageInfo[];
  total: number;
}

/** Version info for a package. */
export interface VersionInfo {
  version: string;
  publishedAt: string;
  changelog?: string;
}

/** Update availability info. */
export interface UpdateInfo {
  latestVersion: string;
  changelog?: string;
}

/**
 * Registry provider interface.
 * Implement this to connect to different package sources (file share, Git, HTTP).
 */
export interface RegistryProvider {
  id: string;
  name: string;
  search(query: RegistryQuery): Promise<RegistrySearchResult>;
  getPackageInfo(packageId: string, version?: string): Promise<PackageInfo>;
  fetchPackage(packageId: string, version: string): Promise<string>;
  getVersions(packageId: string): Promise<VersionInfo[]>;
  checkForUpdate(packageId: string, currentVersion: string): Promise<UpdateInfo | null>;
}

// ============================================================================
// Provider Registry
// ============================================================================

const providers = new Map<string, RegistryProvider>();

/** Register a registry provider. */
export function registerRegistryProvider(provider: RegistryProvider): void {
  providers.set(provider.id, provider);
}

/** Unregister a registry provider. */
export function unregisterRegistryProvider(providerId: string): void {
  providers.delete(providerId);
}

/** Get all registered providers. */
export function getRegistryProviders(): RegistryProvider[] {
  return Array.from(providers.values());
}

/** Get a specific provider by ID. */
export function getRegistryProvider(providerId: string): RegistryProvider | undefined {
  return providers.get(providerId);
}

// ============================================================================
// Backend Commands (Tauri wrappers)
// ============================================================================

/** Parse a .calp file and return its metadata. */
export async function parsePackageInfo(path: string): Promise<PackageInfo> {
  return invokeBackend<PackageInfo>("parse_package_info", { path });
}

/** Browse a directory for .calp files. */
export async function browsePackages(directory: string): Promise<PackageInfo[]> {
  return invokeBackend<PackageInfo[]>("browse_packages", {
    request: { directory },
  });
}

/** Export selected objects as a .calp package. */
export async function exportAsPackage(request: {
  outputPath: string;
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  tags: string[];
  sheetIndices: number[];
  tableIds: number[];
  filePaths: string[];
  dataSources: DataSourceDeclaration[];
}): Promise<string> {
  return invokeBackend<string>("export_as_package", { request });
}

/** Import a .calp package into the current workbook. */
export async function importPackage(request: {
  path: string;
  sheetConflict: "rename" | "replace" | "skip";
  tableConflict: "rename" | "replace" | "skip";
  bindings: ImportBinding[];
}): Promise<ImportResult> {
  return invokeBackend<ImportResult>("import_package", { request });
}

/** Download a .calp file from an HTTP registry to a local temp path. */
export async function downloadPackage(
  url: string,
  packageId: string,
  version: string
): Promise<string> {
  return invokeBackend<string>("download_package", {
    request: { url, packageId, version },
  });
}

/** Result of publishing a package to a registry. */
export interface PublishResult {
  packageId: string;
  version: string;
  message: string;
}

/** Publish (upload) a .calp file to an HTTP registry. */
export async function publishPackage(
  filePath: string,
  registryUrl: string,
  authToken?: string
): Promise<PublishResult> {
  return invokeBackend<PublishResult>("publish_package", {
    request: { filePath, registryUrl, authToken: authToken ?? null },
  });
}

/** Data binding for import. */
export interface ImportBinding {
  sourceId: string;
  internalRef: string;
  targetType: "table" | "range";
  tableName?: string;
  sheetName?: string;
  startRow?: number;
  startCol?: number;
  endRow?: number;
  endCol?: number;
}
