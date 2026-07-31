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
  unregisterExposed,
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
import { ALLOWLIST, thinAppEventForScripts } from "./allowlist";
import { MAX_RANGE_CELLS } from "./validators";
import type { ScriptCell } from "../scriptableObjects";
import type { TypedCellData } from "../lib";
import type { CellData, FormattingOptions } from "../types";
import {
  fetchOriginOf,
  grantBackendCapability,
  grantNetOrigin,
  hasFetchOrigin,
  recordCapabilityGrant,
  requestCapabilityGrant,
  resetAllGrants,
  revokeBackendCapabilities,
  RUST_MIRRORED_CAPABILITIES,
  syncBackendGrants,
  syncNetOriginsToBackend,
  wasDeniedThisSession,
} from "./capabilities";
import {
  captureWritebackWrite,
  captureWritebackWrites,
  workbookHasWritebackRegions,
} from "./writebackWriteGuard";
import { requestScriptDialog, resetScriptDialogs, revokeScriptDialogs } from "./scriptDialogs";
import type {
  ScriptDialogFormSpec,
  ScriptDialogPromptOptions,
  ScriptDialogTextOptions,
} from "./scriptDialogSpec";
import { AppEvents, emitAppEvent, onAppEvent } from "../events";
import {
  registerLifecycleGuard,
  type LifecycleAction,
  type LifecycleDetail,
  type LifecycleGuardResult,
} from "../../core/lib/lifecycleGuards";
import {
  rectRowsCols,
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
import { getSlicerStoreService, getTimelineStoreService, getChartStoreService, getPivotStoreService, getPaneControlStoreService, getControlStoreService } from "../componentStoreRegistry";
import type { ChartPlacement } from "../componentStoreRegistry";
import {
  chartToRef,
  namedRangeToRef,
  pivotToRef,
  shapeToRef,
  slicerToRef,
  tableToRef,
  type ScriptObjectKind,
  type ScriptObjectRef,
} from "./objectInventory";
import {
  aggregationToFunction,
  areaToAxis,
  layoutDirectivesToConfig,
  PIVOT_AREAS,
  type PivotArea,
} from "./pivotLayoutVocabulary";
import type { AggregationFunction, PivotApi, PivotAxis } from "../pivotTypes";
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
  /** For distributed scripts: the resolved package version they were pulled
   *  from. Seeds the read-only `context.package` mirror. */
  packageVersion?: string;
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
  void syncBackendGrants(definition.id);

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
    // Provenance mirror (B5): a distributed script can finally ask which package
    // and version it shipped in. Built from the AUTHORITATIVE definition here,
    // never from the worker, and omitted entirely for local scripts.
    packageInfo:
      definition.provenance === "distributed"
        ? {
            name: definition.packageName || "(unknown package)",
            version: definition.packageVersion ?? null,
            provenance: "distributed",
          }
        : undefined,
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
  // Dismiss any modal this script had on screen. The worker is already gone, so
  // nothing is waiting on the answer — but the DIALOG would otherwise stay up,
  // asking on behalf of code that no longer exists.
  revokeScriptDialogs(scriptId);
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
  // ...and every dialog mute / dismissal streak, so the next workbook's scripts
  // are not judged by the previous one's behavior.
  resetScriptDialogs();
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
    // Mirror BI-family grants to the authoritative Rust store (the Rust gates
    // re-check it per call).
    if (RUST_MIRRORED_CAPABILITIES.has(cap)) {
      await grantBackendCapability(handle.scriptId, cap);
    }
  }
}

/**
 * The AUTHORITATIVE owner identity for a scheduled job.
 *
 * Derived from the mount definition alone. A scheduled job outlives the session
 * that created it, so the identity recorded with it is what a later revoke, a
 * later audit entry and the transparency panel's "who scheduled this?" all
 * resolve against — it must never be script-supplied.
 */
