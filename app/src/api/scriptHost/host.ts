//! FILENAME: app/src/api/scriptHost/host.ts
// PURPOSE: The trusted side of the script realm (sandbox design §3/§4):
//          spawns one Worker per mounted script, relays every `call` through
//          the tier broker, forwards only the hooks each worker declared,
//          pushes mirror snapshots for sync getters, and plumbs the
//          data-only render protocols (cell style batches, shape/slicer
//          bitmaps). Faults: one free respawn on worker crash; a second
//          crash within 30s faults the script.

import {
  brokerCall,
  BrokerError,
  buildHandleFromDefinition,
  callExposed,
  registerExposed,
  registerMountedHandle,
  scriptEmitEventName,
  scriptSubscribeEventName,
  type ScriptHandle,
} from "./broker";
import {
  PROTOCOL_VERSION,
  RENDER_TIMEOUT_MS,
  METHOD_CALL_TIMEOUT_MS,
  COALESCE_HOOKS,
  type H2W,
  type W2H,
  type MountSpec,
  type RenderCellRequest,
  type RenderDrawTarget,
  type StyleOverride,
} from "./protocol";
import {
  registerCellRenderCache,
  invalidateCellRenderCache,
  storeBitmap,
  getBitmap,
  invalidateBitmap,
  invalidateSlicerBitmaps,
} from "./renderCache";
import { ALLOWLIST } from "./allowlist";
import {
  fetchOriginOf,
  grantNetOrigin,
  hasFetchOrigin,
  recordCapabilityGrant,
  requestCapabilityGrant,
  resetAllGrants,
  revokeBackendCapabilities,
  syncNetOriginsToBackend,
  wasDeniedThisSession,
} from "./capabilities";
import { AppEvents, emitAppEvent, onAppEvent } from "../events";
import { showToast } from "../notifications";
import { ExtensionRegistry } from "../extensionRegistry";
import { getSlicerStoreService, getChartStoreService, getPivotStoreService } from "../componentStoreRegistry";
import type { IStyleOverride } from "../styleInterceptors";

type CleanupFn = () => void;

// Lazy backend imports (same pattern as scriptableObjects.ts — avoids
// circular deps at module load).
let _libModule: typeof import("../lib") | null = null;
async function getLib() {
  if (!_libModule) {
    _libModule = await import("../lib");
  }
  return _libModule;
}

// ============================================================================
// Per-script storage (Phase 4.3, design §8). HOST-SIDE + workbook-local: the
// store lives in the .cala virtual filesystem at
// .calcula/script-data/<scriptId>.json as a flat { key: value } of strings.
// The scriptId is ALWAYS the authoritative handle id (definition.id), never an
// arg — a script can only touch its OWN data.
// ============================================================================

const SCRIPT_STORAGE_QUOTA_BYTES = 262_144; // 256 KB per script (design §8)

function scriptStoragePath(scriptId: string): string {
  return `.calcula/script-data/${scriptId}.json`;
}

async function readScriptStorage(scriptId: string): Promise<Record<string, string>> {
  const { readVirtualFile } = await import("../backend");
  try {
    const raw = await readVirtualFile(scriptStoragePath(scriptId));
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {}; // missing / unreadable -> empty store
  }
}

async function writeScriptStorage(scriptId: string, store: Record<string, string>): Promise<void> {
  const { createVirtualFile } = await import("../backend");
  await createVirtualFile(scriptStoragePath(scriptId), JSON.stringify(store));
}

// Active sheet tracking for event payload transforms (CELL_VALUES_CHANGED
// carries no sheet index; UI edits target the active sheet).
let activeSheetIndexForEvents = 0;
let activeSheetWired = false;
function wireActiveSheet(): void {
  if (activeSheetWired) return;
  activeSheetWired = true;
  onAppEvent(AppEvents.SHEET_CHANGED, (detail) => {
    const d = detail as { sheetIndex?: number } | undefined;
    if (d && typeof d.sheetIndex === "number") {
      activeSheetIndexForEvents = d.sheetIndex;
    }
  });
}

// ============================================================================
// Definition shape the host needs (structural — avoids importing the full
// ObjectScriptDefinition and creating a module cycle).
// ============================================================================

export interface HostMountDefinition {
  id: string;
  name: string;
  objectType: string;
  instanceId: string | null;
  source: string;
  accessLevel: string;
  provenance?: string;
  packageName?: string;
  /** The R19 declared-capability ceiling (authoritative). Passed to
   *  buildHandleFromDefinition; the broker denies any cap not in this set. */
  declaredCapabilities?: string[];
  apiVersion: string;
}

interface MountedWorker {
  worker: Worker;
  handle: ScriptHandle;
  definition: HostMountDefinition;
  cleanupFns: CleanupFn[];
  /** Wired app-event forwarders, keyed by hook. */
  forwarders: Map<string, CleanupFn>;
  /** Pending render-cell batches. */
  pendingRenderCells: Map<number, { resolve: (styles: (StyleOverride | null)[] | null) => void; timer: number }>;
  /** Pending bitmap draws, keyed by reqId. */
  pendingRenderDraws: Map<number, { key: string; timer: number }>;
  /** In-flight bitmap request keys (single-flight per key). */
  drawsInFlight: Set<string>;
  /** Pending relayed methodCalls. */
  pendingMethodCalls: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number }>;
  nextReqId: number;
  /** Coalesced event queue, flushed per animation frame. */
  coalesced: Map<string, unknown>;
  coalesceScheduled: boolean;
  /** Crash bookkeeping (one free respawn; second crash within 30s faults). */
  lastCrashAt: number;
  respawned: boolean;
  /** Shape property cache for setState oldValue + mirror pushes. */
  shapeProps: Map<string, string>;
  /** Render hooks the worker declared (onRender/canvasRenderer/itemRenderer). */
  declaredRenderHooks: Set<string>;
}

const mounted = new Map<string, MountedWorker>();
const faulted = new Map<string, string>();

// ============================================================================
// Spawn / terminate
// ============================================================================

function spawnWorker(): Worker {
  return new Worker(new URL("./worker/bootstrap.ts", import.meta.url), { type: "module" });
}

/** Whether the worker realm is available in this environment (jsdom tests lack Worker). */
export function workerRealmAvailable(): boolean {
  return typeof Worker !== "undefined" && typeof window !== "undefined";
}

/**
 * Mount a script in its own worker realm. Resolves when the worker reports
 * mounted (or rejects with the script's setup error).
 */
