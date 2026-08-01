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
  hostCallExposed,
  listExposed,
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
  type DebugAction,
  type DebugPauseState,
  type DebugReadyState,
  type DebugSnapshotState,
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
import { MAX_RANGE_CELLS, MAX_FILE_TEXT_CHARS } from "./validators";
import type { PickerTextEncoding } from "../filesystem";
import type { AutoFilterColumnCriteria } from "../autoFilterService";
import type { ScriptCell } from "../scriptableObjects";
import type { TypedCellData } from "../lib";
import type { CellData, FormattingOptions } from "../types";
import {
  fetchOriginOf,
  grantBackendCapability,
  grantNetOrigin,
  hasFetchOrigin,
  persistAlwaysGrant,
  recordCapabilityGrant,
  requestCapabilityGrant,
  resetAllGrants,
  restoreAndSyncGrants,
  revokeBackendCapabilities,
  RUST_MIRRORED_CAPABILITIES,
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
import { revokeScriptKeybindingsForScript } from "../keybindings";
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
// Workbook file lifecycle (G1): rate limit + Before-Save re-entrancy guard
// ============================================================================
//
// A script-initiated save takes EXACTLY the path Ctrl+S takes (core/lib/file-api
// saveFile/saveFileAs): the cancellable Before-Save guards, the BEFORE_SAVE /
// AFTER_SAVE broadcasts, and — for Save As — the .xlsx lossy-save consent. None
// of that is re-implemented here, because a second implementation is a second
// set of rules for the same act, and the whole point of the veto is that it
// applies to a script exactly as it applies to a person.
//
// Two guards are this file's own:
//
//  1. RATE. One save per script per SCRIPT_SAVE_MIN_INTERVAL_MS. A `while(true)
//     save()` loop must not thrash the disk (or, on a large workbook, wedge the
//     app). This is a resource guard, NOT a security boundary — a compromised
//     renderer can call save_file directly and always could; the security
//     boundary here is that the WORKER cannot reach Tauri at all.
//
//  2. RE-ENTRANCY. A save attempted while a Before-Save/Close verdict is being
//     collected is refused. Without it, an onBeforeSave handler that calls
//     save() re-enters checkLifecycleGuards and recurses. Refusing is also the
//     honest semantic: a handler being asked "may this save proceed?" is not in
//     a position to start another one.

/** Minimum gap between two script-initiated saves BY THE SAME SCRIPT. */
export const SCRIPT_SAVE_MIN_INTERVAL_MS = 5_000;

/** scriptId -> timestamp of its last accepted save/saveAs. */
const lastScriptSave = new Map<string, number>();

/** Depth of the Before-Save/Close verdict collection currently in progress. */
let lifecycleVerdictDepth = 0;

/** True while any mounted script is being asked for a save/close verdict. */
export function isCollectingLifecycleVerdict(): boolean {
  return lifecycleVerdictDepth > 0;
}

/**
 * Run `fn` with the Before-Save/Close verdict depth raised, so any save a
 * SCRIPT attempts while its own (or another script's) handler is being consulted
 * is refused instead of re-entering checkLifecycleGuards.
 *
 * The wrapper exists — rather than two bare `depth += 1` lines inside the
 * forwarder — so the rule itself is directly testable: the recursion it prevents
 * would otherwise need a live worker to reproduce, which is exactly the kind of
 * thing that ends up untested and then ships.
 */
export async function withLifecycleVerdictDepth<T>(fn: () => Promise<T>): Promise<T> {
  lifecycleVerdictDepth += 1;
  try {
    return await fn();
  } finally {
    // Clamped: a workbook reset (hostResetAll -> resetScriptSaveLimits) can zero
    // the counter while a verdict is still in flight, and a negative depth would
    // make the NEXT reset leave the guard permanently disarmed.
    lifecycleVerdictDepth = Math.max(0, lifecycleVerdictDepth - 1);
  }
}

/**
 * Throw unless `scriptId` may start a save right now. CHECK ONLY — the bucket is
 * spent by {@link recordScriptSave}, once the save is actually going ahead.
 *
 * The split matters for one very ordinary script: `save()` on a workbook that
 * has never been saved throws "no file to save back to", and the obvious next
 * line is `saveAs()`. If the refused call had already spent the bucket, that
 * second line would fail too, with a message about saving too often — punishing
 * a script for an error it handled correctly.
 *
 * Separated from the executor so both rules are testable without a worker, and
 * so the two refusal messages stay distinguishable to a script that wants to
 * degrade gracefully.
 */
export function assertScriptSaveAllowed(scriptId: string, now: number = Date.now()): void {
  if (lifecycleVerdictDepth > 0) {
    throw new BrokerError(
      "HostError",
      "a save cannot be started from inside an onBeforeSave / onBeforeClose handler",
    );
  }
  const last = lastScriptSave.get(scriptId);
  if (last !== undefined && now - last < SCRIPT_SAVE_MIN_INTERVAL_MS) {
    const waitMs = SCRIPT_SAVE_MIN_INTERVAL_MS - (now - last);
    throw new BrokerError(
      "HostError",
      `saving too often: wait ${Math.ceil(waitMs / 1000)}s ` +
        `(a script may save at most once every ${SCRIPT_SAVE_MIN_INTERVAL_MS / 1000}s)`,
    );
  }
}

/** Spend this script's save budget. Called once a save is really going ahead —
 *  including one the user then cancels, because the guards ran and (for Save As)
 *  a dialog was put on their screen. */
export function recordScriptSave(scriptId: string, now: number = Date.now()): void {
  lastScriptSave.set(scriptId, now);
}

/** Forget every save rate-limit bucket (workbook reset / tests). */
export function resetScriptSaveLimits(): void {
  lastScriptSave.clear();
  lifecycleVerdictDepth = 0;
}

/**
 * The executor behind `api.workbook.save()` / `saveAs()`.
 *
 * Exported so the two things that make it safe are directly testable without
 * spawning a worker: the rate/re-entrancy refusal, and the fact that a
 * Before-Save VETO comes back as `{ saved: false }` rather than a silent
 * success. It delegates to core/lib/file-api — the SAME functions Ctrl+S and
 * the File menu call — so the veto, the BEFORE_SAVE/AFTER_SAVE broadcasts, the
 * dirty-state event, the window title and the .xlsx lossy-save consent are the
 * originals, not a second implementation that could drift from them.
 */
export async function executeWorkbookSave(
  scriptId: string,
  mode: "save" | "saveAs",
): Promise<ScriptSaveResult> {
  assertScriptSaveAllowed(scriptId);
  const fs = await import("../filesystem");
  if (mode === "save") {
    const currentPath = await fs.getCurrentFilePath();
    if (!currentPath) {
      // Deliberately NOT a silent Save As. saveFile() falls back to a picker
      // when there is no path; for a script that would mean a file dialog the
      // user never asked for, appearing out of nowhere. Fail loudly instead and
      // let the script call saveAs() if that is really what it meant. The rate
      // bucket is deliberately NOT spent here, so that saveAs() can follow
      // immediately.
      throw new BrokerError(
        "HostError",
        "this workbook has never been saved, so there is no file to save it back to — use saveAs()",
      );
    }
    // null here can only mean a Before-Save guard vetoed (the no-path branch is
    // excluded above), and the veto has already been reported to the user by
    // name through the lifecycle cancel reporter.
    recordScriptSave(scriptId);
    const savedPath = await fs.saveFile();
    return savedPath ? { saved: true, name: fs.fileNameOf(savedPath) } : { saved: false, name: null };
  }
  // saveAs: the script supplies NOTHING — no path, no name, no filter.
  // saveFileAs() opens the same picker the File menu opens, applies the same
  // .xlsx loss report, and runs the same Before-Save guards. A cancelled picker,
  // a declined loss report and a vetoing guard all return null; all three are
  // "the user said no", and all three resolve rather than reject.
  recordScriptSave(scriptId);
  const savedPath = await fs.saveFileAs();
  return savedPath ? { saved: true, name: fs.fileNameOf(savedPath) } : { saved: false, name: null };
}

// ---- file.picker helpers (G1) ------------------------------------------------

/** MIME types worth a friendlier picker label than "CSV file". Purely
 *  cosmetic — a mimeType a script sends can only ever change the words on one
 *  filter row, never which file is written or where. */
const MIME_FILTER_LABELS: Record<string, string> = {
  "text/csv": "CSV file",
  "text/plain": "Text file",
  "text/tab-separated-values": "Tab-separated file",
  "text/markdown": "Markdown file",
  "text/html": "HTML file",
  "application/json": "JSON file",
  "application/xml": "XML file",
  "text/xml": "XML file",
};

/** The extension of a bare file name, lowercased, without the dot. */
function fileExtensionOf(name: string): string | undefined {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return undefined;
  const ext = name.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,16}$/.test(ext) ? ext : undefined;
}

