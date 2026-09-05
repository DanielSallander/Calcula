//! FILENAME: app/src/api/scriptHost/protocol.ts
// PURPOSE: The host <-> worker RPC protocol for the script realm (sandbox
//          design §4). All payloads are structured-clone data; ImageBitmap
//          is the only transferable. One implicit port per worker; FIFO per
//          port, so `mount` always precedes events.

import type { CapabilityId } from "./allowlist";

export const PROTOCOL_VERSION = 1;

/**
 * Current version of the object-script `context` API, stamped onto every mount
 * definition.
 *
 * It lives HERE rather than in `scriptableObjects.ts` (which re-exports it as
 * the public `SCRIPT_API_VERSION`) because the host has to build mount
 * definitions of its own — the transient mount a module macro is debugged under
 * — and `scriptableObjects.ts` imports the host. Reading the constant from
 * there would close that import cycle; duplicating it would let the two drift.
 */
export const SCRIPT_API_VERSION = "1.0.0";

/**
 * Name prefix for RUN-AT-CURSOR run-targets (VBA F5).
 *
 * On a DEBUG mount the worker auto-exposes every top-level function declaration
 * under this prefix, so the debugger can invoke the function the cursor is in
 * through the ordinary exposed-method door (`hostCallExposed`). It is a
 * SUB-namespace of the broker's `HOST_ONLY_EXPOSED_PREFIX` ("__calcula_host__"):
 * the script-facing `callExposed` door refuses the whole host-only namespace, so
 * no script can reach a run-target — only trusted host code (the debugger) can.
 *
 * Defined here rather than in `broker.ts` because the WORKER realm (bootstrap.ts
 * / contextShims.ts) must build the exposed name too, and the worker bundle may
 * not import host/broker code. A test pins it against `HOST_ONLY_EXPOSED_PREFIX`
 * so the two can never drift.
 */
export const RUN_TARGET_EXPOSED_PREFIX = "__calcula_host__runTarget:";

// ============================================================================
// Mount
// ============================================================================

/**
 * Where a DISTRIBUTED script came from, mirrored read-only into
 * `context.package`. Host-supplied at mount from the authoritative script
 * definition — never from anything the script sends — so a package-aware script
 * (one that branches on "which report am I shipped in, at which version") cannot
 * lie about its own provenance to another script it calls.
 *
 * Absent for locally authored scripts; `context.package` is then `null`.
 */
export interface MountPackageInfo {
  name: string;
  /** Resolved semver of the package version this script was pulled from. Null
   *  for a package pulled before versions were recorded on scripts. */
  version: string | null;
  provenance: "distributed";
}

/**
 * A DEBUG SESSION the user explicitly opened on this script (task H1).
 *
 * Present only when the host mounts the script FOR debugging: instrumentation
 * costs a yield point per statement, so a normal mount never carries it. A
 * script cannot put itself into a session — there is no allowlist method, no
 * setState/getState aspect and no broker method that produces this field; it is
 * built host-side from a user gesture in the editor, exactly like `tier` and
 * `capabilities`.
 */
export interface DebugSpec {
  /** Lines the user marked. Live data — updatable mid-session, no remount. */
  breakpoints: number[];
  /** Pause at the first yield point the session reaches (default false). */
  pauseOnEntry: boolean;
  /**
   * Whether this mount CALLS the script's `setup(context)` entry point.
   *
   * True for every ordinary mount, debug or not: `setup` is what registers
   * `onClick` and friends, so an object script whose setup was never called has
   * no hooks, no triggers and nothing to debug.
   *
   * FALSE ONLY FOR THE SYNTHETIC MODULE-MACRO MOUNT the host builds in
   * `hostStartModuleScriptDebugSession`. A recorded macro's `setup` is not a
   * registration step — under the synthetic unlocked `workbook` definition
   * `context.onClick` does not exist, so setup falls through to
   * `return macroNNNN(context.api)` and MOUNTING THE MACRO RUNS IT. Entering the
   * debugger therefore executed the whole macro, then invited the user to step
   * through effects that had already landed (and ran it a second time when they
   * did). VBA's contract is the opposite: entering debug prepares the script and
   * executes NOTHING; Run / run-at-cursor / firing a trigger is what starts it.
   *
   * When false the realm still evaluates the module body and installs every
   * run-target (including `setup` itself — see bootstrap.ts), so the session has
   * something to run; it just does not invoke the entry point itself.
   */
  autoInvokeSetup: boolean;
}

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
  /** Set for distributed scripts only — seeds the read-only `context.package`. */
  packageInfo?: MountPackageInfo;
  /** Set ONLY for a mount the user opened a debug session on. */
  debug?: DebugSpec;
  /** Mirror seeds for sync getters (workbook/shape/panel props, slicer selection). */
  snapshot: {
    properties?: Record<string, unknown>;
    selection?: unknown;
    /**
     * PREVIEW mounts only (§5c.1): a mirror path with no seed THROWS a
     * `PREVIEW_MIRROR_GAP`-prefixed error instead of answering its fallback.
     *
     * A real mount's fallbacks are placeholders the host immediately overwrites
     * with `{t:"mirror"}` pushes; a preview sends none, so under a preview the
     * fallback is not a default — it is a fabricated answer (`sheetCount: 0`
     * against a real 3-sheet workbook) that crosses no broker and therefore
     * can never gap. Strict mode turns that silent fiction into the same
     * decline every other unservable member gets.
     */
    strict?: boolean;
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
  kind: "shape" | "slicerItem" | "chartMark";
  /** Cache key (shape instanceId, slicer item key, or chart-mark composite key).
   *  MUST NOT contain '|' — requestDraw builds the in-flight key as `${kind}|${key}`. */
  key: string;
  /** The structured-clone payload the renderer receives: a slicer item, or a
   *  chart mark's { spec, data, layout, theme } paint context. */
  item?: unknown;
};