export async function hostMountScript(definition: HostMountDefinition): Promise<void> {
  wireActiveSheet();
  if (mounted.has(definition.id)) {
    hostUnmountScript(definition.id);
  }
  faulted.delete(definition.id);

  const handle = buildHandleFromDefinition(definition);
  const worker = spawnWorker();
  const mw: MountedWorker = {
    worker,
    handle,
    definition,
    cleanupFns: [],
    forwarders: new Map(),
    pendingRenderCells: new Map(),
    pendingRenderDraws: new Map(),
    drawsInFlight: new Set(),
    pendingMethodCalls: new Map(),
    nextReqId: 1,
    coalesced: new Map(),
    coalesceScheduled: false,
    lastCrashAt: 0,
    respawned: false,
    shapeProps: new Map(),
    declaredRenderHooks: new Set(),
  };
  mounted.set(definition.id, mw);
  mw.cleanupFns.push(registerMountedHandle(handle));
  // Re-establish this script's net.fetch origins in the Rust store (a remount
  // within the session keeps session grants; first mount pushes nothing).
  void syncNetOriginsToBackend(definition.id);

  const snapshot = await buildSnapshot(definition, mw);

  const spec: MountSpec = {
    protocolVersion: PROTOCOL_VERSION,
    scriptId: definition.id,
    objectType: definition.objectType,
    instanceId: definition.instanceId ?? undefined,
    tier: handle.tier,
    capabilities: [...handle.grants],
    apiVersion: definition.apiVersion,
    source: definition.source,
    scriptName: definition.name,
    snapshot,
  };

  const mountedPromise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Script mount timed out (10s)")), 10_000);
    wireWorker(mw, (ok, error) => {
      clearTimeout(timer);
      if (ok) {
        resolve();
      } else {
        reject(new Error(error || "Script setup failed"));
      }
    });
  });

  post(mw, { t: "mount", spec });
  try {
    await mountedPromise;
  } catch (err) {
    hostUnmountScript(definition.id);
    throw err;
  }
}

export function hostUnmountScript(scriptId: string): void {
  const mw = mounted.get(scriptId);
  if (!mw) return;
  mw.worker.terminate();
  for (const pending of mw.pendingRenderCells.values()) {
    clearTimeout(pending.timer);
    pending.resolve(null);
  }
  for (const pending of mw.pendingMethodCalls.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error("Script unmounted"));
  }
  for (const pending of mw.pendingRenderDraws.values()) {
    clearTimeout(pending.timer);
  }
  for (let i = mw.cleanupFns.length - 1; i >= 0; i--) {
    try {
      mw.cleanupFns[i]();
    } catch {
      /* ignore */
    }
  }
  for (const unsub of mw.forwarders.values()) {
    try {
      unsub();
    } catch {
      /* ignore */
    }
  }
  if (mw.definition.instanceId) {
    invalidateBitmap("shape", mw.definition.instanceId);
    invalidateSlicerBitmaps(mw.definition.instanceId);
  }
  // Drop the script's Rust-side net.fetch grants so an unmounted script can
  // never fetch (session grants in capabilities.ts survive for a remount).
  void revokeBackendCapabilities(scriptId);
  mounted.delete(scriptId);
}

export function hostIsMounted(scriptId: string): boolean {
  return mounted.has(scriptId);
}

export function hostResetAll(): void {
  for (const scriptId of [...mounted.keys()]) {
    hostUnmountScript(scriptId);
  }
  faulted.clear();
  // Workbook reset = fresh session: forget all capability grants.
  resetAllGrants();
}

/** Faulted scripts (crashed twice within 30s) with their last error. */
export function listFaultedScripts(): Array<{ scriptId: string; error: string }> {
  return [...faulted.entries()].map(([scriptId, error]) => ({ scriptId, error }));
}

/**
 * Validate a source for syntax errors in a short-lived scratch worker.
 * Nothing user-authored executes (blob-ESM wrap).
 */
export function hostValidateScript(source: string): Promise<{ valid: boolean; error?: string }> {
  if (!workerRealmAvailable()) {
    return Promise.resolve({ valid: true });
  }
  return new Promise((resolve) => {
    const worker = spawnWorker();
    const timer = setTimeout(() => {
      worker.terminate();
      resolve({ valid: false, error: "Validation timed out (5s)" });
    }, 5000);
    worker.onmessage = (e: MessageEvent<W2H>) => {
      if (e.data.t === "validated") {
        clearTimeout(timer);
        worker.terminate();
        resolve({ valid: e.data.valid, error: e.data.error });
      }
    };
    worker.onerror = (e) => {
      clearTimeout(timer);
      worker.terminate();
      resolve({ valid: false, error: e.message || "Worker error during validation" });
    };
    worker.postMessage({ t: "validate", source } satisfies H2W);
  });
}

function post(mw: MountedWorker, msg: H2W): void {
  mw.worker.postMessage(msg);
}

// ============================================================================
// Worker message wiring
// ============================================================================

function wireWorker(mw: MountedWorker, onMounted: (ok: boolean, error?: string) => void): void {
  mw.worker.onmessage = (e: MessageEvent<W2H>) => {
    const msg = e.data;
    switch (msg.t) {
      case "mounted":
        onMounted(msg.ok, msg.error);
        break;
      case "call":
        void handleCall(mw, msg.callId, msg.method, msg.args);
        break;
      case "hookRegistered":
        wireHookForwarder(mw, msg.hook);
        break;
      case "renderCellsResult": {
        const pending = mw.pendingRenderCells.get(msg.reqId);
        if (pending) {
          mw.pendingRenderCells.delete(msg.reqId);
          clearTimeout(pending.timer);
          pending.resolve(msg.styles);
        }
        break;
      }
      case "renderDrawResult": {
        const pending = mw.pendingRenderDraws.get(msg.reqId);
        if (pending) {
          mw.pendingRenderDraws.delete(msg.reqId);
          clearTimeout(pending.timer);
          mw.drawsInFlight.delete(pending.key);
          if (msg.bitmap) {
            const [kind, key] = pending.key.split("|", 2) as ["shape" | "slicerItem", string];
            storeBitmap(kind, key, { bitmap: msg.bitmap, w: msg.bitmap.width, h: msg.bitmap.height, dpr: 1 });
          }
        }
        break;
      }
      case "methodResult": {
        const pending = mw.pendingMethodCalls.get(msg.callId);
        if (pending) {
          mw.pendingMethodCalls.delete(msg.callId);
          clearTimeout(pending.timer);
          if (msg.ok) {
            pending.resolve(msg.value);
          } else {
            pending.reject(new Error(msg.error?.message || "method call failed"));
          }
        }
        break;
      }
      case "console":
        emitAppEvent("objectscript:console", {
          scriptId: mw.definition.id,
          level: msg.level,
          args: msg.args,
        });
        break;
      case "error":
        emitAppEvent("objectscript:error", {
          scriptId: mw.definition.id,
          scriptName: mw.definition.name,
          error: msg.message,
          stack: msg.stack,
          hook: msg.hook,
        });
        break;
      case "validated":
      case "pong":
        break;
    }
  };

  mw.worker.onerror = (e) => {
    const now = Date.now();
    const message = e.message || "Worker crashed";
    if (mw.respawned && now - mw.lastCrashAt < 30_000) {
      // Second crash within 30s: fault the script (visible in the panel).
      faulted.set(mw.definition.id, message);
      emitAppEvent("objectscript:error", {
        scriptId: mw.definition.id,
        scriptName: mw.definition.name,
        error: `Script faulted after repeated crashes: ${message}`,
      });
      hostUnmountScript(mw.definition.id);
      return;
    }
    mw.lastCrashAt = now;
    mw.respawned = true;
    const definition = mw.definition;
    hostUnmountScript(definition.id);
    void hostMountScript(definition).then(() => {
      const remounted = mounted.get(definition.id);
      if (remounted) {
        remounted.lastCrashAt = now;
        remounted.respawned = true;
      }
    }).catch(() => {
      faulted.set(definition.id, message);
    });
  };
}