function scheduleOwnerOf(definition: HostMountDefinition): {
  scriptId: string;
  surface: string;
  objectType: string;
  instanceId: string | null;
} {
  return {
    scriptId: definition.id,
    surface: definition.provenance === "distributed" ? "extension-worker" : "object-script",
    objectType: definition.objectType,
    instanceId: definition.instanceId,
  };
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
      // The cleanup returned by context.expose() being called while the script
      // is still mounted. Until the integration sweep this method had NO
      // ALLOWLIST row, so the broker rejected it with UnknownMethod before it
      // ever reached here and the host kept relaying to a handler the worker
      // had already dropped. Owner-checked in the broker so it cannot delete a
      // remounted successor's registration.
      const [name] = args as [string];
      unregisterExposed(handle, name);
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
      const sheetIndex = await activeSheetForWriteGuard(lib);
      recordScriptWrite(definition.id, sheetIndex, row, col);
      // A .calp writeback cell is the publisher's input form: capture it as a
      // schema-validated draft first, exactly like a human keystroke, and only
      // then let the grid show the value. A rejection throws and nothing is
      // written. See writebackWriteGuard.ts.
      await captureWritebackWrite(definition.id, { sheetIndex, row, col, value });
      await lib.updateCell(row, col, value);
      return undefined;
    }
    case "api.updateCellsBatch": {
      const [updates] = args as [Array<{ row: number; col: number; value: string }>];
      const lib = await getLib();
      const sheetIndex = await activeSheetForWriteGuard(lib);
      for (const u of updates) {
        recordScriptWrite(definition.id, sheetIndex, u.row, u.col);
      }
      const { plain, drafted } = await captureWritebackWrites(
        definition.id,
        updates.map((u) => ({ sheetIndex, row: u.row, col: u.col, value: u.value })),
      );
      if (plain.length > 0) {
        await lib.updateCellsBatch(plain.map((u) => ({ row: u.row, col: u.col, value: u.value })));
      }
      // update_cells_batch DROPS writeback cells (partial-success semantics in
      // commands/data.rs), so a cell whose draft was just saved has to be
      // written on its own or the grid would show nothing at all.
      for (const u of drafted) {
        await lib.updateCell(u.row, u.col, u.value);
      }
      return undefined;
    }
    case "api.getCellData": {
      // Typed single-cell read (any sheet). Unlike api.getCellValue this keeps
      // the value's type and the cell's formula.
      const [row, col, sheetIndex] = args as [number, number, number?];
      const lib = await getLib();
      return readTypedCell(lib, sheetIndex, row, col);
    }
    case "api.getRangeValues": {
      // ONE round trip for a whole rectangle, on any sheet.
      const [startRow, startCol, endRow, endCol, sheetIndex] = args as
        [number, number, number, number, number?];
      const lib = await getLib();
      return readTypedRange(lib, sheetIndex, startRow, startCol, endRow, endCol);
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

    // ---- unlocked: formatting (B2) ----
    case "api.setRangeFormat": {
      const [startRow, startCol, endRow, endCol, format, sheetIndex] = args as
        [number, number, number, number, FormattingOptions, number?];
      const lib = await getLib();
      await applyRangeFormat(lib, sheetIndex, startRow, startCol, endRow, endCol, format);
      return undefined;
    }
    case "api.clearRangeFormat": {
      const [startRow, startCol, endRow, endCol, sheetIndex] = args as
        [number, number, number, number, number?];
      const lib = await getLib();
      await clearRangeFormat(lib, sheetIndex, startRow, startCol, endRow, endCol);
      return undefined;
    }

    // ---- unlocked: structure (B2) ----
    // Every backend command below acts on the ACTIVE sheet, so an explicit
    // sheetIndex that names another one is REFUSED with an actionable message
    // rather than silently applied to the wrong sheet (assertActiveSheet).
    case "api.insertRows": {
      const [start, count, sheetIndex] = args as [number, number, number?];
      const lib = await getLib();
      await assertActiveSheet(lib, sheetIndex, "insertRows");
      await lib.insertRows(start, count);
      await afterStructuralChange();
      return undefined;
    }
    case "api.deleteRows": {
      const [start, count, sheetIndex] = args as [number, number, number?];
      const lib = await getLib();
      await assertActiveSheet(lib, sheetIndex, "deleteRows");
      await lib.deleteRows(start, count);
      await afterStructuralChange();
      return undefined;
    }
    case "api.insertColumns": {
      const [start, count, sheetIndex] = args as [number, number, number?];
      const lib = await getLib();
      await assertActiveSheet(lib, sheetIndex, "insertColumns");
      await lib.insertColumns(start, count);
      await afterStructuralChange();
      return undefined;
    }
    case "api.deleteColumns": {
      const [start, count, sheetIndex] = args as [number, number, number?];
      const lib = await getLib();
      await assertActiveSheet(lib, sheetIndex, "deleteColumns");
      await lib.deleteColumns(start, count);
      await afterStructuralChange();
      return undefined;
    }
    case "api.mergeCells": {
      const [startRow, startCol, endRow, endCol, sheetIndex] = args as
        [number, number, number, number, number?];
      const lib = await getLib();
      const active = await assertActiveSheet(lib, sheetIndex, "mergeCells");
      const result = await lib.mergeCells(startRow, startCol, endRow, endCol);
      if (!result.success) {
        throw new BrokerError("ValidationError", "mergeCells was refused (the range overlaps an existing merge)");
      }
      for (const cell of result.updatedCells) {
        recordScriptWrite(definition.id, active, cell.row, cell.col);
      }
      await afterCellDataChange(result.updatedCells);
      return undefined;
    }
    case "api.unmergeCells": {
      const [row, col, sheetIndex] = args as [number, number, number?];
      const lib = await getLib();
      await assertActiveSheet(lib, sheetIndex, "unmergeCells");
      const result = await lib.unmergeCells(row, col);
      if (!result.success) {
        throw new BrokerError("ValidationError", `No merged region at row=${row} col=${col}`);
      }
      await afterCellDataChange(result.updatedCells);
      return undefined;
    }
    case "api.setRowHeight": {
      const [row, height, sheetIndex] = args as [number, number, number?];
      const lib = await getLib();
      await assertActiveSheet(lib, sheetIndex, "setRowHeight");
      await lib.setRowHeight(row, height);
      await syncDimensionToGrid("row", row, height);
      return undefined;
    }
    case "api.setColumnWidth": {
      const [col, width, sheetIndex] = args as [number, number, number?];
      const lib = await getLib();
      await assertActiveSheet(lib, sheetIndex, "setColumnWidth");
      await lib.setColumnWidth(col, width);
      await syncDimensionToGrid("column", col, width);
      return undefined;
    }
    case "api.freezePanes": {
      // The @api orchestrator persists AND emits FREEZE_CHANGED, which the
      // Shell bridges into Core's freeze config — same path the View ribbon uses.
      const [freezeRow, freezeCol] = args as [number | null, number | null];
      const grid = await import("../grid");
      await grid.freezePanes(freezeRow ?? null, freezeCol ?? null);
      return undefined;
    }

    // ---- unlocked: sheet CRUD (B2) ----
    case "api.addSheet": {
      const [name] = args as [string?];
      const lib = await getLib();
      if (name !== undefined && name !== null) {
        await assertSheetNameFree(lib, name, null);
      }
      const result = await lib.addSheet(name ?? undefined);
      await announceSheetsChanged(result);
      // add_sheet makes the new sheet active — resolve it by INDEX FIELD, not
      // by array position (the two diverge once a sheet has been deleted).
      const added = result.sheets.find((s) => s.index === result.activeIndex);
      return { index: added?.index ?? result.activeIndex, name: added?.name ?? "" };
    }
    case "api.deleteSheet": {
      const [index] = args as [number];
      const lib = await getLib();
      const before = await lib.getSheets();
      if (!before.sheets.some((s) => s.index === index)) {
        throw new BrokerError("ValidationError", `No sheet with index ${index}`);
      }
      if (before.sheets.length <= 1) {
        throw new BrokerError("ValidationError", "Cannot delete the last remaining sheet");
      }
      const result = await lib.deleteSheet(index);
      await announceSheetsChanged(result);
      return undefined;
    }
    case "api.renameSheet": {
      const [index, newName] = args as [number, string];
      const lib = await getLib();
      await assertSheetNameFree(lib, newName, index);
      const result = await lib.renameSheet(index, newName);
      await announceSheetsChanged(result);
      return undefined;
    }
    case "api.setSheetVisibility": {
      const [index, visibility] = args as [number, "visible" | "hidden" | "veryHidden"];
      const lib = await getLib();
      const before = await lib.getSheets();
      if (!before.sheets.some((s) => s.index === index)) {
        throw new BrokerError("ValidationError", `No sheet with index ${index}`);
      }
      if (visibility !== "visible" && before.sheets.filter((s) => s.visibility === "visible").length <= 1) {
        throw new BrokerError("ValidationError", "Cannot hide the last visible sheet");
      }
      const result =
        visibility === "visible"
          ? await lib.unhideSheet(index)
          : await lib.hideSheet(index, visibility);
      await announceSheetsChanged(result);
      return undefined;
    }

    // ---- unlocked: sort + find/replace (B2) ----
    case "api.sortRange": {
      // vSortRange already enforced the field shape (key/ascending/sortOn/...),
      // so the cast lands on a validated payload.
      const [startRow, startCol, endRow, endCol, fields, options, sheetIndex] = args as [
        number, number, number, number,
        Parameters<Awaited<ReturnType<typeof getLib>>["sortRange"]>[4],
        { matchCase?: boolean; hasHeaders?: boolean; orientation?: "rows" | "columns" } | undefined,
        number?,
      ];
      const lib = await getLib();
      const active = await assertActiveSheet(lib, sheetIndex, "sortRange");
      const result = await lib.sortRange<SortRangeResultLike>(
        startRow, startCol, endRow, endCol,
        fields,
        options ?? undefined,
      );
      if (!result.success) {
        throw new BrokerError("ValidationError", result.error || "sortRange failed");
      }
      for (const cell of result.updatedCells) {
        recordScriptWrite(definition.id, active, cell.row, cell.col);
      }
      await afterCellDataChange(result.updatedCells);
      return result.sortedCount;
    }
    case "api.findAll": {
      const [query, options] = args as [string, Record<string, boolean> | undefined];
      const lib = await getLib();
      const result = await lib.findAll(query, options ?? {});
      // Reshape the backend's [row, col] tuples into named fields — a script
      // reading `m.row` cannot silently swap the two the way `m[0]` can.
      return {
        matches: result.matches.map(([row, col]) => ({ row, col })),
        totalCount: result.totalCount,
      };
    }
    case "api.replaceAll": {
      const [search, replacement, options] = args as
        [string, string, Record<string, boolean> | undefined];
      const lib = await getLib();
      const active = await lib.getActiveSheet();
      const result = await lib.replaceAll(search, replacement, options ?? {});
      for (const cell of result.updatedCells) {
        recordScriptWrite(definition.id, active, cell.row, cell.col);
      }
      await afterCellDataChange(result.updatedCells);
      return {
        replacementCount: result.replacementCount,
        skippedWriteback: result.skippedWriteback ?? 0,
      };
    }

    // ---- unlocked: workbook objects (B3) ----
    case "api.listObjects": {
      const [kind] = args as [ScriptObjectKind];
      return listWorkbookObjects(kind);
    }
    case "api.createChart": {
      const [spec, options] = args as [Record<string, unknown>, ChartCreateOptions?];
      const store = requireChartStore();
      // The extension validates the spec against the ChartSpec schema and
      // throws on a violation -> brokerCall audits ok:false and the script's
      // awaited createChart() rejects with the schema complaint.
      return store.createChart(spec, options);
    }
    case "api.deleteChart": {
      const [chartId] = args as [string];
      const store = requireChartStore();
      if (!store.deleteChart(chartId)) {
        throw new BrokerError("ValidationError", `No chart with id "${chartId}"`);
      }
      return undefined;
    }
    case "api.createTable": {
      const [startRow, startCol, endRow, endCol, options] = args as
        [number, number, number, number, { name?: string; hasHeaders?: boolean }?];
      // create_table resolves the ACTIVE sheet internally (it reads the header
      // text straight off the live grid), so there is no sheetIndex to pass and
      // none to refuse — the rectangle is always on the sheet the user is on.
      // Call api.setActiveSheet(n) first to build a table on another sheet.
      const backend = await import("../backend");
      const result = await backend.createTable({
        name: options?.name ?? "", // "" => the backend auto-names ("Table1", ...)
        startRow,
        startCol,
        endRow,
        endCol,
        hasHeaders: options?.hasHeaders ?? true,
      });
      if (!result.success || !result.table) {
        throw new BrokerError("ValidationError", result.error || "createTable failed");
      }
      await announceObjectsChanged();
      emitAppEvent(AppEvents.TABLE_CREATED, { tableId: result.table.id });
      return tableToRef(result.table);
    }
    case "api.deleteTable": {
      const [tableId] = args as [string];
      const lib = await getLib();
      const table = (await lib.getTableById(tableId)) as TableLike | null;
      if (!table) throw new BrokerError("ValidationError", `No table with id "${tableId}"`);
      await assertActiveSheet(lib, table.sheetIndex, "deleteTable");
      const backend = await import("../backend");
      const result = await backend.deleteTable(tableId);
      if (!result.success) {
        throw new BrokerError("ValidationError", result.error || "deleteTable failed");
      }
      await announceObjectsChanged();
      return undefined;
    }
    case "api.createNamedRange": {
      const [name, refersTo, options] = args as
        [string, string, { sheetIndex?: number | null; comment?: string }?];
      const lib = await getLib();
      const result = await lib.createNamedRange(
        name,
        options?.sheetIndex ?? null, // null = workbook scope (the common case)
        refersTo,
        options?.comment,
      );
      if (!result.success) {
        throw new BrokerError("ValidationError", result.error || "createNamedRange failed");
      }
      emitAppEvent(AppEvents.NAMED_RANGES_CHANGED, {});
      return undefined;
    }
    case "api.deleteNamedRange": {
      const [name] = args as [string];
      const lib = await getLib();
      const result = await lib.deleteNamedRange(name);
      if (!result.success) {
        throw new BrokerError("ValidationError", result.error || `No named range "${name}"`);
      }
      emitAppEvent(AppEvents.NAMED_RANGES_CHANGED, {});
      return undefined;
    }
    case "api.createPivot": {
      const [sourceRange, destinationCell, fields, options] = args as [
        string,
        string,
        ScriptPivotFields,
        { name?: string; sourceSheet?: number; destinationSheet?: number; hasHeaders?: boolean } | undefined,
      ];
      return createPivotFromScript(sourceRange, destinationCell, fields, options);
    }
    case "api.deletePivot": {
      const [pivotId] = args as [string];
      const api = await requirePivotApi();
      await api.delete(pivotId);
      announcePivotChanged();
      return undefined;
    }
    case "api.objectGetState": {
      // Cross-instance READ. The aspect executors are the SAME ones the
      // own-object door uses — only the instance id differs, and only the
      // unlocked tier can supply it (the allowlist row enforces that).
      const [, targetId, aspect, aspectArgs] = args as [string, string, string, unknown[]];
      return executeGetState(targetId, aspect, aspectArgs ?? []);
    }
    case "api.objectSetState": {
      const [, targetId, aspect, aspectArgs] = args as [string, string, string, unknown[]];
      return executeSetState(mw, targetId, aspect, aspectArgs ?? []);
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
    case "sheet.getCellData": {
      // Typed single-cell read, clamped to the script's own sheet (an explicit
      // OTHER sheetIndex is unlocked-tier reach — same rule as getCellValue).
      const [row, col, sheetIndex] = args as [number, number, number?];
      const lib = await getLib();
      const target = await clampSheetIndex(lib, handle, sheetIndex);
      return readTypedCell(lib, target, row, col);
    }
    case "sheet.getRangeValues": {
      const [startRow, startCol, endRow, endCol, sheetIndex] = args as
        [number, number, number, number, number?];
      const lib = await getLib();
      const target = await clampSheetIndex(lib, handle, sheetIndex);
      return readTypedRange(lib, target, startRow, startCol, endRow, endCol);
    }
    case "sheet.setRangeValues": {
      // Bulk own-sheet write: same reach as N sheet.setCellValue calls, one RPC,
      // and ONE undo step. `values` is anchored at (startRow, startCol); an
      // undefined/null entry leaves that cell untouched.
      const [startRow, startCol, values, sheetIndex] = args as
        [number, number, Array<Array<string | null | undefined>>, number?];
      const lib = await getLib();
      const target = await clampSheetIndex(lib, handle, sheetIndex);
      const active = await lib.getActiveSheet();
      const targetSheet = target ?? active;
      const updates: Array<{ row: number; col: number; value: string }> = [];
      for (let r = 0; r < values.length; r++) {
        const row = values[r];
        for (let c = 0; c < row.length; c++) {
          const v = row[c];
          if (v === undefined || v === null) continue;
          const gridRow = startRow + r;
          const gridCol = startCol + c;
          recordScriptWrite(definition.id, targetSheet, gridRow, gridCol);
          updates.push({ row: gridRow, col: gridCol, value: String(v) });
        }
      }
      if (updates.length > MAX_RANGE_CELLS) {
        throw new BrokerError(
          "ValidationError",
          `range too large: ${updates.length} cells (max ${MAX_RANGE_CELLS})`,
        );
      }
      await writeCellsOnSheet(lib, definition.id, targetSheet, active, updates);
      return undefined;
    }
    case "sheet.setRangeFormat": {
      // Own-sheet formatting: identical reach to sheet.setRangeValues (clamped
      // to the script's sheet), appearance instead of content.
      const [startRow, startCol, endRow, endCol, format, sheetIndex] = args as
        [number, number, number, number, FormattingOptions, number?];
      const lib = await getLib();
      const target = await clampSheetIndex(lib, handle, sheetIndex);
      await applyRangeFormat(lib, target, startRow, startCol, endRow, endCol, format);
      return undefined;
    }
    case "sheet.clearRangeFormat": {
      const [startRow, startCol, endRow, endCol, sheetIndex] = args as
        [number, number, number, number, number?];
      const lib = await getLib();
      const target = await clampSheetIndex(lib, handle, sheetIndex);
      await clearRangeFormat(lib, target, startRow, startCol, endRow, endCol);
      return undefined;
    }
    case "sheet.setCellValue": {
      const [row, col, value, sheetIndex] = args as [number, number, string, number?];
      const lib = await getLib();
      // The TIER check runs first: a restricted script must be refused for
      // naming another sheet BEFORE anything of its value is drafted there.
      let offSheet = false;
      let target: number;
      if (sheetIndex !== undefined) {
        target = sheetIndex;
        const active = await lib.getActiveSheet();
        if (sheetIndex !== active) {
          if (handle.tier !== "unlocked") {
            throw new BrokerError("PermissionDenied", "Restricted sheet scripts can only access their own sheet");
          }
          offSheet = true;
        }
      } else {
        target = await activeSheetForWriteGuard(lib);
      }
      recordScriptWrite(definition.id, target, row, col);
      await captureWritebackWrite(definition.id, { sheetIndex: target, row, col, value });
      if (offSheet) {
        await lib.updateCellOnSheets([sheetIndex as number], row, col, value);
        return undefined;
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
        {
          method?: string;
          headers?: Record<string, string>;
          body?: string;
          /** Connector-secret injection (bi.connector): a SLOT name; the Rust
           *  gate resolves + attaches the value server-side (never in JS). */
          secretHeader?: { sourceId: string; slot: string; header: string; format?: string };
        } | undefined,
      ];
      const { invokeBackend } = await import("../backend");
      return invokeBackend("script_http_fetch", {
        request: {
          scriptId: definition.id,
          url,
          method: init?.method,
          headers: init?.headers,
          body: init?.body,
          secretHeader: init?.secretHeader ?? null,
        },
      });
    }
    // ---- ui.dialog: ask the user, await the answer ----
    // Identity is HOST-supplied on every one of these: scriptName and origin
    // come from the mount handle, never from args, so a script cannot present
    // its dialog as somebody else's (or as the app's). The guards — one dialog
    // per script, one app-wide, and a dismissal-streak mute — live in
    // scriptDialogs.ts, and every "no answer" path (Cancel, Escape, overlay,
    // close, deadline, unmount) lands on `dismissed`, so these never hang.
    case "cap.dialogAlert": {
      const [message, options] = args as [string, ScriptDialogTextOptions | undefined];
      await requestScriptDialog({
        scriptId: definition.id,
        scriptName: definition.name,
        scriptOrigin: handle.origin,
        kind: "alert",
        message,
        textOptions: options,
      });
      return undefined;
    }
    case "cap.dialogConfirm": {
      const [message, options] = args as [string, ScriptDialogTextOptions | undefined];
      const answer = await requestScriptDialog({
        scriptId: definition.id,
        scriptName: definition.name,
        scriptOrigin: handle.origin,
        kind: "confirm",
        message,
        textOptions: options,
      });
      // Dismissal is a NO. Anything else than an explicit confirm must not read
      // as consent — that is the whole point of asking.
      return answer.dismissed === false;
    }
    case "cap.dialogPrompt": {
      const [message, options] = args as [string, ScriptDialogPromptOptions | undefined];
      const answer = await requestScriptDialog({
        scriptId: definition.id,
        scriptName: definition.name,
        scriptOrigin: handle.origin,
        kind: "prompt",
        message,
        promptOptions: options,
      });
      if (answer.dismissed) return null;
      return typeof answer.value === "string" ? answer.value : null;
    }
    case "cap.dialogForm": {
      const [spec] = args as [ScriptDialogFormSpec];
      const answer = await requestScriptDialog({
        scriptId: definition.id,
        scriptName: definition.name,
        scriptOrigin: handle.origin,
        kind: "form",
        form: spec,
      });
      if (answer.dismissed) return null;
      return answer.value !== null && typeof answer.value === "object" ? answer.value : null;
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
    case "cap.biModelInfo": {
      // Sanitized model read: the Rust gateway projects a WHITELIST of the
      // overview (never security roles or connection targets).
      const [connectionId] = args as [string];
      const { invokeBackend } = await import("../backend");
      return invokeBackend("script_bi_model", {
        connectionId,
        scriptId: definition.id,
        action: "info",
        kind: null,
        payload: null,
      });
    }
    case "cap.biModelUpsert":
    case "cap.biModelDelete": {
      // Governed model mutation: the Rust gateway re-checks the bi.model
      // grant, enforces the allowed-kind set + rate limit authoritatively,
      // rejects package-subscribed models, and routes through the same
      // undoable funnel the Model Editor uses.
      const [connectionId, kind, payload] = args as [string, string, unknown];
      const { invokeBackend } = await import("../backend");
      return invokeBackend("script_bi_model", {
        connectionId,
        scriptId: definition.id,
        action: method === "cap.biModelUpsert" ? "upsert" : "delete",
        kind,
        payload: payload ?? null,
      });
    }
    case "cap.biModelValidate":
    case "cap.biModelLineage": {
      // Read-only diagnostics on the SAME gateway (its own 120/min Rust rate
      // bucket, so a spent mutation budget can never block the call that
      // explains why an edit failed). Every answer is rebuilt field-by-field
      // Rust-side and its error text scrubbed, so a validation message can
      // never leak a security role, source id, host or database name.
      const [connectionId, action, payload] = args as [string, string, unknown];
      const { invokeBackend } = await import("../backend");
      return invokeBackend("script_bi_model", {
        connectionId,
        scriptId: definition.id,
        action,
        kind: null,
        payload: payload ?? null,
      });
    }
    case "cap.biModelBatch": {
      // Atomic multi-edit: many model changes, ONE undo entry. Ownership is
      // enforced Rust-side (only the opening script may end/cancel) and an
      // abandoned batch is reclaimed by a wall-clock deadline and ROLLED BACK,
      // so a crashed script cannot wedge the model half-edited.
      const [connectionId, action] = args as [string, string];
      const { invokeBackend } = await import("../backend");
      return invokeBackend("script_bi_model", {
        connectionId,
        scriptId: definition.id,
        action,
        kind: null,
        payload: null,
      });
    }
    // ---- distribution.writeback: the .calp collection loop, automated ----
    // Everything routes through ONE Rust gateway (script_writeback) which
    // re-checks the grant, gates the two publisher actions on Ed25519 key
    // possession, rate-limits per bucket, and dispatches into the very same
    // calp_* commands the interactive UI calls.
    case "cap.writebackListRegions":
    case "cap.writebackGetLayer": {
      const { invokeBackend } = await import("../backend");
      return invokeBackend("script_writeback", {
        scriptId: definition.id,
        action: method === "cap.writebackListRegions" ? "listRegions" : "getLayer",
        payload: {},
      });
    }
    case "cap.writebackSaveDraft": {
      const [regionId, sheetId, row, col, value] = args as
        [string, string, number, number, unknown];
      const { invokeBackend } = await import("../backend");
      return invokeBackend("script_writeback", {
        scriptId: definition.id,
        action: "saveDraft",
        payload: { regionId, sheetId, row, col, value },
      });
    }
    case "cap.writebackSubmit": {
      const [regionId] = args as [string];
      const { invokeBackend } = await import("../backend");
      const result = await invokeBackend<{ submitted: number }>("script_writeback", {
        scriptId: definition.id,
        action: "submitRegion",
        payload: { regionId },
      });
      return result?.submitted ?? 0;
    }
    case "cap.writebackPreview": {
      const [regionId] = args as [string];
      const { invokeBackend } = await import("../backend");
      return invokeBackend("script_writeback", {
        scriptId: definition.id,
        action: "previewSubmission",
        payload: { regionId },
      });
    }
    case "cap.writebackListSubmissions": {
      // PUBLISHER ONLY (Rust require_publisher). The payload is forwarded
      // whole: its regionId/writebackId key is what selects the grid-region or
      // model-column surface, and the validator already proved exactly one.
      const [target] = args as [Record<string, unknown>];
      const { invokeBackend } = await import("../backend");
      return invokeBackend("script_writeback", {
        scriptId: definition.id,
        action: "listSubmissions",
        payload: target,
      });
    }
    case "cap.writebackReview": {
      // PUBLISHER ONLY (Rust require_publisher).
      const [decision] = args as [Record<string, unknown>];
      const { invokeBackend } = await import("../backend");
      await invokeBackend("script_writeback", {
        scriptId: definition.id,
        action: "setSubmissionState",
        payload: decision,
      });
      return undefined;
    }
    case "cap.connectorRegister": {
      // The connector host records the AUTHORITATIVE script identity (from the
      // definition, never from args), installs via the Rust gate, runs the
      // initial feed, and arms the refresh schedule.
      const [connectionId, def] = args as [string, unknown];
      const { registerScriptConnectorForScript } = await import("../scriptConnectors");
      return registerScriptConnectorForScript(
        definition.id,
        definition.objectType,
        definition.instanceId,
        connectionId,
        def as never,
      );
    }
    case "cap.connectorRemove": {
      const [connectionId, sourceId] = args as [string, string];
      const { removeScriptConnectorForScript } = await import("../scriptConnectors");
      await removeScriptConnectorForScript(definition.id, connectionId, sourceId);
      return undefined;
    }
    // ---- schedule: persistent recurring jobs. The OWNER identity below comes
    // from the authoritative definition, never from args — a script cannot
    // schedule work on another script's behalf or under another script's name,
    // which is what keeps the audit trail and the revoke check meaningful.
    case "cap.scheduleEvery": {
      const [intervalSecs, handler, options] = args as [
        number,
        string,
        { label?: string } | undefined,
      ];
      const { scheduleEvery } = await import("./scheduler");
      return scheduleEvery(
        scheduleOwnerOf(definition),
        intervalSecs,
        handler,
        options?.label,
      );
    }
    case "cap.scheduleAt": {
      const [timeOfDay, handler, options] = args as [
        string,
        string,
        { label?: string } | undefined,
      ];
      const { scheduleAt } = await import("./scheduler");
      return scheduleAt(scheduleOwnerOf(definition), timeOfDay, handler, options?.label);
    }
    case "cap.scheduleList": {
      const { listScheduledJobsForScript } = await import("./scheduler");
      return listScheduledJobsForScript(definition.id);
    }
    case "cap.scheduleCancel": {
      const [jobId] = args as [string];
      const { cancelScheduledJobForScript } = await import("./scheduler");
      return cancelScheduledJobForScript(definition.id, jobId);
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

/**
 * Dispatch ONE state-changing aspect at `instanceId`.
 *
 * Two doors reach this: `object.setState` (restricted, instance PINNED to the
 * mount handle) and `api.objectSetState` (unlocked, an explicit target id). The
 * executors are deliberately shared — an aspect must behave identically however
 * it was addressed — but the HOST-SIDE MIRRORS must not be: a mirror is this
 * script's view of ITS OWN object, so pushing another instance's state into it
 * would make `chart.getSpec()` start returning a stranger's spec. Hence
 * `isOwnInstance` gates every mirror push and the shapeProps cache below.
 */
async function executeSetState(mw: MountedWorker, instanceId: string, aspect: string, args: unknown[]): Promise<unknown> {
  const isOwnInstance = instanceId === (mw.definition.instanceId || "");
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
        if (isOwnInstance) pushChartSpecMirror(mw, instanceId);
      }
      return undefined;
    }
    case "chart.replaceSpec": {
      const [fullSpec] = args as [Record<string, unknown>];
      const store = getChartStoreService();
      if (store) {
        store.replaceChartSpec(instanceId, fullSpec);
        if (isOwnInstance) pushChartSpecMirror(mw, instanceId);
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
        if (isOwnInstance) pushPivotFieldsMirror(mw, instanceId);
      }
      return undefined;
    }
    // ---- pivot LAYOUT mutation (B3 §4) ----
    // The vocabulary is the Pivot Layout DSL's (rows/columns/values/filters,
    // sum/count/average/..., compact/tabular/values-on-rows/...), so a script
    // and the DSL editor describe the same pivot with the same words. Each of
    // these is ONE backend command that recalculates the pivot and rewrites its
    // destination cells; the refresh announcement is the feature-neutral
    // MUTATION_REFRESH the Pivot extension already listens to.
    case "pivot.addField":
    case "pivot.moveField":
    case "pivot.removeField":
    case "pivot.setAggregation":
    case "pivot.setLayout": {
      await executePivotLayoutAspect(instanceId, aspect, args);
      if (isOwnInstance) pushPivotFieldsMirror(mw, instanceId);
      announcePivotChanged();
      return undefined;
    }
    case "shape.setProperty": {
      const [key, value] = args as [string, string];
      // The shapeProps cache is this script's OWN mirror; a cross-instance write
      // must not poison it (and cannot read a meaningful oldValue from it).
      const oldValue = isOwnInstance ? mw.shapeProps.get(key) || "" : "";
      if (isOwnInstance) mw.shapeProps.set(key, value);
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
      await writeCellOnSheet(lib, mw.definition.id, coord.sheetIndex, coord.row, coord.col, String(value));
      emitAppEvent("table:dataChanged", { tableId: instanceId });
      return undefined;
    }
    case "table.setRangeValues": {
      // Bulk own-object table write in TABLE-RELATIVE coordinates. Every target
      // is resolved through tableCellCoord, so the write stays inside the
      // table's body exactly like table.setCellValue — one RPC, one undo step.
      const [startRow, startCol, values] = args as
        [number, number, Array<Array<string | null | undefined>>];
      const lib = await getLib();
      const table = (await lib.getTableById(instanceId)) as TableLike | null;
      if (!table) throw new BrokerError("ValidationError", `Table not found: ${instanceId}`);
      const updates: Array<{ row: number; col: number; value: string }> = [];
      let sheetIndex = -1;
      for (let r = 0; r < values.length; r++) {
        const row = values[r];
        for (let c = 0; c < row.length; c++) {
          const v = row[c];
          if (v === undefined || v === null) continue;
          const coord = tableCellCoord(table, startRow + r, startCol + c);
          if (!coord) {
            throw new BrokerError(
              "ValidationError",
              `Table cell out of range: row=${startRow + r} col=${startCol + c}`,
            );
          }
          sheetIndex = coord.sheetIndex;
          recordScriptWrite(mw.definition.id, coord.sheetIndex, coord.row, coord.col);
          updates.push({ row: coord.row, col: coord.col, value: String(v) });
        }
      }
      if (updates.length === 0) return undefined;
      if (updates.length > MAX_RANGE_CELLS) {
        throw new BrokerError(
          "ValidationError",
          `range too large: ${updates.length} cells (max ${MAX_RANGE_CELLS})`,
        );
      }
      const active = await lib.getActiveSheet();
      await writeCellsOnSheet(lib, mw.definition.id, sheetIndex, active, updates);
      emitAppEvent("table:dataChanged", { tableId: instanceId });
      return undefined;
    }
    case "table.setRangeFormat":
    case "table.clearRangeFormat": {
      // Own-object formatting in TABLE-RELATIVE coordinates. Both corners are
      // resolved through tableCellCoord, so the change cannot escape the
      // table's body — exactly like table.setRangeValues.
      const [startRow, startCol, endRow, endCol, format] = args as
        [number, number, number, number, FormattingOptions?];
      assertRangeSize(startRow, startCol, endRow, endCol);
      const lib = await getLib();
      const table = (await lib.getTableById(instanceId)) as TableLike | null;
      if (!table) throw new BrokerError("ValidationError", `Table not found: ${instanceId}`);
      const first = tableCellCoord(table, startRow, startCol);
      const last = tableCellCoord(table, endRow, endCol);
      if (!first || !last) {
        throw new BrokerError(
          "ValidationError",
          `Table range out of bounds: (${startRow},${startCol})-(${endRow},${endCol})`,
        );
      }
      if (aspect === "table.setRangeFormat") {
        await applyRangeFormat(lib, first.sheetIndex, first.row, first.col, last.row, last.col, format ?? {});
      } else {
        await clearRangeFormat(lib, first.sheetIndex, first.row, first.col, last.row, last.col);
      }
      return undefined;
    }
    case "table.addRow": {
      const lib = await getLib();
      await lib.addTableRow(instanceId);
      emitAppEvent("table:dataChanged", { tableId: instanceId });
      if (isOwnInstance) pushTableMirror(mw, instanceId);
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
          updates.push({
            row: coords.startRow + r,
            col: coords.startCol + c,
            value: String(v),
          });
        }
      }
      // One undo step whether the name resolves to the active sheet or not
      // (the off-sheet path has no batch command, so it batches host-side).
      await writeCellsOnSheet(lib, mw.definition.id, coords.sheetIndex, active, updates);
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
          updates.push({ row: gridRow, col: gridCol, value: String(v) });
        }
      }
      // One undo step, on or off the active sheet.
      await writeCellsOnSheet(lib, mw.definition.id, b.sheetIndex, active, updates);
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
    // ---- cross-instance READS (B3) ----
    // A script's OWN object is read from a worker-local mirror (sync getters);
    // another object has no mirror, so these aspects are the async read path
    // behind api.chart(id).getSpec(), api.slicer(id).getSelectedItems(), etc.
    // They are pure reads of state the same script could already mutate.
    case "chart.getSpec": {
      const chart = getChartStoreService()?.getChartById(instanceId);
      if (!chart) throw new BrokerError("ValidationError", `No chart with id "${instanceId}"`);
      try {
        return JSON.parse(chart.specJson);
      } catch {
        throw new BrokerError("HostError", `Chart "${instanceId}" has an unreadable spec`);
      }
    }
    case "slicer.getSelectedItems": {
      const store = getSlicerStoreService();
      if (!store) throw new BrokerError("HostError", "The Slicer extension is not loaded");
      if (!store.getSlicerById(instanceId)) {
        throw new BrokerError("ValidationError", `No slicer with id "${instanceId}"`);
      }
      return store.getSelectedItems(instanceId);
    }
    case "pivot.getFields": {
      const store = getPivotStoreService();
      if (!store) throw new BrokerError("HostError", "The Pivot extension is not loaded");
      return store.getPivotFields(instanceId);
    }
    case "namedRange.getValues": {
      const lib = await getLib();
      const coords = (await lib.resolveNamedRangeCoords(instanceId)) as NamedRangeCoordsLike;
      return readRangeValues(lib, coords);
    }
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
    case "table.getRangeData": {
      // Bulk TYPED read of the table's own body, in table-relative coordinates.
      // The body is contiguous on one sheet, so the two corners resolved through
      // tableCellCoord define the grid rectangle — own-object reach, one RPC.
      const [startRow, startCol, endRow, endCol] = args as [number, number, number, number];
      assertRangeSize(startRow, startCol, endRow, endCol);
      const lib = await getLib();
      const table = (await lib.getTableById(instanceId)) as TableLike | null;
      if (!table) throw new BrokerError("ValidationError", `Table not found: ${instanceId}`);
      const first = tableCellCoord(table, startRow, startCol);
      const last = tableCellCoord(table, endRow, endCol);
      if (!first || !last) {
        throw new BrokerError(
          "ValidationError",
          `Table range out of bounds: (${startRow},${startCol})-(${endRow},${endCol})`,
        );
      }
      return readTypedRange(lib, first.sheetIndex, first.row, first.col, last.row, last.col);
    }
    default:
      throw new BrokerError("ValidationError", `Unknown getState aspect: ${aspect}`);
  }
}