/** What the editor can ask a debug session to do. */
export type DebugAction =
  | "continue"
  | "stepOver"
  | "stepInto"
  | "stepOut"
  | "pause"
  | "stop";

export type H2W =
  | { t: "mount"; spec: MountSpec }
  | { t: "debugBreakpoints"; lines: number[] }
  | { t: "debugControl"; action: DebugAction }
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

/**
 * One hit-testable rectangle a SANDBOXED chart mark optionally returns from its
 * markRenderer, in LOCAL plot coordinates (origin 0,0, sized to the plot area the
 * worker painted). Structural by design — protocol.ts must not import Charts types
 * (Alien Rule). The host SANITIZES these (finite-check, clamp to the bitmap, cap
 * count) before trusting them, then the Charts shim offsets them into chart space.
 */
export interface SandboxHitRect {
  x: number;
  y: number;
  w: number;
  h: number;
  seriesIndex?: number;
  categoryIndex?: number;
  value?: number;
  seriesName?: string;
  categoryName?: string;
}

/** Optional per-datum hit geometry a sandboxed mark returns alongside its bitmap. */
export interface SandboxHitGeometry {
  rects: SandboxHitRect[];
}

/** Hard cap on returned rects (a hostile mark can't bloat host memory/hit-tests). */
export const MAX_SANDBOX_HIT_RECTS = 5_000;

// ============================================================================
// Debug channel (task H1)
// ============================================================================

/**
 * One inspected binding. STRINGIFIED IN THE WORKER: only a name, a type tag and
 * a bounded preview ever cross to the host. No object graph, no function
 * reference, nothing structured-cloned out of the realm — the debug channel is
 * a viewport, never a new export path.
 */
export interface DebugVariable {
  name: string;
  type: string;
  value: string;
}

/** One frame of the captured call stack (best effort — see debugRuntime.ts). */
export interface DebugFrame {
  functionName: string;
  line: number | null;
}

/** The state the editor renders while a script sits at a yield point. */
export interface DebugPauseState {
  line: number;
  reason: "breakpoint" | "step" | "pause" | "entry";
  variables: DebugVariable[];
  callStack: DebugFrame[];
  /** Yield points suspended behind this pause (concurrent hook dispatches). */
  waiting: number;
}

/**
 * A breakpoint that could not suspend: it sits in a SYNCHRONOUS function, and
 * JS cannot suspend synchronous code without blocking the whole realm. The
 * runtime captures the locals and keeps going, and the editor says so.
 */
export interface DebugSnapshotState {
  line: number;
  variables: DebugVariable[];
  /** Hits collapsed into this report by the rate limiter. */
  suppressed: number;
}

/**
 * Whether SCRIPT CODE IS ACTUALLY ON THE STACK right now.
 *
 * WHY THIS EXISTS. A session used to flip to "running" the moment the realm
 * reported it had instrumented the source, and nothing ever moved it off again.
 * For the overwhelmingly common script shape — `setup` registers a handler and
 * returns — that meant the editor said "Running" forever while precisely
 * nothing ran, and the user sat waiting for an event a debug session gave them
 * no way to fire. The realm is the ONLY place that can answer this honestly, so
 * it says so: one message when an execution starts, one when it finishes.
 *
 * `label` names the execution ("setup", a hook name, an exposed method) so the
 * editor can say WHAT is running rather than merely that something is.
 */