/** The label for the picker's file-type row. The script's own `description`
 *  wins (it knows what it is producing), then the MIME table, then the bare
 *  extension. Never the script's name — a filter row must not read like the
 *  app is vouching for the file. */
function filterLabelFor(
  description: string | undefined,
  mimeType: string | undefined,
  extension: string | undefined,
): string {
  if (description && description.trim().length > 0) return description.trim();
  if (mimeType && MIME_FILTER_LABELS[mimeType]) return MIME_FILTER_LABELS[mimeType];
  if (extension) return `${extension.toUpperCase()} file`;
  return "File";
}

/** The shape `api.workbook.save()` / `saveAs()` resolve to. A cancellation —
 *  a guard veto, a dismissed picker, a declined .xlsx loss report — is NOT an
 *  error: it resolves with `saved: false`, so a script's cancel path is
 *  `if (!result.saved) return;` and never a rejected promise it must catch. */
export interface ScriptSaveResult {
  saved: boolean;
  /** The file NAME written to (never a path); null when nothing was saved. */
  name: string | null;
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
  /**
   * Debug sessions only: suspends/restarts the 10s mount deadline. A breakpoint
   * inside `setup` legitimately stops the mount for as long as the user is
   * reading it, and the deadline would otherwise tear the worker down (and with
   * it the session) mid-inspection.
   */
  suspendMountDeadline?: () => void;
  resumeMountDeadline?: () => void;
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