// ============================================================================
// Typed + bulk range I/O (B1)
// ============================================================================
// The display-string reads above answer "what does this cell LOOK like". They
// cannot answer "is this a number, a formula, an error" — so a script that read
// a block and wrote it back replaced every formula with its rendered text. The
// helpers below back the typed/bulk broker methods: ONE round trip per
// rectangle, values with their engine type, and each cell's formula.

/** A never-shared empty cell (callers may mutate the grid they get back). */
function emptyScriptCell(): ScriptCell {
  return { value: null, display: "", type: "empty" };
}

function typedToScriptCell(c: TypedCellData): ScriptCell {
  const cell: ScriptCell = { value: c.value, display: c.display, type: c.type };
  // `formula` is absent (not null) when the cell has none — so
  // `if (cell.formula)` reads naturally in script code.
  if (c.formula) cell.formula = c.formula;
  return cell;
}

/** Host-side re-check of the bulk ceiling. The validator already rejected an
 *  oversized rectangle; this is the belt-and-braces check for any host caller
 *  that reaches an executor without passing through it. */
function assertRangeSize(startRow: number, startCol: number, endRow: number, endCol: number): void {
  if (endRow < startRow || endCol < startCol) {
    throw new BrokerError("ValidationError", "invalid range: end before start");
  }
  const cells = (endRow - startRow + 1) * (endCol - startCol + 1);
  if (cells > MAX_RANGE_CELLS) {
    throw new BrokerError("ValidationError", `range too large: ${cells} cells (max ${MAX_RANGE_CELLS})`);
  }
}

