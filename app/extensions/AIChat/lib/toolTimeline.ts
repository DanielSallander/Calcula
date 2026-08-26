//! FILENAME: app/extensions/AIChat/lib/toolTimeline.ts
// PURPOSE: The transcript's state machine — every tool call is one bubble that
//          goes running -> done or running -> error, with a duration and a
//          one-line result. Pure, so it can be tested without jsdom.
// CONTEXT: Reported 2026-08-22: "you just see an empty field and you have no idea
//          where the progress is at the moment."
//
//          WHAT THE TRANSCRIPT DID BEFORE. Bubbles were append-only `{kind,text}`
//          strings. Three consequences, all of them the same bug:
//            * `toolCallStarted` appended "read_cell_range…" and the dispatch
//              loop appended `read_cell_range({...})` a moment later — TWO
//              bubbles for one call, neither of which ever resolved. The ellipsis
//              stayed on screen forever, so a finished call and a hung one looked
//              identical.
//            * A tool that THREW produced no bubble at all. The error went into
//              the model's tool result and the user saw nothing — so the loop
//              could burn all eight turns failing, in silence.
//            * Nothing recorded how long anything took, which is the one number
//              that distinguishes "the local model is slow" from "this is stuck".
//
//          WHY A REDUCER AND NOT setState CALLBACKS INLINE. ChatView.tsx has no
//          test coverage of any kind — no unit test imports it and no E2E journey
//          drives it. Putting the state machine here means the part that can be
//          wrong is the part that is tested, and the component keeps only the
//          wiring. Every function below returns a NEW array; none mutates its
//          argument, so React's identity check sees the change.

/**
 * What a transcript entry is.
 *
 * `notice` is a neutral status line and `error` is a failure. `warning` is the
 * third thing that actually happens and had nowhere to go: the run SUCCEEDED and
 * the user must still act, or the result is worthless. A draft that only runs at
 * the Unlocked tier is the case that forced it — mounted as-is it does nothing at
 * all, and saying so in grey italics beside "3 charts" buries it.
 */
export type BubbleKind = "user" | "assistant" | "tool" | "error" | "notice" | "warning";

export type ToolState = "running" | "done" | "error";

export interface Bubble {
  kind: BubbleKind;
  text: string;
  /**
   * Correlates a tool bubble across its lifetime.
   *
   * The provider's own call id where there is one, so the `toolCallStarted`
   * stream event and the dispatch loop land on the SAME bubble. A salvaged call
   * has no provider id and gets a synthetic one — see `ChatView`.
   */
  toolId?: string;
  state?: ToolState;
  /** Wall-clock duration of the call, once it has finished. */
  ms?: number;
  /** A short excerpt of the tool's result, or the error text. */
  detail?: string;
  /**
   * Set when this call produced a script draft. Drives the "Open in editor"
   * button, which is what makes the draft reachable after its editor window has
   * been closed.
   */
  draftId?: string;
  /** True when the model wrote this call as prose and it was recovered. */
  salvaged?: boolean;
}

/** ASCII only — CLAUDE.md bans Unicode in this kind of output. */
export function stateMarker(state: ToolState | undefined): string {
  switch (state) {
    case "done": return "[OK]";
    case "error": return "[!]";
    case "running": return "[..]";
    default: return "";
  }
}

/** `1.4s` / `320ms` — a duration a person can read at a glance. */
export function formatMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * The single line a tool bubble renders.
 *
 * One line, always, whatever state it is in — a bubble that changes height as it
 * resolves makes the log jump under the reader.
 */
export function formatToolBubble(b: Bubble): string {
  const marker = stateMarker(b.state);
  const dur = formatMs(b.ms);
  const head = [marker, b.text].filter(Boolean).join(" ");
  const tail = [dur, b.detail].filter(Boolean).join(" - ");
  return tail ? `${head}  ${tail}` : head;
}

function replaceAt(bubbles: readonly Bubble[], index: number, next: Bubble): Bubble[] {
  const out = bubbles.slice();
  out[index] = next;
  return out;
}