  // An open debug session survives a remount (Save & Apply keeps you in the
  // debugger), but every remount restarts from a clean, un-paused state.
  const debugSession = debugSessions.get(definition.id) ?? null;
  if (debugSession) {
    debugSession.status = "starting";
    debugSession.paused = null;
    debugSession.ready = null;
    debugSession.lastSnapshot = null;
    emitDebugState(debugSession, definition.id);
  }

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
  // Re-establish this script's grants BEFORE the mount spec is built, so the
  // capability list the worker realm receives is the one it actually has:
  //   1. persisted "Allow always" decisions for THIS EXACT SOURCE (local
  //      scripts only; a changed source lapses the grant and arms a diff for
  //      the next JIT prompt), then
  //   2. the resulting live set is pushed to the authoritative Rust store, which
  //      re-validates every id — a persisted decision is an INPUT to the grant
  //      flow, never a bypass of it.
  // Awaited (the old fire-and-forget sync pair was not) because a scheduled job
  // restored from the .cala can be swept as "due" the moment the tick pump
  // starts, and Rust denies it unless the `schedule` grant is already there.
  await restoreAndSyncGrants({
    scriptId: definition.id,
    scriptName: definition.name,
    source: definition.source,
    origin: handle.origin,
    declaredCapabilities: handle.declaredCapabilities,
  });

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
    // Only a script the user explicitly opened a debug session on is
    // instrumented; every other mount is byte-for-byte the production path.
    debug: debugSession
      ? {
          breakpoints: debugSession.breakpoints,
          pauseOnEntry: pauseOnEntryOnce.get(definition.id) === true,
        }
      : undefined,
    snapshot,
  };
  pauseOnEntryOnce.set(definition.id, false);

  const mountedPromise = new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const arm = (): void => {
      if (settled || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        settled = true;
        reject(new Error("Script mount timed out (10s)"));
      }, 10_000);
    };
    const disarm = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    arm();
    // A debug session may legitimately stop inside `setup`; the deadline is
    // suspended while it is paused and re-armed the moment it resumes, so a
    // debugger can never be killed by the clock it is standing still in front of.
    mw.suspendMountDeadline = disarm;
    mw.resumeMountDeadline = arm;
    wireWorker(mw, (ok, error) => {
      settled = true;
      disarm();
      mw.suspendMountDeadline = undefined;
      mw.resumeMountDeadline = undefined;
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
  // Take back every keyboard shortcut it held. The per-binding cleanups above
  // already do this; this sweep is by scriptId and is the one that must not be
  // forgettable — a shortcut that outlives its script is a key the user can
  // press to reach code that is gone, which is precisely the ambient state
  // Application.OnKey left behind.
  revokeScriptKeybindingsForScript(scriptId);
  // Throw away its private clipboard. It holds cell VALUES — a copy of part of
  // the user's data — so it must not outlive the code that captured it, and a
  // remounted successor must not inherit a buffer it never filled.
  clearScriptClipboard(scriptId);
  mounted.delete(scriptId);
  // The worker is gone, so any pause died with it. Say so rather than leaving a
  // "paused" indicator standing in front of a script that no longer exists.
  const session = debugSessions.get(scriptId);
  if (session && session.status !== "detached") {
    session.status = "detached";
    session.paused = null;
    emitDebugState(session, scriptId);
  }
}

export function hostIsMounted(scriptId: string): boolean {
  return mounted.has(scriptId);
}

export function hostResetAll(): void {
  for (const scriptId of [...mounted.keys()]) {
    hostUnmountScript(scriptId);
  }
  faulted.clear();
  // A new workbook is a new file: no debug session from the previous one may
  // survive it (and none may be left "paused" against a worker that is gone).
  for (const scriptId of [...debugSessions.keys()]) {
    debugSessions.delete(scriptId);
    pauseOnEntryOnce.delete(scriptId);
    emitDebugState(null, scriptId);
  }
  // Workbook reset = fresh session: forget all capability grants.
  resetAllGrants();
  // ...and every dialog mute / dismissal streak, so the next workbook's scripts
  // are not judged by the previous one's behavior.
  resetScriptDialogs();
  // ...and the save rate buckets: a new workbook is a new file, and the old
  // one's timings say nothing about it.
  resetScriptSaveLimits();
  // ...and every private clipboard: those hold cells from the workbook that is
  // being replaced, and a style index from it means nothing in the next one.
  clearScriptClipboard();
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
// Debug sessions (task H1) — real step-through over the worker RPC
// ============================================================================
//
// A session is ENTERED EXPLICITLY, by a user gesture in the script editor, on
// one named script. It is never ambient and never self-service: nothing in the
// ALLOWLIST, no `object.setState`/`object.getState` aspect, no broker method and
// no extension-broker method produces a session, so a distributed script cannot
// arrange to pause itself (nor to pause anybody else). Entering one REMOUNTS the
// script with instrumentation — the mount is the only place its source is
// compiled — which is why the UI announces the restart.
//
// A paused script holds no lock the app needs. Everything that awaits a script
// is bounded host-side and defaults to letting the user through:
//   - cell/bitmap renders   -> RENDER_TIMEOUT_MS, and the worker refuses to
//                              suspend inside a render at all (beginNoPause).
//   - onBeforeCommit        -> 1.5s, verdict defaults to ALLOW; a paused script
//                              is skipped outright (see callRangeBeforeCommit).
//   - onBeforeSave/Close    -> 3s, verdict defaults to ALLOW; a paused script is
//                              likewise skipped, so a workbook can ALWAYS be
//                              saved and closed while a debugger sits open.
//   - scheduled jobs        -> METHOD_CALL_TIMEOUT_MS in the renderer plus the
//                              Rust MAX_RUN_MS watchdog; a firing lands as a
//                              normal failed run and is re-armed.
//   - JS UDF evaluation     -> the same relayed-call deadline; the cell reports
//                              an error and recalculates later.

/** State of one open debug session, as the editor renders it. */
export interface DebugSessionState {
  scriptId: string;
  scriptName: string;
  /** "starting" until the worker reports what it managed to instrument. */
  status: "starting" | "running" | "paused" | "detached";
  breakpoints: number[];
  ready: DebugReadyState | null;
  paused: DebugPauseState | null;
  /** Most recent non-pausing (synchronous-context) breakpoint report. */
  lastSnapshot: DebugSnapshotState | null;
}

const debugSessions = new Map<string, DebugSessionState>();

/** Broadcast the session so every editor surface can re-render it. */
function emitDebugState(session: DebugSessionState | null, scriptId: string): void {
  emitAppEvent("objectscript:debug-state", { scriptId, session });
}

/** The open session for a script, if any. */
export function getDebugSession(scriptId: string): DebugSessionState | null {
  return debugSessions.get(scriptId) ?? null;
}

/** Every open session (transparency: the user can see what is being debugged). */
export function listDebugSessions(): DebugSessionState[] {
  return [...debugSessions.values()];
}

/**
 * True while this script is suspended at a yield point. Callers that hold a
 * user-visible operation open (commit verdicts, save/close verdicts) use it to
 * skip the wait entirely instead of burning their deadline on a script that is
 * provably not going to answer.
 */
export function isScriptDebugPaused(scriptId: string): boolean {
  return debugSessions.get(scriptId)?.status === "paused";
}

/**
 * Open a debug session on a mounted script and remount it instrumented.
 *
 * Rejects for an unknown/unmounted script: the session is built from the
 * AUTHORITATIVE mount definition the host already holds, never from anything
 * the caller supplies beyond the breakpoint lines.
 */
export async function hostStartDebugSession(
  scriptId: string,
  breakpoints: number[] = [],
  options: { pauseOnEntry?: boolean } = {},
): Promise<DebugSessionState> {
  const mw = mounted.get(scriptId);
  if (!mw) {
    throw new Error("Cannot debug a script that is not mounted — apply it first.");
  }
  const definition = mw.definition;
  const session: DebugSessionState = {
    scriptId,
    scriptName: definition.name,
    status: "starting",
    breakpoints: normalizeBreakpointLines(breakpoints),
    ready: null,
    paused: null,
    lastSnapshot: null,
  };
  debugSessions.set(scriptId, session);
  pauseOnEntryOnce.set(scriptId, options.pauseOnEntry === true);
  emitDebugState(session, scriptId);
  try {
    // Ungated remount on purpose: this is already-consented code being
    // relaunched, exactly like the crash-respawn path. Re-gating here would
    // prompt mid-session for a script the user is already running.
    await mountWorker(definition);
  } catch (err) {
    debugSessions.delete(scriptId);
    pauseOnEntryOnce.delete(scriptId);
    emitDebugState(null, scriptId);
    throw err;
  }
  return session;
}

/**
 * End a session: release any pause FIRST (a stop must always resume — a script
 * may never be left suspended by the act of closing the debugger), then remount
 * the script from its original source so no instrumentation survives.
 */
export async function hostStopDebugSession(scriptId: string): Promise<void> {
  const session = debugSessions.get(scriptId);
  if (!session) return;
  const mw = mounted.get(scriptId);
  if (mw) {
    post(mw, { t: "debugControl", action: "stop" });
  }
  debugSessions.delete(scriptId);
  pauseOnEntryOnce.delete(scriptId);
  emitDebugState(null, scriptId);
  if (mw) {
    await mountWorker(mw.definition);
  }
}

/** Drive a running session (continue / step / pause). */
export function hostDebugControl(scriptId: string, action: DebugAction): void {
  const session = debugSessions.get(scriptId);
  if (!session) return;
  if (action === "stop") {
    void hostStopDebugSession(scriptId);
    return;
  }
  const mw = mounted.get(scriptId);
  if (!mw) return;
  post(mw, { t: "debugControl", action });
  if (session.status === "paused") {
    session.status = "running";
    session.paused = null;
    emitDebugState(session, scriptId);
  }
}

/** Move breakpoints mid-session — live data, no remount. */
export function hostSetDebugBreakpoints(scriptId: string, lines: number[]): void {
  const normalized = normalizeBreakpointLines(lines);
  const session = debugSessions.get(scriptId);
  if (session) {
    session.breakpoints = normalized;
    emitDebugState(session, scriptId);
  }
  const mw = mounted.get(scriptId);
  if (mw && session) {
    post(mw, { t: "debugBreakpoints", lines: normalized });
  }
}

function normalizeBreakpointLines(lines: number[]): number[] {
  const set = new Set<number>();
  for (const n of lines) {
    if (Number.isInteger(n) && n > 0) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

/** pauseOnEntry applies to the mount that starts the session, not to later ones. */
const pauseOnEntryOnce = new Map<string, boolean>();

function handleDebugMessage(mw: MountedWorker, msg: Extract<W2H, { t: `debug${string}` }>): void {
  const scriptId = mw.definition.id;
  const session = debugSessions.get(scriptId);
  if (!session) return;
  switch (msg.t) {
    case "debugReady":
      session.ready = msg.state;
      session.status = "running";
      break;
    case "debugPaused":
      session.status = "paused";
      session.paused = msg.state;
      // The script stopped before finishing `setup` — hold the mount deadline
      // open for as long as the user keeps it there.
      mw.suspendMountDeadline?.();
      break;
    case "debugResumed":
      session.status = "running";
      session.paused = null;
      mw.resumeMountDeadline?.();
      break;
    case "debugSnapshot":
      session.lastSnapshot = msg.state;
      break;
  }
  emitDebugState(session, scriptId);
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
      case "debugReady":
      case "debugPaused":
      case "debugResumed":
      case "debugSnapshot":
        handleDebugMessage(mw, msg);
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
    if (decision === "always") {
      // Persisted per workbook + script + SOURCE HASH, and per ORIGIN: another
      // origin re-prompts even though net.fetch itself is now remembered.
      await persistAlwaysGrant({
        scriptId: handle.scriptId,
        scriptName: handle.scriptName,
        source: mw.definition.source,
        origin: handle.origin,
        capability: cap,
        netOrigin: origin,
      });
    }
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
    if (decision === "always") {
      // "Always" now survives a restart — bound to this workbook and to this
      // script's exact source. This is what makes a `schedule` job restored
      // from the .cala able to fire without re-asking (§7.10).
      await persistAlwaysGrant({
        scriptId: handle.scriptId,
        scriptName: handle.scriptName,
        source: mw.definition.source,
        origin: handle.origin,
        capability: cap,
        netOrigin: null,
      });
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
    case "api.splitPanes": {
      // The freeze row's twin, and the same orchestrator shape: @api/grid
      // persists the split AND emits SPLIT_CHANGED, which the Shell bridges into
      // Core's split config — the same path View ▸ Split uses. Nothing about the
      // document changes, only what is on screen.
      const [splitRow, splitCol] = args as [number | null, number | null];
      const grid = await import("../grid");
      await grid.splitWindow(splitRow ?? null, splitCol ?? null);
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
    case "api.moveSheet": {
      // Reordering renumbers OTHER sheets, so a script holding indexes must
      // re-read after this. Both ends are checked against the live list first:
      // move_sheet clamps out-of-range silently, and a silent clamp is a script
      // that thinks it moved a sheet somewhere it did not.
      const [fromIndex, toIndex] = args as [number, number];
      const lib = await getLib();
      const before = await lib.getSheets();
      if (!before.sheets.some((s) => s.index === fromIndex)) {
        throw new BrokerError("ValidationError", `No sheet with index ${fromIndex}`);
      }
      if (toIndex >= before.sheets.length) {
        throw new BrokerError(
          "ValidationError",
          `toIndex ${toIndex} is past the last position (${before.sheets.length - 1})`,
        );
      }
      const result = await lib.moveSheet(fromIndex, toIndex);
      await announceSheetsChanged(result);
      return undefined;
    }
    case "api.copySheet": {
      // copy_sheet inserts the duplicate immediately after its source, so every
      // index at or after that point shifts by one — the same "re-read your
      // indexes" contract as moveSheet. The new sheet is resolved by comparing
      // the list BEFORE and AFTER rather than by arithmetic on the insert
      // position, so a backend that changes where it inserts cannot make this
      // return the wrong sheet.
      const [sourceIndex, newName] = args as [number, string?];
      const lib = await getLib();
      const before = await lib.getSheets();
      if (!before.sheets.some((s) => s.index === sourceIndex)) {
        throw new BrokerError("ValidationError", `No sheet with index ${sourceIndex}`);
      }
      if (newName !== undefined && newName !== null) {
        await assertSheetNameFree(lib, newName, null);
      }
      const result = await lib.copySheet(sourceIndex, newName ?? undefined);
      await announceSheetsChanged(result);
      const beforeNames = new Set(before.sheets.map((s) => s.name));
      const added = result.sheets.find((s) => !beforeNames.has(s.name));
      if (!added) {
        throw new BrokerError("HostError", "The sheet was copied but the new sheet could not be identified");
      }
      return { index: added.index, name: added.name };
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
    // ---- the WorksheetFunction bridge (G4) ----
    // Nothing is written and nothing is remembered: the Rust command builds a
    // throwaway evaluator over the live grid, answers, and drops it. So this is
    // a READ, and its reach is exactly api.getRangeValues' reach.
    case "api.evaluate": {
      const [expressions, options] = args as [string[], { sheetIndex?: number } | undefined];
      const mod = await import("../formulaEval");
      return mod.evaluateFormulasTyped(expressions, options?.sheetIndex);
    }
    // ---- explicit formula read/write, A1 or R1C1 (G4) ----
    case "api.getCellFormula": {
      const [row, col, options] = args as [number, number, ScriptFormulaOptions | undefined];
      const lib = await getLib();
      return readCellFormula(lib, options?.sheetIndex, row, col, options?.style);
    }
    case "api.setCellFormula": {
      const [row, col, formula, options] = args as
        [number, number, string | null, ScriptFormulaOptions | undefined];
      const lib = await getLib();
      await writeCellFormula(lib, definition.id, options?.sheetIndex, row, col, formula, options?.style);
      return undefined;
    }
    // ---- range copy / paste / paste special (G4) ----
    case "api.copyRange": {
      const [startRow, startCol, endRow, endCol, sheetIndex] = args as
        [number, number, number, number, number?];
      const lib = await getLib();
      return copyRangeToScriptClipboard(lib, definition.id, sheetIndex, startRow, startCol, endRow, endCol);
    }
    case "api.pasteRange": {
      const [row, col, options] = args as [number, number, ScriptPasteOptions | undefined];
      const lib = await getLib();
      return pasteScriptClipboard(lib, definition.id, row, col, options ?? {});
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
      // No skip count: the backend guard now REFUSES a replace that touches a
      // claimed writeback region outright (it rejects, naming the region),
      // rather than silently completing a partial edit.
      return { replacementCount: result.replacementCount };
    }

    // ---- unlocked: column filtering / AutoFilter (G4) ----
    //
    // ALL SIX go through @api/autoFilterService, never through the backend
    // commands directly, and that is a correctness requirement rather than a
    // layering preference. The AutoFilter extension caches the filter's range,
    // and a chevron click sends a column index RELATIVE to that cached start
    // column, which the backend then resolves against ITS start column. Filter
    // behind the cache's back and the next click filters a different column than
    // the one the user pressed. The seam is also what pushes the hidden-row set
    // into Core and re-syncs the chevron regions, so it is the only door that
    // leaves the grid showing what the backend believes.
    //
    // Nothing here touches `Table.autoFilterId`. That link is DERIVED state that
    // Rust recomputes in relink_autofilter_owner inside the very commands these
    // calls reach (after releasing the auto_filters guard, because the canonical
    // lock order is tables -> auto_filters). Maintaining it from here would both
    // duplicate that rule and get it wrong.
    case "api.autoFilterGet":
    case "api.autoFilterListValues":
    case "api.autoFilterApply":
    case "api.autoFilterSetColumn":
    case "api.autoFilterClear":
    case "api.autoFilterRemove":
      return executeAutoFilter(method, args);

    // ---- unlocked: workbook file lifecycle (G1) ----
    //
    // Every one of these delegates to core/lib/file-api — the SAME functions the
    // File menu and Ctrl+S call. That is the requirement, not a convenience: the
    // Before-Save veto, the BEFORE_SAVE/AFTER_SAVE broadcasts, the dirty-state
    // event, the window title and the .xlsx lossy-save consent all live there,
    // and a script-initiated save that reimplemented any of them would be a save
    // the user cannot veto or be warned about.
    case "api.workbookSave":
      return executeWorkbookSave(definition.id, "save");
    case "api.workbookSaveAs":
      return executeWorkbookSave(definition.id, "saveAs");
    case "api.workbookIsDirty": {
      const fs = await import("../filesystem");
      return fs.isFileModified();
    }
    case "api.workbookFileName": {
      // NAME ONLY. The full path is withheld on purpose: a sandboxed script has
      // no API that takes a path, so the directory buys it nothing — while
      // "C:\Users\<real name>\Consulting\ClientX" handed to a script that also
      // holds net.fetch is an exfiltration the fetch consent never covered.
      const fs = await import("../filesystem");
      const path = await fs.getCurrentFilePath();
      return path ? fs.fileNameOf(path) : null;
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
    case "sheet.getCellFormula": {
      const [row, col, options] = args as [number, number, ScriptFormulaOptions | undefined];
      const lib = await getLib();
      const target = await clampSheetIndex(lib, handle, options?.sheetIndex);
      return readCellFormula(lib, target, row, col, options?.style);
    }
    case "sheet.setCellFormula": {
      const [row, col, formula, options] = args as
        [number, number, string | null, ScriptFormulaOptions | undefined];
      const lib = await getLib();
      // clampSheetIndex refuses a restricted script that named ANOTHER sheet
      // before a single character of the formula is drafted anywhere.
      const target = await clampSheetIndex(lib, handle, options?.sheetIndex);
      await writeCellFormula(lib, definition.id, target, row, col, formula, options?.style);
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
    // ---- file.picker: the user picks the file, the host does the I/O ----
    //
    // The broker has already enforced that file.picker was declared (R19) and
    // granted, and vFileExport/vFileImport have already rejected any
    // suggestedName that is a path in disguise. What is left here is the part
    // that makes this safe where VBA's FileSystemObject was not: the ONLY thing
    // that selects a file is a native picker the human drives. There is no
    // argument on either call that can name a location, and none is
    // reconstructed from anything the script sent.
    case "cap.fileExportText": {
      const [suggestedName, content, options] = args as [
        string,
        string,
        { mimeType?: string; encoding?: PickerTextEncoding; description?: string } | undefined,
      ];
      const fs = await import("../filesystem");
      const extension = fileExtensionOf(suggestedName);
      return fs.exportTextViaPicker({
        suggestedName,
        content,
        title: `${definition.name} — save a file`,
        filterName: filterLabelFor(options?.description, options?.mimeType, extension),
        filterExtensions: extension ? [extension] : [],
        encoding: options?.encoding,
      });
    }
    case "cap.fileImportText": {
      const [options] = args as [{ extensions?: string[]; description?: string } | undefined];
      const fs = await import("../filesystem");
      const extensions = (options?.extensions ?? []).map((e) => e.toLowerCase());
      // Cancellation resolves null (never hangs, never rejects); an oversize
      // file rejects rather than truncating.
      return fs.importTextViaPicker({
        title: `${definition.name} — open a file`,
        filterName: filterLabelFor(options?.description, undefined, extensions[0]),
        filterExtensions: extensions,
        maxChars: MAX_FILE_TEXT_CHARS,
      });
    }
    // PRINTING (G4). The script names a FILE and nothing else — it supplies no
    // bytes, so this cannot become "write whatever I like wherever the user can
    // be persuaded to click". The document is rendered by TRUSTED code through
    // the feature-neutral @api/printService seam, from the workbook's own page
    // setup, print area, print titles, page breaks and headers/footers: the same
    // generatePdf(getPrintData()) the File menu runs. Then the same picker
    // cap.fileExportText uses, driven by the same human.
    case "cap.filePrintPdf": {
      const [suggestedName] = args as [string?];
      const printService = await import("../printService");
      // Rendered BEFORE the picker opens on purpose: if no print provider is
      // registered (the Print extension is disabled) the script gets a clear
      // refusal instead of a file dialog that ends in an empty file.
      const bytes = await printService.renderWorkbookPdf();
      const fs = await import("../filesystem");
      return fs.exportBinaryViaPicker({
        suggestedName: suggestedName ?? (await defaultPdfName(fs)),
        bytes,
        title: `${definition.name} — save a PDF`,
        filterName: "PDF file",
        filterExtensions: ["pdf"],
      });
    }
    // ---- ui.shortcut: one combination, bound to one exposed method ----
    //
    // WHAT THIS EXECUTOR DELIBERATELY DOES NOT DO: install a key listener.
    // There is exactly one keydown listener in the app (keybindings.ts), and it
    // stays the only one — a second listener would be a second policy, and a
    // second policy is how a script ends up seeing keys nobody granted it. All
    // this does is ask the registry for one combination and hand it a runner.
    //
    // THE RUNNER IS THE WHOLE TRUST BOUNDARY, so read it closely:
    //   - it re-checks that THIS mount is still the live one (a remount gets a
    //     fresh MountedWorker; a stale closure must not reach into it),
    //   - it re-checks that the script still EXPOSES the named method AND that
    //     the exposure is still owned by this script — hostCallExposed keys on
    //     (objectType, instanceId, name), so without the owner check a second
    //     script on the same object could inherit a shortcut it never asked
    //     for,
    //   - it passes `{ combo }` and nothing else. Not the DOM event, not the
    //     key, not the target, not a repeat flag. A script learns that ITS
    //     shortcut fired, never what the user typed.
    // Invocation goes through callExposedMethod — the same door a scheduled job
    // and a cross-script call use. There is no second way into a script realm.
    case "cap.shortcutBind": {
      const [combo, handler, options] = args as [string, string, { label?: string } | undefined];
      const kb = await import("../keybindings");
      const scriptId = definition.id;
      const objectType = definition.objectType;
      const boundInstanceId = definition.instanceId;
      const handlerName = handler.trim();
      const result = kb.registerScriptKeybinding({
        scriptId,
        scriptName: definition.name,
        combo,
        handler: handlerName,
        label: options?.label,
        run: (firedCombo: string) => {
          if (mounted.get(scriptId) !== mw) return;
          const exposed = listExposed().find(
            (m) =>
              m.ownerScriptId === scriptId &&
              m.objectType === objectType &&
              m.instanceId === boundInstanceId &&
              m.methodName === handlerName,
          );
          if (!exposed) {
            console.warn(
              `[Keybindings] ${firedCombo}: "${definition.name}" no longer exposes ${handlerName}()`,
            );
            return;
          }
          void Promise.resolve(
            hostCallExposed(objectType, boundInstanceId, handlerName, [{ combo: firedCombo }]),
          ).catch((err) => {
            console.error(`[Keybindings] ${firedCombo} -> ${handlerName}() failed:`, err);
          });
        },
      });
      if (!result.ok) {
        // A refusal is LOUD and reaches the author verbatim: a shortcut that
        // silently did not take is the failure mode this whole design exists to
        // avoid. PermissionDenied for a policy refusal (reserved / already
        // taken / too many), ValidationError only for a malformed request.
        throw new BrokerError(
          result.code === "invalid" ? "ValidationError" : "PermissionDenied",
          result.reason,
        );
      }
      // Bound for as long as this mount lives, and not one keystroke longer.
      // (hostUnmountScript ALSO sweeps by scriptId, so a shortcut cannot
      // survive on a cleanup list that failed to run.)
      mw.cleanupFns.push(() => kb.revokeScriptKeybinding(result.binding.id));
      return { ...result.binding };
    }
    case "cap.shortcutUnbind": {
      const [combo] = args as [string];
      const { revokeScriptKeybindingCombo } = await import("../keybindings");
      return revokeScriptKeybindingCombo(definition.id, combo);
    }
    case "cap.shortcutList": {
      const { listScriptKeybindings } = await import("../keybindings");
      return listScriptKeybindings(definition.id);
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

// ============================================================================
// Explicit formula read/write, with a reference style (G4)
// ============================================================================
// `getCellData().formula` could already answer "what formula is in this cell",
// but only in A1, and there was NO way to author one except by passing a value
// string to setCellValue. These two helpers make both directions explicit and
// add the R1C1 spelling — VBA's `Range.FormulaR1C1`.
//
// THE STYLE IS THE CALLER'S CLAIM, NEVER THE USER'S SETTING. A script that says
// "R1C1" means it; the View ▸ R1C1 toggle a user flipped an hour ago must not
// silently change what a script's string means. So the conversion base is the
// TARGET CELL's own coordinates and the style comes from the argument, never
// from get_reference_style.
//
// KNOWN EDGE (inherited, documented rather than hidden): the A1<->R1C1 converter
// in app/src-tauri/src/r1c1.rs is regex-based over the formula text. It skips
// string literals and refuses matches adjacent to identifier characters, but a
// DEFINED NAME that looks like a reference (a name literally called `RC` or
// `R1C1`) would be rewritten. Formulas that use only cell references, ranges and
// functions — which is what this API exists for — convert exactly.

export interface ScriptFormulaOptions {
  style?: "A1" | "R1C1";
  sheetIndex?: number;
}

// The four G4 helpers below are EXPORTED for the same reason executeWorkbookSave
// is: what makes them safe (the R1C1 base cell, the writeback draft gate, the
// per-cell reference shift, the refusal to paste an empty buffer) is otherwise
// only reachable through a live worker realm, which jsdom cannot spawn. They
// take their `lib` as a parameter precisely so a test can drive them.

/**
 * The formula in one cell, in the requested notation. `null` when the cell
 * holds a plain value, is empty, or has its formula hidden by sheet protection
 * (the typed read already withholds it there — this must not reveal what
 * `getCellData` refuses to).
 */
export async function readCellFormula(
  lib: Awaited<ReturnType<typeof getLib>>,
  sheetIndex: number | undefined,
  row: number,
  col: number,
  style: "A1" | "R1C1" | undefined,
): Promise<string | null> {
  const cell = await readTypedCell(lib, sheetIndex, row, col);
  const formula = cell.formula;
  if (!formula) return null;
  if (style !== "R1C1") return formula;
  const grid = await import("../grid");
  return grid.convertFormulaStyle(formula, "A1", "R1C1", row, col);
}

/**
 * Put a formula into one cell.
 *
 * `null` CLEARS it (the honest spelling of "this cell should no longer compute
 * anything"). A string is always written as a FORMULA — the leading `=` is
 * added when the caller omitted it — because a method called setCellFormula
 * that quietly stored text when you forgot one character is a trap; text goes
 * through setCellValue, which is what it is for.
 *
 * Everything that makes an ordinary script write safe applies unchanged: the
 * write is attributed (so the script's own range-behaviour handlers do not
 * re-fire for it) and a .calp writeback cell is drafted through the same
 * authoritative gate a human keystroke takes, or the whole call throws.
 */
export async function writeCellFormula(
  lib: Awaited<ReturnType<typeof getLib>>,
  scriptId: string,
  sheetIndex: number | undefined,
  row: number,
  col: number,
  formula: string | null,
  style: "A1" | "R1C1" | undefined,
): Promise<void> {
  const active = await lib.getActiveSheet();
  const target = sheetIndex ?? (await activeSheetForWriteGuard(lib));
  let value = "";
  if (formula !== null) {
    const trimmed = formula.trim();
    if (trimmed.length > 0) {
      const withEquals = trimmed.startsWith("=") ? trimmed : `=${trimmed}`;
      value =
        style === "R1C1"
          ? await (await import("../grid")).convertFormulaStyle(withEquals, "R1C1", "A1", row, col)
          : withEquals;
    }
  }
  recordScriptWrite(scriptId, target, row, col);
  await writeCellsOnSheet(lib, scriptId, target, active, [{ row, col, value }]);
}

// ============================================================================
// Range copy / paste / paste special (G4)
// ============================================================================
//
// THE ONE DECISION THAT MATTERS, stated where the code is: there is NO method
// here that reads the operating system's clipboard, and none that writes it.
//
//   Reading it is ambient authority. What a person last copied is arbitrary —
//   a password out of a password manager, a bank number, a sentence from a chat
//   window — and it has nothing to do with this workbook. There is no way to
//   scope it (a script cannot ask for "only the spreadsheet-shaped clipboards"),
//   no way to write an honest consent line for it, and no way for a user to
//   audit what was taken after the fact. So it is refused outright rather than
//   sold as a capability.
//
//   Writing it is the other half of the same problem: it silently destroys what
//   the user had in hand, and it is a channel out of Calcula into every other
//   application on the machine — an exfiltration route that no consent given for
//   "this script may read your cells" ever covered.
//
// What a script gets instead is a buffer of ITS OWN: per script, host-side,
// never persisted, discarded when the script unmounts. Copy fills it from a
// range the script names; paste writes it into a place the script names. That
// is the whole of VBA's `Range.Copy` / `PasteSpecial` idiom, minus the ambient
// part nobody needed.

/** One captured cell. `styleIndex` is the workbook-local style-registry index,
 *  which is why a paste can only target the same workbook — and it always does,
 *  because the buffer never leaves this process. */
interface ClipboardCell {
  value: number | string | boolean | null;
  display: string;
  formula: string | null;
  type: string;
  styleIndex: number;
}

interface ScriptClipboard {
  /** Where it was copied FROM — the base for relative-reference shifting. */
  startRow: number;
  startCol: number;
  rows: number;
  cols: number;
  /** Dense rows x cols; a null entry is a cell that did not exist. */
  cells: (ClipboardCell | null)[][];
}

// ============================================================================
// Column filtering / AutoFilter (G4)
// ============================================================================
//
// One executor behind six broker rows, because all six are the SAME act aimed
// at the same object: the filter on the active sheet. Extracted from the switch
// so the argument order — the whole failure surface here, since every AutoFilter
// argument is a bare integer — is pinned by a test rather than by reading.
//
// THE ROUTING IS THE POINT. Every call goes through @api/autoFilterService, the
// seam the AutoFilter extension registers, and NEVER through the backend
// commands directly. The extension caches the filter's range, and a chevron
// click sends a column index relative to that cache; filtering behind it leaves
// the next click aimed at a different column, with the grid still showing rows
// the backend believes are hidden.
//
// AND THE ABSENCE IS THE POINT TOO. Nothing here reads, writes or infers
// `Table.autoFilterId`. That link is DERIVED state recomputed by Rust
// (relink_autofilter_owner) inside the very commands the controller reaches,
// after releasing the auto_filters guard, because the canonical lock order is
// tables -> auto_filters. There is no correct way to maintain it from the
// frontend and no reason to try.

/** Exported for tests: the AutoFilter executor, driven with a fake controller
 *  (a live worker realm is not available under jsdom). */
export async function executeAutoFilter(method: string, args: unknown[]): Promise<unknown> {
  const svc = await import("../autoFilterService");
  // Throws a plain Error when the AutoFilter extension is not loaded; the
  // broker turns that into a HostError the script can see, which is the honest
  // outcome — the alternative is filtering somewhere the user cannot look.
  const filter = svc.requireAutoFilterController();
  switch (method) {
    case "api.autoFilterGet":
      return filter.get();
    case "api.autoFilterListValues": {
      const [columnIndex] = args as [number];
      return filter.listValues(columnIndex);
    }
    case "api.autoFilterApply": {
      const [startRow, startCol, endRow, endCol] = args as [number, number, number, number];
      return filter.apply(startRow, startCol, endRow, endCol);
    }
    case "api.autoFilterSetColumn": {
      // vAutoFilterCriteria has already proved the discriminated shape, so the
      // cast lands on a validated payload.
      const [columnIndex, criteria] = args as [number, AutoFilterColumnCriteria];
      return filter.setColumn(columnIndex, criteria);
    }
    case "api.autoFilterClear": {
      const [columnIndex] = args as [number | null | undefined];
      return filter.clear(columnIndex ?? null);
    }
    case "api.autoFilterRemove":
      await filter.remove();
      return undefined;
    default:
      throw new BrokerError("UnknownMethod", `Unknown AutoFilter method: ${method}`);
  }
}

/** scriptId -> that script's private clipboard. Never shared, never persisted. */
const scriptClipboards = new Map<string, ScriptClipboard>();

/** What copy/paste answer with, so a script can size its own layout. */
export interface ScriptClipboardSize {
  rows: number;
  cols: number;
}

/** Forget one script's clipboard (unmount) or all of them (workbook reset). */
export function clearScriptClipboard(scriptId?: string): void {
  if (scriptId === undefined) scriptClipboards.clear();
  else scriptClipboards.delete(scriptId);
}

/** Test/inspection hook: the size of a script's buffer, or null if empty. */
export function scriptClipboardSize(scriptId: string): ScriptClipboardSize | null {
  const clip = scriptClipboards.get(scriptId);
  return clip ? { rows: clip.rows, cols: clip.cols } : null;
}

/**
 * Capture a rectangle into the calling script's private clipboard.
 *
 * ACTIVE SHEET ONLY, and refused (never silently redirected) otherwise: the
 * typed read is sheet-aware but `get_viewport_cells` — the only bulk source of
 * STYLE INDEXES — is not, and a copy that silently dropped every cell's
 * formatting on another sheet would be a paste that looks like it worked. Same
 * rule, same message, as sortRange / mergeCells / replaceAll.
 */
export async function copyRangeToScriptClipboard(
  lib: Awaited<ReturnType<typeof getLib>>,
  scriptId: string,
  sheetIndex: number | undefined,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): Promise<ScriptClipboardSize> {
  assertRangeSize(startRow, startCol, endRow, endCol);
  await assertActiveSheet(lib, sheetIndex, "copyRange");
  const rows = endRow - startRow + 1;
  const cols = endCol - startCol + 1;
  // Two reads, one rectangle: the typed one carries value/type/formula, the
  // viewport one carries styleIndex. Neither shape alone can express a paste.
  const [typed, styled] = await Promise.all([
    lib.getRangeCellsTyped(startRow, startCol, endRow, endCol),
    lib.getViewportCells(startRow, startCol, endRow, endCol),
  ]);
  const styleAt = new Map<string, number>();
  for (const c of styled) styleAt.set(`${c.row},${c.col}`, c.styleIndex ?? 0);

  const cells: (ClipboardCell | null)[][] = [];
  for (let r = 0; r < rows; r++) cells.push(new Array<ClipboardCell | null>(cols).fill(null));
  for (const c of typed) {
    const r = c.row - startRow;
    const k = c.col - startCol;
    if (r < 0 || r >= rows || k < 0 || k >= cols) continue;
    cells[r][k] = {
      value: c.value,
      display: c.display,
      formula: c.formula ?? null,
      type: c.type,
      styleIndex: styleAt.get(`${c.row},${c.col}`) ?? 0,
    };
  }
  // A style-only cell has no typed entry (the backend keeps the payload sparse)
  // but still carries formatting worth pasting.
  for (const c of styled) {
    const r = c.row - startRow;
    const k = c.col - startCol;
    if (r < 0 || r >= rows || k < 0 || k >= cols) continue;
    if (cells[r][k] === null && (c.styleIndex ?? 0) !== 0) {
      cells[r][k] = { value: null, display: "", formula: null, type: "empty", styleIndex: c.styleIndex ?? 0 };
    }
  }
  scriptClipboards.set(scriptId, { startRow, startCol, rows, cols, cells });
  return { rows, cols };
}

export interface ScriptPasteOptions {
  mode?: "all" | "values" | "formulas";
  transpose?: boolean;
  skipBlanks?: boolean;
  sheetIndex?: number;
}

/**
 * The string that reproduces a captured cell's VALUE (not its formula).
 *
 * Numbers and booleans are written INVARIANT — "1234.5", "TRUE" — so a paste on
 * a sv-SE workbook does not turn 1234.5 into text because the decimal separator
 * disagreed. `display` is deliberately not used: it is formatted ("1 234,50 kr")
 * and writing it back would store text where a number was.
 */
function clipboardValueString(cell: ClipboardCell): { value: string; invariant: boolean } {
  switch (cell.type) {
    case "number":
      return { value: typeof cell.value === "number" ? String(cell.value) : cell.display, invariant: true };
    case "boolean":
      return { value: cell.value ? "TRUE" : "FALSE", invariant: true };
    case "empty":
      return { value: "", invariant: false };
    // "error" carries its Excel literal ("#DIV/0!") and "text" its own text.
    default:
      return { value: typeof cell.value === "string" ? cell.value : cell.display, invariant: false };
  }
}

/**
 * Write the calling script's clipboard into the grid at (row, col).
 *
 * ACTIVE SHEET ONLY, for the same reason copy is: `update_cells_batch` is the
 * only write that carries a style index, and it has no sheet parameter.
 *
 * Relative references are shifted PER CELL (source position -> destination
 * position), which is also what makes `transpose` correct: a transposed paste
 * gives each formula its own row/column delta rather than one delta for the
 * block. Mode "values" writes no formulas at all and mode "formulas" carries no
 * styles, which is the PasteSpecial vocabulary a macro author expects.
 */
export async function pasteScriptClipboard(
  lib: Awaited<ReturnType<typeof getLib>>,
  scriptId: string,
  row: number,
  col: number,
  options: ScriptPasteOptions,
): Promise<ScriptClipboardSize> {
  const clip = scriptClipboards.get(scriptId);
  if (!clip) {
    throw new BrokerError(
      "HostError",
      "nothing to paste: call copyRange(...) first (each script has its own clipboard, and it is empty when the script starts)",
    );
  }
  const active = await assertActiveSheet(lib, options.sheetIndex, "pasteRange");
  const mode = options.mode ?? "all";
  const transpose = options.transpose === true;
  const destRows = transpose ? clip.cols : clip.rows;
  const destCols = transpose ? clip.rows : clip.cols;
  assertRangeSize(row, col, row + destRows - 1, col + destCols - 1);

  // Pass 1: decide every destination cell, and collect the formulas that need
  // shifting (one batched round trip, never one call per formula).
  interface Pending {
    row: number;
    col: number;
    value: string;
    invariant: boolean;
    styleIndex?: number;
    shiftIndex?: number;
  }
  const pending: Pending[] = [];
  const shifts: Array<{ formula: string; rowDelta: number; colDelta: number }> = [];
  for (let r = 0; r < clip.rows; r++) {
    for (let c = 0; c < clip.cols; c++) {
      const cell = clip.cells[r][c];
      if (cell === null && options.skipBlanks === true) continue;
      const destRow = row + (transpose ? c : r);
      const destCol = col + (transpose ? r : c);
      if (cell === null) {
        // A blank source cell CLEARS its destination — that is what a paste of a
        // rectangle means. `skipBlanks` above is how a caller says otherwise.
        pending.push({ row: destRow, col: destCol, value: "", invariant: false });
        continue;
      }
      const entry: Pending = { row: destRow, col: destCol, value: "", invariant: false };
      if (mode !== "values" && cell.formula) {
        const rowDelta = destRow - (clip.startRow + r);
        const colDelta = destCol - (clip.startCol + c);
        if (rowDelta === 0 && colDelta === 0) {
          entry.value = cell.formula;
        } else {
          entry.shiftIndex = shifts.length;
          shifts.push({ formula: cell.formula, rowDelta, colDelta });
        }
      } else {
        const v = clipboardValueString(cell);
        entry.value = v.value;
        entry.invariant = v.invariant;
      }
      if (mode === "all") entry.styleIndex = cell.styleIndex;
      pending.push(entry);
    }
  }
  if (shifts.length > 0) {
    const shifted = await lib.shiftFormulasBatch(shifts);
    for (const p of pending) {
      if (p.shiftIndex !== undefined) p.value = shifted[p.shiftIndex];
    }
  }
  if (pending.length === 0) return { rows: destRows, cols: destCols };

  // Pass 2: the write, on exactly the same terms as any other script write —
  // attributed (no self-echo into the script's own onChange), and every cell
  // claimed by a .calp writeback region drafted through the authoritative gate
  // instead of being written behind the publisher's schema.
  for (const p of pending) recordScriptWrite(scriptId, active, p.row, p.col);
  const { plain, drafted } = await captureWritebackWrites(
    scriptId,
    pending.map((p) => ({ sheetIndex: active, row: p.row, col: p.col, value: p.value })),
  );
  const byCoord = new Map(pending.map((p) => [`${p.row},${p.col}`, p]));
  const updates = plain.map((w) => {
    const p = byCoord.get(`${w.row},${w.col}`);
    const update: { row: number; col: number; value: string; styleIndex?: number; invariant?: boolean } = {
      row: w.row,
      col: w.col,
      value: w.value,
    };
    if (p?.styleIndex !== undefined) update.styleIndex = p.styleIndex;
    if (p?.invariant) update.invariant = true;
    return update;
  });
  await withScriptUndoBatch(lib, `Paste ${pending.length} cells`, async () => {
    if (updates.length > 0) {
      const changed = await lib.updateCellsBatch(updates);
      await afterCellDataChange(changed);
    }
    // update_cells_batch DROPS writeback cells, so a drafted one is written on
    // its own or the grid would show nothing at all (same rule as
    // api.updateCellsBatch).
    for (const w of drafted) {
      await lib.updateCell(w.row, w.col, w.value);
    }
  });
  return { rows: destRows, cols: destCols };
}

/** The picker's pre-filled name for a script-requested PDF: this workbook's own
 *  file name with a .pdf extension, or a neutral default when it has never been
 *  saved. The FULL PATH is never used or returned — only the last segment, which
 *  is exactly what api.workbookFileName already gives a script. */
async function defaultPdfName(fs: typeof import("../filesystem")): Promise<string> {
  try {
    const path = await fs.getCurrentFilePath();
    if (path) {
      const name = fs.fileNameOf(path);
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      if (stem.length > 0) return `${stem}.pdf`;
    }
  } catch {
    // A workbook with no file is the normal case, not an error.
  }
  return "workbook.pdf";
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
  if (isScriptDebugPaused(scriptId)) {
    // The script is suspended at a breakpoint. Waiting out the 1.5s deadline
    // would only add latency to the user's Enter key before allowing anyway.
    return null;
  }
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
  if (isScriptDebugPaused(scriptId)) {
    // DEBUGGING MUST NEVER MAKE A WORKBOOK UNSAVEABLE. A script stopped at a
    // breakpoint cannot deliver a verdict, and the default-allow policy already
    // says a verdict that does not arrive is not a veto — so skip the 3s wait
    // and let the save/close through immediately.
    console.warn(
      `[ScriptHost] "${mw.definition.name}" is paused in the debugger — its ` +
        `onBefore${action === "save" ? "Save" : "Close"} verdict is skipped (allowing the ${action}).`,
    );
    return null;
  }
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
      // While a verdict is being collected, a script-initiated save is refused
      // (assertScriptSaveAllowed reads this depth). Without it, an onBeforeSave
      // handler that calls api.workbook.save() re-enters checkLifecycleGuards
      // and recurses; with it, that call rejects with a message naming the
      // reason, the handler's throw is treated as "no objection" like any other,
      // and the user's original save proceeds.
      return withLifecycleVerdictDepth(async () => {
        const verdict = await callWorkbookBeforeLifecycle(scriptId, action, detail);
        if (!verdict?.cancel) return null;
        return { by: mw.definition.name, reason: verdict.reason };
      });
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
  // payload carries capability-gated metadata (BI model events, and the
  // writeback-submission notification — see thinAppEventForScripts).
  const unsub = onAppEvent(eventName, (detail) =>
    forwardEvent(mw, hook, thinAppEventForScripts(eventName, detail)),
  );
  // WRITEBACK_SUBMISSION_RECEIVED is the one app event that does not fire on
  // its own: it is raised by the demand-driven publisher-inbox poll, which runs
  // only while somebody holds a watch. Subscribing IS the demand, so acquire
  // one here and release it with the forwarder — a script that stops listening
  // (or is unmounted, or faults) must not leave a timer polling a registry on
  // its behalf. Acquisition is async only because the module is lazily
  // imported; the release closes over the promise so an unmount that lands
  // first still releases.
  if (eventName === AppEvents.WRITEBACK_SUBMISSION_RECEIVED) {
    const releasing = import("../distribution")
      .then((mod) => mod.acquireSubmissionWatch())
      .catch(() => null);
    addForwarder(mw, hook, () => {
      unsub();
      void releasing.then((release) => release?.());
    });
    return;
  }
  addForwarder(mw, hook, unsub);
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
