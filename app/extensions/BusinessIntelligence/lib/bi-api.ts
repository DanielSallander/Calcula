//! FILENAME: app/extensions/BusinessIntelligence/lib/bi-api.ts
// PURPOSE: Extension-facing API wrappers around backend BI commands.
// CONTEXT: Extensions call these instead of backend.ts directly for
//          caching, post-processing, and event emission.

import {
  biLoadModel as apiLoadModel,
  biConnect as apiConnect,
  biBindTable as apiBindTable,
  biQuery as apiQuery,
  biInsertResult as apiInsertResult,
  biRefresh as apiRefresh,
  biGetModelInfo as apiGetModelInfo,
  biGetRegionAtCell as apiGetRegionAtCell,
} from "../../../src/api/backend";

import type {
  BiModelInfo,
  BiConnectRequest,
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

let cachedModelInfo: BiModelInfo | null = null;
let cachedQueryResult: BiQueryResult | null = null;
let cachedQueryRequest: BiQueryRequest | null = null;

export function getCachedModelInfo(): BiModelInfo | null {
  return cachedModelInfo;
}

export function getCachedQueryResult(): BiQueryResult | null {
  return cachedQueryResult;
}

export function getCachedQueryRequest(): BiQueryRequest | null {
  return cachedQueryRequest;
}

// ---------------------------------------------------------------------------
// API wrappers
// ---------------------------------------------------------------------------

export async function loadModel(path: string): Promise<BiModelInfo> {
  const info = await apiLoadModel(path);
  cachedModelInfo = info;
  return info;
}

export async function connect(request: BiConnectRequest): Promise<string> {
  return apiConnect(request);
}

export async function bindTable(request: BiBindRequest): Promise<string> {
  return apiBindTable(request);
}

export async function query(request: BiQueryRequest): Promise<BiQueryResult> {
  const result = await apiQuery(request);
  cachedQueryResult = result;
  cachedQueryRequest = request;
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

export async function refresh(): Promise<BiQueryResult> {
  const result = await apiRefresh();
  cachedQueryResult = result;
  return result;
}

export async function getModelInfo(): Promise<BiModelInfo | null> {
  const info = await apiGetModelInfo();
  if (info) {
    cachedModelInfo = info;
  }
  return info;
}

export async function getRegionAtCell(
  row: number,
  col: number,
): Promise<BiRegionInfo | null> {
  return apiGetRegionAtCell(row, col);
}