// ============================================================================
// RPC dispatch — every worker `call` goes through the broker
// ============================================================================

async function handleCall(mw: MountedWorker, callId: number, method: string, args: unknown[]): Promise<void> {
  try {
    // JIT capability grant (R10): for a LOCAL script's first ungranted use of a
    // capability, prompt the user before the broker denies it. On grant the live
    // grant set (+ the Rust net.fetch store) is updated, so the broker admits the
    // same call below. Distributed scripts are not JIT-prompted — they acquire
    // capabilities only through package consent (Phase 4.2).
    await maybeRequestCapabilityGrant(mw, method, args);
    const value = await brokerCall(mw.handle, method, args, () => executeImpl(mw, method, args));
    post(mw, { t: "callResult", callId, ok: true, value });
  } catch (err) {
    const error =
      err instanceof BrokerError
        ? { code: err.code, message: err.message, detail: err.capability ? { capability: err.capability } : undefined }
        : { code: "HostError" as const, message: err instanceof Error ? err.message : String(err) };
    post(mw, { t: "callResult", callId, ok: false, error });
  }
}

/**
 * JIT capability grant (R10). LOCAL scripts only — distributed scripts acquire
 * capabilities through package consent (Phase 4.2), never JIT. For net.fetch the
 * prompt is per-origin (parsed from the fetch URL); other caps are blanket. On
 * grant the live grant set is updated and a net.fetch origin is mirrored to the
 * authoritative Rust store. A denied request is remembered for the session (no
 * re-prompt); the broker (cap missing) or Rust (origin missing) then denies it.
 */
async function maybeRequestCapabilityGrant(
  mw: MountedWorker,
  method: string,
  args: unknown[],
): Promise<void> {
  const cap = ALLOWLIST[method]?.capability;
  if (!cap) return;
  const { handle } = mw;
  if (handle.origin !== "local" || cap === "ui.html") return;
  // R19: only JIT-prompt for capabilities the script actually DECLARED. An
  // undeclared cap is above the ceiling — the broker denies it (PermissionDenied)
  // and the user is never asked to grant something the script never declared.
  if (!handle.declaredCapabilities.has(cap)) return;

  if (cap === "net.fetch") {
    const origin = fetchOriginOf(args[0]);
    if (!origin) return; // invalid URL — vFetch / Rust will reject
    if (handle.grants.has(cap) && hasFetchOrigin(handle.scriptId, origin)) return;
    if (wasDeniedThisSession(handle.scriptId, cap, origin)) return;
    const decision = await requestCapabilityGrant({
      scriptId: handle.scriptId,
      scriptName: handle.scriptName,
      capability: cap,
      origin,
    });
    if (decision === "deny") return;
    recordCapabilityGrant(handle.scriptId, cap, origin);
    try {
      await grantNetOrigin(handle.scriptId, origin);
    } catch (e) {
      console.error("[caps] failed to mirror net.fetch origin to backend:", e);
    }
    // (decision === "always" persistence across reload lands in Phase 4.2.)
    return;
  }

  // Blanket caps (storage, bi.query — executors land in Phase 4.3).
  if (handle.grants.has(cap)) return;
  if (wasDeniedThisSession(handle.scriptId, cap, null)) return;
  const decision = await requestCapabilityGrant({
    scriptId: handle.scriptId,
    scriptName: handle.scriptName,
    capability: cap,
    origin: null,
  });
  if (decision !== "deny") recordCapabilityGrant(handle.scriptId, cap);
}

