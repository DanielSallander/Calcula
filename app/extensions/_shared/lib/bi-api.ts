//! FILENAME: app/extensions/BusinessIntelligence/lib/bi-api.ts
// PURPOSE: Extension-facing API wrappers around backend BI commands.
// CONTEXT: Multi-connection model. Extensions call these instead of
//          backend.ts directly for caching, post-processing, and event emission.

import {
  biCreateConnection as apiCreateConnection,
  biDeleteConnection as apiDeleteConnection,
  biUpdateConnection as apiUpdateConnection,
  biGetConnections as apiGetConnections,
  biGetConnection as apiGetConnection,
  biConnect as apiConnect,
  biDisconnect as apiDisconnect,
  biBindTable as apiBindTable,
  biQuery as apiQuery,
  biInsertResult as apiInsertResult,
  biRefreshConnection as apiRefreshConnection,
  biRefreshAllInMemory as apiRefreshAllInMemory,
  biGetModelInfo as apiGetModelInfo,
  biSetActiveRole as apiSetActiveRole,
  biGetActiveRole as apiGetActiveRole,
  biGetRegionAtCell as apiGetRegionAtCell,
} from "@api/backend";

import type {
  ConnectionInfo,
  CreateConnectionRequest,
  UpdateConnectionRequest,
  BiModelInfo,
  BiBindRequest,
  BiQueryRequest,
  BiQueryResult,
  BiInsertRequest,
  BiInsertResponse,
  BiRegionInfo,
} from "@api/backend";

// ---------------------------------------------------------------------------
// Cached state
// ---------------------------------------------------------------------------

let cachedConnections: ConnectionInfo[] | null = null;
let cachedQueryResult: BiQueryResult | null = null;
let cachedQueryRequest: BiQueryRequest | null = null;
let cachedActiveConnectionId: string | null = null;

export function getCachedConnections(): ConnectionInfo[] | null {
  return cachedConnections;
}

export function getCachedQueryResult(): BiQueryResult | null {
  return cachedQueryResult;
}

export function getCachedQueryRequest(): BiQueryRequest | null {
  return cachedQueryRequest;
}

export function getCachedActiveConnectionId(): string | null {
  return cachedActiveConnectionId;
}

export function setCachedActiveConnectionId(id: string | null): void {
  cachedActiveConnectionId = id;
}

// ---------------------------------------------------------------------------
// Connection Management
// ---------------------------------------------------------------------------

export async function createConnection(
  request: CreateConnectionRequest,
): Promise<ConnectionInfo> {
  const conn = await apiCreateConnection(request);
  cachedConnections = null; // invalidate
  return conn;
}

export async function deleteConnection(connectionId: string): Promise<void> {
  await apiDeleteConnection(connectionId);
  cachedConnections = null;
  if (cachedActiveConnectionId === connectionId) {
    cachedActiveConnectionId = null;
  }
}

export async function updateConnection(
  request: UpdateConnectionRequest,
): Promise<ConnectionInfo> {
  const conn = await apiUpdateConnection(request);
  cachedConnections = null;
  return conn;
}

export async function getConnections(): Promise<ConnectionInfo[]> {
  const connections = await apiGetConnections();
  cachedConnections = connections;
  return connections;
}

export async function getConnection(
  connectionId: string,
): Promise<ConnectionInfo> {
  return apiGetConnection(connectionId);
}

// ---------------------------------------------------------------------------
// Connect / Disconnect / Bind
// ---------------------------------------------------------------------------

export async function connect(
  connectionId: string,
  remember?: boolean,
): Promise<ConnectionInfo> {
  const conn = await apiConnect({ connectionId, remember });
  cachedConnections = null;
  return conn;
}

export async function disconnect(connectionId: string): Promise<ConnectionInfo> {
  const conn = await apiDisconnect(connectionId);
  cachedConnections = null;
  return conn;
}

export async function bindTable(
  connectionId: string,
  request: BiBindRequest,
): Promise<string> {
  return apiBindTable(connectionId, request);
}

// ---------------------------------------------------------------------------
// Query & Insert
// ---------------------------------------------------------------------------

export async function query(
  connectionId: string,
  request: BiQueryRequest,
): Promise<BiQueryResult> {
  const result = await apiQuery(connectionId, request);
  cachedQueryResult = result;
  cachedQueryRequest = request;
  cachedActiveConnectionId = connectionId;
  return result;
}

export async function insertResult(
  request: BiInsertRequest,
): Promise<BiInsertResponse> {
  if (!cachedQueryResult || !cachedQueryRequest) {
    throw new Error("No query result to insert. Execute a query first.");
  }
  return apiInsertResult(request, cachedQueryResult, cachedQueryRequest);
}

export async function refreshConnection(
  connectionId: string,
): Promise<BiQueryResult[]> {
  const results = await apiRefreshConnection(connectionId);
  cachedConnections = null;
  return results;
}

/**
 * Force-refresh all in-memory tables on a connection (ignores TTL).
 * Call on workbook open or when the user clicks "Refresh All".
 * Returns names of tables that were refreshed.
 */
export async function refreshAllInMemory(
  connectionId: string,
): Promise<string[]> {
  return apiRefreshAllInMemory(connectionId);
}

// ---------------------------------------------------------------------------
// Model Info & Region Check
// ---------------------------------------------------------------------------

export async function getModelInfo(
  connectionId: string,
): Promise<BiModelInfo | null> {
  return apiGetModelInfo(connectionId);
}

/** Set the active "view as" RLS role for a connection (null = unrestricted). */
export async function setActiveRole(
  connectionId: string,
  role: string | null,
): Promise<void> {
  return apiSetActiveRole(connectionId, role);
}

/** Get the active "view as" RLS role for a connection (null = unrestricted). */
export async function getActiveRole(
  connectionId: string,
): Promise<string | null> {
  return apiGetActiveRole(connectionId);
}

export async function getRegionAtCell(
  row: number,
  col: number,
): Promise<BiRegionInfo | null> {
  return apiGetRegionAtCell(row, col);
}
