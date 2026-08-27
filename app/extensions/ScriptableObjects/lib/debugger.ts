//! FILENAME: app/extensions/ScriptableObjects/lib/debugger.ts
// PURPOSE: The editor's half of step-through debugging (task H1): the
//          breakpoint store (persisted in the workbook, so a session survives a
//          reload) and the session controller the toolbar drives.
//
// CONTEXT: The scripts themselves run in worker realms owned by the MAIN
//          window, but the script editor can also be a separate Tauri window.
//          So this module has two transports:
//            - "local"  — same window as the script host: call it directly.
//            - "remote" — the standalone editor window: send commands over the
//                         Tauri event bridge and mirror the state the main
//                         window broadcasts back.
//          Which one is in force is set EXPLICITLY by whoever mounts the UI
//          (`setRemoteDebugTransport()` in the standalone window). There is no
//          sniffing, and no path by which a script can reach any of this: a
//          session is created only by these functions, which are trusted UI
//          code, and never by anything the sandbox can call.

import { emitAppEvent, onAppEvent } from "@api/events";
import { emitTauriEvent, listenTauriEvent } from "@api/backend";
import { getExtensionData, setExtensionData } from "@api/extensionData";
import type { DebugSessionState, DebugTrigger } from "@api/scriptHost/host";
import type { DebugAction } from "@api/scriptHost/protocol";
import {
  enclosingTopLevelFunction,
  topLevelFunctions,
  type TopLevelFunction,
} from "@api/scriptHost/worker/debugInstrument";

export type { DebugSessionState, DebugTrigger, DebugAction };

/**
 * How a session is opened for a script with NO standing mount — a recorded macro
 * (a MODULE script) the user opened in the editor.
 *
 * `mountFromModuleStore` is a request, not a payload: the host looks the id up
 * in the module store and builds the synthetic unlocked `workbook` definition
 * itself. Nothing here — and nothing on the cross-window bridge — carries
 * SOURCE. It used to, and that made the bridge a door for mounting arbitrary
 * code at the unlocked tier by naming an id.
 */
export interface StartDebugOptions {
  pauseOnEntry?: boolean;
  /**
   * When the script is not mounted, resolve it from the workbook's module store
   * and mount it transiently for the session. False/absent keeps the strict
   * "apply it first" behaviour object scripts need.
   */
  mountFromModuleStore?: boolean;
}

// ============================================================================
// Types
// ============================================================================

export interface Breakpoint {
  scriptId: string;
  line: number;
  enabled: boolean;
}

/** Event names (window-local app events). */
export const DebugEvents = {
  /** Breakpoints for one script changed. */
  BREAKPOINTS_CHANGED: "objectscript:breakpoints-changed",
  /** Session state changed (started/paused/resumed/stopped). */
  STATE_CHANGED: "objectscript:debug-state",
} as const;

/** Cross-window channel (editor window <-> main window). */
const BRIDGE_COMMAND_EVENT = "objscript:debug-command";
const BRIDGE_STATE_EVENT = "objscript:debug-state-broadcast";

type BridgeCommand =
  | {
      command: "start";
      scriptId: string;
      lines: number[];
      pauseOnEntry: boolean;
      /**
       * Ask the host to resolve this id from the module store and mount it for
       * the session (a recorded macro has no standing mount). A FLAG, never a
       * body: the editor window cannot put source into a debug mount.
       */
      fromModuleStore?: boolean;
    }
  | { command: "stop"; scriptId: string }
  | { command: "control"; scriptId: string; action: DebugAction }
  | { command: "breakpoints"; scriptId: string; lines: number[] }
  | { command: "fire"; scriptId: string; triggerId: string };

// ============================================================================
// Breakpoint store — persisted per script IN THE WORKBOOK
// ============================================================================

/** The `extension-data` key breakpoints round-trip through in the .cala. */
export const DEBUG_EXTENSION_DATA_ID = "calcula.objectScripts.debug";

interface PersistedDebugState {
  /** scriptId -> breakpoint lines. */
  breakpoints: Record<string, number[]>;
}

let loadPromise: Promise<void> | null = null;
let loaded = false;

function toLines(bps: readonly Breakpoint[]): number[] {
  return bps.filter((bp) => bp.enabled).map((bp) => bp.line);
}

