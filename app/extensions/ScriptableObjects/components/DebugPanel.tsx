//! FILENAME: app/extensions/ScriptableObjects/components/DebugPanel.tsx
// PURPOSE: The debugger's user interface, shared by both script editors (the
//          in-window dialog and the standalone editor window): the session hook,
//          the step toolbar, the locals/call-stack view, and the gutter
//          decoration model.
// CONTEXT: Everything here is a VIEW over the session state the host owns. No
//          component reaches into the script host on its own — they all go
//          through ../lib/debugger, which is the one place that knows whether
//          this window talks to the host directly or over the window bridge.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  debugControl,
  fireDebugTrigger,
  getBreakpointLines,
  getDebugSession,
  loadPersistedBreakpoints,
  onDebugStateChange,
  startDebugSession,
  stopDebugSession,
  toggleBreakpoint,
  DebugEvents,
  type DebugAction,
  type DebugSessionState,
  type DebugTrigger,
} from "../lib/debugger";
import { onAppEvent } from "@api/events";

// ============================================================================
// Styles (injected once per window)
// ============================================================================

const STYLE_ID = "objscript-debug-styles";

export function injectDebugStyles(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .debug-paused-line {
      background: rgba(255, 196, 0, 0.16);
      border-left: 2px solid #FFC400;
    }
    .debug-paused-glyph {
      background: #FFC400;
      clip-path: polygon(0 0, 100% 50%, 0 100%);
      width: 10px !important;
      height: 12px !important;
      margin-left: 4px;
      margin-top: 4px;
    }
    .breakpoint-glyph-unverified {
      border: 1.5px solid #E51400;
      border-radius: 50%;
      width: 10px !important;
      height: 10px !important;
      margin-left: 4px;
      margin-top: 5px;
      opacity: 0.8;
    }
    .osd-badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 600;
      white-space: nowrap;
    }
    .osd-badge.paused { background: #4A3B00; color: #FFC400; }
    .osd-badge.running { background: #10331B; color: #6FD08C; }
    .osd-badge.starting { background: #26323D; color: #8CB4FF; }
    .osd-badge.waiting { background: #2A2A38; color: #B9B4FF; }
    .osd-badge.finished { background: #2B2B2B; color: #B0B0B0; }
    .osd-badge.failed { background: #3A2323; color: #FF9B9B; }
    .osd-badge.detached { background: #3A2323; color: #FF9B9B; }
    .osd-trigger-row {
      display: flex; align-items: center; gap: 8px;
      padding: 3px 6px; border-radius: 3px;
    }
    .osd-trigger-row:nth-child(odd) { background: rgba(255,255,255,0.03); }
    .osd-trigger-name {
      color: #9CDCFE; font-family: 'Cascadia Code', Consolas, monospace;
      white-space: nowrap;
    }
    .osd-trigger-desc { color: #999; flex: 1; min-width: 0; }
    .osd-trigger-fire {
      background: #2D5A3D; color: #D7F5E1; border: 1px solid #3E7A54;
      border-radius: 3px; padding: 1px 8px; font-size: 11px; cursor: pointer;
      white-space: nowrap;
    }
    .osd-trigger-fire:hover { background: #3A6E4C; }
    .osd-trigger-fire:disabled { background: #333; color: #777; border-color: #444; cursor: default; }
    .osd-dot {
      width: 7px; height: 7px; border-radius: 50%; background: currentColor;
    }
    .osd-dot.pulse { animation: osd-pulse 1.1s ease-in-out infinite; }
    @keyframes osd-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.25; } }
    .osd-var-row { display: flex; gap: 8px; padding: 2px 6px; align-items: baseline; }
    .osd-var-row:nth-child(odd) { background: rgba(255,255,255,0.03); }
    .osd-var-name { color: #9CDCFE; font-family: 'Cascadia Code', Consolas, monospace; }
    .osd-var-type { color: #808080; font-size: 10px; }
    .osd-var-value {
      color: #CE9178; font-family: 'Cascadia Code', Consolas, monospace;
      white-space: pre-wrap; word-break: break-all; flex: 1;
    }
    .osd-frame {
      padding: 2px 6px; font-family: 'Cascadia Code', Consolas, monospace;
      font-size: 11px; color: #ccc; cursor: default;
    }
    .osd-frame:hover { background: rgba(255,255,255,0.06); }
    .osd-frame-line { color: #6A9955; }
  `;
  document.head.appendChild(style);
}

// ============================================================================
// Gutter decorations
// ============================================================================

export interface DebugDecoration {
  line: number;
  glyphClassName: string;
  lineClassName?: string;
  hover: string;
}

/**
 * The gutter model. A breakpoint is VERIFIED once the worker reports that the
 * line actually carries a yield point; an unverified one is drawn hollow and
 * says why, exactly like a real debugger — never a solid dot that silently
 * never fires.
 */
export function computeDebugDecorations(
  breakpointLines: number[],
  session: DebugSessionState | null,
): DebugDecoration[] {
  const ready = session?.ready ?? null;
  const pausable = new Set(ready?.pausableLines ?? []);
  const snapshotOnly = new Set(ready?.snapshotLines ?? []);
  const out: DebugDecoration[] = [];

  for (const line of breakpointLines) {
    if (!ready) {
      out.push({
        line,
        glyphClassName: "breakpoint-glyph",
        hover: `Breakpoint at line ${line}. Start debugging to arm it.`,
      });
      continue;
    }
    if (pausable.has(line)) {
      out.push({
        line,
        glyphClassName: "breakpoint-glyph",
        hover: `Breakpoint at line ${line} — will pause.`,
      });
    } else if (snapshotOnly.has(line)) {
      out.push({
        line,
        glyphClassName: "breakpoint-glyph-unverified",
        hover:
          `Line ${line} is inside a SYNCHRONOUS function, which cannot be suspended. ` +
          `Execution will not stop; the variables at this line are reported instead. ` +
          `Make the enclosing function \`async\` to pause here.`,
      });
    } else {
      out.push({
        line,
        glyphClassName: "breakpoint-glyph-unverified",
        hover:
          `No statement starts on line ${line}, so there is nothing to stop at. ` +
          `Move the breakpoint to the first line of a statement.`,
      });
    }
  }

  const pausedLine = session?.status === "paused" ? session.paused?.line : undefined;
  if (pausedLine) {
    out.push({
      line: pausedLine,
      glyphClassName: "debug-paused-glyph",
      lineClassName: "debug-paused-line",
      hover: `Paused here (${session?.paused?.reason ?? "breakpoint"}).`,
    });
  }
  return out;
}

/** The shape of one Monaco content change this module needs. */
export interface EditorLineChange {
  range: { startLineNumber: number; endLineNumber: number };
  text: string;
}

/**
 * How far breakpoints below an edit must move. Without this a breakpoint drifts
 * onto an unrelated statement the moment the author inserts a line above it —
 * and a drifted breakpoint is worse than none, because it looks correct.
 */
export function breakpointShift(
  change: EditorLineChange,
): { fromLine: number; delta: number } | null {
  const removed = change.range.endLineNumber - change.range.startLineNumber;
  let added = 0;
  for (let i = 0; i < change.text.length; i++) {
    if (change.text[i] === "\n") added++;
  }
  const delta = added - removed;
  if (delta === 0) return null;
  return { fromLine: change.range.startLineNumber + 1, delta };
}

// ============================================================================
// Session hook
// ============================================================================

export interface UseDebugSession {
  session: DebugSessionState | null;
  breakpointLines: number[];
  decorations: DebugDecoration[];
  isPaused: boolean;
  /**
   * The open document is debugged under an INERT mount: entering the session
   * prepares the realm and executes nothing, and the user starts it with Run /
   * F5 / a Run row. True for module macros (see UseDebugSessionOptions), and it
   * is what the toolbar promises the user before they press Debug.
   */
  inertMount: boolean;
  busy: boolean;
  error: string | null;
  toggleLine: (line: number) => void;
  start: (options?: { pauseOnEntry?: boolean }) => void;
  stop: () => void;
  send: (action: DebugAction) => void;
  /** Make one of the script's registered triggers fire (event-driven scripts). */
  fire: (triggerId: string) => void;
}

/** How this document reaches a mount, for the surfaces that have no standing one. */
export interface UseDebugSessionOptions {
  /**
   * The open document is a MODULE script (a recorded macro), which is never
   * persistently mounted — buttons run it transiently per click. Debug must
   * therefore be able to ask the host to mount it from the module store, or
   * "Debug" is dead until the user runs the macro by some other route first.
   */
  mountFromModuleStore?: boolean;
}

export function useDebugSession(
  scriptId: string | null,
  options: UseDebugSessionOptions = {},
): UseDebugSession {
  const [session, setSession] = useState<DebugSessionState | null>(null);
  const [breakpointLines, setBreakpointLines] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Persisted breakpoints load once per window; the gutter re-reads when it lands.
  useEffect(() => {
    let cancelled = false;
    void loadPersistedBreakpoints().then(() => {
      if (!cancelled && scriptId) setBreakpointLines(getBreakpointLines(scriptId));
    });
    return () => {
      cancelled = true;
    };
  }, [scriptId]);

  useEffect(() => {
    setSession(scriptId ? getDebugSession(scriptId) : null);
    setBreakpointLines(scriptId ? getBreakpointLines(scriptId) : []);
    setError(null);
  }, [scriptId]);

  useEffect(() => {
    if (!scriptId) return;
    const offState = onDebugStateChange((detail) => {
      if (detail.scriptId !== scriptId) return;
      setSession(detail.session);
      setBusy(false);
      const err = (detail as { error?: string }).error;
      setError(typeof err === "string" ? err : null);
    });
    const offBps = onAppEvent<{ scriptId: string }>(DebugEvents.BREAKPOINTS_CHANGED, (detail) => {
      if (detail?.scriptId !== scriptId) return;
      setBreakpointLines(getBreakpointLines(scriptId));
    });
    return () => {
      offState();
      offBps();
    };
  }, [scriptId]);

  const toggleLine = useCallback(
    (line: number) => {
      if (!scriptId) return;
      toggleBreakpoint(scriptId, line);
      setBreakpointLines(getBreakpointLines(scriptId));
    },
    [scriptId],
  );

  // Read through a ref so `start` stays referentially stable while still using
  // the CURRENT document's mount policy — the toolbar is re-rendered on every
  // document switch and must not carry the previous document's answer.
  const mountFromModuleStore = options.mountFromModuleStore === true;
  const mountPolicyRef = useRef(mountFromModuleStore);
  mountPolicyRef.current = mountFromModuleStore;

  const start = useCallback(
    (startOptions?: { pauseOnEntry?: boolean }) => {
      if (!scriptId) return;
      setBusy(true);
      setError(null);
      void startDebugSession(scriptId, {
        pauseOnEntry: startOptions?.pauseOnEntry,
        mountFromModuleStore: mountPolicyRef.current,
      })
        .catch((e: unknown) => {
          setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => setBusy(false));
    },
    [scriptId],
  );

  const stop = useCallback(() => {
    if (!scriptId) return;
    setBusy(true);
    void stopDebugSession(scriptId)
      .catch(() => undefined)
      .finally(() => {
        setBusy(false);
        setSession(null);
      });
  }, [scriptId]);

  const send = useCallback(
    (action: DebugAction) => {
      if (!scriptId) return;
      void debugControl(scriptId, action).catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      });
    },
    [scriptId],
  );

  const fire = useCallback(
    (triggerId: string) => {
      if (!scriptId) return;
      setError(null);
      void fireDebugTrigger(scriptId, triggerId).catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      });
    },
    [scriptId],
  );

  const decorations = useMemo(
    () => computeDebugDecorations(breakpointLines, session),
    [breakpointLines, session],
  );

  return {
    session,
    breakpointLines,
    decorations,
    isPaused: session?.status === "paused",
    // Before a session exists the document's own mount policy is the answer;
    // once one is open the HOST's answer is authoritative (it built the mount).
    inertMount: session ? session.autoInvokeSetup === false : mountFromModuleStore,
    busy,
    error,
    toggleLine,
    start,
    stop,
    send,
    fire,
  };
}

// ============================================================================
// Toolbar
// ============================================================================

function Glyph({ d, size = 12 }: { d: string; size?: number }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const ICONS = {
  play: "M4 2.5v11l9-5.5-9-5.5z",
  stop: "M3.5 3.5h9v9h-9z",
  pause: "M4 3h3v10H4V3zm5 0h3v10H9V3z",
  stepOver: "M8 3a5 5 0 00-5 5H1l3 3 3-3H5a3 3 0 113 3v2a5 5 0 100-10z",
  stepInto: "M8 2v6.6L5.7 6.3 4.3 7.7 8 11.4l3.7-3.7-1.4-1.4L8 8.6V2H8zm-4 11h8v1.5H4V13z",
  stepOut: "M8 12V5.4l2.3 2.3 1.4-1.4L8 2.6 4.3 6.3l1.4 1.4L8 5.4V12zm-4 1h8v1.5H4V13z",
  bug: "M8 1a3 3 0 00-2.83 2H4.5a.5.5 0 000 1h.55A3.9 3.9 0 005 5v.5H3.5a.5.5 0 000 1H5v2H3.5a.5.5 0 000 1H5V10a3 3 0 006 0v-.5h1.5a.5.5 0 000-1H11v-2h1.5a.5.5 0 000-1H11V5c0-.35-.05-.68-.15-1h.65a.5.5 0 000-1h-.67A3 3 0 008 1z",
};

export interface DebugToolbarProps {
  state: UseDebugSession;
  /** Disabled when there is no applied script to debug. */
  disabled?: boolean;
  /** Rendered as the button class (each editor styles its own toolbar). */
  buttonClassName?: string;
  /**
   * Run-at-cursor (VBA F5): run the top-level function the cursor is in. When
   * provided, a primary "Run" button is shown to the LEFT of Debug — the VBA
   * mental model. Omitted surfaces (the in-window dialog) simply don't show it.
   */
  onRun?: () => void;
  /** Disable the Run button (e.g. unsaved edits) with an explaining title. */
  runDisabled?: boolean;
  /** Title for the Run button when disabled. */
  runDisabledTitle?: string;
}

const RUN_ICON = "M4 2.5v11l9-5.5-9-5.5z";

/**
 * The step controls. The "paused" badge is deliberately loud and animated: the
 * one failure mode a debugger must never have is looking like a hung app.
 */
export function DebugToolbar({
  state,
  disabled,
  buttonClassName = "ose-btn",
  onRun,
  runDisabled,
  runDisabledTitle,
}: DebugToolbarProps): React.ReactElement {
  const { session, isPaused, busy, start, stop, send, breakpointLines, inertMount } = state;
  const active = !!session && session.status !== "detached";

  // Run-at-cursor. Left of Debug, always available (its own gating aside): F5 in
  // VBA runs the current Sub, and CONTINUES when paused — the button here is the
  // "run" half; the F5 key does the paused→continue half in the editor.
  const runButton = onRun ? (
    <button
      className={`${buttonClassName} primary`}
      onClick={onRun}
      disabled={disabled || runDisabled}
      title={
        runDisabled && runDisabledTitle
          ? runDisabledTitle
          : "Run (F5): run the top-level function the cursor is in, exactly as the app would.\n" +
            "When paused at a breakpoint, F5 continues instead."
      }
    >
      <Glyph d={RUN_ICON} />
      Run
    </button>
  ) : null;

  if (!active) {
    // With no breakpoint set there would be nothing to stop at, so an empty
    // gutter means "stop on the first statement" — of whatever runs first. On an
    // inert mount that is the first statement the USER starts, which is the only
    // reading that makes stepping show effects landing.
    const onEntry = breakpointLines.length === 0;
    return (
      <>
        {runButton}
        <button
          className={buttonClassName}
          onClick={() => start({ pauseOnEntry: onEntry })}
          disabled={disabled || busy}
          title={
            "Start debugging this script.\n" +
            (inertMount
              ? "NOTHING RUNS: the script is prepared and instrumented, then waits. " +
                "Start it with Run (F5) or a Run/Fire row in the panel below.\n"
              : "The script RESTARTS: it is remounted with step instrumentation, so setup() runs again.\n") +
            (onEntry
              ? "No breakpoints are set, so it will stop on the first statement it executes."
              : `It will stop at your ${breakpointLines.length} breakpoint(s).`)
          }
        >
          <Glyph d={ICONS.bug} />
          Debug
        </button>
      </>
    );
  }

  return (
    <>
      {runButton}
      <span className={`osd-badge ${badgeClassFor(session)}`} title={statusTitle(session)}>
        <span className={`osd-dot${session.status === "paused" ? " pulse" : ""}`} />
        {statusLabel(session)}
      </span>
      <button
        className={buttonClassName}
        onClick={() => send(isPaused ? "continue" : "pause")}
        title={
          isPaused
            ? "Continue (F5)"
            : session.status === "waiting" || session.status === "finished"
              ? "Stop on the FIRST statement of the next execution (nothing is running right now)"
              : "Pause at the next statement"
        }
      >
        <Glyph d={isPaused ? ICONS.play : ICONS.pause} />
        {isPaused ? "Continue" : "Pause"}
      </button>
      <button
        className={buttonClassName}
        onClick={() => send("stepOver")}
        disabled={!isPaused}
        title="Step over (F10)"
      >
        <Glyph d={ICONS.stepOver} />
      </button>
      <button
        className={buttonClassName}
        onClick={() => send("stepInto")}
        disabled={!isPaused}
        title="Step into (F11)"
      >
        <Glyph d={ICONS.stepInto} />
      </button>
      <button
        className={buttonClassName}
        onClick={() => send("stepOut")}
        disabled={!isPaused}
        title="Step out (Shift+F11)"
      >
        <Glyph d={ICONS.stepOut} />
      </button>
      <button
        className={buttonClassName}
        onClick={stop}
        disabled={busy}
        title="Stop debugging — resumes the script and remounts it without instrumentation"
      >
        <Glyph d={ICONS.stop} />
        Stop
      </button>
    </>
  );
}

// ============================================================================
// Wording — hooks vs run-targets
// ============================================================================
//
// A session's triggers come in two kinds and they mean opposite things:
//   - hook   — something in the app WILL fire this (a click, an edit, a save).
//              "Waiting" is true, and naming the hook makes it useful.
//   - method — a run-target: YOU may run it again. Nothing is going to arrive.
//
// Saying "Waiting for a trigger" over a script whose only triggers are its own
// run-targets is the bug this whole feature keeps relapsing into: a recorded
// macro always carries run-targets, so the badge said "waiting" forever while
// the user sat in front of a macro that had already finished.

function hookTriggers(session: DebugSessionState): DebugTrigger[] {
  return session.triggers.filter((t) => t.kind === "hook");
}

/** "onClick", "onClick or onEdit", "one of 3 event hooks". */
function describeHooks(hooks: DebugTrigger[]): string {
  if (hooks.length === 1) return hooks[0].name;
  if (hooks.length === 2) return `${hooks[0].name} or ${hooks[1].name}`;
  return `one of its ${hooks.length} event hooks`;
}

/**
 * The badge text. THIS IS THE HONESTY SURFACE.
 *
 * "Running" used to be shown for the entire life of a session, including the
 * overwhelmingly common case where `setup` had registered a handler and
 * returned — so the user watched a motionless "Running" badge and waited for
 * work that was never going to start. Every resting state now names itself, a
 * running one names what is running, and a waiting one names WHAT IT IS WAITING
 * FOR — because if it cannot name that, it is not waiting.
 */
export function statusLabel(session: DebugSessionState): string {
  // An INERT mount (a module macro) executed nothing when the session opened, so
  // every phrase below that says or implies "setup() ran" would be false until
  // the user starts something. `lastActivity` is the proof that they have.
  const inertUnrun = session.autoInvokeSetup === false && !session.lastActivity;
  const hooks = hookTriggers(session);
  switch (session.status) {
    case "paused":
      return `Paused — line ${session.paused?.line ?? "?"}`;
    case "starting":
      return "Starting…";
    case "detached":
      return "Script unmounted";
    case "waiting":
      if (inertUnrun) return "Ready — nothing has run yet";
      // The host only ever says "waiting" when a hook exists; the fallback is
      // for a state this component did not build.
      return hooks.length > 0 ? `Waiting for ${describeHooks(hooks)}` : "Waiting for a trigger";
    case "finished":
      // A script that has NOT run yet is ready, not finished — an inert mount
      // reaches this status the moment it is prepared, because its run-targets
      // are not something that "will fire".
      if (inertUnrun) return "Ready — nothing has run yet";
      return session.lastActivity?.error ? "Finished with an error" : "Finished";
    case "failed":
      return session.autoInvokeSetup === false ? "Nothing to run" : "setup() failed";
    case "running":
      return session.activity ? `Running ${session.activity.label}` : "Running";
    default:
      return "Running";
  }
}

/**
 * The badge's colour class. Presentation only — it follows the STATUS except for
 * the one state whose word and whose mood disagree: an inert mount that has not
 * run yet is "finished" to the host (nothing will fire it) but reads as ready,
 * and greying it out would say the opposite of "press Run".
 */
export function badgeClassFor(session: DebugSessionState): string {
  const inertUnrun = session.autoInvokeSetup === false && !session.lastActivity;
  if (session.status === "finished" && inertUnrun) return "waiting";
  return session.status;
}

function statusTitle(session: DebugSessionState): string {
  const inert = session.autoInvokeSetup === false;
  const inertUnrun = inert && !session.lastActivity;
  const hooks = hookTriggers(session);
  const runTargets = session.triggers.length - hooks.length;
  switch (session.status) {
    case "paused":
      return (
        `"${session.scriptName}" is suspended at line ${session.paused?.line}. ` +
        `The app is NOT hung: renders, saving and closing all continue to work.`
      );
    case "detached":
      return "The script was unmounted, so the session has nothing to attach to.";
    case "waiting":
      return inertUnrun
        ? `"${session.scriptName}" is PREPARED AND IDLE. Entering the debugger deliberately ` +
            `ran nothing, so the sheet is untouched. Start it with Run (F5) or one of its ` +
            `${session.triggers.length} trigger(s) below, and stepping will show each effect ` +
            `land as you step.`
        : `"${session.scriptName}" is MOUNTED AND IDLE. ${inert ? "" : "setup() finished; "}` +
            `nothing is executing. It runs again when ${describeHooks(hooks)} fires — use Fire ` +
            `below to make that happen from here.`;
    case "finished":
      if (inertUnrun) {
        return (
          `"${session.scriptName}" is PREPARED AND IDLE. Entering the debugger deliberately ` +
          `ran nothing, so the sheet is untouched. Start it with Run (F5) or one of its ` +
          `${runTargets} run target(s) below, and stepping will show each effect land.`
        );
      }
      if (session.lastActivity?.error) {
        return (
          `"${session.scriptName}" finished: ${session.lastActivity.label} threw ` +
          `${session.lastActivity.error}. The session is kept open so you can fix it, set a ` +
          `breakpoint and run it again.`
        );
      }
      return (
        `"${session.scriptName}" is idle and NOTHING WILL START IT: it registered no event ` +
        `hook, so nothing in the app can fire it.` +
        (runTargets > 0
          ? ` You can run it again yourself with Run (F5) or a Run row below.`
          : ` There is no more code to step through.`)
      );
    case "failed":
      return inert
        ? `"${session.scriptName}" cannot be started from the debugger: ${session.error ?? "unknown error"}`
        : `"${session.scriptName}" failed during setup(): ${session.error ?? "unknown error"}`;
    case "running":
      return session.activity
        ? `"${session.scriptName}" is executing ${session.activity.label}.`
        : `Debugging "${session.scriptName}".`;
    default:
      return `Debugging "${session.scriptName}".`;
  }
}

/**
 * The panel's one-line explanation of an idle session ("waiting" / "finished").
 *
 * Exported for the same reason `statusLabel` is: this sentence is the thing that
 * lies when the hook/method distinction is dropped, so it is tested directly.
 */
export function idleMessage(session: DebugSessionState): string {
  const inert = session.autoInvokeSetup === false;
  const hooks = hookTriggers(session);
  const runTargets = session.triggers.length - hooks.length;
  const last = session.lastActivity;

  if (inert && !last) {
    return (
      "Prepared — nothing has run yet. Entering the debugger mounted and instrumented this " +
      "script without executing it, so the sheet is untouched. Press Run (F5) to run the " +
      "function the cursor is in, or use a Run/Fire row below; execution stops at your " +
      "breakpoints and stepping applies each effect as you step."
    );
  }
  if (last?.error) {
    // The error leads, and the session is deliberately still here: a run that
    // threw is exactly when the debugger is worth having open.
    return (
      `${last.label} stopped with an error: ${last.error} — the session is kept open on ` +
      `purpose so you can set a breakpoint and run it again.` +
      (hooks.length > 0 ? ` It also runs again when ${describeHooks(hooks)} fires.` : "")
    );
  }
  if (hooks.length > 0) {
    return (
      `Mounted and idle. ${inert ? "" : "setup() finished and "}nothing is executing — this ` +
      `script runs again when ${describeHooks(hooks)} fires.` +
      (last ? ` Last run: ${last.label}${formatDuration(last.durationMs)}.` : "")
    );
  }
  if (last) {
    return (
      `Finished. ${last.label} ran to completion${formatDuration(last.durationMs)} and nothing ` +
      `is executing. No event hook can start this script again` +
      (runTargets > 0 ? " — press Run (F5) or a Run row below to run it again." : ".")
    );
  }
  return (
    "Finished. setup() ran to completion and registered no event hook, so nothing in the app " +
    "can start this script again." +
    (runTargets > 0
      ? ` Its ${runTargets} exposed method(s) are still there for you to call from below.`
      : "")
  );
}

/**
 * The blurb's colour: red for a run that threw (the session is being kept open
 * FOR that error), lilac while a hook can still fire, grey once nothing can.
 */
function idleTone(session: DebugSessionState): string {
  if (session.lastActivity?.error) return "#FF9B9B";
  if (session.triggers.some((t) => t.kind === "hook")) return "#B9B4FF";
  if (session.autoInvokeSetup === false && !session.lastActivity) return "#B9B4FF";
  return "#888";
}

/** " in 0.4 s", or nothing when the host did not time the run. */
function formatDuration(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  return ms < 1000 ? ` in ${Math.round(ms)} ms` : ` in ${(ms / 1000).toFixed(1)} s`;
}

// ============================================================================
// Locals / call stack panel
// ============================================================================

export interface DebugPanelProps {
  state: UseDebugSession;
  /** Jump the editor to a line (call-stack frame click). */
  onRevealLine?: (line: number) => void;
}

/**
 * The trigger list — the answer to "what will make this script run?".
 *
 * Every row says what the user would do in the app to fire it for real, and
 * offers to do it from here. Without this, a script whose only entry point is
 * an event (a recorded macro on a button, a cell-edit handler) can be
 * breakpointed but never reached.
 */
function TriggerList({
  triggers,
  onFire,
  disabled,
}: {
  triggers: DebugTrigger[];
  onFire: (id: string) => void;
  disabled: boolean;
}): React.ReactElement {
  return (
    <div>
      <div style={{ color: "#888", marginBottom: 3 }}>
        Triggers ({triggers.length}) — what makes this script run. A{" "}
        <span style={{ color: "#6FD08C" }}>Run</span> row is a top-level function (F5 runs the one
        the cursor is in); a <span style={{ color: "#9CDCFE" }}>Fire</span> row is an event hook.
      </div>
      {triggers.map((t) => (
        <div className="osd-trigger-row" key={t.id}>
          <span className="osd-trigger-name">
            {t.kind === "method" ? `${t.name}()` : t.name}
          </span>
          <span className="osd-trigger-desc">{t.description}</span>
          <button
            className="osd-trigger-fire"
            onClick={() => onFire(t.id)}
            disabled={disabled || !t.fireable}
            title={
              t.fireable
                ? t.runTarget
                  ? `Run ${t.name}() now, in this debug session (the VBA-F5 gesture).`
                  : `Run the ${t.name} handler now, in this debug session, exactly as the app would.`
                : `Cannot be fired from the debugger: ${t.reason}.`
            }
          >
            {t.runTarget ? "Run" : "Fire"}
          </button>
        </div>
      ))}
    </div>
  );
}

export function DebugPanel({ state, onRevealLine }: DebugPanelProps): React.ReactElement | null {
  const { session, error, fire } = state;
  if (!session && !error) return null;

  const ready = session?.ready;
  const paused = session?.paused ?? null;
  const snapshot = session?.lastSnapshot ?? null;
  const idle = session?.status === "waiting" || session?.status === "finished";
  // See statusLabel: an inert mount ran nothing, so "setup() finished" is a lie
  // until the user has started something themselves.
  const inert = session?.autoInvokeSetup === false;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "6px 10px",
        background: "#1B1B1B",
        borderTop: "1px solid #333",
        color: "#ccc",
        fontSize: 11,
        maxHeight: 260,
        overflowY: "auto",
      }}
    >
      {error && (
        <div style={{ color: "#FF9B9B" }}>
          Debugger: {error}
        </div>
      )}

      {ready && !ready.instrumented && (
        <div style={{ color: "#FFC400" }}>
          Step debugging is unavailable for this script
          {ready.error ? `: ${ready.error}` : "."} It is running normally, un-instrumented —
          breakpoints will not pause.
        </div>
      )}

      {ready && ready.instrumented && ready.promotedFunctions.length > 0 && (
        <div style={{ color: "#6A9955" }}>
          Made awaitable for this session: {ready.promotedFunctions.join(", ")}
        </div>
      )}

      {session?.status === "running" && !paused && (
        <div style={{ color: "#888" }}>
          Running {session.activity?.label ?? "script code"}. Execution stops at the next
          breakpoint on a pausable line.
        </div>
      )}

      {session?.status === "failed" && (
        <div style={{ color: "#FF9B9B" }}>
          {inert ? (
            <>{session.error}</>
          ) : (
            <>
              setup() threw before the script could be mounted: {session.error}. Fix it and use
              Save &amp; Apply — the session stays open and the script remounts into it.
            </>
          )}
        </div>
      )}

      {idle && session && (
        // ONE blurb for both idle statuses. Which words are true depends on
        // whether a real event HOOK exists — not on how many triggers there are
        // — so the sentence is built by idleMessage rather than by the status.
        <div style={{ color: idleTone(session) }}>{idleMessage(session)}</div>
      )}

      {session && session.triggers.length > 0 && (
        // Listed whenever the session knows them; only FIREABLE while the script
        // is idle. Firing a second execution into a realm that is already
        // suspended would queue behind the pause and look like a dead button.
        <TriggerList
          triggers={session.triggers}
          onFire={fire}
          disabled={!idle}
        />
      )}

      {paused && (
        <>
          <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: "#888", marginBottom: 3 }}>
                Variables ({paused.variables.length})
              </div>
              {paused.variables.length === 0 && (
                <div style={{ color: "#666" }}>No named bindings in scope here.</div>
              )}
              {paused.variables.map((v) => (
                <div className="osd-var-row" key={v.name}>
                  <span className="osd-var-name">{v.name}</span>
                  <span className="osd-var-type">{v.type}</span>
                  <span className="osd-var-value">{v.value}</span>
                </div>
              ))}
            </div>
            <div style={{ width: 260, flexShrink: 0 }}>
              <div style={{ color: "#888", marginBottom: 3 }}>Call stack</div>
              {paused.callStack.length === 0 && (
                <div style={{ color: "#666" }}>Not available in this realm.</div>
              )}
              {paused.callStack.map((f, i) => (
                <div
                  className="osd-frame"
                  key={`${f.functionName}:${f.line}:${i}`}
                  onClick={() => f.line && onRevealLine?.(f.line)}
                  title={f.line ? `Go to line ${f.line}` : undefined}
                >
                  {f.functionName}
                  {f.line !== null && <span className="osd-frame-line"> :{f.line}</span>}
                </div>
              ))}
            </div>
          </div>
          {paused.waiting > 0 && (
            <div style={{ color: "#888" }}>
              {paused.waiting} other execution{paused.waiting === 1 ? "" : "s"} of this script
              {paused.waiting === 1 ? " is" : " are"} suspended behind this pause.
            </div>
          )}
        </>
      )}

      {!paused && snapshot && (
        <div style={{ color: "#FFC400" }}>
          Line {snapshot.line} was reached in a synchronous function — it cannot be suspended, so
          execution continued.
          {snapshot.suppressed > 0 && ` (${snapshot.suppressed} further hits collapsed.)`}
          {snapshot.variables.length > 0 && (
            <div style={{ marginTop: 3 }}>
              {snapshot.variables.map((v) => (
                <div className="osd-var-row" key={v.name}>
                  <span className="osd-var-name">{v.name}</span>
                  <span className="osd-var-type">{v.type}</span>
                  <span className="osd-var-value">{v.value}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