export interface DebugActivityState {
  /** True when an execution began, false when the last one finished. */
  running: boolean;
  /** What started/finished: "setup", "onClick", "recalcAll()", ... */
  label: string;
  /** Set on a finishing report whose execution threw or rejected. */
  error?: string;
}

/** What instrumentation actually achieved for this script. */
export interface DebugReadyState {
  /** False when the pass bailed out — the ORIGINAL source is running. */
  instrumented: boolean;
  /** Lines with a pausable yield point (breakpoints here are VERIFIED). */
  pausableLines: number[];
  /** Lines with a snapshot-only yield point (synchronous context). */
  snapshotLines: number[];
  /** Functions promoted to `async` so their bodies could become pausable. */
  promotedFunctions: string[];
  error?: string;
}

export type W2H =
  | { t: "mounted"; ok: boolean; error?: string }
  | { t: "debugReady"; state: DebugReadyState }
  | { t: "debugPaused"; state: DebugPauseState }
  | { t: "debugResumed" }
  | { t: "debugSnapshot"; state: DebugSnapshotState }
  | { t: "debugActivity"; state: DebugActivityState }
  | { t: "validated"; valid: boolean; error?: string }
  | { t: "call"; callId: number; method: string; args: unknown[] }
  | { t: "hookRegistered"; hook: string }
  // Posted when an {t:"event"} dispatch PROMISE settles (success or failure).
  // The preview's completion signal for a handler that sleeps between broker
  // calls: quiescence-by-calls saw nothing in flight during the sleep and cut
  // the run short, losing the tail write (§5c.1). Real mounts ignore it.
  | { t: "eventDone"; hook: string }
  | { t: "renderCellsResult"; reqId: number; styles: (StyleOverride | null)[] }
  | { t: "renderDrawResult"; reqId: number; bitmap: ImageBitmap | null; hitGeometry?: SandboxHitGeometry | null }
  | { t: "methodResult"; callId: number; ok: boolean; value?: unknown; error?: RpcErrorShape }
  | { t: "console"; level: "log" | "warn" | "error"; args: unknown[] }
  | { t: "error"; hook?: string; message: string; stack?: string }
  // `timers` = live capped timers in the realm (workerHardening). The preview's
  // quiescence check needs it: a handler suspended on setTimeout has no broker
  // call in flight, so without this count the drain declared the realm idle
  // and a correct script's tail writes were missing from the diff (§5c.1).
  | { t: "pong"; seq: number; timers?: number };

/**
 * Prefix of the error a STRICT mount's unseeded mirror read throws.
 *
 * A string marker rather than a class because it crosses the worker boundary
 * as `{t:"error"}` text; the preview recognises it and converts the run into a
 * decline ("the preview cannot serve <path>") instead of reporting the throw
 * as the script's own failure.
 */
export const PREVIEW_MIRROR_GAP = "__preview-mirror-gap__:";

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

/**
 * Deadline for a call that WAITS ON A HUMAN (the "ui" method class: the
 * ui.dialog family). Every other deadline in this file bounds machine work, so
 * 30s is generous; a modal a user is reading routinely outlives that, and the
 * 30s timer would abandon the call while the dialog is still on screen — the
 * script would see a spurious Timeout and the user's eventual answer would land
 * nowhere. Five minutes is long enough to read and type, short enough that a
 * forgotten dialog still frees the script (the host resolves it as DISMISSED —
 * a "ui" call never hangs and never rejects on the deadline).
 */
export const UI_DIALOG_DEADLINE_MS = 300_000;

/** Host deadlines by method class (ms): read 10s, mutate 30s, net 120s,
 *  ui / file = however long a person takes (UI_DIALOG_DEADLINE_MS — a native
 *  file picker is bounded by the same human as a modal). */
export const CLASS_DEADLINES_MS: Record<string, number> = {
  read: 10_000,
  mutate: 30_000,
  emit: 10_000,
  net: 120_000,
  ui: UI_DIALOG_DEADLINE_MS,
  file: UI_DIALOG_DEADLINE_MS,
};

/**
 * Per-method worker-side deadline overrides. The worker cannot import the
 * ALLOWLIST (policy must not ride into the sandbox bundle), so the handful of
 * methods whose class deadline differs from CALL_TIMEOUT_MS are named here.
 * Pinned against the allowlist's classes by the protocol tests.
 */
