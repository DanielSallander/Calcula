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
  biGetModelInfo as apiGetModelInfo,
  biGetRegionAtCell as apiGetRegionAtCell,
} from "../../../src/api/backend";

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
} from "../types";

// ---------------------------------------------------------------------------
// Cached state
// ---------------------------------------------------------------------------

let cachedConnections: ConnectionInfo[] | null = null;
let cachedQueryResult: BiQueryResult | null = null;
let cachedQueryRequest: BiQueryRequest | null = null;
let cachedActiveConnectionId: number | null = null;

export function getCachedConnections(): ConnectionInfo[] | null {
  return cachedConnections;
}

export function getCachedQueryResult(): BiQueryResult | null {
  return cachedQueryResult;
}

export function getCachedQueryRequest(): BiQueryRequest | null {
  return cachedQueryRequest;
}

export function getCachedActiveConnectionId(): number | null {
  return cachedActiveConnectionId;
}

export function setCachedActiveConnectionId(id: number | null): void {
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

export async function deleteConnection(connectionId: number): Promise<void> {
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
  connectionId: number,
): Promise<ConnectionInfo> {
  return apiGetConnection(connectionId);
}

// ---------------------------------------------------------------------------
// Connect / Disconnect / Bind
// ---------------------------------------------------------------------------

export async function connect(connectionId: number): Promise<ConnectionInfo> {
  const conn = await apiConnect({ connectionId });
  cachedConnections = null;
  return conn;
}

export async function disconnect(connectionId: number): Promise<ConnectionInfo> {
  const conn = await apiDisconnect(connectionId);
  cachedConnections = null;
  return conn;
}

export async function bindTable(
  connectionId: number,
  request: BiBindRequest,
): Promise<string> {
  return apiBindTable(connectionId, request);
}

// ---------------------------------------------------------------------------
// Query & Insert
// ---------------------------------------------------------------------------

export async function query(
  connectionId: number,
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
  connectionId: number,
): Promise<BiQueryResult[]> {
  const results = await apiRefreshConnection(connectionId);
  cachedConnections = null;
  return results;
}

// ---------------------------------------------------------------------------
// Model Info & Region Check
// ---------------------------------------------------------------------------

export async function getModelInfo(
  connectionId: number,
): Promise<BiModelInfo | null> {
  return apiGetModelInfo(connectionId);
}

export async function getRegionAtCell(
  row: number,
  col: number,
): Promise<BiRegionInfo | null> {
  return apiGetRegionAtCell(row, col);
}
