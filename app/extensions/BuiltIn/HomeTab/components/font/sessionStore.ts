//! FILENAME: app/extensions/BuiltIn/HomeTab/components/font/sessionStore.ts
// PURPOSE: A tiny session-long value with subscribers: what an Excel split
//          button REMEMBERS between clicks -- the kind of underline its face
//          applies, the border its face re-applies, the line colour and line
//          style the border presets draw with, the colour on a Fill / Font
//          Color bar.
// CONTEXT: Excel keeps each of these for the session, per button, and NOT per
//          workbook or per control instance: pick Double Underline, open
//          another workbook, and the face still says double. So the value
//          lives at module level, outside React, and every rendered copy of
//          the button reads the same one -- the Home group can be drawn in the
//          ribbon band AND in a collapsed group's launcher flyout at once, and
//          a choice made in one must show in the other on the next render.
//          `useSessionValue` is React's useSyncExternalStore over it, so a
//          change re-renders every mounted copy and nothing else.
//
//          Deliberately NOT persisted (no localStorage, no document state):
//          Excel forgets all of these when it closes, and a remembered face
//          that survived a restart would apply a colour the user can no
//          longer see having picked.

import { useSyncExternalStore } from "react";

/** One remembered value. `reset` exists for tests: every test starts from
 *  Excel's own defaults, never from what an earlier test picked. */
export interface SessionValue<T> {
  get(): T;
  set(next: T): void;
  subscribe(listener: () => void): () => void;
  reset(): void;
}

/** A session value starting at `initial`. Setting an identical value (by
 *  `Object.is`) notifies nobody, so a click that picks what is already
 *  remembered re-renders nothing. */
export function createSessionValue<T>(initial: T): SessionValue<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of Array.from(listeners)) listener();
  };
  return {
    get: () => value,
    set(next: T) {
      if (Object.is(next, value)) return;
      value = next;
      notify();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset() {
      if (Object.is(value, initial)) return;
      value = initial;
      notify();
    },
  };
}

/** The current value, re-rendering when it changes. */
export function useSessionValue<T>(store: SessionValue<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