/**
 * THE BREAKPOINT SET IS NOT REACHABLE WITHOUT THE WRITE-THROUGH.
 *
 * This used to be a module-level `Map` plus a `persistBreakpoints()` that every
 * mutator had to remember - the same store-plus-remembered-persist shape that
 * silently dropped grid reports at save (`report.rs`) and that `animationStore`
 * was collapsed out of. `commit()` did the whole job; `clearAllBreakpoints()`
 * went round it and did four fifths of the job, which is the failure this shape
 * produces every time: it cleared the map, announced and persisted, and did NOT
 * tell a RUNNING debug session. So "Clear All Breakpoints" during a live debug
 * left the runtime still stopping at every breakpoint the gutter had just
 * stopped drawing.
 *
 * The map now lives in a `#private` field with three doors, and `#byScript` is
 * inaccessible outside the class body - not by convention, by the language:
 *   * `mutate()`  - changes the set for one script AND announces AND persists
 *                   AND retargets a live session. It does all of it or none.
 *   * `adopt()`   - installs a set that CAME FROM the workbook (the load path).
 *                   Deliberately does not persist; the name says so.
 *   * `forget()`  - drops everything because the DOCUMENT was replaced. Also
 *                   does not persist: the document being loaded owns the
 *                   answer, and an empty write would erase it.
 */
class BreakpointStore {
  #byScript = new Map<string, Breakpoint[]>();

  /** The breakpoints for one script. Read-only by type. */
  for(scriptId: string): readonly Breakpoint[] {
    return this.#byScript.get(scriptId) ?? [];
  }

  /** Every script id that currently has breakpoints. */
  get scriptIds(): string[] {
    return [...this.#byScript.keys()];
  }

  /** scriptId -> enabled lines, for the persist payload. */
  linesByScript(): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    for (const [scriptId, bps] of this.#byScript) {
      const lines = toLines(bps);
      if (lines.length > 0) out[scriptId] = lines;
    }
    return out;
  }

  /**
   * Set one script's breakpoints and carry the change everywhere it has to go,
   * as one step. Returns the list that was installed.
   */
  mutate(scriptId: string, bps: Breakpoint[]): Breakpoint[] {
    if (bps.length === 0) this.#byScript.delete(scriptId);
    else this.#byScript.set(scriptId, bps);
    emitAppEvent(DebugEvents.BREAKPOINTS_CHANGED, { scriptId, breakpoints: bps });
    persistBreakpoints();
    // A live session takes new breakpoints immediately - no remount, no restart.
    if (getDebugSession(scriptId)) {
      void sendBreakpoints(scriptId, toLines(bps));
    }
    return bps;
  }

  /**
   * Install a set that came OUT of the workbook. Announces, does not persist:
   * persisting here would write back the value just read, with whatever the
   * parser had to discard silently folded in.
   */
  adopt(entries: Iterable<[string, Breakpoint[]]>): void {
    for (const [scriptId, bps] of entries) this.#byScript.set(scriptId, bps);
    for (const [scriptId, bps] of this.#byScript) {
      emitAppEvent(DebugEvents.BREAKPOINTS_CHANGED, { scriptId, breakpoints: bps });
    }
  }

  /**
   * Drop everything because the DOCUMENT was replaced (File > New / File >
   * Open). Announces so every gutter clears; does not persist.
   */
  forget(): void {
    const ids = this.scriptIds;
    this.#byScript.clear();
    for (const scriptId of ids) {
      emitAppEvent(DebugEvents.BREAKPOINTS_CHANGED, { scriptId, breakpoints: [] });
    }
  }
}

const store = new BreakpointStore();

/**
 * Load the workbook's persisted breakpoints. Idempotent; safe to call from
 * every surface that shows a gutter.
 */
export function loadPersistedBreakpoints(): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    // Collected before the store is touched, so a backend that throws halfway
    // through leaves the previous (already-announced) set alone rather than
    // installing half of a workbook's breakpoints.
    let pending: Array<[string, Breakpoint[]]> = [];
    try {
      const data = await getExtensionData<PersistedDebugState>(DEBUG_EXTENSION_DATA_ID);
      if (data && data.breakpoints && typeof data.breakpoints === "object") {
        for (const [scriptId, lines] of Object.entries(data.breakpoints)) {
          if (!Array.isArray(lines)) continue;
          const clean = [...new Set(lines.filter((n) => Number.isInteger(n) && n > 0))].sort(
            (a, b) => a - b,
          );
          if (clean.length === 0) continue;
          pending.push([scriptId, clean.map((line) => ({ scriptId, line, enabled: true }))]);
        }
      }
    } catch {
      // A workbook with no stored debug state is the normal case; a backend
      // that refuses to answer must not stop the editor from opening.
    } finally {
      loaded = true;
      store.adopt(pending);
    }
  })();
  return loadPromise;
}

/** Whether the persisted set has been read (UI can show a gutter as pending). */
export function breakpointsLoaded(): boolean {
  return loaded;
}

/**
 * Forget this workbook's breakpoints and read the new one's.
 *
 * A different file's line numbers mean nothing here, so File > New / File >
 * Open must go through this rather than leaving the previous workbook's
 * breakpoints hanging in a gutter they no longer belong to.
 */
