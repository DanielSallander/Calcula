//! FILENAME: app/extensions/Pivot/lib/drillDispatch.ts
// PURPOSE: Decide where a pivot double-click goes — the pivot's own script, or
//          the built-in drill — and say something when the script cannot take it.
//
// WHY THIS IS ITS OWN MODULE. The decision lived inline in a 2,200-line
// `activate()` closure, where it could not be unit-tested and where getting it
// wrong was invisible. It is modelled on `Controls/lib/buttonClickDiagnosis.ts`,
// which is the same pattern for the same class of bug on buttons.
//
// THE BUG THIS FIXES (BUG-0096). The interceptor branched on
// `hasObjectScript("pivot", pivotId)` — "does this pivot have a script attached"
// — and then emitted `pivot:drillThrough` and RETURNED, skipping the built-in
// drill. But the handler side is opt-in: the forwarder is installed only when the
// script calls `pivot.onDrillThrough(...)`. So a pivot script that registers only,
// say, `onRefresh` left the emitted event with no subscriber, and because the
// interceptor had already returned, the user got **no drill, no fallback and no
// message** — a double-click that did nothing at all. The interceptor's own
// comment stated the invariant it was breaking: "so a double-click is never a
// silent no-op".
//
// WHY NOT "FALL BACK WHEN THE EVENT HAS NO SUBSCRIBER". Because it cannot be
// done: `emitAppEvent` is a bare `window.dispatchEvent(new CustomEvent(...))` and
// `onAppEvent` a bare `addEventListener`. The DOM EventTarget API exposes no
// subscriber count and no "was it handled" signal, and the forwarder never calls
// `preventDefault`. The emitter structurally cannot know. What CAN answer is the
// script host's own forwarder registry — `mountedScriptHasHook` — which is true
// only after the worker posted `hookRegistered` and the host wired the forwarder.

/** The facts the decision is derived from, supplied by the caller. */
export interface PivotDrillFacts {
  /** The pivot's configured drill behaviour: "script", "sheet", undefined, ... */
  kind: string | undefined;
  /** The object script bound to this pivot, if any. */
  script: { id: string; name: string } | null;
  /** Whether that script is currently mounted (running). */
  mounted: boolean;
  /** Whether the MOUNTED script registered a `pivot.onDrillThrough` handler. */
  handlesDrill: boolean;
}

export interface DrillDiagnosis {
  variant: "warning" | "error";
  message: string;
}

/**
 * Where the double-click goes.
 *
 * `"script"` requires ALL FOUR facts: script mode, a script that exists, mounted,
 * and a registered drill handler. Every other combination is `"builtin"` — which
 * is what makes the fallback symmetric, and the double-click never a no-op.
 */
export function decideDrillDispatch(f: PivotDrillFacts): "script" | "builtin" {
  const canTakeIt = f.kind === "script" && f.script !== null && f.mounted && f.handlesDrill;
  return canTakeIt ? "script" : "builtin";
}

/**
 * What to tell the user, or `null` for silence.
 *
 * Silent in three cases, each deliberate:
 *  - not script mode at all — the built-in drill is simply what was configured;
 *  - the script IS taking it — nothing went wrong;
 *  - script mode with NO script attached — pre-existing deliberate behaviour
 *    (the pivot is configured for a script nobody has written yet), and the
 *    built-in drill still runs, so the click is not lost.
 *
 * It speaks in the two cases where a script EXISTS and still could not take the
 * click, because those are the ones a user would otherwise experience as "the
 * feature is broken".
 */
export function diagnoseScriptDrill(f: PivotDrillFacts): DrillDiagnosis | null {
  if (f.kind !== "script") return null;
  if (decideDrillDispatch(f) === "script") return null;
  if (!f.script) return null;

  if (!f.mounted) {
    return {
      variant: "error",
      message:
        `The script "${f.script.name}" is attached to this pivot but is NOT running, ` +
        "so it cannot handle the drill-through — Script Security may have blocked it, " +
        "or it may have failed to start. Showing the built-in drill instead.",
    };
  }
  return {
    variant: "warning",
    message:
      `The script "${f.script.name}" is running, but it never registered a drill ` +
      "handler (call pivot.onDrillThrough(...) in its setup). Showing the built-in " +
      "drill instead.",
  };
}
