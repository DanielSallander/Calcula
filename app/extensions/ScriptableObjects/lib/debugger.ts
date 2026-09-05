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

/**
 * What every command on the bridge carries besides its own arguments.
 *
 * `id` IS THE CORRELATION. The main-window bridge echoes it on the broadcast
 * that answers the command (`DebugStateBroadcast.commandId`), so the editor
 * window pairs an answer with the exact command it answers — never with
 * "whichever start went out first". Minted from one window-wide sequence
 * (`nextBridgeCommandId`), monotonic and never reused, so a stale id matches
 * nothing; for a `start` it is the same number `startDebugSession` returns as
 * the attempt token, which is what lets a Run claim its own refusal by id.
 *
 * A command WITHOUT a numeric id is dropped by the bridge unanswered: an
 * unanswerable command is exactly the silent no-op this whole area exists to
 * stop, and both ends of the bridge are this one file, so nothing legitimate
 * sends one.
 */
interface BridgeEnvelope {
  id: number;
  scriptId: string;
}

type BridgeCommand = BridgeEnvelope &
  (
    | {
        command: "start";
        lines: number[];
        pauseOnEntry: boolean;
        /**
         * Ask the host to resolve this id from the module store and mount it for
         * the session (a recorded macro has no standing mount). A FLAG, never a
         * body: the editor window cannot put source into a debug mount.
         */
        fromModuleStore?: boolean;
      }
    | { command: "stop" }
    | { command: "control"; action: DebugAction }
    | { command: "breakpoints"; lines: number[] }
    | { command: "fire"; triggerId: string }
  );

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
    const pending: Array<[string, Breakpoint[]]> = [];
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

/**
 * One sequence for every command this window puts on the bridge AND for every
 * start attempt (local or remote). Monotonic and window-wide: a number is never
 * reused, so an answer to a command that has been accounted for matches nothing.
 */
let bridgeCommandSeq = 0;

