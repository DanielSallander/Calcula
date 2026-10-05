//! FILENAME: app/src/api/formatPainterState.ts
// PURPOSE: The one place any surface asks "is the Format Painter on right now,
//          and is it locked?".
// CONTEXT: Extension-facing (`@api/formatPainterState`). Home tab = Excel's
//          Home tab (contract 6.6, 2026-10-04). Excel draws the Format Painter
//          button PRESSED while the painter is armed -- after a click until
//          the paint, after a double-click until Escape or another click on
//          the button. The state lived inside the FormatPainter extension
//          (`isFormatPainterActive`, its own module) with no event and no @api
//          route, so the ribbon could not show it, and a ribbon that imported
//          the extension would break the Facade Rule.
//
// WHO WRITES, WHO READS
// ---------------------
// The FormatPainter extension is the only WRITER: every transition of its own
// state (armed, upgraded to locked, stopped -- by a paint, Escape, the button,
// deactivation) goes through `publishFormatPainterState`. Everything else
// READS: the Home tab's button, and any menu or status surface that wants to
// show the same thing. One cached answer, many readers -- the shape of
// @api/undoState, without its backend seed: this state is born in the
// frontend, so there is nothing to ask before the first transition, and the
// start (OFF) is simply true.
//
// A LOCK IS A KIND OF ON. `{ active: false, locked: true }` is not a state the
// painter can be in; a publish of it is stored as OFF, so a reader never has
// to wonder what a locked-but-inactive painter would look like.

import { useEffect, useState } from "react";

/** Whether the Format Painter is armed, and whether it stays armed after a paint. */
export interface FormatPainterState {
  /** The painter is armed: the next selection receives the copied formatting. */
  active: boolean;
  /** Locked (Excel's double-click): it stays armed after each paint. Never true while `active` is false. */
  locked: boolean;
}

const OFF: FormatPainterState = { active: false, locked: false };

let current: FormatPainterState = OFF;
const listeners = new Set<(next: FormatPainterState) => void>();

/** Read the painter's state without subscribing. */
export function getFormatPainterState(): FormatPainterState {
  return current;
}

/**
 * Subscribe to the painter's transitions. Returns an unsubscribe function.
 * A listener is called only when the state actually changes.
 */
export function subscribeToFormatPainterState(
  listener: (next: FormatPainterState) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Publish the painter's state. THE WRITER IS THE FORMATPAINTER EXTENSION; a
 * reader that publishes would draw a button pressed over a painter that is
 * not armed. A repeat of the current state is silent; a listener that throws
 * is logged and the rest are still told.
 */
export function publishFormatPainterState(next: FormatPainterState): void {
  const normalized: FormatPainterState = next.active ? { active: true, locked: next.locked } : OFF;
  if (normalized.active === current.active && normalized.locked === current.locked) return;
  current = normalized;
  for (const listener of [...listeners]) {
    try {
      listener(current);
    } catch (err) {
      console.error("[formatPainterState] listener threw:", err);
    }
  }
}

/**
 * React binding: re-renders the caller whenever the painter is armed,
 * upgraded to locked, or stopped.
 *
 * ```tsx
 * const { active, locked } = useFormatPainterState();
 * <CommandButton active={active} ... />
 * ```
 */
export function useFormatPainterState(): FormatPainterState {
  const [state, setState] = useState<FormatPainterState>(getFormatPainterState);
  useEffect(() => {
    // A transition between the render and this effect would otherwise be
    // missed until the next one.
    setState(getFormatPainterState());
    return subscribeToFormatPainterState(setState);
  }, []);
  return state;
}

/**
 * Back to OFF with no subscribers. TESTS ONLY -- the store is a module
 * singleton, so without this one test's painter leaks into the next.
 */
export function resetFormatPainterStateForTests(): void {
  listeners.clear();
  current = OFF;
}