export function reloadPersistedBreakpoints(): Promise<void> {
  store.forget();
  loadPromise = null;
  loaded = false;
  return loadPersistedBreakpoints();
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced write-back. Breakpoints are user state, not document content —
 *  they go in via the plain (non-undoable) extension-data write. */
function persistBreakpoints(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const payload: PersistedDebugState = { breakpoints: store.linesByScript() };
    void setExtensionData(DEBUG_EXTENSION_DATA_ID, payload).catch(() => {
      /* best effort — a breakpoint that fails to persist still works this session */
    });
  }, 400);
}

/** Get all breakpoints for a script. */
export function getBreakpoints(scriptId: string): Breakpoint[] {
  return [...store.for(scriptId)];
}

/** Enabled breakpoint lines for a script. */
export function getBreakpointLines(scriptId: string): number[] {
  return toLines(getBreakpoints(scriptId));
}

/** Toggle a breakpoint on a line. Returns the updated breakpoints. */
export function toggleBreakpoint(scriptId: string, line: number): Breakpoint[] {
  const bps = store.for(scriptId);
  const existing = bps.find((bp) => bp.line === line);
  const next = existing
    ? bps.filter((bp) => bp.line !== line)
    : [...bps, { scriptId, line, enabled: true }].sort((a, b) => a.line - b.line);
  return store.mutate(scriptId, next);
}

/** Clear all breakpoints for a script. */
export function clearBreakpoints(scriptId: string): void {
  store.mutate(scriptId, []);
}

/**
 * Clear every breakpoint in the workbook.
 *
 * One `mutate` per script rather than a bulk clear, and that is a FIX rather
 * than a tidy-up: the hand-rolled version cleared the map, announced and
 * persisted but never told a RUNNING debug session, so "Clear All" during a
 * live debug left the runtime stopping at every breakpoint the gutter had just
 * stopped drawing. The persist is debounced, so N calls still make one write.
 */
export function clearAllBreakpoints(): void {
  for (const scriptId of store.scriptIds) {
    store.mutate(scriptId, []);
  }
}

/**
 * Re-anchor breakpoints after an edit that moved lines.
 *
 * `delta` is applied to every breakpoint at or after `fromLine`; breakpoints on
 * deleted lines are dropped. Without this a breakpoint drifts onto an unrelated
 * statement the moment the author inserts a line above it.
 */
export function shiftBreakpoints(scriptId: string, fromLine: number, delta: number): Breakpoint[] {
  const bps = store.for(scriptId);
  if (bps.length === 0 || delta === 0) return [...bps];
  const moved: Breakpoint[] = [];
  for (const bp of bps) {
    if (bp.line < fromLine) {
      moved.push(bp);
      continue;
    }
    const line = bp.line + delta;
    if (line < fromLine && delta < 0) continue; // the line itself was deleted
    if (line > 0) moved.push({ ...bp, line });
  }
  const deduped = [...new Map(moved.map((bp) => [bp.line, bp])).values()].sort(
    (a, b) => a.line - b.line,
  );
  return store.mutate(scriptId, deduped);
}

// ============================================================================
// Transport
// ============================================================================

type Transport = "local" | "remote";
let transport: Transport = "local";

/**
 * Declare that this window has no script host of its own (the standalone Object
 * Script Editor window), so debug commands must travel to the main window.
 */
export function setRemoteDebugTransport(): void {
  transport = "remote";
}

/** Current transport (tests / diagnostics). */
export function getDebugTransport(): Transport {
  return transport;
}

async function hostApi(): Promise<typeof import("@api/scriptHost/host")> {
  return import("@api/scriptHost/host");
}

async function sendCommand(cmd: BridgeCommand): Promise<void> {
  await emitTauriEvent(BRIDGE_COMMAND_EVENT, cmd);
}

// ============================================================================
// Session state mirror
// ============================================================================

const sessions = new Map<string, DebugSessionState>();

function rememberSession(scriptId: string, session: DebugSessionState | null): void {
  if (session) sessions.set(scriptId, session);
  else sessions.delete(scriptId);
}

/**
 * Keep the mirror in step with whoever announced the change — the host itself
 * (main window) or the bridge (editor window). Registered once, at module load,
 * so `getDebugSession` is never stale for the surface that is reading it.
 */
if (typeof window !== "undefined") {
  onAppEvent<{ scriptId: string; session: DebugSessionState | null }>(
    DebugEvents.STATE_CHANGED,
    (detail) => {
      if (!detail || typeof detail.scriptId !== "string") return;
      rememberSession(detail.scriptId, detail.session);
    },
  );
}