function nextBridgeCommandId(): number {
  return ++bridgeCommandSeq;
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

/** Every command the editor window can put on the bridge. */
type BridgeCommandName = BridgeCommand["command"];

/** What a state broadcast carries. `error` is the bridge's, never the host's. */
interface DebugStateBroadcast {
  scriptId: string;
  session: DebugSessionState | null;
  /**
   * Set ONLY by the main-window bridge's catch: the command it relayed REJECTED,
   * and this is what it rejected with. The host's own `emitDebugState` never
   * carries it, so an `error` here means "this window's last command failed".
   */
  error?: string;
  /**
   * WHICH COMMAND THIS BROADCAST IS ANSWERING — the fact the bridge used to have
   * in hand and drop, and the root of two defects that made the refusal record
   * worse than not having one.
   *
   * Present only on a broadcast the BRIDGE itself built as the answer to one
   * relayed command: its catch (the command rejected; `error` says why) and, for
   * a `start` only, the success answer it sends when the host's start promise
   * resolves. Absent on everything the HOST itself announced (`emitDebugState`
   * relayed out by the bridge's app-event listener): those are unsolicited state
   * changes, not answers to any one command.
   *
   * The rule this enables: only a `start` answer may be paired with a start
   * attempt. A `fire` that rejects after the session auto-ended broadcasts
   * `{ session: null, error }` exactly like a refused mount does, and stamping
   * that onto an outstanding start reported a mount that SUCCEEDED as
   * never-mounted.
   */
  command?: BridgeCommandName;
  /**
   * The `id` of that command, echoed verbatim. Set together with `command` and
   * never alone: this is what pairs the answer with ONE start attempt rather
   * than with the oldest one outstanding. The pairing used to be arrival order —
   * "the host answers starts in the order it received them, and the bridge
   * relays in order" — which was an assumption about two async pipelines that
   * nothing checked. With the id it is not an assumption.
   */
  commandId?: number;
}

/** A broadcast the bridge stamped as the answer to one command, decoded. */
interface BridgeAnswer {
  command: BridgeCommandName;
  id: number;
}

/**
 * What a broadcast is: an UNSTAMPED host state (`null`), a well-formed answer
 * to one command, or `"malformed"` — stamped with a command but no usable id.
 *
 * The bridge sets `command` and `commandId` together and refuses to relay a
 * command that has no id, so a malformed stamp cannot come from this bridge. It
 * is decoded as its own case rather than folded into either neighbour on
 * purpose: treating it as unstamped would let it retire a start it does not
 * belong to, and treating it as an answer would mean guessing WHICH — the
 * arrival-order pairing this id replaced.
 */
function decodeBridgeAnswer(detail: DebugStateBroadcast): BridgeAnswer | null | "malformed" {
  if (detail.command === undefined) return null;
  if (typeof detail.commandId !== "number" || !Number.isInteger(detail.commandId)) {
    return "malformed";
  }
  return { command: detail.command, id: detail.commandId };
}

/**
 * WHY A REFUSED START HAS TO BE REMEMBERED AT ALL.
 *
 * On the remote transport a start is ONE-WAY: `startDebugSession` returns when
 * the command is on the wire. A mount the host REFUSES (Script Security, or the
 * distributed-application consent gate) throws before any session exists, so
 * nothing lands in the session mirror — and the mirror's own rule is that an
 * absent session is NOT evidence of refusal, because a mirror that has simply
 * not caught up looks identical.
 *
 * The refusal does arrive: the bridge's catch broadcasts `{ session: null,
 * error }`, with the gate's own sentence in `error`. It was just never kept.
 * `waitForDebugSettled` stopped waiting on it and dropped it on the floor, and
 * run-at-cursor then fired into a script that had never mounted and told the
 * author "Running x()…".
 *
 * So the broadcast is recorded here, and it is EVIDENCE rather than a guess:
 *   * a broadcast that carries a SETTLED session answers the start — whatever
 *     was refused, a mount exists now and has finished coming up;
 *   * a broadcast with NO session and an error records that error — the host
 *     answered, and its answer was no;
 *   * no broadcast at all records nothing, which is exactly the "slow mirror"
 *     case, and it must keep falling through to the host rather than becoming a
 *     refusal this window invented.
 *
 * TWO KINDS OF BROADCAST ARE NOT ANSWERS AT ALL, and treating them as answers is
 * what made this record worse than no record:
 *
 *   * PROGRESS. The host publishes `{ status: "starting" }` BEFORE it awaits the
 *     mount (`startDebugSessionOn`), so a refused mount puts three things on the
 *     wire in order: `starting`, then `null` (the host deleting the session it
 *     just announced), then the bridge's `{ null, error }`. Retiring the attempt
 *     on `starting` consumed it, the real refusal that followed found nothing
 *     outstanding and was discarded, and Run fell through to `{ status: "ran" }`
 *     — the exact lie this record exists to stop, produced by the record itself.
 *     So only a SETTLED session (`isDebugMountSettled`, the same set the fire
 *     path waits on) answers an attempt; `starting`, `running` and `detached` are
 *     the mount still happening and change nothing here.
 *
 *   * ANOTHER COMMAND'S ANSWER. The bridge's catch fires for EVERY relayed
 *     command, and a `fire` into a session that has just auto-ended rejects with
 *     `{ session: null, error }` — byte for byte the shape of a refused mount.
 *     Stamped onto an outstanding start, that reported a mount which then
 *     succeeded as never-mounted. The broadcast now names the command it is
 *     answering, and only a `start` answer may be paired with a start attempt.
 *
 * WHY THE RECORD CARRIES AN ATTEMPT ID, AND IS NOT ONE SLOT PER SCRIPT.
 *
 * A bare `Map<scriptId, string>` is correct only while exactly ONE start is
 * outstanding, and that is not the world this runs in: `runFromCursor` had no
 * in-flight guard and F5 is a Monaco keybinding, which AUTO-REPEATS. Two
 * overlapping `runAtCursor` calls therefore start two sessions, the host refuses
 * both, and the single slot can answer only one of them. The other read `null`,
 * found no session in the mirror, fell through the evidence-only trigger check
 * (an empty mirror is not evidence) and reported `{ status: "ran" }` — the exact
 * lie this record exists to stop, reintroduced by the record's own shape.
 *
 * So every start MINTS a token, the token rides with the attempt — over the
 * bridge it IS the command's `id`, and the bridge echoes it on the answer — and
 * a refusal answers the attempt it belongs to and no other:
 *   * `beginStartAttempt` mints one and appends it to this script's outstanding
 *     queue, BEFORE the command leaves;
 *   * a STAMPED `start` answer (the bridge's rejection, or the success answer it
 *     sends when the host's start promise resolves) retires exactly the attempt
 *     whose id it echoes, and a refusal is recorded under that id — provided the
 *     attempt is still outstanding or a Run is still waiting on it. An answer
 *     to an attempt that is neither belongs to nobody in this window and is
 *     not kept;
 *   * an UNSTAMPED settled session (the host's own `emitDebugState`, relayed
 *     verbatim) is the FALLBACK: it retires the oldest outstanding attempt, as
 *     the record always did. The bridge answers every start it relays, and the
 *     host's settled state goes out BEFORE the start promise resolves
 *     (`mountWorker` resolves from the worker's `mounted` message, and
 *     `noteDebugMountSettled` runs first), so by the time the fallback fires
 *     the stamped success answer is already on the wire behind it; the fallback
 *     matters only for an answer the wire lost, and it can only ever retire —
 *     it never records a reason, so it can never put words in a Run's mouth;
 *   * `takeStartRefusal(scriptId, attempt)` returns a reason only when the stamps
 *     match, and leaves a non-matching record exactly where it is. A refusal
 *     nobody claimed (a Debug press with no `runAtCursor` behind it) can never
 *     become a later Run's answer, and a later Run's refusal can never be eaten
 *     by an earlier one.
 *
 * WHY ARRIVAL ORDER WAS NOT GOOD ENOUGH, even though nobody could show a
 * reordering on today's wire: two starts are two independent async chains in
 * the main window (`hostStartDebugSession` awaits a worker spawn, a consent
 * gate, a mount timeout), and "the host answers starts in the order it received
 * them" was a property of the current implementation, not of the protocol. A
 * Run whose refusal arrived BEFORE an earlier Debug press's answer was stamped
 * onto the Debug press, waited out its backstop, and fired into nothing — the
 * exact lie this record exists to stop, held off only by an ordering nothing
 * enforced. The id makes the pairing a fact of the message.
 *
 * Both queues are capped: they are bookkeeping for in-flight gestures, not a log.
 */
interface RecordedStartRefusal {
  /** The start attempt this refusal answers. */
  attempt: number;
  /** The gate's own sentence, verbatim. */
  reason: string;
}

/** Per script: attempts that have gone out and not yet been answered, oldest first. */
const outstandingStarts = new Map<string, number[]>();

/** Per script: refusals the host answered with, each stamped with its attempt. */
const startRefusals = new Map<string, RecordedStartRefusal[]>();

/**
 * How many in-flight starts (and unclaimed refusals) one script may accumulate.
 *
 * A bound rather than unlimited growth: an unclaimed refusal is deliberately
 * left alone (that is the fix), so without a cap a workbook that refuses every
 * Debug press would grow one entry per press for the life of the window.
 */
const MAX_TRACKED_STARTS = 8;

/**
 * Mint the token for a start that is about to go out. Over the bridge the token
 * is the command's `id`, so it comes from the bridge's own sequence.
 */
function beginStartAttempt(scriptId: string): number {
  const attempt = nextBridgeCommandId();
  const queue = outstandingStarts.get(scriptId) ?? [];
  queue.push(attempt);
  while (queue.length > MAX_TRACKED_STARTS) queue.shift();
  outstandingStarts.set(scriptId, queue);
  return attempt;
}

/**
 * THE FALLBACK PAIRING: retire the oldest outstanding attempt and return it.
 * Used only for an UNSTAMPED settled session — a state the host announced on
 * its own, which names no command. Null when nothing is outstanding (a state
 * change with no start behind it at all, or one the stamped answer has already
 * retired — the normal case, since that answer precedes nothing on the wire but
 * follows the host's settled state by one message).
 */
function answerOldestStartAttempt(scriptId: string): number | null {
  const queue = outstandingStarts.get(scriptId);
  if (!queue || queue.length === 0) return null;
  const attempt = queue.shift() as number;
  if (queue.length === 0) outstandingStarts.delete(scriptId);
  return attempt;
}

/**
 * Retire ONE specific attempt; true when it was still outstanding.
 *
 * The stamped answer's door (the bridge echoes the id, so this is exact), and
 * the LOCAL transport's: there a refusal is a THROW, so no broadcast will ever
 * answer the attempt and it would sit in the queue absorbing somebody else's.
 */
function finishStartAttempt(scriptId: string, attempt: number): boolean {
  const queue = outstandingStarts.get(scriptId);
  if (!queue) return false;
  const at = queue.indexOf(attempt);
  if (at < 0) return false;
  queue.splice(at, 1);
  if (queue.length === 0) outstandingStarts.delete(scriptId);
  return true;
}

/**
 * Attempts a `runAtCursor` is still WAITING on, per script, oldest first.
 *
 * The queue above tracks starts the host has not answered; this tracks starts a
 * Run has not finished waiting for, and they are not the same set. A stray
 * unstamped settled broadcast (a Debug press in another surface, a trigger-list
 * refresh on some other session) retires the oldest outstanding attempt through
 * the fallback, so the refusal that really did answer it arrives to find its id
 * no longer outstanding. Dropping it there is the silence this whole record
 * exists to stop, so a refusal whose id is no longer outstanding is still kept
 * when a Run is waiting on THAT id. Matched by id, never "the oldest Run still
 * waiting": the refusal names its attempt, so there is nothing left to guess.
 * It can only make Run more honest: `runAtCursor` reports `startRefused` only
 * when the mirror ALSO shows no SETTLED mount, so a mount that really came up is
 * never described as refused.
 */
const waitingStarts = new Map<string, number[]>();

function beginStartWait(scriptId: string, attempt: number): void {
  const queue = waitingStarts.get(scriptId) ?? [];
  queue.push(attempt);
  while (queue.length > MAX_TRACKED_STARTS) queue.shift();
  waitingStarts.set(scriptId, queue);
}

function endStartWait(scriptId: string, attempt: number): void {
  const queue = waitingStarts.get(scriptId);
  if (!queue) return;
  const at = queue.indexOf(attempt);
  if (at >= 0) queue.splice(at, 1);
  if (queue.length === 0) waitingStarts.delete(scriptId);
}

/** Whether a Run is still waiting on exactly this attempt. */
function isStartWaiting(scriptId: string, attempt: number): boolean {
  return (waitingStarts.get(scriptId) ?? []).includes(attempt);
}

/** Drop the refusal recorded for one attempt, if there is one. */
function clearStartRefusal(scriptId: string, attempt: number): void {
  const records = startRefusals.get(scriptId);
  if (!records) return;
  const at = records.findIndex((r) => r.attempt === attempt);
  if (at < 0) return;
  records.splice(at, 1);
  if (records.length === 0) startRefusals.delete(scriptId);
}

/**
 * Fold one broadcast into the mirror AND into the refusal record.
 *
 * The mirror takes EVERY broadcast — it is this window's picture of the session,
 * and a progress state is news. The start record takes only ANSWERS: see
 * `RecordedStartRefusal` for why a progress status and another command's
 * rejection are not answers, and what each of them broke when it was treated as
 * one.
 */
function observeDebugBroadcast(detail: DebugStateBroadcast): void {
  rememberSession(detail.scriptId, detail.session);
  const answer = decodeBridgeAnswer(detail);
  if (answer === null) {
    // UNSTAMPED: the host announcing state on its own. A mount that is still
    // coming up (`starting`, `running`, `detached`) has not answered anything
    // yet, and retiring an attempt on it discards the refusal that follows. A
    // SETTLED one falls back to arrival order — see `answerOldestStartAttempt`
    // for why that is normally a no-op and never records a word.
    if (!isDebugMountSettled(detail.session)) return;
    const settledAttempt = answerOldestStartAttempt(detail.scriptId);
    // A mount exists and has settled, so this attempt's refusal — if some earlier
    // broadcast managed to record one for it — is void. Only THIS attempt's:
    // another attempt's refusal is that gesture's answer, not this one's.
    if (settledAttempt !== null) clearStartRefusal(detail.scriptId, settledAttempt);
    return;
  }
  // A stamp with no usable id names a command this window cannot identify.
  // Pairing it by guess is the arrival-order rule this id replaced; it updates
  // the mirror above and touches no start.
  if (answer === "malformed") return;
  // Anything but a `start` is a different question and must not touch this
  // script's starts: a `fire` rejecting after its session auto-ended is
  // `{ session: null, error }` byte for byte like a refused mount.
  if (answer.command !== "start") return;
  // THE ANSWER NAMES ITS ATTEMPT. Retire exactly that one — whether or not it is
  // the oldest, and whether or not it is outstanding at all (an unstamped
  // settled state may already have retired it through the fallback).
  const wasOutstanding = finishStartAttempt(detail.scriptId, answer.id);
  const reason = typeof detail.error === "string" ? detail.error.trim() : "";
  if (reason === "") {
    // The bridge's SUCCESS answer: the host's start promise resolved. Whatever
    // session rides with it, this attempt was not refused, so a refusal some
    // earlier broadcast recorded under its id is void.
    clearStartRefusal(detail.scriptId, answer.id);
    return;
  }
  // A STAMPED rejection IS the refusal of that start. The session it carries is
  // whatever the host happened to hold at that instant, not evidence the mount
  // came up: a refused `start` can arrive alongside a leftover
  // `detached`/`starting` session. Judging it by the settled test dropped the
  // refusal AND left the attempt outstanding forever, so every later refused Run
  // answered the wrong attempt and reported "ran". The settled test belongs only
  // to UNSTAMPED host progress states.
  //
  // Kept when the attempt was outstanding OR a Run is waiting on that exact id;
  // with neither, there is nobody in this window it can belong to.
  if (!wasOutstanding && !isStartWaiting(detail.scriptId, answer.id)) return;
  const records = startRefusals.get(detail.scriptId) ?? [];
  records.push({ attempt: answer.id, reason });
  while (records.length > MAX_TRACKED_STARTS) records.shift();
  startRefusals.set(detail.scriptId, records);
}

/** Whether a refusal answering exactly this attempt has arrived. Does not consume. */
function hasStartRefusal(scriptId: string, attempt: number): boolean {
  return (startRefusals.get(scriptId) ?? []).some((r) => r.attempt === attempt);
}

/**
 * Read and consume the refusal recorded for ONE start attempt, if any.
 *
 * Consuming rather than peeking: a refusal answers exactly one start attempt,
 * and leaving it behind would let the next Run — which may well succeed — read
 * the previous one's reason. Matching on the attempt rather than on the script
 * is the other half of the same rule: a record stamped with a DIFFERENT attempt
 * is left where it is, so no gesture ever adopts another gesture's answer.
 */
function takeStartRefusal(scriptId: string, attempt: number): string | null {
  const records = startRefusals.get(scriptId);
  if (!records) return null;
  const at = records.findIndex((r) => r.attempt === attempt);
  if (at < 0) return null;
  const [record] = records.splice(at, 1);
  if (records.length === 0) startRefusals.delete(scriptId);
  return record.reason;
}

/**
 * Keep the mirror in step with whoever announced the change — the host itself
 * (main window) or the bridge (editor window). Registered once, at module load,
 * so `getDebugSession` is never stale for the surface that is reading it.
 *
 * Registered at module load is also what makes the refusal record RACE-PROOF:
 * the bridge's error broadcast can land while `startDebugSession` is still
 * awaiting its round trip, i.e. before `waitForDebugSettled` has installed a
 * listener of its own. This one is always already listening.
 */
if (typeof window !== "undefined") {
  onAppEvent<DebugStateBroadcast>(DebugEvents.STATE_CHANGED, (detail) => {
    if (!detail || typeof detail.scriptId !== "string") return;
    observeDebugBroadcast(detail);
  });
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
  // The FULL broadcast shape, deliberately: `error` and `command` are what the
  // start record reads, and a narrower type here would let a future edit rebuild
  // the payload from its named fields and silently drop them again.
  void listenTauriEvent<DebugStateBroadcast>(
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
 *
 * RETURNS THE ATTEMPT TOKEN. Over the remote bridge the answer to this start
 * comes back later, asynchronously, as a broadcast — and the token is the
 * command `id` that broadcast echoes, so it is what tells this start's answer
 * from the answer to a start that overlapped it. A caller that goes on to read
 * the refusal (`runAtCursor`) must pass the token it was given here; a caller
 * that only wants a session open (the Debug button) can ignore it.
 */
export async function startDebugSession(
  scriptId: string,
  options: StartDebugOptions = {},
): Promise<number> {
  const lines = getBreakpointLines(scriptId);
  const pauseOnEntry = options.pauseOnEntry === true;
  // Minted BEFORE the command leaves: the bridge's answer can land inside
  // `sendCommand`, and an answer that arrives before its attempt exists would be
  // stamped onto whatever came before it.
  const attempt = beginStartAttempt(scriptId);
  if (transport === "remote") {
    await sendCommand({
      id: attempt,
      command: "start",
      scriptId,
      lines,
      pauseOnEntry,
      fromModuleStore: options.mountFromModuleStore === true,
    });
    return attempt;
  }
  const host = await hostApi();
  try {
    if (options.mountFromModuleStore) {
      // Resolves the source itself, and is a plain `hostStartDebugSession` when
      // the id turns out to be mounted already.
      await host.hostStartModuleScriptDebugSession(scriptId, lines, { pauseOnEntry });
    } else {
      await host.hostStartDebugSession(scriptId, lines, { pauseOnEntry });
    }
  } finally {
    // Locally the host answers by RETURNING or THROWING, never by broadcasting a
    // refusal, so nothing else will ever retire this attempt.
    finishStartAttempt(scriptId, attempt);
  }
  applySessionState(scriptId, host.getDebugSession(scriptId));
  return attempt;
}

/** Stop debugging. Always resumes a paused script first. */
export async function stopDebugSession(scriptId: string): Promise<void> {
  if (transport === "remote") {
    await sendCommand({ id: nextBridgeCommandId(), command: "stop", scriptId });
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
    await sendCommand({ id: nextBridgeCommandId(), command: "control", scriptId, action });
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
    await sendCommand({ id: nextBridgeCommandId(), command: "fire", scriptId, triggerId });
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
  | { status: "notReady"; functionName: string; message: string }
  /**
   * NO SESSION WAS OPENED AT ALL — the host refused the mount and said why.
   *
   * Distinct from `notReady`, which is a statement about a mount that EXISTS.
   * "Not ready" for a script the consent gate switched off would be a lie in the
   * hopeful direction: nothing is coming, and waiting is not the remedy.
   */
  | { status: "startRefused"; functionName: string; message: string };

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
 *
 * A refusal that is ALREADY recorded ends the wait before it begins: the
 * broadcast can land while `startDebugSession` is still awaiting its round trip,
 * and waiting out a 20-second backstop for an answer that has already arrived
 * would be the same silence in slower form.
 *
 * `attempt` is THIS caller's start token, and the wait ends on a refusal only
 * when the refusal answers that token. Ending on any error broadcast at all is
 * what let two overlapping Runs both stop waiting on the FIRST refusal — one of
 * them then read no reason of its own and reported a run that never happened.
 */
async function waitForDebugSettled(
  scriptId: string,
  attempt: number,
  timeoutMs = 20000,
): Promise<void> {
  // Local transport: startDebugSession already awaited the mount before it
  // returned, so the session (and its run-targets) are settled. Only the remote
  // bridge returns before the main window has finished remounting.
  if (transport === "local") return;
  if (isDebugMountSettled(getDebugSession(scriptId))) return;
  if (hasStartRefusal(scriptId, attempt)) return;
  // Declared before the wait begins so a refusal that finds nothing outstanding
  // (something else retired the attempt) still has an asker to be delivered to.
  beginStartWait(scriptId, attempt);
  try {
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
        // broadcast; waiting out the backstop for it would only delay the
        // message. The module-level observer runs FIRST (registered at module
        // load, and DOM listeners fire in registration order), so by the time
        // this one is called the refusal has already been stamped — and only the
        // stamp that matches this attempt ends this wait.
        if (hasStartRefusal(scriptId, attempt)) {
          finish();
          return;
        }
        if (isDebugMountSettled(detail.session)) finish();
      });
      const timer = setTimeout(finish, timeoutMs);
    });
  } finally {
    endStartWait(scriptId, attempt);
  }
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
    const attempt = await startDebugSession(scriptId, options);
    await waitForDebugSettled(scriptId, attempt);
    // THE START ITSELF CAN BE REFUSED, AND OVER THE BRIDGE THAT REFUSAL IS NOT A
    // THROW. On the local transport `startDebugSession` awaits the host, so a
    // refused mount rejects and this caller never gets here. Over the bridge the
    // start is one-way: the gate's refusal comes back as a broadcast saying the
    // host has NO session for this script and why. Without consulting it, control
    // fell straight through the trigger check below (which refuses only on
    // evidence, and an empty mirror is not evidence), fired into a script that
    // was never mounted, and reported "Running x()…".
    //
    // `takeStartRefusal` is that evidence, and only that: it is set solely by a
    // broadcast that carried an error AND no session, and it is claimed by the
    // ATTEMPT TOKEN this Run's own start minted — never by script id alone, or a
    // Run that overlapped another Run (or followed a Debug press) would read an
    // answer addressed to somebody else. A mirror that is merely slow records
    // nothing, times out, and still falls through to the host — which remains
    // authoritative and refuses for itself.
    //
    // AND THE MIRROR OVERRULES IT ONLY WITH A SETTLED MOUNT. A session that is
    // still `starting` (the host announces one BEFORE it awaits the mount, so
    // the next gesture's attempt is visible here) or `detached` is not a mount
    // this Run could fire into; letting it suppress the refusal produced "not
    // registered as a run target yet — try Run again in a moment" for a script
    // the consent gate had switched off, which is the same false hope
    // `startRefused` exists to replace.
    const refusal = takeStartRefusal(scriptId, attempt);
    if (refusal && !isDebugMountSettled(getDebugSession(scriptId))) {
      return {
        status: "startRefused",
        functionName: target.name,
        message: startRefusedMessage(target.name, refusal),
      };
    }
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
    const retry = await startDebugSession(scriptId, options);
    await waitForDebugSettled(scriptId, retry);
    await fireDebugTrigger(scriptId, triggerId);
  }
  return { status: "ran", functionName: target.name };
}

