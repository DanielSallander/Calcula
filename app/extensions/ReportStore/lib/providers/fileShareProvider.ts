//! FILENAME: app/extensions/ReportStore/lib/providers/fileShareProvider.ts
// PURPOSE: Built-in registry provider that scans a local directory for .calp files.

import type {
  RegistryProvider,
  RegistryQuery,
  RegistrySearchResult,
  PackageInfo,
  VersionInfo,
  UpdateInfo,
} from "@api/distribution";
import { browsePackages, parsePackageInfo } from "@api/distribution";

/**
 * FileShareProvider scans a local directory for .calp package files.
 * This is the simplest provider — no server required, just a shared folder.
 */
export class FileShareProvider implements RegistryProvider {
  id = "file-share";
  name = "File Share";

  private directory: string;
  private cache: PackageInfo[] = [];

  constructor(directory: string) {
    this.directory = directory;
  }

  /** Update the directory path. */
  setDirectory(directory: string): void {
    this.directory = directory;
    this.cache = [];
  }

  async search(query: RegistryQuery): Promise<RegistrySearchResult> {
    // Refresh cache
    this.cache = await browsePackages(this.directory);

    let filtered = this.cache;

    // Text search
    if (query.text) {
      const lower = query.text.toLowerCase();
      filtered = filtered.filter(
        (p) =>
          p.name.toLowerCase().includes(lower) ||
          p.description.toLowerCase().includes(lower) ||
          p.id.toLowerCase().includes(lower)
      );
    }

    // Tag filter
    if (query.tags && query.tags.length > 0) {
      const queryTags = new Set(query.tags.map((t) => t.toLowerCase()));
      filtered = filtered.filter((p) =>
        p.tags.some((t) => queryTags.has(t.toLowerCase()))
      );
    }

    // Author filter
    if (query.author) {
      const authorLower = query.author.toLowerCase();
      filtered = filtered.filter((p) =>
        p.author.toLowerCase().includes(authorLower)
      );
    }

    // Sort
    if (query.sortBy === "name") {
      filtered.sort((a, b) => a.name.localeCompare(b.name));
    }

    // Paginate
    const total = filtered.length;
    const paged = filtered.slice(query.offset, query.offset + query.limit);

    return { packages: paged, total };
  }

  async getPackageInfo(packageId: string, _version?: string): Promise<PackageInfo> {
    if (this.cache.length === 0) {
      this.cache = await browsePackages(this.directory);
    }
    const pkg = this.cache.find((p) => p.id === packageId);
    if (!pkg) {
      throw new Error(`Package not found: ${packageId}`);
    }
    return pkg;
  }

  async fetchPackage(packageId: string, version: string): Promise<string> {
    // For file share, the package is already local — just return the path
    // Convention: filename is id-version.calp or we scan for it
    const pkg = await this.getPackageInfo(packageId, version);
    // The path is the directory + a filename derived from the package
    return `${this.directory}\\${pkg.id.replace(/\./g, "-")}-${pkg.version}.calp`;
  }

  async getVersions(packageId: string): Promise<VersionInfo[]> {
    // File share doesn't have versioning — return the single available version
    const pkg = await this.getPackageInfo(packageId);
    return [
      {
        version: pkg.version,
        publishedAt: new Date().toISOString(),
      },
    ];
  }

  async checkForUpdate(_packageId: string, _currentVersion: string): Promise<UpdateInfo | null> {
    // File share doesn't track updates
    return null;
  }
}