function applySessionState(scriptId: string, session: DebugSessionState | null): void {
  rememberSession(scriptId, session);
  emitAppEvent(DebugEvents.STATE_CHANGED, { scriptId, session });
}

/** The debug session for a script as this window last saw it. */
export function getDebugSession(scriptId: string): DebugSessionState | null {
  return sessions.get(scriptId) ?? null;
}

/** Subscribe to session changes. Returns a cleanup. */
export function onDebugStateChange(
  callback: (detail: { scriptId: string; session: DebugSessionState | null }) => void,
): () => void {
  return onAppEvent(DebugEvents.STATE_CHANGED, callback);
}

/**
 * Mirror the main window's broadcasts into this window. Call once from the
 * standalone editor; returns a cleanup.
 */
export function subscribeRemoteDebugState(): () => void {
  let unlisten: (() => void) | null = null;
  let disposed = false;
  void listenTauriEvent<{ scriptId: string; session: DebugSessionState | null }>(
    BRIDGE_STATE_EVENT,
    (payload) => {
      if (!payload || typeof payload.scriptId !== "string") return;
      // The main window's own app event is re-emitted here so both surfaces
      // render from exactly one shape of state.
      if (payload.session) sessions.set(payload.scriptId, payload.session);
      else sessions.delete(payload.scriptId);
      emitAppEvent(DebugEvents.STATE_CHANGED, payload);
    },
  ).then((fn) => {
    if (disposed) fn();
    else unlisten = fn;
  });
  return () => {
    disposed = true;
    unlisten?.();
  };
}

// ============================================================================
// Session control
// ============================================================================

/**
 * Start debugging one script.
 *
 * ENTERING A SESSION RESTARTS THE SCRIPT: the source is only instrumented at
 * mount, so the host remounts it. Callers must say so in the UI.
 */
export async function startDebugSession(
  scriptId: string,
  options: StartDebugOptions = {},
): Promise<void> {
  const lines = getBreakpointLines(scriptId);
  const pauseOnEntry = options.pauseOnEntry === true;
  if (transport === "remote") {
    await sendCommand({
      command: "start",
      scriptId,
      lines,
      pauseOnEntry,
      fromModuleStore: options.mountFromModuleStore === true,
    });
    return;
  }
  const host = await hostApi();
  if (options.mountFromModuleStore) {
    // Resolves the source itself, and is a plain `hostStartDebugSession` when
    // the id turns out to be mounted already.
    await host.hostStartModuleScriptDebugSession(scriptId, lines, { pauseOnEntry });
  } else {
    await host.hostStartDebugSession(scriptId, lines, { pauseOnEntry });
  }
  applySessionState(scriptId, host.getDebugSession(scriptId));
}

/** Stop debugging. Always resumes a paused script first. */
export async function stopDebugSession(scriptId: string): Promise<void> {
  if (transport === "remote") {
    await sendCommand({ command: "stop", scriptId });
    return;
  }
  const host = await hostApi();
  await host.hostStopDebugSession(scriptId);
  applySessionState(scriptId, null);
}

/**
 * Stop a session AND wait until this window can see that it is gone.
 *
 * `stopDebugSession` over the remote bridge returns as soon as the command is on
 * the wire, so the session MIRROR still holds the old session for a few
 * milliseconds. That matters for exactly one caller: the editor tearing down a
 * session whose instrumented mount was built from older source, so that the Run
 * which follows opens a FRESH mount instead of finding the stale one still
 * listed and firing into it. Without the wait, "Run picks up your edits" would
 * be a race that usually lost.
 *
 * Resolves immediately when there is no session, and on a timeout backstop so a
 * lost broadcast can never wedge Run.
 */
export async function stopDebugSessionAndWait(
  scriptId: string,
  timeoutMs = 10000,
): Promise<void> {
  if (!getDebugSession(scriptId)) return;
  if (transport === "local") {
    await stopDebugSession(scriptId);
    return;
  }
  const gone = new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      off();
      clearTimeout(timer);
      resolve();
    };
    // Registered BEFORE the command is sent: the broadcast that clears the
    // session can arrive while `sendCommand` is still awaiting its round trip.
    const off = onDebugStateChange((detail) => {
      if (detail.scriptId === scriptId && !detail.session) finish();
    });
    const timer = setTimeout(finish, timeoutMs);
  });
  await stopDebugSession(scriptId);
  await gone;
}

/** Continue / step / pause. */
export async function debugControl(scriptId: string, action: DebugAction): Promise<void> {
  if (transport === "remote") {
    await sendCommand({ command: "control", scriptId, action });
    return;
  }
  const host = await hostApi();
  host.hostDebugControl(scriptId, action);
  applySessionState(scriptId, host.getDebugSession(scriptId));
}

