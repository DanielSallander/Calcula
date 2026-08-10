//! FILENAME: app/src/api/undoState.ts
// PURPOSE: The one place any surface asks "can the user undo right now?".
// CONTEXT: Extension-facing (`@api/undoState`). Ribbon buttons, menu items and
// anything else that offers Undo/Redo binds to this instead of assuming.
//
// WHY A SHARED STORE RATHER THAN A HOOK PER CONSUMER
// --------------------------------------------------
// There are at least two consumers (the Home tab's Undo/Redo buttons and the
// Edit menu's items) and they must never disagree — a greyed ribbon button
// above an enabled menu entry for the same command is worse than either state
// alone. One subscription, one cached answer, many readers.
//
// WHY IT IS NOT A POLL
// --------------------
// The backend announces `document:undo-state-changed` from inside the undo
// store's own lock guard (`undo_history::UndoHistory`), on a real transition.
// Polling `get_undo_state` on a timer would burn IPC on a value that changes a
// handful of times a session, and re-reading it after frontend commands only
// would miss precisely the edits the frontend never saw — a script, an MCP
// tool, a `.calp` pull, a scheduled job — which is the same class of mutation
// the dirty indicator used to miss.
//
// THE SEED READ IS NOT A POLL EITHER. The first subscriber triggers one
// `getUndoState()` call, because a listener that mounts BETWEEN transitions has
// no event to learn from and must not start on a guess. After that the store
// lives on events.

import { useEffect, useState } from "react";
import { getUndoState } from "./lib";
import { AppEvents, onAppEvent } from "./events";

/** Whether undo and redo are available right now. */
export interface UndoAvailability {
  canUndo: boolean;
  canRedo: boolean;
}

/**
 * The optimistic start. Before the first answer arrives, both are enabled.
 *
 * FAIL OPEN, deliberately, and it is the same judgement the bridge makes: a
 * wrongly-ENABLED button costs a press that does nothing, which is exactly the
 * behaviour that shipped until now. A wrongly-DISABLED one takes away an undo
 * the user really has and gives them no way to argue with it.
 */
const OPTIMISTIC: UndoAvailability = { canUndo: true, canRedo: true };

let current: UndoAvailability = OPTIMISTIC;
const listeners = new Set<(next: UndoAvailability) => void>();
let unsubscribeFromBus: (() => void) | null = null;
let seeded = false;

function publish(next: UndoAvailability): void {
  if (next.canUndo === current.canUndo && next.canRedo === current.canRedo) return;
  current = next;
  for (const listener of [...listeners]) listener(current);
}

/** Read the last known availability without subscribing. */
export function getUndoAvailability(): UndoAvailability {
  return current;
}

/**
 * Subscribe to availability changes. Returns an unsubscribe function.
 *
 * The bus subscription and the seed read are installed on the FIRST subscriber
 * and torn down with the last, so a window with no Undo affordance on screen
 * costs nothing.
 */
export function subscribeToUndoAvailability(
  listener: (next: UndoAvailability) => void,
): () => void {
  listeners.add(listener);
  if (!unsubscribeFromBus) {
    unsubscribeFromBus = onAppEvent<Partial<UndoAvailability> | undefined>(
      AppEvents.UNDO_STATE_CHANGED,
      (detail) => {
        publish({
          canUndo: detail?.canUndo ?? true,
          canRedo: detail?.canRedo ?? true,
        });
      },
    );
  }
  if (!seeded) {
    seeded = true;
    void getUndoState()
      .then((state) => publish({ canUndo: state.canUndo, canRedo: state.canRedo }))
      .catch(() => {
        // No backend (test/browser context). The optimistic default stands,
        // which is the pre-existing behaviour rather than a locked-out one.
      });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && unsubscribeFromBus) {
      unsubscribeFromBus();
      unsubscribeFromBus = null;
    }
  };
}

/**
 * React binding: re-renders the caller whenever undo/redo availability moves.
 *
 * ```tsx
 * const { canUndo } = useUndoAvailability();
 * <Button disabled={!canUndo} onClick={undo}>Undo</Button>
 * ```
 */
export function useUndoAvailability(): UndoAvailability {
  const [availability, setAvailability] = useState<UndoAvailability>(getUndoAvailability);
  useEffect(() => {
    setAvailability(getUndoAvailability());
    return subscribeToUndoAvailability(setAvailability);
  }, []);
  return availability;
}

/**
 * Drop the cached answer and every subscription. TESTS ONLY — the store is a
 * module singleton, so without this one test's seed leaks into the next.
 */
export function resetUndoAvailabilityForTests(): void {
  listeners.clear();
  unsubscribeFromBus?.();
  unsubscribeFromBus = null;
  seeded = false;
  current = OPTIMISTIC;
}
