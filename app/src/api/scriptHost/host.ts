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
import { assertMountAllowed } from "./mountGate";
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
  sanitizeSandboxGeometry,
} from "./renderCache";
import { ALLOWLIST } from "./allowlist";
import {
  fetchOriginOf,
  grantBiCapability,
  grantNetOrigin,
  hasFetchOrigin,
  recordCapabilityGrant,
  requestCapabilityGrant,
  resetAllGrants,
  revokeBackendCapabilities,
  syncBiGrantsToBackend,
  syncNetOriginsToBackend,
  wasDeniedThisSession,
} from "./capabilities";
import { AppEvents, emitAppEvent, onAppEvent } from "../events";
import {
  tableCellCoord,
  tableDataRowCount,
  tableHeaders,
  tableContains,
  namedRangeCells,
  namedRangeContains,
  type TableLike,
  type NamedRangeCoordsLike,
} from "./objectCoords";
import { showToast } from "../notifications";
import { getCellBehaviorById } from "../cellBehaviors";
import { ExtensionRegistry } from "../extensionRegistry";
import { getSlicerStoreService, getTimelineStoreService, getChartStoreService, getPivotStoreService, getPaneControlStoreService } from "../componentStoreRegistry";
import type { IStyleOverride } from "../styleInterceptors";

type CleanupFn = () => void;

// ============================================================================
// Script write attribution (self-echo suppression for range behaviors)
// ============================================================================
// Broker-originated cell writes are remembered briefly so a range behavior's
// onChange never re-fires for its OWN writes (the classic feedback loop).
// Keyed per script + cell with a short TTL — the rAF-debounced cell-event
// batch always flushes well inside it.

const SCRIPT_WRITE_TTL_MS = 250;
const recentScriptWrites = new Map<string, number>();

function scriptWriteKey(scriptId: string, sheetIndex: number, row: number, col: number): string {
  return `${scriptId}|${sheetIndex}:${row}:${col}`;
}

function recordScriptWrite(scriptId: string, sheetIndex: number, row: number, col: number): void {
  if (recentScriptWrites.size > 8192) {
    const now = performance.now();
    for (const [k, expiry] of recentScriptWrites) {
      if (expiry < now) recentScriptWrites.delete(k);
    }
  }
  recentScriptWrites.set(
    scriptWriteKey(scriptId, sheetIndex, row, col),
    performance.now() + SCRIPT_WRITE_TTL_MS,
  );
}

function isOwnScriptWrite(scriptId: string, sheetIndex: number, row: number, col: number): boolean {
  const key = scriptWriteKey(scriptId, sheetIndex, row, col);
  const expiry = recentScriptWrites.get(key);
  if (expiry === undefined) return false;
  if (expiry < performance.now()) {
    recentScriptWrites.delete(key);
    return false;
  }
  return true;
}

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
  pendingRenderDraws: Map<number, { key: string; timer: number; w: number; h: number }>;
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
  /**
   * Host-side copy of the seeded snapshot properties + subsequent mirror pushes,
   * used by event forwarders to filter by object bounds (table/namedRange range
   * membership) without an IPC refetch per change event.
   */
  hostMirror: Map<string, unknown>;
}

const mounted = new Map<string, MountedWorker>();
const faulted = new Map<string, string>();

/**
 * Whether a mounted script declared a hook (its worker posted hookRegistered
 * and the host wired the forwarder). Cell-behavior dispatch uses this so a
 * binding never claims a gesture its script doesn't even handle — an
 * onChange-only behavior must not swallow clicks.
 */
export function mountedScriptHasHook(scriptId: string, hook: string): boolean {
  const mw = mounted.get(scriptId);
  return !!mw && mw.forwarders.has(hook);
}

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
 * PUBLIC mount entry — the universal Script-Security chokepoint. EVERY worker-realm
 * mount goes through here (object scripts, custom chart marks, custom chart
 * transforms, JS UDF libraries), so the global "Script Security" setting governs
 * them all: assertMountAllowed throws ScriptSecurityBlockedError BEFORE any worker
 * is spawned when the setting is "disabled" or a "prompt" is declined. On allow it
 * delegates to mountWorker. NOTE: the crash-respawn path below calls mountWorker
 * directly — a respawn re-launches already-consented code and must not re-gate (it
 * would risk prompting mid-session or blocking automatic crash recovery).
 */
export async function hostMountScript(definition: HostMountDefinition): Promise<void> {
  await assertMountAllowed(definition.name);
  return mountWorker(definition);
}

/**
 * Mount a script in its own worker realm (ungated internal). Resolves when the
 * worker reports mounted (or rejects with the script's setup error).
 */