/**
 * Make one of a waiting script's triggers fire.
 *
 * An event-driven script — everything the macro recorder produces — has no
 * entry point the debugger can "run", so without this a breakpoint inside its
 * handler is unreachable from the editor.
 */
export async function fireDebugTrigger(scriptId: string, triggerId: string): Promise<void> {
  if (transport === "remote") {
    await sendCommand({ command: "fire", scriptId, triggerId });
    return;
  }
  const host = await hostApi();
  await host.hostDebugFireTrigger(scriptId, triggerId);
  applySessionState(scriptId, host.getDebugSession(scriptId));
}

// ============================================================================
// Run-at-cursor (VBA F5)
// ============================================================================

/** The outcome of a run-at-cursor request — never a silent no-op. */
export type RunAtCursorOutcome =
  | { status: "ran"; functionName: string }
  | { status: "noFunction"; message: string }
  | { status: "badArity"; functionName: string; message: string }
  /** The session is open but the function has no run-target to fire (yet). */
  | { status: "notReady"; functionName: string; message: string };

/**
 * Resolve the function the cursor is in, per the VBA-F5 rule:
 *   1. the top-level function whose body encloses `line` (if it is not `setup`);
 *   2. otherwise — cursor in `setup`, in a header comment or on a blank line —
 *      the SOLE non-`setup` top-level function, if there is exactly one (the
 *      recorded-macro shape);
 *   3. otherwise `setup` itself, when the source declares one.
 *
 * Step 3 exists because a debug mount can be INERT (a module macro: entering the
 * debugger executes nothing), and on an inert mount `setup` is a registered
 * run-target — indeed the ONLY one for a macro whose whole body lives in it.
 * Refusing to resolve it would leave Run with nothing to do on exactly the
 * script the user most wants to run. On a NON-inert mount `setup` was already
 * invoked by the mount and is not a run-target; `runAtCursor` sees that in the
 * session's trigger list and says so rather than firing into nothing.
 */
interface RunTargetResolution {
  /** What Run would start, or null when nothing in the file resolves. */
  target: TopLevelFunction | null;
  /**
   * Every top-level function the source declares — including `setup`.
   *
   * Returned alongside the target because THE MESSAGE NEEDS IT. Every reason
   * Run can refuse ("setup is not a run target", "nothing resolved") is only
   * actionable if it can say what the file does contain, and re-scanning the
   * source in the message builder would derive the same fact twice from the
   * same string.
   */
  functions: readonly TopLevelFunction[];
}

function resolveRunTarget(source: string, line: number): RunTargetResolution {
  const functions = topLevelFunctions(source);
  const enclosing = enclosingTopLevelFunction(functions, line);
  if (enclosing && enclosing.name !== "setup") return { target: enclosing, functions };
  const nonSetup = functions.filter((f) => f.name !== "setup");
  if (nonSetup.length === 1) return { target: nonSetup[0], functions };
  return { target: functions.find((f) => f.name === "setup") ?? null, functions };
}

/**
 * The statuses that mean THE MOUNT HAS SETTLED: `setup` has returned or thrown,
 * so everything the realm registers at mount time exists — including the
 * run-targets the debugger exposes for each top-level function, which are what
 * run-at-cursor fires.
 *
 * THE THREE THAT ARE NOT SETTLED, and why this list is explicit rather than
 * "anything but starting":
 *   - "starting"  the realm has not reported in at all.
 *   - "running"   `setup` is still executing; it has not finished registering.
 *   - "detached"  the gap INSIDE an instrumented remount. Opening a session
 *                 unmounts the plain realm before spawning the instrumented one,
 *                 and that unmount broadcasts a `detached` session.
 *
 * That last one is the bug this list exists to prevent, and it was live: a cold
 * Run in the standalone editor window saw `detached` a few milliseconds after
 * pressing Run, called the mount settled, and fired its trigger into the gap.
 * The host answered `"method:x" is not a trigger this script has registered`,
 * the very next state broadcast wiped that error off the panel, and the user got
 * a Run that printed "Running x()…" and did absolutely nothing — while running
 * the macro once by any other route "fixed" it, because the second Run found a
 * session already open and skipped the wait entirely.
 */
const SETTLED_DEBUG_STATUSES: ReadonlySet<DebugSessionState["status"]> = new Set([
  "waiting",
  "finished",
  "paused",
  "failed",
]);

function isDebugMountSettled(session: DebugSessionState | null | undefined): boolean {
  return !!session && SETTLED_DEBUG_STATUSES.has(session.status);
}

/**
 * Wait until the debug session for `scriptId` is mounted and settled.
 *
 * The remote transport returns from `startDebugSession` as soon as the command
 * is on the wire — long before the main window has finished remounting — so
 * firing immediately would race the run-target registration. Resolves as soon as
 * the mount settles, immediately on a broadcast that reports the session FAILED
 * TO OPEN (there is nothing left to wait for), and on a timeout backstop so a
 * lost broadcast can never wedge the editor.
 */
