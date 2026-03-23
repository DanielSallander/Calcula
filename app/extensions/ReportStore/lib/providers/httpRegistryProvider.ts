//! FILENAME: app/extensions/ReportStore/lib/providers/httpRegistryProvider.ts
// PURPOSE: Registry provider that connects to a Calcula Registry HTTP server.

import type {
  RegistryProvider,
  RegistryQuery,
  RegistrySearchResult,
  PackageInfo,
  VersionInfo,
  UpdateInfo,
} from "../../../../src/api/distribution";
import { downloadPackage } from "../../../../src/api/distribution";

/** Shape of the /search response from the registry server. */
interface SearchResponse {
  packages: RegistryPackageEntry[];
  total: number;
}

/** Shape of a package entry from the registry index/search. */
interface RegistryPackageEntry {
  id: string;
  name: string;
  description: string;
  author: string;
  tags: string[];
  latestVersion: string;
  versions: RegistryVersionEntry[];
}

/** Shape of a version entry from the registry. */
interface RegistryVersionEntry {
  version: string;
  publishedAt: string;
  size: number;
  path: string;
  contents: { type: string; name: string }[];
  dataSources: { id: string; name: string; type: string }[];
  requiredExtensions: string[];
}

/**
 * HttpRegistryProvider connects to a Calcula Registry server over HTTP.
 *
 * Endpoints used (matching calcula-registry spec):
 * - GET /search?q=<text>&tags=<t1,t2>&author=<name>&offset=0&limit=50
 * - GET /packages/{id}
 * - GET /packages/{id}/{version}
 * - GET /packages/{id}/{version}/download
 */
export class HttpRegistryProvider implements RegistryProvider {
  id: string;
  name: string;

  baseUrl: string;

  constructor(id: string, name: string, baseUrl: string) {
    this.id = id;
    this.name = name;
    // Strip trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /** Update the server URL. */
  setBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async search(query: RegistryQuery): Promise<RegistrySearchResult> {
    const params = new URLSearchParams();
    if (query.text) params.set("q", query.text);
    if (query.tags && query.tags.length > 0) params.set("tags", query.tags.join(","));
    if (query.author) params.set("author", query.author);
    params.set("offset", String(query.offset));
    params.set("limit", String(query.limit));

    const url = `${this.baseUrl}/search?${params.toString()}`;
    const response = await this.fetchJson<SearchResponse>(url);

    return {
      packages: response.packages.map((entry) => this.entryToPackageInfo(entry)),
      total: response.total,
    };
  }

  async getPackageInfo(packageId: string, version?: string): Promise<PackageInfo> {
    if (version) {
      const entry = await this.fetchJson<RegistryVersionEntry>(
        `${this.baseUrl}/packages/${encodeURIComponent(packageId)}/${encodeURIComponent(version)}`
      );
      // For a single version response, we need the parent package info too
      const parent = await this.fetchJson<RegistryPackageEntry>(
        `${this.baseUrl}/packages/${encodeURIComponent(packageId)}`
      );
      return this.versionToPackageInfo(parent, entry);
    }

    const entry = await this.fetchJson<RegistryPackageEntry>(
      `${this.baseUrl}/packages/${encodeURIComponent(packageId)}`
    );
    return this.entryToPackageInfo(entry);
  }

  async fetchPackage(packageId: string, version: string): Promise<string> {
    const url = `${this.baseUrl}/packages/${encodeURIComponent(packageId)}/${encodeURIComponent(version)}/download`;
    // Download via Rust backend (handles binary file + temp storage)
    return downloadPackage(url, packageId, version);
  }

  async getVersions(packageId: string): Promise<VersionInfo[]> {
    const entry = await this.fetchJson<RegistryPackageEntry>(
      `${this.baseUrl}/packages/${encodeURIComponent(packageId)}`
    );
    return entry.versions.map((v) => ({
      version: v.version,
      publishedAt: v.publishedAt,
    }));
  }

  async checkForUpdate(packageId: string, currentVersion: string): Promise<UpdateInfo | null> {
    try {
      const entry = await this.fetchJson<RegistryPackageEntry>(
        `${this.baseUrl}/packages/${encodeURIComponent(packageId)}?since=${encodeURIComponent(currentVersion)}`
      );
      if (entry.latestVersion && entry.latestVersion !== currentVersion) {
        return { latestVersion: entry.latestVersion };
      }
      return null;
    } catch {
      return null;
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private async fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Registry request failed: HTTP ${response.status} ${response.statusText}${text ? ` — ${text}` : ""}`
      );
    }
    return response.json();
  }

  /** Convert a full registry package entry to our PackageInfo (using latest version). */
  private entryToPackageInfo(entry: RegistryPackageEntry): PackageInfo {
    const latest = entry.versions.find((v) => v.version === entry.latestVersion)
      ?? entry.versions[entry.versions.length - 1];

    return {
      id: entry.id,
      name: entry.name,
      version: latest?.version ?? entry.latestVersion,
      description: entry.description,
      author: entry.author,
      tags: entry.tags,
      contents: (latest?.contents ?? []).map((c) => ({
        type: c.type as PackageInfo["contents"][0]["type"],
        path: "",
        name: c.name,
      })),
      dataSources: (latest?.dataSources ?? []).map((ds) => ({
        id: ds.id,
        name: ds.name,
        description: "",
        type: ds.type as "table" | "range" | "bi-connection",
        columns: [],
        internalRef: "",
      })),
      requiredExtensions: latest?.requiredExtensions ?? [],
    };
  }

  /** Convert a parent entry + specific version entry to PackageInfo. */
  private versionToPackageInfo(
    parent: RegistryPackageEntry,
    version: RegistryVersionEntry
  ): PackageInfo {
    return {
      id: parent.id,
      name: parent.name,
      version: version.version,
      description: parent.description,
      author: parent.author,
      tags: parent.tags,
      contents: (version.contents ?? []).map((c) => ({
        type: c.type as PackageInfo["contents"][0]["type"],
        path: "",
        name: c.name,
      })),
      dataSources: (version.dataSources ?? []).map((ds) => ({
        id: ds.id,
        name: ds.name,
        description: "",
        type: ds.type as "table" | "range" | "bi-connection",
        columns: [],
        internalRef: "",
      })),
      requiredExtensions: version.requiredExtensions ?? [],
    };
  }
}