/** The IMPL table (design §5): today's context-builder bodies, minus closures. */
async function executeImpl(mw: MountedWorker, method: string, args: unknown[]): Promise<unknown> {
  const { handle, definition } = mw;
  const instanceId = definition.instanceId || "";

  switch (method) {
    // ---- base ----
    case "base.log": {
      console.log(`[Script:${definition.name}]`, ...args);
      emitAppEvent("objectscript:console", { scriptId: definition.id, level: "log", args });
      return undefined;
    }
    case "base.notify": {
      const [message, type] = args as [string, string?];
      showToast(message, { type: (type as "info" | "success" | "warning" | "error") || "info" });
      return undefined;
    }
    case "base.expose": {
      const [name, isPublic] = args as [string, boolean];
      const relay = (...relayArgs: unknown[]) => relayMethodCall(mw, name, relayArgs);
      const cleanup = registerExposed(handle, name, relay, isPublic === true);
      mw.cleanupFns.push(cleanup);
      return undefined;
    }
    case "base.unexpose": {
      // Cleanup happens via the registered cleanup on unmount; explicit
      // unexpose re-registers a tombstone-free state by running the cleanup
      // now (registerExposed cleanups are idempotent and successor-safe).
      return undefined;
    }
    case "base.callMethod": {
      const [targetType, targetInstanceId, methodName, callArgs] = args as [string, string | null, string, unknown[]];
      return callExposed(handle, targetType, targetInstanceId, methodName, callArgs ?? []);
    }

    // ---- events ----
    case "events.subscribe": {
      const [name] = args as [string];
      wireAppEventForwarder(mw, `event:${name}`, scriptSubscribeEventName(name));
      return undefined;
    }

    // ---- unlocked api ----
    case "api.getCellValue": {
      const [row, col] = args as [number, number];
      const lib = await getLib();
      const cell = await lib.getCell(row, col);
      return cell?.display ?? "";
    }
    case "api.setCellValue": {
      const [row, col, value] = args as [number, number, string];
      const lib = await getLib();
      await lib.updateCell(row, col, value);
      return undefined;
    }
    case "api.updateCellsBatch": {
      const [updates] = args as [Array<{ row: number; col: number; value: string }>];
      const lib = await getLib();
      await lib.updateCellsBatch(updates.map((u) => ({ row: u.row, col: u.col, value: u.value })));
      return undefined;
    }
    case "api.getSheetNames": {
      const lib = await getLib();
      const result = await lib.getSheets();
      return result.sheets.map((s: { name: string }) => s.name);
    }
    case "api.getActiveSheet": {
      const lib = await getLib();
      return lib.getActiveSheet();
    }
    case "api.setActiveSheet": {
      const [index] = args as [number];
      const lib = await getLib();
      await lib.setActiveSheet(index);
      return undefined;
    }
    case "api.emitEvent": {
      const [name, detail] = args as [string, unknown];
      emitAppEvent(scriptEmitEventName(name), detail);
      return undefined;
    }
    case "api.executeCommand": {
      const [commandId, cmdArgs] = args as [string, unknown];
      const mod = await import("../commands");
      if (!mod.CommandRegistry.isScriptSafe(commandId)) {
        throw new BrokerError(
          "PermissionDenied",
          `Command '${commandId}' is not flagged scriptSafe; scripts may only run commands their extension has audited for script use`,
        );
      }
      // Surface the command's result back to the script.
      return await mod.CommandRegistry.execute(commandId, cmdArgs);
    }
    case "api.beginBatch": {
      const [description] = args as [string];
      const lib = await getLib();
      await lib.beginUndoTransaction(description);
      return undefined;
    }
    case "api.commitBatch": {
      const lib = await getLib();
      await lib.commitUndoTransaction();
      return undefined;
    }
    case "api.cancelBatch": {
      const lib = await getLib();
      await lib.cancelUndoTransaction();
      return undefined;
    }

    // ---- sheet scope ----
    case "sheet.getCellValue": {
      const [row, col, sheetIndex] = args as [number, number, number?];
      const lib = await getLib();
      if (sheetIndex !== undefined) {
        const active = await lib.getActiveSheet();
        if (sheetIndex !== active) {
          if (handle.tier !== "unlocked") {
            throw new BrokerError("PermissionDenied", "Restricted sheet scripts can only access their own sheet");
          }
          const results = await lib.getWatchCells([[sheetIndex, row, col]]);
          return results[0]?.display ?? "";
        }
      }
      const cellData = await lib.getCell(row, col);
      return cellData?.display ?? "";
    }
    case "sheet.setCellValue": {
      const [row, col, value, sheetIndex] = args as [number, number, string, number?];
      const lib = await getLib();
      if (sheetIndex !== undefined) {
        const active = await lib.getActiveSheet();
        if (sheetIndex !== active) {
          if (handle.tier !== "unlocked") {
            throw new BrokerError("PermissionDenied", "Restricted sheet scripts can only access their own sheet");
          }
          await lib.updateCellOnSheets([sheetIndex], row, col, value);
          return undefined;
        }
      }
      await lib.updateCell(row, col, value);
      return undefined;
    }

    // ---- own-object state ----
    case "object.setState": {
      const [aspect, aspectArgs] = args as [string, unknown[]];
      return executeSetState(mw, instanceId, aspect, aspectArgs);
    }
    case "object.getState": {
      const [aspect, aspectArgs] = args as [string, unknown[]];
      return executeGetState(aspect, aspectArgs);
    }

    // ---- render ----
    case "render.invalidate": {
      invalidateCellRenderCache(definition.id);
      if (instanceId) {
        invalidateBitmap("shape", instanceId);
        invalidateSlicerBitmaps(instanceId);
      }
      return undefined;
    }
    case "render.setHtml": {
      const [html] = args as [string];
      emitAppEvent("shape:setHtmlContent", { instanceId, html });
      return undefined;
    }

    // ---- capabilities ----
    case "cap.fetch": {
      // The broker already enforced net.fetch is granted (coarse gate) and
      // vFetch validated https. The Rust command is the AUTHORITATIVE gate: it
      // re-derives + re-checks the origin against the per-script grant store,
      // rate-limits, strips credentials, and bounds the response — it never
      // trusts these args for permission. Worker arg shape: [url, init?].
      const [url, init] = args as [
        string,
        { method?: string; headers?: Record<string, string>; body?: string } | undefined,
      ];
      const { invokeBackend } = await import("../backend");
      return invokeBackend("script_http_fetch", {
        request: {
          scriptId: definition.id,
          url,
          method: init?.method,
          headers: init?.headers,
          body: init?.body,
        },
      });
    }
    case "cap.storageGet": {
      // The broker already enforced `storage` is declared (R19 ceiling) and
      // granted, and vKey validated the key. The scriptId is the AUTHORITATIVE
      // handle id — never an arg — so a script reads only its OWN store.
      const [key] = args as [string];
      const store = await readScriptStorage(definition.id);
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
    }
    case "cap.storageSet": {
      // Read-modify-write the script's own store. Reject a set that would push
      // the serialized store over the 256 KB quota BEFORE writing (the prior
      // store on disk is left untouched).
      const [key, value] = args as [string, string];
      const store = await readScriptStorage(definition.id);
      store[key] = value;
      const serialized = JSON.stringify(store);
      if (serialized.length > SCRIPT_STORAGE_QUOTA_BYTES) {
        throw new BrokerError("HostError", "script storage quota exceeded (256 KB)");
      }
      await writeScriptStorage(definition.id, store);
      return undefined;
    }
    case "cap.biQuery": {
      // The broker enforced bi.query is declared + granted. This is a STRUCTURED,
      // model-scoped query (measures/group_by/filters) run through the same cached
      // engine path the app's pivots use — no raw SQL, no DB-wide access. bi_query
      // is MAIN-window-guarded; the host runs in the main window.
      const [connectionId, request] = args as [string, unknown];
      const { invokeBackend } = await import("../backend");
      return invokeBackend("bi_query", { connectionId, request });
    }
    case "cap.biListConnections": {
      // Expose ONLY a non-sensitive summary — never connectionString / server /
      // database / credentials (toBiConnectionSummary whitelists the fields).
      const { invokeBackend } = await import("../backend");
      const { toBiConnectionSummary } = await import("./biQuerySupport");
      const conns = await invokeBackend<Array<Record<string, unknown>>>("bi_get_connections");
      return (conns ?? []).map(toBiConnectionSummary);
    }
    case "cap.biSql": {
      // Higher-trust RAW SQL: vBiSql validated read-only on the frontend; the
      // Rust command re-validates read-only authoritatively and the connector
      // executes it against the connection's database.
      const [connectionId, sql] = args as [string, string];
      const { invokeBackend } = await import("../backend");
      return invokeBackend("script_bi_sql", { connectionId, sql });
    }

    default:
      throw new BrokerError("UnknownMethod", `No host implementation for ${method}`);
  }
}