async function waitForDebugSettled(scriptId: string, timeoutMs = 20000): Promise<void> {
  // Local transport: startDebugSession already awaited the mount before it
  // returned, so the session (and its run-targets) are settled. Only the remote
  // bridge returns before the main window has finished remounting.
  if (transport === "local") return;
  if (isDebugMountSettled(getDebugSession(scriptId))) return;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      off();
      clearTimeout(timer);
      resolve();
    };
    const off = onDebugStateChange((detail) => {
      if (detail.scriptId !== scriptId) return;
      // The bridge reports a session that could not be opened as an error
      // broadcast; waiting out the backstop for it would only delay the message.
      if (typeof (detail as { error?: string }).error === "string") {
        finish();
        return;
      }
      if (isDebugMountSettled(detail.session)) finish();
    });
    const timer = setTimeout(finish, timeoutMs);
  });
}

/**
 * Run the top-level function the cursor is in — the VBA F5 gesture.
 *
 * Ensures a debug mount exists (starting a session, and for a macro with no
 * standing mount asking the host to mount it from the module store by id — the
 * caller never supplies a body), then fires the enclosing
 * function through the SAME `hostCallExposed` door the Fire buttons use. It
 * NEVER guesses a wrong-arity call and never silently does nothing: an
 * unresolvable cursor and an un-runnable arity each return a message the caller
 * shows the user.
 */
export async function runAtCursor(
  scriptId: string,
  source: string,
  line: number,
  options: StartDebugOptions = {},
): Promise<RunAtCursorOutcome> {
  const { target, functions } = resolveRunTarget(source, line);
  if (!target) {
    return { status: "noFunction", message: noRunTargetMessage(functions) };
  }
  if (target.arity > 1) {
    return {
      status: "badArity",
      functionName: target.name,
      message:
        `"${target.name}" takes ${target.arity} arguments. Run can only start a function that ` +
        "takes no arguments or a single `api` argument — call it from setup() instead.",
    };
  }

  if (!getDebugSession(scriptId)) {
    await startDebugSession(scriptId, options);
    await waitForDebugSettled(scriptId);
  }

  // LOOK BEFORE FIRING. Over the remote bridge a fire is one-way — the host's
  // refusal comes back as a state broadcast that the next broadcast overwrites —
  // so a trigger that does not exist would be a silent no-op reported to the
  // author as "Running x()…". The session mirror already knows every trigger the
  // realm registered, so the refusal is decided HERE, where it can be returned.
  const triggerId = `method:${target.name}`;
  const session = getDebugSession(scriptId);
  // Refused only on EVIDENCE of absence. A mirror with no trigger list at all is
  // not evidence — the host is authoritative and refuses for itself, and on the
  // local transport that refusal is a throw the caller sees.
  if (
    session &&
    Array.isArray(session.triggers) &&
    !session.triggers.some((t) => t.id === triggerId)
  ) {
    return {
      status: "notReady",
      functionName: target.name,
      message: notReadyMessage(session, target.name, functions),
    };
  }
  try {
    await fireDebugTrigger(scriptId, triggerId);
  } catch (err) {
    // A COMPLETED MACRO RELEASES ITS SESSION (the host ends a debug session that
    // ran cleanly and has no event hook to wait for), and the user's next Run
    // can land in the microseconds between the look above and this fire. That is
    // not an error to show — it is a Run that needs a mount. Reopen and fire
    // once; anything else is the caller's to see.
    //
    // Local transport only: over the bridge a fire is one-way, so a fire into a
    // session that has just ended comes back as an error broadcast instead, and
    // pressing Run again works (by then the mirror has caught up).
    if (getDebugSession(scriptId)) throw err;
    await startDebugSession(scriptId, options);
    await waitForDebugSettled(scriptId);
    await fireDebugTrigger(scriptId, triggerId);
  }
  return { status: "ran", functionName: target.name };
}

/**
 * Why Run cannot start `functionName` — always a reason, and never a remedy the
 * user cannot perform.
 *
 * THE BRANCH ORDER IS LOAD-BEARING, in both directions:
 *   - `failed` FIRST, because it is a settled status: reaching the settled arm
 *     with a session that holds `error` would drop the one fact that explains
 *     everything else.
 *   - the `setup` arm SECOND, because on a mount that invokes setup no wait and
 *     no restart makes it a run-target; the remedy is a different function or a
 *     trigger, and it is the only arm that can name one.
 *   - `detached` before the not-yet arm, because it is not settled either and
 *     "try again in a moment" is false advice for a realm that is gone.
 *   - the not-yet arm reads `SETTLED_DEBUG_STATUSES`, the same set the fire path
 *     waits on, so a status can never be "still coming" to one and "settled" to
 *     the other.
 */
