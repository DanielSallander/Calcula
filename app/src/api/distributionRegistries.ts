//! FILENAME: app/src/api/distributionRegistries.ts
// PURPOSE: Saved-registry catalog for .calp distribution (distribution brick 1).
// CONTEXT: The backend now routes a registry LOCATION string by scheme — a
//          local path / file:// URL opens a LocalRegistry, an http(s):// URL
//          opens a read-only HttpRegistry. Any calp command that takes a
//          `registryPath` therefore already accepts a URL; this module adds a
//          per-machine catalog of known registries so the UI can offer a picker
//          instead of blind free-text entry. Stored in the profile dir (never
//          the workbook — a document must not carry your machine's registries).
// SECURITY: v1 HTTP registries are anonymous, read-only; no credentials are
//          stored. Pull integrity (signature + TOFU + per-artifact SHA-256) is
//          identical regardless of transport, so an HTTP registry can serve a
//          package but cannot forge a signature or tamper an artifact undetected.

import { invokeBackend } from "./backend";

/** One saved registry (mirrors Rust `SavedRegistry`). */
export interface SavedRegistry {
  id: string;
  name: string;
  /** A path, `file://…`, or `https://…` — anything the backend can open. */
  location: string;
}

/** Whether a location string denotes an HTTP(S) registry. */
export function isHttpRegistry(location: string): boolean {
  return location.startsWith("http://") || location.startsWith("https://");
}

/** List the machine's saved registries. */
export function listRegistries(): Promise<SavedRegistry[]> {
  return invokeBackend("calp_list_registries");
}

/** Add (or replace by id) a saved registry; returns the full list. */
export function addRegistry(registry: SavedRegistry): Promise<SavedRegistry[]> {
  return invokeBackend("calp_add_registry", { registry });
}

/** Remove a saved registry by id; returns the full list. */
export function removeRegistry(id: string): Promise<SavedRegistry[]> {
  return invokeBackend("calp_remove_registry", { id });
}