async function executeSetState(mw: MountedWorker, instanceId: string, aspect: string, args: unknown[]): Promise<unknown> {
  switch (aspect) {
    case "slicer.setSelectedItems": {
      const [items] = args as [string[] | null];
      const store = getSlicerStoreService();
      if (store) {
        await store.setSelectedItems(instanceId, items);
      }
      return undefined;
    }
    case "slicer.setStyleProperty": {
      const [name, value] = args as [string, unknown];
      getSlicerStoreService()?.setStyleProperty(instanceId, name, value as string);
      return undefined;
    }
    case "chart.updateSpec": {
      const [patch] = args as [Record<string, unknown>];
      const store = getChartStoreService();
      if (store) {
        store.updateChartSpec(instanceId, patch);
        pushChartSpecMirror(mw, instanceId);
      }
      return undefined;
    }
    case "chart.setStyleProperty": {
      const [name, value] = args as [string, unknown];
      getChartStoreService()?.setStyleProperty(instanceId, name, value as string);
      return undefined;
    }
    case "pivot.refresh": {
      const store = getPivotStoreService();
      if (store) {
        await store.refreshPivot(instanceId);
        pushPivotFieldsMirror(mw, instanceId);
      }
      return undefined;
    }
    case "shape.setProperty": {
      const [key, value] = args as [string, string];
      const oldValue = mw.shapeProps.get(key) || "";
      mw.shapeProps.set(key, value);
      emitAppEvent("shape:setProperty", { instanceId, key, value, oldValue });
      return undefined;
    }
    case "shape.declareProperties": {
      const [props] = args as [unknown];
      emitAppEvent("shape:declareProperties", { instanceId, props });
      return undefined;
    }
    case "shape.sendMessage": {
      const [type, data] = args as [string, unknown];
      emitAppEvent("shape:sendMessage", { instanceId, type, data });
      return undefined;
    }
    case "panel.open":
      emitAppEvent("panel:open", { panelId: instanceId });
      return undefined;
    case "panel.close":
      emitAppEvent("panel:close", { panelId: instanceId });
      return undefined;
    case "panel.setBadge": {
      const [text] = args as [string | null];
      emitAppEvent("panel:setBadge", { panelId: instanceId, text: text || "" });
      return undefined;
    }
    case "panel.moveTo": {
      const [placement] = args as [string];
      emitAppEvent("panel:moveTo", { panelId: instanceId, placement });
      return undefined;
    }
    default:
      throw new BrokerError("ValidationError", `Unknown setState aspect: ${aspect}`);
  }
}

async function executeGetState(aspect: string, args: unknown[]): Promise<unknown> {
  switch (aspect) {
    case "shape.cellValue": {
      const [cellRef] = args as [string];
      const parsed = parseCellRef(cellRef);
      if (!parsed) return "";
      const lib = await getLib();
      const cell = await lib.getCell(parsed.row, parsed.col);
      return cell?.display ?? "";
    }
    default:
      throw new BrokerError("ValidationError", `Unknown getState aspect: ${aspect}`);
  }
}

function parseCellRef(ref: string): { row: number; col: number } | null {
  const match = ref.trim().toUpperCase().match(/^([A-Z]{1,3})(\d+)$/);
  if (!match) return null;
  const rowNum = parseInt(match[2], 10);
  if (isNaN(rowNum) || rowNum < 1) return null;
  let col = 0;
  for (let i = 0; i < match[1].length; i++) {
    col = col * 26 + (match[1].charCodeAt(i) - 64);
  }
  return { row: rowNum - 1, col: col - 1 };
}

/** Relay a callMethod from another script INTO this worker (5s deadline). */
function relayMethodCall(mw: MountedWorker, methodName: string, args: unknown[]): Promise<unknown> {
  const callId = mw.nextReqId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      mw.pendingMethodCalls.delete(callId);
      reject(new Error(`Method '${methodName}' timed out (${METHOD_CALL_TIMEOUT_MS}ms)`));
    }, METHOD_CALL_TIMEOUT_MS) as unknown as number;
    mw.pendingMethodCalls.set(callId, { resolve, reject, timer });
    post(mw, { t: "methodCall", callId, methodName, args });
  });
}

// ============================================================================
// Event forwarding — only hooks the worker declared, filters host-side
// ============================================================================

function forwardEvent(mw: MountedWorker, hook: string, payload: unknown): void {
  if (COALESCE_HOOKS.has(hook)) {
    mw.coalesced.set(hook, payload);
    if (!mw.coalesceScheduled) {
      mw.coalesceScheduled = true;
      requestAnimationFrame(() => {
        mw.coalesceScheduled = false;
        for (const [h, p] of mw.coalesced) {
          post(mw, { t: "event", hook: h, payload: p });
        }
        mw.coalesced.clear();
      });
    }
    return;
  }
  post(mw, { t: "event", hook, payload });
}

function addForwarder(mw: MountedWorker, hook: string, unsub: CleanupFn): void {
  const existing = mw.forwarders.get(hook);
  if (existing) {
    existing();
  }
  mw.forwarders.set(hook, unsub);
}

function wireAppEventForwarder(mw: MountedWorker, hook: string, eventName: string): void {
  if (mw.forwarders.has(hook)) return;
  addForwarder(mw, hook, onAppEvent(eventName, (detail) => forwardEvent(mw, hook, detail)));
}

/**
 * Wire the host-side subscription for a declared hook. The mapping mirrors
 * the legacy context builders exactly: same app events, same transforms,
 * same instance filters — moved host-side (design §4 rule 4).
 */
