//! FILENAME: app/extensions/Charts/lib/overlayKeys.ts
// PURPOSE: The keyboard's claim on the insight overlay — which keystrokes step
//          the points of interest on the selected chart, and when.
// CONTEXT: docs/design/insight-overlays.md §4.8a: stepping is the default and
//          the pill is the pointer's way; the arrow keys are the keyboard's.
//          The grid owns the arrow keys while a chart is selected, so this
//          claim is NARROW: only while the selected chart actually shows cues,
//          only the plain Left/Right arrows (a modifier means the grid's own
//          jump, never a step), never inside a text field. Pure, so the rule
//          is testable apart from the document listener that applies it.

export interface StepKeyEvent {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/** +1 for the next point of interest, -1 for the previous, null when the key is not ours. */
export function overlayStepDelta(e: StepKeyEvent, cueCount: number): 1 | -1 | null {
  if (cueCount <= 0) return null;
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
  if (e.key === "ArrowRight") return 1;
  if (e.key === "ArrowLeft") return -1;
  return null;
}

/** A keystroke aimed at a text field belongs to that field. */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable === true;
}