/**
 * Read a rectangle as a DENSE rows x cols grid of typed cells in ONE backend
 * call. The backend answers sparsely (only cells that exist); the rectangle is
 * filled here so scripts can index it positionally.
 */
async function readTypedRange(
  lib: Awaited<ReturnType<typeof getLib>>,
  sheetIndex: number | undefined,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): Promise<ScriptCell[][]> {
  assertRangeSize(startRow, startCol, endRow, endCol);
  const sparse = await lib.getRangeCellsTyped(startRow, startCol, endRow, endCol, sheetIndex);
  const rows = endRow - startRow + 1;
  const cols = endCol - startCol + 1;
  const grid: ScriptCell[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: ScriptCell[] = [];
    for (let c = 0; c < cols; c++) row.push(emptyScriptCell());
    grid.push(row);
  }
  for (const c of sparse) {
    const r = c.row - startRow;
    const k = c.col - startCol;
    if (r >= 0 && r < rows && k >= 0 && k < cols) {
      grid[r][k] = typedToScriptCell(c);
    }
  }
  return grid;
}

/** Read ONE cell as a typed cell (same source as readTypedRange). */
async function readTypedCell(
  lib: Awaited<ReturnType<typeof getLib>>,
  sheetIndex: number | undefined,
  row: number,
  col: number,
): Promise<ScriptCell> {
  const grid = await readTypedRange(lib, sheetIndex, row, col, row, col);
  return grid[0][0];
}