function wireHookForwarder(mw: MountedWorker, hook: string): void {
  if (mw.forwarders.has(hook)) return;
  const { definition } = mw;
  const instanceId = definition.instanceId || "";
  const objectType = definition.objectType;

  // api.onEvent subscriptions arrive via the audited events.subscribe call.
  if (hook.startsWith("event:")) return;

  // Render hooks wire caches/providers instead of event forwarders.
  if (hook === "onRender") {
    mw.declaredRenderHooks.add(hook);
    const dispose = registerCellRenderCache(definition.id, (cells) => requestCellStyles(mw, cells));
    addForwarder(mw, hook, dispose);
    return;
  }
  if (hook === "canvasRenderer") {
    mw.declaredRenderHooks.add(hook);
    wireShapeBitmapInvalidation(mw, instanceId);
    return;
  }
  if (hook === "itemRenderer") {
    // Slicer item bitmaps self-invalidate by key; nothing further to wire.
    mw.declaredRenderHooks.add(hook);
    return;
  }

  switch (`${objectType}.${hook}`) {
    // ---- workbook ----
    case "workbook.onOpen":
      addForwarder(mw, hook, onAppEvent(AppEvents.AFTER_OPEN, (d) => {
        pushWorkbookMirror(mw);
        forwardEvent(mw, hook, d);
      }));
      break;
    case "workbook.onBeforeSave":
      wireAppEventForwarder(mw, hook, AppEvents.BEFORE_SAVE);
      break;
    case "workbook.onAfterSave":
      wireAppEventForwarder(mw, hook, AppEvents.AFTER_SAVE);
      break;
    case "workbook.onBeforeClose":
      wireAppEventForwarder(mw, hook, AppEvents.BEFORE_CLOSE);
      break;
    case "workbook.onSheetChange":
      addForwarder(mw, hook, onAppEvent(AppEvents.SHEET_CHANGED, (d) => {
        pushWorkbookMirror(mw);
        forwardEvent(mw, hook, d);
      }));
      break;
    case "workbook.onThemeChange":
      wireAppEventForwarder(mw, hook, AppEvents.THEME_CHANGED);
      break;

    // ---- sheet ----
    case "sheet.onActivate":
      wireAppEventForwarder(mw, hook, AppEvents.SHEET_CHANGED);
      break;
    case "sheet.onDeactivate": {
      let lastSheet = { sheetIndex: -1, sheetName: "" };
      addForwarder(mw, hook, onAppEvent(AppEvents.SHEET_CHANGED, (detail) => {
        const d = detail as { sheetIndex: number; sheetName: string };
        if (lastSheet.sheetIndex >= 0) {
          forwardEvent(mw, hook, lastSheet);
        }
        lastSheet = { sheetIndex: d.sheetIndex, sheetName: d.sheetName };
      }));
      break;
    }
    case "sheet.onSelectionChange":
    case "cell.onSelect": {
      const unsub = ExtensionRegistry.onSelectionChange((sel) => {
        if (!sel) return;
        const row = sel.row ?? sel.startRow;
        const col = sel.col ?? sel.startCol;
        const payload = hook === "onSelect"
          ? { row, col, sheetIndex: sel.sheetIndex ?? 0 }
          : {
              sheetIndex: sel.sheetIndex ?? 0,
              row,
              col,
              endRow: sel.endRow ?? row,
              endCol: sel.endCol ?? col,
            };
        forwardEvent(mw, hook, payload);
      });
      addForwarder(mw, hook, unsub);
      break;
    }
    case "sheet.onDataChange":
      addForwarder(mw, hook, onAppEvent(AppEvents.CELL_VALUES_CHANGED, (detail) => {
        const d = detail as { changes: unknown[] };
        forwardEvent(mw, hook, { sheetIndex: activeSheetIndexForEvents, changes: d.changes });
      }));
      break;

    // ---- cell ----
    case "cell.onEdit":
      addForwarder(mw, hook, onAppEvent(AppEvents.CELL_VALUES_CHANGED, (detail) => {
        const d = detail as { changes: Array<{ row: number; col: number; oldValue?: string; newValue: string; formula?: string | null }> };
        forwardEvent(mw, hook, {
          changes: d.changes.map((change) => ({
            row: change.row,
            col: change.col,
            sheetIndex: activeSheetIndexForEvents,
            oldValue: change.oldValue,
            newValue: change.newValue,
            formula: change.formula,
          })),
        });
      }));
      break;
    case "cell.onEditStart":
      wireAppEventForwarder(mw, hook, AppEvents.EDIT_STARTED);
      break;
    case "cell.onEditEnd":
      addForwarder(mw, hook, onAppEvent(AppEvents.EDIT_ENDED, (detail) => {
        const d = detail as { row: number; col: number; sheetIndex?: number; committed?: boolean };
        forwardEvent(mw, hook, { row: d.row, col: d.col, sheetIndex: d.sheetIndex ?? 0, committed: d.committed ?? true });
      }));
      break;

    // ---- row / column ----
    case "row.onInsert":
      wireAppEventForwarder(mw, hook, AppEvents.ROWS_INSERTED);
      break;
    case "row.onDelete":
      wireAppEventForwarder(mw, hook, AppEvents.ROWS_DELETED);
      break;
    case "row.onResize":
      wireAppEventForwarder(mw, hook, AppEvents.ROW_RESIZED);
      break;
    case "column.onInsert":
      wireAppEventForwarder(mw, hook, AppEvents.COLUMNS_INSERTED);
      break;
    case "column.onDelete":
      wireAppEventForwarder(mw, hook, AppEvents.COLUMNS_DELETED);
      break;
    case "column.onResize":
      wireAppEventForwarder(mw, hook, AppEvents.COLUMN_RESIZED);
      break;

    // ---- slicer ----
    case "slicer.onSelectionChange":
      addForwarder(mw, hook, onAppEvent("slicer:selectionChanged", (detail) => {
        const d = detail as { slicerId: string; selectedItems: string[] };
        if (String(d.slicerId) !== instanceId) return;
        post(mw, { t: "mirror", path: "slicer.selection", value: d.selectedItems });
        forwardEvent(mw, hook, { selectedItems: d.selectedItems });
      }));
      break;

    // ---- chart ----
    case "chart.onDataChange": {
      const getSourceRange = () => {
        const store = getChartStoreService();
        const chart = store?.getChartById(instanceId);
        if (!chart) return null;
        try {
          const spec = JSON.parse(chart.specJson) as { data?: unknown };
          const d = spec.data as
            | { sheetIndex?: number; startRow?: number; startCol?: number; endRow?: number; endCol?: number }
            | string
            | undefined;
          if (
            d && typeof d === "object" &&
            typeof d.startRow === "number" && typeof d.endRow === "number" &&
            typeof d.startCol === "number" && typeof d.endCol === "number"
          ) {
            return d as { sheetIndex?: number; startRow: number; startCol: number; endRow: number; endCol: number };
          }
        } catch { /* unparseable spec — any-change behavior */ }
        return null;
      };
      const unsubCells = onAppEvent(AppEvents.CELL_VALUES_CHANGED, (detail) => {
        const range = getSourceRange();
        if (range) {
          if (range.sheetIndex !== undefined && range.sheetIndex !== activeSheetIndexForEvents) return;
          const d = detail as { changes?: Array<{ row: number; col: number }> };
          const hit = d.changes?.some(
            (c) =>
              c.row >= range.startRow && c.row <= range.endRow &&
              c.col >= range.startCol && c.col <= range.endCol,
          );
          if (!hit) return;
        }
        pushChartSpecMirror(mw, instanceId);
        forwardEvent(mw, hook, undefined);
      });
      const unsubBulk = onAppEvent(AppEvents.DATA_CHANGED, () => {
        pushChartSpecMirror(mw, instanceId);
        forwardEvent(mw, hook, undefined);
      });
      addForwarder(mw, hook, () => {
        unsubCells();
        unsubBulk();
      });
      break;
    }

    // ---- pivot ----
    case "pivot.onRefresh":
      addForwarder(mw, hook, onAppEvent("pivot:refresh", (detail) => {
        const d = detail as { pivotId?: string } | undefined;
        if (d?.pivotId !== undefined && String(d.pivotId) !== instanceId) return;
        pushPivotFieldsMirror(mw, instanceId);
        forwardEvent(mw, hook, undefined);
      }));
      break;

    // ---- button ----
    case "button.onClick":
      addForwarder(mw, hook, onAppEvent("button:clicked", (detail) => {
        const d = detail as { instanceId: string; x: number; y: number };
        if (d.instanceId !== instanceId) return;
        forwardEvent(mw, hook, { x: d.x, y: d.y });
      }));
      break;

    // ---- shape ----
    case "shape.onClick":
      addForwarder(mw, hook, onAppEvent("shape:clicked", (detail) => {
        const d = detail as { instanceId: string; x: number; y: number };
        if (d.instanceId !== instanceId) return;
        forwardEvent(mw, hook, { x: d.x, y: d.y });
      }));
      break;
    case "shape.onResize":
      addForwarder(mw, hook, onAppEvent("shape:resized", (detail) => {
        const d = detail as { instanceId: string; width: number; height: number };
        if (d.instanceId !== instanceId) return;
        invalidateBitmap("shape", instanceId);
        forwardEvent(mw, hook, { width: d.width, height: d.height });
      }));
      break;
    case "shape.onPropertyChange":
      addForwarder(mw, hook, onAppEvent("shape:propertyChanged", (detail) => {
        const d = detail as { instanceId: string; key: string; oldValue: string; newValue: string };
        if (d.instanceId !== instanceId) return;
        mw.shapeProps.set(d.key, d.newValue);
        invalidateBitmap("shape", instanceId);
        forwardEvent(mw, hook, { key: d.key, oldValue: d.oldValue, newValue: d.newValue });
      }));
      break;
    case "shape.onCellChange":
      addForwarder(mw, hook, onAppEvent(AppEvents.CELL_VALUES_CHANGED, (detail) => {
        const d = detail as { changes: unknown[] };
        invalidateBitmap("shape", instanceId);
        forwardEvent(mw, hook, { changes: d.changes });
      }));
      break;
    case "shape.onMessage":
      addForwarder(mw, hook, onAppEvent("shape:htmlMessage", (detail) => {
        const d = detail as { instanceId: string; type: string; data: unknown };
        if (d.instanceId !== instanceId) return;
        forwardEvent(mw, hook, { type: d.type, data: d.data });
      }));
      break;

    // ---- panel ----
    case "panel.onClick":
    case "panel.onActivate":
    case "panel.onDeactivate": {
      const eventName =
        hook === "onClick" ? "panel:clicked" : hook === "onActivate" ? "panel:activated" : "panel:deactivated";
      addForwarder(mw, hook, onAppEvent(eventName, (detail) => {
        const d = detail as { panelId: string; placement: string };
        if (d.panelId !== instanceId) return;
        forwardEvent(mw, hook, { placement: d.placement });
      }));
      break;
    }
    case "panel.onPlacementChange":
      addForwarder(mw, hook, onAppEvent("panel:placementChanged", (detail) => {
        const d = detail as { panelId: string; oldPlacement: string; newPlacement: string };
        if (d.panelId !== instanceId) return;
        post(mw, { t: "mirror", path: "panel.placement", value: d.newPlacement });
        forwardEvent(mw, hook, { oldPlacement: d.oldPlacement, newPlacement: d.newPlacement });
      }));
      break;
    case "panel.onShow":
    case "panel.onHide": {
      const eventName = hook === "onShow" ? "panel:shown" : "panel:hidden";
      addForwarder(mw, hook, onAppEvent(eventName, (detail) => {
        const d = detail as { panelId: string };
        if (d.panelId !== instanceId) return;
        forwardEvent(mw, hook, undefined);
      }));
      break;
    }

    default:
      // Unknown hook: nothing to wire (pruned/dead surface).
      break;
  }

  // Panel placement metadata also feeds the mirror regardless of hooks.
  if (objectType === "panel" && !mw.forwarders.has("__panelMeta")) {
    addForwarder(mw, "__panelMeta", onAppEvent("panel:metadata", (detail) => {
      const d = detail as { panelId: string; placement: string; movable: boolean };
      if (d.panelId !== instanceId) return;
      post(mw, { t: "mirror", path: "panel.placement", value: d.placement });
      post(mw, { t: "mirror", path: "panel.movable", value: d.movable });
    }));
  }
}