/**
 * The mount was REFUSED, so nothing ran — and the gate's own words are the whole
 * point of the sentence.
 *
 * The refusals that reach here are already written for the person reading them
 * ("'SalesApp' arrived in the application … and you have not approved that
 * application's code, so it will not run. Approve the application first…"), and
 * they are the only text that names WHICH application and WHAT to do about it.
 * Summarising them into a house style would delete the remedy, which is the same
 * failure as the generic "not ready" this replaced. So the reason is passed
 * through verbatim, with only enough framing to say that Run did nothing.
 */
function startRefusedMessage(functionName: string, reason: string): string {
  return (
    `"${functionName}" did not run: the debug session could not be opened, so this ` +
    `script was never mounted. ${reason}`
  );
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
    await sendCommand({ id: nextBridgeCommandId(), command: "breakpoints", scriptId, lines });
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
    // A command with no id could be relayed but never ANSWERED — its rejection
    // would pair with nothing and a refused mount would be Run's "ran" again.
    // Both ends are this file; nothing legitimate sends one.
    if (!cmd || typeof cmd.scriptId !== "string" || typeof cmd.id !== "number") return;
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
        if (cmd.command === "start") {
          // THE SUCCESS ANSWER, and how a host-announced state gets attributed
          // to a start at all. The host's own `emitDebugState` names no command
          // — it cannot: the settled state comes from the worker's `mounted`
          // message, keyed by mount, not by whichever start asked for it — so
          // the attribution is made HERE, at the one place that awaited this
          // exact start. `hostStartDebugSession` resolves from that same
          // `mounted` message, after `noteDebugMountSettled` has already
          // broadcast the settled state, so this answer follows the host's own
          // states on the wire and carries the session as it stands. Only for
          // `start`: it is the only command a Run pairs with, and a success
          // answer for every `fire` would be a duplicate render per press.
          const answered: DebugStateBroadcast = {
            scriptId: cmd.scriptId,
            session: host.getDebugSession(cmd.scriptId),
            command: "start",
            commandId: cmd.id,
          };
          void emitTauriEvent(BRIDGE_STATE_EVENT, answered);
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
        //
        // AND IT SAYS WHICH COMMAND FAILED. This catch answers every relayed
        // command with the same shape, so a `fire` into a session that had just
        // auto-ended was indistinguishable from a refused mount: `{ session:
        // null, error }` either way. The editor window stamped that onto the
        // start it was waiting for and reported a mount that then came up
        // perfectly well as never-mounted. The command is right here; dropping
        // it is what made the two cases the same message.
        //
        // AND WHICH ONE: the command's own id, echoed. Two starts in flight are
        // two answers, and without the id the editor window paired them by
        // arrival order.
        const broadcast: DebugStateBroadcast = {
          scriptId: cmd.scriptId,
          session: host.getDebugSession(cmd.scriptId),
          error: err instanceof Error ? err.message : String(err),
          command: cmd.command,
          commandId: cmd.id,
        };
        void emitTauriEvent(BRIDGE_STATE_EVENT, broadcast);
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
