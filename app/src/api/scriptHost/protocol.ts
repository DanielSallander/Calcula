//! FILENAME: app/src/api/scriptHost/protocol.ts
// PURPOSE: The host <-> worker RPC protocol for the script realm (sandbox
//          design §4). All payloads are structured-clone data; ImageBitmap
//          is the only transferable. One implicit port per worker; FIFO per
//          port, so `mount` always precedes events.

import type { CapabilityId } from "./allowlist";

export const PROTOCOL_VERSION = 1;

// ============================================================================
// Mount
// ============================================================================

export interface MountSpec {
  protocolVersion: number;
  scriptId: string;
  objectType: string;
  instanceId?: string;
  /** Display + shim shaping only — ENFORCEMENT IS HOST-SIDE (the broker). */
  tier: "restricted" | "unlocked";
  /** Granted capabilities; display + shim shaping only — ditto. */
  capabilities: CapabilityId[];
  apiVersion: string;
  source: string;
  /** Script display name (console prefixes, error reporting). */
  scriptName: string;
  /** Mirror seeds for sync getters (workbook/shape/panel props, slicer selection). */
  snapshot: {
    properties?: Record<string, unknown>;
    selection?: unknown;
  };
}

// ============================================================================
// Host -> Worker
// ============================================================================

export interface RenderCellRequest {
  row: number;
  col: number;
  sheetIndex: number;
  value: string;
}

export type RenderDrawTarget = {
  kind: "shape" | "slicerItem";
  /** Cache key (shape instanceId, or slicer item key). */
  key: string;
  /** Slicer items carry the item payload the renderer receives. */
  item?: unknown;
};

export type H2W =
  | { t: "mount"; spec: MountSpec }
  | { t: "validate"; source: string }
  | { t: "event"; hook: string; payload: unknown }
  | { t: "mirror"; path: string; value: unknown }
  | { t: "renderCells"; reqId: number; cells: RenderCellRequest[] }
  | { t: "renderDraw"; reqId: number; target: RenderDrawTarget; w: number; h: number; dpr: number }
  | { t: "callResult"; callId: number; ok: boolean; value?: unknown; error?: RpcErrorShape }
  | { t: "methodCall"; callId: number; methodName: string; args: unknown[] }
  | { t: "ping"; seq: number };

// ============================================================================
// Worker -> Host
// ============================================================================

/** Style override returned by cell onRender (subset the renderer consumes). */
export type StyleOverride = Record<string, unknown>;

export type W2H =
  | { t: "mounted"; ok: boolean; error?: string }
  | { t: "validated"; valid: boolean; error?: string }
  | { t: "call"; callId: number; method: string; args: unknown[] }
  | { t: "hookRegistered"; hook: string }
  | { t: "renderCellsResult"; reqId: number; styles: (StyleOverride | null)[] }
  | { t: "renderDrawResult"; reqId: number; bitmap: ImageBitmap | null }
  | { t: "methodResult"; callId: number; ok: boolean; value?: unknown; error?: RpcErrorShape }
  | { t: "console"; level: "log" | "warn" | "error"; args: unknown[] }
  | { t: "error"; hook?: string; message: string; stack?: string }
  | { t: "pong"; seq: number };

// ============================================================================
// Errors & limits
// ============================================================================

export interface RpcErrorShape {
  code:
    | "PermissionDenied"
    | "CapabilityRequired"
    | "ValidationError"
    | "Timeout"
    | "HostError"
    | "UnknownMethod";
  message: string;
  /** Lets scripts degrade gracefully / the editor offer "request grant". */
  detail?: { capability?: string };
}

/** Worker-side safety timeout for any pending call (ms). */
export const CALL_TIMEOUT_MS = 30_000;
/** Host deadlines by method class (ms): read 10s, mutate 30s, net 120s. */
export const CLASS_DEADLINES_MS: Record<string, number> = {
  read: 10_000,
  mutate: 30_000,
  emit: 10_000,
  net: 120_000,
};
/** In-flight call cap per script; excess rejects HostError{rpc-saturated}. */
export const MAX_INFLIGHT_CALLS = 32;
/** Relayed methodCall deadline (ms). Must be >= CALL_TIMEOUT_MS: a relayed
 *  method body may itself `await` a broker capability call (e.g. a custom
 *  function doing `cube.value(...)` under bi.query), which is bounded by the
 *  worker's own CALL_TIMEOUT_MS. A shorter relay deadline would abandon the
 *  call before the in-worker work could possibly finish, surfacing spurious
 *  timeouts for BI-backed UDFs. Kept equal so the worker's deadline governs. */
export const METHOD_CALL_TIMEOUT_MS = CALL_TIMEOUT_MS;
/** Per-worker outbound event queue high-water mark. */
export const EVENT_QUEUE_HIGH_WATER = 256;
/** Render request: no response within this window -> drop in-flight, degrade. */
export const RENDER_TIMEOUT_MS = 2_000;

/**
 * Hooks whose queued events coalesce latest-per-key under backpressure;
 * discrete hooks (onClick, onEdit) queue every occurrence.
 */
export const COALESCE_HOOKS: ReadonlySet<string> = new Set([
  "onDataChange",
  "onSelectionChange",
  "onResize",
  "onThemeChange",
  "onSheetChange",
]);