// ============================================================================
// Mirrors
// ============================================================================

async function buildSnapshot(definition: HostMountDefinition, mw: MountedWorker): Promise<MountSpec["snapshot"]> {
  const properties: Record<string, unknown> = {};
  let selection: unknown;
  const instanceId = definition.instanceId || "";

  try {
    switch (definition.objectType) {
      case "workbook": {
        const backend = await import("../backend");
        try {
          const props = await backend.getWorkbookProperties();
          properties["workbook.title"] = props.title;
          properties["workbook.author"] = props.author;
        } catch { /* defaults */ }
        try {
          const lib = await getLib();
          const sheets = await lib.getSheets();
          properties["workbook.sheetCount"] = sheets.sheets.length;
          properties["workbook.sheetNames"] = sheets.sheets.map((s: { name: string }) => s.name);
        } catch { /* defaults */ }
        break;
      }
      case "slicer": {
        const store = getSlicerStoreService();
        if (store) {
          selection = store.getSelectedItems(instanceId);
          const slicer = store.getSlicerById(instanceId);
          if (slicer) {
            properties["slicer.fieldName"] = slicer.fieldName ?? "";
            properties["slicer.sourceType"] = slicer.sourceType ?? "";
            properties["slicer.columns"] = slicer.columns ?? 1;
          }
        }
        break;
      }
      case "chart": {
        const store = getChartStoreService();
        const chart = store?.getChartById(instanceId);
        if (chart) {
          try {
            properties["chart.spec"] = JSON.parse(chart.specJson);
          } catch { /* unparseable */ }
        }
        break;
      }
      case "pivot": {
        const store = getPivotStoreService();
        if (store) {
          properties["pivot.fields"] = store.getPivotFields(instanceId);
        }
        break;
      }
      case "shape": {
        const parts = instanceId.replace("control-", "").split("-");
        if (parts.length >= 3) {
          const sheetIndex = parseInt(parts[0], 10);
          const row = parseInt(parts[1], 10);
          const col = parseInt(parts[2], 10);
          if (!isNaN(sheetIndex) && !isNaN(row) && !isNaN(col)) {
            const { invokeBackend } = await import("../backend");
            const resolved = await invokeBackend<Record<string, string>>(
              "resolve_control_properties",
              { sheetIndex, row, col },
            );
            if (resolved) {
              properties["shape.properties"] = resolved;
              for (const [k, v] of Object.entries(resolved)) {
                mw.shapeProps.set(k, v);
              }
            }
          }
        }
        break;
      }
    }
  } catch {
    // Snapshot failures degrade to defaults — scripts still mount.
  }

  return { properties, selection };
}