function notReadyMessage(
  session: DebugSessionState,
  functionName: string,
  functions: readonly TopLevelFunction[],
): string {
  if (session.status === "failed") {
    return session.autoInvokeSetup === false
      ? `"${functionName}" cannot be started: ${session.error ?? "unknown error"}`
      : `setup() failed, so "${functionName}" was never registered as a run target: ` +
          `${session.error ?? "unknown error"}`;
  }
  if (functionName === "setup" && session.autoInvokeSetup !== false) {
    return setupIsNotARunTargetMessage(functions, session.triggers ?? []);
  }
  if (session.status === "detached") {
    return (
      `"${functionName}" cannot run: this script is no longer mounted, so the debug ` +
      "session has nothing left to run it in. Press Debug to open a session again, then Run."
    );
  }
  if (!SETTLED_DEBUG_STATUSES.has(session.status)) {
    return (
      `"${functionName}" is not registered as a run target yet (the script is ` +
      `${session.status}). Try Run again in a moment.`
    );
  }
  return (
    `"${functionName}" is not one of the run targets this mount registered, and the ` +
    `mount has settled (${session.status}) — waiting will not make it appear. ` +
    "Press Stop, then Run again to open a fresh session."
  );
}

/**
 * The `setup` refusal, built from what THIS file and THIS mount actually hold.
 *
 * The sentence this replaced offered two remedies unconditionally — "put the
 * cursor inside another top-level function to run that, or fire one of the
 * triggers in the debug panel" — and the user who reported it had neither: one
 * `setup`, no other function, and no trigger. Being told to use a thing that
 * does not exist is worse than being told nothing, because it reads as a fact
 * about the editor rather than a fact about the file.
 *
 * So each half is offered only when it is REAL, and when neither is, the message
 * says the honest thing: nothing in this script can be started, here is how to
 * add something that can.
 */
function setupIsNotARunTargetMessage(
  functions: readonly TopLevelFunction[],
  triggers: readonly DebugTrigger[],
): string {
  const others = functions.filter((f) => f.name !== "setup").map((f) => f.name);
  // `runTarget !== true` is the correction that makes this offer honest. A
  // run-target IS one of the top-level functions the cursor remedy just named,
  // its panel button says "Run", not "Fire", and offering it here would tell the
  // user to do the same thing twice under two different names.
  const offerable = triggers.filter((t) => t.fireable && t.runTarget !== true);
  const blocked = triggers.filter((t) => !t.fireable);

  const parts = ["setup() is the entry point this mount already ran, so it is not a run target."];
  if (others.length > 0) {
    parts.push(`Put the cursor inside ${listNames(others)} and press Run.`);
  }
  if (offerable.length > 0) {
    // "Or" only when a cursor remedy was actually offered above it. With no
    // other top-level function — the exact shape that produced this report —
    // the sentence would otherwise open on a dangling conjunction and read as
    // the second half of advice the reader never got.
    const lead = others.length > 0 ? "Or fire" : "Fire";
    parts.push(
      `${lead} one of the triggers in the debug panel: ${listNames(offerable.map(triggerLabel))}.`,
    );
  } else if (blocked.length > 0) {
    const first = blocked[0];
    const why = first.reason ? ` (${first.reason})` : "";
    parts.push(
      `The debug panel lists ${listNames(blocked.map(triggerLabel))}, but the debugger ` +
        `cannot start ${blocked.length > 1 ? "them" : "it"} directly${why}.`,
    );
  }
  if (others.length === 0 && triggers.length === 0) {
    // THE SAME REMEDY IS SPELLED OUT IN `noRunTargetMessage` BELOW. Change one
    // and change the other: they are the sibling refusals for the same missing
    // run target, and the name they suggest must be the name the scaffolds,
    // the validator's `no-run-target` notice and the authoring prompt all use
    // (`RUNNABLE_WORK_FN`, scriptTemplate.ts). `doThing` was a third spelling.
    parts.push(
      "This script has no entry point besides setup(): nothing was registered and there " +
        "is no other top-level declaration. Add one — async function run() { ... } — and " +
        "press Run with the cursor inside it.",
    );
  }
  return parts.join(" ");
}

/** How a trigger is written in prose: a method reads as a call, a hook as a name. */
function triggerLabel(trigger: DebugTrigger): string {
  return trigger.kind === "method" ? `${trigger.name}()` : trigger.name;
}

/** "a", "a or b", "a, b or c" — a list a person reads rather than parses. */
function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