export const METHOD_DEADLINES_MS: Record<string, number> = {
  "cap.dialogAlert": UI_DIALOG_DEADLINE_MS,
  "cap.dialogConfirm": UI_DIALOG_DEADLINE_MS,
  "cap.dialogPrompt": UI_DIALOG_DEADLINE_MS,
  "cap.dialogForm": UI_DIALOG_DEADLINE_MS,
  // Another script's form by name: same shape as form.show — resolves once the
  // form is ON SCREEN, the answer arrives later as an event (scriptForms.ts).
  "cap.formsShow": UI_DIALOG_DEADLINE_MS,
  // form.show is class "ui" (it interrupts the user), but it resolves as soon
  // as the trusted renderer acknowledges the form is ON SCREEN — the answer
  // arrives later as an event. The open form is bounded by the host-side
  // idle/absolute deadlines in scriptForms.ts, not by this timer; this row only
  // keeps the show from being abandoned while the renderer is still mounting.
  "form.show": UI_DIALOG_DEADLINE_MS,
  // An ADD-IN's form (M4). Same shape as form.show — it resolves once the
  // renderer says the form is on screen — plus the reason cap.dialogForm needs
  // this row: it carries `ui.dialog`, so the FIRST call awaits the consent
  // prompt, and the generic 30 s timer would abandon it while the person was
  // still reading. The open form is then bounded by scriptForms.ts's own
  // idle/absolute deadlines, not by this one.
  "ext.formShow": UI_DIALOG_DEADLINE_MS,
  // Task panes (M2). pane.dock never waits on the USER — it resolves once the
  // renderer acknowledges the pane is on screen — but it is the capability-
  // bearing entry point, so its FIRST call awaits the ui.pane consent dialog,
  // and the generic 30 s timer would abandon it while the person was still
  // reading the prompt. pane.reveal carries the capability too.
  "pane.dock": UI_DIALOG_DEADLINE_MS,
  "pane.reveal": UI_DIALOG_DEADLINE_MS,
  // The file.picker family and workbook Save As (class "file"): a native
  // save/open dialog is bounded by the same person a modal is. On the 30s
  // default the worker would abandon the call while the picker was still open,
  // the script would see a spurious Timeout, and the file the user then chose
  // would be written with nobody listening for the result.
  //
  // api.workbookSave is deliberately absent: it opens no picker (it writes back
  // to the file the workbook came from) and is bounded by the Before-Save
  // handlers, which carry their own 3s deadline in host.ts.
  "cap.fileExportText": UI_DIALOG_DEADLINE_MS,
  "cap.fileImportText": UI_DIALOG_DEADLINE_MS,
  // Same picker, plus the host's read + magic-byte validation + hashing after
  // the user chooses. The human is still the slow part.
  "cap.fileImportMedia": UI_DIALOG_DEADLINE_MS,
  // Same picker, plus a PDF render before it opens.
  "cap.filePrintPdf": UI_DIALOG_DEADLINE_MS,
  "api.workbookSaveAs": UI_DIALOG_DEADLINE_MS,
};

/** The worker-side deadline for one method (default CALL_TIMEOUT_MS). */
export function callDeadlineMs(method: string): number {
  return METHOD_DEADLINES_MS[method] ?? CALL_TIMEOUT_MS;
}
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
/**
 * Backpressure releases only once the realm has drained back BELOW this many
 * outstanding dispatches. One threshold flaps on every acknowledgement — hold
 * at 256, release at 255, hold at 256 again — so the hold has hysteresis.
 */
export const EVENT_QUEUE_LOW_WATER = 64;
/**
 * A realm that has outstanding dispatches and acknowledges NONE of them for this
 * long has stopped running its event loop (an infinite loop in a hook, a
 * handler awaiting a promise that never settles). The host treats that exactly
 * as a crash — the realm is respawned once, then faulted — because a script
 * that has stopped acknowledging is indistinguishable from one that has died,
 * and its queue would otherwise grow for as long as the workbook stays open.
 */
export const EVENT_STALL_MS = 30_000;
/** Render request: no response within this window -> drop in-flight, degrade. */
export const RENDER_TIMEOUT_MS = 2_000;

/**
 * Max variable-preview length crossing the debug channel, per value. Bounds
 * what one paused frame can push at the host.
 */
export const DEBUG_VALUE_PREVIEW_CHARS = 200;

/** Max stack frames reported with a pause. */
export const DEBUG_MAX_STACK_FRAMES = 32;

/**
 * Minimum gap between two `debugSnapshot` reports (synchronous-context hits).
 * A breakpoint inside a hot synchronous loop cannot pause, so without this it
 * would post one message per iteration and drown the host message loop.
 */
export const DEBUG_SNAPSHOT_MIN_INTERVAL_MS = 250;

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