function pushWorkbookMirror(mw: MountedWorker): void {
  void (async () => {
    try {
      const lib = await getLib();
      const sheets = await lib.getSheets();
      post(mw, { t: "mirror", path: "workbook.sheetCount", value: sheets.sheets.length });
      post(mw, { t: "mirror", path: "workbook.sheetNames", value: sheets.sheets.map((s: { name: string }) => s.name) });
    } catch { /* keep stale mirror */ }
    try {
      const backend = await import("../backend");
      const props = await backend.getWorkbookProperties();
      post(mw, { t: "mirror", path: "workbook.title", value: props.title });
      post(mw, { t: "mirror", path: "workbook.author", value: props.author });
    } catch { /* keep stale mirror */ }
  })();
}

function pushChartSpecMirror(mw: MountedWorker, instanceId: string): void {
  const chart = getChartStoreService()?.getChartById(instanceId);
  if (chart) {
    try {
      post(mw, { t: "mirror", path: "chart.spec", value: JSON.parse(chart.specJson) });
    } catch { /* unparseable spec — keep previous mirror */ }
  }
}

function pushPivotFieldsMirror(mw: MountedWorker, instanceId: string): void {
  const store = getPivotStoreService();
  if (store) {
    post(mw, { t: "mirror", path: "pivot.fields", value: store.getPivotFields(instanceId) });
  }
}

// ============================================================================
// Render plumbing
// ============================================================================

function requestCellStyles(mw: MountedWorker, cells: RenderCellRequest[]): Promise<(IStyleOverride | null)[] | null> {
  if (!mounted.has(mw.definition.id)) {
    return Promise.resolve(null);
  }
  const reqId = mw.nextReqId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      mw.pendingRenderCells.delete(reqId);
      resolve(null); // degrade: base styling this round
    }, RENDER_TIMEOUT_MS) as unknown as number;
    mw.pendingRenderCells.set(reqId, {
      resolve: resolve as (styles: (StyleOverride | null)[] | null) => void,
      timer,
    });
    post(mw, { t: "renderCells", reqId, cells });
  });
}

function wireShapeBitmapInvalidation(mw: MountedWorker, instanceId: string): void {
  // propertyChanged / resize / cell-change invalidation is wired with the
  // corresponding hooks when registered; render.invalidate covers the rest.
  // Here we only ensure a dispose path exists for the bitmap itself.
  mw.cleanupFns.push(() => invalidateBitmap("shape", instanceId));
}

/**
 * Host blit API for shapeRenderer: returns the cached bitmap for a shape, and
 * (single-flight) requests one from the script's worker when missing.
 */
export function getShapeBitmap(
  instanceId: string,
  w: number,
  h: number,
  dpr: number,
): ImageBitmap | null {
  const cached = getBitmap("shape", instanceId);
  if (cached) {
    return cached.bitmap;
  }
  const mw = findWorkerForInstance("shape", instanceId);
  if (mw) {
    requestDraw(mw, { kind: "shape", key: instanceId }, w, h, dpr);
  }
  return null;
}

/** True when a worker-realm script provides a canvas renderer for this shape. */
export function hasShapeBitmapRenderer(instanceId: string): boolean {
  return findWorkerForInstance("shape", instanceId) !== null;
}

/**
 * Host blit API for the slicer renderer. Key self-invalidates on state
 * change (slicerId + item text + selected + hasData + size).
 */
export function getSlicerItemBitmap(
  slicerId: string,
  item: { text: string; selected: boolean; hasData: boolean },
  w: number,
  h: number,
  dpr: number,
): ImageBitmap | null {
  const key = `${slicerId}:${item.text}:${item.selected}:${item.hasData}:${Math.round(w)}x${Math.round(h)}`;
  const cached = getBitmap("slicerItem", key);
  if (cached) {
    return cached.bitmap;
  }
  const mw = findWorkerForInstance("slicer", slicerId);
  if (mw) {
    requestDraw(mw, { kind: "slicerItem", key, item }, w, h, dpr);
  }
  return null;
}

/** True when a worker-realm script provides an item renderer for this slicer. */
export function hasSlicerItemBitmapRenderer(slicerId: string): boolean {
  return findWorkerForInstance("slicer", slicerId) !== null;
}

function findWorkerForInstance(objectType: string, instanceId: string): MountedWorker | null {
  for (const mw of mounted.values()) {
    if (mw.definition.objectType === objectType && mw.definition.instanceId === instanceId) {
      const rendererHook = objectType === "shape" ? "canvasRenderer" : "itemRenderer";
      // Only workers that declared the renderer hook can draw.
      return mw.declaredRenderHooks.has(rendererHook) ? mw : null;
    }
  }
  return null;
}

function requestDraw(mw: MountedWorker, target: RenderDrawTarget, w: number, h: number, dpr: number): void {
  const flightKey = `${target.kind}|${target.key}`;
  if (mw.drawsInFlight.has(flightKey)) {
    return; // single-flight per key
  }
  mw.drawsInFlight.add(flightKey);
  const reqId = mw.nextReqId++;
  const timer = setTimeout(() => {
    mw.pendingRenderDraws.delete(reqId);
    mw.drawsInFlight.delete(flightKey);
  }, RENDER_TIMEOUT_MS) as unknown as number;
  mw.pendingRenderDraws.set(reqId, { key: flightKey, timer });
  post(mw, { t: "renderDraw", reqId, target, w, h, dpr });
}
