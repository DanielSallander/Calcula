//! FILENAME: app/src/api/scriptHost/worker/debugRuntime.ts
// PURPOSE: The in-realm half of step-through debugging (task H1). The object
//          the instrumented source calls at every yield point: it decides
//          whether to suspend, builds the bounded snapshot the editor renders,
//          and resumes when the host says so.
//
// CONTEXT: A yield point is `await __calculaDbg.h(line, localsThunk)` in an
//          async context and `__calculaDbg.s(line, localsThunk)` in a
//          synchronous one. The async form can genuinely SUSPEND (the returned
//          promise is not settled until the user continues); the synchronous
//          form can only report, because suspending synchronous JS would mean
//          blocking the worker's message loop — and a realm that cannot read
//          its own port can never be told to resume. We do not do that.
//
// SECURITY: this object grants NOTHING. It reads bindings the script already
//          holds, stringifies them inside the realm, and posts previews. It
//          exists only in a mount the user explicitly opened a debug session
//          on; a script has no way to create one, and no way to observe one it
//          is not in beyond the pause itself.
//
// NON-WEDGE RULE: `beginNoPause()/endNoPause()` marks regions the host is
//          actively waiting on with a short deadline (cell/bitmap rendering).
//          A yield point inside one never suspends — it degrades to a report —
//          so a paused debug session can never stall the grid.

import {
  DEBUG_MAX_STACK_FRAMES,
  DEBUG_SNAPSHOT_MIN_INTERVAL_MS,
  DEBUG_VALUE_PREVIEW_CHARS,
  type DebugAction,
  type DebugFrame,
  type DebugPauseState,
  type DebugSpec,
  type DebugVariable,
  type W2H,
} from "../protocol";

type Post = (msg: W2H) => void;
type LocalsThunk = () => DebugVariable[] | null;

/** The shape the instrumented source calls into. Kept to 1-char names: it is
 *  emitted once per statement, and the emitted text is part of the script. */
export interface DebugRuntimeApi {
  /** Pausable yield point (async context). */
  h(line: number, locals: LocalsThunk): Promise<void> | void;
  /** Report-only yield point (synchronous context — cannot suspend). */
  s(line: number, locals: LocalsThunk): void;
  /** Build the variable list from [name, getter] pairs. */
  p(pairs: Array<[string, () => unknown]>): DebugVariable[];
}

export interface DebugController extends DebugRuntimeApi {
  setBreakpoints(lines: number[]): void;
  control(action: DebugAction): void;
  /** Enter a region where suspension is forbidden (host is waiting on us). */
  beginNoPause(): void;
  endNoPause(): void;
  /**
   * Enter a region where yield points do NOTHING AT ALL — no pause, no snapshot.
   *
   * Used for the module-body evaluation of an INERT debug mount. The instrumenter
   * puts a yield point in front of every top-level statement, including the
   * `function foo(...)` declarations a recorded macro is made of, so without this
   * a session opened with `pauseOnEntry` (which is what an empty gutter means)
   * would stop on line 1 DURING THE MOUNT — reporting "Paused — line 1" for a
   * mount that deliberately executed nothing, which is the same lie in a new
   * place. A breakpoint parked on a declaration line would do the same.
   *
   * Distinct from beginNoPause: that one DEGRADES a pause to a snapshot report,
   * which is right for a render on a deadline and wrong here — nothing the user
   * asked for is running, so there is nothing to report.
   */
  beginInert(): void;
  endInert(): void;
  /** True while at least one execution is suspended at a yield point. */
  isPaused(): boolean;
  /** Release everything and disarm — the session is over. */
  dispose(): void;
}

type Mode = "run" | "stepInto" | "stepOver" | "stepOut" | "pauseNext";

/** Values that are cheap and safe to preview verbatim. */
function previewOf(v: unknown): { type: string; value: string } {
  if (v === null) return { type: "null", value: "null" };
  if (v === undefined) return { type: "undefined", value: "undefined" };
  const t = typeof v;
  if (t === "string") {
    const s = v as string;
    return { type: "string", value: JSON.stringify(clip(s)) };
  }
  if (t === "number" || t === "boolean" || t === "bigint") {
    return { type: t, value: String(v) };
  }
  if (t === "symbol") return { type: "symbol", value: String(v) };
  if (t === "function") {
    const name = (v as { name?: string }).name;
    return { type: "function", value: `function ${name || "(anonymous)"}()` };
  }
  if (Array.isArray(v)) {
    let body: string;
    try {
      body = v
        .slice(0, 12)
        .map((x) => shallow(x))
        .join(", ");
    } catch {
      body = "…";
    }
    return { type: "array", value: clip(`[${body}${v.length > 12 ? `, …${v.length} items` : ""}]`) };
  }
  // Plain-ish object: one shallow level, own enumerable keys only.
  try {
    const keys = Object.keys(v as object).slice(0, 12);
    const body = keys.map((k) => `${k}: ${shallow((v as Record<string, unknown>)[k])}`).join(", ");
    const ctor = (v as { constructor?: { name?: string } }).constructor?.name;
    const label = ctor && ctor !== "Object" ? `${ctor} ` : "";
    return { type: "object", value: clip(`${label}{${body}}`) };
  } catch {
    return { type: "object", value: "[object]" };
  }
}