/**
 * Resolve the sheet a sheet-scoped call may touch. `undefined` means "the
 * active sheet". Naming another sheet is unlocked-tier reach — the same clamp
 * sheet.getCellValue / sheet.setCellValue apply.
 */
async function clampSheetIndex(
  lib: Awaited<ReturnType<typeof getLib>>,
  handle: ScriptHandle,
  sheetIndex: number | undefined,
): Promise<number | undefined> {
  if (sheetIndex === undefined || sheetIndex === null) return undefined;
  const active = await lib.getActiveSheet();
  if (sheetIndex !== active && handle.tier !== "unlocked") {
    throw new BrokerError("PermissionDenied", "Restricted sheet scripts can only access their own sheet");
  }
  return sheetIndex;
}

/**
 * Run `fn`'s writes inside ONE undo transaction — but only if nobody else's
 * transaction is already open. `begin_transaction` is a no-op while one is
 * open, so an unconditional commit here would close the app's group early
 * (e.g. a cut+paste that spans several backend calls).
 *
 * WHY THIS EXISTS (B1 §5): api.beginBatch/commitBatch/cancelBatch stay
 * UNLOCKED-tier. Handing a restricted script an OPEN-ENDED transaction is not
 * the same reach as letting it write its own cells: an unbalanced begin (or a
 * script that faults between begin and commit) leaves a workbook-wide
 * transaction open, and every later UI edit is swallowed into the script's
 * group — an ambient effect on the user's undo stack, well outside the
 * script's own object. Instead every multi-cell path batches INTERNALLY, so a
 * restricted script's block write is already one Ctrl+Z with no way to leak an
 * open transaction.
 */
async function withScriptUndoBatch(
  lib: Awaited<ReturnType<typeof getLib>>,
  description: string,
  fn: () => Promise<void>,
): Promise<void> {
  const alreadyOpen = (await lib.getUndoState()).transactionOpen;
  if (alreadyOpen) {
    await fn();
    return;
  }
  await lib.beginUndoTransaction(description);
  try {
    await fn();
  } catch (err) {
    await lib.cancelUndoTransaction();
    throw err;
  }
  await lib.commitUndoTransaction();
}

/**
 * The sheet index a sheet-less script write lands on, for the writeback guard.
 * Only pays for the `getActiveSheet` round trip when the workbook ACTUALLY has
 * .calp writeback regions to check against; otherwise it reuses the cached
 * index the event forwarders already track.
 */
async function activeSheetForWriteGuard(
  lib: Awaited<ReturnType<typeof getLib>>,
): Promise<number> {
  if (!(await workbookHasWritebackRegions())) return activeSheetIndexForEvents;
  return lib.getActiveSheet();
}

/**
 * Write many cells on ONE sheet as a single undo step. The active sheet takes
 * the batch command (which opens its own transaction); another sheet has no
 * batch command, so the per-cell writes are wrapped in one transaction here.
 *
 * Every target passes the .calp writeback draft gate first (writebackWriteGuard
 * .ts): a cell claimed by a writeback region is drafted through the same
 * authoritative path a human keystroke takes, or the whole call throws.
 */
async function writeCellsOnSheet(
  lib: Awaited<ReturnType<typeof getLib>>,
  scriptId: string,
  sheetIndex: number,
  activeSheet: number,
  updates: Array<{ row: number; col: number; value: string }>,
): Promise<void> {
  if (updates.length === 0) return;
  const { plain, drafted } = await captureWritebackWrites(
    scriptId,
    updates.map((u) => ({ sheetIndex, row: u.row, col: u.col, value: u.value })),
  );
  if (sheetIndex === activeSheet) {
    if (plain.length > 0) {
      await lib.updateCellsBatch(plain.map((u) => ({ row: u.row, col: u.col, value: u.value })));
    }
    // updateCellsBatch drops writeback cells, so drafted ones go singly.
    for (const u of drafted) {
      await lib.updateCell(u.row, u.col, u.value);
    }
    return;
  }
  await withScriptUndoBatch(lib, `Script write (${updates.length} cells)`, async () => {
    for (const u of updates) {
      await lib.updateCellOnSheets([sheetIndex], u.row, u.col, u.value);
    }
  });
}

