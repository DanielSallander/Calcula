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
  buildPreviewHandle,
  callExposed,
  hostCallExposed,
  listExposed,
  HOST_ONLY_EXPOSED_PREFIX,
  registerExposed,
  unregisterExposed,
  registerMountedHandle,
  scriptEmitEventName,
  scriptSubscribeEventName,
  sameTrustOrigin,
  type ScriptHandle,
} from "./broker";
import { assertMountAllowed } from "./mountGate";
import { drainBrokerTraffic, synthesizableHookPayload, withTimeout } from "./scriptPreview/runShape";
import type { PreviewBackend } from "./scriptPreview/backend";
import {
  PROTOCOL_VERSION,
  RENDER_TIMEOUT_MS,
  METHOD_CALL_TIMEOUT_MS,
  RUN_TARGET_EXPOSED_PREFIX,
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
  type RpcErrorShape,
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
import { ALLOWLIST, thinAppEventForScripts, thinWorkbookPathDetail } from "./allowlist";
// Host-side audit appends. Nearly every entry comes from the broker, which
// audits the calls it relays; the exception is the WITH-UNPROTECTED restore
// fired from hostUnmountScript / hostResetAll, which no worker asked for and
// which must still be visible — a re-protection nobody can see would undo the
// only reason this design was chosen over VBA's UserInterfaceOnly flag.
import { appendAudit } from "./auditRing";
import type { CapabilityId } from "./capabilityIds";
import { MAX_RANGE_CELLS, MAX_FILE_TEXT_CHARS, checkCellWriteValue } from "./validators";
import type { PickerTextEncoding } from "../filesystem";
import type { ControlValue } from "../controlValues";
import type { AutoFilterColumnCriteria } from "../autoFilterService";
import type { ScriptCell } from "../scriptableObjects";
import type {
  TypedCellData,
  DataValidation,
  DataValidationRule,
  DataValidationOperator,
  DataValidationAlertStyle,
  ListSource,
  Hyperlink,
  AddHyperlinkParams,
} from "../lib";
// columnToLetter: the A1 spelling delivered on onDataChange change entries.
// (The worker-side canonicalModel keeps a private twin, colToLetters; this is
// the one exported, unit-tested implementation.)
import { columnToLetter, type CellData, type FormattingOptions } from "../types";
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
import {
  closeScriptForm,
  defineScriptForm,
  getScriptFormSpec,
  refreshScriptFormSeeds,
  resetScriptForms,
  revokeScriptForms,
  showScriptForm,
  updateScriptForm,
  type FormSessionDeps,
  type FormSubmitDecision,
} from "./scriptForms";
import {
  MAX_FORM_ERROR_CHARS,
  formOriginForMount,
  isValidFormName,
  type FormPatch,
  type FormSeed,
  type FormSpec,
  type FormValue,
} from "./scriptFormSpec";
import {
  isLocalOrigin,
  mountProvenanceForOrigin,
  scriptOriginForMount,
  scriptOriginForStoredRecord,
} from "./scriptOrigin";
import {
  cellWriteFor,
  collectFormBindings,
  collectFormSources,
  dirtyNames,
  optionsFromCells,
  parseFormBinding,
  parseFormRange,
  rowsFromCells,
  seedFromCell,
  seedFromControlValue,
  sheetIdentityRefusal,
  type FormBindingDecl,
} from "./scriptFormBindings";
import type {
  ScriptDialogFormSpec,
  ScriptDialogPromptOptions,
  ScriptDialogTextOptions,
} from "./scriptDialogSpec";
import { AppEvents, emitAppEvent, onAppEvent, type ApplicationUpdatedPayload } from "../events";
import type { PullResponse } from "../distribution";
import {
  registerLifecycleGuard,
  type LifecycleAction,
  type LifecycleDetail,
  type LifecycleGuardResult,
} from "../../core/lib/lifecycleGuards";
// The two click choke points Core already consults (Wave 4): double-click asks
// before entering edit mode, right-click before requesting the context menu.
// The script host registers one interceptor per declared onBefore*Click hook.
import { registerCellDoubleClickInterceptor } from "../../core/lib/cellDoubleClickInterceptors";
import { registerCellContextMenuInterceptor } from "../../core/lib/cellContextMenuInterceptors";
import {
  rectRowsCols,
  tableCellCoord,
  tableDataRowCount,
  tableHeaderOffset,
  tableHeaders,
  tableContains,
  namedRangeCells,
  namedRangeContains,
  type TableLike,
  type NamedRangeCoordsLike,
} from "./objectCoords";
import { showToast } from "../notifications";
// The fill-handle's own machinery (drag parity for api.fillRange): SHARED with
// core/hooks/useFillHandle so a script fill and a drag fill cannot diverge.
import {
  detectPattern,
  processPendingFills,
  replicateMergeRegions,
  type PatternResult,
  type PendingFill,
} from "../../core/lib/fillEngine";
import { revokeScriptKeybindingsForScript } from "../keybindings";
// A1 parsing for the Wave-4 `range` option: the SAME pure, dependency-free
// parser the worker realm uses, so both realms read "B2:D10" identically.
import {
  parseA1Body as parseA1BodyHost,
  splitSheetPrefix as splitSheetPrefixHost,
} from "./worker/canonicalModel";
import { getCellBehaviorById } from "../cellBehaviors";
import { getSlicerStoreService, getTimelineStoreService, getChartStoreService, getPivotStoreService, getPaneControlStoreService } from "../componentStoreRegistry";
import { getControlsProvider } from "../controlsService";
import type { ChartPlacement } from "../componentStoreRegistry";
import {
  chartToRef,
  floatingRangeToRef,
  namedRangeToRef,
  pivotToRef,
  shapeToRef,
  controlSheetFromInstanceId,
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
import type {
  ConditionalFormat,
  ConditionalFormatRange,
  ConditionalFormatRule,
  SheetProtectionOptions,
  Table as BackendTable,
  TotalsRowFunction as BackendTotalsRowFunction,
} from "../backend";
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

/**
 * The refusal a RESTRICTED script gets for naming a sheet other than the one on
 * screen. ONE exported constant, because it is a user-facing statement of what
 * the tier clamps to and it has to agree with the `sheet.*` ALLOWLIST desc rows
 * — which a test pins.
 *
 * It says "the sheet you are looking at" and NOT "its own sheet", because there
 * is no such thing to point at. `sheet` is a PRIMITIVE object type: one script
 * per workbook, `instanceId` always null, and its own scaffold opens with
 * "Sheet Script (applies to ALL sheets)". Every other object type reaches the
 * same `sheet.*` family. So the clamp the host implements — an omitted
 * sheetIndex resolving to the active sheet, a named other sheet refused — is
 * the ACTIVE sheet, and that is the only clamp it could implement.
 */
export const RESTRICTED_SHEET_CLAMP_MESSAGE =
  "Restricted scripts can only reach the sheet you are looking at; " +
  "naming another sheet requires unlocked access";

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
  /**
   * The ARTIFACT this mount is, when the workbook's consent record names one.
   *
   * `source` here is the exact source the user APPROVED — never `definition.source`,
   * which is the composed realm source (a host-generated import prelude, then the
   * body) and hashes to something no consent record has ever seen. Supplying it
   * tightens the mount gate from "this application is approved" to "this artifact
   * is covered by that approval, at this hash".
   *
   * Only a mount that can name its artifact honestly sets this. A composed realm
   * — a UDF library, a shared-library realm, a chart mark/transform library —
   * mounts code merged from many artifacts under a synthetic consent identity its
   * own surface computes; re-deriving that identity here would be a second copy of
   * the decision, which is precisely how the run routes came to differ. Those get
   * the application-level floor, and their surface keeps its artifact check.
   */
  consentArtifact?: { id: string; source: string };
  apiVersion: string;
  /**
   * Why this mount is happening. `"open"` marks the workbook-open mount path
   * (startup load and the AFTER_OPEN reload) — scripts are mounted FROM the
   * AFTER_OPEN handler, so their live `workbook.onOpen` subscription is wired
   * only after the open it exists to observe was broadcast, and the host
   * REPLAYS that one delivery at mount. Absent for every other mount (Save &
   * Apply, consent, template stamping, crash respawn): no replay. The flag is
   * CONSUMED by the first mount that sees it, never inferred heuristically.
   */
  mountCause?: "open";
}

interface MountedWorker {
  worker: Worker;
  /**
   * The realm has been terminated: nothing may be relayed into it any more.
   *
   * Set by `hostUnmountScript` the moment it calls `worker.terminate()`, and
   * NOT derived from the `mounted` map — that map is cleared at the END of the
   * unmount, long after the sweeps that close this script's forms and dialogs
   * run, so a "is it still mounted?" check reads TRUE while the realm is
   * already dead.
   */
  terminated?: boolean;
  handle: ScriptHandle;
  definition: HostMountDefinition;
  /**
   * The proof this mount's definition passed Script Security and distributed
   * consent. Kept so a REMOUNT of the same code (crash respawn, a debug session
   * opening or closing) can re-present it instead of re-gating — and so it can
   * never be re-presented for anything else (see `assertAdmissionCovers`).
   */
  admission: MountAdmission;
  cleanupFns: CleanupFn[];
  /** Wired app-event forwarders, keyed by hook. */
  forwarders: Map<string, CleanupFn>;
  /** Pending render-cell batches. */
  pendingRenderCells: Map<number, { resolve: (styles: (StyleOverride | null)[] | null) => void; timer: number }>;
  /** Pending bitmap draws, keyed by reqId. */
  pendingRenderDraws: Map<number, { key: string; timer: number; w: number; h: number }>;
  /** In-flight bitmap request keys (single-flight per key). */
  drawsInFlight: Set<string>;
  /**
   * Pending relayed methodCalls. `timer` is null while the deadline is
   * SUSPENDED, which happens for exactly one reason: the realm is paused in the
   * debugger (see suspendMethodCallDeadlines).
   */
  pendingMethodCalls: Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: number | null;
      /** (Re-)arm the deadline from now. */
      arm: () => void;
    }
  >;
  nextReqId: number;
  /** Coalesced event queue, flushed per animation frame. */
  coalesced: Map<string, unknown>;
  coalesceScheduled: boolean;
  /**
   * True while this open-mount still owes its script the `workbook.onOpen`
   * replay (see HostMountDefinition.mountCause). Cleared the moment the hook
   * is wired, so a hook re-declared later in the same mount cannot replay twice.
   */
  openReplayPending: boolean;
  /** Crash bookkeeping (one free respawn; second crash within 30s faults). */
  lastCrashAt: number;
  respawned: boolean;
  /** Shape property cache for setState oldValue + mirror pushes. */
  shapeProps: Map<string, string>;
  /** Render hooks the worker declared (onRender/canvasRenderer/itemRenderer). */
  declaredRenderHooks: Set<string>;
  /**
   * EVERY hook the worker declared, in registration order.
   *
   * `forwarders` is not the same thing: `event:` subscriptions and the render
   * hooks deliberately register no forwarder, so a set built from it would not
   * be the honest answer to "what is this script waiting for" — which is
   * precisely the question a debug session has to answer.
   */
  declaredHooks: string[];
  /**
   * Host-side copy of the seeded snapshot properties + subsequent mirror pushes,
   * used by event forwarders to filter by object bounds (table/namedRange range
   * membership) without an IPC refetch per change event.
   */
  hostMirror: Map<string, unknown>;
  /**
   * Open FORM sessions this worker is waiting on (its own, or one it opened
   * on another script's behalf). While > 0 the relayed method-call deadlines
   * stay suspended: a `run()` or a button handler awaiting `form.show()` is
   * carried by that relay, and its 30 s timer would otherwise abandon the
   * call while the user was still typing into the form.
   */
  formHolds: number;
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
 *
 * BOTH SPELLINGS ARE ACCEPTED, and that is not politeness — it is the fix for a
 * bug this asymmetry actually caused. Forwarders are keyed by the BARE hook
 * name the worker registers and the host echoes back on every event
 * ("onClick"); the objectType prefix exists only so `wireHookForwarder` can
 * switch on `${objectType}.${hook}`. A caller who reads that switch — the
 * obvious place to learn the hook names — naturally writes the QUALIFIED form,
 * and used to get a flat `false` for a hook that is wired and firing.
 *
 * That is exactly what happened to the run-mode button-click diagnosis: it
 * asked for "button.onClick", never got it, and so told the user
 * "it never registered a click handler" on every SUCCESSFUL click of a working
 * macro button. A predicate that answers "no" for a live hook does not just
 * fail to help; it accuses working code.
 */
export function mountedScriptHasHook(scriptId: string, hook: string): boolean {
  const mw = mounted.get(scriptId);
  if (!mw) return false;
  if (mw.forwarders.has(hook)) return true;
  const prefix = `${mw.definition.objectType}.`;
  return hook.startsWith(prefix) && mw.forwarders.has(hook.slice(prefix.length));
}

// ============================================================================
// Spawn / terminate
// ============================================================================

/**
 * THE ONLY PLACE A SCRIPT REALM IS CREATED — and there are exactly three call
 * sites, which is a fact `distributedMountConsent.test.ts` pins so a fourth
 * cannot appear unclassified:
 *
 *   1. `mountWorker`        — a MOUNT. Gated: it cannot be called without a
 *                             `MountAdmission` (Script Security + distributed
 *                             consent).
 *   2. `hostValidateScript` — a SYNTAX CHECK. Ungated by design: the source is
 *                             wrapped as blob-ESM and PARSED, never executed,
 *                             the realm gets no mount spec, no tier, no grants
 *                             and no broker handle, and it is terminated on
 *                             every path. There is nothing here for consent to
 *                             protect, and gating it would make the editor
 *                             unable to tell a publisher's macro it has a typo.
 *   3. `hostPreviewScript`  — a DRY RUN over a substituted backend. Ungated by
 *                             design, and the reasoning is in its own header:
 *                             safety is proved by the calls it does NOT make
 *                             (no `assertMountAllowed`, no live handle, no
 *                             grants, no `mounted.set`, no `executeImpl`), so
 *                             no call can reach a Tauri command and nothing is
 *                             registered anywhere. Its handle is a
 *                             `PreviewOrigin`, same-origin with nothing.
 */
function spawnWorker(): Worker {
  return new Worker(new URL("./worker/bootstrap.ts", import.meta.url), { type: "module" });
}

/** Whether the worker realm is available in this environment (jsdom tests lack Worker). */
export function workerRealmAvailable(): boolean {
  return typeof Worker !== "undefined" && typeof window !== "undefined";
}

// ============================================================================
// MOUNT ADMISSION — the gates live at the boundary, not at the callers
// ============================================================================
//
// WHY THIS EXISTS. Creating a realm for code that arrived inside a distributed
// application (`.calp`) requires TWO decisions, and they are not the same one:
//
//   * SCRIPT SECURITY — may this workbook run scripts at all right now?
//     (`assertMountAllowed`, the global setting.)
//   * DISTRIBUTED CONSENT — has the user approved THIS application's code?
//     (`require_distributed_module_consent`, Rust-authoritative.)
//
// The second one was asked at CALLERS. Every review round found another caller
// that had not been taught to ask: the macro library, then macro buttons, then
// the one-off runner, then the Object Script Editor's Run and Debug — which
// mounted a publisher's macro in a REAL worker realm, correctly capped at the
// restricted tier, with no consent anywhere in the path. RESTRICTED IS NOT
// CONSENTED: the tier bounds what the code may REACH; consent is the user
// agreeing to run it AT ALL.
//
// So the requirement moved to the boundary where a realm is created. There is
// exactly one producer of a `MountAdmission` (`admitMount`) and exactly one
// consumer (`mountWorker`, which cannot be called without one). A new mount
// route therefore gets both gates by construction: it either goes through
// `hostMountScript` — which is the only exported way to obtain an admission —
// or it does not compile.
//
// AN ADMISSION IS NOT A BEARER TOKEN. It names the script id, the EXACT source
// and the origin it was granted for, and `mountWorker` re-checks all three. A
// remount (crash respawn, debugger Save & Apply, Stop returning a script to its
// production mount) re-presents the admission the mount already held, which is
// honest — it is the same code, already admitted. Swapping in different source
// under an old admission is refused.

/**
 * The brand. Module-private and never exported, so no value of this type can be
 * constructed outside this file — the point of the shape.
 */
const MOUNT_ADMISSION_BRAND = Symbol("calcula.mountAdmission");

/**
 * Proof that a specific mount passed Script Security AND distributed consent.
 * Deliberately not exported: a caller cannot hold one, only obtain a mount.
 */
interface MountAdmission {
  readonly [MOUNT_ADMISSION_BRAND]: true;
  /** The script id it was granted for. */
  readonly scriptId: string;
  /** The exact source it was granted for. */
  readonly source: string;
  /** `"local"` or `"package:<name>"` — the origin the gates judged. */
  readonly originKey: string;
  /**
   * The artifact identity the consent gate was asked about (`""` when the mount
   * named none). Recorded so an admission is a COMPLETE statement of what was
   * judged rather than three quarters of one — the same reason it carries the
   * source and the origin.
   */
  readonly artifactKey: string;
}

/** The artifact identity a definition presents to the consent gate, flattened. */
function mountArtifactKey(definition: HostMountDefinition): string {
  const artifact = definition.consentArtifact;
  return artifact ? JSON.stringify([artifact.id, artifact.source]) : "";
}

/**
 * The origin a definition mounts under, flattened to a comparable key.
 *
 * `scriptOriginForMount` is the ONE derivation (provenance, never the package
 * name); this only makes its answer storable on an admission so a definition
 * cannot be laundered from `distributed` to `local` between admission and mount.
 */
function mountOriginKey(definition: HostMountDefinition): string {
  const origin = scriptOriginForMount(definition);
  return origin.kind === "package" ? `package:${origin.name}` : "local";
}

/**
 * The sentinel `distributed_module_refusal` prefixes its message with
 * (app/src-tauri/src/scripting/commands.rs). Recognised, never re-decided: it
 * only distinguishes "the gate said no" from "the gate could not be reached",
 * which are two different sentences for the user.
 */
const DISTRIBUTED_SCRIPT_NOT_CONSENTED = "DISTRIBUTED_SCRIPT_NOT_CONSENTED";

/**
 * Put a DISTRIBUTED mount past the workbook's consent record, through the
 * execution-free `check_distributed_mount_consent` command.
 *
 * WHY NOT `check_distributed_module_consent`, WHICH THIS USED TO CALL. That
 * command asks the MODULE-runtime question, and its Rust decision
 * (`distributed_module_refusal`) resolves ownership by EXACT SOURCE EQUALITY
 * against stored module records — with an explicit "not a stored module at all,
 * allow" early return. Five of the six mount routes COMPOSE their realm source
 * (chart marks, chart transforms, the UDF library, a shared-library realm, and
 * an object script mounted behind its import prelude), so they matched no stored
 * record and the gate answered ALLOW every single time. The provenance was
 * right; the question was not.
 *
 * `check_distributed_mount_consent` asks BOTH: the module question exactly as
 * `run_script` applies it (so a stored module a `.calp` shipped is still refused
 * unless the record names it), AND the question a mount can answer — "has this
 * workbook approved that APPLICATION's code?", over the same consent file, the
 * same records and the same helpers the subscribe flow writes.
 *
 * WHERE THE ARTIFACT IS NAMEABLE, IT IS NAMED. `definition.consentArtifact`
 * carries the stored id and the pre-prelude source for the one route that
 * honestly knows them (a standing object-script mount), which tightens the check
 * to that artifact's hash. A composed realm has no such identity to offer and
 * gets the application-level floor.
 *
 * THE CALL IS MADE HERE AND THE DECISION IS NOT. The mount happens in the
 * renderer, so the renderer is the only place that can ASK. It is not a place
 * that may ANSWER: the consent record lives in the workbook, the renderer is
 * assumed hostile, and a second implementation of "has this application been
 * approved?" is exactly what let the run routes drift apart. This function
 * contains no policy.
 *
 * FAILS CLOSED ON EVERY OUTCOME THAT IS NOT A CLEAN "YES" — a refusal, an IPC
 * error, a missing backend, a command that is not there. "I could not find out
 * whether you approved this publisher's code" is not approval, and this is the
 * path that spawns a real worker realm for a stranger's JavaScript.
 *
 * LOCAL MOUNTS ARE NOT ASKED ABOUT. There is no application to have consented
 * to — `scriptOriginForMount` derives that from the pull-time provenance stamp,
 * never from the package name — so asking would spend an IPC round trip on every
 * mount of the user's own code to be told what the origin already said.
 */
async function requireDistributedMountConsent(definition: HostMountDefinition): Promise<void> {
  const origin = scriptOriginForMount(definition);
  if (origin.kind !== "package") return;
  const describeFailure = (message: string): Error =>
    new Error(
      `"${definition.name}" was not mounted: it arrived inside the application ` +
        `"${origin.name}", and whether you have approved that application's code could ` +
        `not be established. ${message}`,
    );
  let invoke: typeof import("../backend").invokeBackend;
  try {
    // Dynamically imported like every other backend reach in this file: a static
    // value import would drag the Tauri door into every consumer of the host.
    ({ invokeBackend: invoke } = await import("../backend"));
  } catch (err) {
    throw describeFailure(err instanceof Error ? err.message : String(err));
  }
  try {
    await invoke<void>("check_distributed_mount_consent", {
      // `origin.name`, never `definition.packageName`: a definition that names a
      // package without carrying distributed provenance never reaches this line,
      // and one that carries the provenance with no name asks about the
      // placeholder — which no consent record can satisfy, so it is refused.
      packageName: origin.name,
      source: definition.source,
      artifact: definition.consentArtifact ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The gate spoke: pass its own words through, so the user reads the same
    // refusal here as on the module-runtime route.
    if (message.includes(DISTRIBUTED_SCRIPT_NOT_CONSENTED)) throw new Error(message);
    throw describeFailure(message);
  }
}

/**
 * Run BOTH mount gates and mint the proof. The only producer of a
 * `MountAdmission` in the codebase.
 *
 * CONSENT IS ASKED FIRST, and the order is deliberate. `assertMountAllowed` can
 * show a modal whose "yes" grants script execution for the whole SESSION; asking
 * for that on behalf of code we are about to refuse would mint a session-wide
 * approval for a run that never happens, and make the user answer twice to be
 * told no. A refusal that no prompt can fix comes first.
 */
async function admitMount(definition: HostMountDefinition): Promise<MountAdmission> {
  await requireDistributedMountConsent(definition);
  await assertMountAllowed(definition.name);
  return Object.freeze({
    [MOUNT_ADMISSION_BRAND]: true as const,
    scriptId: definition.id,
    source: definition.source,
    originKey: mountOriginKey(definition),
    artifactKey: mountArtifactKey(definition),
  });
}

/**
 * An admission covers ONE script id, ONE exact source, ONE origin and ONE
 * consented artifact.
 *
 * Without this an admission would be a bearer token: the remount paths hold one
 * for as long as the mount lives, and handing `mountWorker` a different
 * definition alongside it would be a consent bypass wearing a proof.
 */
function assertAdmissionCovers(
  definition: HostMountDefinition,
  admission: MountAdmission,
): void {
  if (
    admission.scriptId === definition.id &&
    admission.source === definition.source &&
    admission.originKey === mountOriginKey(definition) &&
    admission.artifactKey === mountArtifactKey(definition)
  ) {
    return;
  }
  throw new Error(
    `Refusing to mount "${definition.name}": the mount admission presented was granted ` +
      "for different code. An admission covers one script id, one exact source, one " +
      "origin and one consented artifact — obtain a new one through hostMountScript " +
      "rather than reusing one.",
  );
}

/**
 * PUBLIC mount entry — the universal chokepoint. EVERY worker-realm mount goes
 * through here (object scripts, custom chart marks, custom chart transforms, JS
 * UDF libraries, shared script libraries, the one-off runner), so BOTH gates
 * govern them all: the global "Script Security" setting, and — for anything that
 * arrived in a distributed application — that application's consent record.
 * Neither can be skipped by a new caller, because `mountWorker` will not mount
 * without the admission only `admitMount` can mint, and this is the only
 * exported route to it.
 *
 * NOTE: the remount paths (crash respawn, debugger) call `mountWorker` directly
 * with the admission the mount ALREADY holds — a respawn re-launches
 * already-admitted code and must not re-gate, which would risk prompting
 * mid-session or blocking automatic crash recovery.
 */
export async function hostMountScript(definition: HostMountDefinition): Promise<void> {
  const admission = await admitMount(definition);
  return mountWorker(definition, admission);
}

/**
 * Mount a script in its own worker realm. Resolves when the worker reports
 * mounted (or rejects with the script's setup error).
 *
 * The `admission` parameter is the structural half of the fix above: this is the
 * only function that spawns a mounted realm, and it cannot be called without
 * proof that the gates ran for THIS definition.
 */
async function mountWorker(
  definition: HostMountDefinition,
  admission: MountAdmission,
): Promise<void> {
  assertAdmissionCovers(definition, admission);
  wireActiveSheet();
  if (mounted.has(definition.id)) {
    // OWNERSHIP SURVIVES A REMOUNT. `hostUnmountScript` clears the transient
    // marker (an unmount really is the end of a debugger-owned mount), but a
    // REMOUNT is not an unmount — and losing the marker here is what made the
    // debugger leak: opening a session on a macro remounts it instrumented, the
    // marker vanished mid-flight, and Stop then REMOUNTED the macro instead of
    // tearing it down. The workbook was left with a permanently mounted,
    // unlocked realm that nothing would ever revoke.
    const wasTransient = transientDebugMounts.has(definition.id);
    hostUnmountScript(definition.id);
    if (wasTransient) transientDebugMounts.add(definition.id);
  }
  faulted.delete(definition.id);

  // An open debug session survives a remount (Save & Apply keeps you in the
  // debugger), but every remount restarts from a clean, un-paused state.
  const debugSession = debugSessions.get(definition.id) ?? null;
  if (debugSession) {
    // A remount restarts the session; nothing the PREVIOUS realm did may end it.
    cancelDebugAutoEnd(definition.id);
    activityStartedAt.delete(definition.id);
    debugSession.status = "starting";
    debugSession.paused = null;
    debugSession.ready = null;
    debugSession.lastSnapshot = null;
    debugSession.activity = null;
    debugSession.lastActivity = null;
    debugSession.triggers = [];
    debugSession.error = null;
    emitDebugState(debugSession, definition.id);
  }

  const handle = buildHandleFromDefinition(definition);
  const worker = spawnWorker();
  const mw: MountedWorker = {
    worker,
    handle,
    definition,
    admission,
    cleanupFns: [],
    forwarders: new Map(),
    pendingRenderCells: new Map(),
    pendingRenderDraws: new Map(),
    drawsInFlight: new Set(),
    pendingMethodCalls: new Map(),
    nextReqId: 1,
    coalesced: new Map(),
    coalesceScheduled: false,
    openReplayPending: definition.mountCause === "open",
    lastCrashAt: 0,
    respawned: false,
    shapeProps: new Map(),
    declaredRenderHooks: new Set(),
    declaredHooks: [],
    hostMirror: new Map(),
    formHolds: 0,
  };
  mounted.set(definition.id, mw);
  // CONSUME the mount cause. The crash-respawn path re-calls mountWorker with
  // this very definition object, and a respawn (or any later remount) is not an
  // open — the replay belongs to the one mount the opener started.
  definition.mountCause = undefined;
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
          // Survives every remount of the session (Save & Apply keeps you in the
          // debugger, and an inert session must STAY inert): it lives on the
          // session, not on the mount, and the reset above deliberately leaves
          // it alone.
          autoInvokeSetup: debugSession.autoInvokeSetup,
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
  // FIRST, ahead of every sweep below: an api.beginUnprotected may be in flight
  // right now, past its permission checks and waiting on the backend. The
  // protection sweep further down can only release holds that are already
  // recorded, so this counter is what tells that begin — when it finally lands
  // — that its owner is gone and it must put the sheet back itself.
  noteScriptDeparture(scriptId);
  transientDebugMounts.delete(scriptId);
  // There is no realm left to end a session against.
  cancelDebugAutoEnd(scriptId);
  activityStartedAt.delete(scriptId);
  mw.terminated = true;
  mw.worker.terminate();
  for (const pending of mw.pendingRenderCells.values()) {
    clearTimeout(pending.timer);
    pending.resolve(null);
  }
  for (const pending of mw.pendingMethodCalls.values()) {
    if (pending.timer !== null) clearTimeout(pending.timer);
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
  // ...and any FORM it had open, for the same reason — plus its layout and its
  // show bucket, so a remount starts clean. A caller awaiting that form's
  // answer (the cross-script show) is told null by the registry.
  revokeScriptForms(scriptId);
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
  // Hand the calculation mode back if THIS script flipped it to manual (Wave 3
  // item 7). Fire-and-forget — unmount is synchronous and the worker is
  // already gone — and covers every way a script ends: explicit unmount,
  // fault (both crash paths route through here) and debugger stop.
  if (manualCalcHolders.has(scriptId)) {
    void getLib()
      .then((lib) => releaseManualCalculation(lib, scriptId))
      .catch(() => {
        // Best-effort: the backend may already be gone (window teardown).
      });
  }
  // Put back any sheet protection THIS script lifted with api.withUnprotected
  // and did not close — the crash guarantee that makes the helper safe. Same
  // fire-and-forget debt discipline as the calculation mode above, and the same
  // coverage: unmount, fault (both crash paths), debugger stop. Without this,
  // killing a script mid-write would leave the user's sheet unprotected, which
  // is the exact failure that made VBA's UserInterfaceOnly untrustworthy.
  if (scriptOwesUnprotectRestore(scriptId)) {
    void getLib()
      .then((lib) => releaseUnprotectedSheets(lib, scriptId))
      .catch(() => {
        // Best-effort: the backend may already be gone (window teardown).
      });
  }
  // Unfreeze the screen if THIS script paused repaints with
  // beginBatch({ deferRepaint: true }) and died before its commit/cancel —
  // same deferred-action discipline as the calculation mode above: the pause
  // is a debt, and every way a script ends routes through here.
  releaseDeferredRepaint(scriptId);
  // ...and take its status-bar message down (Wave 4). A dead script must
  // never pin a stale "Working…" in front of the user.
  releaseScriptStatusBar(scriptId);
  mounted.delete(scriptId);
  // The worker is gone, so any pause died with it. Say so rather than leaving a
  // "paused" indicator standing in front of a script that no longer exists.
  const session = debugSessions.get(scriptId);
  // "failed" already says the realm is gone AND why, so it is not downgraded to
  // the less informative "detached" by the teardown that follows a failed mount.
  if (session && session.status !== "detached" && session.status !== "failed") {
    session.status = "detached";
    session.paused = null;
    // Nothing is executing and nothing can be triggered: the realm is gone.
    session.activity = null;
    session.triggers = [];
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
    cancelDebugAutoEnd(scriptId);
    emitDebugState(null, scriptId);
  }
  for (const scriptId of [...autoEndTimers.keys()]) cancelDebugAutoEnd(scriptId);
  activityStartedAt.clear();
  transientDebugMounts.clear();
  // Workbook reset = fresh session: forget all capability grants.
  resetAllGrants();
  // ...and every dialog mute / dismissal streak, so the next workbook's scripts
  // are not judged by the previous one's behavior.
  resetScriptDialogs();
  // ...and every form layout, session, deadline and show bucket.
  resetScriptForms();
  // ...and the save rate buckets: a new workbook is a new file, and the old
  // one's timings say nothing about it.
  resetScriptSaveLimits();
  // ...and every private clipboard: those hold cells from the workbook that is
  // being replaced, and a style index from it means nothing in the next one.
  clearScriptClipboard();
  // ...and the manual-calculation debt (Wave 3 item 7). Restored EXPLICITLY
  // here rather than left to the per-script unmounts above: their restores are
  // fire-and-forget microtasks, and clearing the tracking set below would win
  // the race and swallow them. One direct restore covers the workbook swap.
  if (manualCalcHolders.size > 0) {
    resetManualCalculationTracking();
    void getLib()
      .then((lib) => lib.setCalculationMode("automatic"))
      .catch(() => {
        // Best-effort: the backend may already be gone (window teardown).
      });
  }
  // ...and every sheet protection a script lifted with api.withUnprotected, by
  // the SAME snapshot-then-clear shape and for the same reason: the per-script
  // unmounts above only queued microtasks, and the clear below would win the
  // race and swallow them.
  //
  // The protection IS restored here rather than dropped, because this sweep is
  // not only "the workbook is being replaced": BEFORE_CLOSE routes through here
  // too, on a workbook that is still live and can still be saved. Dropping the
  // debt there would write the file with the user's sheet left open.
  if (unprotectedHolds.size > 0) {
    const holds = allUnprotectedHolds();
    resetUnprotectedTracking();
    void getLib()
      .then((lib) => restoreAllUnprotected(lib, holds))
      .catch(() => {
        // Best-effort: the backend may already be gone (window teardown).
      });
  }
  // ...and the Wave-4 application debts: a paused repaint (dropped without a
  // flush — the document under the canvas is being replaced wholesale), the
  // status-bar message (cleared — the new workbook owes the old one nothing),
  // and the running-macro chain (those mounts were just torn down above).
  resetDeferredRepaint();
  resetStatusBarTracking();
  resetMacroRunTracking();
  // ...and every library import table. The lockfile belongs to the workbook, so
  // a binding from the old one names a realm that is gone and a package the new
  // workbook may not even have installed.
  //
  // NOT done in hostUnmountScript, deliberately: a RELINK registers the new
  // table and then remounts, and mountWorker unmounts the previous worker as its
  // first step — clearing there would delete the table that was just installed.
  // Per-script lifetime is owned by the linker's release()/clearScriptImports.
  resetScriptImports();
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

// ============================================================================
// The faithful dry run (§5c)
// ============================================================================

/** What a caller asks the preview to run, and how. */
export interface PreviewRunRequest {
  source: string;
  objectType: string;
  /** Display name used in error text; never an id and never persisted. */
  scriptName?: string;
  instanceId?: string | null;
  /** Shapes which surface the realm builds. Reaches no capability by itself. */
  tier?: "restricted" | "unlocked";
  apiVersion?: string;
  /** Mirror seeds for the sync getters (`context.workbook.*`, properties, ...). */
  snapshot?: MountSpec["snapshot"];
  /** The substituted backend. Serves what it can; THROWS for anything else. */
  backend: PreviewBackend;
  /**
   * Hooks to fire after `setup` returns, in order — for a button, ["onClick"].
   *
   * A LIST rather than one, because an object type has as many hooks as it has,
   * and which of them a draft cares about is the DRAFT's choice, not the
   * caller's guess. With `eventOptional` the preview fires exactly the ones the
   * script registered and skips the rest in silence.
   */
  events?: string[];
  /** How many times to fire each, sequentially (default 1). */
  eventCount?: number;
  /**
   * The hook is fired IF the script registered it, and its absence is not a
   * failure.
   *
   * The two callers want opposite things and both are right. A graded task
   * NAMES the event its solution must handle, so a script that never registers
   * it did not do the job — that caller leaves this false. A draft gate has no
   * task and no expectation; it fires the object's usual hook opportunistically
   * to catch a handler that throws, and must not invent a defect out of a
   * script that legitimately only does setup-time work.
   */
  eventOptional?: boolean;
  /**
   * Called once the realm has gone quiet — after `setup`, and after each hook.
   *
   * The hook exists so the caller can bring its backend's state up to date
   * between phases (the preview recalculates its formulas here) without this
   * function needing to know what that state IS. It is awaited, so the next
   * hook sees the result; a rejection is ignored, because an enrichment that
   * failed must not turn a working preview into a failed one.
   */
  onSettle?: () => Promise<void>;
  setupTimeoutMs?: number;
  eventTimeoutMs?: number;
}

/**
 * What the realm actually did. Says nothing about whether it was RIGHT.
 *
 * Note what is NOT here: the script's OUTPUT. `context.log` and
 * `context.notify` are broker calls (`base.log` / `base.notify`), so the
 * backend the caller supplied already collected them — reporting a second copy
 * from here would be a second definition of "what the script said", and the two
 * would disagree the first time a backend chose to filter one.
 */
export interface PreviewRunResult {
  /** The realm was available and the script mounted and ran to completion. */
  ran: boolean;
  error?: string;
  /** Hooks the script registered, as the realm reported them. */
  hooks: string[];
  /** Broker methods the script called, in order, admitted or not. */
  calls: string[];
  /**
   * Calls the BROKER refused, with its own code and message.
   *
   * Reported rather than swallowed because a refusal the script ignored is
   * otherwise invisible: it neither throws (nothing awaited it) nor changes a
   * cell, so the run reads as a clean one that happened to do nothing. Whether
   * a given refusal means "the script is wrong" or "the preview cannot judge
   * this" is the CALLER's decision — a capability refusal here says only that
   * a preview declares nothing, while a validation refusal is one the product
   * would have made identically.
   */
  refusals: Array<{ method: string; code: string; message: string }>;
  /**
   * Hooks the script registered that were OFFERED opportunistically and NOT
   * fired, because the preview cannot synthesize the payload the product's
   * forwarder delivers (§5c.1). Firing them with `undefined` instead is how a
   * correct destructuring handler got rejected as "FAILS when run" — so an
   * unfired handler is reported, never guessed at.
   *
   * IT LEAVES THIS RUNG AS A FIELD, not only as prose in `output`. The preview
   * already said it in a `[preview] ...` line, and every consumer that had to
   * ACT on it — the transcript note, the guided result card, the editor's diff
   * window — would have had to parse that line back out. A run that fired
   * nothing and a run that fired everything and changed nothing are different
   * facts, and only this list tells them apart.
   */
  unexercisedHooks: string[];
  /**
   * An explicitly-NAMED event whose payload the preview cannot synthesize.
   * The caller asserted this hook must be exercised; the preview cannot do it
   * faithfully, so the run proves nothing and the caller must decline.
   */
  unsupportedEvent?: string;
  /**
   * The realm never went quiet because live TIMERS were still pending when the
   * budget expired. Not a verdict: a `setInterval` dashboard poller is legal in
   * the product, which bounds nothing — so the caller declines rather than
   * reporting "still making calls" about a script that may be correct.
   */
  undecidable?: string;
  /** True when this environment has no Worker realm at all (jsdom). */
  realmUnavailable?: boolean;
}

const PREVIEW_SETUP_TIMEOUT_MS = 5_000;
const PREVIEW_EVENT_TIMEOUT_MS = 5_000;

/** Monotonic, so two previews in one session can never share a script id. */
let previewSeq = 0;

/**
 * Run a candidate script in the realm it ACTUALLY runs in — a real hardened
 * Worker — against a substituted backend, and report what it did.
 *
 * WHY THIS EXISTS. `ai_dry_run_script` executes in the Rust QuickJS realm,
 * which shares a small fraction of this realm's `context` and rejects `export`
 * outright, so it declines every object script and its verdict would otherwise
 * describe the emulator rather than the draft. This is the faithful version:
 * the surface is the product's, the mount transform is the product's, hook
 * dispatch is the product's, admission is the product's broker. Only what sits
 * BEHIND the broker is substituted, because a preview has no document to write
 * to — that is the one substitution, and it is the whole design.
 *
 * SAFETY IS PROVED BY ABSENCE, NOT BY A FLAG. This function deliberately does
 * NOT call — and a source-reading guard pins that it does not:
 *
 *   - `assertMountAllowed`      … so no Script-Security modal, no session
 *                                 approval, and no persistent workbook-trust
 *                                 record can be created by previewing.
 *   - `buildHandleFromDefinition`… so no LIVE grant set is fetched. It builds a
 *                                 `buildPreviewHandle` instead, whose grant and
 *                                 declared sets are fresh and EMPTY, so a source
 *                                 the user once granted "Always" cannot inherit
 *                                 that grant here.
 *   - `restoreAndSyncGrants`    … so nothing is pushed to the authoritative Rust
 *                                 capability store.
 *   - `registerMountedHandle`   … so the preview never appears as a mounted
 *                                 script in the transparency panel.
 *   - `mounted.set` / `executeImpl` … so no call can reach a real Tauri command,
 *                                 and `hostUnmountScript` — which REVOKES Rust
 *                                 capabilities by script id — is never reached.
 *
 * Each of those is an absent call rather than a suppressed one, which is the
 * same discipline `DocumentEffect` uses in reverse: there, possession of the
 * value proves the flag is set; here, absence of the call proves nothing was
 * granted. Four conditionals inside `mountWorker` would each have failed OPEN.
 *
 * THE WORKER IS ALWAYS TERMINATED, on every exit path including a throw, so a
 * draft that leaves a live `setInterval` cannot outlive its own preview.
 */
export async function hostPreviewScript(req: PreviewRunRequest): Promise<PreviewRunResult> {
  if (!workerRealmAvailable()) {
    // NOT a verdict. jsdom has no Worker, and answering "it did not run" there
    // would be a statement about the test environment reported as one about the
    // script — the precise failure this whole rung exists to avoid.
    return { ran: false, realmUnavailable: true, hooks: [], calls: [], refusals: [], unexercisedHooks: [] };
  }

  const scriptName = req.scriptName || "(preview)";
  const handle = buildPreviewHandle({
    // A synthetic id that cannot collide with any real script's, so nothing
    // keyed by script id — grants, audit rows, save throttles — can be
    // attributed to, or clobbered on behalf of, a script the user has.
    scriptId: `preview:${req.objectType}:${previewSeq++}`,
    scriptName,
    objectType: req.objectType,
    instanceId: req.instanceId ?? null,
    tier: req.tier === "restricted" ? "restricted" : "unlocked",
  });

  const worker = spawnWorker();
  const hooks: string[] = [];
  const calls: string[] = [];
  const refusals: PreviewRunResult["refusals"] = [];
  let inFlight = 0;
  let hookError: string | undefined;
  let mountSettle: ((ok: boolean, error?: string) => void) | null = null;
  let pingSeq = 0;
  let awaitingPong: { seq: number; resolve: (timers: number) => void } | null = null;
  /** Dispatches the realm has reported complete ({t:"eventDone"}). */
  let eventDoneCount = 0;
  /**
   * The lowest live-timer count any pong has reported — the realm's
   * infrastructure floor (Vite's dev-mode HMR client holds one permanently).
   * Only the DELTA above this floor is evidence about the script.
   */
  let minPongTimers = Number.MAX_SAFE_INTEGER;

  const send = (msg: H2W): void => worker.postMessage(msg);

  worker.onmessage = (e: MessageEvent<W2H>): void => {
    const msg = e.data;
    switch (msg.t) {
      case "mounted":
        mountSettle?.(msg.ok, msg.error);
        break;
      case "hookRegistered":
        hooks.push(msg.hook);
        break;
      case "pong":
        if (awaitingPong?.seq === msg.seq) {
          const { resolve } = awaitingPong;
          awaitingPong = null;
          // An old worker build's pong carries no count; 0 keeps the previous
          // behaviour rather than wedging quiescence on `undefined !== 0`.
          resolve(msg.timers ?? 0);
        }
        break;
      case "eventDone":
        eventDoneCount++;
        break;
      case "error":
        // A hook handler that threw or rejected reports HERE and dispatch
        // returns normally — reading only the dispatch result would call that a
        // clean run. First error wins.
        hookError ??= msg.message;
        break;
      case "call": {
        calls.push(msg.method);
        inFlight++;
        // The REAL broker, with a preview handle: the same ALLOWLIST lookup,
        // the same argument validators, the same tier check and the same R19
        // declared-capability ceiling that govern a mounted script. The ONLY
        // substitution is the executor — `executeImpl` is not reachable from
        // here, so no call can fall through to a Tauri command.
        void brokerCall(handle, msg.method, msg.args, async () => req.backend(msg.method, msg.args))
          .then(
            (value) => send({ t: "callResult", callId: msg.callId, ok: true, value }),
            (err: unknown) => {
              // ANNOTATED, and not `as string` on the code. BrokerError.code is
              // already RpcErrorCode — the exact union RpcErrorShape.code
              // requires — so the cast that used to sit here only widened it to
              // `string` and made the object unassignable to the shape it is
              // sent as. The annotation is what keeps the OTHER arm honest too:
              // without a contextual type the ternary widens "HostError" to
              // `string`, so a typo in that literal would compile.
              const error: RpcErrorShape =
                err instanceof BrokerError
                  ? { code: err.code, message: err.message }
                  : { code: "HostError", message: err instanceof Error ? err.message : String(err) };
              refusals.push({ method: msg.method, ...error });
              send({ t: "callResult", callId: msg.callId, ok: false, error });
            },
          )
          .finally(() => {
            inFlight--;
          });
        break;
      }
      // Every other message this realm can send — debug state, render results,
      // methodCall relays, pong — belongs to a MOUNTED script's lifecycle and
      // has no meaning for a preview. Ignoring them is deliberate: answering a
      // `methodCall` would relay a preview into the live exposed-method
      // registry, and answering `renderDraw` would put a draft's pixels on the
      // grid.
      default:
        break;
    }
  };

  let workerError: string | undefined;
  worker.onerror = (e: ErrorEvent): void => {
    workerError ??= e.message || "Worker error during preview";
    mountSettle?.(false, workerError);
  };

  /**
   * Wait until the realm has PROCESSED everything posted so far.
   *
   * WHY THIS IS NOT OPTIONAL, measured rather than reasoned: without it the
   * event path reported every writing script as changing NOTHING. `{t:"event"}`
   * is fire-and-forget, and `postMessage` is asynchronous — so the host began
   * counting quiet turns while the event message was still in transit, saw zero
   * calls in flight (the handler had not run yet), and declared the realm idle
   * before the first write was even issued. "It ran and changed nothing" is the
   * single most misleading verdict this ladder can produce, and here it would
   * have been produced for CORRECT scripts, every time.
   *
   * `ping`/`pong` is a real protocol round trip and the realm handles messages
   * IN ORDER, so a pong proves the event was dispatched and the handler ran at
   * least to its first `await` — by which point any call it issues has already
   * been posted, and (messages again being ordered) already counted here.
   * Quiescence only means something after that.
   *
   * The offline harness needs none of this: it calls `dispatchEvent` in-process,
   * so the handler has already run by the time it looks.
   */
  const realmCaughtUp = (timeoutMs: number): Promise<number> =>
    new Promise<number>((resolve) => {
      const seq = ++pingSeq;
      awaitingPong = { seq, resolve };
      // Resolve rather than reject on timeout: the drain that follows has its
      // own budget and produces the better message, and a realm that stopped
      // answering will be caught there. -1 = "no pong", which quiescence must
      // treat as NOT-quiet — an unanswered ping proves nothing about timers.
      setTimeout(() => {
        if (awaitingPong?.seq === seq) {
          awaitingPong = null;
          resolve(-1);
        }
      }, timeoutMs);
      send({ t: "ping", seq });
    });

  /**
   * Run the realm to a standstill: nothing in flight, and nothing the realm
   * has yet to react to.
   *
   * ONE DRAIN IS NOT ENOUGH, and the reason is a full round trip. When a call
   * is refused, the host settles it and `inFlight` drops to zero — but the
   * WORKER has not seen the result yet. It processes the `callResult`
   * afterwards, the handler's `await` throws, and only then is `{t:"error"}`
   * posted. A single drain finishes before any of that and reports a failing
   * script as a clean run. So each drain is followed by a ping/pong flush, and
   * the pair repeats while new calls keep appearing — which is also what makes
   * a `.then` chain that issues its next call from the previous one's result
   * settle properly rather than being cut off half-way.
   *
   * WHAT THIS DELIBERATELY DOES NOT DO: require the realm's live-TIMER count
   * to reach zero. That was the first fix for the lost-tail-write defect
   * (§5c.1), and it wedged every dev-mode preview at 5s — the count includes
   * realm INFRASTRUCTURE (Vite's HMR client keeps a permanent retry timer in
   * dev workers), and timer bookkeeping cannot tell a script's sleep from the
   * plumbing's. A handler's timer-suspended work is instead covered by the
   * realm's OWN completion signal: `{t:"eventDone"}` when the dispatch promise
   * settles, awaited by the fire loop below. The pong's timer count survives
   * only as DIAGNOSIS — it picks the budget-expiry message, never quiescence.
   */
  const settleRealm = async (
    timeoutMs: number,
  ): Promise<{ reason: string; undecidable: boolean } | undefined> => {
    const startedAt = Date.now();
    for (;;) {
      const seen = calls.length;
      const remaining = Math.max(0, timeoutMs - (Date.now() - startedAt));
      const stuck = await drainBrokerTraffic(() => inFlight, remaining);
      if (stuck !== undefined) return { reason: stuck, undecidable: false };
      // Flush: anything the realm posts while digesting the results above —
      // an error, or the next call in a chain — arrives before the pong does,
      // because the realm handles messages in order.
      const timers = await realmCaughtUp(Math.max(0, timeoutMs - (Date.now() - startedAt)));
      if (timers >= 0 && timers < minPongTimers) minPongTimers = timers;
      if (calls.length === seen && inFlight === 0) return undefined;
      if (Date.now() - startedAt > timeoutMs) {
        return {
          reason:
            timers === -1
              ? `the realm stopped answering within ${timeoutMs / 1000}s`
              : `the script was still making calls ${timeoutMs / 1000}s after it was started`,
          undecidable: false,
        };
      }
    }
  };

  /**
   * Wait for the realm to report `count` dispatches complete (§5c.1).
   *
   * THE COMPLETION SIGNAL, not an optimisation: a handler that sleeps between
   * broker calls (`await sleep(100); write(...)`) has NOTHING in flight while
   * suspended, so quiescence-by-calls declared the realm idle mid-sleep and
   * the tail write was silently missing from the diff — "changed nothing"
   * about a correct script. The realm posts `{t:"eventDone"}` when the
   * dispatch promise settles, which by construction is after every await the
   * handler chained — so waiting here, then draining, catches the tail.
   *
   * On timeout the TIMER DELTA picks the verdict: a count above the lowest
   * this realm has reported means the handler is plausibly waiting on its own
   * timer (a `setInterval` poller is legal in the product, which bounds
   * nothing), so the answer is UNDECIDABLE — a decline, never "it failed".
   * The baseline subtraction is what keeps dev-mode infrastructure timers
   * (Vite's HMR retry loop holds one permanently) from declining everything.
   */
  const awaitEventDone = async (
    count: number,
    timeoutMs: number,
  ): Promise<{ reason: string; undecidable: boolean } | undefined> => {
    const startedAt = Date.now();
    while (eventDoneCount < count) {
      if (Date.now() - startedAt > timeoutMs) {
        const timers = await realmCaughtUp(1_000);
        if (timers > minPongTimers) {
          return {
            reason:
              "the handler was still waiting on a timer when the preview's budget expired, so " +
              "the preview cannot know what it would eventually do",
            undecidable: true,
          };
        }
        return {
          reason: `the handler did not complete within ${timeoutMs / 1000}s`,
          undecidable: false,
        };
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    return undefined;
  };

  /** Hooks this run actually DISPATCHED, recorded at the send. */
  const firedHooks = new Set<string>();
  let unsupportedEvent: string | undefined;
  let undecidable: string | undefined;

  const finish = (ran: boolean, error?: string): PreviewRunResult => {
    worker.terminate();
    // DERIVED FROM WHAT THE REALM REGISTERED, not from what the caller offered.
    //
    // Built by walking `req.events`, this list could only ever name a hook the
    // CALLER knew about — and callers get that list from `objectHooksFor`,
    // which matches root-level `on[A-Z]` chains only. A handler registered
    // under a sub-object was therefore never offered, never fired, and never
    // reported: `context.render.onMessage(...)` on a shape, `render.markRenderer`
    // on a chart mark, `style.itemRenderer` on a slicer. Those drafts ran, did
    // nothing, and read as exercised-and-clean — the exact inversion this field
    // exists to prevent, and worst for chartMark, whose offered-hook list is
    // empty outright.
    //
    // `event:` names are dropped: `api.onEvent("x", h)` registers `event:x`,
    // which no preview can dispatch. Filtered HERE rather than left to break
    // later, because the only thing standing between it and a stream of
    // "the script registered event:x, but the preview never fired it" is a
    // missing no-op case in the preview backend.
    //
    // Gated on `ran`: a run that never completed cannot support a claim about
    // which of its handlers went unexercised.
    const unexercisedHooks = ran
      ? hooks.filter((h) => !firedHooks.has(h) && !h.startsWith("event:"))
      : [];
    return { ran, error, hooks, calls, refusals, unexercisedHooks, unsupportedEvent, undecidable };
  };

  try {
    const mounted = new Promise<void>((resolve, reject) => {
      mountSettle = (ok, error) => {
        mountSettle = null;
        if (ok) resolve();
        else reject(new Error(error || "setup(context) failed"));
      };
    });

    send({
      t: "mount",
      spec: {
        protocolVersion: PROTOCOL_VERSION,
        scriptId: handle.scriptId,
        objectType: req.objectType,
        instanceId: req.instanceId ?? undefined,
        tier: handle.tier,
        // The realm shapes `context.caps` from this list. It is EMPTY, matching
        // the handle's empty grant set — so the surface a preview sees is the
        // surface it can actually use, and a capability call fails at the
        // broker rather than looking available and dying somewhere stranger.
        capabilities: [],
        apiVersion: req.apiVersion || "1.0",
        source: req.source,
        scriptName,
        snapshot: req.snapshot ?? {},
      },
    });

    try {
      await withTimeout(mounted, req.setupTimeoutMs ?? PREVIEW_SETUP_TIMEOUT_MS, "setup(context)");
    } catch (e) {
      return finish(false, e instanceof Error ? e.message : String(e));
    }

    // `setup` itself may have issued calls whose tails are still in flight —
    // the same `.then`-chain shape that made the offline harness misgrade a
    // correct script. Settle before observing anything.
    const settledSetup = await settleRealm(req.eventTimeoutMs ?? PREVIEW_EVENT_TIMEOUT_MS);
    if (settledSetup !== undefined) {
      if (settledSetup.undecidable) {
        undecidable = settledSetup.reason;
        return finish(false);
      }
      return finish(false, settledSetup.reason);
    }
    if (hookError !== undefined) return finish(false, `setup(context) threw: ${hookError}`);
    await req.onSettle?.().catch(() => undefined);
    // RE-CHECKED after onSettle, and attributed to setup: the settle only
    // proves the realm went quiet, and a rejection from a handler's returned
    // promise can land during onSettle's own IPC round trip. Without this
    // check the error was blamed on the NEXT hook — or, when there was none,
    // dropped, and a throwing script graded as a clean run (§5c.1).
    if (hookError !== undefined) return finish(false, `setup(context) threw: ${hookError}`);

    for (const event of req.events ?? []) {
      if (!hooks.includes(event)) {
        // Optional: the caller offered a hook this object type HAS and this
        // draft chose not to handle, which is not a defect. Required: the
        // caller named the hook the script exists to handle, so not
        // registering it means the script does not do the job.
        if (req.eventOptional) continue;
        return finish(
          false,
          `the script never registers the "${event}" hook (for a button, the click handler is ` +
            `context.${event}(handler))`,
        );
      }
      // THE PAYLOAD DISCIPLINE (§5c.1). The product's forwarders deliver rich,
      // hook-specific payloads; firing a registered handler with a guessed one
      // (the first version sent `undefined`) made CORRECT destructuring
      // handlers throw and rejected the draft — the rung's founding failure
      // mode. A hook whose payload cannot be synthesized is therefore never
      // fired: skipped-and-reported when it was offered opportunistically,
      // and the whole run is unsupported when the caller named it — an
      // explicit event is an assertion the hook must be EXERCISED, and a
      // preview that cannot do that faithfully has nothing to say.
      const synthesized = synthesizableHookPayload(event, req.objectType);
      if (synthesized === null) {
        if (req.eventOptional) {
          // Nothing to record: `finish` derives the list from registered-minus-
          // fired, and this hook is in `hooks` and will never reach `firedHooks`.
          continue;
        }
        unsupportedEvent = event;
        return finish(true);
      }
      const fires = Math.max(1, req.eventCount ?? 1);
      firedHooks.add(event);
      for (let i = 0; i < fires; i++) {
        const doneTarget = eventDoneCount + 1;
        send({ t: "event", hook: event, payload: synthesized.payload });
        // The realm ACKS a dispatch when its promise settles ({t:"eventDone"},
        // §5c.1) — which is after every await the handler chained, sleeps
        // included. Waiting for the ack FIRST is what keeps a handler's
        // timer-suspended tail work in the run; the drain afterwards is what
        // catches the broker calls that tail work posted, plus any
        // non-returned `.then` chain the ack cannot see.
        const done = await awaitEventDone(doneTarget, req.eventTimeoutMs ?? PREVIEW_EVENT_TIMEOUT_MS);
        if (done !== undefined) {
          if (done.undecidable) {
            undecidable = done.reason;
            return finish(false);
          }
          return finish(false, `the "${event}" handler: ${done.reason}`);
        }
        const settled = await settleRealm(req.eventTimeoutMs ?? PREVIEW_EVENT_TIMEOUT_MS);
        if (settled !== undefined) {
          if (settled.undecidable) {
            undecidable = settled.reason;
            return finish(false);
          }
          return finish(false, settled.reason);
        }
        if (hookError !== undefined) {
          return finish(false, `the "${event}" handler threw: ${hookError}`);
        }
        await req.onSettle?.().catch(() => undefined);
        // Same re-check as after setup's onSettle, attributed to THIS event —
        // the error latch is first-wins and is inspected after every phase, so
        // whatever it holds here arrived during this event's settle or
        // recalculation, not during a later one.
        if (hookError !== undefined) {
          return finish(false, `the "${event}" handler threw: ${hookError}`);
        }
      }
    }

    if (workerError !== undefined) return finish(false, workerError);
    // The last line of defence for a rejection that lands in the microscopic
    // window after the final onSettle check: better attributed vaguely than
    // reported as a clean run.
    if (hookError !== undefined) return finish(false, `a handler threw: ${hookError}`);
    return finish(true);
  } catch (e) {
    // The realm must not survive an unexpected failure of its own driver.
    return finish(false, e instanceof Error ? e.message : String(e));
  }
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

/**
 * One thing that can make this script start executing.
 *
 * WHY THE DEBUGGER NEEDS THIS AT ALL. The dominant script shape — and the ONLY
 * shape the macro recorder produces — is `setup` registering a handler and
 * returning. Such a script has no entry point a debugger can "run": it is
 * mounted and idle until something in the app happens to it. A session that
 * cannot name that something, and cannot make it happen, leaves the user
 * waiting in front of a script that will never move.
 */
export interface DebugTrigger {
  /** Stable within a mount: "hook:onClick", "method:recalcAll", "method:doThing". */
  id: string;
  kind: "hook" | "method";
  /** The hook name or the (display) exposed-method / run-target name. */
  name: string;
  /** What the user would do in the app to fire this for real. */
  description: string;
  /** Whether the debugger may fire it directly. */
  fireable: boolean;
  /** Why not, when `fireable` is false. */
  reason?: string;
  /**
   * True for a RUN-AT-CURSOR run-target — a top-level function auto-exposed on
   * this debug mount (VBA F5). Distinct from an ordinary exposed method so the
   * UI can present it as "run this function" rather than an event hook.
   */
  runTarget?: boolean;
  /**
   * The actual exposed-method name to invoke through `hostCallExposed`. Equal to
   * `name` for an ordinary method; for a run-target it is the prefixed relay name
   * (`RUN_TARGET_EXPOSED_PREFIX + name`) while `name` stays the plain function.
   */
  invokeName?: string;
}

/** What the realm last told us it was executing. */
export interface DebugActivityRecord {
  label: string;
  /** Set when that execution threw or rejected. */
  error?: string;
  /**
   * Wall-clock duration of a COMPLETED execution, in milliseconds.
   *
   * Only ever set on `lastActivity` (a running execution has no duration yet),
   * and only when the host saw both ends of it — an execution that was already
   * in flight when the session opened has no start to measure from.
   */
  durationMs?: number;
}

/**
 * State of one open debug session, as the editor renders it.
 *
 * THE STATUS IS A CLAIM ABOUT THE SCRIPT, NOT ABOUT THE SESSION. It used to
 * become "running" when the realm reported it had instrumented the source and
 * then never changed again, so an event-driven script — the common case —
 * claimed to be running forever while nothing at all was happening. The realm
 * now reports the start and end of every execution (`debugActivity`), and
 * "waiting" / "finished" are the honest resting states.
 */
export interface DebugSessionState {
  scriptId: string;
  scriptName: string;
  /**
   * - starting  — remounting; the realm has not reported in yet.
   * - running   — script code is on the stack right now (`activity` names it).
   * - paused    — suspended at a yield point (`paused` describes where).
   * - waiting   — mounted and idle, with a real EVENT HOOK that something in the
   *               app will fire (a click, an edit, a save). Only a `hook`
   *               trigger justifies this word — see `idleStatusFor`.
   * - finished  — mounted and idle with nothing that will fire on its own. Its
   *               `method` run-targets are still there for the USER to run
   *               again; nothing is going to arrive.
   * - failed    — `setup` threw; `error` says what it threw.
   * - detached  — the script was unmounted; there is nothing to attach to.
   */
  status: "starting" | "running" | "paused" | "waiting" | "finished" | "failed" | "detached";
  /**
   * Whether the debug mount CALLED the script's `setup(context)` entry point.
   *
   * True for an object script — calling `setup` is what registers `onClick`, and
   * a session that skipped it would have no triggers and nothing to debug.
   *
   * False for the synthetic module-macro mount (`hostStartModuleScriptDebugSession`),
   * where `setup` is not a registration step but the macro body itself: calling
   * it would execute the whole macro before the user had stepped a single line.
   * The UI reads this to say "prepared, nothing has run yet" instead of
   * "setup() finished".
   */
  autoInvokeSetup: boolean;
  breakpoints: number[];
  ready: DebugReadyState | null;
  paused: DebugPauseState | null;
  /** Most recent non-pausing (synchronous-context) breakpoint report. */
  lastSnapshot: DebugSnapshotState | null;
  /** What is executing while `status` is "running" / "paused". */
  activity: DebugActivityRecord | null;
  /** The last execution that COMPLETED (its error, if it threw). */
  lastActivity: DebugActivityRecord | null;
  /** What can start this script again, as of the last idle transition. */
  triggers: DebugTrigger[];
  /** Set when `status` is "failed". */
  error: string | null;
}

const debugSessions = new Map<string, DebugSessionState>();

/**
 * When the realm said the CURRENT execution started, so a completed one can be
 * reported with a duration. Host-side by design: the realm's clock is not ours,
 * and an execution the host never saw start simply has no duration.
 */
const activityStartedAt = new Map<string, number>();

/**
 * Scripts the DEBUGGER itself mounted (a recorded macro opened in the editor has
 * no standing mount of its own — it is a module script). Tracked so Stop UNMOUNTS
 * such a script rather than remounting it clean: there is no production mount to
 * return it to.
 */
const transientDebugMounts = new Set<string>();

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

// ----------------------------------------------------------------------------
// Triggers — what can make an idle script start executing
// ----------------------------------------------------------------------------

/**
 * Hooks the debugger must NOT synthesize.
 *
 * Render hooks are pull-based: the host asks for styles/bitmaps on a 2s
 * deadline and the realm refuses to suspend inside one at all (beginNoPause),
 * so a "fire" button for them would either do nothing visible or invite the
 * user to set a breakpoint that provably cannot stop. They are still LISTED —
 * the user should see that the script renders — just not fireable.
 */
const UNFIREABLE_HOOKS: Record<string, string> = {
  onRender: "cell renderers run on the paint deadline and cannot be suspended",
  canvasRenderer: "shape painters run on the paint deadline and cannot be suspended",
  itemRenderer: "slicer item painters run on the paint deadline and cannot be suspended",
  markRenderer: "chart mark painters run on the paint deadline and cannot be suspended",
};

/** The gesture that fires a hook for real, in the user's words. */
const HOOK_GESTURES: Record<string, string> = {
  onClick: "a click on it",
  onDoubleClick: "a double-click on it",
  onChange: "its value changing",
  onEdit: "an edit to it",
  onEditStart: "an edit starting on it",
  onEditEnd: "an edit finishing on it",
  onSelect: "it being selected",
  onSelectionChange: "the selection moving",
  onDataChange: "its data changing",
  onOpen: "the workbook being opened",
  onBeforeSave: "the workbook being saved",
  onAfterSave: "the workbook finishing a save",
  onBeforeClose: "the workbook being closed",
  onSheetChange: "the active sheet changing",
  onThemeChange: "the theme changing",
  onActivate: "it being activated",
  onDeactivate: "it being deactivated",
  onInsert: "a row/column being inserted",
  onDelete: "a row/column being deleted",
  onResize: "it being resized",
  onRefresh: "it being refreshed",
  onDrillThrough: "a drill-through on it",
  onShow: "it being shown",
  onHide: "it being hidden",
  onPropertyChange: "one of its properties changing",
  onPlacementChange: "it being moved",
  onCellChange: "one of its cells changing",
  onMessage: "a message being posted to it",
};

/**
 * The synthetic payload a fired hook receives.
 *
 * DELIBERATELY THE PRODUCTION SHAPE, with neutral values — no "simulated: true"
 * marker. A debugger that hands a handler a payload it could never receive in
 * production teaches the author about a program that does not exist. Hooks
 * absent from this table are dispatched with `undefined`, which is exactly what
 * their real forwarders send.
 */
const SIMULATED_HOOK_PAYLOADS: Record<string, () => unknown> = {
  onClick: () => ({ x: 0, y: 0 }),
  onDoubleClick: () => ({ x: 0, y: 0 }),
  // Form hooks carry WIDGET payloads (scriptForms.ts), not a click position;
  // keyed by `objectType.hook` and consulted first, so a form's onClick is
  // never fired with a button's `{ x, y }`.
  "form.onShow": () => ({ values: {} }),
  "form.onClick": () => ({ name: "", values: {} }),
  "form.onChange": () => ({ name: "", value: null, values: {}, source: "user" }),
  "form.onClose": () => ({ reason: "cancel", values: {} }),
};

/** The synthetic payload for a debugger-fired hook, type-specific first. */
function simulatedHookPayload(objectType: string, hook: string): unknown {
  return (SIMULATED_HOOK_PAYLOADS[`${objectType}.${hook}`] ?? SIMULATED_HOOK_PAYLOADS[hook])?.();
}

function describeHookTrigger(objectType: string, hook: string): string {
  if (hook.startsWith("event:")) {
    return `the app event "${hook.slice("event:".length)}" being emitted`;
  }
  const gesture = HOOK_GESTURES[hook];
  return gesture
    ? `${gesture} (the ${objectType} this script is attached to)`
    : `an ${hook} event on the ${objectType} this script is attached to`;
}

/**
 * Everything that can start this script again: the hooks its `setup` registered
 * and the methods it exposed. Recomputed on demand — a script may register a
 * hook or expose a method long after `setup` returned.
 */
function collectDebugTriggers(mw: MountedWorker): DebugTrigger[] {
  const { objectType, instanceId, id } = mw.definition;
  const out: DebugTrigger[] = [];
  for (const hook of mw.declaredHooks) {
    const blocked = UNFIREABLE_HOOKS[hook];
    out.push({
      id: `hook:${hook}`,
      kind: "hook",
      name: hook,
      description: describeHookTrigger(objectType, hook),
      fireable: !blocked,
      ...(blocked ? { reason: blocked } : {}),
    });
  }
  const seenMethod = new Set<string>();
  for (const method of listExposed()) {
    if (method.ownerScriptId !== id) continue;
    if (method.objectType !== objectType) continue;
    if ((method.instanceId ?? null) !== (instanceId ?? null)) continue;
    const isRunTarget = method.methodName.startsWith(RUN_TARGET_EXPOSED_PREFIX);
    // Ordinary host-only relays (shared-library entry points) stay hidden; only
    // run-targets — the debugger's own VBA-F5 entry points — are surfaced.
    if (method.methodName.startsWith(HOST_ONLY_EXPOSED_PREFIX) && !isRunTarget) continue;
    const displayName = isRunTarget
      ? method.methodName.slice(RUN_TARGET_EXPOSED_PREFIX.length)
      : method.methodName;
    if (seenMethod.has(displayName)) continue; // a plain method shadows a same-named run-target
    seenMethod.add(displayName);
    out.push({
      id: `method:${displayName}`,
      kind: "method",
      name: displayName,
      invokeName: method.methodName,
      ...(isRunTarget ? { runTarget: true } : {}),
      description: isRunTarget
        ? displayName === "setup"
          ? // Only ever registered on an INERT mount (nothing called it), so this
            // never contradicts an object script whose setup already ran.
            "run setup() from the top — the entry point Calcula calls when this script is " +
            "mounted, and what a button linked to this macro runs"
          : `run ${displayName}() from the top — the VBA-F5 "run the function the cursor is in" entry point`
        : `a call to ${displayName}() — a shortcut, a scheduled job, a formula or another script`,
      fireable: true,
    });
  }
  return out;
}

/**
 * Idle statuses: the script is mounted, nothing is executing.
 *
 * ONLY A `hook` TRIGGER MEANS "WAITING". The two kinds of trigger answer two
 * different questions:
 *   - hook   — something in the app WILL fire this (a click, an edit, a save).
 *              The script really is waiting for it.
 *   - method — YOU may run this again. A run-target is exposed on the debug
 *              mount purely so the user can start it; nothing in the app is
 *              going to call it, and nothing ever will.
 *
 * Counting methods as "waiting" is what made every recorded macro report
 * "Waiting for a trigger" forever after the user had stepped through the whole
 * thing: a macro always carries its own run-targets (`setup` plus each top-level
 * function), so the list was never empty and the badge never changed. A macro
 * that has run is FINISHED — there is nothing left to wait for.
 */
function idleStatusFor(triggers: DebugTrigger[]): "waiting" | "finished" {
  return triggers.some((t) => t.kind === "hook") ? "waiting" : "finished";
}

/**
 * What the user is told when an INERT mount has nothing that can be started.
 *
 * The whole point of an inert mount is that the user drives execution, so a
 * session with no run-target is a dead end — a Run button that does nothing.
 * It is reported as a failure WITH THE REASON rather than as a serene "Waiting
 * for a trigger" that will wait forever.
 */
const NOTHING_RUNNABLE_ERROR =
  "Nothing in this script can be started from the debugger: no top-level function " +
  "declaration was found. Put the macro body in a top-level `function name(api) { … }` " +
  "(or `function setup(context) { … }`) — a function assigned to a const or an arrow " +
  "function cannot be run from here.";

/**
 * Move a session to its resting state: mounted, with nothing on the stack.
 * "waiting" when an event hook can still fire it, "finished" when the only way
 * it runs again is the user starting it.
 */
function settleDebugIdle(mw: MountedWorker, session: DebugSessionState): void {
  session.triggers = collectDebugTriggers(mw);
  session.paused = null;
  session.activity = null;
  applyIdleStatus(session);
}

/**
 * The resting status for a session whose triggers are already current — the one
 * place that knows an INERT mount with no run-target is a dead end rather than a
 * script that "finished".
 */
function applyIdleStatus(session: DebugSessionState): void {
  if (!session.autoInvokeSetup && session.triggers.length === 0) {
    // Terminal for an inert mount: nothing ran, so nothing can register a
    // trigger later. Saying "finished" here would claim the script completed.
    session.status = "failed";
    session.error = NOTHING_RUNNABLE_ERROR;
    return;
  }
  session.status = idleStatusFor(session.triggers);
}

/** Re-read the trigger list of a session that is already at rest. */
function refreshIdleDebugTriggers(mw: MountedWorker): void {
  const session = debugSessions.get(mw.definition.id);
  if (!session) return;
  if (session.status !== "waiting" && session.status !== "finished") return;
  settleDebugIdle(mw, session);
  emitDebugState(session, mw.definition.id);
}

// ----------------------------------------------------------------------------
// Leaving debug mode by itself — stepping past the end of a macro
// ----------------------------------------------------------------------------
//
// VBA's contract: step past the end of a Sub and you are out of break mode.
// Ours was not — the user stepped through every line of a recorded macro and
// the toolbar still showed a live session, because the debugger owns the mount
// and nothing ever released it. A macro that has run to completion, with no
// event hook that can start it again, has nothing left to debug: the session
// ends itself and the toolbar returns to its normal state.
//
// THE THREE THINGS THIS MUST NOT DO:
//   1. swallow a failure — a run that threw KEEPS its session (that is exactly
//      when the user needs it), so only a clean completion ends;
//   2. unregister a handler being debugged — a script with a real `hook`
//      trigger stays mounted and waiting, forever if that is what the user
//      wants;
//   3. vanish without a trace — the completion is printed to the script console
//      first, so there is a record after the badge disappears.
//
// It is also idempotent and identity-checked: everything it does is re-validated
// against the SAME session object at the moment it acts, so a Stop, a Run or a
// window close landing in the meantime wins and the auto-end simply drops.

/** How often the pending-work check re-runs while a call is still in flight. */
const AUTO_END_POLL_MS = 25;

/**
 * How long the auto-end waits for the run's own method call to come back before
 * giving up entirely. Ending while the call is in flight would tear the realm
 * down under it and reject the caller with "Script unmounted" — the run that
 * just SUCCEEDED would be reported as failed. Giving up leaves the session open
 * and honest ("Finished"); the user can still press Stop.
 */
const AUTO_END_MAX_WAIT_MS = 3_000;

/** Pending auto-ends, keyed by script id, so a Stop/Run can cancel them. */
const autoEndTimers = new Map<string, ReturnType<typeof setTimeout>>();

function cancelDebugAutoEnd(scriptId: string): void {
  const timer = autoEndTimers.get(scriptId);
  if (timer !== undefined) {
    clearTimeout(timer);
    autoEndTimers.delete(scriptId);
  }
}

/**
 * Whether this session is one that should let go of the debugger on its own.
 *
 * Re-evaluated on every tick, never cached: the user may have run something
 * else, hit a breakpoint, or had a hook appear since the completion landed.
 */
function qualifiesForDebugAutoEnd(session: DebugSessionState): boolean {
  // Only the DEBUGGER'S OWN inert mount (a recorded macro). A real object
  // script's mount belongs to the workbook, not to this session.
  if (session.autoInvokeSetup !== false) return false;
  if (!transientDebugMounts.has(session.scriptId)) return false;
  // Settled and idle. "paused"/"running" mean the user is still in it;
  // "failed"/"detached" mean the session is carrying a message worth reading.
  if (session.status !== "finished" && session.status !== "waiting") return false;
  // A real event hook is a promise that something will fire: ending would
  // unregister the very handler being debugged.
  if (session.triggers.some((t) => t.kind === "hook")) return false;
  // Something must actually have RUN, and it must have run cleanly.
  const last = session.lastActivity;
  if (!last || last.error) return false;
  return true;
}

/** Human duration for the completion line. */
function formatRunDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/**
 * The record that outlives the badge: one line in the script console saying
 * what ran, how it ended, and that the session is over. Printed through the
 * same channel `context.log` uses, so it lands in both editors' consoles.
 */
function announceDebugAutoEnd(session: DebugSessionState): void {
  const last = session.lastActivity;
  const label = last?.label ?? "the script";
  const took = typeof last?.durationMs === "number" ? ` in ${formatRunDuration(last.durationMs)}` : "";
  emitAppEvent("objectscript:console", {
    scriptId: session.scriptId,
    level: "log",
    args: [
      `[debug] ${session.scriptName}: ${label} finished${took}. ` +
        "Nothing else can start this script, so the debug session ended. " +
        "Press Run (F5) or Debug to run it again.",
    ],
  });
}

/**
 * Try to end `session` now; re-arm if the run's own method call is still open.
 *
 * `session` is the identity guard: if the map no longer holds THIS object the
 * user has stopped or restarted the session, and this auto-end is stale.
 */
function runDebugAutoEnd(scriptId: string, session: DebugSessionState, deadline: number): void {
  if (debugSessions.get(scriptId) !== session) return;
  if (!qualifiesForDebugAutoEnd(session)) return;
  const mw = mounted.get(scriptId);
  if (!mw) return;
  if (mw.pendingMethodCalls.size > 0) {
    // The realm reports the END OF THE EXECUTION before the relayed method call
    // resolves. Tearing the worker down between those two would reject the call
    // the user is awaiting.
    if (Date.now() >= deadline) return;
    scheduleDebugAutoEnd(scriptId, session, deadline);
    return;
  }
  announceDebugAutoEnd(session);
  // THE SAME TEARDOWN AS PRESSING STOP — there is no second path, so the
  // transient mount is released exactly as it always was.
  void hostStopDebugSession(scriptId).catch(() => undefined);
}

function scheduleDebugAutoEnd(scriptId: string, session: DebugSessionState, deadline: number): void {
  cancelDebugAutoEnd(scriptId);
  const timer = setTimeout(() => {
    autoEndTimers.delete(scriptId);
    runDebugAutoEnd(scriptId, session, deadline);
  }, AUTO_END_POLL_MS);
  autoEndTimers.set(scriptId, timer);
}

/** Arm an auto-end for a session that just completed an execution cleanly. */
function maybeAutoEndDebugSession(scriptId: string, session: DebugSessionState): void {
  if (!qualifiesForDebugAutoEnd(session)) {
    cancelDebugAutoEnd(scriptId);
    return;
  }
  scheduleDebugAutoEnd(scriptId, session, Date.now() + AUTO_END_MAX_WAIT_MS);
}

/**
 * The realm answered the mount.
 *
 * This is the backstop that makes the status honest even when instrumentation
 * bailed out (no `debugActivity` reports at all in that case, because the
 * fallback path runs the ORIGINAL source): `mounted` means `setup` returned, so
 * whatever the session last believed, the script is now idle — or failed.
 */
function noteDebugMountSettled(mw: MountedWorker, ok: boolean, error?: string): void {
  const scriptId = mw.definition.id;
  const session = debugSessions.get(scriptId);
  if (!session) return;
  if (ok) {
    if (session.status === "paused") return; // a later execution is suspended
    session.error = null;
    settleDebugIdle(mw, session);
  } else {
    // A `setup` that threw leaves nothing to step through — but the session is
    // kept, showing WHAT it threw, instead of vanishing and taking the reason
    // with it. Save & Apply remounts straight back into the session.
    session.status = "failed";
    session.paused = null;
    session.activity = null;
    session.triggers = [];
    session.error = error || "setup() failed";
  }
  emitDebugState(session, scriptId);
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
  // A standing mount is normally a REAL object script: `setup` is its
  // registration step, so the debug mount must keep calling it or the script
  // would come up with no hooks, an empty Fire list and nothing to debug at all.
  //
  // THE EXCEPTION is a mount the DEBUGGER itself owns — the synthetic module
  // macro. Its standing mount is one this file made, inert by construction, and
  // re-entering a session on it (Save & Apply, pressing Debug again, Run finding
  // the mount already there) must not quietly flip it back to "run the macro at
  // mount". That marker is the only authority on the question, so it is read
  // here rather than inferred from whatever session happens to be open.
  const autoInvokeSetup = !transientDebugMounts.has(scriptId);
  // The standing mount's own admission: this is a REMOUNT of code already
  // admitted (same id, same source, same origin), so the gates do not run again
  // and the user is not re-prompted mid-session.
  return startDebugSessionOn(
    mw.definition,
    breakpoints,
    options,
    autoInvokeSetup,
    mw.admission,
  );
}

/**
 * Open a session on a definition and (re)mount it instrumented.
 *
 * `autoInvokeSetup` is the one thing the two entry points disagree about, and it
 * is decided by the CALLER because only the caller knows what kind of script
 * this is — see DebugSessionState.autoInvokeSetup.
 *
 * `admission` is the other: `hostStartDebugSession` re-presents the standing
 * mount's (a remount of admitted code), while the MODULE path mints a fresh one,
 * because that mount is brand new and nothing has gated it yet.
 */
async function startDebugSessionOn(
  definition: HostMountDefinition,
  breakpoints: number[],
  options: { pauseOnEntry?: boolean },
  autoInvokeSetup: boolean,
  admission: MountAdmission,
): Promise<DebugSessionState> {
  const scriptId = definition.id;
  // A fresh session replaces whatever the previous one was about to do.
  cancelDebugAutoEnd(scriptId);
  activityStartedAt.delete(scriptId);
  const session: DebugSessionState = {
    scriptId,
    scriptName: definition.name,
    status: "starting",
    autoInvokeSetup,
    breakpoints: normalizeBreakpointLines(breakpoints),
    ready: null,
    paused: null,
    lastSnapshot: null,
    activity: null,
    lastActivity: null,
    triggers: [],
    error: null,
  };
  debugSessions.set(scriptId, session);
  pauseOnEntryOnce.set(scriptId, options.pauseOnEntry === true);
  emitDebugState(session, scriptId);
  try {
    // Re-presenting an existing admission on purpose: this is already-admitted
    // code being relaunched, exactly like the crash-respawn path. Re-gating here
    // would prompt mid-session for a script the user is already running. (The
    // MODULE path below mints its admission before it ever gets here — that
    // mount is brand new, so both gates run for it.)
    await mountWorker(definition, admission);
  } catch (err) {
    // A `setup` that threw is a debugging RESULT, not a failure to start a
    // session: noteDebugMountSettled has already recorded what it threw, and
    // the panel shows it. Anything else (spawn failure, mount timeout) leaves
    // no session behind.
    const settled = debugSessions.get(scriptId);
    if (settled?.status !== "failed") {
      debugSessions.delete(scriptId);
      pauseOnEntryOnce.delete(scriptId);
      emitDebugState(null, scriptId);
    }
    throw err;
  }
  return session;
}

/**
 * Open a debug session on a MODULE script that has no standing mount — a
 * recorded macro the user opened in the Object Script Editor.
 *
 * THE CALLER SUPPLIES AN ID, NEVER A BODY. `hostStartDebugSession` builds its
 * session from the authoritative mount definition the host already holds; a
 * module macro has no mount, so this resolves the equally authoritative record
 * — the module store, through `get_script` — and builds the definition HERE.
 * An earlier version took a caller-supplied `HostMountDefinition`, which meant
 * arbitrary source arrived over the editor-window Tauri bridge and was mounted
 * at the unlocked tier on the strength of an id. That is a source-injection door
 * into the debugger, and it is now closed: nothing a caller sends can decide
 * WHAT runs, only WHICH stored module does.
 *
 * The definition is the byte-for-byte unlocked `workbook` object-script shape
 * `runMacroModule` uses for a button click, so what you step through is what a
 * button runs. Script Security still gates the mount (`assertMountAllowed`).
 *
 * THE MOUNT EXECUTES NOTHING. Under that synthetic definition `context.onClick`
 * does not exist, so the macro's generated `setup` falls through to
 * `return macroNNNN(context.api)` — meaning MOUNTING IT RUNS IT. This used to
 * happen TWICE per session: once on a plain mount here, then again on the
 * instrumented remount — so the debugger paused at line 6 with every value the
 * macro writes already in the grid, and stepping applied them a third time. The
 * plain pre-mount is gone (there is exactly ONE mount now) and it carries
 * `autoInvokeSetup: false`, so entering the debugger prepares the realm,
 * installs the run-targets, and stops. Run / run-at-cursor / Fire is what
 * starts it, which is VBA's contract and the only way stepping can show effects
 * landing.
 *
 * The mount is TRANSIENT: the debugger owns it, Stop tears it down rather than
 * remounting it, and a session that fails to open takes the mount with it. If
 * the id is already mounted (a real object script, or a session already open)
 * this is exactly `hostStartDebugSession` — including its `setup` invocation,
 * because a standing mount means a real object script whose setup registers its
 * hooks.
 */
export async function hostStartModuleScriptDebugSession(
  scriptId: string,
  breakpoints: number[] = [],
  options: { pauseOnEntry?: boolean } = {},
): Promise<DebugSessionState> {
  if (mounted.has(scriptId)) {
    return hostStartDebugSession(scriptId, breakpoints, options);
  }

  // Dynamically imported: `workbookScripts` reaches the backend door and
  // `scriptableObjects` imports THIS module, so a static import would either
  // drag the grid state into every host consumer or close an import cycle.
  const [{ getWorkbookScript }, { SCRIPT_API_VERSION }] = await Promise.all([
    import("../workbookScripts"),
    import("./protocol"),
  ]);

  let record: Awaited<ReturnType<typeof getWorkbookScript>> | null = null;
  try {
    record = await getWorkbookScript(scriptId);
  } catch (err) {
    throw new Error(
      `"${scriptId}" could not be read from this workbook's script modules, so there ` +
        `is nothing to debug: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!record || typeof record.source !== "string" || record.source.trim() === "") {
    throw new Error(
      `"${scriptId}" is not a script module in this workbook (or holds no source). ` +
        "It may have been deleted since the editor listed it.",
    );
  }

  // THE RECORD'S OWN PROVENANCE, NEVER A CONSTANT. `source_package` is stamped
  // by `core/calp/src/pull.rs` on every module a `.calp` ships and survives into
  // the workbook script map, so a module the user "opened in the editor" may be
  // a publisher's. This used to hard-code BOTH `accessLevel: "unlocked"` and
  // `provenance: "local"`, which meant opening a debug session on a distributed
  // module handed it the top tier under the user's own identity — a strictly
  // easier escalation than the Run button, because a debug mount is a real
  // realm with live handlers that the user then drives by hand.
  const origin = scriptOriginForStoredRecord(record);
  const definition: HostMountDefinition = {
    id: scriptId,
    name: record.name || scriptId,
    objectType: "workbook",
    instanceId: null,
    source: record.source,
    // Distributed code is capped at `restricted`; local code keeps the unlocked
    // tier a button click runs it under, so what you step through is what runs.
    accessLevel: origin.kind === "package" ? "restricted" : "unlocked",
    ...mountProvenanceForOrigin(origin),
    apiVersion: SCRIPT_API_VERSION,
  };

  // BOTH mount gates run here, exactly as `hostMountScript` would run them —
  // Script Security AND, for a module that arrived in an application, that
  // application's consent record. This is a BRAND NEW realm for a publisher's
  // code, driven by hand afterwards, so "the debugger only inspects" is not a
  // reason to skip either. The mount itself then goes through the session path,
  // so there is only ever ONE mount and it is the instrumented, inert one.
  const admission = await admitMount(definition);
  transientDebugMounts.add(scriptId);
  try {
    return await startDebugSessionOn(definition, breakpoints, options, false, admission);
  } catch (err) {
    // The session did not open, so the mount the debugger made FOR it must not
    // outlive the attempt: there is no production mount here to fall back to,
    // and a leftover unlocked realm is exactly the thing nothing would ever
    // revoke. (`hostUnmountScript` also clears the transient marker.)
    if (mounted.has(scriptId)) hostUnmountScript(scriptId);
    transientDebugMounts.delete(scriptId);
    throw err;
  }
}

/**
 * Script ids whose mount the DEBUGGER owns (module macros mounted for a
 * session). Transparency, and the input to the cleanup below.
 */
export function hostTransientDebugMountIds(): string[] {
  return [...transientDebugMounts];
}

/**
 * End every debugger-owned session and tear down its mount.
 *
 * The surface that opened these sessions is the standalone editor window, which
 * the user can simply CLOSE. Without this, a transient macro mount — unlocked
 * tier, real realm, live handlers — would survive in the main window with no UI
 * left that knows it exists, which is precisely the ambient state a transient
 * mount is supposed to avoid.
 */
export async function hostStopTransientDebugSessions(): Promise<void> {
  for (const scriptId of [...transientDebugMounts]) {
    try {
      await hostStopDebugSession(scriptId);
    } catch {
      /* stop is best-effort; the unmount below is the guarantee */
    }
    // A transient mount with no session behind it (the session failed, or was
    // already dismissed) is still ours to remove.
    if (transientDebugMounts.delete(scriptId) && mounted.has(scriptId)) {
      hostUnmountScript(scriptId);
    }
  }
}

/**
 * Fire one of a waiting script's triggers from the debugger.
 *
 * THE POINT: a script whose only entry point is an event is otherwise
 * undebuggable — you can arm a breakpoint and then have no way to reach it.
 * This is the same door the app itself uses (the hook forwarder's `event`
 * message, or `hostCallExposed` for an exposed method), so a handler reached
 * this way runs exactly as it would in production: same dispatcher, same
 * payload shape, same instrumentation.
 *
 * It is trusted-UI-only, like every other function in this section: a session
 * exists only because the user opened one, and a script has no way to reach
 * this or to observe that it happened beyond the handler running.
 */
export async function hostDebugFireTrigger(scriptId: string, triggerId: string): Promise<void> {
  const session = debugSessions.get(scriptId);
  if (!session) {
    throw new Error("No debug session is open for this script.");
  }
  const mw = mounted.get(scriptId);
  if (!mw) {
    throw new Error("The script is not mounted, so it has nothing to trigger.");
  }
  const trigger = collectDebugTriggers(mw).find((t) => t.id === triggerId);
  if (!trigger) {
    throw new Error(`"${triggerId}" is not a trigger this script has registered.`);
  }
  if (!trigger.fireable) {
    throw new Error(`${trigger.name} cannot be fired from the debugger: ${trigger.reason}.`);
  }
  if (trigger.kind === "method") {
    // A run-target is invoked under its prefixed relay name (invokeName); an
    // ordinary method under its own name. invokeName defaults to name.
    await Promise.resolve(
      hostCallExposed(
        mw.definition.objectType,
        mw.definition.instanceId,
        trigger.invokeName ?? trigger.name,
        [],
      ),
    );
    return;
  }
  post(mw, {
    t: "event",
    hook: trigger.name,
    payload: simulatedHookPayload(mw.definition.objectType, trigger.name),
  });
}

/**
 * End a session: release any pause FIRST, then remount the script from its
 * original source so no instrumentation survives.
 *
 * NO REALM IS EVER LEFT SUSPENDED BY A STOP, and that guarantee does not rest on
 * the `stop` message being delivered. The remount below terminates the worker
 * outright, which takes any pause with it; the message is posted first so that a
 * realm which does read it in time unwinds its suspended executions normally
 * instead of being cut off mid-frame. Either way the script comes back mounted,
 * un-instrumented and un-paused.
 *
 * Works on a session with no mount behind it too (a `setup` that threw leaves a
 * "failed" session the user dismisses with Stop) — there is simply nothing to
 * remount.
 */
export async function hostStopDebugSession(scriptId: string): Promise<void> {
  // Whatever ends this session, it ends only once: a pending auto-end must not
  // fire at a session the user (or a restart) has already taken away.
  cancelDebugAutoEnd(scriptId);
  activityStartedAt.delete(scriptId);
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
    if (transientDebugMounts.has(scriptId)) {
      // A macro the debugger mounted itself: there is no production mount to
      // remount, so tear it down entirely instead of relaunching it.
      transientDebugMounts.delete(scriptId);
      hostUnmountScript(scriptId);
    } else {
      // Back to the production mount: the same definition under the same
      // admission it was mounted with, so ending a session never re-prompts.
      await mountWorker(mw.definition, mw.admission);
    }
  } else {
    transientDebugMounts.delete(scriptId);
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
    // Optimistic: the realm's own `debugResumed` lands a tick later and is
    // authoritative. Both agree that "resumed" means "running only if something
    // is actually on the stack".
    session.paused = null;
    if (session.activity) session.status = "running";
    else applyIdleStatus(session);
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
      // NOT "running": instrumentation finishing says nothing about whether any
      // script code is executing. `debugActivity` is the only thing that does.
      session.ready = msg.state;
      break;
    case "debugPaused":
      session.status = "paused";
      session.paused = msg.state;
      // The user is standing inside the script: nothing may end the session
      // under them.
      cancelDebugAutoEnd(scriptId);
      // The script stopped before finishing `setup` — hold the mount deadline
      // open for as long as the user keeps it there.
      mw.suspendMountDeadline?.();
      // ...and every relayed method call it is standing inside. A debugger-fired
      // method, a scheduled job or a UDF that stops at a breakpoint would
      // otherwise be abandoned by its 30s deadline while the user was reading
      // the frame it stopped in.
      suspendMethodCallDeadlines(mw);
      break;
    case "debugResumed":
      // Only the pause is lifted. Whether anything is still executing is the
      // activity tracker's answer: a resume that lets `setup` run to completion
      // ends with the script IDLE, not "running".
      session.paused = null;
      if (session.activity) session.status = "running";
      else applyIdleStatus(session);
      mw.resumeMountDeadline?.();
      resumeMethodCallDeadlines(mw);
      break;
    case "debugSnapshot":
      session.lastSnapshot = msg.state;
      break;
    case "debugActivity":
      if (msg.state.running) {
        session.activity = { label: msg.state.label };
        session.error = null;
        activityStartedAt.set(scriptId, Date.now());
        // Something is executing again — a pending auto-end from the PREVIOUS
        // execution must not fire into it.
        cancelDebugAutoEnd(scriptId);
        if (session.status !== "paused") session.status = "running";
      } else {
        const startedAt = activityStartedAt.get(scriptId);
        activityStartedAt.delete(scriptId);
        session.activity = null;
        session.lastActivity = {
          label: msg.state.label,
          ...(msg.state.error ? { error: msg.state.error } : {}),
          ...(startedAt !== undefined ? { durationMs: Date.now() - startedAt } : {}),
        };
        // A pause report can outlive the execution that raised it only if the
        // realm died; while genuinely paused, no activity can have finished.
        if (session.status !== "paused") {
          settleDebugIdle(mw, session);
          // Stepping past the end of a macro leaves debug mode, exactly as it
          // does in VBA — but only for a clean run of a script nothing else can
          // start. maybeAutoEndDebugSession decides; this is just the moment.
          maybeAutoEndDebugSession(scriptId, session);
        }
      }
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
        noteDebugMountSettled(mw, msg.ok, msg.error);
        onMounted(msg.ok, msg.error);
        break;
      case "call":
        void handleCall(mw, msg.callId, msg.method, msg.args);
        break;
      case "hookRegistered":
        if (!mw.declaredHooks.includes(msg.hook)) mw.declaredHooks.push(msg.hook);
        wireHookForwarder(mw, msg.hook);
        // A hook registered after `setup` returned (from inside another handler)
        // changes what the script is waiting for, so an idle session re-reads it.
        refreshIdleDebugTriggers(mw);
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
          if (pending.timer !== null) clearTimeout(pending.timer);
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
      case "debugActivity":
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
    // Captured BEFORE the unmount drops the record that holds it.
    const admission = mw.admission;
    hostUnmountScript(definition.id);
    // Respawn already-admitted code after a crash by re-presenting its own
    // admission (mountWorker, not hostMountScript), so recovery never re-prompts
    // and never re-asks the publisher-consent gate for code already running.
    void mountWorker(definition, admission).then(() => {
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
// Shared script libraries — the CALLER-IDENTITY import table (design §5.3)
//
// WHAT THIS REPLACED, AND WHY. Wave H authorized a library call with an
// unguessable 128-bit token minted per (realm, consumer) and baked into the
// consumer's generated prelude. That is an object-capability, not an identity
// check: a consumer that leaked its token delegated its whole library reach to
// whoever received it, undetectably, and the library could never be told who was
// actually calling. Both of the feature's documented residuals came from that
// one gap.
//
// The table below is the fix. A script names an ALIAS; the host resolves that
// alias in the table it built FOR THAT SCRIPT'S ID from that script's own
// `// @uses` pragmas. Nothing the caller holds, sends or can be given
// authorizes anything — only who it IS. Consequences:
//
//   * There is no credential left to leak. Handing a peer the alias string
//     achieves nothing: the peer's own table is consulted, not the sender's.
//   * The target's entry point no longer has to be script-reachable at all. It
//     is exposed under HOST_ONLY_EXPOSED_PREFIX and `public: false`, so
//     `callExposed` refuses it for every script and only `hostCallExposed` —
//     this file — can get in.
//   * The caller is now known at the moment of the call, which is what makes
//     `authorizeImportCall` below able to cap the call by the CALLER's grants.
//
// This map is HOST STATE. It is written only by trusted linker code
// (scriptLibraries/linker.ts), keyed by the authoritative mount id, and is never
// derived from anything a script sends.
// ============================================================================

/** One resolved `imports.<alias>` binding: where the realm is, what it exports,
 *  and what it was granted. Recorded by the linker at link time. */
export interface LibraryImportBinding {
  /** The name the consumer's `// @uses` bound it to. */
  alias: string;
  package: string;
  version: string;
  /** The realm's mount id — used to check it is still mounted before dispatch. */
  libraryScriptId: string;
  objectType: string;
  instanceId: string;
  /** The realm's host-only relay entry point (HOST_ONLY_EXPOSED_PREFIX name). */
  entryMethod: string;
  /** Exactly the names the library declared with `// @export`. */
  exports: readonly string[];
  /**
   * The capabilities the realm was actually mounted with, i.e.
   * `declared(library) INTERSECT declared(consumer)`. This is the set a call
   * through this binding can reach, and therefore the set the CALLER must hold
   * grants for before the call is dispatched.
   */
  capabilities: readonly CapabilityId[];
  /** The realm's granted net.fetch origins (already intersected downward). */
  netOrigins: readonly string[];
}

/** consumer scriptId -> alias -> binding. */
const scriptImports = new Map<string, Map<string, LibraryImportBinding>>();

/**
 * Install the import table for one script. Trusted-caller only (the linker):
 * this is the whole authorization basis for `base.callImport`, so anything that
 * can call it can grant library reach.
 *
 * Replaces the script's table wholesale — a relink is a fresh set of bindings,
 * never a merge with a previous mount's.
 */
export function registerScriptImports(
  consumerScriptId: string,
  bindings: readonly LibraryImportBinding[],
): void {
  if (bindings.length === 0) {
    scriptImports.delete(consumerScriptId);
    return;
  }
  const table = new Map<string, LibraryImportBinding>();
  for (const b of bindings) {
    // Frozen (and the arrays copied) so a later mutation of the linker's object
    // cannot retroactively widen a binding the host already handed out.
    table.set(
      b.alias,
      Object.freeze({
        ...b,
        exports: Object.freeze([...b.exports]),
        capabilities: Object.freeze([...b.capabilities]),
        netOrigins: Object.freeze([...b.netOrigins]),
      }),
    );
  }
  scriptImports.set(consumerScriptId, table);
}

/** Drop a script's import table (release / relink / workbook close). */
export function clearScriptImports(consumerScriptId: string): void {
  scriptImports.delete(consumerScriptId);
}

/** A script's current bindings (transparency panel / tests). */
export function listScriptImports(consumerScriptId: string): LibraryImportBinding[] {
  return [...(scriptImports.get(consumerScriptId)?.values() ?? [])];
}

/** Drop every import table (workbook close / test reset). */
export function resetScriptImports(): void {
  scriptImports.clear();
}

/**
 * Resolve `alias` for the CALLING script and authorize the call.
 *
 * Two gates, in this order:
 *
 *  (1) IDENTITY. The alias is looked up in the table registered for
 *      `handle.scriptId`. A script that did not declare the import has no entry
 *      and is refused — with the same message whether the alias is unknown to it
 *      or belongs to a different script, so the refusal is not a directory of
 *      what other scripts imported. The method name must be one the library
 *      declared with `// @export`.
 *
 *  (2) THE CALLER'S OWN GRANTS CAP THE CALL. The realm holds
 *      `declared(library) INTERSECT declared(consumer)` — a CEILING intersection.
 *      Before Wave H's caller-identity work landed there was no way to also
 *      require the consumer to have been GRANTED those capabilities, so a
 *      consumer that DECLARED `net.fetch` but had never been prompted for it
 *      could cause egress through a library the user had approved at install
 *      time: nothing ungranted happened, but the consumer's own just-in-time
 *      prompt was skipped. Now the caller is known, so it is required to hold
 *      the grant itself — and, if it is a local script that declared the
 *      capability, it is prompted for it HERE, on first use through the library.
 *
 *      The check is at CALL time, not link time, and that is essential: a
 *      consumer legitimately holds no grants at mount time (JIT means the first
 *      USE is the prompt), so intersecting grants when the realm is mounted
 *      would either deny every library that needs anything or force a prompt
 *      before the script has done a thing.
 *
 *      A realm holding `net.fetch` is checked per ORIGIN, because that is the
 *      granularity net.fetch is actually granted at. A realm that holds
 *      `net.fetch` with NO origins needs no per-origin consent from the caller:
 *      it cannot reach any host at all (the Rust gate is authoritative and
 *      matches per origin), so there is nothing to consent to.
 *
 * Pure policy — it dispatches nothing. Exported so the security tests can drive
 * it without a Worker realm.
 */
export async function authorizeImportCall(args: {
  handle: ScriptHandle;
  /** The CONSUMER's own source — what an "always" grant is bound to. */
  consumerSource: string;
  alias: string;
  methodName: string;
}): Promise<LibraryImportBinding> {
  const { handle, alias, methodName } = args;
  const binding = scriptImports.get(handle.scriptId)?.get(alias);
  if (!binding) {
    throw new BrokerError(
      "PermissionDenied",
      `This script did not declare a library aliased '${alias}' with a // @uses pragma`,
    );
  }
  if (!binding.exports.includes(methodName)) {
    throw new BrokerError(
      "PermissionDenied",
      `'${methodName}' is not an export of ${binding.package}@${binding.version}. ` +
        `Declared exports: ${binding.exports.join(", ") || "(none)"}`,
    );
  }
  await requireCallerCoversLibrary(handle, args.consumerSource, binding);
  return binding;
}

/** Gate (2) of authorizeImportCall — see its doc comment. */
async function requireCallerCoversLibrary(
  handle: ScriptHandle,
  consumerSource: string,
  binding: LibraryImportBinding,
): Promise<void> {
  const label = `${binding.package}@${binding.version}`;
  for (const cap of binding.capabilities) {
    // Belt-and-braces: the linker already intersected against this set, so a
    // miss here means the ceiling and the realm disagree. Fail closed.
    if (!handle.declaredCapabilities.has(cap)) {
      throw new BrokerError(
        "PermissionDenied",
        `${label} uses the '${cap}' capability, which this script did not declare`,
        cap,
      );
    }
    if (cap === "net.fetch") continue; // per-origin, below
    if (handle.grants.has(cap)) continue;
    await requestLibraryCapability(handle, consumerSource, cap, null, label);
    if (!handle.grants.has(cap)) {
      throw new BrokerError(
        "CapabilityRequired",
        `Calling ${label} needs the '${cap}' capability, which this script has not been granted`,
        cap,
      );
    }
  }

  if (!binding.capabilities.includes("net.fetch")) return;
  for (const origin of binding.netOrigins) {
    if (handle.grants.has("net.fetch") && hasFetchOrigin(handle.scriptId, origin)) continue;
    await requestLibraryCapability(handle, consumerSource, "net.fetch", origin, label);
    if (!(handle.grants.has("net.fetch") && hasFetchOrigin(handle.scriptId, origin))) {
      throw new BrokerError(
        "CapabilityRequired",
        `Calling ${label} can reach ${origin}, which this script has not been granted`,
        "net.fetch",
      );
    }
  }
}

/**
 * MAY this script be asked, in the moment, for a capability it does not hold?
 *
 * The one predicate behind BOTH JIT-prompt gates (`requestLibraryCapability`
 * below and `maybeRequestCapabilityGrant`). Only workbook-authored code may:
 * distributed code holds exactly what package consent recorded, and neither of
 * these paths may become a second way to acquire capabilities after install —
 * a prompt in the moment is a deliberately LOWER bar than package consent.
 *
 * It reads the origin's KIND. While `handle.origin` was a bare string this was
 * `handle.origin !== "local"`, so an application whose publisher NAMED it
 * `local` was routed down the local path and could be granted net.fetch,
 * storage, schedule or bi.query by a single prompt the user answered about what
 * they took to be their own script. Exported so that gate is testable on its own
 * (it is otherwise reachable only through a live Worker realm).
 */
export function mayJitPromptForCapability(handle: Pick<ScriptHandle, "origin">): boolean {
  return isLocalOrigin(handle.origin);
}

/**
 * JIT-prompt the CONSUMER for a capability its library holds. Mirrors
 * maybeRequestCapabilityGrant's policy exactly — local scripts only, one prompt
 * per session per (capability, origin), "always" persisted against the
 * CONSUMER's source — and adds the library provenance so the dialog can say why
 * it is asking now. A denial simply returns; the caller then fails the call.
 */
async function requestLibraryCapability(
  handle: ScriptHandle,
  consumerSource: string,
  cap: CapabilityId,
  origin: string | null,
  libraryLabel: string,
): Promise<void> {
  // A distributed consumer is never JIT-prompted (Phase 4.2): it holds exactly
  // what package consent recorded, and this path must not become a second way to
  // acquire capabilities after install. One predicate for both JIT gates.
  if (!mayJitPromptForCapability(handle)) return;
  if (wasDeniedThisSession(handle.scriptId, cap, origin)) return;
  const decision = await requestCapabilityGrant({
    scriptId: handle.scriptId,
    scriptName: handle.scriptName,
    capability: cap,
    origin,
    viaLibrary: libraryLabel,
  });
  if (decision === "deny") return;
  recordCapabilityGrant(handle.scriptId, cap, origin ?? undefined);
  if (origin) {
    try {
      await grantNetOrigin(handle.scriptId, origin);
    } catch (e) {
      console.error("[caps] failed to mirror net.fetch origin to backend:", e);
    }
  } else if (RUST_MIRRORED_CAPABILITIES.has(cap)) {
    await grantBackendCapability(handle.scriptId, cap);
  }
  if (decision === "always") {
    await persistAlwaysGrant({
      scriptId: handle.scriptId,
      scriptName: handle.scriptName,
      source: consumerSource,
      origin: handle.origin,
      capability: cap,
      netOrigin: origin,
    });
  }
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
  // KIND, not a name. This is gate (1) of the origin-forgery defect: as a bare
  // string, an application NAMED `local` took the local JIT-prompt path and could
  // be granted capabilities by a prompt in the moment, instead of only through
  // package consent — a deliberately higher bar. See scriptOrigin.ts.
  if (!mayJitPromptForCapability(handle) || cap === "ui.html") return;
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

/**
 * The side effects a .calp pull/refresh has on the RENDERER, run identically
 * whether the pull was started by the Subscribe dialog or by a script.
 *
 * THIS IS NOT A CONVENIENCE — it is how rule 1 ("a script can never consent on
 * the user's behalf") is kept true on the script path. Rust materializes pulled
 * object scripts as Restricted + Distributed, i.e. present but UNMOUNTED. Two
 * things then have to happen for the user to be in control:
 *
 *  1. frontend distributable-object providers materialize the custom objects
 *     Rust does not know about (`applyPulledCustomObjects` — the exact call
 *     `subscribeToApplication` makes), and
 *  2. `PACKAGE_UPDATED` fires, which makes the ScriptableObjects extension
 *     re-read the workbook's scripts. That path mounts ONLY what persisted
 *     consent already covers — and consent is keyed by SHA-256 OF THE SOURCE,
 *     so a script whose code this refresh just changed is NOT consent-current,
 *     is NOT mounted, and raises a consent prompt showing the diff.
 *
 * Skipping (2) would be worse than doing it: the pulled code would sit in the
 * workbook unannounced until the next reload, with nothing telling the user it
 * had arrived. Announcing is what makes it visible; mounting stays the human's.
 *
 * `response` is null for a refresh (which pulls many packages and returns a
 * summary rather than one package's custom objects).
 */
async function announcePulledPackage(response: PullResponse | null): Promise<void> {
  if (response) {
    const { applyPulledCustomObjects } = await import("../distribution");
    await applyPulledCustomObjects(response);
  }
  const payload: ApplicationUpdatedPayload = response
    ? {
        packageName: response.packageName,
        version: response.resolvedVersion,
        kind: "subscribe",
        sheetsPulled: response.sheetsPulled,
        scriptsPulled: response.scriptsPulled,
      }
    : {
        packageName: "",
        version: null,
        kind: "refresh",
        sheetsPulled: 0,
        scriptsPulled: null,
      };
  emitAppEvent(AppEvents.PACKAGE_UPDATED, payload);
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
      // A newly exposed method is a new way to start this script — an open
      // debug session sitting at rest must see it appear.
      refreshIdleDebugTriggers(mw);
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
      refreshIdleDebugTriggers(mw);
      return undefined;
    }
    case "base.callMethod": {
      const [targetType, targetInstanceId, methodName, callArgs] = args as [string, string | null, string, unknown[]];
      return callExposed(handle, targetType, targetInstanceId, methodName, callArgs ?? []);
    }
    case "base.callImport": {
      // The consumer names only an alias. WHERE that alias points is host state
      // keyed by THIS script's mount id, and whether the call may proceed is
      // decided against THIS script's grants — see authorizeImportCall.
      const [alias, methodName, callArgs] = args as [string, string, unknown[]];
      const binding = await authorizeImportCall({
        handle,
        consumerSource: definition.source,
        alias,
        methodName,
      });
      if (!mounted.has(binding.libraryScriptId)) {
        throw new BrokerError(
          "HostError",
          `Library ${binding.package}@${binding.version} is no longer mounted`,
        );
      }
      // hostCallExposed, not callExposed: the realm's entry point lives in the
      // host-only namespace precisely so this is the ONLY door into it.
      return await hostCallExposed(binding.objectType, binding.instanceId, binding.entryMethod, [
        methodName,
        Array.isArray(callArgs) ? callArgs : [],
      ]);
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
      // The optional 4th argument is a sheet ref (0-based index or NAME) — the
      // flat VBA idiom `api.setCellValue(r, c, v, "Sheet2")`. vCellSet always
      // validated that slot; until the live-run fix the worker shim dropped it
      // and this executor ignored it, so the value silently landed on the
      // ACTIVE sheet — the exact wrong-sheet write class Wave 1 exists to kill.
      const [row, col, rawValue, sheetRef] = args as
        [number, number, ScriptCellWriteValue, (number | string)?];
      const lib = await getLib();
      // Typed write: 42 lands as the NUMBER 42, true as a boolean, null clears
      // — through the same invariant parse path a paste of a numeric cell takes.
      const { value, invariant } = scriptCellInput(rawValue);
      let sheetIndex: number;
      if (sheetRef !== undefined && sheetRef !== null) {
        const { sheets, activeIndex } = await lib.getSheets();
        sheetIndex = resolveSheetRefIn(sheets, sheetRef, "setCellValue");
        if (sheetIndex !== activeIndex) {
          // Another sheet, by name or index: the same off-sheet path
          // sheet.setCellValue takes (api.* is unlocked-only, so no tier clamp).
          recordScriptWrite(definition.id, sheetIndex, row, col);
          // Canonical US form + invariant flag — parse_cell_input_invariant,
          // never delocalized (sv-SE would read "42.5" as 425). The backend
          // recalculates dependents (written sheet + active) before returning;
          // the writeback draft gate and the active-sheet-skip retry both live
          // inside writeOffSheetCellTyped.
          await writeOffSheetCellTyped(
            lib, definition.id, sheetIndex, row, col, value, invariant,
          );
          return undefined;
        }
      } else {
        sheetIndex = await activeSheetForWriteGuard(lib);
      }
      recordScriptWrite(definition.id, sheetIndex, row, col);
      // writeActiveCellTyped runs the .calp writeback draft gate first — a cell
      // that is a publisher's input form is captured as a schema-validated
      // draft, exactly like a human keystroke, before the grid shows the value.
      // A rejection throws and nothing is written. See writebackWriteGuard.ts.
      const written = await writeActiveCellTyped(
        lib, definition.id, sheetIndex, row, col, value, invariant,
      );
      // THE CANVAS DOES NOT WATCH THE BACKEND. update_cell changes the engine
      // and returns the recalculated cells; nothing re-fetches them until
      // something dispatches `grid:refresh`. Without this line a script write
      // lands in the document and stays invisible until the user scrolls,
      // reloads or edits a cell by hand — which is exactly what "I clicked the
      // macro button and nothing happened" looked like. Every other mutate
      // handler in this broker already does it; these two were the omission.
      await afterCellDataChange(written);
      return undefined;
    }
    case "api.updateCellsBatch": {
      const [rawUpdates] = args as [Array<{ row: number; col: number; value: ScriptCellWriteValue }>];
      const lib = await getLib();
      const sheetIndex = await activeSheetForWriteGuard(lib);
      // Typed writes, converted through the same invariant path as a paste.
      const updates = rawUpdates.map((u) => ({ row: u.row, col: u.col, ...scriptCellInput(u.value) }));
      for (const u of updates) {
        recordScriptWrite(definition.id, sheetIndex, u.row, u.col);
      }
      const { plain, drafted } = await captureWritebackWrites(
        definition.id,
        updates.map((u) => ({ sheetIndex, row: u.row, col: u.col, value: u.value })),
      );
      const invariantAt = new Map(updates.map((u) => [`${u.row},${u.col}`, u.invariant]));
      const changed: CellData[] = [];
      if (plain.length > 0) {
        changed.push(
          ...(await lib.updateCellsBatch(
            plain.map((u) => ({
              row: u.row,
              col: u.col,
              value: u.value,
              invariant: invariantAt.get(`${u.row},${u.col}`) || undefined,
            })),
          )),
        );
      }
      // update_cells_batch DROPS writeback cells (partial-success semantics in
      // commands/data.rs), so a cell whose draft was just saved has to be
      // written on its own or the grid would show nothing at all.
      for (const u of drafted) {
        changed.push(...(await lib.updateCell(u.row, u.col, u.value)).cells);
      }
      // One refresh for the whole batch — see api.setCellValue above.
      await afterCellDataChange(changed);
      return undefined;
    }
    case "api.getCellData": {
      // Typed single-cell read (any sheet, by index or name). Unlike
      // api.getCellValue this keeps the value's type and the cell's formula.
      const [row, col, sheetRef] = args as [number, number, (number | string)?];
      const lib = await getLib();
      const target = await resolveOptionalSheetRef(lib, sheetRef, "getCellData");
      return readTypedCell(lib, target, row, col);
    }
    case "api.getRangeValues": {
      // ONE round trip for a whole rectangle, on any sheet (index or name).
      const [startRow, startCol, endRow, endCol, sheetRef] = args as
        [number, number, number, number, (number | string)?];
      const lib = await getLib();
      const target = await resolveOptionalSheetRef(lib, sheetRef, "getRangeValues");
      return readTypedRange(lib, target, startRow, startCol, endRow, endCol);
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
      // THE user-reported wall: api.setActiveSheet("Sheet1") used to fail with
      // "index must be a non-negative integer". A sheet ref is an index OR a
      // name, resolved here against the live list.
      const [ref] = args as [number | string];
      const lib = await getLib();
      const index = await resolveSheetRef(lib, ref, "setActiveSheet");
      const result = await lib.setActiveSheet(index);
      // The BACKEND's active sheet moved; Core's did not. Announcing it is what
      // keeps the tab bar, the canvas and every subsequent active-sheet write in
      // the same place — a recorded macro's very first statement is
      // `api.setActiveSheet(...)`, so a silent divergence here made the rest of
      // the macro write to a sheet the user was not looking at.
      await announceSheetsChanged(result);
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
      // { deferRepaint: true } is ScreenUpdating done right (Wave 4): repaints
      // pause only INSIDE a batch, so the pause has a guaranteed end — the
      // commit/cancel below, or this script's unmount/fault, whichever comes
      // first. There is deliberately NO standalone screenUpdating flag: a flag
      // with no bracket is exactly how VBA left dead Excel windows frozen.
      const [description, options] = args as [string, { deferRepaint?: boolean } | undefined];
      const lib = await getLib();
      await lib.beginUndoTransaction(description);
      if (options?.deferRepaint === true) acquireDeferredRepaint(definition.id);
      return undefined;
    }
    case "api.commitBatch": {
      const lib = await getLib();
      try {
        await lib.commitUndoTransaction();
      } finally {
        // Release EVEN when the commit throws — the batch is over either way,
        // and a script must never keep the screen frozen past its bracket.
        releaseDeferredRepaint(definition.id);
      }
      return undefined;
    }
    case "api.cancelBatch": {
      const lib = await getLib();
      try {
        await lib.cancelUndoTransaction();
      } finally {
        // The cancel REVERTED whatever the batch wrote, so the single release
        // repaint is what takes the reverted state to the screen.
        releaseDeferredRepaint(definition.id);
      }
      return undefined;
    }

    // ---- unlocked: formatting (B2) ----
    case "api.setRangeFormat": {
      const [startRow, startCol, endRow, endCol, format, sheetRef] = args as
        [number, number, number, number, FormattingOptions, (number | string)?];
      const lib = await getLib();
      const target = await resolveOptionalSheetRef(lib, sheetRef, "setRangeFormat");
      await applyRangeFormat(lib, target, startRow, startCol, endRow, endCol, format);
      return undefined;
    }
    case "api.clearRangeFormat": {
      const [startRow, startCol, endRow, endCol, sheetRef] = args as
        [number, number, number, number, (number | string)?];
      const lib = await getLib();
      await clearRangeFormat(lib, sheetRef, startRow, startCol, endRow, endCol);
      return undefined;
    }
    case "api.getRangeFormat": {
      // Format READ-BACK (Wave 3): the inverse of api.setRangeFormat, on any
      // sheet (index or name — the Wave-1 resolver owns the slot).
      const [startRow, startCol, endRow, endCol, sheetRef] = args as
        [number, number, number, number, (number | string)?];
      const lib = await getLib();
      const target = await resolveOptionalSheetRef(lib, sheetRef, "getRangeFormat");
      return readRangeFormats(lib, target, startRow, startCol, endRow, endCol);
    }
    case "api.getCellFormat": {
      const [row, col, sheetRef] = args as [number, number, (number | string)?];
      const lib = await getLib();
      const target = await resolveOptionalSheetRef(lib, sheetRef, "getCellFormat");
      return readCellFormat(lib, target, row, col);
    }

    // ---- unlocked: named cell styles + theme palette (Wave 4) ----
    case "api.listNamedStyles": {
      const lib = await getLib();
      const styles = await lib.getNamedStyles();
      return styles.map(
        (s): ScriptNamedStyleInfo => ({ name: s.name, builtIn: s.builtIn, category: s.category }),
      );
    }
    case "api.applyNamedStyle": {
      const [name, startRow, startCol, endRow, endCol, sheetRef] = args as
        [string, number, number, number, number, (number | string)?];
      const lib = await getLib();
      await executeApplyNamedStyle(lib, name, startRow, startCol, endRow, endCol, sheetRef);
      return undefined;
    }
    case "api.createNamedStyle": {
      const [name, format] = args as [string, ScriptRangeFormat];
      const lib = await getLib();
      return executeCreateNamedStyle(lib, name, format);
    }
    case "api.deleteNamedStyle": {
      const [name] = args as [string];
      const lib = await getLib();
      await lib.deleteNamedStyle(name);
      return undefined;
    }
    case "api.getThemePalette": {
      const lib = await getLib();
      const theme = await lib.getDocumentTheme();
      const colors: Record<string, string> = {};
      for (const [slot, hex] of Object.entries(theme.colors)) {
        colors[slot] = applyThemeTint(hex as string, 0);
      }
      return {
        name: theme.name,
        colors,
        fonts: { heading: theme.fonts.heading, body: theme.fonts.body },
      };
    }

    // ---- unlocked: calculation control (Wave 3, item 7) ----
    case "api.getCalculationMode": {
      const lib = await getLib();
      const mode = await lib.getCalculationMode();
      return mode === "manual" ? "manual" : "automatic";
    }
    case "api.setCalculationMode": {
      const [mode] = args as ["automatic" | "manual"];
      const lib = await getLib();
      return executeSetCalculationMode(lib, definition.id, mode);
    }
    case "api.recalculate": {
      const [options] = args as [{ full?: boolean }?];
      const lib = await getLib();
      return executeRecalculate(lib, options);
    }

    // ---- unlocked: sheet protection (Wave 3, item 8) ----
    // The backend protection commands address the ACTIVE sheet only, so a
    // sheet ref naming another one is refused with the fix spelled out
    // (assertActiveSheet), exactly like the structure rows above.
    case "api.protectSheet": {
      const [options, sheetRef] = args as
        [ScriptProtectSheetOptions?, (number | string)?];
      const lib = await getLib();
      await assertActiveSheet(lib, sheetRef, "protectSheet");
      return executeProtectSheet(lib, options);
    }
    case "api.unprotectSheet": {
      const [password, sheetRef] = args as [(string | null)?, (number | string)?];
      const lib = await getLib();
      await assertActiveSheet(lib, sheetRef, "unprotectSheet");
      return executeUnprotectSheet(lib, password ?? undefined);
    }
    case "api.getProtectionStatus": {
      const [sheetRef] = args as [(number | string)?];
      const lib = await getLib();
      await assertActiveSheet(lib, sheetRef, "getProtectionStatus");
      const status = await lib.getProtectionStatus();
      return {
        protected: status.isProtected,
        hasPassword: status.hasPassword,
        options: status.options,
      } satisfies ScriptProtectionStatus;
    }

    // ---- unlocked: the api.withUnprotected pair ----
    // The worker helper is the composite; these are its two halves. The RESTORE
    // is a host debt (see the executors), which is what makes the helper safe
    // against a realm that never runs its own finally.
    case "api.beginUnprotected": {
      const [password, sheetRef] = args as [(string | null)?, (number | string)?];
      const lib = await getLib();
      return executeBeginUnprotected(lib, definition.id, password ?? undefined, sheetRef);
    }
    case "api.endUnprotected": {
      const [token] = args as [(string | null)?];
      const lib = await getLib();
      return executeEndUnprotected(lib, definition.id, token ?? null);
    }

    // ---- unlocked: scenarios (What-If) ----
    // Six thin rows over the six scenario_* commands. scenarioShow CALLS
    // scenario_show — the transient-write precedent — rather than repeating it.
    case "api.scenarios": {
      const [sheetRef] = args as [(number | string)?];
      const lib = await getLib();
      return executeScenarios(lib, sheetRef);
    }
    case "api.scenarioAdd": {
      const [params] = args as [ScriptScenarioAddParams];
      const lib = await getLib();
      return executeScenarioAdd(lib, params);
    }
    case "api.scenarioShow": {
      const [name, sheetRef] = args as [string, (number | string)?];
      const lib = await getLib();
      return executeScenarioShow(lib, definition.id, name, sheetRef);
    }
    case "api.scenarioDelete": {
      const [name, sheetRef] = args as [string, (number | string)?];
      const lib = await getLib();
      return executeScenarioDelete(lib, name, sheetRef);
    }
    case "api.scenarioSummary": {
      const [options] = args as [ScriptScenarioSummaryOptions?];
      const lib = await getLib();
      return executeScenarioSummary(lib, options);
    }
    case "api.scenarioMerge": {
      const [fromSheet, toSheet] = args as [number | string, (number | string)?];
      const lib = await getLib();
      return executeScenarioMerge(lib, fromSheet, toSheet);
    }

    // ---- unlocked: consolidate (Data ▸ Consolidate) ----
    case "api.consolidate": {
      const [params] = args as [ScriptConsolidateParams];
      const lib = await getLib();
      return executeConsolidate(lib, definition.id, params);
    }

    // ---- unlocked: structure (B2; sheet-addressable since Wave 3) ----
    // The backend commands take an optional sheetIndex with the full off-sheet
    // guard chain (protection, spill, writeback claims, sheet-tagged undo,
    // cross-sheet formula rewrite, recalc). A non-visible target returns NO
    // repaint payload — the sheet re-materializes from backend state on switch
    // — so the canvas refresh is skipped for it. setRowHeight/setColumnWidth
    // stay ACTIVE-SHEET-ONLY: those two commands still have no sheet param.
    case "api.insertRows":
    case "api.deleteRows":
    case "api.insertColumns":
    case "api.deleteColumns": {
      const [start, count, sheetRef] = args as [number, number, (number | string)?];
      const lib = await getLib();
      await executeStructuralOp(
        lib,
        method.slice("api.".length) as StructuralOpName,
        start,
        count,
        sheetRef,
      );
      return undefined;
    }
    case "api.mergeCells": {
      const [startRow, startCol, endRow, endCol, sheetRef] = args as
        [number, number, number, number, (number | string)?];
      const lib = await getLib();
      await executeMergeCells(lib, definition.id, startRow, startCol, endRow, endCol, sheetRef);
      return undefined;
    }
    case "api.unmergeCells": {
      const [row, col, sheetRef] = args as [number, number, (number | string)?];
      const lib = await getLib();
      await executeUnmergeCells(lib, row, col, sheetRef);
      return undefined;
    }
    case "api.setRowHeight": {
      const [row, height, sheetIndex] = args as [number, number, (number | string)?];
      const lib = await getLib();
      await assertActiveSheet(lib, sheetIndex, "setRowHeight");
      await lib.setRowHeight(row, height);
      await syncDimensionToGrid("row", row, height);
      return undefined;
    }
    case "api.setColumnWidth": {
      const [col, width, sheetIndex] = args as [number, number, (number | string)?];
      const lib = await getLib();
      await assertActiveSheet(lib, sheetIndex, "setColumnWidth");
      await lib.setColumnWidth(col, width);
      await syncDimensionToGrid("column", col, width);
      return undefined;
    }
    case "api.autoFitColumns": {
      const [startCol, endCol, sheetIndex] = args as [number, number, (number | string)?];
      const lib = await getLib();
      return autoFitFromScript(lib, "columns", startCol, endCol, sheetIndex);
    }
    case "api.autoFitRows": {
      const [startRow, endRow, sheetIndex] = args as [number, number, (number | string)?];
      const lib = await getLib();
      return autoFitFromScript(lib, "rows", startRow, endRow, sheetIndex);
    }
    // Hide / unhide (VBA Rows("5:10").Hidden = True). The USER-hidden set is one
    // of three independent authorities — see the ALLOWLIST rows.
    case "api.setRowsHidden":
    case "api.setColumnsHidden": {
      const [start, end, hidden, sheetIndex] = args as
        [number, number, boolean, (number | string)?];
      const lib = await getLib();
      return executeSetLinesHidden(
        lib,
        method === "api.setRowsHidden" ? "rows" : "columns",
        start, end, hidden, sheetIndex,
      );
    }
    case "api.getHiddenRows":
    case "api.getHiddenColumns": {
      const [sheetIndex] = args as [(number | string)?];
      const lib = await getLib();
      return executeGetHiddenLines(
        lib, method === "api.getHiddenRows" ? "rows" : "columns", sheetIndex,
      );
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

    // ---- unlocked: PAGE SETUP + PRINT LAYOUT (Wave 4, SHEETS cluster). ----
    // Every backend print command acts on the ACTIVE SHEET (print.rs has no
    // sheet parameter), so the optional trailing sheet ref is refused unless
    // it names the active sheet — assertActiveSheet, the AutoFilter rule.
    // Mutations end with GRID_REFRESH so the Print extension's page-break
    // preview overlay repaints, exactly as its own menu handlers do.
    case "api.getPageSetup": {
      const [sheetRef] = args as [(number | string)?];
      const lib = await getLib();
      await assertActiveSheet(lib, sheetRef, "getPageSetup");
      return lib.getPageSetup();
    }
    case "api.setPageSetup": {
      // READ-MERGE-WRITE: the backend command takes the FULL PageSetup, the
      // script hands over a PATCH (vPageSetupPatch enumerated its keys), so
      // the current setup is read and only the named keys are replaced —
      // setRangeFormat's partial-write contract applied to the page.
      const [patch, sheetRef] = args as [Record<string, unknown>, (number | string)?];
      const lib = await getLib();
      await assertActiveSheet(lib, sheetRef, "setPageSetup");
      const current = await lib.getPageSetup();
      await lib.setPageSetup({ ...current, ...patch } as typeof current);
      emitAppEvent(AppEvents.GRID_REFRESH);
      return undefined;
    }
    case "api.setPrintArea": {
      const [startRow, startCol, endRow, endCol, sheetRef] = args as
        [number, number, number, number, (number | string)?];
      const lib = await getLib();
      await assertActiveSheet(lib, sheetRef, "setPrintArea");
      // Answers the A1 spelling the backend stored ("A1:F20"), so the script
      // can echo exactly what the Page Setup dialog would now show.
      const area = await lib.setPrintArea(startRow, startCol, endRow, endCol);
      emitAppEvent(AppEvents.GRID_REFRESH);
      return { area };
    }
    case "api.clearPrintArea": {
      const [sheetRef] = args as [(number | string)?];
      const lib = await getLib();
      await assertActiveSheet(lib, sheetRef, "clearPrintArea");
      await lib.clearPrintArea();
      emitAppEvent(AppEvents.GRID_REFRESH);
      return undefined;
    }
    case "api.addPageBreak":
    case "api.removePageBreak": {
      const [kind, index, sheetRef] = args as ["row" | "col", number, (number | string)?];
      const lib = await getLib();
      await assertActiveSheet(
        lib, sheetRef, method === "api.addPageBreak" ? "addPageBreak" : "removePageBreak",
      );
      if (method === "api.addPageBreak") {
        // A break sits ABOVE its row / LEFT of its column, so index 0 names a
        // break before the first row — a break with no page in front of it.
        // Refused with the reason, matching the Print menu's own guard.
        if (index <= 0) {
          throw new BrokerError(
            "ValidationError",
            `a ${kind === "row" ? "row" : "column"} page break cannot sit before the first ${
              kind === "row" ? "row" : "column"} (index must be >= 1)`,
          );
        }
        await (kind === "row" ? lib.insertRowPageBreak(index) : lib.insertColPageBreak(index));
      } else {
        await (kind === "row" ? lib.removeRowPageBreak(index) : lib.removeColPageBreak(index));
      }
      emitAppEvent(AppEvents.GRID_REFRESH);
      return undefined;
    }
    case "api.resetPageBreaks": {
      const [sheetRef] = args as [(number | string)?];
      const lib = await getLib();
      await assertActiveSheet(lib, sheetRef, "resetPageBreaks");
      await lib.resetAllPageBreaks();
      emitAppEvent(AppEvents.GRID_REFRESH);
      return undefined;
    }

    // ---- unlocked: OUTLINE GROUPING (Wave 4, SHEETS cluster), through the
    //      @api/groupingService seam the Grouping extension registers — the
    //      autoFilterService pattern, and for the same reason: only the
    //      extension's store pushes group-hidden rows/cols into the grid and
    //      sizes the outline bar, so bypassing it would group invisibly.
    //      requireGroupingController REFUSES (loudly) when the extension is
    //      disabled. ACTIVE SHEET ONLY, like the backend it drives. ----
    case "api.groupRows":
    case "api.ungroupRows":
    case "api.groupColumns":
    case "api.ungroupColumns": {
      const [start, end, sheetRef] = args as [number, number, (number | string)?];
      const lib = await getLib();
      await assertActiveSheet(lib, sheetRef, method.slice("api.".length));
      const { requireGroupingController } = await import("../groupingService");
      const controller = requireGroupingController();
      switch (method) {
        case "api.groupRows": return controller.groupRows(start, end);
        case "api.ungroupRows": return controller.ungroupRows(start, end);
        case "api.groupColumns": return controller.groupColumns(start, end);
        default: return controller.ungroupColumns(start, end);
      }
    }
    case "api.showOutlineLevel": {
      const [rowLevel, colLevel, sheetRef] = args as
        [(number | null)?, (number | null)?, (number | string)?];
      const lib = await getLib();
      await assertActiveSheet(lib, sheetRef, "showOutlineLevel");
      const { requireGroupingController } = await import("../groupingService");
      return requireGroupingController().showOutlineLevel(rowLevel ?? null, colLevel ?? null);
    }

    // ---- unlocked: sheet CRUD (B2) ----
    case "api.addSheet": {
      // Optional POSITION (Wave 4 — VBA's Add Before:=/After:=). The backend
      // has no position parameter (add_sheet always appends), so the position
      // is composed as add + move under ONE undo transaction: the anchor is
      // resolved against the PRE-ADD list (an append never renumbers it), the
      // final index computed there, and move_sheet rotates the new sheet into
      // place. A failed move CANCELS the transaction and rethrows — the caller
      // is never told half the truth. (Sheet CRUD records no undo entries
      // today, so the empty transaction commits as a no-op; the bracket is
      // what keeps this one step if that ever changes.)
      const [name, position] = args as [
        string?,
        { before?: number | string | null; after?: number | string | null }?,
      ];
      const lib = await getLib();
      if (name !== undefined && name !== null) {
        await assertSheetNameFree(lib, name, null);
      }
      const before = await lib.getSheets();
      const target = resolveSheetPosition(before.sheets, position, "addSheet");
      if (target === null) {
        const result = await lib.addSheet(name ?? undefined);
        await announceSheetsChanged(result);
        // add_sheet makes the new sheet active — resolve it by INDEX FIELD, not
        // by array position (the two diverge once a sheet has been deleted).
        const added = result.sheets.find((s) => s.index === result.activeIndex);
        return { index: added?.index ?? result.activeIndex, name: added?.name ?? "" };
      }
      await lib.beginUndoTransaction("Add sheet");
      let result;
      try {
        result = await lib.addSheet(name ?? undefined);
        const appendedAt = result.activeIndex;
        if (target !== appendedAt) {
          result = await lib.moveSheet(appendedAt, target);
        }
        await lib.commitUndoTransaction();
      } catch (e) {
        try {
          await lib.cancelUndoTransaction();
        } catch {
          /* the throw below is the primary failure */
        }
        throw e;
      }
      await announceSheetsChanged(result);
      const added = result.sheets.find((s) => s.index === target);
      return { index: added?.index ?? target, name: added?.name ?? "" };
    }
    case "api.deleteSheet": {
      const [ref] = args as [number | string];
      const lib = await getLib();
      const before = await lib.getSheets();
      const index = resolveSheetRefIn(before.sheets, ref, "deleteSheet");
      if (before.sheets.length <= 1) {
        throw new BrokerError("ValidationError", "Cannot delete the last remaining sheet");
      }
      const result = await lib.deleteSheet(index);
      await announceSheetsChanged(result);
      return undefined;
    }
    case "api.renameSheet": {
      const [ref, newName] = args as [number | string, string];
      const lib = await getLib();
      const index = await resolveSheetRef(lib, ref, "renameSheet");
      await assertSheetNameFree(lib, newName, index);
      const result = await lib.renameSheet(index, newName);
      await announceSheetsChanged(result);
      return undefined;
    }
    case "api.setSheetVisibility": {
      const [ref, visibility] = args as [number | string, "visible" | "hidden" | "veryHidden"];
      const lib = await getLib();
      const before = await lib.getSheets();
      const index = resolveSheetRefIn(before.sheets, ref, "setSheetVisibility");
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
      const [fromRef, toIndex] = args as [number | string, number];
      const lib = await getLib();
      const before = await lib.getSheets();
      const fromIndex = resolveSheetRefIn(before.sheets, fromRef, "moveSheet");
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
      const [sourceRef, newName, position] = args as [
        number | string,
        string?,
        { before?: number | string | null; after?: number | string | null }?,
      ];
      const lib = await getLib();
      const before = await lib.getSheets();
      const sourceIndex = resolveSheetRefIn(before.sheets, sourceRef, "copySheet");
      if (newName !== undefined && newName !== null) {
        await assertSheetNameFree(lib, newName, null);
      }
      // Optional POSITION (Wave 4), same construction as addSheet: the anchor
      // resolves against the PRE-COPY list, the final index is computed in the
      // list WITHOUT the copy, and move_sheet rotates the copy there — which
      // yields exactly "the base list with the copy inserted at target".
      const target = resolveSheetPosition(before.sheets, position, "copySheet");
      let result;
      let added: { index: number; name: string } | undefined;
      if (target === null) {
        result = await lib.copySheet(sourceIndex, newName ?? undefined);
        const beforeNames = new Set(before.sheets.map((s) => s.name));
        added = result.sheets.find((s) => !beforeNames.has(s.name));
      } else {
        await lib.beginUndoTransaction("Copy sheet");
        try {
          result = await lib.copySheet(sourceIndex, newName ?? undefined);
          const beforeNames = new Set(before.sheets.map((s) => s.name));
          const copy = result.sheets.find((s) => !beforeNames.has(s.name));
          if (copy && copy.index !== target) {
            result = await lib.moveSheet(copy.index, target);
            added = copy ? result.sheets.find((s) => s.name === copy.name) : undefined;
          } else {
            added = copy;
          }
          await lib.commitUndoTransaction();
        } catch (e) {
          try {
            await lib.cancelUndoTransaction();
          } catch {
            /* the throw below is the primary failure */
          }
          throw e;
        }
      }
      await announceSheetsChanged(result);
      if (!added) {
        throw new BrokerError("HostError", "The sheet was copied but the new sheet could not be identified");
      }
      return { index: added.index, name: added.name };
    }

    // ---- unlocked: sort + find/replace (B2; sheet-addressable since Wave 3) ----
    case "api.sortRange": {
      // vSortRange already enforced the field shape (key/ascending/sortOn/...),
      // so the cast lands on a validated payload.
      const [startRow, startCol, endRow, endCol, fields, options, sheetRef] = args as [
        number, number, number, number,
        Parameters<Awaited<ReturnType<typeof getLib>>["sortRange"]>[4],
        { matchCase?: boolean; hasHeaders?: boolean; orientation?: "rows" | "columns" } | undefined,
        (number | string)?,
      ];
      const lib = await getLib();
      return executeSortRange(
        lib, definition.id, startRow, startCol, endRow, endCol, fields, options, sheetRef,
      );
    }
    // ---- the WorksheetFunction bridge (G4) ----
    // Nothing is written and nothing is remembered: the Rust command builds a
    // throwaway evaluator over the live grid, answers, and drops it. So this is
    // a READ, and its reach is exactly api.getRangeValues' reach.
    case "api.evaluate": {
      const [expressions, options] = args as
        [string[], { sheetIndex?: number | string } | undefined];
      const mod = await import("../formulaEval");
      const lib = await getLib();
      const target = await resolveOptionalSheetRef(lib, options?.sheetIndex, "evaluate");
      return mod.evaluateFormulasTyped(expressions, target);
    }
    // ---- explicit formula read/write, A1 or R1C1 (G4) ----
    case "api.getCellFormula": {
      const [row, col, options] = args as [number, number, ScriptFormulaOptions | undefined];
      const lib = await getLib();
      const target = await resolveOptionalSheetRef(lib, options?.sheetIndex, "getCellFormula");
      return readCellFormula(lib, target, row, col, options?.style);
    }
    case "api.setCellFormula": {
      const [row, col, formula, options] = args as
        [number, number, string | null, ScriptFormulaOptions | undefined];
      const lib = await getLib();
      const target = await resolveOptionalSheetRef(lib, options?.sheetIndex, "setCellFormula");
      await writeCellFormula(lib, definition.id, target, row, col, formula, options?.style);
      return undefined;
    }
    // ---- range copy / paste / paste special (G4) ----
    case "api.copyRange": {
      const [startRow, startCol, endRow, endCol, sheetRef] = args as
        [number, number, number, number, (number | string)?];
      const lib = await getLib();
      return copyRangeToScriptClipboard(lib, definition.id, sheetRef, startRow, startCol, endRow, endCol);
    }
    case "api.pasteRange": {
      const [row, col, options] = args as [number, number, ScriptPasteOptions | undefined];
      const lib = await getLib();
      return pasteScriptClipboard(lib, definition.id, row, col, options ?? {});
    }
    case "api.fillRange": {
      const [startRow, startCol, endRow, endCol, options, sheetRef] = args as [
        number, number, number, number, ScriptFillOptions | undefined, (number | string)?,
      ];
      const lib = await getLib();
      return fillRangeFromScript(
        lib, definition.id, startRow, startCol, endRow, endCol, options ?? {}, sheetRef,
      );
    }
    case "api.findAll": {
      const [query, options] = args as [string, ScriptFindAllOptions | undefined];
      const lib = await getLib();
      return executeFindAll(lib, query, options);
    }
    case "api.replaceAll": {
      const [search, replacement, options] = args as
        [string, string, ScriptReplaceAllOptions | undefined];
      const lib = await getLib();
      return executeReplaceAll(lib, definition.id, search, replacement, options);
    }

    // ---- unlocked: range ops (Wave 4, RANGE-OPS cluster) ----
    case "api.removeDuplicates": {
      const [startRow, startCol, endRow, endCol, options, sheetRef] = args as [
        number, number, number, number, ScriptRemoveDuplicatesOptions | undefined,
        (number | string)?,
      ];
      const lib = await getLib();
      return executeRemoveDuplicates(
        lib, definition.id, startRow, startCol, endRow, endCol, options, sheetRef,
      );
    }
    case "api.textToColumns": {
      const [startRow, startCol, endRow, endCol, options] = args as [
        number, number, number, number, ScriptTextToColumnsOptions | undefined,
      ];
      const lib = await getLib();
      return executeTextToColumns(
        lib, definition.id, startRow, startCol, endRow, endCol, options,
      );
    }
    case "api.getSpecialCells": {
      const [startRow, startCol, endRow, endCol, kind, sheetRef] = args as [
        number, number, number, number,
        "constants" | "formulas" | "blanks" | "visible", (number | string)?,
      ];
      const lib = await getLib();
      return executeGetSpecialCells(lib, startRow, startCol, endRow, endCol, kind, sheetRef);
    }
    case "api.goalSeek": {
      const [params] = args as [ScriptGoalSeekParams];
      const lib = await getLib();
      return executeGoalSeek(lib, definition.id, params);
    }

    // ---- unlocked: data validation (Wave 3, item 5) ----
    case "api.setDataValidation": {
      const [startRow, startCol, endRow, endCol, rule, sheetRef] = args as
        [number, number, number, number, ScriptValidationRule, (number | string)?];
      const lib = await getLib();
      await executeSetDataValidation(lib, startRow, startCol, endRow, endCol, rule, sheetRef);
      return undefined;
    }
    case "api.clearDataValidation": {
      const [range, sheetRef] = args as [ScriptRangeBox, (number | string)?];
      const lib = await getLib();
      await executeClearDataValidation(lib, range, sheetRef);
      return undefined;
    }
    case "api.getDataValidation": {
      const [row, col, sheetRef] = args as [number, number, (number | string)?];
      const lib = await getLib();
      return executeGetDataValidation(lib, row, col, sheetRef);
    }
    case "api.listDataValidations": {
      const [sheetRef] = args as [(number | string)?];
      const lib = await getLib();
      return executeListDataValidations(lib, sheetRef);
    }

    // ---- unlocked: hyperlinks (Wave 3, item 6) ----
    // NO follow, by design: scripts attach/read/remove links; opening one is
    // the user's click (external targets leave the sandbox entirely; internal
    // navigation from a script is api.select / api.scrollTo).
    case "api.addHyperlink": {
      const [row, col, link, options, sheetRef] = args as [
        number, number, ScriptHyperlinkSpec,
        ScriptHyperlinkOptions | undefined, (number | string)?,
      ];
      const lib = await getLib();
      return executeAddHyperlink(lib, row, col, link, options, sheetRef);
    }
    case "api.removeHyperlink": {
      const [row, col, sheetRef] = args as [number, number, (number | string)?];
      const lib = await getLib();
      return executeRemoveHyperlink(lib, row, col, sheetRef);
    }
    case "api.getHyperlink": {
      const [row, col, sheetRef] = args as [number, number, (number | string)?];
      const lib = await getLib();
      return executeGetHyperlink(lib, row, col, sheetRef);
    }
    case "api.listHyperlinks": {
      const [sheetRef] = args as [(number | string)?];
      const lib = await getLib();
      return executeListHyperlinks(lib, sheetRef);
    }

    // ---- unlocked: selection + navigation (Wave 2) ----
    case "api.getSelection": {
      // COORDINATES ONLY, from Core's live grid state — the same snapshot the
      // ribbon reads. Never cell contents: those stay behind the read rows.
      const gridApi = await import("../grid");
      const state = gridApi.getGridStateSnapshot();
      const sel = state?.selection;
      if (!state || !sel) return null;
      return normalizeSelection(sel, state.sheetContext?.activeSheetIndex ?? 0);
    }
    case "api.select": {
      // Application.Goto + Range.Select. The broker only ever sees NUMBERS
      // here — the A1-string spelling resolves worker-side (contextShims) —
      // plus an optional sheet ref resolved against the live list (Wave 1).
      const [startRow, startCol, endRowArg, endColArg, options] = args as
        [number, number, number?, number?, ScriptSelectOptions?];
      const endRow = endRowArg ?? startRow;
      const endCol = endColArg ?? startCol;
      const opts = options ?? {};
      if (opts.sheetIndex !== undefined && opts.sheetIndex !== null) {
        const lib = await getLib();
        const { sheets, activeIndex } = await lib.getSheets();
        const target = resolveSheetRefIn(sheets, opts.sheetIndex, "select");
        if (target !== activeIndex) {
          // Selection lives on the ACTIVE sheet in Core, so naming another
          // sheet activates it first — the same announce path setActiveSheet
          // takes, or the tab bar and the canvas would disagree.
          await announceSheetsChanged(await lib.setActiveSheet(target));
        }
      }
      const scroll = opts.scroll !== false;
      const extraAreas = (opts.ranges ?? []).map(normalizeSelectionArea);
      const [gridApi, dispatchMod] = await Promise.all([
        import("../grid"),
        import("../gridDispatch"),
      ]);
      if (extraAreas.length > 0) {
        // Multi-area: SET_SELECTION already carries additionalRanges (the
        // Select-Visible-Cells / Go To Special shape) — one dispatch.
        dispatchMod.dispatchGridAction(gridApi.setSelection({
          startRow, startCol, endRow, endCol,
          type: "cells",
          additionalRanges: extraAreas,
        }));
        if (scroll) {
          dispatchMod.dispatchGridAction(gridApi.scrollToCell(endRow, endCol, false));
        }
        gridApi.refreshGridData();
      } else if (scroll) {
        // The same NAVIGATE_TO_CELL choreography pivot creation uses:
        // selection + scroll + canvas refresh in the right order.
        gridApi.navigateToRange(startRow, startCol, endRow, endCol);
      } else {
        dispatchMod.dispatchGridAction(
          gridApi.setSelection(startRow, startCol, endRow, endCol, "cells"),
        );
      }
      return undefined;
    }
    case "api.scrollTo": {
      // ScrollIntoView: bring a cell on screen WITHOUT touching the selection.
      const [row, col, sheetRef] = args as [number, number, (number | string)?];
      if (sheetRef !== undefined && sheetRef !== null) {
        const lib = await getLib();
        const { sheets, activeIndex } = await lib.getSheets();
        const target = resolveSheetRefIn(sheets, sheetRef, "scrollTo");
        if (target !== activeIndex) {
          await announceSheetsChanged(await lib.setActiveSheet(target));
        }
      }
      const gridApi = await import("../grid");
      // select: false is the whole point — scroll only.
      gridApi.navigateToCell(row, col, false);
      return undefined;
    }
    case "api.clearRange": {
      // Range.Clear / ClearContents / ClearFormats over the existing
      // clear_range_with_options backend (which opens its own transaction, so
      // one call is ONE undo entry — see the B2 note above about not nesting).
      // Sheet-addressable since Wave 3: the Wave-2 active-sheet residual is
      // CLOSED — the Rust command grew a sheetIndex with the full off-sheet
      // guard chain, so the activate-clear-restore dance never happened.
      const [startRow, startCol, endRow, endCol, options, sheetRef] = args as [
        number, number, number, number,
        ({ applyTo?: "all" | "contents" | "formats" } | undefined)?,
        (number | string)?,
      ];
      const lib = await getLib();
      return executeClearRange(
        lib, definition.id, startRow, startCol, endRow, endCol, options, sheetRef,
      );
    }
    case "api.getSheets": {
      // The rich sheet listing (Wave 2): getSheetNames discards visibility and
      // tab colour that lib.getSheets already returns — this row stops that.
      const lib = await getLib();
      const { sheets } = await lib.getSheets();
      return sheets.map((s) => ({
        index: s.index,
        name: s.name,
        visibility: s.visibility,
        tabColor: s.tabColor ?? null,
      }));
    }
    case "api.setTabColor": {
      // The one sheet attribute the CRUD rows left write-only-from-the-UI. The
      // sheet may be named (Wave 1 rules); null removes the colour — the
      // backend stores "" for "no colour", which build_sheet_list reports back
      // as an absent tabColor.
      const [ref, color] = args as [number | string, string | null];
      const lib = await getLib();
      const index = await resolveSheetRef(lib, ref, "setTabColor");
      const result = await lib.setTabColor(index, color ?? "");
      await announceSheetsChanged(result);
      return undefined;
    }

    // ---- unlocked: range discovery (Wave 2) ----
    // Range.End / CurrentRegion / UsedRange over the get_range_edge /
    // get_current_region / get_used_range commands — ONE implementation
    // (engine::navigation) behind the keyboard's Ctrl+Arrow, these rows and
    // the QuickJS ops, so a script and a keystroke can never disagree about
    // where an edge is. Results are rebuilt field-by-field (house rule: a
    // field added to the backend result later is absent here by default
    // instead of crossing to scripts by default).
    case "api.getRangeEdge": {
      const [row, col, direction, sheetRef] = args as
        [number, number, "up" | "down" | "left" | "right", (number | string)?];
      const lib = await getLib();
      const target = await resolveOptionalSheetRef(lib, sheetRef, "getRangeEdge");
      const edge = await lib.getRangeEdge(row, col, direction, target);
      return { row: edge.row, col: edge.col };
    }
    case "api.getCurrentRegion": {
      // `empty: true` = the seed cell is isolated; the rectangle then collapses
      // to the seed cell itself (the VBA CurrentRegion convention, and exactly
      // what the backend returns).
      const [row, col, sheetRef] = args as [number, number, (number | string)?];
      const lib = await getLib();
      const target = await resolveOptionalSheetRef(lib, sheetRef, "getCurrentRegion");
      const region = await lib.getCurrentRegion(row, col, target);
      return {
        startRow: region.startRow,
        startCol: region.startCol,
        endRow: region.endRow,
        endCol: region.endCol,
        empty: region.empty,
      };
    }
    case "api.getUsedRange": {
      // `empty: true` = the sheet stores nothing at all (the coordinates are
      // then meaningless zeros — the shim's sheet.usedRange() maps this to null).
      const [sheetRef] = args as [(number | string)?];
      const lib = await getLib();
      const target = await resolveOptionalSheetRef(lib, sheetRef, "getUsedRange");
      const used = await lib.getUsedRange(target);
      return {
        startRow: used.startRow,
        startCol: used.startCol,
        endRow: used.endRow,
        endCol: used.endCol,
        empty: used.empty,
      };
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

    // ---- unlocked: the APPLICATION cluster (Wave 4) ----
    case "api.setStatusBar": {
      // Lands in the SAME service the QuickJS DeferredAction::SetStatusBar
      // lands in (@api/grid setStatusBarText -> STATUS_BAR_TEXT_CHANGED), so
      // both script surfaces drive one status bar. The worker realm is async,
      // so a long-running script's progress messages appear LIVE mid-run.
      const [text] = args as [string | null];
      await executeSetStatusBar(definition.id, text);
      return undefined;
    }
    case "api.runMacro": {
      // VBA's Application.Run, through the @api/macroRunService seam.
      const [ref] = args as [string];
      return executeRunMacro(ref);
    }
    case "api.userName": {
      // The SAME display name writeback submissions carry (derived from the
      // Windows user name by calp::identity_provider) — one identity for the
      // whole app, read through the existing calp_get_subscriber_identity
      // command. Nothing else from the identity is disclosed (no machine id).
      const dist = await import("../distribution");
      return (await dist.getSubscriberIdentity()).displayName;
    }
    case "api.getViewOption": {
      const [name] = args as [ScriptViewOptionName];
      return executeGetViewOption(name);
    }
    case "api.setViewOption": {
      const [name, value] = args as [ScriptViewOptionName, boolean | string];
      await executeSetViewOption(name, value);
      return undefined;
    }
    case "api.getZoom": {
      // PERCENT, matching the setter — @api/grid owns the factor conversion.
      const grid = await import("../grid");
      return grid.getZoom();
    }
    case "api.setZoom": {
      // vZoom proved 10..400; @api/grid setZoomLevel is the same setter the
      // View menu and Ctrl+scroll drive, so Core's own clamp still applies.
      const [percent] = args as [number];
      const grid = await import("../grid");
      grid.setZoomLevel(percent);
      return undefined;
    }
    case "api.getPanes": {
      return executeGetPanes();
    }

    // ---- unlocked: workbook objects (B3) ----
    case "api.listObjects": {
      const [kind] = args as [ScriptObjectKind];
      return listWorkbookObjects(kind);
    }
    case "api.createChart": {
      const [spec, rawOptions] = args as [
        Record<string, unknown>,
        (Omit<ChartCreateOptions, "sheetIndex"> & { sheetIndex?: number | string })?,
      ];
      // The placement's sheet may be named; the chart store speaks indexes.
      let options = rawOptions as ChartCreateOptions | undefined;
      if (rawOptions && rawOptions.sheetIndex !== undefined) {
        const lib = await getLib();
        options = {
          ...rawOptions,
          sheetIndex: await resolveSheetRef(lib, rawOptions.sheetIndex, "createChart"),
        };
      }
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
    // PICTURES. The whole ingress question is answered by the arguments: the
    // only image argument is a `media:` handle, already validated as such by
    // vCreatePicture, and there is no bytes/path parameter for a caller to
    // reach for. So this executor's job is placement, not admission.
    //
    // ACTIVE SHEET only, exactly like api.createTable above and for the same
    // reason: a control's geometry is derived from the live sheet's row heights
    // and column widths, and the overlay hit-test regions are sheet-blind — a
    // control created "for" another sheet paints on the one in front of the
    // user. There is therefore no sheet argument to refuse.
    //
    // The placement itself goes through the feature-neutral seam
    // (@api/pictureControlService), never through set_control_metadata here: a
    // hand-rolled control writes successfully and renders nothing, which is the
    // failure the button seam already exists to prevent.
    case "api.createPicture": {
      const [mediaRef, anchor, options] = args as [
        string,
        { row: number; col: number },
        { width?: number; height?: number; name?: string } | undefined,
      ];
      const pictures = await import("../pictureControlService");
      if (!pictures.hasPictureControlProvider()) {
        throw new BrokerError(
          "HostError",
          "The Controls extension is not loaded, so pictures are unavailable",
        );
      }
      const lib = await getLib();
      const { activeIndex } = await lib.getSheets();
      const handle = await pictures.requirePictureControlProvider().createPicture({
        sheetIndex: activeIndex,
        row: anchor.row,
        col: anchor.col,
        mediaRef,
        width: options?.width,
        height: options?.height,
        name: options?.name,
      });
      await announceObjectsChanged();
      return handle;
    }
    // SHAPES. The placement rules are the picture row's, one step simpler: the
    // only thing named is a CATALOG ID, so there is not even a handle to
    // validate here — an id the catalog does not hold is refused by the
    // provider, with every accepted id in the message.
    //
    // ACTIVE SHEET only (api.createTable's rule), and the seam is the ONLY way
    // in: a hand-rolled shape needs seventeen property keys, an explicit
    // `pinToGrid: "false"` and three registrations, and getting any of that
    // wrong writes successfully and draws nothing.
    case "api.createShape": {
      const [shapeType, anchor, options] = args as [
        string,
        { row: number; col: number },
        { width?: number; height?: number; text?: string; name?: string } | undefined,
      ];
      const controls = await import("../controlsService");
      if (!controls.hasControlsProvider()) {
        throw new BrokerError(
          "HostError",
          "The Controls extension is not loaded, so shapes are unavailable",
        );
      }
      const lib = await getLib();
      const { activeIndex } = await lib.getSheets();
      const handle = await controls.requireControlsProvider().createShape({
        sheetIndex: activeIndex,
        row: anchor.row,
        col: anchor.col,
        shapeType,
        width: options?.width,
        height: options?.height,
        text: options?.text,
        name: options?.name,
      });
      await announceObjectsChanged();
      return handle;
    }
    // Deleting is INSTANCE-addressed (the id api.listObjects("shape") reports),
    // and the id encodes the anchor's sheet — so the active-sheet rule is
    // enforced by reading the sheet OUT of the id rather than by taking a sheet
    // argument. The seam performs the same full teardown the user's Delete key
    // does, object script included: a control's instanceId is derived from its
    // anchor, so a script left behind at a deleted control's anchor is
    // inherited by whatever is created there next.
    case "api.deleteShape": {
      const [instanceId] = args as [string];
      const controls = await import("../controlsService");
      if (!controls.hasControlsProvider()) {
        throw new BrokerError(
          "HostError",
          "The Controls extension is not loaded, so shapes are unavailable",
        );
      }
      const anchorSheet = controlSheetFromInstanceId(instanceId);
      if (anchorSheet === null) {
        throw new BrokerError(
          "ValidationError",
          `"${instanceId}" is not a control id. Use the id api.shapes() reports.`,
        );
      }
      const lib = await getLib();
      await assertActiveSheet(lib, anchorSheet, "deleteShape");
      const removed = await controls.requireControlsProvider().deleteControl(instanceId);
      if (!removed) {
        throw new BrokerError("ValidationError", `No control with id "${instanceId}"`);
      }
      await announceObjectsChanged();
      return undefined;
    }
    // ---- FLOATING RANGES. Id-addressed straight at the backend (the backend
    //      resolves the backing sheet from the stable id — the script layer
    //      never sees a sheet index for the cells). Writes ride the ordinary
    //      undoable, recalculating off-sheet edit path; delete ends the undo
    //      history exactly like deleting a sheet, which the row's desc says.
    //      The setState aspect door refuses this kind by name (vSetState).
    case "api.createFloatingRange": {
      const [options] = args as [
        { name?: string; x?: number; y?: number; rows?: number; cols?: number } | undefined,
      ];
      const { invokeBackend } = await import("../backend");
      const created = await invokeBackend<FloatingRangeWire>("create_floating_range", {
        name: options?.name ?? null,
        x: options?.x ?? 40,
        y: options?.y ?? 40,
      });
      if (!created) {
        throw new BrokerError("HostError", "create_floating_range returned nothing");
      }
      let info = created;
      const rows = options?.rows ?? 1;
      const cols = options?.cols ?? 1;
      if (rows > 1 || cols > 1) {
        info =
          (await invokeBackend<FloatingRangeWire>("update_floating_range", {
            id: created.id,
            patch: { rowCount: rows, colCount: cols },
          })) ?? created;
      }
      announceFloatingRangesChanged();
      return floatingRangeToRef({
        id: info.id,
        name: info.name,
        hostSheetIndex: info.hostSheetIndex,
        rowCount: info.rowCount,
        colCount: info.colCount,
      });
    }
    case "api.deleteFloatingRange": {
      const [id] = args as [string];
      const { invokeBackend } = await import("../backend");
      await invokeBackend("delete_floating_range", { id });
      announceFloatingRangesChanged();
      return undefined;
    }
    case "api.floatingRangeResize": {
      const [id, rows, cols] = args as [string, number, number];
      const { invokeBackend } = await import("../backend");
      const info = await invokeBackend<FloatingRangeWire>("update_floating_range", {
        id,
        patch: { rowCount: rows, colCount: cols },
      });
      if (!info) throw new BrokerError("ValidationError", `No floating range with id "${id}"`);
      announceFloatingRangesChanged();
      return floatingRangeToRef({
        id: info.id,
        name: info.name,
        hostSheetIndex: info.hostSheetIndex,
        rowCount: info.rowCount,
        colCount: info.colCount,
      });
    }
    case "api.floatingRangeSetCells": {
      const [id, startRow, startCol, values] = args as [
        string,
        number,
        number,
        (string | number | boolean | null)[][],
      ];
      const { invokeBackend } = await import("../backend");
      // Per-cell through the ONE write door (the same command the in-app editor
      // commits through), values in invariant (canonical US) form — the split
      // update_cells_batch makes for every script-typed write.
      for (let r = 0; r < values.length; r++) {
        for (let c = 0; c < values[r].length; c++) {
          const v = values[r][c];
          const text =
            v === null ? "" : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v);
          await invokeBackend("update_floating_range_cell", {
            id,
            row: startRow + r,
            col: startCol + c,
            value: text,
            invariant: true,
          });
        }
      }
      announceFloatingRangesChanged();
      return undefined;
    }
    case "api.floatingRangeGetCells": {
      const [id] = args as [string];
      const { invokeBackend } = await import("../backend");
      const rows = await invokeBackend<FloatingRangeWire[]>("list_floating_ranges", {});
      const info = (rows ?? []).find((fr) => fr.id === id);
      if (!info) throw new BrokerError("ValidationError", `No floating range with id "${id}"`);
      const cells = await invokeBackend<
        Array<{ row: number; col: number; kind: string; value: unknown; formula?: string | null }>
      >("get_floating_range_cells", {
        id,
        startRow: 0,
        startCol: 0,
        endRow: Math.max(0, info.rowCount - 1),
        endCol: Math.max(0, info.colCount - 1),
      });
      return {
        rowCount: info.rowCount,
        colCount: info.colCount,
        // SPARSE, exactly as the backend answers: only cells that exist.
        cells: (cells ?? []).map((c) => ({
          row: c.row,
          col: c.col,
          kind: c.kind,
          value: c.value,
          formula: c.formula ?? undefined,
        })),
      };
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
      // A table delete CASCADES into the slicers bound to it and prunes it out
      // of the ribbon filters that named it, so the announcement has to reach
      // those stores — "objects" does not. See announceObjectCascade.
      await announceObjectCascade();
      return undefined;
    }
    case "api.createNamedRange": {
      const [name, refersTo, options] = args as
        [string, string, { sheetIndex?: number | string | null; comment?: string }?];
      const lib = await getLib();
      // null = workbook scope (the common case); a name resolves to its index.
      let scope: number | null = null;
      if (options?.sheetIndex !== undefined && options.sheetIndex !== null) {
        scope = await resolveSheetRef(lib, options.sheetIndex, "createNamedRange");
      }
      const result = await lib.createNamedRange(
        name,
        scope,
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
      const [sourceRange, destinationCell, fields, rawOptions] = args as [
        string,
        string,
        ScriptPivotFields,
        {
          name?: string;
          sourceSheet?: number | string;
          destinationSheet?: number | string;
          hasHeaders?: boolean;
        } | undefined,
      ];
      // Either sheet may be named; the pivot facade speaks indexes.
      let options:
        | { name?: string; sourceSheet?: number; destinationSheet?: number; hasHeaders?: boolean }
        | undefined;
      if (rawOptions) {
        const lib = await getLib();
        options = {
          ...rawOptions,
          sourceSheet: await resolveOptionalSheetRef(lib, rawOptions.sourceSheet, "createPivot"),
          destinationSheet: await resolveOptionalSheetRef(
            lib,
            rawOptions.destinationSheet,
            "createPivot",
          ),
        };
      }
      return createPivotFromScript(sourceRange, destinationCell, fields, options);
    }
    case "api.deletePivot": {
      const [pivotId] = args as [string];
      const api = await requirePivotApi();
      await api.delete(pivotId);
      announcePivotChanged();
      return undefined;
    }
    case "api.refreshAllPivots": {
      // ONE backend call (refresh_all_pivot_tables), not a loop: the backend
      // walks its own pivot registry and rewrites each destination.
      //
      // The count is what actually REFRESHED. The backend logs and SKIPS a
      // pivot whose refresh fails (a broken source, a missing connection), so a
      // workbook with 5 pivots can honestly answer 4 — which is why this
      // reports a number instead of `void`, and why the typings say "refreshed",
      // not "all".
      const { refreshAllPivotTables } = await import("../backend");
      const responses = await refreshAllPivotTables<unknown[]>();
      announcePivotChanged();
      return { refreshedCount: Array.isArray(responses) ? responses.length : 0 };
    }
    // ---- unlocked: notes + comments (Wave 4) ----
    // The notes/comments backend addresses THE ACTIVE SHEET; the optional
    // sheet slot resolves by the Wave-1 rules and a non-active target is
    // refused with the fix spelled out (assertActiveSheet). listComments is
    // the one sheet-addressable read (the backend has a per-sheet query).
    case "api.setNote": {
      const [row, col, text, sheetRef] = args as
        [number, number, string | null, (number | string)?];
      return executeSetNote(definition.name, row, col, text, sheetRef);
    }
    case "api.getNote": {
      const [row, col, sheetRef] = args as [number, number, (number | string)?];
      const lib = await getLib();
      await assertActiveSheet(lib, sheetRef, "getNote");
      const note = await lib.getNote(row, col);
      return note ? note.content : null;
    }
    case "api.listNotes": {
      const [sheetRef] = args as [(number | string)?];
      const lib = await getLib();
      await assertActiveSheet(lib, sheetRef, "listNotes");
      const notes = await lib.getAllNotes();
      return notes.map((n) => ({
        row: n.row, col: n.col, text: n.content, author: n.authorName,
      }));
    }
    // ANNOTATION MUTATIONS DO NOT ANNOUNCE FROM HERE. The tauri-api
    // note/comment wrappers emit AppEvents.ANNOTATIONS_CHANGED themselves, so
    // every route announces identically — this file used to do it by hand and
    // covered five of the mutators, which is exactly the failure mode
    // per-call-site announcements produce.
    case "api.addComment": {
      const [row, col, text] = args as [number, number, string];
      const lib = await getLib();
      const result = await lib.addComment({
        row, col,
        // Honest attribution: the thread is signed with the SCRIPT's name (no
        // email — a script has none, and inventing the user's would be worse).
        authorEmail: "",
        authorName: definition.name,
        content: text,
      });
      if (!result.success || !result.comment) {
        throw new BrokerError("ValidationError", result.error || "addComment failed");
      }
      return { id: result.comment.id };
    }
    case "api.replyToComment": {
      const [commentId, text] = args as [string, string];
      const lib = await getLib();
      const result = await lib.addReply({
        commentId,
        authorEmail: "",
        authorName: definition.name,
        content: text,
      });
      if (!result.success || !result.reply) {
        throw new BrokerError("ValidationError", result.error || `No comment "${commentId}"`);
      }
      return { id: result.reply.id };
    }
    case "api.resolveComment": {
      const [commentId, resolved] = args as [string, boolean?];
      const lib = await getLib();
      const result = await lib.resolveComment(commentId, resolved ?? true);
      if (!result.success) {
        throw new BrokerError("ValidationError", result.error || `No comment "${commentId}"`);
      }
      return undefined;
    }
    case "api.deleteComment": {
      const [commentId] = args as [string];
      const lib = await getLib();
      const result = await lib.deleteComment(commentId);
      if (!result.success) {
        throw new BrokerError("ValidationError", result.error || `No comment "${commentId}"`);
      }
      return undefined;
    }
    case "api.listComments": {
      const [range, sheetRef] = args as [
        ({ startRow: number; startCol: number; endRow: number; endCol: number } | null)?,
        (number | string)?,
      ];
      const lib = await getLib();
      // Sheet-addressable READ: the backend stores comments per sheet, so a
      // named other sheet is honored here (unlike the mutation rows).
      const comments = sheetRef === undefined || sheetRef === null
        ? await lib.getAllComments()
        : await lib.getCommentsForSheet(await resolveSheetRef(lib, sheetRef, "listComments"));
      const filtered = range
        ? comments.filter((c) =>
            c.row >= range.startRow && c.row <= range.endRow &&
            c.col >= range.startCol && c.col <= range.endCol)
        : comments;
      return filtered.map((c) => ({
        id: c.id,
        row: c.row,
        col: c.col,
        text: c.content,
        author: c.authorName,
        resolved: c.resolved,
        replies: c.replies.map((r) => ({ id: r.id, text: r.content, author: r.authorName })),
      }));
    }
    // ---- unlocked: conditional formatting CRUD (Wave 3 item 3) ----
    case "api.listConditionalFormats":
    case "api.addConditionalFormat":
    case "api.updateConditionalFormat":
    case "api.deleteConditionalFormat":
    case "api.clearConditionalFormats":
      return executeConditionalFormat(method, args);
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
      const [row, col, sheetRef] = args as [number, number, (number | string)?];
      const lib = await getLib();
      if (sheetRef !== undefined && sheetRef !== null) {
        const { sheets, activeIndex } = await lib.getSheets();
        const target = resolveSheetRefIn(sheets, sheetRef, "getCellValue");
        if (target !== activeIndex) {
          if (handle.tier !== "unlocked") {
            throw new BrokerError("PermissionDenied", RESTRICTED_SHEET_CLAMP_MESSAGE);
          }
          const results = await lib.getWatchCells([[target, row, col]]);
          return results[0]?.display ?? "";
        }
      }
      const cellData = await lib.getCell(row, col);
      return cellData?.display ?? "";
    }
    case "sheet.getCellData": {
      // Typed single-cell read, clamped to the script's own sheet (an explicit
      // OTHER sheet ref is unlocked-tier reach — same rule as getCellValue).
      const [row, col, sheetRef] = args as [number, number, (number | string)?];
      const lib = await getLib();
      const target = await clampSheetIndex(lib, handle, sheetRef, "getCellData");
      return readTypedCell(lib, target, row, col);
    }
    case "sheet.getRangeValues": {
      const [startRow, startCol, endRow, endCol, sheetRef] = args as
        [number, number, number, number, (number | string)?];
      const lib = await getLib();
      const target = await clampSheetIndex(lib, handle, sheetRef, "getRangeValues");
      return readTypedRange(lib, target, startRow, startCol, endRow, endCol);
    }
    case "sheet.setRangeValues": {
      // Bulk own-sheet write: same reach as N sheet.setCellValue calls, one RPC,
      // and ONE undo step. `values` is anchored at (startRow, startCol); an
      // undefined entry leaves that cell untouched, an explicit null CLEARS it,
      // and numbers/booleans land typed (see scriptCellInput).
      const [startRow, startCol, values, sheetRef] = args as
        [number, number, Array<Array<ScriptCellWriteValue | undefined>>, (number | string)?];
      const lib = await getLib();
      const target = await clampSheetIndex(lib, handle, sheetRef, "setRangeValues");
      const active = await lib.getActiveSheet();
      const targetSheet = target ?? active;
      const updates: Array<{ row: number; col: number; value: string; invariant?: boolean }> = [];
      for (let r = 0; r < values.length; r++) {
        const row = values[r];
        for (let c = 0; c < row.length; c++) {
          const v = row[c];
          if (v === undefined) continue; // hole: leave the cell untouched
          const gridRow = startRow + r;
          const gridCol = startCol + c;
          recordScriptWrite(definition.id, targetSheet, gridRow, gridCol);
          const { value, invariant } = scriptCellInput(v);
          updates.push({ row: gridRow, col: gridCol, value, invariant });
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
      const target = await clampSheetIndex(lib, handle, options?.sheetIndex, "getCellFormula");
      return readCellFormula(lib, target, row, col, options?.style);
    }
    case "sheet.setCellFormula": {
      const [row, col, formula, options] = args as
        [number, number, string | null, ScriptFormulaOptions | undefined];
      const lib = await getLib();
      // clampSheetIndex refuses a restricted script that named ANOTHER sheet
      // before a single character of the formula is drafted anywhere.
      const target = await clampSheetIndex(lib, handle, options?.sheetIndex, "setCellFormula");
      await writeCellFormula(lib, definition.id, target, row, col, formula, options?.style);
      return undefined;
    }
    case "sheet.setRangeFormat": {
      // Own-sheet formatting: identical reach to sheet.setRangeValues (clamped
      // to the script's sheet), appearance instead of content.
      const [startRow, startCol, endRow, endCol, format, sheetRef] = args as
        [number, number, number, number, FormattingOptions, (number | string)?];
      const lib = await getLib();
      const target = await clampSheetIndex(lib, handle, sheetRef, "setRangeFormat");
      await applyRangeFormat(lib, target, startRow, startCol, endRow, endCol, format);
      return undefined;
    }
    case "sheet.clearRangeFormat": {
      const [startRow, startCol, endRow, endCol, sheetRef] = args as
        [number, number, number, number, (number | string)?];
      const lib = await getLib();
      const target = await clampSheetIndex(lib, handle, sheetRef, "clearRangeFormat");
      await clearRangeFormat(lib, target, startRow, startCol, endRow, endCol);
      return undefined;
    }
    case "sheet.getRangeFormat": {
      // Format read-back, clamped exactly like sheet.getRangeValues: an
      // explicit OTHER sheet ref is unlocked-tier reach.
      const [startRow, startCol, endRow, endCol, sheetRef] = args as
        [number, number, number, number, (number | string)?];
      const lib = await getLib();
      const target = await clampSheetIndex(lib, handle, sheetRef, "getRangeFormat");
      return readRangeFormats(lib, target, startRow, startCol, endRow, endCol);
    }
    case "sheet.getCellFormat": {
      const [row, col, sheetRef] = args as [number, number, (number | string)?];
      const lib = await getLib();
      const target = await clampSheetIndex(lib, handle, sheetRef, "getCellFormat");
      return readCellFormat(lib, target, row, col);
    }
    case "sheet.setCellValue": {
      const [row, col, rawValue, sheetRef] = args as
        [number, number, ScriptCellWriteValue, (number | string)?];
      const lib = await getLib();
      const { value, invariant } = scriptCellInput(rawValue);
      // The TIER check runs first: a restricted script must be refused for
      // naming another sheet BEFORE anything of its value is drafted there.
      let offSheet = false;
      let target: number;
      if (sheetRef !== undefined && sheetRef !== null) {
        const { sheets, activeIndex } = await lib.getSheets();
        target = resolveSheetRefIn(sheets, sheetRef, "setCellValue");
        if (target !== activeIndex) {
          if (handle.tier !== "unlocked") {
            throw new BrokerError("PermissionDenied", RESTRICTED_SHEET_CLAMP_MESSAGE);
          }
          offSheet = true;
        }
      } else {
        target = await activeSheetForWriteGuard(lib);
      }
      recordScriptWrite(definition.id, target, row, col);
      if (offSheet) {
        // A typed value crosses in canonical US form + the invariant flag, so
        // the backend parses it with parse_cell_input_invariant instead of
        // delocalizing (sv-SE would read "42.5" as 425 otherwise). The
        // writeback draft gate and the active-sheet-skip retry both live
        // inside writeOffSheetCellTyped.
        await writeOffSheetCellTyped(
          lib, definition.id, target, row, col, value, invariant,
        );
        return undefined;
      }
      // Re-fetch the canvas — see the note on api.setCellValue. The writeback
      // draft gate runs inside writeActiveCellTyped.
      await afterCellDataChange(
        await writeActiveCellTyped(lib, definition.id, target, row, col, value, invariant),
      );
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
    // ---- forms (the VBA UserForm): trusted host code paints a DATA-ONLY
    //      widget tree; the script never supplies pixels. Identity is
    //      HOST-supplied exactly as for ui.dialog. `form.show` resolves once
    //      the renderer acknowledges the form is on screen; the answer is
    //      relayed into the worker later as `__form_closed` (scriptForms.ts). ----
    case "form.define": {
      const [spec] = args as [FormSpec];
      defineScriptForm(definition.id, spec);
      return undefined;
    }
    case "form.show": {
      const [options] = args as [{ initial?: Record<string, unknown> } | undefined];
      // Bindings are resolved and READ before anything is painted, as broker
      // calls under this script's own handle — so a restricted form naming
      // another sheet is refused (and audited) exactly as its own
      // sheet.getCellData call would be, and the refusal shows up as a
      // disabled widget with the reason rather than as nothing.
      //
      // They are handed to the registry as a THUNK, not as finished seeds,
      // because the registry owns the guards: no layout, the 20-per-minute show
      // bucket, the dismissal mute and the app-wide modal slot. Reading first
      // meant a muted script looping on show() still performed one audited read
      // per bound cell for a form that never opened — wasted IPC, and an audit
      // trail claiming a form had read the sheet when the user saw nothing.
      const spec = getScriptFormSpec(definition.id);
      const holder: { bound: ResolvedFormBindings | null } = { bound: null };
      return showScriptForm({
        scriptId: definition.id,
        scriptName: definition.name,
        // Derived from `provenance`, the same way `handle.origin` now is —
        // `formOriginForMount` IS `scriptOriginForMount` (scriptFormSpec.ts),
        // so the identity band and the trust handle read one derivation. Passing
        // `handle.origin` here would work; going through the definition keeps
        // this call independent of whether a handle is in scope.
        origin: formOriginForMount(definition),
        initial: options?.initial,
        resolve: async () => {
          const bound = spec ? await resolveFormBindings(mw, spec) : null;
          holder.bound = bound;
          return {
            seeds: bound?.seeds,
            pinnedSheetName: bound?.pinnedSheetName,
            writeOnChange: bound?.writeOnChange,
          };
        },
        deps: formSessionDeps(mw, () => holder.bound),
      });
    }
    case "form.update": {
      const [patch] = args as [FormPatch];
      updateScriptForm(definition.id, patch);
      return undefined;
    }
    case "form.close": {
      const [result] = args as [Record<string, FormValue | string[]> | null | undefined];
      closeScriptForm(definition.id, result ?? null);
      return undefined;
    }
    case "cap.formsShow": {
      // Another script's form, by NAME. The caller's own row was admitted and
      // audited by the broker call that brought us here; what follows is the
      // TARGET's admission — resolved among mounted forms (an unconsented
      // distributed form is not mounted, so it is not found), same tier AND
      // origin as the caller (the R7 predicate), and then the target's own
      // form.show policy under the target's handle, so a form whose owner never
      // declared ui.dialog is refused with the owner's error, never opened by
      // proxy. Both scripts wait: the caller's method-call clock is held with
      // the owner's, and the answer is relayed to both.
      // The TARGET's bound cells are read the same way they are for its own
      // form.show: as a thunk the registry calls only once its guards have let
      // this show through, so a target that is muted or already has a form up
      // costs no reads at all.
      const [name, options] = args as [string, { initial?: Record<string, unknown> } | undefined];
      const target = findMountedFormByName(name, mw);
      const spec = getScriptFormSpec(target.definition.id);
      const holder: { bound: ResolvedFormBindings | null } = { bound: null };
      return brokerCall(target.handle, "form.show", [options], () =>
        showScriptForm({
          scriptId: target.definition.id,
          scriptName: target.definition.name,
          // The TARGET's provenance, structurally (see form.show above).
          origin: formOriginForMount(target.definition),
          initial: options?.initial,
          resolve: async () => {
            const bound = spec ? await resolveFormBindings(target, spec) : null;
            holder.bound = bound;
            return {
              seeds: bound?.seeds,
              pinnedSheetName: bound?.pinnedSheetName,
              writeOnChange: bound?.writeOnChange,
            };
          },
          callerName: definition.name,
          callerScriptId: definition.id,
          deps: formSessionDeps(target, () => holder.bound, mw),
        }),
      );
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
    // The MEDIA arm of the same capability, and the narrowest of the four.
    //
    // WHAT COMES BACK IS A HANDLE, NOT A PICTURE. `importImageViaPicker` opens
    // the native dialog, and the file the user chooses is read, magic-byte
    // validated, byte- and pixel-capped and stored INSIDE THE DOCUMENT by Rust
    // (`read_media_file`); the bytes never enter the WebView, let alone the
    // worker realm. Contrast cap.fileImportText, which hands the script the
    // file's contents — and does it through read_text_file, whose Windows-1252
    // lossy fallback turns a binary file into mojibake rather than an error.
    // This arm cannot repeat that, because there is no content to hand over.
    //
    // The response is RE-PROJECTED field by field rather than passed through.
    // `MediaRef` has no `data` member and a Rust test asserts it never grows
    // one — but that test guards the Rust type, and this is the door with the
    // sandbox on the other side. Naming the five fields here means a sixth
    // could never arrive by accident, in this build or a later one.
    case "cap.fileImportMedia": {
      return executeMediaImport(definition.name);
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
    // ---- distribution.subscribe / distribution.publish: the .calp package
    // loop, automated. Everything routes through ONE Rust gateway
    // (script_distribution) which re-checks the ACTION'S OWN capability (the two
    // are never one grant), refuses a registry the user has not configured,
    // gates a registry write on Ed25519 publisher-key possession, rate-limits
    // per bucket, and dispatches into the very same calp_* commands the
    // interactive UI calls.
    //
    // WHAT THIS BLOCK MUST NEVER DO, and does not: mount, grant or consent. The
    // two side effects below are the same ones the Subscribe / Refresh dialogs
    // perform, and they exist precisely so the CONSENT FLOW RUNS: PACKAGE_UPDATED
    // makes ScriptableObjects re-read the pulled scripts, which mounts only what
    // consent already covers (keyed by SOURCE HASH) and raises a prompt for
    // everything else — including a script whose source the refresh just changed.
    case "cap.pkgListRegistries":
    case "cap.pkgListSubscriptions":
    case "cap.pkgRefreshPreview": {
      const { invokeBackend } = await import("../backend");
      return invokeBackend("script_distribution", {
        scriptId: definition.id,
        action:
          method === "cap.pkgListRegistries"
            ? "listRegistries"
            : method === "cap.pkgListSubscriptions"
              ? "listSubscriptions"
              : "refreshPreview",
        payload: {},
      });
    }
    case "cap.pkgBrowse": {
      const [registry] = args as [string];
      const { invokeBackend } = await import("../backend");
      return invokeBackend("script_distribution", {
        scriptId: definition.id,
        action: "listApplicationsInWorkspace",
        payload: { registryPath: registry },
      });
    }
    case "cap.pkgInspect": {
      const [registry, packageName, versionPin] = args as [string, string, string];
      const { invokeBackend } = await import("../backend");
      return invokeBackend("script_distribution", {
        scriptId: definition.id,
        action: "inspectApplication",
        payload: { registryPath: registry, packageName, versionPin },
      });
    }
    case "cap.pkgPull": {
      const [registry, packageName, versionPin] = args as [string, string, string];
      const { invokeBackend } = await import("../backend");
      const response = await invokeBackend<PullResponse>("script_distribution", {
        scriptId: definition.id,
        action: "pull",
        payload: { registryPath: registry, packageName, versionPin },
      });
      await announcePulledPackage(response);
      return response;
    }
    case "cap.pkgRefreshApply": {
      const { invokeBackend } = await import("../backend");
      const result = await invokeBackend("script_distribution", {
        scriptId: definition.id,
        action: "refreshApply",
        payload: {},
      });
      await announcePulledPackage(null);
      return result;
    }
    case "cap.pkgPublishPreview": {
      const [sheetIndices] = args as [number[] | undefined];
      const { invokeBackend } = await import("../backend");
      return invokeBackend("script_distribution", {
        scriptId: definition.id,
        action: "publishPreview",
        payload: { sheetIndices: sheetIndices ?? null },
      });
    }
    case "cap.pkgNextVersion": {
      const [registry, packageName, bump] = args as [string, string, string];
      const { invokeBackend } = await import("../backend");
      const result = await invokeBackend<{ version: string }>("script_distribution", {
        scriptId: definition.id,
        action: "nextVersion",
        payload: { registryPath: registry, packageName, bump },
      });
      return result?.version ?? "";
    }
    case "cap.pkgPublish":
    case "cap.pkgPublishModel": {
      // The spec is forwarded field by field, never spread: `publishedBy`,
      // `customObjects` and `includeComments` are refused by the validator AND
      // by Rust, and spreading would be the one edit that quietly reintroduced
      // them.
      const [spec] = args as [Record<string, unknown>];
      const { invokeBackend } = await import("../backend");
      return invokeBackend("script_distribution", {
        scriptId: definition.id,
        action: method === "cap.pkgPublish" ? "publish" : "publishModel",
        payload:
          method === "cap.pkgPublish"
            ? {
                registryPath: spec.registry,
                packageName: spec.packageName,
                version: spec.version,
                kind: spec.kind ?? null,
                sheetIndices: spec.sheetIndices ?? null,
              }
            : {
                registryPath: spec.registry,
                packageName: spec.packageName,
                version: spec.version,
                connectionId: spec.connectionId,
              },
      });
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
    case "cap.scheduleOnce": {
      // One-shot Application.OnTime (Wave 4). The wire carries an ABSOLUTE
      // epoch-ms time; the DELAY is computed here — the one clock-reading
      // step a stateless validator cannot do — floored to the Rust
      // MIN_ONCE_DELAY_SECS (5s: "at 3pm" given at 3pm means "now", not an
      // error) and refused beyond a year (a typo'd year-2090 timestamp is a
      // job that would never fire while anyone remembered consenting to it).
      const [atMs, handler, options] = args as [
        number,
        string,
        { label?: string } | undefined,
      ];
      const delaySecs = (atMs - Date.now()) / 1000;
      if (delaySecs > 366 * 24 * 3600) {
        throw new BrokerError(
          "ValidationError",
          "scheduleOnce: the time is more than a year away — check the timestamp",
        );
      }
      const { scheduleOnce } = await import("./scheduler");
      return scheduleOnce(
        scheduleOwnerOf(definition),
        Math.max(5, delaySecs),
        handler,
        options?.label,
      );
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
    case "chart.setGeometry": {
      // Move / resize / rename / re-sheet (Wave 4). Placement, not spec: the
      // patch goes to the chart STORE's placement path (the one the drag
      // handles use), never through the spec validator — geometry is not a
      // spec key, and the extension throws for an unknown id.
      const [rawPatch] = args as [
        { x?: number; y?: number; width?: number; height?: number; name?: string; sheetIndex?: number | string },
      ];
      const store = getChartStoreService();
      if (!store) throw new BrokerError("HostError", "The Charts extension is not loaded");
      let placement: ChartPlacement = { ...rawPatch } as ChartPlacement;
      if (rawPatch.sheetIndex !== undefined) {
        // The target sheet may be NAMED (Wave 1); the store speaks indexes.
        const lib = await getLib();
        placement = {
          ...placement,
          sheetIndex: await resolveSheetRef(lib, rawPatch.sheetIndex, "chart.setGeometry"),
        };
      }
      store.updateChartPlacement(instanceId, placement);
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
    // ---- pivot DATA mutation (Wave 3 item 4) ----
    // Report filters, item visibility, sort and value number format — the
    // aspects that finish the "set the page filter, refresh" macro. Fields are
    // named the way the layout family names them (SOURCE column names, real
    // names listed on a miss) and every one is a backend command that
    // recalculates the pivot and rewrites its destination cells, so the same
    // refresh choreography applies. Grid and BI pivots take the same path: the
    // backend commands consult the pivot's bi_metadata themselves (calc-group
    // filters trigger the BI re-query server-side).
    case "pivot.setFilter":
    case "pivot.clearFilter":
    case "pivot.setItemVisibility":
    case "pivot.sortField":
    case "pivot.setNumberFormat": {
      await executePivotDataAspect(instanceId, aspect, args);
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
      const [row, colIndex, rawValue] = args as [number, number, unknown];
      assertCellWriteValue(rawValue, "table.setCellValue value");
      const lib = await getLib();
      const table = (await lib.getTableById(instanceId)) as TableLike | null;
      if (!table) throw new BrokerError("ValidationError", `Table not found: ${instanceId}`);
      const coord = tableCellCoord(table, row, colIndex);
      if (!coord) {
        throw new BrokerError("ValidationError", `Table cell out of range: row=${row} col=${colIndex}`);
      }
      // Typed write: 42 -> the NUMBER 42, true -> TRUE, null -> clear — via the
      // same invariant conversion every other cell write uses (scriptCellInput).
      const { value, invariant } = scriptCellInput(rawValue);
      recordScriptWrite(mw.definition.id, coord.sheetIndex, coord.row, coord.col);
      if (invariant) {
        const active = await lib.getActiveSheet();
        await writeCellsOnSheet(lib, mw.definition.id, coord.sheetIndex, active, [
          { row: coord.row, col: coord.col, value, invariant: true },
        ]);
      } else {
        // Strings keep the single-cell command (writeback draft gate + the
        // cube prefetch a formula may need).
        await writeCellOnSheet(lib, mw.definition.id, coord.sheetIndex, coord.row, coord.col, value);
      }
      emitAppEvent("table:dataChanged", { tableId: instanceId });
      return undefined;
    }
    case "table.setRangeValues": {
      // Bulk own-object table write in TABLE-RELATIVE coordinates. Every target
      // is resolved through tableCellCoord, so the write stays inside the
      // table's body exactly like table.setCellValue — one RPC, one undo step.
      const [startRow, startCol, values] = args as
        [number, number, Array<Array<ScriptCellWriteValue | undefined>>];
      const lib = await getLib();
      const table = (await lib.getTableById(instanceId)) as TableLike | null;
      if (!table) throw new BrokerError("ValidationError", `Table not found: ${instanceId}`);
      const updates: Array<{ row: number; col: number; value: string; invariant?: boolean }> = [];
      let sheetIndex = -1;
      for (let r = 0; r < values.length; r++) {
        const row = values[r];
        for (let c = 0; c < row.length; c++) {
          const v = row[c];
          // vRangeWrite semantics: undefined = HOLE (leave the cell alone),
          // an explicit null CLEARS it, numbers/booleans land typed.
          if (v === undefined) continue;
          assertCellWriteValue(v, "table.setRangeValues value");
          const coord = tableCellCoord(table, startRow + r, startCol + c);
          if (!coord) {
            throw new BrokerError(
              "ValidationError",
              `Table cell out of range: row=${startRow + r} col=${startCol + c}`,
            );
          }
          sheetIndex = coord.sheetIndex;
          recordScriptWrite(mw.definition.id, coord.sheetIndex, coord.row, coord.col);
          const { value, invariant } = scriptCellInput(v);
          updates.push({ row: coord.row, col: coord.col, value, invariant: invariant || undefined });
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
    // ---- table STRUCTURE mutation (Wave 4): the ListObject management
    // family. Every aspect is ONE existing backend table command (the same
    // ones the Table Design ribbon calls); the backend addresses tables on
    // the ACTIVE sheet, so that is asserted first with the fix spelled out —
    // the exact rule api.deleteTable already applies. After the mutation the
    // Table extension reloads its store from the backend on
    // TABLE_DEFINITIONS_UPDATED, the same announcement its own dialogs make.
    case "table.rename":
    case "table.resize":
    case "table.addColumn":
    case "table.removeColumn":
    case "table.renameColumn":
    case "table.setTotalsRow":
    case "table.setTotalsFunction":
    case "table.setStyle":
    case "table.convertToRange":
    case "table.insertRow":
    case "table.deleteRow": {
      await executeTableStructureAspect(instanceId, aspect, args);
      // convertToRange DELETES the table — a mirror push would just log a
      // "table not found" fetch; every other aspect refreshes the own mirror.
      if (isOwnInstance && aspect !== "table.convertToRange") {
        pushTableMirror(mw, instanceId);
      }
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
    case "namedRange.update": {
      // Edit the DEFINITION of the name (refersTo / scope / comment / the name
      // itself), mirroring MCP update_named_range — with one improvement: a
      // rename lands as ONE undo step (delete+create inside a host-side undo
      // transaction) instead of the MCP's two. Returns { name } so the worker
      // handle can re-key itself after a rename.
      const [patch] = args as [ScriptNamedRangeUpdate];
      return executeNamedRangeUpdate(instanceId, patch);
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
    case "pivot.getFieldInfo": {
      const [field] = args as [string];
      return executePivotFieldInfo(instanceId, field);
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
    // ---- table STRUCTURE reads (Wave 4): the read twins of the management
    // aspects — column list, style, totals config — straight off the stored
    // Table definition, so a read-modify-write macro never guesses.
    case "table.getColumns": {
      const table = await requireFullTable(instanceId);
      return table.columns.map((c) => {
        const col: {
          name: string;
          totalsFunction: string;
          totalsFormula?: string;
          calculatedFormula?: string;
        } = { name: c.name, totalsFunction: c.totalsRowFunction };
        if (c.totalsRowFormula) col.totalsFormula = c.totalsRowFormula;
        if (c.calculatedFormula) col.calculatedFormula = c.calculatedFormula;
        return col;
      });
    }
    case "table.getStyle": {
      const table = await requireFullTable(instanceId);
      return { styleName: table.styleName, styleOptions: { ...table.styleOptions } };
    }
    case "table.getTotals": {
      const table = await requireFullTable(instanceId);
      return {
        shown: table.styleOptions.totalRow,
        columns: table.columns.map((c) => {
          const col: { name: string; function: string; formula?: string } = {
            name: c.name,
            function: c.totalsRowFunction,
          };
          if (c.totalsRowFormula) col.formula = c.totalsRowFormula;
          return col;
        }),
      };
    }
    default:
      throw new BrokerError("ValidationError", `Unknown getState aspect: ${aspect}`);
  }
}

/** The FULL stored Table definition (columns/style/totals), or a loud miss. */
async function requireFullTable(tableId: string): Promise<BackendTable> {
  const lib = await getLib();
  const table = (await lib.getTableById(tableId)) as BackendTable | null;
  if (!table) throw new BrokerError("ValidationError", `Table not found: ${tableId}`);
  return table;
}

// ============================================================================
// Table STRUCTURE aspects (Wave 4): the ListObject management family
// ============================================================================
// One aspect = one existing backend table command (the same ones the Table
// Design ribbon calls). The backend addresses tables on the ACTIVE sheet, so
// that is asserted first — the exact rule api.deleteTable already applies —
// and every failure surfaces the backend's own error text. Exported for tests.

export async function executeTableStructureAspect(
  instanceId: string,
  aspect: string,
  args: unknown[],
): Promise<void> {
  const lib = await getLib();
  const table = (await lib.getTableById(instanceId)) as BackendTable | null;
  if (!table) throw new BrokerError("ValidationError", `Table not found: ${instanceId}`);
  await assertActiveSheet(lib, table.sheetIndex, aspect);
  const backend = await import("../backend");
  const check = (result: { success: boolean; error?: string }): void => {
    if (!result.success) {
      throw new BrokerError("ValidationError", result.error || `${aspect} failed`);
    }
  };
  switch (aspect) {
    case "table.rename": {
      const [newName] = args as [string];
      check(await backend.renameTable(instanceId, newName));
      break;
    }
    case "table.resize": {
      const [startRow, startCol, endRow, endCol] = args as [number, number, number, number];
      check(await backend.resizeTable({ tableId: instanceId, startRow, startCol, endRow, endCol }));
      break;
    }
    case "table.addColumn": {
      const [name, position] = args as [string, number?];
      check(await backend.addTableColumn(instanceId, name, position ?? undefined));
      break;
    }
    case "table.removeColumn": {
      const [name] = args as [string];
      check(await backend.removeTableColumn(instanceId, name));
      break;
    }
    case "table.renameColumn": {
      const [oldName, newName] = args as [string, string];
      check(await backend.renameTableColumn(instanceId, oldName, newName));
      break;
    }
    case "table.setTotalsRow": {
      const [show] = args as [boolean];
      check(await backend.toggleTotalsRow(instanceId, show));
      break;
    }
    case "table.setTotalsFunction": {
      const [column, fn, customFormula] = args as [string, BackendTotalsRowFunction, string?];
      check(await backend.setTotalsRowFunction({
        tableId: instanceId,
        columnName: column,
        function: fn,
        customFormula: customFormula ?? undefined,
      }));
      break;
    }
    case "table.setStyle": {
      const [style] = args as [
        string | { styleName?: string; styleOptions?: Partial<BackendTable["styleOptions"]> },
      ];
      const styleName = typeof style === "string" ? style : style.styleName;
      // The backend replaces the WHOLE options struct, so a partial patch is
      // merged over the stored options here — `{ bandedRows: false }` must not
      // silently reset the other six flags.
      const styleOptions = typeof style === "string" || style.styleOptions === undefined
        ? undefined
        : { ...table.styleOptions, ...style.styleOptions };
      check(await backend.updateTableStyle({ tableId: instanceId, styleName, styleOptions }));
      break;
    }
    case "table.convertToRange": {
      check(await backend.convertToRange(instanceId));
      break;
    }
    case "table.insertRow": {
      // position = the 0-based DATA row the new row is inserted BEFORE.
      // Omitted = append (the same end_row expansion table.addRow does — no
      // sheet rows shift). A positioned insert is a REAL sheet-row insert at
      // that spot: the backend shifts rows down and expands this table (and
      // keeps every other object on the sheet consistent, exactly like
      // Insert Row in the grid).
      const [position] = args as [number?];
      if (position === undefined || position === null) {
        await lib.addTableRow(instanceId);
        break;
      }
      const dataRows = tableDataRowCount(table);
      const maxInsertable = table.styleOptions.totalRow ? dataRows + 1 : dataRows;
      if (position >= maxInsertable) {
        throw new BrokerError(
          "ValidationError",
          `position ${position} is out of range (the table has ${dataRows} data row(s)); ` +
            "omit position to append a row at the end",
        );
      }
      const gridRow = table.startRow + tableHeaderOffset(table) + position;
      await lib.insertRows(gridRow, 1, table.sheetIndex);
      break;
    }
    case "table.deleteRow": {
      // position = the 0-based DATA row to delete. A REAL sheet-row delete:
      // rows below shift up and the table shrinks (backend bookkeeping).
      const [position] = args as [number];
      const dataRows = tableDataRowCount(table);
      if (position >= dataRows) {
        throw new BrokerError(
          "ValidationError",
          `position ${position} is out of range (the table has ${dataRows} data row(s))`,
        );
      }
      const gridRow = table.startRow + tableHeaderOffset(table) + position;
      await lib.deleteRows(gridRow, 1, table.sheetIndex);
      break;
    }
    default:
      throw new BrokerError("ValidationError", `Unknown table structure aspect: ${aspect}`);
  }
  // The Table extension reloads its store from the backend on this — the same
  // announcement its own Design-tab dialogs make; Pivot/Charts/AutoFilter
  // listen too. Then the generic objects refresh repaints the grid.
  emitAppEvent(AppEvents.TABLE_DEFINITIONS_UPDATED, {});
  // `table.convertToRange` DISSOLVES the table, and §3bt gave it the identical
  // cascade `delete_table` runs — the slicers bound to it are deleted and the
  // ribbon filters that named it are pruned. The Table extension's own
  // `convertToRangeAsync` announces that; this path must too, or the slicer
  // goes on painting a rectangle that swallows clicks. Every other aspect here
  // only reshapes a table that still exists, so it keeps the narrower
  // announcement.
  if (aspect === "table.convertToRange") {
    await announceObjectCascade();
    return;
  }
  await announceObjectsChanged();
}

// ============================================================================
// namedRange.update (Wave 4): edit the DEFINITION of a name
// ============================================================================

/** The patch namedRange.update accepts (checkNamedRangeUpdate has proved it). */
export interface ScriptNamedRangeUpdate {
  refersTo?: string;
  newName?: string;
  comment?: string;
  /** A sheet ref (index or name) scopes the name to that sheet; `null` clears
   *  the scope to workbook; absent keeps the stored scope. */
  sheetIndex?: number | string | null;
}

/**
 * Mirrors MCP update_named_range, with two improvements the frontend can
 * afford: a RENAME lands as ONE undo step (delete+create inside a host-side
 * undo transaction — record_object_undo joins an open transaction), and the
 * name's attached object scripts are re-keyed instead of silently pruned.
 * A rename is refused while a DISTRIBUTED script is attached: re-creating one
 * through the save command would launder its provenance to "local".
 *
 * Returns `{ name }` — the (possibly new) name — so worker handles re-key.
 */
export async function executeNamedRangeUpdate(
  instanceId: string,
  patch: ScriptNamedRangeUpdate,
): Promise<{ name: string }> {
  const lib = await getLib();
  const existing = await lib.getNamedRange(instanceId);
  if (!existing) {
    throw new BrokerError("ValidationError", `No named range "${instanceId}"`);
  }
  // Merge: absent = keep. `sheetIndex: null` clears to workbook scope; a
  // sheet NAME resolves against the live list (Wave 1).
  const targetRefersTo = patch.refersTo ?? existing.refersTo;
  const targetComment = patch.comment ?? existing.comment;
  let targetScope: number | null = existing.sheetIndex;
  if (patch.sheetIndex !== undefined) {
    targetScope = patch.sheetIndex === null
      ? null
      : await resolveSheetRef(lib, patch.sheetIndex, "namedRange.update");
  }
  const targetName = patch.newName ?? existing.name;
  const renaming = targetName.toUpperCase() !== existing.name.toUpperCase();

  if (!renaming) {
    const result = await lib.updateNamedRange(
      existing.name, targetScope, targetRefersTo, targetComment, existing.folder,
    );
    if (!result.success) {
      throw new BrokerError("ValidationError", result.error || "namedRange.update failed");
    }
    emitAppEvent(AppEvents.NAMED_RANGES_CHANGED, {});
    return { name: existing.name };
  }

  // RENAME = delete + create (both fully validated + undoable — the raw
  // rename_named_range command records no undo entry and skips the
  // name-vs-table collision check, which is why MCP shuns it too). The
  // delete PRUNES scripts attached to the name, so they are captured first
  // and re-saved pointing at the new name afterwards.
  const scriptBackend = await import("../objectScriptBackend");
  const summaries = (await scriptBackend.listObjectScripts()).filter(
    (s) => s.objectType === "namedRange" &&
      (s.instanceId ?? "").toUpperCase() === existing.name.toUpperCase(),
  );
  if (summaries.some((s) => s.provenance === "distributed")) {
    throw new BrokerError(
      "ValidationError",
      `Cannot rename "${existing.name}": a distributed script is attached to it. ` +
        "Detach the script (or copy it to a local one) first.",
    );
  }
  const attached = await Promise.all(summaries.map((s) => scriptBackend.getObjectScript(s.id)));

  await withScriptUndoBatch(lib, `Rename name ${existing.name} -> ${targetName}`, async () => {
    const removed = await lib.deleteNamedRange(existing.name);
    if (!removed.success) {
      throw new BrokerError(
        "ValidationError",
        removed.error || `Failed to remove named range "${existing.name}"`,
      );
    }
    const created = await lib.createNamedRange(
      targetName, targetScope, targetRefersTo, targetComment, existing.folder,
    );
    if (!created.success) {
      // Put the original back so a rejected rename is not a silent delete
      // (the throw below also cancels the undo transaction).
      await lib.createNamedRange(
        existing.name, existing.sheetIndex, existing.refersTo, existing.comment, existing.folder,
      );
      throw new BrokerError(
        "ValidationError",
        created.error || `Failed to create named range "${targetName}"`,
      );
    }
  });

  // Re-key the rescued scripts at the new name (persisted store)...
  for (const script of attached) {
    await scriptBackend.saveObjectScript({
      ...script,
      instanceId: targetName,
    } as Parameters<typeof scriptBackend.saveObjectScript>[0]);
  }
  // ...and the LIVE mounts, so an attached script's own-object aspects keep
  // resolving after the rename (instanceId is pinned at mount).
  for (const other of mounted.values()) {
    if (
      other.definition.objectType === "namedRange" &&
      (other.definition.instanceId ?? "").toUpperCase() === existing.name.toUpperCase()
    ) {
      other.definition.instanceId = targetName;
      other.handle.instanceId = targetName;
    }
  }
  emitAppEvent(AppEvents.NAMED_RANGES_CHANGED, {});
  return { name: targetName };
}

// ============================================================================
// Notes (Wave 4): the VBA Range.NoteText 90% case — one text per cell
// ============================================================================

/**
 * Set / replace / remove the note on one cell. `text: null` removes it (the
 * honest spelling of `Range.ClearNotes`); an existing note is UPDATED in
 * place so its size/position survive a text change. Returns the note id, or
 * null after a removal. Exported for tests.
 */
export async function executeSetNote(
  scriptName: string,
  row: number,
  col: number,
  text: string | null,
  sheetRef?: number | string,
): Promise<{ id: string } | null> {
  const lib = await getLib();
  await assertActiveSheet(lib, sheetRef, "setNote");
  const existing = await lib.getNote(row, col);
  if (text === null) {
    if (existing) {
      const result = await lib.deleteNote(existing.id);
      if (!result.success) {
        throw new BrokerError("ValidationError", result.error || "deleteNote failed");
      }
    }
    // No note either way — the cell is in the state the script asked for.
    return null;
  }
  const result = existing
    ? await lib.updateNote({ noteId: existing.id, content: text })
    : await lib.addNote({ row, col, authorName: scriptName, content: text });
  if (!result.success || !result.note) {
    // The one refusal worth translating: a cell can hold a note OR a comment
    // thread, never both — the backend text already says so.
    throw new BrokerError("ValidationError", result.error || "setNote failed");
  }
  return { id: result.note.id };
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
  /** 0-based sheet index or sheet name; resolved host-side at execution time. */
  sheetIndex?: number | string;
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
  sheetIndex: number | string | undefined,
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
  /** 0-based sheet index or sheet name (must resolve to the active sheet). */
  sheetIndex?: number | string;
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

// ============================================================================
// Fill / AutoFill (Wave 3, item 10) + Auto-fit (item 11)
// ============================================================================

/** api.fillRange options. The rectangle handed over is SOURCE + TARGET
 *  together; `sourceSize` is the thickness of the seed band at the edge the
 *  fill starts from (1 = Excel's FillDown/FillRight shape). */
export interface ScriptFillOptions {
  direction?: "down" | "up" | "right" | "left";
  /** "copy" (default): tile the band, shifting formulas — Excel FillDown.
   *  "series": the drag-fill inference (series, dates, custom lists, ...). */
  type?: "copy" | "series";
  sourceSize?: number;
}

/**
 * The series pattern a SCRIPT fill uses for one column/row band — the drag
 * machinery's inference verbatim (same non-formula basis, same detectPattern),
 * plus ONE deliberate addition: a lone numeric seed becomes a step-1 series.
 * The drag gesture copies a lone number (so does Excel's drag without Ctrl),
 * but a script that explicitly asked for `type: "series"` means "count on from
 * here" — Excel's Fill > Series default — and answering it with a copy would
 * make the option useless for the commonest case.
 */
function scriptSeriesPattern(values: string[]): PatternResult {
  const nonFormulaValues = values.filter((v) => !v.startsWith("="));
  const basis = nonFormulaValues.length > 0 ? nonFormulaValues : values;
  const pattern = detectPattern(basis);
  if (
    pattern.type === "copy" &&
    basis.length === 1 &&
    basis[0].trim() !== "" &&
    !Number.isNaN(parseFloat(basis[0]))
  ) {
    return { type: "series", baseValues: basis, step: 1 };
  }
  return pattern;
}

/**
 * Fill a rectangle from its leading band — VBA Range.FillDown/FillRight/
 * AutoFill, over the SAME machinery the drag fill-handle runs
 * (core/lib/fillEngine.ts): identical series inference, identical per-cell
 * formula shifting (batched), identical merge replication, one undo step.
 *
 * ACTIVE SHEET ONLY, refused (never silently redirected) otherwise: the fill
 * machinery reads its source styles through `get_viewport_cells` — the same
 * active-sheet-only bulk path copyRange documents — and writes through
 * `update_cells_batch`, which carries style indexes only on the active sheet.
 * Same rule, same message, as copyRange / sortRange.
 */
export async function fillRangeFromScript(
  lib: Awaited<ReturnType<typeof getLib>>,
  scriptId: string,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  options: ScriptFillOptions,
  sheetRef: number | string | undefined,
): Promise<{ count: number }> {
  assertRangeSize(startRow, startCol, endRow, endCol);
  const active = await assertActiveSheet(lib, sheetRef, "fillRange");
  const direction = options.direction ?? "down";
  const fillType = options.type ?? "copy";
  const sourceSize = options.sourceSize ?? 1;
  const vertical = direction === "down" || direction === "up";
  const axisSpan = vertical ? endRow - startRow + 1 : endCol - startCol + 1;
  // The band covering the whole range means there is nothing left to fill —
  // exactly Excel's FillDown on a one-row range, which does nothing.
  if (sourceSize >= axisSpan) return { count: 0 };

  // The source band: the edge slice the fill starts from.
  let srcStartRow = startRow, srcEndRow = endRow, srcStartCol = startCol, srcEndCol = endCol;
  if (direction === "down") srcEndRow = startRow + sourceSize - 1;
  else if (direction === "up") srcStartRow = endRow - sourceSize + 1;
  else if (direction === "right") srcEndCol = startCol + sourceSize - 1;
  else srcStartCol = endCol - sourceSize + 1;

  // Fetch the band once (values + formulas + style indexes), like completeFill.
  const sourceCells = await lib.getViewportCells(srcStartRow, srcStartCol, srcEndRow, srcEndCol);
  const cellMap = new Map<string, string>();
  const styleMap = new Map<string, number>();
  for (const cell of sourceCells) {
    const key = `${cell.row},${cell.col}`;
    cellMap.set(key, cell.formula || cell.display || "");
    styleMap.set(key, cell.styleIndex ?? 0);
  }
  const getSourceValue = (row: number, col: number): string => cellMap.get(`${row},${col}`) || "";
  const getSourceStyle = (row: number, col: number): number => styleMap.get(`${row},${col}`) || 0;

  const patternFor = (values: string[]): PatternResult => {
    if (fillType === "series") return scriptSeriesPattern(values);
    return { type: "copy", baseValues: values, step: 0 };
  };

  // Build the pending fills with the drag machinery's own index arithmetic
  // (useFillHandle completeFill, branch by branch).
  const pendingFills: PendingFill[] = [];
  const sourceValues: string[][] = [];

  if (vertical) {
    for (let c = srcStartCol; c <= srcEndCol; c++) {
      const colValues: string[] = [];
      for (let r = srcStartRow; r <= srcEndRow; r++) colValues.push(getSourceValue(r, c));
      sourceValues.push(colValues);
    }
    const sourceCount = srcEndRow - srcStartRow + 1;
    for (let c = srcStartCol; c <= srcEndCol; c++) {
      const colIdx = c - srcStartCol;
      const pattern = patternFor(sourceValues[colIdx]);
      if (direction === "down") {
        for (let r = srcEndRow + 1; r <= endRow; r++) {
          const fillIndex = r - srcStartRow;
          const sourceIndex = fillIndex % sourceCount;
          const sourceRow = srcStartRow + sourceIndex;
          pendingFills.push({
            row: r, col: c,
            sourceValue: sourceValues[colIdx][sourceIndex],
            sourceRow, sourceCol: c,
            pattern,
            allSourceValues: sourceValues[colIdx],
            fillIndex,
            sourceStyleIndex: getSourceStyle(sourceRow, c),
          });
        }
      } else {
        // Fill up — mirror from the bottom of the band upward.
        for (let r = srcStartRow - 1; r >= startRow; r--) {
          const fillIndex = srcEndRow - r;
          const sourceIndex = fillIndex % sourceCount;
          const sourceRow = srcEndRow - sourceIndex;
          pendingFills.push({
            row: r, col: c,
            sourceValue: sourceValues[colIdx][sourceCount - 1 - sourceIndex],
            sourceRow, sourceCol: c,
            pattern,
            allSourceValues: sourceValues[colIdx].slice().reverse(),
            fillIndex,
            sourceStyleIndex: getSourceStyle(sourceRow, c),
          });
        }
      }
    }
  } else {
    for (let r = srcStartRow; r <= srcEndRow; r++) {
      const rowValues: string[] = [];
      for (let c = srcStartCol; c <= srcEndCol; c++) rowValues.push(getSourceValue(r, c));
      sourceValues.push(rowValues);
    }
    const sourceCount = srcEndCol - srcStartCol + 1;
    for (let r = srcStartRow; r <= srcEndRow; r++) {
      const rowIdx = r - srcStartRow;
      const pattern = patternFor(sourceValues[rowIdx]);
      if (direction === "right") {
        for (let c = srcEndCol + 1; c <= endCol; c++) {
          const fillIndex = c - srcStartCol;
          const sourceIndex = fillIndex % sourceCount;
          const sourceCol = srcStartCol + sourceIndex;
          pendingFills.push({
            row: r, col: c,
            sourceValue: sourceValues[rowIdx][sourceIndex],
            sourceRow: r, sourceCol,
            pattern,
            allSourceValues: sourceValues[rowIdx],
            fillIndex,
            sourceStyleIndex: getSourceStyle(r, sourceCol),
          });
        }
      } else {
        // Fill left — mirror from the right of the band leftward.
        for (let c = srcStartCol - 1; c >= startCol; c--) {
          const fillIndex = srcEndCol - c;
          const sourceIndex = fillIndex % sourceCount;
          const sourceCol = srcEndCol - sourceIndex;
          pendingFills.push({
            row: r, col: c,
            sourceValue: sourceValues[rowIdx][sourceCount - 1 - sourceIndex],
            sourceRow: r, sourceCol,
            pattern,
            allSourceValues: sourceValues[rowIdx].slice().reverse(),
            fillIndex,
            sourceStyleIndex: getSourceStyle(r, sourceCol),
          });
        }
      }
    }
  }

  // Values + shifted formulas, through the SHARED engine (one batched shift).
  const batchUpdates = await processPendingFills(pendingFills);

  // The write, on the same terms as any other script write: attributed, and
  // every .calp-writeback-claimed cell drafted through the authoritative gate.
  for (const u of batchUpdates) recordScriptWrite(scriptId, active, u.row, u.col);
  const { plain, drafted } = await captureWritebackWrites(
    scriptId,
    batchUpdates.map((u) => ({ sheetIndex: active, row: u.row, col: u.col, value: u.value })),
  );
  const byCoord = new Map(batchUpdates.map((u) => [`${u.row},${u.col}`, u]));
  const updates = plain.map((w) => {
    const u = byCoord.get(`${w.row},${w.col}`);
    return { row: w.row, col: w.col, value: w.value, styleIndex: u?.styleIndex };
  });

  const srcBox = { startRow: srcStartRow, startCol: srcStartCol, endRow: srcEndRow, endCol: srcEndCol };
  const targetBox = { startRow, startCol, endRow, endCol };
  await withScriptUndoBatch(lib, `Fill ${batchUpdates.length} cells`, async () => {
    if (updates.length > 0) {
      const changed = await lib.updateCellsBatch(updates);
      await afterCellDataChange(changed);
    }
    for (const w of drafted) {
      await lib.updateCell(w.row, w.col, w.value);
    }
    // Merge patterns replicate from the band into the filled area, exactly as
    // the drag does (same shared function, same clipping rules).
    await replicateMergeRegions(srcBox, targetBox, direction);
  });

  // The same completion event the drag emits, so extensions that follow fills
  // (e.g. sparklines) see a script fill too.
  emitAppEvent(AppEvents.FILL_COMPLETED, {
    sourceRange: srcBox,
    targetRange: targetBox,
    direction,
  });

  return { count: batchUpdates.length };
}

/**
 * Auto-fit columns or rows to their contents — the double-click best-fit,
 * scripted. The measurement is THE SAME code the double-click runs
 * (core/lib/gridRenderer measureOptimalColumnWidth / measureOptimalRowHeight),
 * including the @api/autoFitContributors registry, so extension-rendered
 * content (pivot overlays, in-cell filter buttons) sizes identically whichever
 * hand asked.
 *
 * ACTIVE SHEET ONLY, refused otherwise: measurement is canvas text metrics
 * over the rendered sheet's cells (get_cells_in_cols/rows are active-sheet
 * commands) and the live theme fonts — an off-sheet "best fit" would be a
 * fabricated answer, so the honest response is the same refusal sortRange
 * gives.
 *
 * Excel semantics, matching the double-click handler exactly: an empty COLUMN
 * keeps its width (and contributes no undo entry); an empty ROW resets to the
 * default height.
 */
export async function autoFitFromScript(
  lib: Awaited<ReturnType<typeof getLib>>,
  kind: "columns" | "rows",
  start: number,
  end: number,
  sheetRef: number | string | undefined,
): Promise<{ count: number }> {
  await assertActiveSheet(lib, sheetRef, kind === "columns" ? "autoFitColumns" : "autoFitRows");
  const [{ measureOptimalColumnWidth, measureOptimalRowHeight }, { getActiveGridTheme }, { DEFAULT_GRID_CONFIG }] =
    await Promise.all([
      import("../../core/lib/gridRenderer"),
      import("../../core/theme/skinLoader"),
      import("../../core/types/types"),
    ]);
  const styles = await lib.getAllStyles();
  const activeTheme = getActiveGridTheme();
  const theme = { cellFontFamily: activeTheme.cellFontFamily, cellFontSize: activeTheme.cellFontSize };

  if (kind === "columns") {
    // Measure first (reads only), apply after — so a span of empty columns
    // opens no undo transaction at all (the double-click handler cancels its
    // transaction in that case; here it is simply never opened).
    const fits: Array<{ col: number; width: number }> = [];
    for (let c = start; c <= end; c++) {
      const cells = await lib.getCellsInCols(c, c);
      const optimalWidth = measureOptimalColumnWidth(c, cells, styles, theme, DEFAULT_GRID_CONFIG.minColumnWidth);
      // Excel: an empty column keeps its current width.
      if (optimalWidth === null) continue;
      fits.push({ col: c, width: optimalWidth });
    }
    if (fits.length === 0) return { count: 0 };
    await withScriptUndoBatch(lib, "Auto-fit columns", async () => {
      for (const { col, width } of fits) {
        await lib.setColumnWidth(col, width);
        await syncDimensionToGrid("column", col, width);
      }
    });
    return { count: fits.length };
  }

  const [defaults, widths] = await Promise.all([lib.getDefaultDimensions(), lib.getAllColumnWidths()]);
  const columnWidths = new Map(widths.map((d) => [d.index, d.size]));
  const fits: Array<{ row: number; height: number }> = [];
  for (let r = start; r <= end; r++) {
    const cells = await lib.getCellsInRows(r, r);
    const optimalHeight = measureOptimalRowHeight(
      cells,
      styles,
      columnWidths,
      defaults.defaultColumnWidth,
      theme,
      DEFAULT_GRID_CONFIG.minRowHeight,
      defaults.defaultRowHeight,
      r,
    );
    // Excel: an empty row RESETS to the default height (unlike columns).
    fits.push({ row: r, height: optimalHeight ?? defaults.defaultRowHeight });
  }
  await withScriptUndoBatch(lib, "Auto-fit rows", async () => {
    for (const { row, height } of fits) {
      await lib.setRowHeight(row, height);
      await syncDimensionToGrid("row", row, height);
    }
  });
  return { count: fits.length };
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
 * active sheet". The ref may be an index or a NAME (resolved against the live
 * list); naming another sheet is unlocked-tier reach — the same clamp
 * sheet.getCellValue / sheet.setCellValue apply.
 */
async function clampSheetIndex(
  lib: Awaited<ReturnType<typeof getLib>>,
  handle: ScriptHandle,
  sheetRef: number | string | undefined,
  method: string,
): Promise<number | undefined> {
  if (sheetRef === undefined || sheetRef === null) return undefined;
  const { sheets, activeIndex } = await lib.getSheets();
  const resolved = resolveSheetRefIn(sheets, sheetRef, method);
  if (resolved !== activeIndex && handle.tier !== "unlocked") {
    throw new BrokerError("PermissionDenied", RESTRICTED_SHEET_CLAMP_MESSAGE);
  }
  return resolved;
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

// ============================================================================
// Typed cell writes (Wave 1)
// ============================================================================

/** What a script may hand any cell-write method. `null` clears the cell. */
export type ScriptCellWriteValue = string | number | boolean | null;

/**
 * Turn a typed script value into the backend's input form — the SAME
 * construction clipboardValueString uses for a paste, because it is the same
 * problem: 42 must land as the NUMBER 42 on a sv-SE workbook whose decimal
 * separator disagrees with JavaScript's. Numbers and booleans are written
 * INVARIANT ("42.5", "TRUE") and flagged so the batch write path parses them
 * with parse_cell_input_invariant instead of delocalizing; strings are the
 * user-entry form they always were; null becomes the empty input, which is how
 * a cell is cleared. Exported for tests.
 */
/**
 * Assert an object-aspect argument is a legal cell-write value. The aspect
 * dispatch (objSet) has no allowlist validator in front of it, so executors
 * that accept cell values must gate here — the SAME rule vCellSet applies
 * (checkCellWriteValue): string (<= 1 MB) | finite number | boolean | null.
 * Throws a BrokerError naming the argument; never silently stringifies.
 */
function assertCellWriteValue(v: unknown, label: string): asserts v is ScriptCellWriteValue {
  const verdict = checkCellWriteValue(v, label);
  if (verdict !== true) throw new BrokerError("ValidationError", verdict);
}

export function scriptCellInput(v: ScriptCellWriteValue): { value: string; invariant: boolean } {
  if (v === null) return { value: "", invariant: false };
  if (typeof v === "number") return { value: String(v), invariant: true };
  if (typeof v === "boolean") return { value: v ? "TRUE" : "FALSE", invariant: true };
  return { value: v, invariant: false };
}

/**
 * Write ONE cell on the ACTIVE sheet, honouring the invariant flag.
 *
 * The .calp writeback draft gate runs HERE, first: a cell claimed by a
 * writeback region is captured as a schema-validated draft exactly like a
 * human keystroke, or the whole call throws.
 *
 * The invariant path exists only on the batch command, so a typed value takes
 * a single-element batch; a plain string keeps the single-cell command (which
 * also runs the cube prefetch a formula may need). A writeback-DRAFTED cell
 * always goes through update_cell — update_cells_batch drops writeback cells,
 * and a draft that then painted nothing would look like a failed write.
 */
async function writeActiveCellTyped(
  lib: Awaited<ReturnType<typeof getLib>>,
  scriptId: string,
  sheetIndex: number,
  row: number,
  col: number,
  value: string,
  invariant: boolean,
): Promise<CellData[]> {
  const drafted = await captureWritebackWrite(scriptId, { sheetIndex, row, col, value });
  if (invariant && !drafted) {
    return lib.updateCellsBatch([{ row, col, value, invariant: true }]);
  }
  return (await lib.updateCell(row, col, value)).cells;
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
  updates: Array<{ row: number; col: number; value: string; invariant?: boolean }>,
): Promise<void> {
  if (updates.length === 0) return;
  const { plain, drafted } = await captureWritebackWrites(
    scriptId,
    updates.map((u) => ({ sheetIndex, row: u.row, col: u.col, value: u.value })),
  );
  // The guard's answer carries coordinates + value only; re-attach each cell's
  // invariant flag (a typed number/boolean must not be delocalized).
  const invariantAt = new Map(updates.map((u) => [`${u.row},${u.col}`, u.invariant === true]));
  if (sheetIndex === activeSheet) {
    const changed: CellData[] = [];
    if (plain.length > 0) {
      changed.push(
        ...(await lib.updateCellsBatch(
          plain.map((u) => ({
            row: u.row,
            col: u.col,
            value: u.value,
            invariant: invariantAt.get(`${u.row},${u.col}`) || undefined,
          })),
        )),
      );
    }
    // updateCellsBatch drops writeback cells, so drafted ones go singly.
    for (const u of drafted) {
      changed.push(...(await lib.updateCell(u.row, u.col, u.value)).cells);
    }
    // The visible sheet changed: re-fetch it (see api.setCellValue).
    await afterCellDataChange(changed);
    return;
  }
  // Cells the backend SKIPPED because the target became the active sheet
  // mid-block — re-issued through the active path below rather than dropped
  // (see writeOffSheetCellTyped for the whole story).
  const skipped: Array<{ row: number; col: number; value: string; invariant?: boolean }> = [];
  await withScriptUndoBatch(lib, `Script write (${updates.length} cells)`, async () => {
    for (const u of updates) {
      // Carry each cell's invariant flag: a typed number/boolean crossing to
      // another sheet must not be delocalized (sv-SE reads "42.5" as 425).
      // recalc: false — a full sheet evaluation per cell would be quadratic;
      // ONE recalc for the whole block follows below.
      const written = await lib.updateCellOnSheets(
        [sheetIndex], u.row, u.col, u.value,
        invariantAt.get(`${u.row},${u.col}`) || undefined,
        false,
      );
      if (Array.isArray(written) && !written.includes(sheetIndex)) {
        skipped.push({ ...u, invariant: invariantAt.get(`${u.row},${u.col}`) || undefined });
      }
    }
  });
  if (skipped.length > 0) {
    await afterCellDataChange(
      await lib.updateCellsBatch(
        skipped.map((u) => ({
          row: u.row, col: u.col, value: u.value, invariant: u.invariant,
        })),
      ),
    );
  }
  // All cells are in: recalculate dependents once (the written sheet + the
  // active sheet, double pass) — without this a formula reading the written
  // block stayed stale until the next manual edit (found live).
  await lib.recalculateSheetsAfterScriptWrite([sheetIndex]);
  // Another sheet: no visible cell moved, but a formula on the ACTIVE sheet may
  // depend on one, and the style caches key on the whole workbook. Refresh
  // without the per-cell event (we have no CellData for an off-sheet write).
  scheduleGridDataRefresh();
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

// ============================================================================
// Sheet references (Wave 1): a sheet is addressed by 0-based INDEX or by NAME
// ============================================================================
// The ONE resolver every executor that receives a sheet ref calls, at
// execution time, against the LIVE sheet list — never worker-side, so a name
// always means what the workbook means by it when the call lands. A number
// passes through bounds-checked; a string resolves by EXACT name first, then
// case-insensitively IF unique. Every refusal lists the actual sheets, because
// the error a VBA convert reads at 11pm must name them.

/** A sheet as the resolver sees it (the subset of SheetInfo it needs). */
interface SheetListEntry {
  index: number;
  name: string;
}

function describeSheets(sheets: SheetListEntry[]): string {
  return sheets.map((s) => `"${s.name}" (${s.index})`).join(", ");
}

/** Pure resolution over a given sheet list. Exported for tests. */
export function resolveSheetRefIn(
  sheets: SheetListEntry[],
  ref: number | string,
  method: string,
): number {
  if (typeof ref === "number") {
    if (sheets.some((s) => s.index === ref)) return ref;
    throw new BrokerError(
      "ValidationError",
      `${method}: no sheet with index ${ref} (sheets: ${describeSheets(sheets)})`,
    );
  }
  const exact = sheets.filter((s) => s.name === ref);
  if (exact.length === 1) return exact[0].index;
  const lower = ref.toLowerCase();
  const relaxed = sheets.filter((s) => s.name.toLowerCase() === lower);
  if (relaxed.length === 1) return relaxed[0].index;
  if (relaxed.length > 1) {
    throw new BrokerError(
      "ValidationError",
      `${method}: sheet name "${ref}" is ambiguous ignoring case ` +
        `(matches ${describeSheets(relaxed)}) — use the exact name or the index`,
    );
  }
  throw new BrokerError(
    "ValidationError",
    `${method}: no sheet named "${ref}" (sheets: ${describeSheets(sheets)})`,
  );
}

/**
 * Resolve an addSheet/copySheet `{ before | after }` position bag (Wave 4) to
 * the FINAL tab-bar index the new sheet should land on, computed in the list
 * WITHOUT the new sheet (`baseSheets` — the pre-add/pre-copy list). Since
 * move_sheet rotates the moved sheet to exactly `toIndex`, and rotating equals
 * "remove, then insert at toIndex", this answer feeds moveSheet directly.
 * Null = no position requested (keep the historical placement).
 */
export function resolveSheetPosition(
  baseSheets: SheetListEntry[],
  position:
    | { before?: number | string | null; after?: number | string | null }
    | undefined
    | null,
  method: string,
): number | null {
  if (!position) return null;
  const hasBefore = position.before !== undefined && position.before !== null;
  const hasAfter = position.after !== undefined && position.after !== null;
  if (!hasBefore && !hasAfter) return null;
  // vAddSheet/vCopySheet already refused both-set; re-refused here so a caller
  // that reaches this helper another way gets the same answer.
  if (hasBefore && hasAfter) {
    throw new BrokerError(
      "ValidationError",
      `${method}: position may name before OR after, not both`,
    );
  }
  const anchor = resolveSheetRefIn(
    baseSheets,
    (hasBefore ? position.before : position.after) as number | string,
    method,
  );
  return hasBefore ? anchor : anchor + 1;
}

/** Resolve a REQUIRED sheet ref against the live sheet list. */
async function resolveSheetRef(
  lib: Awaited<ReturnType<typeof getLib>>,
  ref: number | string,
  method: string,
): Promise<number> {
  const { sheets } = await lib.getSheets();
  return resolveSheetRefIn(sheets, ref, method);
}

/** Resolve an OPTIONAL sheet ref; undefined/null = "the active sheet". */
async function resolveOptionalSheetRef(
  lib: Awaited<ReturnType<typeof getLib>>,
  ref: number | string | undefined | null,
  method: string,
): Promise<number | undefined> {
  if (ref === undefined || ref === null) return undefined;
  return resolveSheetRef(lib, ref, method);
}

/**
 * Resolve the sheet an ACTIVE-SHEET-ONLY backend command may touch. `undefined`
 * means "the active sheet"; naming another one (by index or by name) is refused
 * with the fix spelled out. Returns the active sheet index (for write
 * attribution).
 */
async function assertActiveSheet(
  lib: Awaited<ReturnType<typeof getLib>>,
  sheetRef: number | string | undefined | null,
  method: string,
): Promise<number> {
  if (sheetRef === undefined || sheetRef === null) return lib.getActiveSheet();
  const { sheets, activeIndex } = await lib.getSheets();
  const resolved = resolveSheetRefIn(sheets, sheetRef, method);
  if (resolved === activeIndex) return activeIndex;
  throw new BrokerError(
    "ValidationError",
    `${method} can only target the active sheet (currently ${activeIndex}); ` +
      `call api.setActiveSheet(${JSON.stringify(sheetRef)}) first`,
  );
}

// ============================================================================
// Selection (Wave 2): the normalized shape scripts see
// ============================================================================
// Core's Selection keeps its ANCHOR in startRow/startCol and its ACTIVE CELL in
// endRow/endCol, so a drag up-and-left yields start > end — correct for the
// grid, hostile for a script doing arithmetic on the rectangle. What crosses to
// scripts is NORMALIZED (start <= end per axis) with the active cell carried
// separately, plus EVERY area of a multi-area selection — additionalRanges,
// which the script-facing emitters used to drop.

/** One rectangular area of a selection, normalized (start <= end per axis). */
export interface ScriptSelectionArea {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** What api.getSelection returns (null when nothing is selected). */
export interface ScriptSelectionSnapshot extends ScriptSelectionArea {
  /** The sheet the selection lives on (0-based). */
  sheetIndex: number;
  /** The active cell — the one a keystroke would land in. */
  activeRow: number;
  activeCol: number;
  /** EVERY selected area: the primary rectangle first, then each Ctrl+Click
   *  area, all normalized. Always at least one entry. */
  areas: ScriptSelectionArea[];
}

/** api.select options (mirrors the worker shim's ScriptSelectOptions). */
interface ScriptSelectOptions {
  sheetIndex?: number | string;
  /** Default true: scroll the selection into view (Application.Goto). */
  scroll?: boolean;
  /** Additional areas for a multi-area selection (Ctrl+Click shape). */
  ranges?: ScriptSelectionArea[];
}

/** Normalize one rectangle so start <= end on both axes. */
export function normalizeSelectionArea(a: {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}): ScriptSelectionArea {
  return {
    startRow: Math.min(a.startRow, a.endRow),
    startCol: Math.min(a.startCol, a.endCol),
    endRow: Math.max(a.startRow, a.endRow),
    endCol: Math.max(a.startCol, a.endCol),
  };
}

/**
 * Core Selection -> the normalized script shape. Pure; exported for tests.
 * `activeSheetIndex` is the fallback for a Selection that does not carry its
 * own sheetIndex (Core's usually does not — it lives on the active sheet by
 * construction).
 */
export function normalizeSelection(
  sel: {
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
    sheetIndex?: number;
    activeRow?: number;
    activeCol?: number;
    additionalRanges?: Array<{ startRow: number; startCol: number; endRow: number; endCol: number }>;
  },
  activeSheetIndex: number,
): ScriptSelectionSnapshot {
  const primary = normalizeSelectionArea(sel);
  return {
    ...primary,
    sheetIndex: sel.sheetIndex ?? activeSheetIndex,
    // Selection's own convention: end IS the active cell (aliases may override).
    activeRow: sel.activeRow ?? sel.endRow,
    activeCol: sel.activeCol ?? sel.endCol,
    areas: [primary, ...(sel.additionalRanges ?? []).map(normalizeSelectionArea)],
  };
}

/**
 * Ask the canvas to re-fetch cell data, AT MOST ONCE PER FRAME.
 *
 * Coalesced on purpose. A script that loops `await api.setCellValue(...)` ten
 * thousand times would otherwise dispatch ten thousand `grid:refresh` events,
 * each of which starts its own viewport fetch — turning the fix for an
 * invisible write into a stall. Every scheduled refresh is TRAILING, so the
 * last one always runs and the final state is what the user ends up looking at.
 *
 * Kept separate from the per-cell `cellEvents` batch, which is NOT coalesced:
 * those carry semantics (which cells changed) that downstream features need in
 * full, and they cost nothing but a synchronous fan-out.
 */
let gridRefreshScheduled = false;

// ---- Deferred repaint (Wave 4): api.beginBatch({ deferRepaint: true }) ----
// ScreenUpdating with a guaranteed end. While ONE script holds the deferral,
// this choke point — the broker's single door to the canvas after a mutate —
// swallows every refresh broadcast and remembers that one is owed; the release
// (commitBatch, cancelBatch, or the holder's unmount/fault) fires exactly ONE
// trailing refresh. Ownership is a single holder, not a set: the deferral is
// bracketed by one script's batch, and a second script asking while a batch is
// open must not be able to extend (or steal) the first one's bracket.

let deferredRepaintHolder: string | null = null;
let repaintOwedWhileDeferred = false;

/** Test seam: which script (if any) currently holds repaints paused. */
export function scriptHoldingDeferredRepaint(): string | null {
  return deferredRepaintHolder;
}

/** Pause repaint broadcasts for `scriptId`'s open batch. First holder wins —
 *  a later script cannot take over a pause it does not own the bracket for. */
export function acquireDeferredRepaint(scriptId: string): void {
  if (deferredRepaintHolder === null) deferredRepaintHolder = scriptId;
}

/**
 * End `scriptId`'s repaint pause (commit, cancel, unmount, fault) and fire the
 * ONE trailing refresh the swallowed broadcasts are owed. A no-op for anyone
 * who is not the holder, so an unrelated script's commitBatch can never
 * unfreeze — or double-refresh — a bracket it does not own.
 */
export function releaseDeferredRepaint(scriptId: string): void {
  if (deferredRepaintHolder !== scriptId) return;
  deferredRepaintHolder = null;
  if (repaintOwedWhileDeferred) {
    repaintOwedWhileDeferred = false;
    scheduleGridDataRefresh();
  }
}

/** Workbook-swap sweep (hostResetAll): drop the pause without repainting — the
 *  document under the canvas is being replaced wholesale anyway. */
export function resetDeferredRepaint(): void {
  deferredRepaintHolder = null;
  repaintOwedWhileDeferred = false;
}

function scheduleGridDataRefresh(): void {
  if (deferredRepaintHolder !== null) {
    // A deferRepaint batch is open: swallow the broadcast, remember the debt.
    repaintOwedWhileDeferred = true;
    return;
  }
  if (gridRefreshScheduled) return;
  gridRefreshScheduled = true;
  const fire = (): void => {
    gridRefreshScheduled = false;
    emitAppEvent(AppEvents.MUTATION_REFRESH, { domains: ["styles"] });
    void import("../grid").then((grid) => grid.refreshGridData());
  };
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(fire);
  } else {
    setTimeout(fire, 16);
  }
}

/** Push a batch of changed cells to the grid + style caches (the same refresh
 *  choreography the Home tab performs after applyFormatting). */
async function afterCellDataChange(cells: CellData[]): Promise<void> {
  if (cells.length > 0) {
    const { cellEvents, cellToChange } = await import("../../core/lib/cellEvents");
    cellEvents.emitBatch(cells.map(cellToChange), "script");
  }
  scheduleGridDataRefresh();
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

// ============================================================================
// Theme colors + fills in the script format vocabulary (Wave 4)
// ============================================================================
// Wherever a format key takes a color, a script may write a HEX STRING or a
// THEME REFERENCE `{ theme, tint? }` (slot = one of the 12 document-theme
// slots; tint = a FRACTION -1..1, positive lighter). textColor /
// backgroundColor theme refs ride the backend's *_theme/*_tint
// FormattingParams fields — the engine stores the REFERENCE, so a later theme
// change restyles the cells and the read-back reports the theme object.
// Border-side colors have no theme slot in the border pipeline
// (BorderSideParam is absolute-only), so a theme ref there is RESOLVED to its
// current hex at write time and reads back as that hex.

/** A theme color reference: a slot key ("accent1", "dark1", ...) plus an
 *  optional tint FRACTION (-1..1; positive = lighter, negative = darker). */
export interface ScriptThemeColorRef {
  theme: string;
  tint?: number;
}

/** Any color a script writes: "#rrggbb(aa)" hex or a theme reference. */
export type ScriptColorValue = string | ScriptThemeColorRef;

/** A theme color as the READ-BACK reports it (tint always present). */
export interface ScriptThemeColorReadback {
  theme: string;
  tint: number;
}

/** A color as the read-back reports it: canonical "#rrggbb" hex for an
 *  absolute color, the theme object for a theme-referenced one. */
export type ScriptColorReadback = string | ScriptThemeColorReadback;

/** The script `fill` vocabulary (write side) — mirrors the backend FillParam
 *  union, with script colors in every slot. */
export type ScriptFillSpec =
  | { type: "none" }
  | { type: "solid"; color: ScriptColorValue }
  | { type: "pattern"; patternType: string; fgColor: ScriptColorValue; bgColor: ScriptColorValue }
  | { type: "gradient"; color1: ScriptColorValue; color2: ScriptColorValue; direction: string };

/** A fill as the read-back reports it ({ type: "none" } when the cell has no
 *  fill beyond the default background). */
export type ScriptFillReadback =
  | { type: "none" }
  | { type: "solid"; color: ScriptColorReadback }
  | { type: "pattern"; patternType: string; fgColor: ScriptColorReadback; bgColor: ScriptColorReadback }
  | { type: "gradient"; color1: ScriptColorReadback; color2: ScriptColorReadback; direction: string };

/** One border edge as a script spells it ({ style, color } — no width; the
 *  width IS the style: thin/medium/thick). */
interface ScriptBorderSideSpec {
  style: string;
  color: ScriptColorValue;
}

/**
 * What setRangeFormat accepts since Wave 3 item 2 (theme colors + fills since
 * Wave 4): the per-cell FormattingOptions vocabulary with script COLORS in
 * every color slot, plus the three RANGE-EDGE border keys, which describe the
 * RECTANGLE and are decomposed host-side into per-cell truth.
 */
export interface ScriptRangeFormat
  extends Omit<
    FormattingOptions,
    | "textColor" | "backgroundColor" | "fill"
    | "borderTop" | "borderRight" | "borderBottom" | "borderLeft"
    | "borderDiagonalDown" | "borderDiagonalUp"
  > {
  textColor?: ScriptColorValue;
  backgroundColor?: ScriptColorValue;
  fill?: ScriptFillSpec;
  borderTop?: ScriptBorderSideSpec;
  borderRight?: ScriptBorderSideSpec;
  borderBottom?: ScriptBorderSideSpec;
  borderLeft?: ScriptBorderSideSpec;
  borderDiagonalDown?: ScriptBorderSideSpec;
  borderDiagonalUp?: ScriptBorderSideSpec;
  borderOutline?: ScriptBorderSideSpec;
  borderInsideHorizontal?: ScriptBorderSideSpec;
  borderInsideVertical?: ScriptBorderSideSpec;
}

const isThemeColorRef = (v: ScriptColorValue): v is ScriptThemeColorRef =>
  typeof v === "object" && v !== null;

/** Script tint fraction (-1..1) -> the engine's permille form. */
const tintToPermille = (tint: number | undefined): number => Math.round((tint ?? 0) * 1000);
/** Engine permille -> the script's fraction form. */
const permilleToFraction = (permille: number | null | undefined): number => (permille ?? 0) / 1000;

/**
 * The engine's tint math (theme.rs apply_tint), channel for channel: positive
 * blends toward white, negative toward black. `tint` is a FRACTION. Exported
 * for the round-trip test.
 */
export function applyThemeTint(hex: string, tint: number): string {
  const canonical = normalizeHexColor(hex);
  if (tint === 0) return canonical;
  const blend = (channel: number): number => {
    const c = channel;
    const result = tint > 0 ? c + (255 - c) * tint : c * (1 + tint);
    return Math.max(0, Math.min(255, Math.round(result)));
  };
  const hexPart = (v: number): string => v.toString(16).padStart(2, "0");
  const r = blend(parseInt(canonical.slice(1, 3), 16));
  const g = blend(parseInt(canonical.slice(3, 5), 16));
  const b = blend(parseInt(canonical.slice(5, 7), 16));
  return `#${hexPart(r)}${hexPart(g)}${hexPart(b)}`;
}

/** Resolve a theme reference against the given document theme. Exported for
 *  tests (and the border/write path below). */
export function resolveThemeColorRef(
  theme: { colors: Record<string, string> },
  ref: ScriptThemeColorRef,
): string {
  const base = theme.colors[ref.theme];
  return applyThemeTint(base ?? "#000000", ref.tint ?? 0);
}

/** The lowered (backend-vocabulary) form of a script format: plain
 *  FormattingOptions plus the three edge keys with RESOLVED hex colors. */
interface LoweredRangeFormat extends FormattingOptions {
  borderOutline?: { style: string; color: string };
  borderInsideHorizontal?: { style: string; color: string };
  borderInsideVertical?: { style: string; color: string };
}

const BORDER_SPEC_KEYS = [
  "borderTop", "borderRight", "borderBottom", "borderLeft",
  "borderDiagonalDown", "borderDiagonalUp",
  "borderOutline", "borderInsideHorizontal", "borderInsideVertical",
] as const;

/**
 * Lower the SCRIPT format vocabulary onto the backend's: theme text/background
 * colors become *Theme/*Tint FormattingParams fields (the engine stores the
 * reference); theme border colors are resolved to hex (the border pipeline is
 * absolute-only); fills become FillParam with theme fields where referenced.
 * The document theme is fetched AT MOST ONCE, and only when something actually
 * references it. Exported for tests.
 */
export async function lowerScriptFormat(
  lib: Awaited<ReturnType<typeof getLib>>,
  format: ScriptRangeFormat,
): Promise<LoweredRangeFormat> {
  let theme: { colors: Record<string, string> } | null = null;
  const resolveColor = async (c: ScriptColorValue): Promise<string> => {
    if (!isThemeColorRef(c)) return c;
    if (!theme) {
      theme = (await lib.getDocumentTheme()) as unknown as { colors: Record<string, string> };
    }
    return resolveThemeColorRef(theme, c);
  };
  const {
    textColor, backgroundColor, fill,
    borderTop, borderRight, borderBottom, borderLeft,
    borderDiagonalDown, borderDiagonalUp,
    borderOutline, borderInsideHorizontal, borderInsideVertical,
    ...rest
  } = format;
  const out: LoweredRangeFormat = { ...rest };
  if (textColor !== undefined) {
    if (isThemeColorRef(textColor)) {
      out.textColorTheme = textColor.theme;
      out.textColorTint = tintToPermille(textColor.tint);
    } else {
      out.textColor = textColor;
    }
  }
  if (backgroundColor !== undefined) {
    if (isThemeColorRef(backgroundColor)) {
      out.bgColorTheme = backgroundColor.theme;
      out.bgColorTint = tintToPermille(backgroundColor.tint);
    } else {
      out.backgroundColor = backgroundColor;
    }
  }
  if (fill !== undefined) {
    out.fill = await lowerFillSpec(fill, resolveColor);
  }
  const sides = {
    borderTop, borderRight, borderBottom, borderLeft,
    borderDiagonalDown, borderDiagonalUp,
    borderOutline, borderInsideHorizontal, borderInsideVertical,
  } as Record<(typeof BORDER_SPEC_KEYS)[number], ScriptBorderSideSpec | undefined>;
  for (const key of BORDER_SPEC_KEYS) {
    const side = sides[key];
    if (side === undefined) continue;
    out[key] = { style: side.style, color: await resolveColor(side.color) };
  }
  return out;
}

/** Script fill -> backend FillParam (theme colors carry BOTH the reference and
 *  their current hex — the hex is the parse fallback, never the truth). */
async function lowerFillSpec(
  fill: ScriptFillSpec,
  resolveColor: (c: ScriptColorValue) => Promise<string>,
): Promise<NonNullable<FormattingOptions["fill"]>> {
  const parts = async (
    c: ScriptColorValue,
  ): Promise<{ hex: string; theme?: string; tint?: number }> =>
    isThemeColorRef(c)
      ? { hex: await resolveColor(c), theme: c.theme, tint: tintToPermille(c.tint) }
      : { hex: c };
  switch (fill.type) {
    case "none":
      return { type: "none" };
    case "solid": {
      const c = await parts(fill.color);
      return { type: "solid", color: c.hex, colorTheme: c.theme, colorTint: c.tint };
    }
    case "pattern": {
      const fg = await parts(fill.fgColor);
      const bg = await parts(fill.bgColor);
      // patternType/direction were enumerated by the validator against the
      // backend's own vocabulary, so the cast is a formality, not a loophole.
      return {
        type: "pattern",
        patternType: fill.patternType,
        fgColor: fg.hex,
        bgColor: bg.hex,
        fgColorTheme: fg.theme,
        fgColorTint: fg.tint,
        bgColorTheme: bg.theme,
        bgColorTint: bg.tint,
      } as NonNullable<FormattingOptions["fill"]>;
    }
    default: {
      const c1 = await parts(fill.color1);
      const c2 = await parts(fill.color2);
      return {
        type: "gradient",
        color1: c1.hex,
        color2: c2.hex,
        direction: fill.direction,
        color1Theme: c1.theme,
        color1Tint: c1.tint,
        color2Theme: c2.theme,
        color2Tint: c2.tint,
      } as NonNullable<FormattingOptions["fill"]>;
    }
  }
}

/**
 * Map a script border side onto apply_border_preset's (style, color, width)
 * vocabulary. The backend stores width + line style and REPORTS them back as
 * one word (border_side_to_data: Solid/1 = "thin", Solid/2 = "medium",
 * Solid/3 = "thick"), so this mapping is what makes the read-back word equal
 * the word that was written. Exported for the round-trip test.
 */
export function borderPresetArgs(
  side: { style: string; color: string },
): { style: string; color: string; width: number } {
  switch (side.style) {
    case "none":   return { style: "solid",  color: side.color, width: 0 };
    case "thin":   return { style: "solid",  color: side.color, width: 1 };
    case "medium": return { style: "solid",  color: side.color, width: 2 };
    case "thick":  return { style: "solid",  color: side.color, width: 3 };
    case "dashed": return { style: "dashed", color: side.color, width: 1 };
    case "dotted": return { style: "dotted", color: side.color, width: 1 };
    case "double": return { style: "double", color: side.color, width: 1 };
    // The validator enumerated the styles, so this arm is unreachable — kept
    // total so a future style fails visibly rather than as undefined.
    default:       return { style: "solid",  color: side.color, width: 1 };
  }
}

/**
 * Apply a PARTIAL format to a rectangle. Absent properties are left alone, so a
 * script can bold a block without resetting its number format. The active sheet
 * takes apply_formatting (which also replicates to a grouped sheet selection,
 * exactly as a ribbon click would); another sheet takes the sheet-scoped
 * apply_formatting_to_sheets.
 *
 * RANGE-EDGE BORDERS (Wave 3, item 2). borderOutline / borderInsideHorizontal /
 * borderInsideVertical are decomposed here into the per-cell truth via the SAME
 * apply_border_preset command the ribbon's border menu calls ("outside" /
 * "insideHorizontal" / "insideVertical") — outline puts each side only on its
 * edge cells; the inside presets put the interior edges on BOTH adjoining
 * cells, exactly as Excel stores them, so a later per-cell read reports what
 * Excel would. These presets are ACTIVE-SHEET commands (no sheet parameter
 * exists), so an off-sheet target combined with an edge key is refused.
 *
 * UNDO GRANULARITY: apply_formatting and apply_border_preset join an
 * already-open frontend transaction (the `opened_transaction` guard
 * update_cells_batch uses), so the withScriptUndoBatch wrap below makes a
 * multi-call decomposition (base keys + several edge keys) a GENUINE single
 * undo step; a single-key call — the common case — is one backend step and
 * takes no wrap at all.
 *
 * Exported for tests (jsdom cannot spawn the worker realm; the recording-lib
 * pattern rangeClipboard.test.ts uses applies here too).
 */
export async function applyRangeFormat(
  lib: Awaited<ReturnType<typeof getLib>>,
  sheetIndex: number | undefined,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  format: ScriptRangeFormat,
): Promise<void> {
  assertRangeSize(startRow, startCol, endRow, endCol);
  // Lower the script vocabulary first (theme refs -> *Theme/*Tint or resolved
  // hex, script fill -> FillParam) — a pure read, so it precedes every write.
  const lowered = await lowerScriptFormat(lib, format);
  const { borderOutline, borderInsideHorizontal, borderInsideVertical, ...base } = lowered;
  // [preset, side] in application order: interiors first, outline last, so a
  // border box reads visually correct even while a repaint lands mid-way.
  const edges: Array<[preset: string, side: { style: string; color: string } | undefined]> = [
    ["insideHorizontal", borderInsideHorizontal],
    ["insideVertical", borderInsideVertical],
    ["outside", borderOutline],
  ];
  const edgeCount = edges.filter(([, side]) => side !== undefined).length;
  const hasBaseKeys = Object.values(base).some((v) => v !== undefined);
  const active = await lib.getActiveSheet();
  const target = sheetIndex ?? active;
  if (edgeCount > 0 && target !== active) {
    throw new BrokerError(
      "ValidationError",
      "borderOutline / borderInsideHorizontal / borderInsideVertical can only target " +
        `the active sheet (currently ${active}); call api.setActiveSheet(...) first`,
    );
  }
  const { rows, cols } = rectRowsCols(startRow, startCol, endRow, endCol);
  const work = async (): Promise<void> => {
    if (hasBaseKeys || edgeCount === 0) {
      if (target === active) {
        const result = await lib.applyFormatting(rows, cols, base);
        await afterCellDataChange(result.cells);
      } else {
        await lib.applyFormattingToSheets([target], rows, cols, base);
        emitAppEvent(AppEvents.MUTATION_REFRESH, { domains: ["styles"] });
      }
    }
    for (const [preset, side] of edges) {
      if (side === undefined) continue;
      const args = borderPresetArgs(side);
      const result = await lib.applyBorderPreset(
        startRow, startCol, endRow, endCol, preset, args.style, args.color, args.width,
      );
      await afterCellDataChange(result.cells);
    }
  };
  const backendCalls = (hasBaseKeys || edgeCount === 0 ? 1 : 0) + edgeCount;
  if (backendCalls > 1) {
    await withScriptUndoBatch(lib, "Format range", work);
  } else {
    await work();
  }
}

/**
 * Strip ALL formatting from a rectangle, keeping the values. Backed by
 * clear_range_with_options(applyTo: "formats") — an ACTIVE-SHEET command, so an
 * off-sheet target is refused rather than silently clearing the wrong sheet.
 */
async function clearRangeFormat(
  lib: Awaited<ReturnType<typeof getLib>>,
  sheetIndex: number | string | undefined,
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
// Format READ-BACK (Wave 3, item 1)
// ============================================================================
// The inverse of applyRangeFormat: CellData.styleIndex -> StyleData ->
// ScriptCellFormat, in the SAME vocabulary the write path accepts, so
// setRangeFormat(X) followed by getRangeFormat reports X back (bold: true,
// textColor "#rrggbb", the numberFormat string, textRotation incl. the
// "custom:N" form StyleData emits, one { style, color } per border side).

/** One border edge as a format read reports it. `style` uses the same word
 *  vocabulary the write accepts (none/thin/medium/thick/dashed/dotted/double —
 *  border_side_to_data folds width+line style back into the word). */
export interface ScriptBorderSideReadback {
  style: string;
  color: string;
}

/**
 * The FULLY-POPULATED form of a cell's format, as getRangeFormat /
 * getCellFormat answer it. Every key writable through setRangeFormat reads
 * back here (the three range-edge border keys read back as the per-cell sides
 * they decomposed into), plus the two protection attributes — readable at both
 * tiers, because whether a cell is locked is visible state, while CHANGING it
 * stays unlocked-only.
 *
 * THEME COLORS (Wave 4): a theme-referenced textColor/backgroundColor reads
 * back AS THE THEME OBJECT `{ theme, tint }` — the reference is what the
 * engine stores, so the round trip preserves it — with the resolved hex
 * additionally in textColorResolved / backgroundColorResolved. NOTE the
 * DEFAULT cell reads back theme-referenced too (text = dark1, background =
 * light1): that is genuinely what the engine stores for an untouched cell.
 */
export interface ScriptCellFormat {
  bold: boolean;
  italic: boolean;
  underline: string;
  strikethrough: boolean;
  fontSize: number;
  fontFamily: string;
  /** "#rrggbb" for an absolute color; `{ theme, tint }` for a theme-referenced
   *  one (tint as a FRACTION -1..1). */
  textColor: ScriptColorReadback;
  /** The text color resolved against the current document theme ("#rrggbb"). */
  textColorResolved: string;
  backgroundColor: ScriptColorReadback;
  /** The background resolved against the current document theme ("#rrggbb"). */
  backgroundColorResolved: string;
  textAlign: string;
  verticalAlign: string;
  numberFormat: string;
  wrapText: boolean;
  /** "none" | "rotate90" | "rotate270" | "custom:N" (N in degrees — the form
   *  StyleData emits for a rotation the UI set). */
  textRotation: string;
  indent: number;
  shrinkToFit: boolean;
  /** The cell's fill; `{ type: "none" }` when it has none. A plain
   *  backgroundColor write reads back as a solid fill too (that IS how the
   *  engine stores it). */
  fill: ScriptFillReadback;
  borderTop: ScriptBorderSideReadback;
  borderRight: ScriptBorderSideReadback;
  borderBottom: ScriptBorderSideReadback;
  borderLeft: ScriptBorderSideReadback;
  borderDiagonalDown: ScriptBorderSideReadback;
  borderDiagonalUp: ScriptBorderSideReadback;
  locked: boolean;
  formulaHidden: boolean;
}

/** Canonical hex spelling: leading '#', lowercase — the form Color::to_css
 *  emits, applied on the way OUT so a cached/mocked style with "#ABCDEF" and
 *  the backend's "#abcdef" read back identically. */
function normalizeHexColor(color: string): string {
  const withHash = color.startsWith("#") ? color : `#${color}`;
  return withHash.toLowerCase();
}

/** The fill fields of StyleData as this module reads them (structural — the
 *  backend's FillData with every variant's keys flattened optional). */
interface StyleFillLike {
  type: string;
  color?: string;
  colorTheme?: string | null;
  colorTint?: number | null;
  patternType?: string;
  fgColor?: string;
  bgColor?: string;
  fgColorTheme?: string | null;
  fgColorTint?: number | null;
  bgColorTheme?: string | null;
  bgColorTint?: number | null;
  color1?: string;
  color2?: string;
  direction?: string;
  color1Theme?: string | null;
  color1Tint?: number | null;
  color2Theme?: string | null;
  color2Tint?: number | null;
}

/** One color slot on the way OUT: the theme object when the engine stored a
 *  reference, canonical hex otherwise. */
function colorReadback(
  resolvedHex: string,
  theme: string | null | undefined,
  tintPermille: number | null | undefined,
): ScriptColorReadback {
  if (theme) return { theme, tint: permilleToFraction(tintPermille) };
  return normalizeHexColor(resolvedHex);
}

/** StyleData.fill -> the script fill read-back ({ type: "none" } when absent). */
function fillReadback(fill: StyleFillLike | null | undefined): ScriptFillReadback {
  if (!fill || fill.type === "none") return { type: "none" };
  if (fill.type === "solid") {
    return {
      type: "solid",
      color: colorReadback(fill.color ?? "#ffffff", fill.colorTheme, fill.colorTint),
    };
  }
  if (fill.type === "pattern") {
    return {
      type: "pattern",
      patternType: fill.patternType ?? "none",
      fgColor: colorReadback(fill.fgColor ?? "#000000", fill.fgColorTheme, fill.fgColorTint),
      bgColor: colorReadback(fill.bgColor ?? "#ffffff", fill.bgColorTheme, fill.bgColorTint),
    };
  }
  return {
    type: "gradient",
    color1: colorReadback(fill.color1 ?? "#ffffff", fill.color1Theme, fill.color1Tint),
    color2: colorReadback(fill.color2 ?? "#ffffff", fill.color2Theme, fill.color2Tint),
    direction: fill.direction ?? "horizontal",
  };
}

/** The five fields a script is told about an imported picture. Structurally the
 *  same as `MediaRef` in @api/filesystem, restated here so the projection below
 *  is written against a type that CANNOT grow a `data` member by inheritance. */
interface ScriptMediaHandle {
  ref: string;
  mimeType: string;
  width: number;
  height: number;
  byteLength: number;
}

/**
 * The `cap.fileImportMedia` executor, as its own function so the projection can
 * be tested directly. Exported for tests.
 *
 * `importImageViaPicker` opens the native dialog; the file the user chooses is
 * read, magic-byte validated, byte- and pixel-capped and stored INSIDE THE
 * DOCUMENT by Rust (`read_media_file`). The bytes never enter the WebView, let
 * alone the worker realm.
 *
 * THE RESPONSE IS RE-PROJECTED FIELD BY FIELD rather than passed through, and
 * that is not belt-and-braces. `MediaRef` has no `data` member and a Rust test
 * asserts it never grows one — but that test guards the RUST type, and this is
 * the door with the sandbox on the other side. Naming the five fields here
 * means a sixth cannot travel by default, in this build or a later one.
 *
 * A refusal (wrong format, over a cap, malformed header) propagates as a
 * rejection with the host's own message. That is the point: the ingress this
 * replaces fell back to a 200x150 placeholder and embedded the file anyway.
 */
export async function executeMediaImport(scriptName: string): Promise<ScriptMediaHandle | null> {
  const fs = await import("../filesystem");
  const picked = await fs.importImageViaPicker({
    title: `${scriptName} — choose a picture`,
  });
  if (!picked) return null; // cancelled: a normal outcome, never an error
  return {
    ref: picked.ref,
    mimeType: picked.mimeType,
    width: picked.width,
    height: picked.height,
    byteLength: picked.byteLength,
  };
}

/**
 * StyleData -> the script vocabulary. PURE, and the exact inverse of the
 * applyRangeFormat write path key for key — the round-trip test in
 * __tests__/formatReadback.test.ts is the contract. Exported for tests.
 */
export function styleDataToScriptFormat(style: {
  bold: boolean;
  italic: boolean;
  underline: string;
  strikethrough: boolean;
  fontSize: number;
  fontFamily: string;
  textColor: string;
  backgroundColor: string;
  textAlign: string;
  verticalAlign: string;
  numberFormat: string;
  wrapText: boolean;
  textRotation: string;
  indent: number;
  shrinkToFit: boolean;
  borderTop: { style: string; color: string };
  borderRight: { style: string; color: string };
  borderBottom: { style: string; color: string };
  borderLeft: { style: string; color: string };
  borderDiagonalDown: { style: string; color: string };
  borderDiagonalUp: { style: string; color: string };
  textColorTheme?: string | null;
  textColorTint?: number | null;
  bgColorTheme?: string | null;
  bgColorTint?: number | null;
  fill?: StyleFillLike | null;
  locked: boolean;
  formulaHidden: boolean;
}): ScriptCellFormat {
  const side = (s: { style: string; color: string }): ScriptBorderSideReadback => ({
    style: s.style,
    color: normalizeHexColor(s.color),
  });
  return {
    bold: style.bold,
    italic: style.italic,
    underline: style.underline,
    strikethrough: style.strikethrough,
    fontSize: style.fontSize,
    fontFamily: style.fontFamily,
    textColor: colorReadback(style.textColor, style.textColorTheme, style.textColorTint),
    textColorResolved: normalizeHexColor(style.textColor),
    backgroundColor: colorReadback(style.backgroundColor, style.bgColorTheme, style.bgColorTint),
    backgroundColorResolved: normalizeHexColor(style.backgroundColor),
    textAlign: style.textAlign,
    verticalAlign: style.verticalAlign,
    numberFormat: style.numberFormat,
    wrapText: style.wrapText,
    textRotation: style.textRotation,
    indent: style.indent,
    shrinkToFit: style.shrinkToFit,
    fill: fillReadback(style.fill),
    borderTop: side(style.borderTop),
    borderRight: side(style.borderRight),
    borderBottom: side(style.borderBottom),
    borderLeft: side(style.borderLeft),
    borderDiagonalDown: side(style.borderDiagonalDown),
    borderDiagonalUp: side(style.borderDiagonalUp),
    locked: style.locked,
    formulaHidden: style.formulaHidden,
  };
}

/**
 * Read a rectangle's formats as a DENSE rows x cols grid.
 *
 * The ACTIVE sheet reads style indexes through get_viewport_cells (which also
 * carries the row/column-tier style of an EMPTY cell — a styled empty column
 * reads back styled); another sheet has no bulk cells-with-style command, so
 * it goes through get_watch_cells one triple per cell (bounded by the same
 * MAX_RANGE_CELLS every bulk read obeys). Cells the backend does not answer
 * for hold the default style (index 0).
 *
 * Styles are fetched ONCE per distinct index and the RESULT OBJECTS ARE
 * SHARED across cells of the same style — safe because the grid crosses to
 * the worker realm by structured clone, so a script mutating its copy can
 * never corrupt a neighbour's. Exported for tests.
 */
export async function readRangeFormats(
  lib: Awaited<ReturnType<typeof getLib>>,
  sheetIndex: number | undefined,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): Promise<ScriptCellFormat[][]> {
  assertRangeSize(startRow, startCol, endRow, endCol);
  const active = await lib.getActiveSheet();
  const target = sheetIndex ?? active;
  const rows = endRow - startRow + 1;
  const cols = endCol - startCol + 1;
  const styleIndexAt: number[][] = [];
  for (let r = 0; r < rows; r++) styleIndexAt.push(new Array<number>(cols).fill(0));

  if (target === active) {
    const cells = await lib.getViewportCells(startRow, startCol, endRow, endCol);
    for (const cell of cells) {
      const r = cell.row - startRow;
      const c = cell.col - startCol;
      if (r >= 0 && r < rows && c >= 0 && c < cols) styleIndexAt[r][c] = cell.styleIndex;
    }
  } else {
    const requests: Array<[number, number, number]> = [];
    for (let r = startRow; r <= endRow; r++) {
      for (let c = startCol; c <= endCol; c++) requests.push([target, r, c]);
    }
    const results = await lib.getWatchCells(requests);
    let i = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++, i++) {
        const cell = results[i];
        if (cell) styleIndexAt[r][c] = cell.styleIndex;
      }
    }
  }

  const cache = new Map<number, ScriptCellFormat>();
  const formatFor = async (index: number): Promise<ScriptCellFormat> => {
    const hit = cache.get(index);
    if (hit) return hit;
    const format = styleDataToScriptFormat(await lib.getStyle(index));
    cache.set(index, format);
    return format;
  };
  const out: ScriptCellFormat[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: ScriptCellFormat[] = [];
    for (let c = 0; c < cols; c++) row.push(await formatFor(styleIndexAt[r][c]));
    out.push(row);
  }
  return out;
}

/** Read ONE cell's format (same source as readRangeFormats). */
export async function readCellFormat(
  lib: Awaited<ReturnType<typeof getLib>>,
  sheetIndex: number | undefined,
  row: number,
  col: number,
): Promise<ScriptCellFormat> {
  const grid = await readRangeFormats(lib, sheetIndex, row, col, row, col);
  return grid[0][0];
}

// ============================================================================
// Named cell styles (Wave 4, formatting breadth)
// ============================================================================
// VBA's Styles / Range.Style over the named_styles commands the Cell Styles
// gallery calls. Apply rides the Wave-4 rect command (one undo transaction);
// CREATE has no backend "style from params" command, so it mints the style
// index through the transient-write pattern: one apply_formatting on a scratch
// cell far outside the used range, read the minted index, register the name,
// then revert the cell and drop the undo record — the user's grid and their
// Ctrl+Z history end exactly where they started.

/** What list/create answer a script per style (styleIndex stays internal). */
export interface ScriptNamedStyleInfo {
  name: string;
  builtIn: boolean;
  category: string;
}

/** Apply a named style to a rectangle. ACTIVE SHEET only (the backend command
 *  is); one undo step backend-side. Exported for tests. */
export async function executeApplyNamedStyle(
  lib: Awaited<ReturnType<typeof getLib>>,
  name: string,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  sheetRef?: number | string | null,
): Promise<void> {
  assertRangeSize(startRow, startCol, endRow, endCol);
  await assertActiveSheet(lib, sheetRef, "applyNamedStyle");
  const result = await lib.applyNamedStyleRange(name, startRow, startCol, endRow, endCol);
  await afterCellDataChange(result.cells);
}

/**
 * A cell to derive a style from: outside the used range, no cell stored, no
 * row/column-tier style (getViewportCells synthesizes entries for tier-styled
 * empty cells, so "absent or effective index 0 and empty" IS virgin). Walks a
 * short diagonal in case the first candidate is styled.
 */
async function findScratchCell(
  lib: Awaited<ReturnType<typeof getLib>>,
): Promise<{ row: number; col: number }> {
  const used = await lib.getUsedRange();
  const baseRow = used.empty ? 0 : used.endRow + 2;
  const baseCol = used.empty ? 0 : used.endCol + 2;
  for (let attempt = 0; attempt < 16; attempt++) {
    const row = baseRow + attempt * 3;
    const col = baseCol + attempt * 5;
    const cells = await lib.getViewportCells(row, col, row, col);
    const cell = cells.find((c) => c.row === row && c.col === col);
    if (!cell || (cell.styleIndex === 0 && !cell.display && !cell.formula)) {
      return { row, col };
    }
  }
  throw new BrokerError(
    "HostError",
    "could not find an unstyled scratch cell to derive the style from",
  );
}

/**
 * Create a custom named style from a script format. Transient-write dance (see
 * the section comment): the scratch write joins ONE transaction that is
 * CANCELLED (records dropped) after the cell is reverted — unless the script
 * already holds an open batch, in which case the apply+revert pair simply
 * nets to nothing inside it (cancelling would destroy the script's batch).
 * Exported for tests.
 */
export async function executeCreateNamedStyle(
  lib: Awaited<ReturnType<typeof getLib>>,
  name: string,
  format: ScriptRangeFormat,
): Promise<ScriptNamedStyleInfo> {
  const existing = await lib.getNamedStyles();
  const clash = existing.find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (clash) {
    throw new BrokerError("ValidationError", `a named style called "${clash.name}" already exists`);
  }
  const lowered = await lowerScriptFormat(lib, format);
  const scratch = await findScratchCell(lib);
  const alreadyOpen = (await lib.getUndoState()).transactionOpen;
  if (!alreadyOpen) await lib.beginUndoTransaction(`Create named style '${name}'`);
  let applied = false;
  try {
    const result = await lib.applyFormatting([scratch.row], [scratch.col], lowered);
    applied = true;
    const cell = result.cells.find((c) => c.row === scratch.row && c.col === scratch.col);
    if (!cell) {
      throw new BrokerError("HostError", "the backend reported no style index for the format");
    }
    const created = await lib.createNamedStyle(name, cell.styleIndex, "Custom");
    return { name: created.name, builtIn: created.builtIn, category: created.category };
  } finally {
    if (applied) {
      try {
        // Revert the scratch cell entirely (the style stays in the registry —
        // that is what the named style points at).
        await lib.clearRangeWithOptions(scratch.row, scratch.col, scratch.row, scratch.col, "all");
      } catch {
        // Best effort: the cancel below still drops the undo record, and the
        // scratch cell is outside the used range.
      }
    }
    if (!alreadyOpen) await lib.cancelUndoTransaction();
  }
}

// ============================================================================
// Cross-sheet structural + data ops (Wave 3, items 5/6/12)
// ============================================================================
// The backend commands behind these grew an optional sheetIndex carrying the
// FULL off-sheet guard chain (protection options + per-cell protection on the
// TARGET sheet, spill refusal, writeback claims, subscriber overrides,
// sheet-tagged undo, cross-sheet formula rewrite, recalc of the target and the
// active mirror). Two invariants every executor below keeps:
//   - `sheetRef` absent/null OR resolving to the ACTIVE sheet = the unchanged
//     active path (repaint + events exactly as before Wave 3);
//   - a NON-active target is state-only: the backend returns an empty repaint
//     payload and the canvas is deliberately NOT refreshed (the sheet
//     re-materializes from backend state when the user switches to it).

/** Where a sheet-addressable write goes. */
export interface SheetWriteTarget {
  /** The resolved index to pass to the backend; undefined = active sheet. */
  target: number | undefined;
  /** True when the write lands on a sheet OTHER than the visible one. */
  offSheet: boolean;
  /** The concrete sheet index, for write attribution. */
  sheet: number;
}

/** Resolve an optional sheet ref for a WRITE, deciding the repaint question in
 *  the same breath. Exported for tests. */
export async function resolveSheetWriteTarget(
  lib: Awaited<ReturnType<typeof getLib>>,
  sheetRef: number | string | undefined | null,
  method: string,
): Promise<SheetWriteTarget> {
  if (sheetRef === undefined || sheetRef === null) {
    const active = await lib.getActiveSheet();
    return { target: undefined, offSheet: false, sheet: active };
  }
  const { sheets, activeIndex } = await lib.getSheets();
  const resolved = resolveSheetRefIn(sheets, sheetRef, method);
  return { target: resolved, offSheet: resolved !== activeIndex, sheet: resolved };
}

/** Non-cell document state changed (validation rules, hyperlinks) on the
 *  VISIBLE sheet: the same announce the editing dialogs make, so the
 *  indicator/dropdown chrome repaints without waiting for the next edit. */
function announceNonCellMutation(offSheet: boolean): void {
  if (offSheet) return;
  emitAppEvent(AppEvents.DATA_CHANGED, {});
  scheduleGridDataRefresh();
}

/** The four row/column structural commands (identical shapes). */
export type StructuralOpName = "insertRows" | "deleteRows" | "insertColumns" | "deleteColumns";

export async function executeStructuralOp(
  lib: Awaited<ReturnType<typeof getLib>>,
  op: StructuralOpName,
  start: number,
  count: number,
  sheetRef?: number | string | null,
): Promise<void> {
  const t = await resolveSheetWriteTarget(lib, sheetRef, op);
  // The lib wrappers self-detect an off-sheet target and skip the
  // ROWS_INSERTED-family events + macro recording (those describe the visible
  // canvas); passing the resolved index through is all that is needed here.
  switch (op) {
    case "insertRows": await lib.insertRows(start, count, t.target); break;
    case "deleteRows": await lib.deleteRows(start, count, t.target); break;
    case "insertColumns": await lib.insertColumns(start, count, t.target); break;
    case "deleteColumns": await lib.deleteColumns(start, count, t.target); break;
  }
  if (!t.offSheet) await afterStructuralChange();
}

export async function executeMergeCells(
  lib: Awaited<ReturnType<typeof getLib>>,
  scriptId: string,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  sheetRef?: number | string | null,
): Promise<void> {
  const t = await resolveSheetWriteTarget(lib, sheetRef, "mergeCells");
  const result = await lib.mergeCells(startRow, startCol, endRow, endCol, t.target);
  if (!result.success) {
    throw new BrokerError("ValidationError", "mergeCells was refused (the range overlaps an existing merge)");
  }
  // Off-sheet, updatedCells is [] by contract — attribution and repaint
  // degrade to no-ops together.
  for (const cell of result.updatedCells) {
    recordScriptWrite(scriptId, t.sheet, cell.row, cell.col);
  }
  if (!t.offSheet) await afterCellDataChange(result.updatedCells);
}

export async function executeUnmergeCells(
  lib: Awaited<ReturnType<typeof getLib>>,
  row: number,
  col: number,
  sheetRef?: number | string | null,
): Promise<void> {
  const t = await resolveSheetWriteTarget(lib, sheetRef, "unmergeCells");
  const result = await lib.unmergeCells(row, col, t.target);
  if (!result.success) {
    throw new BrokerError("ValidationError", `No merged region at row=${row} col=${col}`);
  }
  if (!t.offSheet) await afterCellDataChange(result.updatedCells);
}

export async function executeSortRange(
  lib: Awaited<ReturnType<typeof getLib>>,
  scriptId: string,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  fields: Parameters<Awaited<ReturnType<typeof getLib>>["sortRange"]>[4],
  options?: { matchCase?: boolean; hasHeaders?: boolean; orientation?: "rows" | "columns" },
  sheetRef?: number | string | null,
): Promise<number> {
  const t = await resolveSheetWriteTarget(lib, sheetRef, "sortRange");
  const result = await lib.sortRange<SortRangeResultLike>(
    startRow, startCol, endRow, endCol,
    fields,
    { ...(options ?? {}), sheetIndex: t.target },
  );
  if (!result.success) {
    throw new BrokerError("ValidationError", result.error || "sortRange failed");
  }
  for (const cell of result.updatedCells) {
    recordScriptWrite(scriptId, t.sheet, cell.row, cell.col);
  }
  if (!t.offSheet) await afterCellDataChange(result.updatedCells);
  return result.sortedCount;
}

/** The rectangle a range-clamped find/replace names: a plain Box or an A1
 *  spelling ("B2:D10") resolved here, host-side (Wave 4). */
export type ScriptRangeSpec = ScriptRangeBox | string;

/** Resolve a `range` option to a normalized Box. The A1 spelling may NOT name
 *  a sheet — the sheet slot is `options.sheetIndex`, and two competing sheet
 *  claims in one call is exactly the ambiguity this refuses. */
export function resolveScriptRangeSpec(spec: ScriptRangeSpec, method: string): ScriptRangeBox {
  if (typeof spec === "string") {
    const { sheetName, rest } = splitSheetPrefixHost(spec);
    if (sheetName !== null) {
      throw new BrokerError(
        "ValidationError",
        `${method}: options.range must not name a sheet ("${spec}") — use options.sheetIndex`,
      );
    }
    try {
      return parseA1BodyHost(rest);
    } catch {
      throw new BrokerError(
        "ValidationError",
        `${method}: options.range "${spec}" is not an A1 range like "B2:D10"`,
      );
    }
  }
  return {
    startRow: Math.min(spec.startRow, spec.endRow),
    startCol: Math.min(spec.startCol, spec.endCol),
    endRow: Math.max(spec.startRow, spec.endRow),
    endCol: Math.max(spec.startCol, spec.endCol),
  };
}

/** Whether (row, col) lies inside the inclusive box. */
function rangeSpecContains(box: ScriptRangeBox, row: number, col: number): boolean {
  return row >= box.startRow && row <= box.endRow && col >= box.startCol && col <= box.endCol;
}

/** api.findAll options: the search flags plus the Wave-3 sheet slot and the
 *  Wave-4 range clamp. */
export interface ScriptFindAllOptions {
  caseSensitive?: boolean;
  matchEntireCell?: boolean;
  searchFormulas?: boolean;
  sheetIndex?: number | string;
  /** Restrict the search to this rectangle (VBA Range.Find). */
  range?: ScriptRangeSpec;
}

export async function executeFindAll(
  lib: Awaited<ReturnType<typeof getLib>>,
  query: string,
  options?: ScriptFindAllOptions,
): Promise<{ matches: Array<{ row: number; col: number }>; totalCount: number }> {
  const target = await resolveOptionalSheetRef(lib, options?.sheetIndex, "findAll");
  // The range clamp is applied HERE, over the backend's whole-sheet answer:
  // the find command has no rectangle parameter, and filtering coordinates is
  // exactly equivalent (matching is per cell). Resolved BEFORE the backend
  // call so a malformed range fails without the search running.
  const box =
    options?.range !== undefined && options?.range !== null
      ? resolveScriptRangeSpec(options.range, "findAll")
      : null;
  const result = await lib.findAll(query, {
    caseSensitive: options?.caseSensitive ?? false,
    matchEntireCell: options?.matchEntireCell ?? false,
    searchFormulas: options?.searchFormulas ?? false,
    sheetIndex: target,
  });
  // Reshape the backend's [row, col] tuples into named fields — a script
  // reading `m.row` cannot silently swap the two the way `m[0]` can.
  const matches = result.matches
    .filter(([row, col]) => box === null || rangeSpecContains(box, row, col))
    .map(([row, col]) => ({ row, col }));
  return { matches, totalCount: matches.length };
}

/** api.replaceAll options: the replace flags plus the Wave-3 sheet slot and
 *  the Wave-4 range clamp. */
export interface ScriptReplaceAllOptions {
  caseSensitive?: boolean;
  matchEntireCell?: boolean;
  sheetIndex?: number | string;
  /** Restrict the replace to this rectangle (VBA Range.Replace). */
  range?: ScriptRangeSpec;
}

/** Case-insensitive replace-all-occurrences. TWIN of `replace_case_insensitive`
 *  in app/src-tauri/src/commands/search.rs — same walk, same result. */
export function replaceCaseInsensitiveAll(
  text: string,
  search: string,
  replacement: string,
): string {
  if (search.length === 0) return text;
  const searchLower = search.toLowerCase();
  const textLower = text.toLowerCase();
  let result = "";
  let lastEnd = 0;
  let at = textLower.indexOf(searchLower);
  while (at !== -1) {
    result += text.slice(lastEnd, at) + replacement;
    lastEnd = at + search.length;
    at = textLower.indexOf(searchLower, lastEnd);
  }
  return result + text.slice(lastEnd);
}

/**
 * The value transform for a RANGE-CLAMPED replace: what the cell's new INPUT
 * becomes, or null to leave it alone. TWIN of `compute_replacement_value` in
 * app/src-tauri/src/commands/search.rs, over the typed-read cell instead of
 * the engine CellValue: text and number cells only, formula cells skipped,
 * entire-cell mode requires the whole (normalized) text to be the match.
 * Exported for tests.
 */
export function computeRangeReplacement(
  cell: ScriptCell,
  search: string,
  replacement: string,
  caseSensitive: boolean,
  matchEntireCell: boolean,
): { value: string; invariant: boolean } | null {
  if (cell.formula) return null; // formulas are never rewritten (same as Replace All)
  const searchNormalized = caseSensitive ? search : search.toLowerCase();
  if (cell.type === "text") {
    const text = typeof cell.value === "string" ? cell.value : cell.display;
    const newText = caseSensitive
      ? text.split(search).join(replacement)
      : replaceCaseInsensitiveAll(text, search, replacement);
    if (matchEntireCell && newText !== replacement) return null;
    if (newText === text) return null;
    return { value: newText, invariant: false };
  }
  if (cell.type === "number" && typeof cell.value === "number") {
    // The Rust twin matches against the number's canonical text ("{:.0}" for
    // integers, "{}" otherwise) — String(n) is that same spelling in JS.
    const text = String(cell.value);
    const textNormalized = caseSensitive ? text : text.toLowerCase();
    if (matchEntireCell) {
      return textNormalized === searchNormalized ? { value: replacement, invariant: false } : null;
    }
    if (!textNormalized.includes(searchNormalized)) return null;
    const newText = caseSensitive
      ? text.split(search).join(replacement)
      : replaceCaseInsensitiveAll(text, search, replacement);
    const asNumber = Number(newText);
    // A digit-swap that still reads as a number stays a NUMBER (the Rust twin
    // re-parses too) — written invariant so sv-SE cannot re-read "42.5" as 425.
    if (newText.trim().length > 0 && Number.isFinite(asNumber)) {
      return { value: newText, invariant: true };
    }
    return { value: newText, invariant: false };
  }
  return null; // boolean / error / empty: nothing to replace, same as Rust
}

export async function executeReplaceAll(
  lib: Awaited<ReturnType<typeof getLib>>,
  scriptId: string,
  search: string,
  replacement: string,
  options?: ScriptReplaceAllOptions,
): Promise<{ replacementCount: number }> {
  const t = await resolveSheetWriteTarget(lib, options?.sheetIndex, "replaceAll");
  // ---- Range-clamped path (Wave 4): the backend replace command has no
  //      rectangle parameter, so the clamp is done host-side — typed read of
  //      the rectangle, the SAME value transform the Rust command applies
  //      (computeRangeReplacement), and one guarded batch write
  //      (writeCellsOnSheet: one undo step, writeback draft gate, protection
  //      enforced by the write commands themselves).
  if (options?.range !== undefined && options?.range !== null) {
    const box = resolveScriptRangeSpec(options.range, "replaceAll");
    const grid = await readTypedRange(
      lib, t.target, box.startRow, box.startCol, box.endRow, box.endCol,
    );
    const caseSensitive = options?.caseSensitive ?? false;
    const matchEntireCell = options?.matchEntireCell ?? false;
    const updates: Array<{ row: number; col: number; value: string; invariant?: boolean }> = [];
    for (let r = 0; r < grid.length; r++) {
      for (let c = 0; c < grid[r].length; c++) {
        const next = computeRangeReplacement(
          grid[r][c], search, replacement, caseSensitive, matchEntireCell,
        );
        if (next === null) continue;
        updates.push({
          row: box.startRow + r,
          col: box.startCol + c,
          value: next.value,
          invariant: next.invariant,
        });
      }
    }
    for (const u of updates) {
      recordScriptWrite(scriptId, t.sheet, u.row, u.col);
    }
    const active = await lib.getActiveSheet();
    await writeCellsOnSheet(lib, scriptId, t.sheet, active, updates);
    return { replacementCount: updates.length };
  }
  const result = await lib.replaceAll(search, replacement, {
    caseSensitive: options?.caseSensitive ?? false,
    matchEntireCell: options?.matchEntireCell ?? false,
    sheetIndex: t.target,
  });
  for (const cell of result.updatedCells) {
    recordScriptWrite(scriptId, t.sheet, cell.row, cell.col);
  }
  if (!t.offSheet) await afterCellDataChange(result.updatedCells);
  // No skip count: the backend guard REFUSES a replace that touches a claimed
  // writeback region outright (it rejects, naming the region), rather than
  // silently completing a partial edit.
  return { replacementCount: result.replacementCount };
}

// ============================================================================
// Range ops (Wave 4, RANGE-OPS cluster): removeDuplicates / textToColumns /
// getSpecialCells / goalSeek
// ============================================================================

/** api.removeDuplicates options: key columns as RANGE-START OFFSETS
 *  (sortRange-style; the backend takes absolutes, converted here). */
export interface ScriptRemoveDuplicatesOptions {
  columns?: number[];
  hasHeaders?: boolean;
}

export async function executeRemoveDuplicates(
  lib: Awaited<ReturnType<typeof getLib>>,
  scriptId: string,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  options?: ScriptRemoveDuplicatesOptions,
  sheetRef?: number | string | null,
): Promise<{ removedCount: number }> {
  // remove_duplicates is ACTIVE-SHEET-ONLY (no sheet parameter to pass), so a
  // ref naming another sheet is refused, never silently redirected.
  const active = await assertActiveSheet(lib, sheetRef, "removeDuplicates");
  // Offsets -> absolute column indexes; omitted = every column of the range
  // (Excel's default: the whole row is the key).
  const offsets =
    options?.columns ?? Array.from({ length: endCol - startCol + 1 }, (_, i) => i);
  const keyColumns = offsets.map((o) => startCol + o);
  const result = await lib.removeDuplicates(
    startRow, startCol, endRow, endCol, keyColumns, options?.hasHeaders ?? false,
  );
  if (!result.success) {
    throw new BrokerError("ValidationError", result.error || "removeDuplicates failed");
  }
  for (const cell of result.updatedCells) {
    recordScriptWrite(scriptId, active, cell.row, cell.col);
  }
  await afterCellDataChange(result.updatedCells);
  return { removedCount: result.duplicatesRemoved };
}

/** api.textToColumns options (the sheet slot must resolve to the ACTIVE
 *  sheet — the provider writes through the visible grid). */
export interface ScriptTextToColumnsOptions {
  delimiters?: string[];
  consecutiveAsOne?: boolean;
  destination?: { row: number; col: number };
  sheetIndex?: number | string;
}

export async function executeTextToColumns(
  lib: Awaited<ReturnType<typeof getLib>>,
  scriptId: string,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  options?: ScriptTextToColumnsOptions,
): Promise<{ rowsProcessed: number; columnsProduced: number; cellsWritten: number }> {
  const active = await assertActiveSheet(lib, options?.sheetIndex, "textToColumns");
  // The feature-neutral seam (autoFilterService precedent): the TextToColumns
  // extension registered the ONE split implementation the wizard also runs.
  // With the extension disabled this REFUSES rather than half-splitting.
  const { requireTextToColumnsController } = await import("../textToColumnsService");
  const controller = requireTextToColumnsController();
  const result = await controller.split({
    startRow,
    startCol,
    endRow,
    endCol,
    delimiters: options?.delimiters,
    consecutiveAsOne: options?.consecutiveAsOne,
    destination: options?.destination,
  });
  for (const cell of result.writtenCells) {
    recordScriptWrite(scriptId, active, cell.row, cell.col);
  }
  return {
    rowsProcessed: result.rowsProcessed,
    columnsProduced: result.columnsProduced,
    cellsWritten: result.cellsWritten,
  };
}

export async function executeGetSpecialCells(
  lib: Awaited<ReturnType<typeof getLib>>,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  kind: "constants" | "formulas" | "blanks" | "visible",
  sheetRef?: number | string | null,
): Promise<{ cells: Array<{ row: number; col: number }>; truncated: boolean }> {
  const target = await resolveOptionalSheetRef(lib, sheetRef, "getSpecialCells");
  // "visible" is answered ENTIRELY by the backend, on ANY sheet. It used to be
  // patched here: hand-hidden rows/cols lived only in frontend Core state, so
  // the executor unioned them for the ACTIVE sheet and let a background sheet's
  // answer pass through (silently wrong). User hide is backend state now, and
  // collect_hidden_rows_for_sheet composes all three authorities per sheet —
  // there is nothing left for the frontend to add, and adding it would be the
  // second, staler copy of the same fact.
  const result = await lib.getSpecialCells(startRow, startCol, endRow, endCol, kind, target);
  return { cells: result.cells, truncated: result.truncated };
}

// ============================================================================
// Hide / unhide rows and columns (VBA Rows(...).Hidden / Columns(...).Hidden)
// ============================================================================

/** What api.getHiddenRows / api.getHiddenColumns answer.
 *
 *  TWO DIFFERENT QUESTIONS, never conflated:
 *    - `user`      — hidden BY HAND ("what did I hide?")
 *    - `effective` — hidden by ANY authority: user OR filter OR outline
 *                    ("is this row visible?")
 *  `user` is always a subset of `effective`; both are ascending. */
export interface ScriptHiddenLines {
  user: number[];
  effective: number[];
}

/**
 * api.setRowsHidden / api.setColumnsHidden — the whole inclusive span in ONE
 * backend call, so a 500-row Hide is one IPC round-trip and ONE undo step.
 *
 * ACTIVE SHEET ONLY (set_rows_hidden/set_cols_hidden take no sheet parameter),
 * refused rather than redirected when a ref names another sheet. The answer is
 * the sheet's resulting USER-hidden set, which is also what Core's grid state
 * is synced to — no second read anywhere.
 */
export async function executeSetLinesHidden(
  lib: Awaited<ReturnType<typeof getLib>>,
  axis: "rows" | "columns",
  start: number,
  end: number,
  hidden: boolean,
  sheetRef?: number | string | null,
): Promise<{ hidden: number[] }> {
  const method = axis === "rows" ? "setRowsHidden" : "setColumnsHidden";
  await assertActiveSheet(lib, sheetRef, method);
  const span = Array.from({ length: end - start + 1 }, (_, i) => start + i);
  const result =
    axis === "rows"
      ? await lib.setRowsHidden(span, hidden)
      : await lib.setColsHidden(span, hidden);
  await syncHiddenLinesToGrid(axis, result);
  return { hidden: result };
}

/** Push the backend's authoritative USER-hidden set into Core's grid state and
 *  repaint. The reducer composes it with the filter/outline sets it already
 *  holds — this never writes another authority's set. */
async function syncHiddenLinesToGrid(axis: "rows" | "columns", lines: number[]): Promise<void> {
  const [gridApi, dispatchMod] = await Promise.all([import("../grid"), import("../gridDispatch")]);
  dispatchMod.dispatchGridAction(
    axis === "rows"
      ? gridApi.setManuallyHiddenRows(lines)
      : gridApi.setManuallyHiddenCols(lines),
  );
  gridApi.refreshGridData();
}

/**
 * api.getHiddenRows / api.getHiddenColumns — ANY sheet (name or index), because
 * "is row 5 of the Data sheet visible?" must not need an activate-dance.
 */
export async function executeGetHiddenLines(
  lib: Awaited<ReturnType<typeof getLib>>,
  axis: "rows" | "columns",
  sheetRef?: number | string | null,
): Promise<ScriptHiddenLines> {
  const method = axis === "rows" ? "getHiddenRows" : "getHiddenColumns";
  const target = await resolveOptionalSheetRef(lib, sheetRef, method);
  const info =
    axis === "rows"
      ? await lib.getHiddenRowsInfo(target)
      : await lib.getHiddenColsInfo(target);
  return { user: info.user, effective: info.effective };
}

/** api.goalSeek parameters (mirrors the backend's GoalSeekParams + the sheet
 *  slot, which must resolve to the ACTIVE sheet). */
export interface ScriptGoalSeekParams {
  targetRow: number;
  targetCol: number;
  targetValue: number;
  variableRow: number;
  variableCol: number;
  maxIterations?: number;
  tolerance?: number;
  sheetIndex?: number | string;
}

export async function executeGoalSeek(
  lib: Awaited<ReturnType<typeof getLib>>,
  scriptId: string,
  params: ScriptGoalSeekParams,
): Promise<{ converged: boolean; solution: number; iterations: number }> {
  // goal_seek is ACTIVE-SHEET-ONLY (no sheet parameter), refused otherwise —
  // and it WRITES the variable cell, so it is a write-attribution op too.
  const active = await assertActiveSheet(lib, params.sheetIndex, "goalSeek");
  const result = await lib.goalSeek({
    targetRow: params.targetRow,
    targetCol: params.targetCol,
    targetValue: params.targetValue,
    variableRow: params.variableRow,
    variableCol: params.variableCol,
    maxIterations: params.maxIterations,
    tolerance: params.tolerance,
  });
  if (result.error) {
    throw new BrokerError("ValidationError", result.error);
  }
  for (const cell of result.updatedCells) {
    recordScriptWrite(scriptId, active, cell.row, cell.col);
  }
  await afterCellDataChange(result.updatedCells);
  // `converged: false` is an ANSWER, not an error (Excel reports it the same
  // way): the closest value found is left in the cell either way.
  return {
    converged: result.foundSolution,
    solution: result.variableValue,
    iterations: result.iterations,
  };
}

export async function executeClearRange(
  lib: Awaited<ReturnType<typeof getLib>>,
  scriptId: string,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  options?: { applyTo?: "all" | "contents" | "formats" },
  sheetRef?: number | string | null,
): Promise<{ count: number }> {
  const t = await resolveSheetWriteTarget(lib, sheetRef, "clearRange");
  const applyTo = options?.applyTo ?? "all";
  const result = (await lib.clearRangeWithOptions(
    startRow, startCol, endRow, endCol, applyTo, t.target,
  )) as { count: number; updatedCells?: CellData[] };
  const updated = result.updatedCells ?? [];
  // Own-write attribution, so a script's onDataChange never re-fires on its
  // own clear (same rule as mergeCells / replaceAll).
  for (const cell of updated) {
    recordScriptWrite(scriptId, t.sheet, cell.row, cell.col);
  }
  if (!t.offSheet) await afterCellDataChange(updated);
  return { count: result.count };
}

// ============================================================================
// Data validation (Wave 3, item 5)
// ============================================================================
// The script-facing rule is FLAT (checkValidationRule in validators.ts is the
// gate); these two mappers are the single place it meets the backend's nested
// DataValidation union — mirrored field for field, so a validation() read can
// be passed straight back to setValidation().

/** A plain rectangle argument ({ startRow, startCol, endRow, endCol }). */
export interface ScriptRangeBox {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** The flat validation rule scripts speak (the write AND read-back shape). */
export interface ScriptValidationRule {
  type: "wholeNumber" | "decimal" | "list" | "date" | "time" | "textLength" | "custom";
  operator?: DataValidationOperator;
  formula1?: number;
  formula2?: number;
  /** custom only: the formula that must evaluate TRUE. */
  formula?: string;
  /** list only: literal dropdown entries (exactly one of values/sourceRange). */
  values?: string[];
  /** list only: the rectangle the entries come from. */
  sourceRange?: { sheetIndex?: number } & ScriptRangeBox;
  /** list only: show the in-cell dropdown arrow (default true). */
  inCellDropdown?: boolean;
  ignoreBlanks?: boolean;
  inputTitle?: string;
  inputMessage?: string;
  showInput?: boolean;
  errorTitle?: string;
  errorMessage?: string;
  errorStyle?: DataValidationAlertStyle;
  showError?: boolean;
}

/** Flat script rule -> backend DataValidation. Exported for tests. */
export function scriptRuleToDataValidation(rule: ScriptValidationRule): DataValidation {
  let dvRule: DataValidationRule;
  switch (rule.type) {
    case "custom":
      dvRule = { custom: { formula: rule.formula ?? "" } };
      break;
    case "list": {
      const source: ListSource =
        rule.values !== undefined
          ? { values: [...rule.values] }
          : { range: { ...(rule.sourceRange as { sheetIndex?: number } & ScriptRangeBox) } };
      dvRule = { list: { source, inCellDropdown: rule.inCellDropdown !== false } };
      break;
    }
    default: {
      const compare = {
        formula1: rule.formula1 as number,
        formula2: rule.formula2,
        operator: rule.operator as DataValidationOperator,
      };
      dvRule =
        rule.type === "wholeNumber" ? { wholeNumber: compare }
        : rule.type === "decimal" ? { decimal: compare }
        : rule.type === "date" ? { date: compare }
        : rule.type === "time" ? { time: compare }
        : { textLength: compare };
    }
  }
  return {
    rule: dvRule,
    errorAlert: {
      title: rule.errorTitle ?? "",
      message: rule.errorMessage ?? "",
      style: rule.errorStyle ?? "stop",
      showAlert: rule.showError ?? true,
    },
    prompt: {
      title: rule.inputTitle ?? "",
      message: rule.inputMessage ?? "",
      // Providing a prompt is asking for it to show; an explicit flag wins.
      showPrompt: rule.showInput ?? (rule.inputTitle !== undefined || rule.inputMessage !== undefined),
    },
    ignoreBlanks: rule.ignoreBlanks ?? true,
  };
}

/** Backend DataValidation -> the flat script rule ("none" answers null).
 *  Exported for tests. */
export function dataValidationToScriptRule(v: DataValidation): ScriptValidationRule | null {
  const r = v.rule as Record<string, unknown>;
  let flat: ScriptValidationRule;
  const compareKind = (["wholeNumber", "decimal", "date", "time", "textLength"] as const).find(
    (k) => k in r,
  );
  if (compareKind !== undefined) {
    const c = r[compareKind] as { formula1: number; formula2?: number; operator: DataValidationOperator };
    const twoBound = c.operator === "between" || c.operator === "notBetween";
    flat = {
      type: compareKind,
      operator: c.operator,
      formula1: c.formula1,
      // Only the two-bound operators carry formula2, so a read-back always
      // re-validates as a write.
      ...(twoBound && c.formula2 !== undefined ? { formula2: c.formula2 } : {}),
    };
  } else if ("custom" in r) {
    flat = { type: "custom", formula: (r.custom as { formula: string }).formula };
  } else if ("list" in r) {
    const list = r.list as { source: ListSource; inCellDropdown: boolean };
    flat = {
      type: "list",
      ...("values" in list.source
        ? { values: [...list.source.values] }
        : { sourceRange: { ...list.source.range } }),
      inCellDropdown: list.inCellDropdown,
    };
  } else {
    return null; // "none" (or an unknown future kind): no rule to report
  }
  flat.ignoreBlanks = v.ignoreBlanks;
  flat.inputTitle = v.prompt.title;
  flat.inputMessage = v.prompt.message;
  flat.showInput = v.prompt.showPrompt;
  flat.errorTitle = v.errorAlert.title;
  flat.errorMessage = v.errorAlert.message;
  flat.errorStyle = v.errorAlert.style;
  flat.showError = v.errorAlert.showAlert;
  return flat;
}

export async function executeSetDataValidation(
  lib: Awaited<ReturnType<typeof getLib>>,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  rule: ScriptValidationRule,
  sheetRef?: number | string | null,
): Promise<void> {
  const t = await resolveSheetWriteTarget(lib, sheetRef, "setDataValidation");
  const result = await lib.setDataValidation(
    startRow, startCol, endRow, endCol, scriptRuleToDataValidation(rule), t.target,
  );
  if (!result.success) {
    throw new BrokerError("ValidationError", result.error || "setDataValidation failed");
  }
  announceNonCellMutation(t.offSheet);
}

export async function executeClearDataValidation(
  lib: Awaited<ReturnType<typeof getLib>>,
  range: ScriptRangeBox,
  sheetRef?: number | string | null,
): Promise<void> {
  const t = await resolveSheetWriteTarget(lib, sheetRef, "clearDataValidation");
  const result = await lib.clearDataValidation(
    range.startRow, range.startCol, range.endRow, range.endCol, t.target,
  );
  if (!result.success) {
    throw new BrokerError("ValidationError", result.error || "clearDataValidation failed");
  }
  announceNonCellMutation(t.offSheet);
}

export async function executeGetDataValidation(
  lib: Awaited<ReturnType<typeof getLib>>,
  row: number,
  col: number,
  sheetRef?: number | string | null,
): Promise<ScriptValidationRule | null> {
  const target = await resolveOptionalSheetRef(lib, sheetRef, "getDataValidation");
  const validation = await lib.getDataValidation(row, col, target);
  return validation ? dataValidationToScriptRule(validation) : null;
}

/** One entry of api.listDataValidations: the covered rectangle + its rule. */
export interface ScriptValidationRangeInfo extends ScriptRangeBox {
  rule: ScriptValidationRule;
}

export async function executeListDataValidations(
  lib: Awaited<ReturnType<typeof getLib>>,
  sheetRef?: number | string | null,
): Promise<ScriptValidationRangeInfo[]> {
  const target = await resolveOptionalSheetRef(lib, sheetRef, "listDataValidations");
  const ranges = await lib.getAllDataValidations(target);
  const out: ScriptValidationRangeInfo[] = [];
  for (const entry of ranges) {
    const rule = dataValidationToScriptRule(entry.validation);
    if (rule === null) continue; // a stored "none" rule is not a rule
    out.push({
      startRow: entry.startRow,
      startCol: entry.startCol,
      endRow: entry.endRow,
      endCol: entry.endCol,
      rule,
    });
  }
  return out;
}

// ============================================================================
// Hyperlinks (Wave 3, item 6)
// ============================================================================
// Attach / read / remove only. There is NO follow-a-link method, deliberately:
// an external target (url/file/email) opens outside the sandbox and a script
// must never do that on its own; internal navigation already exists as
// api.select / api.scrollTo.

/** What api.addHyperlink accepts — a union on `type`, gated by vAddHyperlink. */
export interface ScriptHyperlinkSpec {
  type: "url" | "email" | "internalReference" | "file";
  /** url / file: the address or path. email: the address (a mailto: prefix is
   *  tolerated and stripped backend-side). */
  target?: string;
  /** email only. */
  subject?: string;
  /** internalReference only: the NAVIGATION-target sheet (omit = same sheet).
   *  Distinct from the `sheet` argument, which is where the link CELL lives. */
  sheetName?: string;
  /** internalReference only: the A1 cell to jump to, e.g. "B4". */
  cellReference?: string;
}

export interface ScriptHyperlinkOptions {
  displayText?: string;
  tooltip?: string;
}

/** A hyperlink as scripts read it back (rebuilt field by field — house rule:
 *  a field the backend adds later stays out until deliberately crossed). */
export interface ScriptHyperlink {
  row: number;
  col: number;
  /** The sheet the link cell LIVES on (0-based). */
  sheetIndex: number;
  type: "url" | "email" | "internalReference" | "file";
  target: string;
  displayText: string | null;
  tooltip: string | null;
  /** internalReference only: the navigation-target sheet (null = same sheet). */
  sheetName: string | null;
  /** internalReference only: the A1 cell the link jumps to. */
  cellReference: string | null;
}

/** Backend Hyperlink -> the script shape. Exported for tests. */
export function hyperlinkToScript(h: Hyperlink): ScriptHyperlink {
  return {
    row: h.row,
    col: h.col,
    sheetIndex: h.sheetIndex,
    type: h.linkType,
    target: h.target,
    displayText: h.displayText ?? null,
    tooltip: h.tooltip ?? null,
    sheetName: h.internalRef?.sheetName ?? null,
    cellReference: h.internalRef?.cellReference ?? null,
  };
}

export async function executeAddHyperlink(
  lib: Awaited<ReturnType<typeof getLib>>,
  row: number,
  col: number,
  link: ScriptHyperlinkSpec,
  options?: ScriptHyperlinkOptions,
  sheetRef?: number | string | null,
): Promise<ScriptHyperlink> {
  const t = await resolveSheetWriteTarget(lib, sheetRef, "addHyperlink");
  const params: AddHyperlinkParams = {
    row,
    col,
    sheetIndex: t.target,
    linkType: link.type,
    // The backend's internal-reference arm reads cellReference (target is its
    // legacy fallback slot); every other arm reads target.
    target: link.type === "internalReference" ? (link.cellReference ?? "") : (link.target ?? ""),
    displayText: options?.displayText,
    tooltip: options?.tooltip,
    sheetName: link.type === "internalReference" ? link.sheetName : undefined,
    cellReference: link.type === "internalReference" ? link.cellReference : undefined,
    emailSubject: link.type === "email" ? link.subject : undefined,
  };
  const result = await lib.addHyperlink(params);
  if (!result.success || !result.hyperlink) {
    throw new BrokerError("ValidationError", result.error || "addHyperlink failed");
  }
  announceNonCellMutation(t.offSheet);
  return hyperlinkToScript(result.hyperlink);
}

export async function executeRemoveHyperlink(
  lib: Awaited<ReturnType<typeof getLib>>,
  row: number,
  col: number,
  sheetRef?: number | string | null,
): Promise<boolean> {
  const t = await resolveSheetWriteTarget(lib, sheetRef, "removeHyperlink");
  const result = await lib.removeHyperlink(row, col, t.target);
  if (result.success) {
    announceNonCellMutation(t.offSheet);
    return true;
  }
  // "There was nothing to remove" answers false (the cell is in the state you
  // asked for — the unprotectSheet convention); real refusals still throw.
  if (result.error && /no hyperlink/i.test(result.error)) return false;
  throw new BrokerError("ValidationError", result.error || "removeHyperlink failed");
}

export async function executeGetHyperlink(
  lib: Awaited<ReturnType<typeof getLib>>,
  row: number,
  col: number,
  sheetRef?: number | string | null,
): Promise<ScriptHyperlink | null> {
  const target = await resolveOptionalSheetRef(lib, sheetRef, "getHyperlink");
  const h = await lib.getHyperlink(row, col, target);
  return h ? hyperlinkToScript(h) : null;
}

export async function executeListHyperlinks(
  lib: Awaited<ReturnType<typeof getLib>>,
  sheetRef?: number | string | null,
): Promise<ScriptHyperlink[]> {
  const target = await resolveOptionalSheetRef(lib, sheetRef, "listHyperlinks");
  const links = await lib.getAllHyperlinks(target);
  return links.map(hyperlinkToScript);
}

// ============================================================================
// Calculation control (Wave 3, item 7)
// ============================================================================
// VBA's Application.Calculation, with the safety VBA never had: the host
// remembers every script that flipped automatic -> manual, and hands the mode
// back to automatic when the LAST such script goes away — unmount, fault,
// debugger stop (all of which pass through hostUnmountScript) and workbook
// swap (hostResetAll). A dead script must never leave the workbook silently
// uncalculating: a stale cell looks exactly like a correct one.

/** Scripts currently holding calculation in manual (only scripts that
 *  actually FLIPPED it — a user's own manual setting is never overridden). */
const manualCalcHolders = new Set<string>();

/** Test seam: which scripts the host would restore automatic for. */
export function scriptsHoldingManualCalculation(): ReadonlySet<string> {
  return manualCalcHolders;
}

/** Test seam / workbook-swap sweep: forget all manual-mode tracking. */
export function resetManualCalculationTracking(): void {
  manualCalcHolders.clear();
}

/**
 * The api.setCalculationMode executor body. Tracks the flip BEFORE the backend
 * write so a crash between the two still restores; a script that sets manual
 * while the mode is ALREADY manual (the user's own choice) is deliberately not
 * tracked — its unmount must not override what the user set by hand.
 */
export async function executeSetCalculationMode(
  lib: Awaited<ReturnType<typeof getLib>>,
  scriptId: string,
  mode: "automatic" | "manual",
): Promise<"automatic" | "manual"> {
  if (mode === "manual") {
    const before = await lib.getCalculationMode();
    // Track the flip — and ALSO a second script joining an existing
    // script-held manual (the mode reads "manual" then, but that manual is
    // script debt, not the user's choice, and the joiner must keep it alive
    // until IT ends too). Only "the USER already had manual and no script is
    // involved" goes untracked.
    if (before !== "manual" || manualCalcHolders.size > 0) {
      manualCalcHolders.add(scriptId);
    }
  } else {
    manualCalcHolders.delete(scriptId);
  }
  const applied = await lib.setCalculationMode(mode);
  return applied === "manual" ? "manual" : "automatic";
}

/**
 * Give the calculation mode back for one departing script: automatic again
 * once NO tracked script still holds manual. Exported for tests and called
 * (fire-and-forget) from hostUnmountScript.
 */
export async function releaseManualCalculation(
  lib: Awaited<ReturnType<typeof getLib>>,
  scriptId: string,
): Promise<void> {
  if (!manualCalcHolders.delete(scriptId)) return;
  if (manualCalcHolders.size > 0) return;
  await lib.setCalculationMode("automatic");
}

/**
 * The api.recalculate executor body: the active sheet by default
 * (calculate_sheet — Shift+F9), the whole workbook with { full: true }
 * (calculate_now — F9, including the cube prefetch and the
 * RECALCULATION_COMPLETED announcement the lib wrappers make). The two are
 * genuinely different passes; until the F9-scope fix they were one pass with
 * two names, so a script asking for `{ full: true }` got the active sheet.
 * The returned cells are pushed through the same refresh choreography every
 * script write uses, so the canvas shows the result.
 */
export async function executeRecalculate(
  lib: Awaited<ReturnType<typeof getLib>>,
  options?: { full?: boolean },
): Promise<{ cellsUpdated: number }> {
  const cells = options?.full === true ? await lib.calculateNow() : await lib.calculateSheet();
  await afterCellDataChange(cells);
  return { cellsUpdated: cells.length };
}

// ============================================================================
// Status bar (Wave 4): Application.StatusBar with the restore VBA never had
// ============================================================================
// The bar is last-write-wins chrome, so ownership is a single holder: the
// script whose message is (or may be) on screen right now. The holder is a
// DEBT exactly like manualCalcHolders — when that script ends in ANY way
// (unmount, fault, debugger stop: all route through hostUnmountScript; and
// workbook swap: hostResetAll) the host clears the bar, so a dead script can
// never pin a stale "Working…" in front of the user.

let statusBarHolder: string | null = null;

/** Test seam: which script's message the host believes is on the bar. */
export function scriptHoldingStatusBar(): string | null {
  return statusBarHolder;
}

/**
 * The api.setStatusBar executor body. Writes the SAME @api/grid service the
 * QuickJS DeferredAction::SetStatusBar lands in (deferredActionHost.ts), so
 * every script surface drives one status bar. `null` restores the default
 * "Ready" — and an explicit null always clears, even a message another script
 * put up, because "make the bar say nothing" is a statement about the bar,
 * not about who wrote last.
 */
export async function executeSetStatusBar(scriptId: string, text: string | null): Promise<void> {
  const grid = await import("../grid");
  if (text === null) {
    statusBarHolder = null;
    grid.clearStatusBarText();
    return;
  }
  statusBarHolder = scriptId;
  grid.setStatusBarText(text);
}

/**
 * Clear the bar for one departing script — but ONLY if its message is the one
 * standing. Called from hostUnmountScript; a script whose message was already
 * replaced owes nothing, and clearing then would erase the replacement.
 */
export function releaseScriptStatusBar(scriptId: string): void {
  if (statusBarHolder !== scriptId) return;
  statusBarHolder = null;
  void import("../grid")
    .then((grid) => grid.clearStatusBarText())
    .catch(() => {
      // Best-effort: the window may already be tearing down.
    });
}

/** Workbook-swap sweep (hostResetAll) / test reset: clear bar + tracking. */
export function resetStatusBarTracking(): void {
  if (statusBarHolder === null) return;
  statusBarHolder = null;
  void import("../grid")
    .then((grid) => grid.clearStatusBarText())
    .catch(() => {
      // Best-effort: the window may already be tearing down.
    });
}

// ============================================================================
// Run-macro (Wave 4): Application.Run over the @api/macroRunService seam
// ============================================================================

/**
 * Macros currently running through api.runMacro, in call order: module id ->
 * display name. Insertion order IS the chain — a nested runMacro awaits inside
 * its caller's entry — which is what lets the cycle refusal name the path
 * (A -> B -> A) instead of just saying "busy".
 */
const runningMacros = new Map<string, string>();

/** Test seam / workbook-swap sweep: forget the running-macro chain. */
export function resetMacroRunTracking(): void {
  runningMacros.clear();
}

/**
 * Resolve a script's macro reference — module id, display name, or the
 * recorder's slug spelling — against the workbook's script list. Exported for
 * tests. Every failure names what WOULD have matched, because "no macro named
 * X" with no list is a puzzle, not an error message.
 */
export function resolveMacroRef(
  scripts: ReadonlyArray<{ id: string; name: string }>,
  ref: string,
): { id: string; name: string } {
  const trimmed = ref.trim();
  // 1. Exact module id ("macro-monthly-report").
  const byId = scripts.find((s) => s.id === trimmed);
  if (byId) return { id: byId.id, name: byId.name };
  // 2. Display name, case-insensitive. Ambiguity is refused WITH the ids —
  //    running one of two same-named scripts at random is the silent-wrong-
  //    macro failure this whole seam exists to prevent.
  const lower = trimmed.toLowerCase();
  const byName = scripts.filter((s) => s.name.toLowerCase() === lower);
  if (byName.length === 1) return { id: byName[0].id, name: byName[0].name };
  if (byName.length > 1) {
    throw new BrokerError(
      "ValidationError",
      `"${trimmed}" names ${byName.length} scripts — run it by module id instead: ` +
        byName.map((s) => `"${s.id}"`).join(", "),
    );
  }
  // 3. The recorder's slug spelling ("monthly report" -> "macro-monthly-report",
  //    same derivation as macroScriptId in the Macro Recorder's library).
  const slug = lower.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug.length > 0) {
    const bySlug = scripts.find((s) => s.id === `macro-${slug}`);
    if (bySlug) return { id: bySlug.id, name: bySlug.name };
  }
  const names = scripts.map((s) => `"${s.name}"`).join(", ");
  throw new BrokerError(
    "ValidationError",
    `no macro named "${trimmed}" in this workbook` +
      (names.length > 0 ? `. Available: ${names}` : " (it holds no scripts at all)"),
  );
}

/**
 * The api.runMacro executor body. One resolution rule, one run path (the same
 * MacroRunProvider a macro-linked button resolves), three explicit outcomes:
 * resolve with the macro's name, or a named throw for notFound / failed. The
 * chain guard runs BEFORE the provider so a self-call (or A -> B -> A) is
 * refused by name instead of recursing until something worse happens.
 */
export async function executeRunMacro(ref: string): Promise<{ name: string }> {
  const macroService = await import("../macroRunService");
  if (!macroService.hasMacroRunProvider()) {
    throw new BrokerError(
      "HostError",
      "the Macro Recorder extension is not loaded, so no macro can run — enable it and try again",
    );
  }
  const scripts = await import("../workbookScripts");
  const summaries = await scripts.listWorkbookScripts();
  const resolved = resolveMacroRef(summaries, ref);
  if (runningMacros.has(resolved.id)) {
    const chain = [...runningMacros.values(), resolved.name].join(" -> ");
    throw new BrokerError(
      "HostError",
      `macro "${resolved.name}" is already running (call chain: ${chain}) — ` +
        "a macro cannot run itself, directly or through another macro",
    );
  }
  runningMacros.set(resolved.id, resolved.name);
  let outcome: import("../macroRunService").MacroRunOutcome;
  try {
    outcome = await macroService.requireMacroRunProvider().runMacroByRef(resolved.id);
  } finally {
    runningMacros.delete(resolved.id);
  }
  switch (outcome.status) {
    case "ran":
      return { name: outcome.name };
    case "notFound":
      // The list said it existed a moment ago; the store disagrees now (a
      // deletion raced the run). Same first-class refusal the button gives.
      throw new BrokerError(
        "ValidationError",
        `no macro with id "${outcome.macroId}" exists in this workbook (it may have just been deleted)`,
      );
    case "failed":
      throw new BrokerError("HostError", `macro "${outcome.name}" failed: ${outcome.message}`);
  }
}

// ============================================================================
// View / window state (Wave 4): the View menu's settings, by name
// ============================================================================

/** The names api.getViewOption / setViewOption speak (vViewOptionSet enforces
 *  the per-name value type before the executor runs). */
export type ScriptViewOptionName = "gridlines" | "headings" | "zeros" | "formulas" | "viewMode";

/**
 * Read one View setting from Core's live grid state. The defaults mirror
 * getInitialState (gridlines/headings/zeros on, formulas off, mode normal) so
 * a headless read before the grid mounts answers what the user WOULD see.
 */
export async function executeGetViewOption(
  name: ScriptViewOptionName,
): Promise<boolean | "normal" | "pageLayout" | "pageBreakPreview"> {
  const grid = await import("../grid");
  const state = grid.getGridStateSnapshot();
  switch (name) {
    case "gridlines": return state?.displayGridlines ?? true;
    case "headings": return state?.displayHeadings ?? true;
    case "zeros": return state?.displayZeros ?? true;
    case "formulas": return state?.showFormulas ?? false;
    case "viewMode": return grid.getViewMode();
  }
}

/**
 * Write one View setting through the SAME app events the View menu emits
 * (the Shell bridges each into Core state, and — for gridlines — persists the
 * backend flag), so a script toggle and a menu click are one mechanism and
 * the menu's checkmarks stay honest. Mirrors the QuickJS deferred-action host
 * (deferredActionHost.ts), which is the other script surface for these.
 */
export async function executeSetViewOption(
  name: ScriptViewOptionName,
  value: boolean | string,
): Promise<void> {
  const grid = await import("../grid");
  switch (name) {
    case "gridlines":
      emitAppEvent(AppEvents.DISPLAY_GRIDLINES_TOGGLED, { displayGridlines: value === true });
      break;
    case "headings":
      emitAppEvent(AppEvents.DISPLAY_HEADINGS_TOGGLED, { displayHeadings: value === true });
      break;
    case "zeros":
      emitAppEvent(AppEvents.DISPLAY_ZEROS_TOGGLED, { displayZeros: value === true });
      break;
    case "formulas":
      emitAppEvent(AppEvents.SHOW_FORMULAS_TOGGLED, { showFormulas: value === true });
      break;
    case "viewMode":
      // changeViewMode emits VIEW_MODE_CHANGED + GRID_REFRESH itself.
      grid.changeViewMode(value as "normal" | "pageLayout" | "pageBreakPreview");
      return;
  }
  // The toggles repaint what the canvas already holds; nothing was re-stored.
  emitAppEvent(AppEvents.GRID_REFRESH);
}

/** What api.getPanes answers: both halves of View ▸ Window in one read. */
export interface ScriptPanes {
  freezeRow: number | null;
  freezeCol: number | null;
  splitRow: number | null;
  splitCol: number | null;
}

/**
 * The api.getPanes executor body: the backend's freeze + split state (the same
 * get_freeze_panes / get_split_window the Shell loads at startup), combined —
 * the read half of the api.freezePanes / api.splitPanes writers.
 */
export async function executeGetPanes(): Promise<ScriptPanes> {
  const tauriApi = await import("../../core/lib/tauri-api");
  const [freeze, split] = await Promise.all([
    tauriApi.getFreezePanes(),
    tauriApi.getSplitWindow(),
  ]);
  return {
    freezeRow: freeze.freezeRow ?? null,
    freezeCol: freeze.freezeCol ?? null,
    splitRow: split.splitRow ?? null,
    splitCol: split.splitCol ?? null,
  };
}

// ============================================================================
// Sheet protection (Wave 3, item 8)
// ============================================================================
// Thin, honest wiring over the SAME protect_sheet / unprotect_sheet /
// get_protection_status commands the Review ribbon calls — active sheet only,
// because that is all the backend addresses.
//
// DECIDED AGAINST, SAID LOUDLY: `scriptsCanEdit` (VBA's UserInterfaceOnly —
// "the protection guards users, the owning workbook's scripts keep write
// access") is not implemented and will not be. Script writes are checked
// against sheet protection by the same authoritative Rust gates a keystroke
// hits; an exemption would have to thread a script-origin flag through every
// backend write path, and — decisively — a bypass that writes through
// protection leaves no trace of what it wrote. The shipped alternative is
// api.withUnprotected (see below), which is auditable end to end.
// vProtectSheet refuses the key and names withUnprotected in the refusal, so
// no script author is left waiting for a flag that is never coming.

/** api.protectSheet options: the SheetProtectionOptions flags (all optional)
 *  plus an optional password. */
export interface ScriptProtectSheetOptions extends Partial<SheetProtectionOptions> {
  password?: string;
}

/** What api.getProtectionStatus answers. */
export interface ScriptProtectionStatus {
  protected: boolean;
  hasPassword: boolean;
  options: SheetProtectionOptions;
}

/**
 * The api.protectSheet executor body. Partial flags are merged over the SAME
 * defaults the Protect Sheet dialog starts from (DEFAULT_PROTECTION_OPTIONS),
 * so an empty call protects exactly like clicking OK in the dialog. Protecting
 * an already-protected sheet is the backend's refusal, surfaced as a
 * ValidationError naming it. Exported for tests.
 */
export async function executeProtectSheet(
  lib: Awaited<ReturnType<typeof getLib>>,
  options?: ScriptProtectSheetOptions,
): Promise<{ protected: true; hasPassword: boolean }> {
  const { password, ...flags } = options ?? {};
  const merged: SheetProtectionOptions = { ...lib.DEFAULT_PROTECTION_OPTIONS };
  for (const key of Object.keys(flags) as Array<keyof SheetProtectionOptions>) {
    const value = flags[key];
    if (value !== undefined) merged[key] = value;
  }
  const usePassword = typeof password === "string" && password.length > 0;
  const result = await lib.protectSheet({
    password: usePassword ? password : undefined,
    options: merged,
  });
  if (!result.success) {
    throw new BrokerError("ValidationError", result.error || "protectSheet was refused");
  }
  return { protected: true, hasPassword: usePassword };
}

/**
 * The api.unprotectSheet executor body. THE CONTRACT: a wrong password answers
 * false — never a throw — because "try the password I have" is a legitimate
 * program shape and an exception would make it exception-driven control flow.
 * An already-unprotected sheet answers true (it is in the asked-for state).
 * Any other backend refusal is a real error and throws. Exported for tests.
 */
export async function executeUnprotectSheet(
  lib: Awaited<ReturnType<typeof getLib>>,
  password?: string,
): Promise<boolean> {
  const result = await lib.unprotectSheet(password);
  if (result.success) return true;
  const error = result.error || "";
  if (/incorrect password/i.test(error)) return false;
  if (/not protected/i.test(error)) return true;
  throw new BrokerError("HostError", error || "unprotectSheet failed");
}

// ============================================================================
// api.withUnprotected — the sanctioned answer to UserInterfaceOnly
// ============================================================================
// WHY THIS AND NOT THE FLAG. VBA's `Protect UserInterfaceOnly:=True` exempts
// code from the protection it just applied. That was rejected here for three
// reasons, in increasing order of weight: it needs a script-origin flag threaded
// through dozens of Rust write gates; Excel's own version does not survive
// save/reload, so the exemption silently lapses; and — decisively — a bypass
// that leaves no trace is invisible in the audit trail, which is the one thing
// Calcula's scripting story is FOR. The sanctioned pattern is
// unprotect -> write -> re-protect, and every step of it shows up in the ring.
//
// What makes the pattern safe is not the worker's try/finally — a killed realm
// never runs its finally, and "the app crashed and left your sheet open" is
// exactly the failure the flag people are afraid of. So the RESTORE IS A HOST
// DEBT, tracked in the map below, released by hostUnmountScript (which every way
// a script ends routes through: explicit unmount, both crash paths, debugger
// stop) and by hostResetAll (workbook swap / BEFORE_CLOSE). This is the
// manualCalcHolders discipline, applied to something stricter than a calc mode.

/** One sheet whose protection is currently lifted on a script's behalf. */
interface UnprotectedHold {
  /** 0-based sheet index the protection belongs to. */
  sheet: number;
  /** The password that was in force, or null if the sheet had none. Kept so
   *  the re-protect restores the SAME password, and so a second caller cannot
   *  join a hold it could not have opened itself. */
  password: string | null;
  /** The permission flags that were in force, captured verbatim BEFORE the
   *  unprotect. Restored verbatim — never DEFAULT_PROTECTION_OPTIONS, which
   *  would quietly rewrite the sheet owner's choices. */
  options: SheetProtectionOptions;
  /** scriptId -> how many nested holds that script currently owns. */
  holders: Map<string, number>;
}

/** sheetIndex -> the live hold. Absent = that sheet is not being held open. */
const unprotectedHolds = new Map<number, UnprotectedHold>();
/** token -> which hold it belongs to, so end() can only release its own. */
const unprotectTokens = new Map<string, { sheet: number; scriptId: string }>();
let nextUnprotectToken = 1;

/**
 * scriptId -> how many times it has DEPARTED (hostUnmountScript ran for it).
 *
 * WHY. `releaseUnprotectedSheets` can only release holds that are already
 * RECORDED. A script that dies while its `beginUnprotected` is still in flight
 * — permission checks passed, unprotect posted, backend not yet answered — is
 * swept BEFORE the hold exists, and the hold recorded a moment later belongs to
 * a script that will never unmount again: nothing releases it and the sheet
 * stays open for the rest of the session. That is the precise leak this helper
 * exists to prevent, so begin compares this counter across its awaits and puts
 * the protection back itself when its owner left in the meantime.
 *
 * NEVER CLEARED, deliberately — not even by resetUnprotectedTracking. A begin
 * captures the value at its start and compares later; zeroing the map between
 * those two points would make a departure that DID happen compare equal, which
 * is exactly the orphan the counter is here to catch. It costs one integer per
 * script id ever mounted.
 */
const scriptDepartures = new Map<string, number>();

function departureEpoch(scriptId: string): number {
  return scriptDepartures.get(scriptId) ?? 0;
}

/** Record that a script has ended. Called by hostUnmountScript for EVERY script,
 *  whether or not it owes a restore — an in-flight begin has not recorded its
 *  hold yet, so "owes nothing" is not the same as "has nothing in flight". */
export function noteScriptDeparture(scriptId: string): void {
  scriptDepartures.set(scriptId, departureEpoch(scriptId) + 1);
}

/** Test seam: read the epoch without mutating it. */
export function scriptDepartureEpoch(scriptId: string): number {
  return departureEpoch(scriptId);
}

/**
 * Per-sheet serialization for every begin/end/restore.
 *
 * Without it, two begins on one sheet can BOTH read "protected" before either
 * records its hold, both unprotect (the second reading "already unprotected"
 * as success), and the second hold overwrites the first — losing the real prior
 * options and leaving the sheet open when only one of the two ends. Every path
 * that reads-then-writes this bookkeeping runs inside the chain, so the whole
 * check-and-record is atomic with respect to the sheet it concerns.
 */
const unprotectQueues = new Map<number, Promise<unknown>>();

function serializeOnSheet<T>(sheet: number, work: () => Promise<T>): Promise<T> {
  const previous = unprotectQueues.get(sheet) ?? Promise.resolve();
  // `work` runs whether the previous link settled or failed: one script's
  // refusal must not wedge the sheet for everyone after it.
  const next = previous.then(work, work);
  unprotectQueues.set(
    sheet,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/** Test seam: the sheets whose protection is currently lifted by a script. */
export function scriptsHoldingUnprotected(): ReadonlyMap<number, UnprotectedHold> {
  return unprotectedHolds;
}

/** Test seam / hostResetAll: forget all hold tracking WITHOUT re-protecting.
 *  hostResetAll restores first and clears second (see its comment there). */
export function resetUnprotectedTracking(): void {
  unprotectedHolds.clear();
  unprotectTokens.clear();
  unprotectQueues.clear();
}

/** Audit a host-initiated protection move that no worker call carried. */
function auditUnprotectRestore(scriptId: string, ok: boolean, error?: string): void {
  appendAudit({
    ts: Date.now(),
    scriptId,
    scriptName: mounted.get(scriptId)?.handle.scriptName ?? scriptId,
    method: "api.endUnprotected",
    class: "mutate",
    ok,
    error,
  });
}

/**
 * Put one hold's protection back exactly as it was.
 *
 * protect_sheet addresses the ACTIVE sheet only, and the script may well have
 * activated a different sheet inside `fn` — so the held sheet is activated for
 * the duration and the previous one restored afterwards. The hop is net-zero
 * (same sheet active before and after, nothing repaints in between), which is
 * why it does not announce; skipping it would re-protect the WRONG sheet, which
 * is worse than any amount of churn.
 */
async function reprotectHeldSheet(
  lib: Awaited<ReturnType<typeof getLib>>,
  hold: UnprotectedHold,
): Promise<void> {
  const activeNow = await lib.getActiveSheet();
  const mustHop = activeNow !== hold.sheet;

  // A HIDDEN HELD SHEET STILL HAS TO BE RE-PROTECTED.
  //
  // `protect_sheet` addresses only the ACTIVE sheet, and as of 2026-08-17 a
  // hidden sheet can no longer BE active (Excel parity: `Activate` raises 1004).
  // So a script that hid its own held sheet inside `fn` would leave that sheet
  // permanently UNPROTECTED — a security regression introduced by a correctness
  // fix, which is the worst way to acquire one.
  //
  // The envelope is VBA's own move: make it visible, do the work, put the
  // visibility back. It is net-zero exactly like the sheet hop around it —
  // same visibility before and after, nothing repaints in between.
  const sheetsBefore = mustHop ? await lib.getSheets() : null;
  const heldWasHidden =
    sheetsBefore?.sheets?.[hold.sheet]?.visibility &&
    sheetsBefore.sheets[hold.sheet].visibility !== "visible"
      ? (sheetsBefore.sheets[hold.sheet].visibility as "hidden" | "veryHidden")
      : null;
  if (heldWasHidden) await lib.unhideSheet(hold.sheet);

  if (mustHop) await lib.setActiveSheet(hold.sheet);
  try {
    const result = await lib.protectSheet({
      password: hold.password ?? undefined,
      options: hold.options,
    });
    if (!result.success) {
      throw new BrokerError(
        "HostError",
        result.error || `could not restore the protection on sheet ${hold.sheet}`,
      );
    }
  } finally {
    if (mustHop) await lib.setActiveSheet(activeNow);
    // Re-hide AFTER hopping away, never before: the sheet cannot be hidden while
    // it is the active one, which is the same rule that made this envelope
    // necessary in the first place.
    if (heldWasHidden) await lib.hideSheet(hold.sheet, heldWasHidden);
  }
}

/** What api.beginUnprotected answers. `token: null` means "there was nothing
 *  to lift" — the sheet was already unprotected and STAYS that way. */
export interface ScriptUnprotectHold {
  token: string | null;
  wasProtected: boolean;
}

/**
 * The api.beginUnprotected executor body.
 *
 * Contract, in the order the checks run:
 *  1. the sheet must be the ACTIVE one (protect_sheet addresses no other);
 *  2. an unprotected sheet is left alone and answers `{ token: null }`, so the
 *    helper never surprises anyone by protecting a sheet that wasn't;
 *  3. a wrong password THROWS — this is the one place the unprotectSheet
 *    "answer false" convention is wrong, because the caller's next act is to
 *    run `fn` against a sheet it believes is open;
 *  4. a sheet already held open is JOINED, not re-unprotected: the depth goes
 *    up, the captured options stay the FIRST ones (the only ones that were
 *    ever really in force), and a joiner must still prove the password.
 */
export async function executeBeginUnprotected(
  lib: Awaited<ReturnType<typeof getLib>>,
  scriptId: string,
  password?: string,
  sheetRef?: number | string | null,
): Promise<ScriptUnprotectHold> {
  // Captured BEFORE the first await. Both of the waits below — resolving the
  // sheet, then queueing behind this sheet's chain — can be outlived by the
  // script that asked, and a hold recorded for a departed script is one nothing
  // will ever release (see scriptDepartures).
  const epoch = departureEpoch(scriptId);
  const active = await assertActiveSheet(lib, sheetRef, "withUnprotected");
  // Everything from here reads the bookkeeping and then writes it, so it runs
  // as one link in the sheet's chain (see serializeOnSheet).
  return serializeOnSheet(active, () =>
    beginUnprotectedOnActiveSheet(lib, scriptId, password, active, epoch),
  );
}

async function beginUnprotectedOnActiveSheet(
  lib: Awaited<ReturnType<typeof getLib>>,
  scriptId: string,
  password: string | undefined,
  active: number,
  /** The caller's departure epoch, sampled before it awaited anything. */
  epoch: number,
): Promise<ScriptUnprotectHold> {
  // Departed while resolving the sheet, or while queued behind another hold on
  // it. Nothing has been lifted yet — including on the JOIN path below, which
  // would otherwise add a holder that never lets go — so simply refuse.
  if (departureEpoch(scriptId) !== epoch) {
    throw new BrokerError(
      "HostError",
      `withUnprotected: the script ended before the protection on sheet ${active} ` +
        `was lifted; nothing ran and the sheet was not touched`,
    );
  }
  const mintToken = (sheet: number): string => {
    const token = `unprot-${nextUnprotectToken++}`;
    unprotectTokens.set(token, { sheet, scriptId });
    return token;
  };

  const existing = unprotectedHolds.get(active);
  if (existing) {
    // Joining someone else's (or one's own outer) hold. The sheet reads
    // "unprotected" right now, so its status can no longer prove anything —
    // the captured password is the only remaining gate, and skipping it would
    // turn a concurrent script into a password oracle.
    if (existing.password !== null && (password ?? "") !== existing.password) {
      throw new BrokerError(
        "PermissionDenied",
        `withUnprotected: sheet ${active} is already open under a different password`,
      );
    }
    existing.holders.set(scriptId, (existing.holders.get(scriptId) ?? 0) + 1);
    return { token: mintToken(active), wasProtected: true };
  }

  const status = await lib.getProtectionStatus();
  if (!status.isProtected) {
    // Nothing to lift and nothing to put back. `fn` runs, the sheet stays
    // unprotected afterwards — a helper that protected it here would be
    // inventing a protection the user never asked for.
    return { token: null, wasProtected: false };
  }
  // Captured BEFORE the unprotect: once the sheet is open the backend reports
  // defaults, and restoring defaults is not restoring.
  const options: SheetProtectionOptions = { ...status.options };

  const opened = await executeUnprotectSheet(lib, password);
  if (!opened) {
    throw new BrokerError(
      "PermissionDenied",
      `withUnprotected: the password is wrong for sheet ${active}; nothing was run and the sheet is still protected`,
    );
  }

  // THE ORPHAN WINDOW. The sheet is open NOW, but its owner may have died while
  // the unprotect was in flight — in which case hostUnmountScript already ran
  // its sweep, found no hold to release (there was not one yet), and will never
  // run again for this id. Recording the hold here would leave the sheet open
  // for the rest of the session with nothing able to close it. So the restore
  // happens HERE, done by the begin that opened it, and the call refuses.
  if (departureEpoch(scriptId) !== epoch) {
    const orphan: UnprotectedHold = {
      sheet: active,
      password: status.hasPassword ? (password ?? "") : null,
      options,
      holders: new Map(),
    };
    try {
      await reprotectHeldSheet(lib, orphan);
      auditUnprotectRestore(scriptId, true);
    } catch (e) {
      // Same rule as every other restore on this surface: a FAILED one is said
      // out loud rather than swallowed.
      auditUnprotectRestore(scriptId, false, e instanceof Error ? e.message : String(e));
    }
    throw new BrokerError(
      "HostError",
      `withUnprotected: the script ended while the protection on sheet ${active} was ` +
        `being lifted; it was put back and nothing ran`,
    );
  }

  unprotectedHolds.set(active, {
    sheet: active,
    password: status.hasPassword ? (password ?? "") : null,
    options,
    holders: new Map([[scriptId, 1]]),
  });
  return { token: mintToken(active), wasProtected: true };
}

/**
 * The api.endUnprotected executor body: drop one hold and, when the LAST holder
 * of a sheet lets go, put the protection back.
 *
 * Deliberately forgiving about unknown/null tokens. `null` is the
 * never-was-protected answer, and an unknown token means the host already
 * restored this hold (an unmount sweep won the race) — in both cases the sheet
 * is in the state the caller wanted and an exception thrown from a `finally`
 * would replace the script's REAL error with a bookkeeping one.
 */
export async function executeEndUnprotected(
  lib: Awaited<ReturnType<typeof getLib>>,
  scriptId: string,
  token?: string | null,
): Promise<{ reprotected: boolean }> {
  if (token === null || token === undefined) return { reprotected: false };
  const entry = unprotectTokens.get(token);
  if (!entry) return { reprotected: false };
  return serializeOnSheet(entry.sheet, async () => {
    // Re-read inside the chain: a release sweep may have won the race between
    // the lookup above and our turn here, in which case the sheet is already
    // back in the state the caller wanted.
    if (!unprotectTokens.delete(token)) return { reprotected: false };
    const hold = unprotectedHolds.get(entry.sheet);
    if (!hold) return { reprotected: false };
    const depth = hold.holders.get(entry.scriptId) ?? 0;
    if (depth <= 1) hold.holders.delete(entry.scriptId);
    else hold.holders.set(entry.scriptId, depth - 1);
    if (hold.holders.size > 0) return { reprotected: false };

    // Last one out. Drop the tracking BEFORE the await so a begin queued behind
    // us opens a fresh hold rather than joining one that is being torn down.
    unprotectedHolds.delete(entry.sheet);
    await reprotectHeldSheet(lib, hold);
    return { reprotected: true };
  });
}

/**
 * Release every hold owned by ONE departing script — the crash guarantee.
 * Called (fire-and-forget) from hostUnmountScript, which is the funnel every
 * ending passes through: explicit unmount, worker fault (both crash paths),
 * debugger stop. A script that dies mid-`fn` gets its sheets re-protected here,
 * which is precisely what a worker-side try/finally cannot promise.
 *
 * Exported for tests.
 */
export async function releaseUnprotectedSheets(
  lib: Awaited<ReturnType<typeof getLib>>,
  scriptId: string,
): Promise<void> {
  // Its tokens die with it whatever else happens — a remounted successor must
  // never be able to end a hold it did not open. Done OUTSIDE the per-sheet
  // chains so an in-flight end for this script finds nothing to release.
  for (const [token, entry] of [...unprotectTokens]) {
    if (entry.scriptId === scriptId) unprotectTokens.delete(token);
  }
  const sheets = [...unprotectedHolds.keys()];
  await Promise.all(
    sheets.map((sheet) =>
      serializeOnSheet(sheet, async () => {
        const hold = unprotectedHolds.get(sheet);
        if (!hold) return;
        if (!hold.holders.delete(scriptId)) return;
        if (hold.holders.size > 0) return;
        unprotectedHolds.delete(sheet);
        try {
          await reprotectHeldSheet(lib, hold);
          auditUnprotectRestore(scriptId, true);
        } catch (e) {
          // The sheet stays open — say so LOUDLY in the ring rather than
          // swallowing it. A failed restore is exactly the state a reader needs.
          auditUnprotectRestore(scriptId, false, e instanceof Error ? e.message : String(e));
        }
      }),
    ),
  );
}

/** Whether a departing script owes any restore (cheap pre-check so
 *  hostUnmountScript does not import the lib for the common case). */
export function scriptOwesUnprotectRestore(scriptId: string): boolean {
  for (const hold of unprotectedHolds.values()) {
    if (hold.holders.has(scriptId)) return true;
  }
  return false;
}

/** Every hold, whoever owns it — the workbook-swap restore (hostResetAll). */
export function allUnprotectedHolds(): UnprotectedHold[] {
  return [...unprotectedHolds.values()];
}

/**
 * Restore every outstanding hold at once. hostResetAll's sweep: BEFORE_CLOSE
 * and AFTER_OPEN/AFTER_NEW all funnel here, and BEFORE_CLOSE is the dangerous
 * one — the workbook is still live and may still be SAVED, so a sheet left
 * open at that moment is a sheet that gets saved unprotected.
 */
export async function restoreAllUnprotected(
  lib: Awaited<ReturnType<typeof getLib>>,
  holds: UnprotectedHold[],
): Promise<void> {
  for (const hold of holds) {
    const owner = [...hold.holders.keys()][0] ?? "(unknown script)";
    try {
      await reprotectHeldSheet(lib, hold);
      auditUnprotectRestore(owner, true);
    } catch (e) {
      auditUnprotectRestore(owner, false, e instanceof Error ? e.message : String(e));
    }
  }
}

// ============================================================================
// Scenarios (What-If) — VBA's Worksheet.Scenarios, over the six shipped commands
// ============================================================================
// PURE WIRING, and that word is load-bearing for `scenarioShow`: it CALLS
// scenario_show. That command is the transient-write precedent the animation
// design cites, it carries the writeback-region skips, the GET.CONTROLVALUE
// snapshot and the dependent recalculation — and it is the one place all of
// that agrees. Re-implementing "write the changing cells and recalculate" here
// would be a second set of rules for the same act.
//
// Everything is NAME-addressed, because that is how VBA reads
// (`ws.Scenarios("Best Case").Show`) and because a scenario's identity IS its
// name — the backend matches case-insensitively on it in all six commands.

/** One changing cell of a scenario, as scripts write and read it. */
export interface ScriptScenarioCell {
  row: number;
  col: number;
  /** The value the cell takes in this scenario. Scalars are accepted on the
   *  way in and stringified for the backend, which re-parses them (number /
   *  TRUE / FALSE / text) exactly as it does for a hand-typed scenario. */
  value: string | number | boolean | null;
}

/** One saved scenario, as api.scenarios() answers it. */
export interface ScriptScenario {
  name: string;
  changingCells: ScriptScenarioCell[];
  comment: string;
  createdBy: string;
  sheetIndex: number;
}

/** api.scenarioAdd parameters — VBA's `Scenarios.Add Name:=..., ChangingCells:=...,
 *  Values:=Array(...)`, with both spellings of the cell/value pairing. */
export interface ScriptScenarioAddParams {
  name: string;
  /** An A1 address ("B2:B4", paired with `values`) or the explicit cells. */
  changingCells: string | ScriptScenarioCell[];
  /** Required with the A1 spelling: one value per cell, row-major. */
  values?: Array<string | number | boolean | null>;
  comment?: string;
  sheet?: number | string;
}

/** api.scenarioSummary options. */
export interface ScriptScenarioSummaryOptions {
  /** The formula cells the report compares across scenarios: an A1 range, a
   *  list of addresses, or explicit coordinates. */
  resultCells?: string | Array<string | { row: number; col: number }>;
  sheet?: number | string;
}

/** One row of the summary report. */
export interface ScriptScenarioSummaryRow {
  cellRef: string;
  currentValue: string;
  scenarioValues: string[];
  isChangingCell: boolean;
}

/** Stringify a scenario value for the backend's `value: String` field. `null`
 *  becomes the empty string, which parse_scenario_value reads as empty text —
 *  the same thing clearing the cell in the Scenario Manager dialog does. */
function scenarioValueToBackend(value: string | number | boolean | null): string {
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}

/** Every cell of a box, row-major — the order VBA's `Values:=Array(...)` pairs
 *  against `ChangingCells`. */
function boxCellsRowMajor(box: ScriptRangeBox): Array<{ row: number; col: number }> {
  const cells: Array<{ row: number; col: number }> = [];
  for (let r = box.startRow; r <= box.endRow; r++) {
    for (let c = box.startCol; c <= box.endCol; c++) cells.push({ row: r, col: c });
  }
  return cells;
}

/**
 * Parse an A1 body that must NOT carry a sheet prefix. Scenario and consolidate
 * arguments carry their sheet in a named slot, and two competing sheet claims
 * in one call is the ambiguity every other range option in this file refuses.
 */
function parseUnqualifiedA1(address: string, method: string, label: string): ScriptRangeBox {
  const { sheetName, rest } = splitSheetPrefixHost(address);
  if (sheetName !== null) {
    throw new BrokerError(
      "ValidationError",
      `${method}: ${label} must not name a sheet ("${address}") — use the \`sheet\` option`,
    );
  }
  try {
    return parseA1BodyHost(rest);
  } catch {
    throw new BrokerError(
      "ValidationError",
      `${method}: ${label} "${address}" is not an A1 range like "B2:B4"`,
    );
  }
}

/**
 * Resolve `changingCells` (+ `values`) to the backend's flat cell list. The A1
 * spelling is expanded row-major and zipped with `values`; a length mismatch is
 * refused NAMING BOTH COUNTS, because "3 cells, 2 values" is a typo the author
 * can fix instantly and a silent truncation is a scenario that quietly stores
 * the wrong numbers.
 */
export function resolveScenarioChangingCells(
  params: ScriptScenarioAddParams,
): Array<{ row: number; col: number; value: string }> {
  if (typeof params.changingCells === "string") {
    const box = parseUnqualifiedA1(params.changingCells, "scenarioAdd", "changingCells");
    const cells = boxCellsRowMajor(box);
    const values = params.values ?? [];
    if (cells.length !== values.length) {
      throw new BrokerError(
        "ValidationError",
        `scenarioAdd: changingCells "${params.changingCells}" covers ${cells.length} cell(s) ` +
          `but ${values.length} value(s) were given — they must pair up one for one, row by row`,
      );
    }
    return cells.map((c, i) => ({
      row: c.row,
      col: c.col,
      value: scenarioValueToBackend(values[i]),
    }));
  }
  return params.changingCells.map((c) => ({
    row: c.row,
    col: c.col,
    value: scenarioValueToBackend(c.value),
  }));
}

/** Resolve the summary's `resultCells` to plain coordinates. */
export function resolveScenarioResultCells(
  spec: ScriptScenarioSummaryOptions["resultCells"],
): Array<{ row: number; col: number }> {
  if (spec === undefined || spec === null) return [];
  if (typeof spec === "string") {
    return boxCellsRowMajor(parseUnqualifiedA1(spec, "scenarioSummary", "resultCells"));
  }
  const out: Array<{ row: number; col: number }> = [];
  for (const entry of spec) {
    if (typeof entry === "string") {
      out.push(...boxCellsRowMajor(parseUnqualifiedA1(entry, "scenarioSummary", "resultCells")));
    } else {
      out.push({ row: entry.row, col: entry.col });
    }
  }
  return out;
}

/** Backend Scenario -> the script shape (camelCase both sides; this only
 *  re-types the value field, which crosses as a string). */
function scenarioToScript(s: {
  name: string;
  changingCells: Array<{ row: number; col: number; value: string }>;
  comment: string;
  createdBy: string;
  sheetIndex: number;
}): ScriptScenario {
  return {
    name: s.name,
    changingCells: s.changingCells.map((c) => ({ row: c.row, col: c.col, value: c.value })),
    comment: s.comment,
    createdBy: s.createdBy,
    sheetIndex: s.sheetIndex,
  };
}

/** The sheet a scenario call addresses: any sheet (all six commands take an
 *  explicit index), defaulting to the active one. */
async function resolveScenarioSheet(
  lib: Awaited<ReturnType<typeof getLib>>,
  sheetRef: number | string | undefined | null,
  method: string,
): Promise<SheetWriteTarget> {
  return resolveSheetWriteTarget(lib, sheetRef, method);
}

export async function executeScenarios(
  lib: Awaited<ReturnType<typeof getLib>>,
  sheetRef?: number | string | null,
): Promise<ScriptScenario[]> {
  const t = await resolveScenarioSheet(lib, sheetRef, "scenarios");
  const result = await lib.scenarioList(t.sheet);
  return result.scenarios.map(scenarioToScript);
}

export async function executeScenarioAdd(
  lib: Awaited<ReturnType<typeof getLib>>,
  params: ScriptScenarioAddParams,
): Promise<{ name: string; changingCells: number }> {
  const t = await resolveScenarioSheet(lib, params.sheet, "scenarioAdd");
  // Resolved BEFORE the backend call so a mismatched cells/values pair fails
  // without touching the workbook.
  const changingCells = resolveScenarioChangingCells(params);
  const result = await lib.scenarioAdd({
    name: params.name,
    changingCells,
    comment: params.comment ?? "",
    sheetIndex: t.sheet,
  });
  if (!result.success) {
    // The backend refuses here for exactly one reason a script can act on: the
    // sheet's allowEditScenarios protection flag. Surfacing its own words keeps
    // the two explanations from drifting.
    throw new BrokerError("ValidationError", result.error || "scenarioAdd was refused");
  }
  return { name: params.name, changingCells: changingCells.length };
}

export async function executeScenarioShow(
  lib: Awaited<ReturnType<typeof getLib>>,
  scriptId: string,
  name: string,
  sheetRef?: number | string | null,
): Promise<{ cellsUpdated: number }> {
  const t = await resolveScenarioSheet(lib, sheetRef, "scenarioShow");
  const result = await lib.scenarioShow({ name, sheetIndex: t.sheet });
  if (result.error) {
    throw new BrokerError("ValidationError", result.error);
  }
  // scenario_show WRITES (there is no scenario_restore — the values stay and
  // are saved), so it is a write-attribution op like any other: without this a
  // script's own onDataChange re-fires on the cells it just drove.
  for (const cell of result.updatedCells) {
    recordScriptWrite(scriptId, t.sheet, cell.row, cell.col);
  }
  if (!t.offSheet) await afterCellDataChange(result.updatedCells);
  return { cellsUpdated: result.updatedCells.length };
}

export async function executeScenarioDelete(
  lib: Awaited<ReturnType<typeof getLib>>,
  name: string,
  sheetRef?: number | string | null,
): Promise<{ deleted: true }> {
  const t = await resolveScenarioSheet(lib, sheetRef, "scenarioDelete");
  const result = await lib.scenarioDelete({ name, sheetIndex: t.sheet });
  if (!result.success) {
    throw new BrokerError("ValidationError", result.error || `scenario "${name}" was not deleted`);
  }
  return { deleted: true };
}

export async function executeScenarioSummary(
  lib: Awaited<ReturnType<typeof getLib>>,
  options?: ScriptScenarioSummaryOptions,
): Promise<{ scenarioNames: string[]; rows: ScriptScenarioSummaryRow[] }> {
  const t = await resolveScenarioSheet(lib, options?.sheet, "scenarioSummary");
  const resultCells = resolveScenarioResultCells(options?.resultCells);
  const result = await lib.scenarioSummary({
    sheetIndex: t.sheet,
    // The backend's ScenarioCell carries a value field it never reads for
    // result cells; "" is the honest filler for "this is a coordinate".
    resultCells: resultCells.map((c) => ({ row: c.row, col: c.col, value: "" })),
  });
  if (result.error) {
    throw new BrokerError("ValidationError", result.error);
  }
  // The report is BUILT by applying each scenario in turn, and the backend
  // never puts the originals back — so the sheet is left holding the last
  // scenario's values but the command answers with rows, not cells. Nothing
  // would repaint without this, and the canvas would keep showing numbers the
  // workbook no longer holds. announceNonCellMutation is the existing "the
  // visible sheet changed underneath you" refresh, which is exactly the shape
  // here: real changes, no cell payload to apply.
  announceNonCellMutation(t.offSheet);
  return { scenarioNames: result.scenarioNames, rows: result.rows };
}

export async function executeScenarioMerge(
  lib: Awaited<ReturnType<typeof getLib>>,
  fromSheet: number | string,
  toSheet?: number | string | null,
): Promise<{ merged: true }> {
  const { sheets, activeIndex } = await lib.getSheets();
  const source = resolveSheetRefIn(sheets, fromSheet, "scenarioMerge");
  const target =
    toSheet === undefined || toSheet === null
      ? activeIndex
      : resolveSheetRefIn(sheets, toSheet, "scenarioMerge");
  if (source === target) {
    throw new BrokerError(
      "ValidationError",
      "scenarioMerge: the source and target sheets must be different",
    );
  }
  const result = await lib.scenarioMerge(source, target);
  if (!result.success) {
    throw new BrokerError("ValidationError", result.error || "scenarioMerge was refused");
  }
  return { merged: true };
}

// ============================================================================
// Consolidate (Data ▸ Consolidate) — one row over consolidate_data
// ============================================================================

/** api.consolidate parameters. */
export interface ScriptConsolidateParams {
  /** sum | count | average | max | min | product | countNums | stdDev |
   *  stdDevP | var | varP. */
  function: string;
  /** The ranges to combine: A1 strings (optionally "Sheet2!"-qualified) or
   *  explicit boxes with their own `sheet` slot. */
  sources: Array<string | (ScriptRangeBox & { sheet?: number | string })>;
  /** Where the result block's top-left corner goes. */
  destination: string | { row: number; col: number; sheet?: number | string };
  /** Match columns up by the header text in each source's top row. */
  useTopRow?: boolean;
  /** Match rows up by the label text in each source's left column. */
  useLeftColumn?: boolean;
  /** Default sheet for sources and destination that do not name their own. */
  sheet?: number | string;
}

/**
 * Resolve one `sources` entry to the backend's `{ sheetIndex, start*, end* }`.
 * The A1 spelling MAY name a sheet here (unlike the scenario arguments): a
 * consolidation whose whole point is combining Q1/Q2/Q3 sheets would be absurd
 * to express with one shared sheet slot, so `"Q1!A1:D10"` is the natural
 * spelling and the wave-1 prefix splitter already reads it.
 */
function resolveConsolidateSource(
  sheets: SheetListEntry[],
  src: string | (ScriptRangeBox & { sheet?: number | string }),
  fallbackSheet: number,
  label: string,
): { sheetIndex: number; startRow: number; startCol: number; endRow: number; endCol: number } {
  if (typeof src === "string") {
    const { sheetName, rest } = splitSheetPrefixHost(src);
    const sheetIndex =
      sheetName === null ? fallbackSheet : resolveSheetRefIn(sheets, sheetName, "consolidate");
    let box: ScriptRangeBox;
    try {
      box = parseA1BodyHost(rest);
    } catch {
      throw new BrokerError(
        "ValidationError",
        `consolidate: ${label} "${src}" is not an A1 range like "A1:D10" or "Q1!A1:D10"`,
      );
    }
    return { sheetIndex, ...box };
  }
  const sheetIndex =
    src.sheet === undefined || src.sheet === null
      ? fallbackSheet
      : resolveSheetRefIn(sheets, src.sheet, "consolidate");
  return {
    sheetIndex,
    startRow: Math.min(src.startRow, src.endRow),
    startCol: Math.min(src.startCol, src.endCol),
    endRow: Math.max(src.startRow, src.endRow),
    endCol: Math.max(src.startCol, src.endCol),
  };
}

/** The consolidate destination: only its TOP-LEFT matters (the block's size is
 *  whatever the aggregation produces), so an A1 range collapses to its start. */
function resolveConsolidateDestination(
  sheets: SheetListEntry[],
  dest: ScriptConsolidateParams["destination"],
  fallbackSheet: number,
): { sheetIndex: number; row: number; col: number } {
  if (typeof dest === "string") {
    const { sheetName, rest } = splitSheetPrefixHost(dest);
    const sheetIndex =
      sheetName === null ? fallbackSheet : resolveSheetRefIn(sheets, sheetName, "consolidate");
    let box: ScriptRangeBox;
    try {
      box = parseA1BodyHost(rest);
    } catch {
      throw new BrokerError(
        "ValidationError",
        `consolidate: destination "${dest}" is not an A1 address like "A1" or "Summary!A1"`,
      );
    }
    return { sheetIndex, row: box.startRow, col: box.startCol };
  }
  const sheetIndex =
    dest.sheet === undefined || dest.sheet === null
      ? fallbackSheet
      : resolveSheetRefIn(sheets, dest.sheet, "consolidate");
  return { sheetIndex, row: dest.row, col: dest.col };
}

export async function executeConsolidate(
  lib: Awaited<ReturnType<typeof getLib>>,
  scriptId: string,
  params: ScriptConsolidateParams,
): Promise<{ rowsWritten: number; colsWritten: number; cellsUpdated: number }> {
  const { sheets, activeIndex } = await lib.getSheets();
  const fallback =
    params.sheet === undefined || params.sheet === null
      ? activeIndex
      : resolveSheetRefIn(sheets, params.sheet, "consolidate");
  // Every reference is resolved BEFORE the backend call, so one bad address
  // refuses the whole consolidation rather than half-writing a summary block.
  const sourceRanges = params.sources.map((src, i) =>
    resolveConsolidateSource(sheets, src, fallback, `sources[${i}]`),
  );
  const dest = resolveConsolidateDestination(sheets, params.destination, fallback);

  const result = await lib.consolidateData({
    function: params.function as Parameters<typeof lib.consolidateData>[0]["function"],
    sourceRanges,
    destSheetIndex: dest.sheetIndex,
    destRow: dest.row,
    destCol: dest.col,
    useTopRow: params.useTopRow ?? false,
    useLeftColumn: params.useLeftColumn ?? false,
  });
  if (!result.success) {
    throw new BrokerError("ValidationError", result.error || "consolidate was refused");
  }
  for (const cell of result.updatedCells) {
    recordScriptWrite(scriptId, dest.sheetIndex, cell.row, cell.col);
  }
  if (dest.sheetIndex === activeIndex) await afterCellDataChange(result.updatedCells);
  return {
    rowsWritten: result.rowsWritten,
    colsWritten: result.colsWritten,
    cellsUpdated: result.updatedCells.length,
  };
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

/** Floating range rows over the wire (api_types::FloatingRangeInfo, flattened). */
interface FloatingRangeWire {
  id: string;
  name: string;
  hostSheetIndex: number;
  backingSheetIndex: number;
  rowCount: number;
  colCount: number;
  x: number;
  y: number;
}

/** A floating range changed (created / deleted / resized / cells written):
 *  the same feature-neutral fan-out shape as announceObjectsChanged, through
 *  the "floatingRanges" domain the Shell translator maps to the extension's
 *  reload event plus grid:refresh (grid formulas reading the range refetch). */
function announceFloatingRangesChanged(): void {
  emitAppEvent(AppEvents.MUTATION_REFRESH, { domains: ["floatingRanges"] });
}

/**
 * An object that OTHER objects point at was deleted, so the backend ran a
 * CASCADE (§3bt's `DEPENDENCY_MATRIX`): the slicers bound to it are gone, the
 * ribbon filters that named it are pruned, a pane control's chart binding is
 * cleared.
 *
 * The "objects" domain does NOT reach any of those. It fans out to charts,
 * sparklines, the table-definitions event, animation, grid and protection —
 * and every one of the cascade's own victims lives in a store that is not on
 * that list. The extensions cache their own objects and paint their own
 * overlays, so a slicer the backend deleted goes on rendering AND on claiming
 * pointer events over the cells underneath until its store re-reads. That is
 * not cosmetic: it is the wedge that took `state-consistency` to a 120 s
 * click-retry timeout on seed 1786421716252.
 *
 * The Table extension's own `deleteTableAsync` has always announced this; the
 * broker calls `backend.deleteTable` DIRECTLY (it has to — the script tier
 * checks and the active-sheet assertion live here), so it has to announce it
 * too. Domains, never feature events: the Shell owns the mapping.
 */
async function announceObjectCascade(): Promise<void> {
  emitAppEvent(AppEvents.MUTATION_REFRESH, {
    domains: ["slicer", "ribbonFilter", "paneControl"],
    source: "commit",
  });
  await announceObjectsChanged();
}

/** A pivot's shape changed: the "pivot" domain reaches the Pivot extension's
 *  own refresh, which re-reads the view and repaints the destination cells. */
function announcePivotChanged(): void {
  emitAppEvent(AppEvents.MUTATION_REFRESH, { domains: ["pivot"] });
}

// ============================================================================
// Conditional formatting CRUD (Wave 3 item 3)
// ============================================================================

/** The spec api.addConditionalFormat receives (vCFSpec has already proved it). */
interface ScriptCFSpec {
  rule: ConditionalFormatRule;
  format: ConditionalFormat;
  ranges: ConditionalFormatRange[];
  stopIfTrue?: boolean;
}

/** The patch api.updateConditionalFormat receives (vCFUpdate has proved it). */
interface ScriptCFPatch {
  rule?: ConditionalFormatRule;
  format?: ConditionalFormat;
  ranges?: ConditionalFormatRange[];
  stopIfTrue?: boolean;
  enabled?: boolean;
}

/** Whole-sheet rectangle for clearConditionalFormats with no range: the
 *  backend keeps any rule with a range OUTSIDE the cleared rect, so "clear
 *  all" is spelled as the largest rectangle a script can address. */
const CF_WHOLE_SHEET = { startRow: 0, startCol: 0, endRow: 10_000_000, endCol: 10_000_000 };

/** CF DEFINITIONS changed outside the CF extension's own dialogs. The
 *  extension re-reads its rule cache and repaints on this event (its dialogs
 *  call invalidateAndRefresh() directly and never emit it). */
function announceConditionalFormatsChanged(): void {
  emitAppEvent(AppEvents.CONDITIONAL_FORMATS_CHANGED, {});
}

/**
 * Execute one conditional-formatting method over the finished backend CRUD
 * (conditional_formatting.rs), via the same backend.ts wrappers the CF
 * extension's dialogs call.
 *
 * SHEET SLOT: `listConditionalFormats` / `clearConditionalFormats` carry an
 * optional Wave-1 sheet ref (index or name), resolved host-side and passed to
 * the sheet-aware backend commands. Rule DEFINITIONS live per sheet, so
 * add/update/delete address rules on the sheet they were created on — the
 * add path is active-sheet scoped (its ranges are active-sheet rectangles).
 *
 * Exported for tests: driven with a mocked ../backend (a live worker realm is
 * not available under jsdom).
 */
export async function executeConditionalFormat(method: string, args: unknown[]): Promise<unknown> {
  const backend = await import("../backend");
  const lib = await getLib();
  switch (method) {
    case "api.listConditionalFormats": {
      const [sheet] = args as [(number | string | null)?];
      const target = await resolveOptionalSheetRef(lib, sheet, "listConditionalFormats");
      return backend.getAllConditionalFormats(target);
    }
    case "api.addConditionalFormat": {
      const [spec] = args as [ScriptCFSpec];
      const result = await backend.addConditionalFormat({
        rule: spec.rule,
        format: spec.format,
        ranges: spec.ranges,
        stopIfTrue: spec.stopIfTrue ?? false,
      });
      if (!result.success || !result.rule) {
        throw new BrokerError("ValidationError", result.error || "addConditionalFormat failed");
      }
      announceConditionalFormatsChanged();
      return result.rule;
    }
    case "api.updateConditionalFormat": {
      const [ruleId, patch] = args as [number, ScriptCFPatch];
      const result = await backend.updateConditionalFormat({ ruleId, ...patch });
      if (!result.success || !result.rule) {
        throw new BrokerError(
          "ValidationError",
          result.error || `No conditional-format rule with id ${ruleId}`,
        );
      }
      announceConditionalFormatsChanged();
      return result.rule;
    }
    case "api.deleteConditionalFormat": {
      const [ruleId] = args as [number];
      const result = await backend.deleteConditionalFormat(ruleId);
      if (!result.success) {
        throw new BrokerError(
          "ValidationError",
          result.error || `No conditional-format rule with id ${ruleId}`,
        );
      }
      announceConditionalFormatsChanged();
      return undefined;
    }
    case "api.clearConditionalFormats": {
      const [range, sheet] = args as [
        { startRow: number; startCol: number; endRow: number; endCol: number } | null | undefined,
        (number | string | null)?,
      ];
      const target = await resolveOptionalSheetRef(lib, sheet, "clearConditionalFormats");
      const box = range ?? CF_WHOLE_SHEET;
      const count = await backend.clearConditionalFormatsInRange(
        box.startRow, box.startCol, box.endRow, box.endCol, target,
      );
      if (count > 0) announceConditionalFormatsChanged();
      return { count };
    }
    default:
      throw new BrokerError("UnknownMethod", `No conditional-format implementation for ${method}`);
  }
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
    case "floatingRange": {
      // Straight from the backend row store: the object exists whether or not
      // its extension is loaded, and for a READ an empty workbook and a
      // missing extension are the same honest answer.
      const { invokeBackend } = await import("../backend");
      const rows = await invokeBackend<FloatingRangeWire[]>("list_floating_ranges", {});
      return (rows ?? []).map((fr) =>
        floatingRangeToRef({
          id: fr.id,
          name: fr.name,
          hostSheetIndex: fr.hostSheetIndex,
          rowCount: fr.rowCount,
          colCount: fr.colCount,
        }),
      );
    }
    case "shape": {
      // Controls are stored per sheet and anchored to a cell, so the whole-
      // workbook view is the union over every sheet.
      //
      // `getControlsProvider` rather than `requireControlsProvider`: for a READ,
      // "the Controls extension is not loaded" and "this workbook has no
      // controls" are the same answer to the caller, and an empty list is
      // honest. Creating and deleting take the throwing accessor, because there
      // "nothing happened" and "it worked" must never look alike.
      const store = getControlsProvider();
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

/**
 * The READ twin of the pivot DATA aspects (getState aspect
 * "pivot.getFieldInfo"): the field's current filters, whether it is filtered
 * at all, and every item with its visibility — what a macro needs for
 * read-modify-write ("keep what is visible, add one more"). Sort order has no
 * backend read, so it is honestly absent. Exported for tests.
 */
export async function executePivotFieldInfo(pivotId: string, field: unknown): Promise<unknown> {
  if (typeof field !== "string" || field.trim().length === 0) {
    throw new BrokerError("ValidationError", "field must be a non-empty field name");
  }
  const api = await requirePivotApi();
  const hierarchies = await api.getHierarchies(pivotId);
  const source = resolveSourceField(hierarchies.hierarchies as SourceFieldLike[], field);
  return api.getFieldInfo(pivotId, source.index);
}

/**
 * Execute one pivot DATA aspect (Wave 3 item 4): report filters, item
 * visibility, sort, value number format. Reached from BOTH the own-object door
 * and api.objectSetState, exactly like executePivotLayoutAspect above — the
 * reach difference lives in the allowlist tier, never here.
 *
 * FIELD ADDRESSING, two deliberate spellings:
 *   - filter / visibility / sort aspects take a SOURCE column name; the
 *     backend requests carry the source field INDEX (their field_index is
 *     matched against FieldConfig.source_index in Rust).
 *   - setNumberFormat takes a VALUE field (a data hierarchy — by its display
 *     alias "Sum of Sales" or its source name); the backend request carries
 *     the POSITION in the value-field list, exactly like setAggregation.
 *
 * Exported for tests: driven with a registered fake PivotApi (a live worker
 * realm is not available under jsdom).
 */
export async function executePivotDataAspect(pivotId: string, aspect: string, args: unknown[]): Promise<void> {
  const api = await requirePivotApi();
  const hierarchies = await api.getHierarchies(pivotId);
  const sourceFields = hierarchies.hierarchies as SourceFieldLike[];

  switch (aspect) {
    case "pivot.setFilter": {
      // values = the item names to KEEP (a manual filter); null = clear the
      // field's filters entirely, the honest spelling of "no page filter".
      const [field, values] = args as [string, string[] | null];
      const source = resolveSourceField(sourceFields, field);
      if (values === null) {
        await api.clearFilter({ pivotId, fieldIndex: source.index });
      } else {
        await api.applyFilter({
          pivotId,
          fieldIndex: source.index,
          filters: { manualFilter: { selectedItems: values } },
        });
      }
      return;
    }
    case "pivot.clearFilter": {
      // No filterType argument = the backend clears EVERY filter kind on the
      // field (manual, label, value), which is what "clear" should mean.
      const [field] = args as [string];
      const source = resolveSourceField(sourceFields, field);
      await api.clearFilter({ pivotId, fieldIndex: source.index });
      return;
    }
    case "pivot.setItemVisibility": {
      const [field, item, visible] = args as [string, string, boolean];
      const source = resolveSourceField(sourceFields, field);
      await api.setItemVisibility({
        pivotId,
        fieldIndex: source.index,
        itemName: item,
        visible,
      });
      return;
    }
    case "pivot.sortField": {
      const [field, direction] = args as [string, "asc" | "desc"];
      const source = resolveSourceField(sourceFields, field);
      await api.sortField({
        pivotId,
        fieldIndex: source.index,
        sortBy: direction === "asc" ? "ascending" : "descending",
      });
      return;
    }
    case "pivot.setNumberFormat": {
      const [valueField, numberFormat] = args as [string, string];
      const placed = findPlacedField(hierarchies.dataHierarchies, sourceFields, valueField);
      if (!placed) {
        const placedNames = hierarchies.dataHierarchies.map((d) => d.name).join(", ") || "(none)";
        throw new BrokerError(
          "ValidationError",
          `Field "${valueField}" is not a value field of this pivot. Value fields: ${placedNames}`,
        );
      }
      // valueFieldIndex is the POSITION in the pivot's value-field list, which
      // is exactly what getHierarchies reports as `position` (same contract as
      // pivot.setAggregation above).
      await api.setNumberFormat({
        pivotId,
        valueFieldIndex: placed.position,
        numberFormat,
      });
      return;
    }
    default:
      throw new BrokerError("ValidationError", `Unknown pivot data aspect: ${aspect}`);
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
 * The off-sheet single-cell write, with the ACTIVE-SHEET SKIP handled.
 *
 * `update_cell_on_sheets` refuses to write the sheet that is active (correct
 * for sheet grouping, where `update_cell` already wrote it) and reports which
 * sheets it did write. A script's write has no such prior write, so a skip
 * would silently DROP the value — and the skip is decided at COMMAND time,
 * after the host already resolved the target from a `get_sheets` snapshot. A
 * macro that writes sheet A while the active sheet becomes A (the user
 * switching tabs, or the macro's own `setActiveSheet`) therefore lost the write
 * with no error anywhere. Caught live by vba-idioms-wave1.spec.ts.
 *
 * So: if the target comes back unwritten, it IS the active sheet now — write it
 * through the active-sheet path, which is the correct path for it.
 *
 * THE WRITEBACK GATE IS OWNED HERE, not by the callers: this function is the
 * single door every off-sheet single-cell script write goes through, so a new
 * caller cannot forget it (writebackGateway.test.ts pins that).
 */
async function writeOffSheetCellTyped(
  lib: Awaited<ReturnType<typeof getLib>>,
  scriptId: string,
  sheetIndex: number,
  row: number,
  col: number,
  value: string,
  invariant: boolean,
): Promise<void> {
  await captureWritebackWrite(scriptId, { sheetIndex, row, col, value });
  const written = await lib.updateCellOnSheets(
    [sheetIndex], row, col, value, invariant || undefined,
  );
  if (Array.isArray(written) && !written.includes(sheetIndex)) {
    // It became the active sheet between the resolve and the call.
    await afterCellDataChange(
      await writeActiveCellTyped(lib, scriptId, sheetIndex, row, col, value, invariant),
    );
    return;
  }
  // Another sheet: no visible cell moved, but an active-sheet formula may
  // depend on one, and the style caches key on the whole workbook.
  scheduleGridDataRefresh();
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
    // Re-fetch the canvas — see the note on api.setCellValue.
    await afterCellDataChange((await lib.updateCell(row, col, value)).cells);
    return;
  }
  const written = await lib.updateCellOnSheets([sheetIndex], row, col, value);
  if (Array.isArray(written) && !written.includes(sheetIndex)) {
    // It became the active sheet between the read above and the call — write
    // it, do not drop it (see writeOffSheetCellTyped).
    await afterCellDataChange((await lib.updateCell(row, col, value)).cells);
    return;
  }
  scheduleGridDataRefresh();
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

// ============================================================================
// Forms — the host callbacks a form session drives, and the submit verdict
// ============================================================================

/**
 * The mounted FORM script called `name` (case-insensitive) that `caller` may
 * reach: same tier and origin, exactly one match. Ambiguity is a loud refusal
 * rather than a first-wins guess, and an unmounted form (a distributed one the
 * user has not approved) is simply not found — nothing paints before consent.
 */
function findMountedFormByName(name: string, caller: MountedWorker): MountedWorker {
  const wanted = name.trim().toLowerCase();
  const matches: MountedWorker[] = [];
  for (const mw of mounted.values()) {
    if (mw.definition.objectType !== "form") continue;
    if (mw.definition.name.trim().toLowerCase() !== wanted) continue;
    if (!sameTrustOrigin(caller.handle, mw.handle)) continue;
    matches.push(mw);
  }
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new BrokerError(
      "HostError",
      `no form named "${name}" is running (it may not exist, or its package has not been approved)`,
    );
  }
  throw new BrokerError(
    "HostError",
    `${matches.length} running forms are named "${name}"; rename one so the name is unique`,
  );
}

/** Hold / release one worker's relayed-method-call clock for an open form. */
function holdFormDeadlines(mw: MountedWorker): void {
  mw.formHolds += 1;
  suspendMethodCallDeadlines(mw);
}
function releaseFormDeadlines(mw: MountedWorker): void {
  mw.formHolds = Math.max(0, mw.formHolds - 1);
  // The debugger owns the clock while the realm is paused (its resume
  // re-arms); otherwise the last hold going away restarts it.
  if (mw.formHolds === 0 && !isScriptDebugPaused(mw.definition.id)) resumeMethodCallDeadlines(mw);
}

/** Deliver a form's answer into a worker, unless that worker is already gone. */
function relayFormClosed(mw: MountedWorker, showId: string, result: unknown): void {
  // The worker may already be gone: the unmount sweep terminates the realm and
  // THEN closes this script's forms. Asking the `mounted` map was the wrong
  // question — it is cleared at the very end of the unmount, so it still
  // answered "mounted" here and the relay went into a dead realm to park a
  // pending call its own 30 s timer later rejected. The realm's own flag is
  // the fact; the map is the bookkeeping.
  if (mw.terminated || mounted.get(mw.definition.id) !== mw) return;
  void relayMethodCall(mw, "__form_closed", [{ showId, result }]).catch(() => {
    // The shim's handler cannot throw; a rejection here is only the deadline
    // of a realm that stopped reading messages.
  });
}

/**
 * Bind a form session to the OWNING worker (and, for a cross-script show, to
 * the CALLER too: it awaits the same answer and its clock is held the same
 * way). The registry (scriptForms.ts) never sees a MountedWorker; it gets
 * these callbacks and nothing else.
 *
 * `getBound` is a GETTER, not a value: the bindings are resolved inside the
 * registry's own `resolve` thunk, which runs after its guards pass and so
 * after these deps have been built. Every callback here fires later still —
 * `opened` on the renderer's acknowledgement, `writeBindings` on a change or a
 * submit — so each reads the holder when it runs. A null answer means the show
 * never got as far as resolving anything, and there is nothing to watch or
 * write.
 */
function formSessionDeps(
  mw: MountedWorker,
  getBound: () => ResolvedFormBindings | null,
  caller?: MountedWorker,
): FormSessionDeps {
  let liveWatch: CleanupFn | null = null;
  return {
    forward: (hook, payload) => forwardEvent(mw, hook, payload),
    mirror: (path, value) => post(mw, { t: "mirror", path, value }),
    relaySubmit: (values) => raceFormSubmitVerdict(mw, values),
    opened: (showId) => {
      const bound = getBound();
      if (bound && (bound.cells.length > 0 || bound.controls.length > 0)) {
        liveWatch = installFormLiveWatch(mw, showId, bound);
      }
    },
    writeBindings: (showId: string, values: Record<string, FormValue | string[]>, names: string[] | null) => {
      const bound = getBound();
      if (!bound || bound.cells.length === 0) return Promise.resolve([]);
      return writeFormBindings(mw, showId, bound, values, names);
    },
    closed: (showId, result) => {
      liveWatch?.();
      liveWatch = null;
      if (caller) relayFormClosed(caller, showId, result);
      relayFormClosed(mw, showId, result);
    },
    suspendDeadlines: () => {
      holdFormDeadlines(mw);
      if (caller) holdFormDeadlines(caller);
    },
    resumeDeadlines: () => {
      releaseFormDeadlines(mw);
      if (caller) releaseFormDeadlines(caller);
    },
  };
}

/** One bound widget whose cell the host reads and writes for it. */
interface ResolvedFormCell {
  decl: FormBindingDecl;
  sheetIndex: number;
  /**
   * The name that index carried when the form opened, re-checked before the
   * write. An index is not a stable identity while a modal is up: another
   * script (a scheduled job, an MCP tool) can delete or move a sheet, after
   * which the same index names a DIFFERENT sheet and the submit would write
   * the form's answers into it.
   */
  sheetName: string | undefined;
  row: number;
  col: number;
}

/** The name a sheet index carries in a sheet list, or undefined if it has none. */
function nameOfSheet(sheets: Array<{ index: number; name: string }>, index: number): string | undefined {
  return sheets.find((s) => s.index === index)?.name;
}

/** What one show() resolved its `bind` declarations to. */
interface ResolvedFormBindings {
  /** Seeds per widget name, including the read-only ones that carry a reason. */
  seeds: Record<string, FormSeed>;
  /** The cell-backed widgets (control bindings are read-only and never listed). */
  cells: ResolvedFormCell[];
  /** Widgets bound to a Controls-pane value (read-only; refreshed live). */
  controls: Array<{ decl: FormBindingDecl; controlName: string }>;
  /** Restricted tier: the sheet every cell binding was pinned to at show. */
  pinnedSheet: number | null;
  pinnedSheetName?: string;
  writeOnChange: string[];
}

/**
 * Content a widget takes from the workbook rather than as a value: a choice
 * list or a table read from a range (through the script's own range rows, so
 * the tier clamp and the audit apply), and an image resolved ONCE here from
 * its `media:` handle (an IPC, so never per paint).
 */
async function resolveFormSources(
  mw: MountedWorker,
  spec: FormSpec,
  sheets: Parameters<typeof resolveSheetRefIn>[0],
  activeIndex: number,
  seeds: Record<string, FormSeed>,
): Promise<void> {
  const { handle } = mw;
  const restricted = handle.tier !== "unlocked";
  for (const src of collectFormSources(spec)) {
    const seed: FormSeed = seeds[src.name] ?? { value: null };
    if (src.source.kind === "image") {
      try {
        const fs = await import("../filesystem");
        seed.imageUrl = await fs.resolveMediaRef(src.source.src);
      } catch (e) {
        seed.reason = e instanceof Error ? e.message : String(e);
      }
      seeds[src.name] = seed;
      continue;
    }
    try {
      const box = parseFormRange(src.source.range);
      const sheetIndex =
        box.sheetName === null ? activeIndex : resolveSheetRefIn(sheets, box.sheetName, "form.show");
      const method = restricted ? "sheet.getRangeValues" : "api.getRangeValues";
      const args: unknown[] = [box.startRow, box.startCol, box.endRow, box.endCol, sheetIndex];
      const cells = (await brokerCall(handle, method, args, () => executeImpl(mw, method, args))) as ScriptCell[][];
      if (src.source.kind === "options") seed.options = optionsFromCells(cells);
      else seed.rows = rowsFromCells(cells);
    } catch (e) {
      seed.reason = e instanceof Error ? e.message : String(e);
      if (src.source.kind === "options") seed.options = [];
      else seed.rows = [];
    }
    seeds[src.name] = seed;
  }
}

/**
 * The READ every bound widget starts from. A real broker call on the same row
 * the script would use by hand — `sheet.getCellData` at restricted tier with
 * an EXPLICIT sheet argument, so the tier clamp (and its audit row) bites when
 * the binding names another sheet — under the script's own handle.
 */
async function readFormCell(mw: MountedWorker, cell: ResolvedFormCell): Promise<FormSeed> {
  const method = mw.handle.tier === "unlocked" ? "api.getCellData" : "sheet.getCellData";
  const args: unknown[] = [cell.row, cell.col, cell.sheetIndex];
  try {
    const read = (await brokerCall(mw.handle, method, args, () => executeImpl(mw, method, args))) as ScriptCell;
    return seedFromCell(cell.decl.widgetType, read, cell.decl.multi);
  } catch (e) {
    return { value: null, readOnly: true, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Resolve every `bind` of a form to a cell (or a control value) and read it.
 * Nothing is refused wholesale: a binding this script cannot reach becomes a
 * DISABLED widget carrying the reason, so the user sees why rather than
 * nothing, and the refusal is in the audit ring like any other.
 */
async function resolveFormBindings(mw: MountedWorker, spec: FormSpec): Promise<ResolvedFormBindings> {
  const { handle } = mw;
  const decls = collectFormBindings(spec);
  const out: ResolvedFormBindings = { seeds: {}, cells: [], controls: [], pinnedSheet: null, writeOnChange: [] };
  const sources = collectFormSources(spec);
  if (decls.length === 0 && sources.length === 0) return out;
  const lib = await getLib();
  const { sheets, activeIndex } = await lib.getSheets();
  const restricted = handle.tier !== "unlocked";
  await resolveFormSources(mw, spec, sheets, activeIndex, out.seeds);
  for (const decl of decls) {
    let parsed;
    try {
      parsed = parseFormBinding(decl.bind);
    } catch (e) {
      out.seeds[decl.name] = { value: null, readOnly: true, reason: e instanceof Error ? e.message : String(e) };
      continue;
    }
    if (parsed.kind === "control") {
      // Through the broker like every other read this form performs, so the
      // policy decides it and the audit ring records it under this script.
      // The executor is inline (host-driven row, no worker shim) — the same
      // shape as formula.udf.invoke.
      const controlArgs: unknown[] = [parsed.name];
      try {
        const value = await brokerCall(mw.handle, "form.readControl", controlArgs, async () => {
          const { getControlValue } = await import("../controlValues");
          return getControlValue(parsed.name) ?? null;
        });
        out.seeds[decl.name] = seedFromControlValue(decl.widgetType, value as ControlValue | null, decl.multi);
        out.controls.push({ decl, controlName: parsed.name });
      } catch (e) {
        out.seeds[decl.name] = { value: null, readOnly: true, reason: e instanceof Error ? e.message : String(e) };
      }
      continue;
    }
    let cell: ResolvedFormCell;
    if (parsed.kind === "cell") {
      let sheetIndex = activeIndex;
      if (parsed.sheetRef !== null) {
        try {
          sheetIndex = resolveSheetRefIn(sheets, parsed.sheetRef, "form.show");
        } catch (e) {
          out.seeds[decl.name] = { value: null, readOnly: true, reason: e instanceof Error ? e.message : String(e) };
          continue;
        }
      }
      cell = { decl, sheetIndex, sheetName: nameOfSheet(sheets, sheetIndex), row: parsed.row, col: parsed.col };
    } else {
      let coords: NamedRangeCoordsLike;
      try {
        coords = (await lib.resolveNamedRangeCoords(parsed.name)) as NamedRangeCoordsLike;
      } catch {
        out.seeds[decl.name] = { value: null, readOnly: true, reason: `the defined name "${parsed.name}" was not found` };
        continue;
      }
      if (!coords || coords.startRow !== coords.endRow || coords.startCol !== coords.endCol) {
        out.seeds[decl.name] = {
          value: null,
          readOnly: true,
          reason: `the defined name "${parsed.name}" must name ONE cell to bind an input`,
        };
        continue;
      }
      cell = {
        decl,
        sheetIndex: coords.sheetIndex,
        sheetName: nameOfSheet(sheets, coords.sheetIndex),
        row: coords.startRow,
        col: coords.startCol,
      };
    }
    const seed = await readFormCell(mw, cell);
    // A choice list read for the same widget (options: { range }) lives on
    // the seed too; keep it when the value read replaces the entry.
    const prior = out.seeds[decl.name];
    out.seeds[decl.name] = prior?.options ? { ...seed, options: prior.options } : seed;
    if (seed.readOnly) continue;
    out.cells.push(cell);
    if (decl.writeOn === "change") out.writeOnChange.push(decl.name);
  }
  if (restricted && out.cells.length > 0) {
    out.pinnedSheet = activeIndex;
    out.pinnedSheetName = sheets[activeIndex]?.name;
  }
  return out;
}

/**
 * Write bound widgets back — every DIRTY one on Submit (`names` null), or
 * exactly `names` for a writeOn:"change" widget — as broker calls under the
 * script's own handle inside ONE undo transaction. The typed value or the
 * user's formula text goes out, never the display string.
 *
 * Restricted tier writes the sheet on screen, checked at call time by the
 * executor; the form's cells were pinned to the sheet it OPENED on, so if the
 * user has since switched sheets the submit is refused with the fix, rather
 * than writing the same (row, col) on whatever sheet is showing.
 */
async function writeFormBindings(
  mw: MountedWorker,
  showId: string,
  bound: ResolvedFormBindings,
  values: Record<string, FormValue | string[]>,
  names: string[] | null,
): Promise<string[]> {
  const { handle, definition } = mw;
  const restricted = handle.tier !== "unlocked";
  const lib = await getLib();
  if (restricted && bound.pinnedSheet !== null) {
    const active = await lib.getActiveSheet();
    if (active !== bound.pinnedSheet) {
      throw new BrokerError(
        "HostError",
        `switch back to "${bound.pinnedSheetName ?? "the sheet this form opened on"}" to save this form`,
      );
    }
  }
  const candidates = bound.cells.filter((c) => names === null || names.includes(c.decl.name));
  // The sheet list can move under an open form (another script, an MCP tool),
  // and every binding holds an INDEX. `sheetIdentityRefusal` states the rule.
  if (candidates.length > 0) {
    const { sheets } = await lib.getSheets();
    const refusal = sheetIdentityRefusal(
      candidates.map((c) => ({ name: c.decl.name, sheetIndex: c.sheetIndex, sheetName: c.sheetName })),
      bound.pinnedSheet !== null && bound.pinnedSheetName !== undefined
        ? { index: bound.pinnedSheet, name: bound.pinnedSheetName }
        : null,
      sheets,
    );
    if (refusal !== null) throw new BrokerError("HostError", refusal);
  }
  const toWrite =
    names === null
      ? new Set(dirtyNames(values, bound.seeds, candidates.map((c) => c.decl.name)))
      : new Set(candidates.map((c) => c.decl.name));
  const cells = candidates.filter((c) => toWrite.has(c.decl.name));
  if (cells.length === 0) return [];
  await withScriptUndoBatch(lib, `Form: ${definition.name}`, async () => {
    for (const cell of cells) {
      const write = cellWriteFor(cell.decl.widgetType, values[cell.decl.name]);
      const method = restricted ? "sheet.setCellValue" : "api.setCellValue";
      const args: unknown[] = restricted ? [cell.row, cell.col, write] : [cell.row, cell.col, write, cell.sheetIndex];
      await brokerCall(handle, method, args, () => executeImpl(mw, method, args));
    }
  });
  // Re-read what was written so the widgets show the cells' formatted text
  // and an unchanged resubmit is not rewritten. Own writes never reach the
  // live watch (isOwnScriptWrite), so this is the refresh.
  //
  // `echo: false`: this is the form's OWN write coming back. Forwarding it as
  // `onChange { source: "cell" }` told a `writeOn: "change"` script that an
  // outside edit had landed on the value it had just written — the same echo
  // `isOwnScriptWrite` exists to suppress on the watch.
  const fresh: Record<string, FormSeed> = {};
  for (const cell of cells) {
    const seed = await readFormCell(mw, cell);
    bound.seeds[cell.decl.name] = seed;
    fresh[cell.decl.name] = seed;
  }
  refreshScriptFormSeeds(showId, fresh, { echo: false });
  return cells.map((c) => c.decl.name);
}

/**
 * While a form is open, a change to a cell it is bound to refreshes the
 * widget. The PINNED-SHEET filter runs before anything else: a restricted
 * form must never be shown a change from a sheet the user switched to, even
 * though the tier clamp would admit that sheet now that it is active.
 *
 * Exported for tests (formLiveWatchDisposal.test.ts drives the Controls-pane
 * subscription's import ordering, which no public entry point can reach).
 */
export function installFormLiveWatch(mw: MountedWorker, showId: string, bound: ResolvedFormBindings): CleanupFn {
  const { definition, handle } = mw;
  const restricted = handle.tier !== "unlocked";
  let pending = new Set<string>();
  let scheduled = false;
  const unsub = onAppEvent(AppEvents.CELL_VALUES_CHANGED, (detail) => {
    const d = detail as { changes?: Array<{ row: number; col: number; sheetIndex?: number }> };
    for (const c of d.changes ?? []) {
      const sheet = c.sheetIndex ?? activeSheetIndexForEvents;
      if (restricted && bound.pinnedSheet !== null && sheet !== bound.pinnedSheet) continue;
      if (isOwnScriptWrite(definition.id, sheet, c.row, c.col)) continue;
      for (const cell of bound.cells) {
        if (cell.sheetIndex === sheet && cell.row === c.row && cell.col === c.col) pending.add(cell.decl.name);
      }
    }
    if (pending.size === 0 || scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      const names = pending;
      pending = new Set();
      void (async () => {
        const fresh: Record<string, FormSeed> = {};
        for (const cell of bound.cells) {
          if (!names.has(cell.decl.name)) continue;
          const seed = await readFormCell(mw, cell);
          bound.seeds[cell.decl.name] = seed;
          fresh[cell.decl.name] = seed;
        }
        refreshScriptFormSeeds(showId, fresh);
      })();
    }, 16);
  });
  if (bound.controls.length === 0) return unsub;
  // Controls-pane values: committed changes only (a mid-drag slider frame is
  // transient and must not re-seed the form on every pixel).
  //
  // THE SUBSCRIPTION CAN OUTRUN THE FORM. `onControlValueChange` is reached
  // through a dynamic import, so a form the user (or a deadline) closes in the
  // same turn it opened runs this cleanup FIRST, against a still-empty
  // `unsubControls`, and the `.then` below then installs a live listener with
  // nobody left to remove it — one that fires for the rest of the session,
  // re-seeding a session that is gone. `disposed` is the fact the `.then` has
  // to ask about, because "was I cleaned up?" cannot be read off a closure
  // variable that is assigned after the fact.
  let unsubControls: CleanupFn = () => {};
  let disposed = false;
  void import("../controlValues").then((cv) => {
    const off = cv.onControlValueChange((change) => {
      if (change.transient) return;
      const watching = bound.controls.filter(
        (c) => c.controlName.toLowerCase() === change.name.toLowerCase(),
      );
      if (watching.length === 0) return;
      // Each delivery is a READ of that control by this script, so it goes
      // through the same audited row the resolve did — a form left open
      // receives every committed change, and the trail has to show that.
      const args: unknown[] = [change.name];
      void brokerCall(mw.handle, "form.readControl", args, async () => change.value ?? null)
        .then((value) => {
          const fresh: Record<string, FormSeed> = {};
          for (const c of watching) {
            const seed = seedFromControlValue(c.decl.widgetType, value as ControlValue | null, c.decl.multi);
            bound.seeds[c.decl.name] = seed;
            fresh[c.decl.name] = seed;
          }
          if (Object.keys(fresh).length > 0) refreshScriptFormSeeds(showId, fresh);
        })
        .catch(() => {
          /* refused: the widget keeps what it had, and the refusal is audited */
        });
    });
    // The form closed while the import was in flight: tear this down now, or
    // nothing ever will.
    if (disposed) {
      off();
      return;
    }
    unsubControls = off;
  });
  return () => {
    disposed = true;
    unsub();
    unsubControls();
  };
}

const FORM_SUBMIT_TIMEOUT = Symbol("formSubmitTimeout");

/**
 * Normalize whatever a form's onSubmit handler returned into a decision.
 *
 * Accepted cancel forms: `false`, `"cancel"`, `{ cancel: true, errors?, message? }`.
 * EVERYTHING ELSE — including `undefined` from a handler that just did some
 * work — accepts the submit. Unlike the workbook lifecycle normalizer this one
 * KEEPS `errors` and `message`: they are what the renderer paints under the
 * widgets, clamped here so a script cannot push an unbounded string at it.
 * Exported for tests.
 */
export function normalizeFormSubmitVerdict(result: unknown): FormSubmitDecision | null {
  if (result === false || result === "cancel") return { cancel: true };
  if (!result || typeof result !== "object") return null;
  const v = result as { cancel?: unknown; errors?: unknown; message?: unknown };
  if (v.cancel !== true) return null;
  const decision: FormSubmitDecision = { cancel: true };
  if (v.errors && typeof v.errors === "object" && !Array.isArray(v.errors)) {
    const errors: Record<string, string> = {};
    for (const [name, text] of Object.entries(v.errors as Record<string, unknown>)) {
      if (!isValidFormName(name) || typeof text !== "string") continue;
      errors[name] = text.slice(0, MAX_FORM_ERROR_CHARS);
    }
    if (Object.keys(errors).length > 0) decision.errors = errors;
  }
  if (typeof v.message === "string" && v.message.length > 0) {
    decision.message = v.message.slice(0, MAX_FORM_ERROR_CHARS);
  }
  return decision;
}

/**
 * Ask a form script's onSubmit for a verdict, bounded by the lifecycle
 * deadline. DEFAULT-ACCEPT on timeout, on a thrown handler, and while the
 * script is paused in the debugger — the same policy as onBeforeSave and
 * range.onBeforeCommit, for the same reason: a hung or crashed script must
 * never trap the user inside a modal. The host's own declarative checks
 * (required / min / max / options) ran before this was asked and apply
 * regardless. A script that registered no onSubmit is not asked at all.
 */
async function raceFormSubmitVerdict(
  mw: MountedWorker,
  values: Record<string, FormValue | string[]>,
): Promise<FormSubmitDecision | null> {
  if (!mw.declaredHooks.includes("onSubmit")) return null;
  if (isScriptDebugPaused(mw.definition.id)) {
    console.warn(
      `[ScriptHost] "${mw.definition.name}" is paused in the debugger — its onSubmit verdict is skipped (accepting the submit).`,
    );
    return null;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      relayMethodCall(mw, "__form_onSubmit", [{ values }]),
      new Promise<typeof FORM_SUBMIT_TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(FORM_SUBMIT_TIMEOUT), BEFORE_LIFECYCLE_DEADLINE_MS);
      }),
    ]);
    if (result === FORM_SUBMIT_TIMEOUT) {
      console.warn(
        `[ScriptHost] onSubmit of "${mw.definition.name}" exceeded ${BEFORE_LIFECYCLE_DEADLINE_MS}ms — accepting the submit`,
      );
      return null;
    }
    return normalizeFormSubmitVerdict(result);
  } catch {
    return null; // handler threw — accept (the error already surfaced on the console)
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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
// Sheet onBeforeDoubleClick / onBeforeRightClick (Wave 4): cancellable click
// verdicts — the onBeforeCommit machinery pointed at two more choke points.
// ============================================================================
//
// Both ride EXISTING @api-visible seams that Core already consults before it
// acts: the double-click verdict is a cellDoubleClickInterceptors entry (asked
// before edit mode is entered — VBA's Workbook_SheetBeforeDoubleClick), the
// right-click verdict a cellContextMenuInterceptors entry (asked before the
// grid's context menu request is emitted — ...BeforeRightClick). Same relay
// (registerReplyingHook worker-side, relayMethodCall here), same 1.5s
// BEFORE_COMMIT_DEADLINE_MS, same DEFAULT-ALLOW on timeout/throw/pause: a slow
// script must never make the grid feel broken. ACTIVE SHEET by construction —
// interceptors only ever fire for the grid the user is looking at.

/** The relayed method name for each cancellable click hook. */
const CLICK_RELAY: Record<"onBeforeDoubleClick" | "onBeforeRightClick", string> = {
  onBeforeDoubleClick: "__sheet_onBeforeDoubleClick",
  onBeforeRightClick: "__sheet_onBeforeRightClick",
};

/**
 * Ask ONE mounted script for a click verdict. Answers TRUE when the script
 * cancelled (suppress edit mode / the context menu), FALSE to proceed —
 * timeouts, throws, unmounted and debugger-paused scripts all answer false.
 * Exported for tests (same reason raceLifecycleVerdict is).
 */
export async function callSheetBeforeClick(
  scriptId: string,
  hook: "onBeforeDoubleClick" | "onBeforeRightClick",
  payload: { row: number; col: number; address: string },
): Promise<boolean> {
  const mw = mounted.get(scriptId);
  if (!mw) return false;
  if (isScriptDebugPaused(scriptId)) {
    // A breakpointed script cannot answer inside 1.5s; waiting out the
    // deadline would only add latency to every click before allowing anyway.
    return false;
  }
  try {
    const result = await Promise.race([
      relayMethodCall(mw, CLICK_RELAY[hook], [payload]),
      new Promise<typeof BEFORE_COMMIT_TIMEOUT>((resolve) =>
        setTimeout(() => resolve(BEFORE_COMMIT_TIMEOUT), BEFORE_COMMIT_DEADLINE_MS),
      ),
    ]);
    if (result === BEFORE_COMMIT_TIMEOUT) {
      console.warn(
        `[ScriptHost] ${hook} of "${mw.definition.name}" exceeded ` +
          `${BEFORE_COMMIT_DEADLINE_MS}ms — allowing the click`,
      );
      return false;
    }
    // The same cancel vocabulary every Before* hook accepts.
    return normalizeLifecycleVerdict(result) !== null;
  } catch {
    return false; // handler threw — allow (error already surfaced via console)
  }
}

/**
 * Wire a cancellable click hook: register a Core interceptor that pulls this
 * script's verdict when the grid is double- or right-clicked. Returned cleanup
 * is stored as the hook's forwarder, so unmount removes the interceptor with
 * it — an unmounted script can never eat a click.
 */
function wireClickVerdictForwarder(
  mw: MountedWorker,
  hook: "onBeforeDoubleClick" | "onBeforeRightClick",
): CleanupFn {
  const scriptId = mw.definition.id;
  const interceptor = (row: number, col: number): Promise<boolean> =>
    callSheetBeforeClick(scriptId, hook, {
      row,
      col,
      address: `${columnToLetter(col)}${row + 1}`,
    });
  return hook === "onBeforeDoubleClick"
    ? registerCellDoubleClickInterceptor(interceptor)
    : registerCellContextMenuInterceptor(interceptor);
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

/** The hook name for a lifecycle action, for log lines ("onBeforeSave"). */
function lifecycleHookName(action: LifecycleAction): string {
  return action === "save"
    ? "onBeforeSave"
    : action === "print"
      ? "onBeforePrint"
      : "onBeforeClose";
}

/** The relayed method name for each cancellable workbook hook. */
const LIFECYCLE_RELAY: Record<LifecycleAction, string> = {
  save: "__workbook_onBeforeSave",
  close: "__workbook_onBeforeClose",
  print: "__workbook_onBeforePrint",
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
        `[ScriptHost] ${lifecycleHookName(action)} of "${scriptName}" ` +
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
        `${lifecycleHookName(action)} verdict is skipped (allowing the ${action}).`,
    );
    return null;
  }
  // THE DETAIL IS THINNED BEFORE IT CROSSES. `LifecycleDetail.path` is the full
  // save path — Core hands it to every guard because trusted extension guards
  // legitimately need it, but a sandboxed onBeforeSave handler must see only the
  // NAME, exactly like api.workbookFileName and the AFTER_OPEN/AFTER_SAVE
  // deliveries. onBeforeClose carries no path today; reducing both keeps the
  // handler contract one shape and means a path added to the close detail later
  // is dropped by default instead of leaking by default.
  return raceLifecycleVerdict(
    () => relayMethodCall(mw, LIFECYCLE_RELAY[action], [thinWorkbookPathDetail(detail)]),
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

/** Relay a callMethod from another script INTO this worker (METHOD_CALL_TIMEOUT_MS). */
function relayMethodCall(mw: MountedWorker, methodName: string, args: unknown[]): Promise<unknown> {
  const callId = mw.nextReqId++;
  return new Promise((resolve, reject) => {
    const entry = {
      resolve,
      reject,
      timer: null as number | null,
      arm: (): void => {
        if (entry.timer !== null) return;
        entry.timer = setTimeout(() => {
          entry.timer = null;
          mw.pendingMethodCalls.delete(callId);
          reject(new Error(`Method '${methodName}' timed out (${METHOD_CALL_TIMEOUT_MS}ms)`));
        }, METHOD_CALL_TIMEOUT_MS) as unknown as number;
      },
    };
    entry.arm();
    mw.pendingMethodCalls.set(callId, entry);
    post(mw, { t: "methodCall", callId, methodName, args });
    // A call relayed INTO a realm that is already suspended must not start
    // burning a deadline it cannot possibly meet: the realm will not read the
    // message until it resumes.
    if (isScriptDebugPaused(mw.definition.id)) suspendMethodCallDeadlines(mw);
  });
}

/**
 * Stop the clock on every relayed method call into this realm.
 *
 * A DEBUGGED SCRIPT MUST NOT BE KILLED FOR BEING SLOW AT A BREAKPOINT. The mount
 * deadline already worked this way; relayed method calls did not, so a method
 * fired from the debugger (or a scheduled job, or a JS UDF) that stopped at a
 * breakpoint was abandoned after 30s and surfaced to the author as a timeout
 * that had nothing to do with their code.
 *
 * Render deadlines are deliberately NOT suspended: the grid is waiting on those,
 * and the realm refuses to suspend inside a render at all (beginNoPause).
 */
function suspendMethodCallDeadlines(mw: MountedWorker): void {
  for (const pending of mw.pendingMethodCalls.values()) {
    if (pending.timer === null) continue;
    clearTimeout(pending.timer);
    pending.timer = null;
  }
}

/** Re-arm those deadlines, in full, from the moment the script resumes. */
function resumeMethodCallDeadlines(mw: MountedWorker): void {
  // A form the script is waiting on is the other reason the clock is stopped;
  // the debugger resuming must not restart it under an open form. The form's
  // own close re-arms once the last hold is released.
  if (mw.formHolds > 0) return;
  for (const pending of mw.pendingMethodCalls.values()) {
    pending.arm();
  }
}

// ============================================================================
// Event forwarding — only hooks the worker declared, filters host-side
// ============================================================================

/**
 * Cap on the merged `changes` array a coalesced onDataChange delivery may carry
 * — the same bound range.onChange puts on its own entries. Beyond it the
 * payload says `truncated: true` instead of lying by omission: the script is
 * told its picture is incomplete and can re-read via getRangeValues.
 */
const MAX_COALESCED_CHANGE_ENTRIES = 1000;

/**
 * Merge two onDataChange payloads that landed inside ONE animation frame.
 *
 * The coalescing map used to keep only the LATEST payload per hook — right for
 * "latest state wins" hooks (onSelectionChange, onThemeChange), but
 * sheet.onDataChange carries a BATCH, so two CELL_VALUES_CHANGED flushes in one
 * rAF (a paste next to a fill, a recalc landing beside a user edit) silently
 * dropped the first batch and an audit script missed edits under load. Batches
 * CONCATENATE, in arrival order; the newer payload's top-level fields (the
 * active sheet) win. Payloads without a `changes` array — chart.onDataChange
 * posts `undefined` — keep the latest-wins behavior.
 */
function mergeCoalescedChangePayloads(prev: unknown, next: unknown): unknown {
  const p = prev as { changes?: unknown[]; truncated?: boolean } | null | undefined;
  const n = next as { changes?: unknown[]; truncated?: boolean } | null | undefined;
  if (!p || !n || !Array.isArray(p.changes) || !Array.isArray(n.changes)) return next;
  const merged = p.changes.concat(n.changes);
  const truncated =
    p.truncated === true || n.truncated === true || merged.length > MAX_COALESCED_CHANGE_ENTRIES;
  if (merged.length > MAX_COALESCED_CHANGE_ENTRIES) merged.length = MAX_COALESCED_CHANGE_ENTRIES;
  return { ...(n as object), changes: merged, ...(truncated ? { truncated: true } : {}) };
}

function forwardEvent(mw: MountedWorker, hook: string, payload: unknown): void {
  if (COALESCE_HOOKS.has(hook)) {
    const queued =
      hook === "onDataChange" && mw.coalesced.has(hook)
        ? mergeCoalescedChangePayloads(mw.coalesced.get(hook), payload)
        : payload;
    mw.coalesced.set(hook, queued);
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

/**
 * Drop the cell changes a RESTRICTED script may not be shown: the ones that
 * happened on a sheet other than the one on screen.
 *
 * THE PUSH DOOR HAD TO BE CLOSED TOO. `sheet.getCellValue` refuses a restricted
 * script that names another sheet, but `sheet.onDataChange` / `cell.onEdit`
 * forwarded the WHOLE CELL_VALUES_CHANGED array — every change's row, col,
 * oldValue, newValue and formula — including changes on sheets the script could
 * never have asked for. A cross-sheet fill, a table refresh or an unlocked
 * script's write on another sheet therefore delivered exactly the contents the
 * pull door refuses. The tier is a statement about what a script may SEE, not
 * only about what it may ask for, so it is enforced on delivery as well.
 *
 * Unlocked scripts keep the full stream (they may read any sheet anyway).
 * `range.onChange` / `namedRange.onChange` already filter by their object's
 * sheet; this is the same rule for the two hooks that had no object to filter by.
 */
function clampChangesToTier<T extends { sheetIndex?: number }>(
  mw: MountedWorker,
  changes: T[],
): T[] {
  if (mw.handle.tier === "unlocked") return changes;
  return changes.filter((c) => (c.sheetIndex ?? activeSheetIndexForEvents) === activeSheetIndexForEvents);
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
      // THINNED, like every other sandboxed delivery. The raw AFTER_OPEN detail
      // is `{ path }` — the user's full folder layout — and this forwarder was
      // the one that handed it over raw.
      addForwarder(mw, hook, onAppEvent(AppEvents.AFTER_OPEN, (d) => {
        pushWorkbookMirror(mw);
        forwardEvent(mw, hook, thinAppEventForScripts(AppEvents.AFTER_OPEN, d));
      }));
      // REPLAY AT MOUNT — once per open-mount. Scripts are mounted FROM the
      // AFTER_OPEN handler, so the live subscription above always comes into
      // being AFTER the broadcast it exists to observe: without this, the
      // advertised onOpen hook could never see its own workbook's open. The
      // payload is the SAME thinned `{ fileName }` shape the live path
      // delivers, rebuilt from the current file (the event detail is long
      // gone), via the exact source api.workbookFileName reads. Guarded by the
      // consumed mountCause flag — a remount, Save & Apply or crash respawn
      // never replays (see HostMountDefinition.mountCause).
      if (mw.openReplayPending) {
        mw.openReplayPending = false;
        void (async () => {
          let fileName: string | null = null;
          try {
            const fs = await import("../filesystem");
            const path = await fs.getCurrentFilePath();
            fileName = path ? fs.fileNameOf(path) : null;
          } catch {
            // No backend (or no file yet) — the open still happened; deliver
            // the same `{ fileName: null }` an untitled workbook's open does.
          }
          // The mount may have been torn down while the name was fetched; a
          // dead realm gets nothing.
          if (mounted.get(mw.definition.id) !== mw) return;
          forwardEvent(mw, hook, { fileName });
        })();
      }
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
    // The third cancellable lifecycle hook (Wave 4): VBA's Workbook_BeforePrint.
    // Same replying-guard construction as save/close — the Print extension's
    // handlePrint/Export-PDF choke points (and the script PDF seam,
    // @api/printService) all pull the verdict through checkLifecycleGuards.
    case "workbook.onBeforePrint":
      addForwarder(mw, hook, wireLifecycleGuardForwarder(mw, "print"));
      break;
    case "workbook.onSheetChange":
      addForwarder(mw, hook, onAppEvent(AppEvents.SHEET_CHANGED, (d) => {
        pushWorkbookMirror(mw);
        forwardEvent(mw, hook, d);
      }));
      break;
    // Sheet COLLECTION hooks (Wave 4): pure forwarders over the SHEET_ADDED /
    // SHEET_DELETED / SHEET_RENAMED events the tauri-api sheet wrappers emit
    // (their payload shapes are public — see events.ts). The workbook mirror
    // is pushed FIRST, the onSheetChange pattern, so a handler reading
    // properties.sheetCount or getSheetNames() sees the post-change truth.
    case "workbook.onSheetAdd":
      addForwarder(mw, hook, onAppEvent(AppEvents.SHEET_ADDED, (d) => {
        pushWorkbookMirror(mw);
        forwardEvent(mw, hook, d);
      }));
      break;
    case "workbook.onSheetDelete":
      addForwarder(mw, hook, onAppEvent(AppEvents.SHEET_DELETED, (d) => {
        pushWorkbookMirror(mw);
        forwardEvent(mw, hook, d);
      }));
      break;
    case "workbook.onSheetRename":
      addForwarder(mw, hook, onAppEvent(AppEvents.SHEET_RENAMED, (d) => {
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
    // Cancellable CLICK hooks (Wave 4): replying hooks, not event forwarders —
    // the grid pulls a verdict through the Core interceptor registries before
    // it acts (edit-mode entry / the context menu). See wireClickVerdictForwarder.
    case "sheet.onBeforeDoubleClick":
      addForwarder(mw, hook, wireClickVerdictForwarder(mw, "onBeforeDoubleClick"));
      break;
    case "sheet.onBeforeRightClick":
      addForwarder(mw, hook, wireClickVerdictForwarder(mw, "onBeforeRightClick"));
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
      // Driven by the SELECTION_CHANGED app event — the emitter the Shell
      // actually feeds (registries/ExtensionRegistry.notifySelectionChange).
      // This hook previously subscribed to @api/extensionRegistry's callback
      // registry, a singleton NOTHING notifies at runtime (the Shell drives
      // its own registry through the service seam), so the hook never fired
      // outside tests. The app event is also where the Wave 2 payload lives:
      // sheetIndex + every area of a multi-area selection.
      addForwarder(mw, hook, onAppEvent(AppEvents.SELECTION_CHANGED, (detail) => {
        const d = detail as {
          startRow?: number;
          startCol?: number;
          endRow?: number;
          endCol?: number;
          sheetIndex?: number;
          areas?: Array<{ startRow: number; startCol: number; endRow: number; endCol: number }>;
        } | null;
        if (!d) return;
        // Anchor corner (raw), matching the hook's historical row/col meaning.
        const row = d.startRow ?? 0;
        const col = d.startCol ?? 0;
        const sheetIndex = d.sheetIndex ?? activeSheetIndexForEvents;
        const payload = hook === "onSelect"
          ? { row, col, sheetIndex }
          : {
              sheetIndex,
              row,
              col,
              endRow: d.endRow ?? row,
              endCol: d.endCol ?? col,
              // EVERY area (Wave 2): primary + Ctrl+Click extras, normalized —
              // additionalRanges used to be dropped on this path.
              areas: d.areas ?? [
                normalizeSelectionArea({
                  startRow: row,
                  startCol: col,
                  endRow: d.endRow ?? row,
                  endCol: d.endCol ?? col,
                }),
              ],
            };
        forwardEvent(mw, hook, payload);
      }));
      break;
    }
    case "sheet.onDataChange":
      addForwarder(mw, hook, onAppEvent(AppEvents.CELL_VALUES_CHANGED, (detail) => {
        const d = detail as {
          changes?: Array<{ row: number; col: number; sheetIndex?: number } & Record<string, unknown>>;
        };
        // Per-change sheetIndex is CARRIED, not flattened. The top-level
        // `sheetIndex` used to be the only sheet in the payload, so a cross-sheet
        // change (a fill that spilled, a table refresh on another sheet) arrived
        // stamped with the ACTIVE sheet's index — a script acting on
        // `{ sheetIndex, change.row, change.col }` then read or wrote the wrong
        // sheet's cell and had no way to tell.
        //
        // OWN WRITES ARE DROPPED PER CHANGE, exactly as range.onChange drops
        // them: the typings promise a script's own writes never re-fire its
        // handlers, and without this filter the canonical VBA timestamp macro —
        // an onDataChange handler writing a neighbouring cell — re-entered
        // itself forever. A user's edit in the same flush still crosses.
        const changes = clampChangesToTier(mw, d.changes ?? [])
          .filter((c) => !isOwnScriptWrite(
            definition.id, c.sheetIndex ?? activeSheetIndexForEvents, c.row, c.col,
          ))
          .map((c) => ({
            ...c,
            sheetIndex: c.sheetIndex ?? activeSheetIndexForEvents,
            // The A1 spelling of the same coordinates, on that change's sheet.
            address: `${columnToLetter(c.col)}${c.row + 1}`,
          }));
        // A flush that was ONLY this script's own echo (or entirely outside a
        // restricted script's reach) says nothing — do not fire.
        if (changes.length === 0) return;
        forwardEvent(mw, hook, { sheetIndex: activeSheetIndexForEvents, changes });
      }));
      break;

    // ---- cell ----
    case "cell.onEdit":
      addForwarder(mw, hook, onAppEvent(AppEvents.CELL_VALUES_CHANGED, (detail) => {
        const d = detail as { changes?: Array<{ row: number; col: number; sheetIndex?: number; oldValue?: string; newValue: string; formula?: string | null }> };
        // Own-write echo guard, same as sheet.onDataChange above: an onEdit
        // handler that writes a cell must not be re-fired by that very write.
        const changes = clampChangesToTier(mw, d.changes ?? [])
          .filter((change) => !isOwnScriptWrite(
            definition.id, change.sheetIndex ?? activeSheetIndexForEvents, change.row, change.col,
          ))
          .map((change) => ({
            row: change.row,
            col: change.col,
            // Per-change sheet when the emitter tagged a cross-sheet edit; else the
            // active sheet (the historical implicit contract).
            sheetIndex: change.sheetIndex ?? activeSheetIndexForEvents,
            oldValue: change.oldValue,
            newValue: change.newValue,
            formula: change.formula,
          }));
        // Echo-only (or fully clamped) flush: nothing happened the script may act on.
        if (changes.length === 0) return;
        forwardEvent(mw, hook, { changes });
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
        if (d.timelineId !== instanceId) return;
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

    // ---- form ----
    // Nothing to WIRE: the scriptForms registry delivers these directly through
    // the session's `forward`/`mirror` callbacks while a form is open, and
    // onSubmit is a replying relay the registry pulls. The cases exist so the
    // hooks read as known rather than as a pruned surface.
    case "form.onShow":
    case "form.onChange":
    case "form.onClick":
    case "form.onClose":
    case "form.onSubmit":
      break;

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
  } catch (err) {
    // Snapshot failures degrade to defaults — the script still mounts, because
    // a missing property mirror is far less bad than a dead object. But it is
    // NOT nothing: every `context.properties.*` read below the failure point
    // silently returns a default, so a script reads 0 rows from a real table
    // and does the wrong thing quietly. Say it in the console AND on the
    // objectscript:error channel the extension routes to a toast.
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[scriptHost] snapshot for "${definition.name}" (${definition.objectType}) failed:`,
      err,
    );
    emitAppEvent("objectscript:error", {
      scriptId: definition.id,
      scriptName: definition.name,
      phase: "snapshot",
      error:
        `its object properties could not be read (${message}), so ` +
        `context.properties.* will read defaults`,
    });
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