function shallow(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  const t = typeof v;
  if (t === "string") return JSON.stringify(clip(v as string, 40));
  if (t === "number" || t === "boolean" || t === "bigint") return String(v);
  if (t === "function") return "ƒ";
  if (Array.isArray(v)) return `Array(${v.length})`;
  if (t === "object") return "{…}";
  return String(v);
}

function clip(s: string, max = DEBUG_VALUE_PREVIEW_CHARS): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

interface RawFrame {
  functionName: string;
  /** Location minus the trailing `:line:col` — identifies the SOURCE. */
  file: string;
  line: number | null;
}

function splitFrames(stack: string): RawFrame[] {
  const out: RawFrame[] = [];
  for (const raw of stack.split("\n")) {
    const text = raw.trim();
    if (!text.startsWith("at ")) continue;
    const body = text.slice(3);
    let functionName: string;
    let loc: string;
    const paren = body.lastIndexOf(" (");
    if (paren >= 0 && body.endsWith(")")) {
      functionName = body.slice(0, paren);
      loc = body.slice(paren + 2, body.length - 1);
    } else {
      functionName = "(anonymous)";
      loc = body;
    }
    const m = /:(\d+):(\d+)$/.exec(loc);
    out.push({
      functionName: functionName.replace(/^async\s+/, "").trim() || "(anonymous)",
      file: m ? loc.slice(0, loc.length - m[0].length) : loc,
      line: m ? Number(m[1]) : null,
    });
  }
  return out;
}

/**
 * The frames that belong to the USER'S SCRIPT.
 *
 * The script is a separate blob module; this runtime lives in the worker
 * bundle. So the leading frames (this file, and the shim bootstrap installs)
 * all share one source, and the first frame with a DIFFERENT source is the
 * script statement that hit the yield point. Everything from there on with that
 * same source is the script's own call stack; host and platform frames below it
 * are not the author's business and are dropped.
 *
 * Counting raw `at ` lines instead would be worthless: the number of host
 * frames under an async continuation swings wildly between two consecutive
 * statements, which would make step-over stop at the wrong place.
 */
function scriptFrames(stack: string | undefined): RawFrame[] {
  if (!stack) return [];
  const frames = splitFrames(stack);
  if (frames.length === 0) return [];
  const runtimeFile = frames[0].file;
  let i = 0;
  while (i < frames.length && frames[i].file === runtimeFile) i++;
  if (i >= frames.length) return [];
  const scriptFile = frames[i].file;
  const out: RawFrame[] = [];
  for (let j = i; j < frames.length && out.length < DEBUG_MAX_STACK_FRAMES; j++) {
    if (frames[j].file === scriptFile) out.push(frames[j]);
  }
  return out;
}

/**
 * Parse a captured stack into the frames the editor shows.
 *
 * The script's blob is line-aligned with the author's source (instrumentation
 * is line-preserving and the module wrapper adds no newline), so the reported
 * line IS the line in the editor.
 */
export function parseStack(stack: string | undefined): DebugFrame[] {
  return scriptFrames(stack).map((f) => ({ functionName: f.functionName, line: f.line }));
}

/** Where an execution is: which script function, and how deep. */
interface FramePosition {
  fn: string;
  depth: number;
}

/**
 * The current position in the SCRIPT's own call stack.
 *
 * Depth alone is not enough. Once an async function suspends at an `await`, V8
 * stops showing its caller, so the depth reported for the statement AFTER an
 * await is lower than for the statement before it — inside the very same
 * function. Step-over therefore compares the FUNCTION as well as the depth,
 * which is what makes "run the callee to completion, then stop" work across the
 * awaits our own yield points introduce.
 */
function framePosition(): FramePosition {
  const frames = scriptFrames(new Error().stack);
  return { fn: frames[0]?.functionName ?? "", depth: frames.length };
}