// ============================================================================
// Formatting + structural operations (B2)
// ============================================================================
// Everything below is WIRING over the trusted @api facade — the same functions
// the Home tab, the Format Cells dialog and the sheet-tab bar call. No new
// backend command, no new capability: whole-workbook reach is what the UNLOCKED
// tier already means (api.setCellValue sets that bar), and the own-sheet
// formatting rows are clamped exactly like sheet.setCellValue.
//
// THE ACTIVE-SHEET CONSTRAINT (why the structural methods take a sheetIndex
// they then insist on): every structural / dimension / merge / sort /
// find-replace Tauri command resolves `state.active_sheet` internally and has
// no sheet parameter. Silently applying an off-sheet request to the ACTIVE
// sheet would corrupt the wrong data, and switching the active sheet under the
// user is a visible side effect (and would still not be atomic). So the host
// refuses with a message that names the fix. Formatting has no such limit —
// apply_formatting_to_sheets is genuinely sheet-scoped.
//
// UNDO GRANULARITY: one broker call is already ONE undo entry — every backend
// command here opens and commits its own transaction (apply_formatting groups
// "Format N cells", the structural ones snapshot the grid, sort/replaceAll are
// atomic). They must therefore NOT be wrapped in withScriptUndoBatch: the Rust
// undo stack does not nest (begin_transaction is a no-op while one is open, and
// the command's own commit would close the outer group early), so wrapping
// would SPLIT the entry instead of merging it.

/** The subset of sort_range's result the executor needs (mirrors SortRangeResult). */
interface SortRangeResultLike {
  success: boolean;
  sortedCount: number;
  updatedCells: CellData[];
  error: string | null;
}

/**
 * Resolve the sheet an ACTIVE-SHEET-ONLY backend command may touch. `undefined`
 * means "the active sheet"; naming another one is refused with the fix spelled
 * out. Returns the active sheet index (for write attribution).
 */
async function assertActiveSheet(
  lib: Awaited<ReturnType<typeof getLib>>,
  sheetIndex: number | undefined,
  method: string,
): Promise<number> {
  const active = await lib.getActiveSheet();
  if (sheetIndex === undefined || sheetIndex === null || sheetIndex === active) return active;
  throw new BrokerError(
    "ValidationError",
    `${method} can only target the active sheet (currently ${active}); ` +
      `call api.setActiveSheet(${sheetIndex}) first`,
  );
}

/** Push a batch of changed cells to the grid + style caches (the same refresh
 *  choreography the Home tab performs after applyFormatting). */
async function afterCellDataChange(cells: CellData[]): Promise<void> {
  if (cells.length > 0) {
    const { cellEvents, cellToChange } = await import("../../core/lib/cellEvents");
    cellEvents.emitBatch(cells.map(cellToChange), "script");
  }
  emitAppEvent(AppEvents.MUTATION_REFRESH, { domains: ["styles"] });
  (await import("../grid")).refreshGridData();
}

/** Rows/columns moved: the canvas must re-fetch cells AND re-read dimensions
 *  (every height/width override past the change shifted with it). */
async function afterStructuralChange(): Promise<void> {
  const grid = await import("../grid");
  grid.refreshGridDimensions();
  grid.refreshGridData();
}

/** Mirror a persisted row height / column width into Core's grid state and
 *  announce it, so the canvas resizes without waiting for a reload. */
async function syncDimensionToGrid(
  kind: "row" | "column",
  index: number,
  size: number,
): Promise<void> {
  const [gridApi, dispatchMod] = await Promise.all([import("../grid"), import("../gridDispatch")]);
  dispatchMod.dispatchGridAction(
    kind === "row" ? gridApi.setRowHeight(index, size) : gridApi.setColumnWidth(index, size),
  );
  const sheetIndex = await (await getLib()).getActiveSheet();
  emitAppEvent(
    kind === "row" ? AppEvents.ROW_RESIZED : AppEvents.COLUMN_RESIZED,
    kind === "row" ? { sheetIndex, row: index, height: size } : { sheetIndex, col: index, width: size },
  );
  // A size of 0 removed the override — re-read the authoritative map rather
  // than leaving the optimistic 0 in Core's state.
  if (size <= 0) gridApi.refreshGridDimensions();
  gridApi.refreshGridData();
}

/** Sheet list changed (add / delete / rename / visibility): sync Core's sheet
 *  context and fire the one event the tab bar + extensions already listen to
 *  (SheetTabs reloads its list from SHEET_CHANGED). */
async function announceSheetsChanged(
  result: { sheets: Array<{ index: number; name: string }>; activeIndex: number },
): Promise<void> {
  const active = result.sheets.find((s) => s.index === result.activeIndex) ?? result.sheets[0];
  const [gridApi, dispatchMod] = await Promise.all([import("../grid"), import("../gridDispatch")]);
  if (active) {
    dispatchMod.dispatchGridAction(gridApi.setActiveSheet(active.index, active.name));
  }
  emitAppEvent(AppEvents.SHEET_CHANGED, {
    sheetIndex: active?.index ?? result.activeIndex,
    sheetName: active?.name ?? "",
  });
  gridApi.refreshGridDimensions();
  gridApi.refreshGridData();
}

/** Reject a duplicate sheet name BEFORE the backend does, so the script gets a
 *  ValidationError naming the clash instead of a raw command string. */
async function assertSheetNameFree(
  lib: Awaited<ReturnType<typeof getLib>>,
  name: string,
  ignoreIndex: number | null,
): Promise<void> {
  const { sheets } = await lib.getSheets();
  const clash = sheets.find(
    (s) => s.index !== ignoreIndex && s.name.toLowerCase() === name.toLowerCase(),
  );
  if (clash) {
    throw new BrokerError("ValidationError", `A sheet named "${clash.name}" already exists`);
  }
}

/**
 * Apply a PARTIAL format to a rectangle. Absent properties are left alone, so a
 * script can bold a block without resetting its number format. The active sheet
 * takes apply_formatting (which also replicates to a grouped sheet selection,
 * exactly as a ribbon click would); another sheet takes the sheet-scoped
 * apply_formatting_to_sheets. Both are undoable as ONE step, backend-side.
 */
async function applyRangeFormat(
  lib: Awaited<ReturnType<typeof getLib>>,
  sheetIndex: number | undefined,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  format: FormattingOptions,
): Promise<void> {
  assertRangeSize(startRow, startCol, endRow, endCol);
  const active = await lib.getActiveSheet();
  const target = sheetIndex ?? active;
  const { rows, cols } = rectRowsCols(startRow, startCol, endRow, endCol);
  if (target === active) {
    const result = await lib.applyFormatting(rows, cols, format);
    await afterCellDataChange(result.cells);
    return;
  }
  await lib.applyFormattingToSheets([target], rows, cols, format);
  emitAppEvent(AppEvents.MUTATION_REFRESH, { domains: ["styles"] });
}

/**
 * Strip ALL formatting from a rectangle, keeping the values. Backed by
 * clear_range_with_options(applyTo: "formats") — an ACTIVE-SHEET command, so an
 * off-sheet target is refused rather than silently clearing the wrong sheet.
 */
async function clearRangeFormat(
  lib: Awaited<ReturnType<typeof getLib>>,
  sheetIndex: number | undefined,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): Promise<void> {
  assertRangeSize(startRow, startCol, endRow, endCol);
  await assertActiveSheet(lib, sheetIndex, "clearRangeFormat");
  await lib.clearRangeWithOptions(startRow, startCol, endRow, endCol, "formats");
  emitAppEvent(AppEvents.MUTATION_REFRESH, { domains: ["styles"] });
  (await import("../grid")).refreshGridData();
}

// ============================================================================
// Workbook objects: enumeration, creation, deletion, layout (B3)
// ============================================================================
// Everything below is WIRING over the trusted @api facade — the store services
// the Charts/Slicer/Controls extensions register (IoC), the typed @api/backend
// table wrappers, the @api/lib named-range wrappers, and the @api/pivot facade.
// No new backend command and no new capability: charts, tables, pivots, names,
// slicers and form controls all live INSIDE the document, which is exactly the
// reach the UNLOCKED tier already means (api.setCellValue sets that bar).
//
// The semantics deliberately mirror the MCP/AI tools that have had this reach
// since C1 (create_chart_from_spec / create_table / create_pivot /
// create_named_range + the list_* readers, app/src-tauri/src/mcp/tools.rs) —
// but through the FRONTEND path, so the extension that owns each object also
// gets to run its own post-create choreography (region sync, cache refresh).

/** Placement options for api.createChart (mirrors ChartPlacement). */
type ChartCreateOptions = ChartPlacement;

/** The `fields` argument of api.createPivot, in the Pivot Layout DSL's areas. */
interface ScriptPivotFields {
  rows?: string[];
  columns?: string[];
  filters?: string[];
  values: Array<string | { field: string; aggregation?: string }>;
}

/** The Charts extension's store service, or an actionable error. */
function requireChartStore(): NonNullable<ReturnType<typeof getChartStoreService>> {
  const store = getChartStoreService();
  if (!store) {
    throw new BrokerError("HostError", "The Charts extension is not loaded, so charts are unavailable");
  }
  return store;
}

