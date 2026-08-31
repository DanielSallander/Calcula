//! FILENAME: app/src/api/distributionWorkspaces.ts
// PURPOSE: Saved-workspace catalog for .calp distribution (distribution brick 1).
// CONTEXT: The backend now routes a workspace LOCATION string by scheme — a
//          local path / file:// URL opens a LocalWorkspace, an http(s):// URL
//          opens a read-only HttpWorkspace. Any calp command that takes a
//          `registryPath` therefore already accepts a URL; this module adds a
//          per-machine catalog of known workspaces so the UI can offer a picker
//          instead of blind free-text entry. Stored in the profile dir (never
//          the workbook — a document must not carry your machine's workspaces).
// SECURITY: v1 HTTP workspaces are anonymous, read-only; no credentials are
//          stored. Pull integrity (signature + TOFU + per-artifact SHA-256) is
//          identical regardless of transport, so an HTTP workspace can serve an
//          application but cannot forge a signature or tamper an artifact undetected.

import { invokeBackend } from "./backend";

/** One saved workspace (mirrors Rust `SavedWorkspace`). */
export interface SavedWorkspace {
  id: string;
  name: string;
  /** A path, `file://…`, or `https://…` — anything the backend can open. */
  location: string;
}

/** Whether a location string denotes an HTTP(S) workspace. */
export function isHttpWorkspace(location: string): boolean {
  return location.startsWith("http://") || location.startsWith("https://");
}

/** List the machine's saved workspaces. */
export function listWorkspaces(): Promise<SavedWorkspace[]> {
  return invokeBackend("calp_list_workspaces");
}

/** Add (or replace by id) a saved workspace; returns the full list. */
export function addWorkspace(registry: SavedWorkspace): Promise<SavedWorkspace[]> {
  return invokeBackend("calp_add_workspace", { registry });
}

/** Remove a saved workspace by id; returns the full list. */
export function removeWorkspace(id: string): Promise<SavedWorkspace[]> {
  return invokeBackend("calp_remove_workspace", { id });
}