export function createDebugRuntime(spec: DebugSpec, post: Post): DebugController {
  const breakpoints = new Set<number>(spec.breakpoints.filter((n) => Number.isInteger(n) && n > 0));
  let mode: Mode = spec.pauseOnEntry ? "pauseNext" : "run";
  let armed = breakpoints.size > 0 || mode !== "run";
  let disposed = false;
  let noPauseDepth = 0;
  /** >0 while an inert region is open — see DebugController.beginInert. */
  let inertDepth = 0;
  /** Position captured at the current pause — the base for step-over/step-out. */
  let basePosition: FramePosition = { fn: "", depth: 0 };
  let sawFirstPause = false;

  /** Resolvers of every execution currently suspended at a yield point. */
  let waiters: Array<() => void> = [];
  let paused = false;
  /** The announced pause, re-posted when another execution joins behind it. */
  let pauseState: DebugPauseState | null = null;

  let lastSnapshotAt = 0;
  let suppressedSnapshots = 0;

  // Deeper stacks than V8's default 10 frames — the call-stack view is one of
  // the two things a step debugger is FOR. Realm-local; affects nothing outside.
  try {
    (Error as unknown as { stackTraceLimit?: number }).stackTraceLimit = DEBUG_MAX_STACK_FRAMES + 8;
  } catch {
    /* not configurable on this engine */
  }

  const reArm = (): void => {
    armed = !disposed && (breakpoints.size > 0 || mode !== "run");
  };

  const releaseAll = (): void => {
    const pending = waiters;
    waiters = [];
    paused = false;
    pauseState = null;
    for (const resolve of pending) {
      try {
        resolve();
      } catch {
        /* a resolver never throws, but never let one stop the others */
      }
    }
  };

  const safeLocals = (locals: LocalsThunk): DebugVariable[] => {
    try {
      return locals() ?? [];
    } catch {
      return [];
    }
  };

  const shouldPause = (line: number): boolean => {
    if (mode === "pauseNext" || mode === "stepInto") return true;
    if (mode === "stepOver") {
      const p = framePosition();
      // Back in the function we stepped from (or above it) — never inside a
      // callee, however that callee's frames happen to unwind across awaits.
      return p.fn === basePosition.fn ? p.depth <= basePosition.depth : p.depth < basePosition.depth;
    }
    if (mode === "stepOut") {
      const p = framePosition();
      return p.fn !== basePosition.fn && p.depth <= basePosition.depth;
    }
    return breakpoints.has(line);
  };

  const reasonFor = (line: number): DebugPauseState["reason"] => {
    if (mode === "pauseNext") return sawFirstPause ? "pause" : "entry";
    if (mode !== "run") return breakpoints.has(line) ? "breakpoint" : "step";
    return "breakpoint";
  };

  const api: DebugController = {
    h(line, locals) {
      if (!armed || disposed || inertDepth > 0) return;
      if (paused) {
        // Another execution is already stopped. Join it rather than announcing
        // a second pause: concurrent hook dispatches must not race the editor
        // into an inconsistent "which line am I on" state.
        const joined = new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
        if (pauseState) {
          pauseState = { ...pauseState, waiting: waiters.length - 1 };
          post({ t: "debugPaused", state: pauseState });
        }
        return joined;
      }
      if (noPauseDepth > 0) {
        // The host is waiting on a bounded deadline (render). Report, continue.
        api.s(line, locals);
        return;
      }
      if (!shouldPause(line)) return;

      const reason = reasonFor(line);
      sawFirstPause = true;
      mode = "run";
      paused = true;
      basePosition = framePosition();
      pauseState = {
        line,
        reason,
        variables: safeLocals(locals),
        callStack: parseStack(new Error().stack),
        waiting: 0,
      };
      post({ t: "debugPaused", state: pauseState });
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },

    s(line, locals) {
      if (!armed || disposed || inertDepth > 0) return;
      if (mode === "run" && !breakpoints.has(line)) return;
      const now = Date.now();
      if (now - lastSnapshotAt < DEBUG_SNAPSHOT_MIN_INTERVAL_MS) {
        suppressedSnapshots++;
        return;
      }
      lastSnapshotAt = now;
      const suppressed = suppressedSnapshots;
      suppressedSnapshots = 0;
      post({
        t: "debugSnapshot",
        state: { line, variables: safeLocals(locals), suppressed },
      });
    },

    p(pairs) {
      const out: DebugVariable[] = [];
      for (const [name, get] of pairs) {
        try {
          const { type, value } = previewOf(get());
          out.push({ name, type, value });
        } catch (err) {
          // Temporal dead zone, a throwing getter, or a name the scanner
          // attributed to the wrong scope. Say so instead of losing the frame.
          out.push({
            name,
            type: "unavailable",
            value: err instanceof Error && /before initialization/.test(err.message)
              ? "<not yet initialized>"
              : "<unavailable>",
          });
        }
      }
      return out;
    },

    setBreakpoints(lines) {
      breakpoints.clear();
      for (const n of lines) {
        if (Number.isInteger(n) && n > 0) breakpoints.add(n);
      }
      reArm();
    },

    control(action) {
      if (disposed) return;
      switch (action) {
        case "continue":
          mode = "run";
          break;
        case "stepInto":
          mode = "stepInto";
          break;
        case "stepOver":
          mode = "stepOver";
          break;
        case "stepOut":
          mode = "stepOut";
          break;
        case "pause":
          mode = "pauseNext";
          break;
        case "stop":
          api.dispose();
          return;
      }
      reArm();
      if (paused) {
        releaseAll();
        post({ t: "debugResumed" });
      }
    },

    beginNoPause() {
      noPauseDepth++;
    },
    endNoPause() {
      if (noPauseDepth > 0) noPauseDepth--;
    },

    beginInert() {
      inertDepth++;
    },
    endInert() {
      if (inertDepth > 0) inertDepth--;
    },

    isPaused() {
      return paused;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      mode = "run";
      breakpoints.clear();
      armed = false;
      const wasPaused = paused;
      releaseAll();
      if (wasPaused) post({ t: "debugResumed" });
    },
  };

  return api;
}