/**
 * The @api/pivot facade, or an actionable error. The facade is a Proxy that
 * THROWS on property access until the Pivot extension registers its
 * implementation, so the probe below is how "not loaded" is detected without
 * the API layer importing the extension.
 */
async function requirePivotApi(): Promise<PivotApi> {
  const mod = await import("../pivot");
  try {
    void mod.pivot.getAll;
  } catch {
    throw new BrokerError("HostError", "The Pivot extension is not loaded, so pivot tables are unavailable");
  }
  return mod.pivot;
}

/** A workbook object was created/deleted: fan out through the feature-neutral
 *  MUTATION_REFRESH "objects" domain (the Shell translates it to charts:refresh,
 *  the table-definitions event and grid:refresh) so no extension is named here. */
async function announceObjectsChanged(): Promise<void> {
  emitAppEvent(AppEvents.MUTATION_REFRESH, { domains: ["objects"] });
  (await import("../grid")).refreshGridData();
}

/** A pivot's shape changed: the "pivot" domain reaches the Pivot extension's
 *  own refresh, which re-reads the view and repaints the destination cells. */
function announcePivotChanged(): void {
  emitAppEvent(AppEvents.MUTATION_REFRESH, { domains: ["pivot"] });
}

/**
 * Enumerate one kind of workbook object as safe descriptors (id + identity +
 * position, never contents). An object kind whose owning extension is not
 * loaded returns an EMPTY list rather than throwing — "this workbook has no
 * slicers" and "the Slicer extension is off" are the same answer to a script,
 * and failing the whole call would break a dashboard builder that merely asked.
 */
async function listWorkbookObjects(kind: ScriptObjectKind): Promise<ScriptObjectRef[]> {
  switch (kind) {
    case "chart":
      return (getChartStoreService()?.listCharts() ?? []).map(chartToRef);
    case "table": {
      const backend = await import("../backend");
      const tables = await backend.getAllTables();
      return tables.map(tableToRef);
    }
    case "pivot": {
      const api = await requirePivotApi();
      const pivots = await api.getAll();
      return pivots.map((p) => pivotToRef({
        id: p.pivotId ?? p.id,
        name: p.name,
        sourceRange: p.sourceRange,
        destination: p.destination,
      }));
    }
    case "namedRange": {
      const lib = await getLib();
      const names = await lib.getAllNamedRanges();
      return names.map(namedRangeToRef);
    }
    case "slicer":
      return (getSlicerStoreService()?.listSlicers() ?? []).map(slicerToRef);
    case "shape": {
      // Controls are stored per sheet and anchored to a cell, so the whole-
      // workbook view is the union over every sheet.
      const store = getControlStoreService();
      if (!store) return [];
      const lib = await getLib();
      const { sheets } = await lib.getSheets();
      const refs: ScriptObjectRef[] = [];
      for (const sheet of sheets) {
        const controls = await store.listControls(sheet.index);
        for (const c of controls) refs.push(shapeToRef(c));
      }
      return refs;
    }
    default:
      // vObjectKind already rejected anything else; this keeps the switch total.
      throw new BrokerError("ValidationError", `Unknown object kind: ${String(kind)}`);
  }
}

/**
 * Create a pivot table and lay its fields out, mirroring the UI's own two-step
 * flow (create_pivot, then update_pivot_fields — the Insert dialog creates the
 * pivot and the editor pane configures it). Field NAMES are resolved to source
 * column indices against the freshly built cache, so a script names columns the
 * way a user does instead of counting columns.
 */
async function createPivotFromScript(
  sourceRange: string,
  destinationCell: string,
  fields: ScriptPivotFields,
  options: { name?: string; sourceSheet?: number; destinationSheet?: number; hasHeaders?: boolean } | undefined,
): Promise<ScriptObjectRef> {
  const api = await requirePivotApi();
  const created = await api.create({
    sourceRange,
    destinationCell,
    sourceSheet: options?.sourceSheet,
    destinationSheet: options?.destinationSheet,
    hasHeaders: options?.hasHeaders ?? true,
    name: options?.name,
  });
  const pivotId = created.pivotId;

  const hierarchies = await api.getHierarchies(pivotId);
  const sourceFields = hierarchies.hierarchies;
  const toFieldConfig = (name: string) => {
    const source = resolveSourceField(sourceFields, name);
    return api.createFieldConfig(source.index, source.name);
  };
  const valueFields = fields.values.map((v) => {
    const name = typeof v === "string" ? v : v.field;
    const aggregation = typeof v === "string" ? undefined : v.aggregation;
    const source = resolveSourceField(sourceFields, name);
    // The DSL's aggregation words and the pivot API's AggregationType share the
    // sum/count/average/... spelling for the create path (only the Excel-shaped
    // AggregationFunction used by setAggregation differs), so the word passes
    // through; the validator already restricted it to the known set.
    return api.createValueFieldConfig(
      source.index,
      source.name,
      (aggregation ?? (source.isNumeric ? "sum" : "count")) as Parameters<PivotApi["createValueFieldConfig"]>[2],
    );
  });

  await api.updateFields({
    pivotId,
    rowFields: (fields.rows ?? []).map(toFieldConfig),
    columnFields: (fields.columns ?? []).map(toFieldConfig),
    filterFields: (fields.filters ?? []).map(toFieldConfig),
    valueFields,
  });
  announcePivotChanged();

  const info = await api.getInfo(pivotId);
  return pivotToRef({
    id: pivotId,
    name: info.name,
    sourceRange: info.sourceRange,
    destination: info.destination,
  });
}

/** A source column of a pivot's cache, matched by name (case-insensitive). */
interface SourceFieldLike {
  index: number;
  name: string;
  isNumeric: boolean;
}

/** Resolve a field NAME to its source column, listing the real names on a miss —
 *  a silent no-op here is the classic "my script did nothing" bug. */
function resolveSourceField(sourceFields: SourceFieldLike[], name: string): SourceFieldLike {
  const wanted = name.trim().toLowerCase();
  const match = sourceFields.find((f) => f.name.trim().toLowerCase() === wanted);
  if (!match) {
    const available = sourceFields.map((f) => f.name).join(", ") || "(none)";
    throw new BrokerError(
      "ValidationError",
      `No source field named "${name}" in this pivot. Available fields: ${available}`,
    );
  }
  return match;
}

/** One placed field of a pivot axis (mirrors RowColumnHierarchyInfo). */
interface PlacedFieldLike {
  name: string;
  fieldIndex: number;
  position: number;
}

/**
 * Find a PLACED field on one axis by name. Matches the placed name first (which
 * may be a display alias like "Sum of Sales") and falls back to the SOURCE
 * column's name, so `removeField("Sales", "values")` works whichever the pivot
 * happens to be storing.
 */
function findPlacedField(
  placed: PlacedFieldLike[],
  sourceFields: SourceFieldLike[],
  name: string,
): PlacedFieldLike | undefined {
  const wanted = name.trim().toLowerCase();
  const direct = placed.find((p) => p.name.trim().toLowerCase() === wanted);
  if (direct) return direct;
  return placed.find((p) => {
    const source = sourceFields.find((f) => f.index === p.fieldIndex);
    return source?.name.trim().toLowerCase() === wanted;
  });
}

/** The four DSL areas mapped onto a hierarchies snapshot's four field lists. */
function placedFieldsByArea(
  hierarchies: { rowHierarchies: PlacedFieldLike[]; columnHierarchies: PlacedFieldLike[]; dataHierarchies: PlacedFieldLike[]; filterHierarchies: PlacedFieldLike[] },
): Record<PivotArea, PlacedFieldLike[]> {
  return {
    rows: hierarchies.rowHierarchies,
    columns: hierarchies.columnHierarchies,
    values: hierarchies.dataHierarchies,
    filters: hierarchies.filterHierarchies,
  };
}

/**
 * Execute one pivot LAYOUT aspect. Reached from BOTH the own-object door
 * (object.setState on a pivot script) and the cross-instance door
 * (api.objectSetState), so the reach difference lives entirely in the allowlist
 * tier, never here.
 */
async function executePivotLayoutAspect(pivotId: string, aspect: string, args: unknown[]): Promise<void> {
  const api = await requirePivotApi();
  const hierarchies = await api.getHierarchies(pivotId);
  const sourceFields = hierarchies.hierarchies as SourceFieldLike[];

  switch (aspect) {
    case "pivot.addField": {
      const [field, area, position, aggregation] = args as [string, PivotArea, number?, string?];
      const source = resolveSourceField(sourceFields, field);
      await api.addHierarchy({
        pivotId,
        fieldIndex: source.index,
        axis: requireAxis(area),
        position: position ?? undefined,
        aggregation: aggregation ? requireAggregation(aggregation) : undefined,
      });
      return;
    }
    case "pivot.moveField": {
      const [field, area, position] = args as [string, PivotArea, number?];
      const source = resolveSourceField(sourceFields, field);
      await api.moveField({
        pivotId,
        fieldIndex: source.index,
        targetAxis: requireAxis(area),
        position: position ?? undefined,
      });
      return;
    }
    case "pivot.removeField": {
      const [field, area] = args as [string, PivotArea?];
      const byArea = placedFieldsByArea(hierarchies);
      const areas: PivotArea[] = area ? [area] : ([...PIVOT_AREAS] as PivotArea[]);
      for (const candidate of areas) {
        const placed = findPlacedField(byArea[candidate], sourceFields, field);
        if (!placed) continue;
        await api.removeHierarchy({
          pivotId,
          axis: requireAxis(candidate),
          position: placed.position,
        });
        return;
      }
      throw new BrokerError(
        "ValidationError",
        `Field "${field}" is not placed in ${area ? `the ${area} area` : "this pivot"}`,
      );
    }
    case "pivot.setAggregation": {
      const [field, aggregation] = args as [string, string];
      const placed = findPlacedField(hierarchies.dataHierarchies, sourceFields, field);
      if (!placed) {
        const placedNames = hierarchies.dataHierarchies.map((d) => d.name).join(", ") || "(none)";
        throw new BrokerError(
          "ValidationError",
          `Field "${field}" is not a value field of this pivot. Value fields: ${placedNames}`,
        );
      }
      // value_field_index is the POSITION in the pivot's value-field list, which
      // is exactly what getHierarchies reports as `position`.
      await api.setAggregation({
        pivotId,
        valueFieldIndex: placed.position,
        summarizeBy: requireAggregation(aggregation),
      });
      return;
    }
    case "pivot.setLayout": {
      const [directives] = args as [string[]];
      const { layout, unknown } = layoutDirectivesToConfig(directives);
      if (unknown.length > 0) {
        // The validator already enumerated the accepted directives, so reaching
        // here means the two lists drifted — fail loudly rather than half-apply.
        throw new BrokerError("ValidationError", `Unknown layout directive(s): ${unknown.join(", ")}`);
      }
      await api.updateLayout({ pivotId, layout });
      return;
    }
    default:
      throw new BrokerError("ValidationError", `Unknown pivot layout aspect: ${aspect}`);
  }
}

