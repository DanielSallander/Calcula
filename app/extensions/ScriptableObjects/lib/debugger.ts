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

export type { DebugSessionState, DebugTrigger, DebugAction };

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
  | { command: "start"; scriptId: string; lines: number[]; pauseOnEntry: boolean }
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

const breakpoints = new Map<string, Breakpoint[]>();
let loadPromise: Promise<void> | null = null;
let loaded = false;

function toLines(bps: Breakpoint[]): number[] {
  return bps.filter((bp) => bp.enabled).map((bp) => bp.line);
}

/**
 * Load the workbook's persisted breakpoints. Idempotent; safe to call from
 * every surface that shows a gutter.
 */
export function loadPersistedBreakpoints(): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const data = await getExtensionData<PersistedDebugState>(DEBUG_EXTENSION_DATA_ID);
      if (data && data.breakpoints && typeof data.breakpoints === "object") {
        for (const [scriptId, lines] of Object.entries(data.breakpoints)) {
          if (!Array.isArray(lines)) continue;
          const clean = [...new Set(lines.filter((n) => Number.isInteger(n) && n > 0))].sort(
            (a, b) => a - b,
          );
          if (clean.length === 0) continue;
          breakpoints.set(
            scriptId,
            clean.map((line) => ({ scriptId, line, enabled: true })),
          );
        }
      }
    } catch {
      // A workbook with no stored debug state is the normal case; a backend
      // that refuses to answer must not stop the editor from opening.
    } finally {
      loaded = true;
      for (const [scriptId, bps] of breakpoints) {
        emitAppEvent(DebugEvents.BREAKPOINTS_CHANGED, { scriptId, breakpoints: bps });
      }
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
  const ids = [...breakpoints.keys()];
  breakpoints.clear();
  loadPromise = null;
  loaded = false;
  for (const scriptId of ids) {
    emitAppEvent(DebugEvents.BREAKPOINTS_CHANGED, { scriptId, breakpoints: [] });
  }
  return loadPersistedBreakpoints();
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced write-back. Breakpoints are user state, not document content —
 *  they go in via the plain (non-undoable) extension-data write. */
function persistBreakpoints(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const payload: PersistedDebugState = { breakpoints: {} };
    for (const [scriptId, bps] of breakpoints) {
      const lines = toLines(bps);
      if (lines.length > 0) payload.breakpoints[scriptId] = lines;
    }
    void setExtensionData(DEBUG_EXTENSION_DATA_ID, payload).catch(() => {
      /* best effort — a breakpoint that fails to persist still works this session */
    });
  }, 400);
}

/** Get all breakpoints for a script. */
export function getBreakpoints(scriptId: string): Breakpoint[] {
  return breakpoints.get(scriptId) ?? [];
}

/** Enabled breakpoint lines for a script. */
export function getBreakpointLines(scriptId: string): number[] {
  return toLines(getBreakpoints(scriptId));
}

function commit(scriptId: string, bps: Breakpoint[]): Breakpoint[] {
  if (bps.length === 0) breakpoints.delete(scriptId);
  else breakpoints.set(scriptId, bps);
  emitAppEvent(DebugEvents.BREAKPOINTS_CHANGED, { scriptId, breakpoints: bps });
  persistBreakpoints();
  // A live session takes new breakpoints immediately — no remount, no restart.
  if (getDebugSession(scriptId)) {
    void sendBreakpoints(scriptId, toLines(bps));
  }
  return bps;
}

/** Toggle a breakpoint on a line. Returns the updated breakpoints. */
export function toggleBreakpoint(scriptId: string, line: number): Breakpoint[] {
  const bps = breakpoints.get(scriptId) ?? [];
  const existing = bps.find((bp) => bp.line === line);
  const next = existing
    ? bps.filter((bp) => bp.line !== line)
    : [...bps, { scriptId, line, enabled: true }].sort((a, b) => a.line - b.line);
  return commit(scriptId, next);
}

/** Clear all breakpoints for a script. */
export function clearBreakpoints(scriptId: string): void {
  commit(scriptId, []);
}

/** Clear every breakpoint in the workbook. */
export function clearAllBreakpoints(): void {
  const ids = [...breakpoints.keys()];
  breakpoints.clear();
  for (const scriptId of ids) {
    emitAppEvent(DebugEvents.BREAKPOINTS_CHANGED, { scriptId, breakpoints: [] });
  }
  persistBreakpoints();
}

/**
 * Re-anchor breakpoints after an edit that moved lines.
 *
 * `delta` is applied to every breakpoint at or after `fromLine`; breakpoints on
 * deleted lines are dropped. Without this a breakpoint drifts onto an unrelated
 * statement the moment the author inserts a line above it.
 */
export function shiftBreakpoints(scriptId: string, fromLine: number, delta: number): Breakpoint[] {
  const bps = breakpoints.get(scriptId);
  if (!bps || bps.length === 0 || delta === 0) return bps ?? [];
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
  return commit(scriptId, deduped);
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
  options: { pauseOnEntry?: boolean } = {},
): Promise<void> {
  const lines = getBreakpointLines(scriptId);
  if (transport === "remote") {
    await sendCommand({
      command: "start",
      scriptId,
      lines,
      pauseOnEntry: options.pauseOnEntry === true,
    });
    return;
  }
  const host = await hostApi();
  await host.hostStartDebugSession(scriptId, lines, options);
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
            await host.hostStartDebugSession(cmd.scriptId, cmd.lines ?? [], {
              pauseOnEntry: cmd.pauseOnEntry === true,
            });
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
        // says the session did not open, rather than leaving it spinning.
        void emitTauriEvent(BRIDGE_STATE_EVENT, {
          scriptId: cmd.scriptId,
          session: null,
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