async function mountWorker(definition: HostMountDefinition): Promise<void> {
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
    hostMirror: new Map(),
  };
  mounted.set(definition.id, mw);
  mw.cleanupFns.push(registerMountedHandle(handle));
  // Re-establish this script's net.fetch origins in the Rust store (a remount
  // within the session keeps session grants; first mount pushes nothing).
  void syncNetOriginsToBackend(definition.id);
  void syncBiGrantsToBackend(definition.id);

  const snapshot = await buildSnapshot(definition, mw);
  if (snapshot.properties) {
    for (const [k, v] of Object.entries(snapshot.properties)) {
      mw.hostMirror.set(k, v);
    }
  }

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
            const [kind, key] = pending.key.split("|", 2) as ["shape" | "slicerItem" | "chartMark", string];
            // chartMark renderers may return per-datum hit geometry in LOGICAL plot
            // coords. It is UNTRUSTED — sanitize (finite, clamp to the LOGICAL plot
            // size, cap count) before caching it for the Charts shim's hit-testing.
            // Clamp to pending.w/h (logical), NOT msg.bitmap.width/height (physical =
            // dpr-inflated) — else the out-of-plot clamp breaks on HiDPI displays.
            const geometry =
              kind === "chartMark" && msg.hitGeometry
                ? sanitizeSandboxGeometry(msg.hitGeometry, pending.w, pending.h)
                : undefined;
            storeBitmap(kind, key, { bitmap: msg.bitmap, w: msg.bitmap.width, h: msg.bitmap.height, dpr: 1, geometry });
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
    // Respawn already-consented code after a crash — bypass the Script-Security
    // gate (mountWorker, not hostMountScript) so recovery never re-prompts.
    void mountWorker(definition).then(() => {
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
  if (decision !== "deny") {
    recordCapabilityGrant(handle.scriptId, cap);
    // Mirror BI grants to the authoritative Rust store (bi_query/script_bi_sql
    // re-check it per call).
    if (cap === "bi.query" || cap === "bi.sql") {
      await grantBiCapability(handle.scriptId, cap);
    }
  }
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
      recordScriptWrite(definition.id, activeSheetIndexForEvents, row, col);
      await lib.updateCell(row, col, value);
      return undefined;
    }
    case "api.updateCellsBatch": {
      const [updates] = args as [Array<{ row: number; col: number; value: string }>];
      const lib = await getLib();
      for (const u of updates) {
        recordScriptWrite(definition.id, activeSheetIndexForEvents, u.row, u.col);
      }
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
      recordScriptWrite(definition.id, sheetIndex ?? activeSheetIndexForEvents, row, col);
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
      return executeGetState(instanceId, aspect, aspectArgs);
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
      return invokeBackend("bi_query", { connectionId, request, scriptId: definition.id });
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
      return invokeBackend("script_bi_sql", { connectionId, sql, scriptId: definition.id });
    }
    case "cap.cubeValue": {
      // CUBE convenience over the bi.query trust class: a measure sliced by member
      // filters, resolved via the same model-scoped path as the cube formulas.
      const [connection, members] = args as [string, string[]];
      const { invokeBackend } = await import("../backend");
      return invokeBackend("cube_udf_value", { connection, members, scriptId: definition.id });
    }
    case "cap.cubeKpi": {
      const [connection, kpi, property] = args as [string, string, number];
      const { invokeBackend } = await import("../backend");
      return invokeBackend("cube_udf_kpi", { connection, kpi, property, scriptId: definition.id });
    }
    case "cap.cubeMembers": {
      const [connection, level] = args as [string, string];
      const { invokeBackend } = await import("../backend");
      return invokeBackend("cube_udf_members", { connection, level, scriptId: definition.id });
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
    case "timeline.setSelection": {
      const [start, end] = args as [string | null, string | null];
      const store = getTimelineStoreService();
      if (store) {
        await store.setSelection(instanceId, start ?? null, end ?? null);
      }
      return undefined;
    }
    case "chart.updateSpec": {
      const [patch] = args as [Record<string, unknown>];
      const store = getChartStoreService();
      if (store) {
        // Throws on a schema violation -> brokerCall audits ok:false + the
        // script's awaited updateSpec() rejects. Mirror only on success.
        store.updateChartSpec(instanceId, patch);
        pushChartSpecMirror(mw, instanceId);
      }
      return undefined;
    }
    case "chart.replaceSpec": {
      const [fullSpec] = args as [Record<string, unknown>];
      const store = getChartStoreService();
      if (store) {
        store.replaceChartSpec(instanceId, fullSpec);
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
    case "table.setCellValue": {
      const [row, colIndex, value] = args as [number, number, string];
      const lib = await getLib();
      const table = (await lib.getTableById(instanceId)) as TableLike | null;
      if (!table) throw new BrokerError("ValidationError", `Table not found: ${instanceId}`);
      const coord = tableCellCoord(table, row, colIndex);
      if (!coord) {
        throw new BrokerError("ValidationError", `Table cell out of range: row=${row} col=${colIndex}`);
      }
      await writeCellOnSheet(lib, coord.sheetIndex, coord.row, coord.col, String(value));
      emitAppEvent("table:dataChanged", { tableId: instanceId });
      return undefined;
    }
    case "table.addRow": {
      const lib = await getLib();
      await lib.addTableRow(instanceId);
      emitAppEvent("table:dataChanged", { tableId: instanceId });
      pushTableMirror(mw, instanceId);
      return undefined;
    }
    case "namedRange.setValues": {
      const [values] = args as [string[][]];
      const lib = await getLib();
      const coords = (await lib.resolveNamedRangeCoords(instanceId)) as NamedRangeCoordsLike;
      const active = await lib.getActiveSheet();
      const updates: Array<{ row: number; col: number; value: string }> = [];
      const rows = coords.endRow - coords.startRow + 1;
      const cols = coords.endCol - coords.startCol + 1;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const v = values?.[r]?.[c];
          if (v === undefined) continue;
          const gridRow = coords.startRow + r;
          const gridCol = coords.startCol + c;
          if (coords.sheetIndex === active) {
            updates.push({ row: gridRow, col: gridCol, value: String(v) });
          } else {
            await lib.updateCellOnSheets([coords.sheetIndex], gridRow, gridCol, String(v));
          }
        }
      }
      if (updates.length > 0) {
        await lib.updateCellsBatch(updates);
      }
      emitAppEvent("namedRange:changed", { name: instanceId });
      return undefined;
    }
    case "range.setValues": {
      // Structurally clamped: a range behavior can only write inside its own
      // binding target (R16). Same write mechanics as namedRange.setValues.
      const [values] = args as [string[][]];
      const b = getCellBehaviorById(instanceId);
      if (!b) throw new BrokerError("ValidationError", `Behavior binding not found: ${instanceId}`);
      const lib = await getLib();
      const active = await lib.getActiveSheet();
      const updates: Array<{ row: number; col: number; value: string }> = [];
      const rows = b.endRow - b.startRow + 1;
      const cols = b.endCol - b.startCol + 1;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const v = values?.[r]?.[c];
          if (v === undefined) continue;
          const gridRow = b.startRow + r;
          const gridCol = b.startCol + c;
          recordScriptWrite(mw.definition.id, b.sheetIndex, gridRow, gridCol);
          if (b.sheetIndex === active) {
            updates.push({ row: gridRow, col: gridCol, value: String(v) });
          } else {
            await lib.updateCellOnSheets([b.sheetIndex], gridRow, gridCol, String(v));
          }
        }
      }
      if (updates.length > 0) {
        await lib.updateCellsBatch(updates);
      }
      return undefined;
    }
    case "range.setCellType": {
      // The two-tier handshake: a script assigns an extension-tier cell type
      // to its own target (undoable via the cell-types store).
      const [typeId, params] = args as [string, Record<string, unknown> | undefined];
      const b = getCellBehaviorById(instanceId);
      if (!b) throw new BrokerError("ValidationError", `Behavior binding not found: ${instanceId}`);
      const lib = await getLib();
      const active = await lib.getActiveSheet();
      if (b.sheetIndex !== active) {
        // The cell-types backend commands operate on the active sheet (v1).
        throw new BrokerError(
          "HostError",
          "range.setCellType currently requires the binding's sheet to be active",
        );
      }
      const cellTypes = await import("../cellTypes");
      await cellTypes.setCellTypeRange(b.startRow, b.startCol, b.endRow, b.endCol, typeId, params ?? {});
      return undefined;
    }
    case "range.clearCellType": {
      const b = getCellBehaviorById(instanceId);
      if (!b) throw new BrokerError("ValidationError", `Behavior binding not found: ${instanceId}`);
      const lib = await getLib();
      const active = await lib.getActiveSheet();
      if (b.sheetIndex !== active) {
        throw new BrokerError(
          "HostError",
          "range.clearCellType currently requires the binding's sheet to be active",
        );
      }
      const cellTypes = await import("../cellTypes");
      await cellTypes.clearCellTypeRange(b.startRow, b.startCol, b.endRow, b.endCol);
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

async function executeGetState(instanceId: string, aspect: string, args: unknown[]): Promise<unknown> {
  switch (aspect) {
    case "shape.cellValue": {
      const [cellRef] = args as [string];
      const parsed = parseCellRef(cellRef);
      if (!parsed) return "";
      const lib = await getLib();
      const cell = await lib.getCell(parsed.row, parsed.col);
      return cell?.display ?? "";
    }
    case "table.getCellValue": {
      const [row, colIndex] = args as [number, number];
      const lib = await getLib();
      const table = (await lib.getTableById(instanceId)) as TableLike | null;
      if (!table) return "";
      const coord = tableCellCoord(table, row, colIndex);
      if (!coord) return "";
      return readCellOnSheet(lib, coord.sheetIndex, coord.row, coord.col);
    }
    default:
      throw new BrokerError("ValidationError", `Unknown getState aspect: ${aspect}`);
  }
}

/**
 * Read a single cell's display value on a specific sheet. Uses the active-sheet
 * fast path (getCell) when the target IS the active sheet; otherwise reads
 * cross-sheet via getWatchCells. Both recalc-aware reads return display strings.
 */
async function readCellOnSheet(
  lib: Awaited<ReturnType<typeof getLib>>,
  sheetIndex: number,
  row: number,
  col: number,
): Promise<string> {
  const active = await lib.getActiveSheet();
  if (sheetIndex === active) {
    const cell = await lib.getCell(row, col);
    return cell?.display ?? "";
  }
  const results = await lib.getWatchCells([[sheetIndex, row, col]]);
  return results[0]?.display ?? "";
}

/**
 * Write a single cell on a specific sheet, recalc + undoable. Uses updateCell
 * on the active sheet, otherwise updateCellOnSheets for a non-active sheet.
 */
async function writeCellOnSheet(
  lib: Awaited<ReturnType<typeof getLib>>,
  sheetIndex: number,
  row: number,
  col: number,
  value: string,
): Promise<void> {
  const active = await lib.getActiveSheet();
  if (sheetIndex === active) {
    await lib.updateCell(row, col, value);
  } else {
    await lib.updateCellOnSheets([sheetIndex], row, col, value);
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

// ============================================================================
// Range onBeforeCommit (granular bricks phase 3): sandboxed commit verdicts
// ============================================================================

/** Hard deadline for a script's commit verdict. A slow or hung handler must
 *  never hold the user's Enter keypress hostage — timeout = allow. */
const BEFORE_COMMIT_DEADLINE_MS = 1500;

const BEFORE_COMMIT_TIMEOUT = Symbol("beforeCommitTimeout");

/** Verdict a range script's onBeforeCommit may return. */
export interface RangeCommitVerdict {
  action?: "allow" | "block" | "retry";
  /** Replacement value when allowing (rewrites chain via commit guards). */
  newValue?: string;
}

/**
 * Ask a mounted range script for a commit verdict (its onBeforeCommit
 * handler), bounded by BEFORE_COMMIT_DEADLINE_MS. Timeouts, errors, and
 * unmounted scripts all resolve to null = allow (default-allow policy; the
 * opt-in blocking mode is a later slice surfaced through consent).
 */
export async function callRangeBeforeCommit(
  scriptId: string,
  payload: { row: number; col: number; value: string },
): Promise<RangeCommitVerdict | null> {
  const mw = mounted.get(scriptId);
  if (!mw) return null;
  try {
    const result = await Promise.race([
      relayMethodCall(mw, "__range_onBeforeCommit", [payload]),
      new Promise<typeof BEFORE_COMMIT_TIMEOUT>((resolve) =>
        setTimeout(() => resolve(BEFORE_COMMIT_TIMEOUT), BEFORE_COMMIT_DEADLINE_MS),
      ),
    ]);
    if (result === BEFORE_COMMIT_TIMEOUT) {
      console.warn(
        `[CellBehaviors] onBeforeCommit of "${mw.definition.name}" exceeded ${BEFORE_COMMIT_DEADLINE_MS}ms — allowing the commit`,
      );
      return null;
    }
    // Accept both the shorthand string verdict and the object form.
    if (result === "block" || result === "retry") {
      return { action: result };
    }
    if (result && typeof result === "object") {
      const v = result as RangeCommitVerdict;
      if (v.action === "block" || v.action === "retry" || typeof v.newValue === "string") {
        return v;
      }
    }
    return null;
  } catch {
    return null; // handler threw — allow (error already surfaced via console)
  }
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
  if (hook === "markRenderer") {
    // Chart-mark bitmaps self-invalidate by composite key (markId+spec+data+size);
    // nothing further to wire, like the slicer item renderer.
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
        const d = detail as { changes?: unknown[] };
        forwardEvent(mw, hook, { sheetIndex: activeSheetIndexForEvents, changes: d.changes ?? [] });
      }));
      break;

    // ---- cell ----
    case "cell.onEdit":
      addForwarder(mw, hook, onAppEvent(AppEvents.CELL_VALUES_CHANGED, (detail) => {
        const d = detail as { changes?: Array<{ row: number; col: number; sheetIndex?: number; oldValue?: string; newValue: string; formula?: string | null }> };
        forwardEvent(mw, hook, {
          changes: (d.changes ?? []).map((change) => ({
            row: change.row,
            col: change.col,
            // Per-change sheet when the emitter tagged a cross-sheet edit; else the
            // active sheet (the historical implicit contract).
            sheetIndex: change.sheetIndex ?? activeSheetIndexForEvents,
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

    // ---- timeline (date-range slicer) ----
    case "timeline.onChange":
      addForwarder(mw, hook, onAppEvent("timelineSlicer:selectionChanged", (detail) => {
        const d = detail as { timelineId: string; selectionStart: string | null; selectionEnd: string | null };
        if (String(d.timelineId) !== instanceId) return;
        post(mw, { t: "mirror", path: "timeline.selectionStart", value: d.selectionStart });
        post(mw, { t: "mirror", path: "timeline.selectionEnd", value: d.selectionEnd });
        forwardEvent(mw, hook, { start: d.selectionStart, end: d.selectionEnd });
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
          // The chart's data sheet; a change with no per-change sheet is assumed
          // active-sheet (the historical implicit contract).
          const chartSheet = range.sheetIndex ?? activeSheetIndexForEvents;
          const d = detail as { changes?: Array<{ row: number; col: number; sheetIndex?: number }> };
          const hit = d.changes?.some(
            (c) =>
              (c.sheetIndex ?? activeSheetIndexForEvents) === chartSheet &&
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

    case "pivot.onDrillThrough":
      addForwarder(mw, hook, onAppEvent("pivot:drillThrough", (detail) => {
        const d = detail as { pivotId?: string; cell?: unknown } | undefined;
        if (d?.pivotId !== undefined && String(d.pivotId) !== instanceId) return;
        forwardEvent(mw, hook, { pivotId: instanceId, cell: d?.cell ?? [] });
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

    // ---- table ----
    case "table.onDataChange": {
      // Fire when a cell inside the table's range changes, or when an explicit
      // table:dataChanged for THIS table is emitted (e.g. by our own setters /
      // addRow). Range membership uses the seeded mirror coords; over-firing on
      // ambiguity is acceptable for v1.
      const inTableRange = (changes: Array<{ row: number; col: number; sheetIndex?: number }>): boolean => {
        const tableSheet = getMirror(mw, "table.sheetIndex");
        const startRow = getMirror(mw, "table.startRow");
        const startCol = getMirror(mw, "table.startCol");
        const endRow = getMirror(mw, "table.endRow");
        const endCol = getMirror(mw, "table.endCol");
        if (startRow == null || startCol == null || endRow == null || endCol == null) {
          return true; // unknown bounds -> over-fire
        }
        const t: TableLike = {
          sheetIndex: tableSheet ?? 0,
          startRow, startCol, endRow, endCol,
          styleOptions: { headerRow: false, totalRow: false },
          columns: [],
        };
        // Gate by sheet too (a change with no per-change sheet is assumed active,
        // the historical implicit contract) so a cross-sheet dependent that
        // coincidentally falls in the table's bbox doesn't spuriously fire.
        return changes.some(
          (c) =>
            (c.sheetIndex ?? activeSheetIndexForEvents) === (tableSheet ?? activeSheetIndexForEvents) &&
            tableContains(t, c.row, c.col),
        );
      };
      const unsubCells = onAppEvent(AppEvents.CELL_VALUES_CHANGED, (detail) => {
        const d = detail as { changes?: Array<{ row: number; col: number; sheetIndex?: number; newValue: string }> };
        const changes = d.changes ?? [];
        if (!inTableRange(changes)) return;
        pushTableMirror(mw, instanceId);
        forwardEvent(mw, hook, { changes });
      });
      const unsubExplicit = onAppEvent("table:dataChanged", (detail) => {
        const d = detail as { tableId?: string } | undefined;
        if (d?.tableId !== undefined && String(d.tableId) !== instanceId) return;
        pushTableMirror(mw, instanceId);
        forwardEvent(mw, hook, { changes: [] });
      });
      addForwarder(mw, hook, () => {
        unsubCells();
        unsubExplicit();
      });
      break;
    }

    // ---- namedRange ----
    case "namedRange.onChange": {
      const coordsFromMirror = (): NamedRangeCoordsLike | null => {
        const startRow = getMirror(mw, "namedRange.startRow");
        const startCol = getMirror(mw, "namedRange.startCol");
        const endRow = getMirror(mw, "namedRange.endRow");
        const endCol = getMirror(mw, "namedRange.endCol");
        const sheetIndex = getMirror(mw, "namedRange.sheetIndex");
        if (
          startRow == null || startCol == null || endRow == null ||
          endCol == null || sheetIndex == null
        ) {
          return null;
        }
        return { sheetIndex, startRow, startCol, endRow, endCol };
      };
      const unsubCells = onAppEvent(AppEvents.CELL_VALUES_CHANGED, (detail) => {
        const d = detail as { changes?: Array<{ row: number; col: number; sheetIndex?: number; newValue: string }> };
        const changes = d.changes ?? [];
        const coords = coordsFromMirror();
        // Unknown bounds -> over-fire. Known bounds -> only when a change lands
        // inside AND on the named range's sheet (a change with no per-change sheet
        // is assumed active-sheet, the historical implicit contract).
        const hit = !coords || changes.some(
          (c) =>
            (c.sheetIndex ?? activeSheetIndexForEvents) === coords.sheetIndex &&
            namedRangeContains(coords, c.row, c.col),
        );
        if (!hit) return;
        pushNamedRangeMirror(mw, instanceId);
        forwardEvent(mw, hook, { changes });
      });
      const unsubExplicit = onAppEvent("namedRange:changed", (detail) => {
        const d = detail as { name?: string } | undefined;
        if (d?.name !== undefined && String(d.name) !== instanceId) return;
        pushNamedRangeMirror(mw, instanceId);
        forwardEvent(mw, hook, { changes: [] });
      });
      addForwarder(mw, hook, () => {
        unsubCells();
        unsubExplicit();
      });
      break;
    }

    // ---- range (cell-behavior bindings, granular bricks phase 2) ----
    case "range.onBeforeCommit":
      // A replying hook: no event forwarder — the commit guard PULLS a verdict
      // via callRangeBeforeCommit. The no-op forwarder records hook presence
      // (mountedScriptHasHook) so untyped commits skip the worker entirely.
      addForwarder(mw, hook, () => {});
      break;
    case "range.onClick":
      addForwarder(mw, hook, onAppEvent("cellbehavior:clicked", (detail) => {
        const d = detail as { bindingId: string; row: number; col: number; sheetIndex: number; ctrlKey: boolean; metaKey: boolean };
        if (d.bindingId !== instanceId) return;
        forwardEvent(mw, hook, {
          row: d.row,
          col: d.col,
          sheetIndex: d.sheetIndex,
          ctrlKey: d.ctrlKey,
          metaKey: d.metaKey,
        });
      }));
      break;
    case "range.onDoubleClick":
      addForwarder(mw, hook, onAppEvent("cellbehavior:dblclicked", (detail) => {
        const d = detail as { bindingId: string; row: number; col: number; sheetIndex: number };
        if (d.bindingId !== instanceId) return;
        forwardEvent(mw, hook, { row: d.row, col: d.col, sheetIndex: d.sheetIndex });
      }));
      break;
    case "range.onChange": {
      // Per-binding delivery policy: one delivery per cell-event flush,
      // clipped to the binding's target, capped, self-echo suppressed, and
      // rate-limited by a token bucket so a recalc storm can't flood the
      // worker queue.
      const MAX_CHANGE_ENTRIES = 1000;
      const BUCKET_CAPACITY = 20; // deliveries
      const REFILL_PER_SECOND = 20;
      let tokens = BUCKET_CAPACITY;
      let lastRefill = performance.now();
      addForwarder(mw, hook, onAppEvent(AppEvents.CELL_VALUES_CHANGED, (detail) => {
        const b = getCellBehaviorById(instanceId);
        if (!b || !b.enabled || b.orphaned) return;
        const d = detail as { changes?: Array<{ row: number; col: number; sheetIndex?: number; newValue: string }> };
        const changes = d.changes ?? [];
        const clipped: Array<{ row: number; col: number; newValue: string }> = [];
        for (const c of changes) {
          const sheet = c.sheetIndex ?? activeSheetIndexForEvents;
          if (sheet !== b.sheetIndex) continue;
          if (c.row < b.startRow || c.row > b.endRow || c.col < b.startCol || c.col > b.endCol) continue;
          // Self-echo suppression: this script's own broker writes never
          // re-fire its onChange (the classic feedback loop).
          if (isOwnScriptWrite(definition.id, sheet, c.row, c.col)) continue;
          clipped.push({ row: c.row, col: c.col, newValue: c.newValue });
          if (clipped.length > MAX_CHANGE_ENTRIES) break;
        }
        if (clipped.length === 0) return;
        const now = performance.now();
        tokens = Math.min(BUCKET_CAPACITY, tokens + ((now - lastRefill) / 1000) * REFILL_PER_SECOND);
        lastRefill = now;
        if (tokens < 1) return; // over budget this second — drop (script re-reads via getValues)
        tokens -= 1;
        const truncated = clipped.length > MAX_CHANGE_ENTRIES;
        if (truncated) clipped.length = MAX_CHANGE_ENTRIES;
        pushRangeMirror(mw, instanceId);
        forwardEvent(mw, hook, truncated ? { changes: clipped, truncated: true } : { changes: clipped });
      }));
      break;
    }

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
        const d = detail as { changes?: unknown[] };
        invalidateBitmap("shape", instanceId);
        forwardEvent(mw, hook, { changes: d.changes ?? [] });
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
      case "timeline": {
        const store = getTimelineStoreService();
        const tl = store?.getTimelineById(instanceId);
        if (tl) {
          properties["timeline.selectionStart"] = tl.selectionStart;
          properties["timeline.selectionEnd"] = tl.selectionEnd;
          properties["timeline.fieldName"] = tl.fieldName ?? "";
          properties["timeline.level"] = tl.level ?? "";
          properties["timeline.sourceType"] = tl.sourceType ?? "";
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
        // Pane-hosted custom control ("pane-{controlId}"): seed declared
        // properties from the ControlsPane store service (read-only; no
        // backend/broker call, no canvas anchor cell to resolve).
        if (instanceId.startsWith("pane-")) {
          const paneStore = getPaneControlStoreService();
          const declared = paneStore?.getProperties(instanceId.slice("pane-".length));
          if (declared) {
            properties["shape.properties"] = declared;
            for (const [k, v] of Object.entries(declared)) {
              mw.shapeProps.set(k, v);
            }
          }
          break;
        }
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
      case "table": {
        const lib = await getLib();
        const table = (await lib.getTableById(instanceId)) as TableLike & { name?: string } | null;
        if (table) {
          properties["table.headers"] = tableHeaders(table);
          properties["table.rowCount"] = tableDataRowCount(table);
          properties["table.name"] = table.name ?? "";
          properties["table.sheetIndex"] = table.sheetIndex;
          properties["table.startRow"] = table.startRow;
          properties["table.startCol"] = table.startCol;
          properties["table.endRow"] = table.endRow;
          properties["table.endCol"] = table.endCol;
        }
        break;
      }
      case "namedRange": {
        const lib = await getLib();
        try {
          const coords = (await lib.resolveNamedRangeCoords(instanceId)) as NamedRangeCoordsLike;
          properties["namedRange.address"] = await formatRangeAddress(lib, coords);
          properties["namedRange.values"] = await readRangeValues(lib, coords);
          properties["namedRange.sheetIndex"] = coords.sheetIndex;
          properties["namedRange.startRow"] = coords.startRow;
          properties["namedRange.startCol"] = coords.startCol;
          properties["namedRange.endRow"] = coords.endRow;
          properties["namedRange.endCol"] = coords.endCol;
        } catch { /* unresolvable range — defaults */ }
        try {
          const nr = await lib.getNamedRange(instanceId);
          if (nr) {
            properties["namedRange.refersTo"] = nr.refersTo;
            properties["namedRange.scope"] = nr.sheetIndex == null ? "workbook" : "sheet";
          }
        } catch { /* defaults */ }
        break;
      }
      case "range": {
        // The binding may not be in the frontend index yet at workbook-open
        // mount time — fall back to the authoritative backend store.
        let b = getCellBehaviorById(instanceId);
        if (!b) {
          try {
            const { invokeBackend } = await import("../backend");
            b = await invokeBackend<typeof b>("get_cell_behavior", { id: instanceId });
          } catch { /* defaults */ }
        }
        if (b) {
          const lib = await getLib();
          const coords: NamedRangeCoordsLike = {
            sheetIndex: b.sheetIndex,
            startRow: b.startRow,
            startCol: b.startCol,
            endRow: b.endRow,
            endCol: b.endCol,
          };
          properties["range.address"] = await formatRangeAddress(lib, coords);
          properties["range.values"] = await readRangeValues(lib, coords);
        }
        break;
      }
    }
  } catch {
    // Snapshot failures degrade to defaults — scripts still mount.
  }

  return { properties, selection };
}

/** Build an "Sheet!A1:B10" address from resolved coords (sheet name resolved). */
async function formatRangeAddress(
  lib: Awaited<ReturnType<typeof getLib>>,
  coords: NamedRangeCoordsLike,
): Promise<string> {
  const a1 = `${colIndexToLetters(coords.startCol)}${coords.startRow + 1}:${colIndexToLetters(coords.endCol)}${coords.endRow + 1}`;
  try {
    const sheets = await lib.getSheets();
    const name = sheets.sheets[coords.sheetIndex]?.name;
    return name ? `${name}!${a1}` : a1;
  } catch {
    return a1;
  }
}

/** Read a named range's cells into a 2D array of display strings (row-major). */
async function readRangeValues(
  lib: Awaited<ReturnType<typeof getLib>>,
  coords: NamedRangeCoordsLike,
): Promise<string[][]> {
  const cells = namedRangeCells(coords);
  if (cells.length === 0) return [];
  const requests = cells.map((c) => [c.sheetIndex, c.row, c.col] as [number, number, number]);
  const results = await lib.getWatchCells(requests);
  const rows = coords.endRow - coords.startRow + 1;
  const cols = coords.endCol - coords.startCol + 1;
  const out: string[][] = [];
  let i = 0;
  for (let r = 0; r < rows; r++) {
    const rowArr: string[] = [];
    for (let c = 0; c < cols; c++) {
      rowArr.push(results[i]?.display ?? "");
      i++;
    }
    out.push(rowArr);
  }
  return out;
}

/** 0-based column index to A1 letters (0 -> "A", 26 -> "AA"). */
function colIndexToLetters(col: number): string {
  let n = col + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
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

/** Read a numeric host-side mirror value (snapshot-seeded + push-updated). */
function getMirror(mw: MountedWorker, path: string): number | null {
  const v = mw.hostMirror.get(path);
  return typeof v === "number" ? v : null;
}

/** Post a mirror to the worker AND keep the host-side mirror in sync. */
function postMirror(mw: MountedWorker, path: string, value: unknown): void {
  mw.hostMirror.set(path, value);
  post(mw, { t: "mirror", path, value });
}

/**
 * Refetch a table and push its mirrors (rowCount/headers/name/sheetIndex +
 * bounds for host-side range filtering). Mirror of pushPivotFieldsMirror.
 */
function pushTableMirror(mw: MountedWorker, instanceId: string): void {
  void (async () => {
    try {
      const lib = await getLib();
      const table = (await lib.getTableById(instanceId)) as (TableLike & { name?: string }) | null;
      if (!table) return;
      postMirror(mw, "table.rowCount", tableDataRowCount(table));
      postMirror(mw, "table.headers", tableHeaders(table));
      postMirror(mw, "table.name", table.name ?? "");
      postMirror(mw, "table.sheetIndex", table.sheetIndex);
      postMirror(mw, "table.startRow", table.startRow);
      postMirror(mw, "table.startCol", table.startCol);
      postMirror(mw, "table.endRow", table.endRow);
      postMirror(mw, "table.endCol", table.endCol);
    } catch { /* keep stale mirror */ }
  })();
}

/**
 * Refetch a named range and push its mirrors (values/address + bounds for
 * host-side range filtering). Mirror of pushPivotFieldsMirror.
 */
function pushNamedRangeMirror(mw: MountedWorker, instanceId: string): void {
  void (async () => {
    try {
      const lib = await getLib();
      const coords = (await lib.resolveNamedRangeCoords(instanceId)) as NamedRangeCoordsLike;
      postMirror(mw, "namedRange.values", await readRangeValues(lib, coords));
      postMirror(mw, "namedRange.address", await formatRangeAddress(lib, coords));
      postMirror(mw, "namedRange.sheetIndex", coords.sheetIndex);
      postMirror(mw, "namedRange.startRow", coords.startRow);
      postMirror(mw, "namedRange.startCol", coords.startCol);
      postMirror(mw, "namedRange.endRow", coords.endRow);
      postMirror(mw, "namedRange.endCol", coords.endCol);
    } catch { /* keep stale mirror */ }
  })();
}

/**
 * Refetch a range behavior's target and push its mirrors (values/address for
 * the sync getters). The target coords come from the binding store — the
 * binding is the source of truth, shifted by structural edits.
 */
function pushRangeMirror(mw: MountedWorker, bindingId: string): void {
  void (async () => {
    try {
      const b = getCellBehaviorById(bindingId);
      if (!b) return;
      const lib = await getLib();
      const coords: NamedRangeCoordsLike = {
        sheetIndex: b.sheetIndex,
        startRow: b.startRow,
        startCol: b.startCol,
        endRow: b.endRow,
        endCol: b.endCol,
      };
      postMirror(mw, "range.values", await readRangeValues(lib, coords));
      postMirror(mw, "range.address", await formatRangeAddress(lib, coords));
    } catch { /* keep stale mirror */ }
  })();
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

/**
 * Host blit API for a sandboxed chart mark (B8.D). Mirrors getSlicerItemBitmap:
 * the caller (the Charts sandbox shim) builds a composite `key` that bakes in the
 * mark id + spec/data signature + plot size, so it self-invalidates. The worker
 * paints the plot area into an OffscreenCanvas from the cloned `item` payload
 * ({ spec, data, layout, theme }) and returns an ImageBitmap. Synchronous:
 * returns the cached bitmap or null (and single-flight requests one on a miss).
 */
export function getChartMarkBitmap(
  instanceId: string,
  key: string,
  item: unknown,
  w: number,
  h: number,
  dpr: number,
): ImageBitmap | null {
  const cached = getBitmap("chartMark", key);
  if (cached) {
    return cached.bitmap;
  }
  const mw = findWorkerForInstance("chartMark", instanceId);
  if (mw) {
    requestDraw(mw, { kind: "chartMark", key, item }, w, h, dpr);
  }
  return null;
}

/** True when a worker-realm script provides a mark renderer for this chart mark. */
export function hasChartMarkBitmapRenderer(instanceId: string): boolean {
  return findWorkerForInstance("chartMark", instanceId) !== null;
}

function findWorkerForInstance(objectType: string, instanceId: string): MountedWorker | null {
  for (const mw of mounted.values()) {
    if (mw.definition.objectType === objectType && mw.definition.instanceId === instanceId) {
      const rendererHook =
        objectType === "shape" ? "canvasRenderer"
          : objectType === "chartMark" ? "markRenderer"
            : "itemRenderer";
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
  // Remember the LOGICAL request size — the worker renders at w*dpr physical px but
  // returns hit geometry in LOGICAL plot coords, so geometry must be clamped to the
  // logical size (NOT msg.bitmap.width/height, which is physical and dpr-inflated).
  mw.pendingRenderDraws.set(reqId, { key: flightKey, timer, w, h });
  post(mw, { t: "renderDraw", reqId, target, w, h, dpr });
}
