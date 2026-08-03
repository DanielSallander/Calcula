//! FILENAME: app/extensions/ScriptableObjects/components/DebugPanel.tsx
// PURPOSE: The debugger's user interface, shared by both script editors (the
//          in-window dialog and the standalone editor window): the session hook,
//          the step toolbar, the locals/call-stack view, and the gutter
//          decoration model.
// CONTEXT: Everything here is a VIEW over the session state the host owns. No
//          component reaches into the script host on its own — they all go
//          through ../lib/debugger, which is the one place that knows whether
//          this window talks to the host directly or over the window bridge.

import React, { useCallback, useEffect, useMemo, useState } from "react";
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
  busy: boolean;
  error: string | null;
  toggleLine: (line: number) => void;
  start: (options?: { pauseOnEntry?: boolean }) => void;
  stop: () => void;
  send: (action: DebugAction) => void;
  /** Make one of the script's registered triggers fire (event-driven scripts). */
  fire: (triggerId: string) => void;
}

export function useDebugSession(scriptId: string | null): UseDebugSession {
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

  const start = useCallback(
    (options?: { pauseOnEntry?: boolean }) => {
      if (!scriptId) return;
      setBusy(true);
      setError(null);
      void startDebugSession(scriptId, options ?? {})
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
  const { session, isPaused, busy, start, stop, send, breakpointLines } = state;
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
    // With no breakpoint set there would be nothing to stop at, and `setup`
    // would have run to completion before the user could place one — so an
    // empty gutter means "stop on the first statement".
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
            "The script RESTARTS: it is remounted with step instrumentation, so setup() runs again.\n" +
            (onEntry
              ? "No breakpoints are set, so it will stop on the first statement."
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
      <span className={`osd-badge ${session.status}`} title={statusTitle(session)}>
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

/**
 * The badge text. THIS IS THE HONESTY SURFACE.
 *
 * "Running" used to be shown for the entire life of a session, including the
 * overwhelmingly common case where `setup` had registered a handler and
 * returned — so the user watched a motionless "Running" badge and waited for
 * work that was never going to start. Every resting state now names itself, and
 * a running one names what is running.
 */
export function statusLabel(session: DebugSessionState): string {
  switch (session.status) {
    case "paused":
      return `Paused — line ${session.paused?.line ?? "?"}`;
    case "starting":
      return "Starting…";
    case "detached":
      return "Script unmounted";
    case "waiting":
      return "Waiting for a trigger";
    case "finished":
      return "Finished";
    case "failed":
      return "setup() failed";
    case "running":
      return session.activity ? `Running ${session.activity.label}` : "Running";
    default:
      return "Running";
  }
}

function statusTitle(session: DebugSessionState): string {
  switch (session.status) {
    case "paused":
      return (
        `"${session.scriptName}" is suspended at line ${session.paused?.line}. ` +
        `The app is NOT hung: renders, saving and closing all continue to work.`
      );
    case "detached":
      return "The script was unmounted, so the session has nothing to attach to.";
    case "waiting":
      return (
        `"${session.scriptName}" is MOUNTED AND IDLE. setup() finished; nothing is ` +
        `executing. It runs again when one of its ${session.triggers.length} trigger(s) ` +
        `fires — use Fire below to make one happen from here.`
      );
    case "finished":
      return (
        `"${session.scriptName}" ran setup() to completion and registered nothing ` +
        `that can start it again. There is no more code to step through.`
      );
    case "failed":
      return `"${session.scriptName}" failed during setup(): ${session.error ?? "unknown error"}`;
    case "running":
      return session.activity
        ? `"${session.scriptName}" is executing ${session.activity.label}.`
        : `Debugging "${session.scriptName}".`;
    default:
      return `Debugging "${session.scriptName}".`;
  }
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
          setup() threw before the script could be mounted: {session.error}. Fix it and use
          Save &amp; Apply — the session stays open and the script remounts into it.
        </div>
      )}

      {session?.status === "waiting" && (
        <div style={{ color: "#B9B4FF" }}>
          Mounted and idle. setup() finished and nothing is executing — this script runs again
          only when one of the triggers below fires.
          {session.lastActivity?.error
            ? ` The last one (${session.lastActivity.label}) threw: ${session.lastActivity.error}`
            : session.lastActivity
              ? ` Last run: ${session.lastActivity.label}.`
              : ""}
        </div>
      )}

      {session?.status === "finished" && (
        <div style={{ color: "#888" }}>
          Finished. setup() ran to completion and registered no handlers and no exposed
          methods, so there is nothing left that can start this script again.
          {session.lastActivity?.error
            ? ` It threw: ${session.lastActivity.error}`
            : ""}
        </div>
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