function indexOfTool(bubbles: readonly Bubble[], toolId: string): number {
  // Searched from the END: the same tool can legitimately be called twice in one
  // conversation, and the live one is always the most recent.
  for (let i = bubbles.length - 1; i >= 0; i--) {
    if (bubbles[i].kind === "tool" && bubbles[i].toolId === toolId) return i;
  }
  return -1;
}

/**
 * Announce a call. Idempotent by `toolId`.
 *
 * Idempotence is the whole point: `toolCallStarted` arrives from the stream and
 * the dispatch loop reaches the same call a moment later, and BOTH used to
 * append. Calling this twice with one id updates the label instead of doubling
 * the bubble.
 */
export function startTool(
  bubbles: readonly Bubble[],
  toolId: string,
  text: string,
  opts: { salvaged?: boolean } = {},
): Bubble[] {
  const at = indexOfTool(bubbles, toolId);
  if (at === -1) {
    return [...bubbles, { kind: "tool", text, toolId, state: "running", ...opts }];
  }
  const existing = bubbles[at];
  // A finished call is never reopened — a late duplicate announcement must not
  // turn a completed line back into a spinner.
  if (existing.state !== "running") return bubbles.slice();
  return replaceAt(bubbles, at, { ...existing, text, ...opts });
}

/** Mark a call finished. A call that was never announced is created finished. */
export function finishTool(
  bubbles: readonly Bubble[],
  toolId: string,
  patch: { ms?: number; detail?: string; draftId?: string; text?: string } = {},
): Bubble[] {
  const at = indexOfTool(bubbles, toolId);
  if (at === -1) {
    return [...bubbles, { kind: "tool", text: patch.text ?? toolId, toolId, state: "done", ...patch }];
  }
  return replaceAt(bubbles, at, { ...bubbles[at], state: "done", ...patch });
}

/**
 * Mark a call failed.
 *
 * Distinct from appending an `error` bubble: the failure belongs ON the call it
 * describes, so the transcript reads as a list of steps with outcomes rather
 * than a list of steps followed by a list of unattributed complaints.
 */
export function failTool(
  bubbles: readonly Bubble[],
  toolId: string,
  message: string,
  ms?: number,
): Bubble[] {
  const detail = truncate(message, 200);
  const at = indexOfTool(bubbles, toolId);
  if (at === -1) {
    return [...bubbles, { kind: "tool", text: toolId, toolId, state: "error", detail, ms }];
  }
  return replaceAt(bubbles, at, { ...bubbles[at], state: "error", detail, ms });
}

/**
 * Any call still marked running becomes an error.
 *
 * Called in the send path's `finally`. Without it, a turn that throws between
 * announcing a call and dispatching it leaves a `[..]` on screen for the rest of
 * the session — a permanent claim that something is still happening.
 */
export function settleRunning(bubbles: readonly Bubble[], message: string): Bubble[] {
  let changed = false;
  const out = bubbles.map((b) => {
    if (b.kind !== "tool" || b.state !== "running") return b;
    changed = true;
    return { ...b, state: "error" as const, detail: truncate(message, 200) };
  });
  return changed ? out : bubbles.slice();
}

/**
 * One line, capped at `max` INCLUDING the ellipsis. Tool results can be an
 * entire sheet summary; a bubble is one line.
 */
export function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  if (max <= 3) return oneLine.slice(0, max);
  return `${oneLine.slice(0, max - 3)}...`;
}

/**
 * The draft id out of `draft_object_script`'s result text.
 *
 * The result is built in `mcp/drafts.rs` as `Drafted object script "X"
 * (id=draft-abc) for button.` — matching it here is a cross-language coupling
 * and it is the WEAKER of the two routes on purpose: `ChatView` prefers the
 * `mcp:script-draft` event, which carries the id as data, and falls back to this
 * only when no event arrived. Returns null rather than guessing.
 */
export function draftIdFromResult(result: string): string | null {
  const m = /\(id=(draft-[0-9a-fA-F]+)\)/.exec(result);
  return m ? m[1] : null;
}
