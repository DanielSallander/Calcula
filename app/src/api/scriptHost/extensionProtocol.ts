//! FILENAME: app/src/api/scriptHost/extensionProtocol.ts
// PURPOSE: The host <-> worker RPC protocol for the DISTRIBUTED-EXTENSION realm
//          (Wave 3 / S8-C7 Phase B). A worker-supported extension runs in a
//          hardened worker with no ambient authority. Two message families cross
//          the boundary:
//            - REGISTRATIONS (commands/menu items/event subscriptions): the
//              extension's handler stays IN the worker; the host installs a
//              proxy in the real registry that RPCs back via `invokeHandler`.
//            - BROKER CALLS (capabilities, toast, executeCommand, emitEvent):
//              routed through the SAME tier broker object scripts use, so the
//              declared-capability ceiling, consent, and audit apply identically.
//          All payloads are structured-clone data; functions never cross.

export const EXTENSION_PROTOCOL_VERSION = 1;

/** The manifest an extension bundle reports from inside the worker. The host
 *  filters `capabilities` to the recognized set before it becomes the ceiling. */
export interface WorkerExtensionManifest {
  id: string;
  name: string;
  version: string;
  apiVersion?: string;
  capabilities?: string[];
  workerSupport?: boolean;
}

/** A menu item an extension registers (data only — no closure crosses). */
export interface ExtMenuItemData {
  id: string;
  label: string;
  icon?: string;
  order?: number;
  separator?: boolean;
}

/** Worker -> host registration requests. Each carries a worker-local regId so
 *  the host can tear it down, and a handlerId when a callback must be relayed. */
export type ExtRegistration =
  | {
      kind: "command";
      regId: number;
      id: string;
      handlerId: number;
      metadata?: Record<string, unknown>;
    }
  | {
      kind: "menuItem";
      regId: number;
      menuId: string;
      item: ExtMenuItemData;
      /** Run a registered command id on click ... */
      commandId?: string;
      /** ... or relay to this worker handler. */
      handlerId?: number;
    }
  | { kind: "event"; regId: number; eventName: string; handlerId: number };

export interface ExtRpcError {
  code:
    | "PermissionDenied"
    | "CapabilityRequired"
    | "ValidationError"
    | "Timeout"
    | "HostError"
    | "UnknownMethod";
  message: string;
  detail?: { capability?: string };
}

// ============================================================================
// Host -> Worker
// ============================================================================

export type HX2W =
  | { t: "init"; protocolVersion: number; source: string }
  | { t: "activate"; ceiling: string[] }
  | { t: "invokeHandler"; reqId: number; handlerId: number; args: unknown[] }
  | { t: "appEvent"; handlerId: number; payload: unknown }
  | { t: "callResult"; callId: number; ok: boolean; value?: unknown; error?: ExtRpcError }
  | { t: "deactivate" };

// ============================================================================
// Worker -> Host
// ============================================================================

export type WX2H =
  | { t: "manifest"; manifest: WorkerExtensionManifest }
  | { t: "manifestError"; message: string }
  | { t: "activated"; ok: boolean; error?: string }
  | { t: "register"; reg: ExtRegistration }
  | { t: "unregister"; regId: number }
  | { t: "call"; callId: number; method: string; args: unknown[] }
  | { t: "handlerResult"; reqId: number; ok: boolean; value?: unknown; error?: ExtRpcError }
  | { t: "console"; level: "log" | "warn" | "error"; args: unknown[] }
  | { t: "error"; message: string; stack?: string };

/** Methods a worker extension may route through the broker, mapped to ALLOWLIST
 *  policy rows. Anything not here is rejected by the broker as UnknownMethod. */
export const EXTENSION_BROKER_METHODS: ReadonlySet<string> = new Set([
  "ext.notify",
  "ext.log",
  "ext.executeCommand",
  "ext.emitEvent",
  "cap.fetch",
  "cap.storageGet",
  "cap.storageSet",
  "cap.biQuery",
  "cap.biListConnections",
  "cap.biSql",
]);

/** Host deadline (ms) for a relayed handler invocation before it is abandoned. */
export const EXTENSION_HANDLER_TIMEOUT_MS = 5_000;
/** Worker-side deadline (ms) for a pending broker call. */
export const EXTENSION_CALL_TIMEOUT_MS = 30_000;