/** DSL area -> PivotAxis, with the accepted list on a miss. */
function requireAxis(area: string): PivotAxis {
  const axis = areaToAxis(area);
  if (!axis) {
    throw new BrokerError("ValidationError", `area must be one of: ${[...PIVOT_AREAS].join(", ")}`);
  }
  return axis;
}

/** DSL aggregation word -> AggregationFunction, with the accepted list on a miss. */
function requireAggregation(aggregation: string): AggregationFunction {
  const fn = aggregationToFunction(aggregation);
  if (!fn) {
    throw new BrokerError("ValidationError", `Unknown aggregation "${aggregation}"`);
  }
  return fn;
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
 * Passes the .calp writeback draft gate first, like every other script write.
 */
async function writeCellOnSheet(
  lib: Awaited<ReturnType<typeof getLib>>,
  scriptId: string,
  sheetIndex: number,
  row: number,
  col: number,
  value: string,
): Promise<void> {
  await captureWritebackWrite(scriptId, { sheetIndex, row, col, value });
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

// ============================================================================
// Workbook onBeforeSave / onBeforeClose (B5): cancellable lifecycle verdicts
// ============================================================================

/**
 * Hard deadline for a script's save/close verdict.
 *
 * Generous compared to the 1.5s commit deadline because these handlers legitimately
 * do work — stamping a version cell, validating a block of inputs — each of which is
 * a broker round trip. It is still a HARD ceiling: saving and closing are the two
 * operations a user must never lose control of.
 */
const BEFORE_LIFECYCLE_DEADLINE_MS = 3000;

const BEFORE_LIFECYCLE_TIMEOUT = Symbol("beforeLifecycleTimeout");

/** The relayed method name for each cancellable workbook hook. */
const LIFECYCLE_RELAY: Record<LifecycleAction, string> = {
  save: "__workbook_onBeforeSave",
  close: "__workbook_onBeforeClose",
};

/** Verdict a workbook script's onBeforeSave / onBeforeClose may return. */
export interface WorkbookLifecycleVerdict {
  cancel: boolean;
  /** Shown to the user alongside the script's name. */
  reason?: string;
}

/**
 * Normalize whatever a handler returned into a verdict.
 *
 * Accepted cancel forms: `false`, `"cancel"`, `{ cancel: true, reason? }`.
 * EVERYTHING ELSE — including `undefined` from a handler that just did some
 * work — allows. A handler that forgets to return must not cancel the user's save.
 */
export function normalizeLifecycleVerdict(result: unknown): WorkbookLifecycleVerdict | null {
  if (result === false || result === "cancel") return { cancel: true };
  if (result && typeof result === "object") {
    const v = result as { cancel?: unknown; reason?: unknown };
    if (v.cancel === true) {
      return { cancel: true, reason: typeof v.reason === "string" ? v.reason : undefined };
    }
  }
  return null;
}

/**
 * Race one script's verdict against the deadline.
 *
 * DEFAULT-ALLOW on timeout and on a thrown handler — the same policy
 * range.onBeforeCommit uses, and for the same reason applied to the two
 * highest-stakes operations there are: a hung or crashed script must NEVER be
 * able to hold Ctrl+S (or the window's close button) hostage. Default-DENY would
 * mean one broken third-party script could make a workbook unsaveable and the app
 * unclosable, with no way out but killing the process and losing the work — a
 * strictly worse outcome than ignoring a veto the script failed to deliver in time.
 * The veto is therefore an ADVISORY that a script must answer promptly to exercise.
 *
 * Exported (with an injectable relay + deadline) so the default-allow behaviour
 * is directly testable without spawning a worker.
 */
export async function raceLifecycleVerdict(
  relay: () => Promise<unknown>,
  scriptName: string,
  action: LifecycleAction,
  deadlineMs: number = BEFORE_LIFECYCLE_DEADLINE_MS,
): Promise<WorkbookLifecycleVerdict | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      relay(),
      new Promise<typeof BEFORE_LIFECYCLE_TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(BEFORE_LIFECYCLE_TIMEOUT), deadlineMs);
      }),
    ]);
    if (result === BEFORE_LIFECYCLE_TIMEOUT) {
      console.warn(
        `[ScriptHost] onBefore${action === "save" ? "Save" : "Close"} of "${scriptName}" ` +
          `exceeded ${deadlineMs}ms — allowing the ${action}`,
      );
      return null;
    }
    return normalizeLifecycleVerdict(result);
  } catch {
    return null; // handler threw — allow (the error already surfaced on the console)
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Ask ONE mounted script for a save/close verdict. An unmounted script cannot
 * object (returns null = allow).
 */
export async function callWorkbookBeforeLifecycle(
  scriptId: string,
  action: LifecycleAction,
  detail: LifecycleDetail,
): Promise<WorkbookLifecycleVerdict | null> {
  const mw = mounted.get(scriptId);
  if (!mw) return null;
  return raceLifecycleVerdict(
    () => relayMethodCall(mw, LIFECYCLE_RELAY[action], [detail]),
    mw.definition.name,
    action,
  );
}

/**
 * Wire a cancellable workbook hook: register a lifecycle guard that pulls this
 * script's verdict when a save or close is attempted. Returned cleanup is stored
 * as the hook's forwarder, so unmount removes the guard with it (an unmounted
 * script can never veto).
 */
function wireLifecycleGuardForwarder(mw: MountedWorker, action: LifecycleAction): CleanupFn {
  const scriptId = mw.definition.id;
  return registerLifecycleGuard(
    async (a, detail): Promise<LifecycleGuardResult | null> => {
      if (a !== action) return null;
      const verdict = await callWorkbookBeforeLifecycle(scriptId, action, detail);
      if (!verdict?.cancel) return null;
      return { by: mw.definition.name, reason: verdict.reason };
    },
  );
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
  // Payloads crossing into the sandbox are THINNED for events whose full
  // payload carries capability-gated metadata (BI model events).
  addForwarder(
    mw,
    hook,
    onAppEvent(eventName, (detail) =>
      forwardEvent(mw, hook, thinAppEventForScripts(eventName, detail)),
    ),
  );
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
    // onBeforeSave / onBeforeClose are REPLYING hooks (B5): no event forwarder —
    // the SAVE and CLOSE paths pull a verdict through the lifecycle-guard
    // registry and await it. Registering the guard as this hook's "forwarder"
    // means unmount tears it down like any other, so a script that is gone can
    // neither be asked nor block anything.
    case "workbook.onBeforeSave":
      addForwarder(mw, hook, wireLifecycleGuardForwarder(mw, "save"));
      break;
    case "workbook.onAfterSave":
      wireAppEventForwarder(mw, hook, AppEvents.AFTER_SAVE);
      break;
    case "workbook.onBeforeClose":
      addForwarder(mw, hook, wireLifecycleGuardForwarder(mw, "close"));
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
    //
    // The structural events are emitted by the tauri-api wrappers and carry no
    // sheet index (they always act on the active sheet). The SCRIPT contract
    // does declare `sheetIndex` — see objectContexts.d.ts, which is fed to
    // Monaco verbatim — so enrich it here rather than let scripts read
    // `undefined` with no type error. Same treatment sheet.onDataChange gets.
    case "row.onInsert":
      addForwarder(mw, hook, onAppEvent(AppEvents.ROWS_INSERTED, (detail) => {
        forwardEvent(mw, hook, { sheetIndex: activeSheetIndexForEvents, ...(detail as object) });
      }));
      break;
    case "row.onDelete":
      addForwarder(mw, hook, onAppEvent(AppEvents.ROWS_DELETED, (detail) => {
        forwardEvent(mw, hook, { sheetIndex: activeSheetIndexForEvents, ...(detail as object) });
      }));
      break;
    case "row.onResize":
      wireAppEventForwarder(mw, hook, AppEvents.ROW_RESIZED);
      break;
    case "column.onInsert":
      addForwarder(mw, hook, onAppEvent(AppEvents.COLUMNS_INSERTED, (detail) => {
        forwardEvent(mw, hook, { sheetIndex: activeSheetIndexForEvents, ...(detail as object) });
      }));
      break;
    case "column.onDelete":
      addForwarder(mw, hook, onAppEvent(AppEvents.COLUMNS_DELETED, (detail) => {
        forwardEvent(mw, hook, { sheetIndex: activeSheetIndexForEvents, ...(detail as object) });
      }));
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