/**
 * Nothing resolved from the cursor — said in terms of what the file declares.
 *
 * Two genuinely different states, and the old single sentence told both of them
 * to move the cursor. A file with NO top-level function has nowhere to put it;
 * saying "put the cursor inside a top-level function" to someone whose file has
 * none is the same defect as offering a trigger that does not exist.
 */
function noRunTargetMessage(functions: readonly TopLevelFunction[]): string {
  const names = functions.map((f) => f.name);
  if (names.length === 0) {
    // Sibling of the "no entry point besides setup()" remedy above; keep the
    // suggested name identical in both.
    return (
      "This script declares no top-level function, so Run has nothing to start. " +
      "Add one — async function run() { ... } — and press Run again."
    );
  }
  return (
    `Put the cursor inside ${listNames(names)} and press Run. Run starts the function ` +
    "the cursor is in, and this script declares more than one to choose between."
  );
}

async function sendBreakpoints(scriptId: string, lines: number[]): Promise<void> {
  if (transport === "remote") {
    await sendCommand({ command: "breakpoints", scriptId, lines });
    return;
  }
  const host = await hostApi();
  host.hostSetDebugBreakpoints(scriptId, lines);
}

// ============================================================================
// Main-window bridge
// ============================================================================

/**
 * Install the main-window half of the bridge: execute debug commands arriving
 * from the editor window, and broadcast every session change back out.
 *
 * The bridge is a RELAY, not an authority: it can only ask the host for things
 * the host already exposes to trusted UI, and every command names a scriptId the
 * host resolves against its own mount table.
 */
export function installObjectScriptDebugBridge(): () => void {
  const cleanups: Array<() => void> = [];

  cleanups.push(
    onAppEvent<{ scriptId: string; session: DebugSessionState | null }>(
      DebugEvents.STATE_CHANGED,
      (detail) => {
        if (!detail || typeof detail.scriptId !== "string") return;
        sessions.set(detail.scriptId, detail.session as DebugSessionState);
        if (!detail.session) sessions.delete(detail.scriptId);
        void emitTauriEvent(BRIDGE_STATE_EVENT, detail);
      },
    ),
  );

  let unlistenCommands: (() => void) | null = null;
  let disposed = false;
  void listenTauriEvent<BridgeCommand>(BRIDGE_COMMAND_EVENT, (cmd) => {
    if (!cmd || typeof cmd.scriptId !== "string") return;
    void (async () => {
      const host = await hostApi();
      try {
        switch (cmd.command) {
          case "start":
            if (cmd.fromModuleStore) {
              // The host reads the module store itself. All the editor window
              // can say is WHICH module; it cannot say what is in it.
              await host.hostStartModuleScriptDebugSession(cmd.scriptId, cmd.lines ?? [], {
                pauseOnEntry: cmd.pauseOnEntry === true,
              });
            } else {
              await host.hostStartDebugSession(cmd.scriptId, cmd.lines ?? [], {
                pauseOnEntry: cmd.pauseOnEntry === true,
              });
            }
            break;
          case "stop":
            await host.hostStopDebugSession(cmd.scriptId);
            break;
          case "control":
            host.hostDebugControl(cmd.scriptId, cmd.action);
            break;
          case "breakpoints":
            host.hostSetDebugBreakpoints(cmd.scriptId, cmd.lines ?? []);
            break;
          case "fire":
            await host.hostDebugFireTrigger(cmd.scriptId, cmd.triggerId);
            break;
        }
      } catch (err) {
        // The editor window is waiting on a state broadcast; give it one that
        // carries the error, rather than leaving it spinning.
        //
        // THE SESSION COMES FROM THE HOST, NEVER FROM THIS CATCH. A rejected
        // command does not mean the session is gone, and most of these are not
        // even about the session's existence: `fire` rejects with whatever the
        // SCRIPT threw, which is the one moment the debugger is most worth
        // having open. Hard-coding `session: null` here deleted the editor
        // window's mirror on exactly that path — the badge, the trigger list and
        // the Run row all disappeared while the host still held a live,
        // instrumented, debugger-owned mount, leaving the user with a running
        // realm, no Stop button to release it, and no way to retry the function
        // they had just fixed. (The in-window dialog never had this: it calls
        // the host directly, so only the host's own broadcasts move its state.)
        //
        // A start that genuinely failed still reports null — because the host
        // says so, having deleted the session itself.
        void emitTauriEvent(BRIDGE_STATE_EVENT, {
          scriptId: cmd.scriptId,
          session: host.getDebugSession(cmd.scriptId),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }).then((fn) => {
    if (disposed) fn();
    else unlistenCommands = fn;
  });

  cleanups.push(() => {
    disposed = true;
    unlistenCommands?.();
  });

  return () => {
    for (const c of cleanups.reverse()) c();
  };
}
