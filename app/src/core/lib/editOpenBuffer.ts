//! FILENAME: app/src/core/lib/editOpenBuffer.ts
// PURPOSE: Hold the keystrokes that arrive while the inline editor is being
//          opened by typing, so none of them are lost.
//
// THE BUG THIS EXISTS FOR
// -----------------------
// Typing into a closed cell used to commit only the LAST character:
// `type("hello")` committed "o", `type("tabbed")` committed "b".
//
// Opening the editor is not instantaneous. The grid container's keydown
// handler calls `startEditing(key)`, and that function awaits TWO IPC round
// trips (`checkEditGuards`, `getMergeInfo`) before it dispatches the editing
// state, after which React must render the editor and the editor must take
// focus. Every keystroke that lands in that window arrives at the grid
// CONTAINER, not at the editor, and the container did one of two wrong things
// with it:
//
//   Phase 1 (before the editing state exists): the container could not tell an
//     open was already in flight, so it called `startEditing(key)` AGAIN. Each
//     call dispatched a fresh replace-mode entry holding only its own single
//     character, and the last dispatch won. That is the "only the last
//     keystroke survives" symptom exactly.
//
//   Phase 2 (state exists, editor mounted, not yet focused): the container's
//     "editing is in progress, let the editor handle it" early-return dropped
//     the key on the floor, because the editor did not have focus yet.
//
// THE FIX
// -------
// A latch, engaged SYNCHRONOUSLY by the keystroke that starts the open and
// released when the editor is ready. While it is engaged the container stops
// starting new edits and stops dropping keys: it applies each key to a pending
// entry held here, in order. `startEditing` seeds the editing state from that
// pending entry instead of from its own argument (so Phase-1 characters are
// already there when the editor first renders), and any key that lands after
// that is pushed straight into the live entry by the container.
//
// Enter / Tab / Escape cannot be applied to a string, so they are latched here
// and REPLAYED by the editor through its own handlers the moment it is ready.
// That keeps "type a value and hit Enter immediately" working at speed, and
// keeps a single implementation of what those keys mean.
//
// NOT A TIMING HACK: nothing here waits for a duration to decide what to do.
// The one timer in this file is a failsafe that only fires if the editor never
// becomes ready at all (see WATCHDOG_MS) -- if it were removed, correct
// behaviour would be unchanged; only the pathological case would leak.

/** The keys that end an entry rather than change it. */
export type OpenTerminalKey = "Enter" | "Tab" | "Escape";

/** An edit-ending key pressed before the editor could receive it. */
export interface PendingTerminal {
  key: OpenTerminalKey;
  shiftKey: boolean;
}

/** The subset of a keyboard event this module reads. */
export interface OpenKeyLike {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  /** True while an IME composition is in progress. */
  isComposing?: boolean;
  /** Legacy IME signal; still the only one some WebViews set. */
  keyCode?: number;
}

/** What the caller should do with a key offered to the open window. */
export type OpenKeyOutcome =
  /** The key changed the pending entry; `value` is the entry after it. */
  | { kind: "text"; value: string }
  /** The key ends the entry and has been latched for replay. */
  | { kind: "terminal" }
  /** Not ours -- the caller must handle it exactly as it would have before. */
  | { kind: "passthrough" };

interface OpenWindow {
  /** Everything typed since the open began, in order. */
  value: string;
  /** The first edit-ending key seen, if any. */
  terminal: PendingTerminal | null;
  /** Failsafe handle; see WATCHDOG_MS. */
  watchdog: ReturnType<typeof setTimeout> | null;
}

/**
 * Failsafe only. The window is released deterministically by the editor
 * (`endEditorOpen`, called on the first pass of its focus effect whether or not
 * it actually takes focus) or by the caller when the open never started
 * (`abortEditorOpen`). This timer exists so that a latch which somehow survives
 * both -- e.g. the editor is never mounted at all -- cannot swallow the user's
 * keyboard forever. It is re-armed by every buffered key, so it can never fire
 * while someone is typing.
 */
const WATCHDOG_MS = 2000;

let openWindow: OpenWindow | null = null;

function armWatchdog(): void {
  if (!openWindow) return;
  if (openWindow.watchdog !== null) clearTimeout(openWindow.watchdog);
  openWindow.watchdog = setTimeout(() => {
    if (!openWindow) return;
    console.warn(
      "[editOpenBuffer] the inline editor never became ready; releasing the open window",
      { pending: openWindow.value, terminal: openWindow.terminal }
    );
    abortEditorOpen();
  }, WATCHDOG_MS);
}

/**
 * Engage the latch. Call this SYNCHRONOUSLY from the keystroke that starts the
 * open, before awaiting anything -- that is what makes the next keystroke see
 * an open already in flight instead of starting a second one.
 *
 * @param firstChar the character that opened the editor (already part of the entry)
 */
export function beginEditorOpen(firstChar: string): void {
  abortEditorOpen();
  openWindow = { value: firstChar, terminal: null, watchdog: null };
  armWatchdog();
}

/** True while keystrokes must be buffered rather than acted on directly. */
export function isEditorOpening(): boolean {
  return openWindow !== null;
}

/**
 * The entry accumulated so far, or null when no open is in flight.
 * `startEditing` seeds the editing state from this so that characters typed
 * during the async part of the open are already present on the first render.
 */
export function openEntryValue(): string | null {
  return openWindow ? openWindow.value : null;
}

/**
 * Apply a key that arrived during the open window.
 *
 * Text keys mutate the pending entry and are reported back so the caller can
 * push the new value into the live editing state. Enter/Tab/Escape are latched
 * for the editor to replay. Everything else is handed back untouched.
 */
export function handleKeyWhileOpening(event: OpenKeyLike): OpenKeyOutcome {
  if (!openWindow) return { kind: "passthrough" };

  // IME composition never belongs to this path: a composing keydown carries no
  // final text (the WebView reports key "Process"/keyCode 229 and delivers the
  // result later as a composition/input event on the focused element). Taking
  // it here would both mangle the entry and preventDefault the composition.
  if (event.isComposing || event.keyCode === 229) return { kind: "passthrough" };

  // Once the entry has been ended, the characters that follow belong to the
  // NEXT cell, not this one. We refuse them rather than corrupting the value
  // that is on its way to the backend.
  if (openWindow.terminal) return { kind: "passthrough" };

  const { key, ctrlKey, metaKey, altKey, shiftKey } = event;

  // Alt+Enter is a text key: it puts a line break in the entry. The caret is
  // always at the end during the open window, so appending is the whole of it.
  if (key === "Enter" && altKey && !ctrlKey && !metaKey) {
    openWindow.value += "\n";
    armWatchdog();
    return { kind: "text", value: openWindow.value };
  }

  if (key.length === 1 && !ctrlKey && !metaKey && !altKey) {
    openWindow.value += key;
    armWatchdog();
    return { kind: "text", value: openWindow.value };
  }

  if (key === "Backspace" && !ctrlKey && !metaKey && !altKey) {
    openWindow.value = openWindow.value.slice(0, -1);
    armWatchdog();
    return { kind: "text", value: openWindow.value };
  }

  // The caret sits at the end of the entry, so Delete has nothing to delete.
  // Consumed rather than passed through so it cannot reach the container's
  // "Delete clears the cell" branch and wipe the entry being typed.
  if (key === "Delete" && !ctrlKey && !metaKey && !altKey) {
    armWatchdog();
    return { kind: "text", value: openWindow.value };
  }

  if (
    (key === "Enter" || key === "Tab" || key === "Escape") &&
    !ctrlKey &&
    !metaKey &&
    !altKey
  ) {
    openWindow.terminal = { key: key as OpenTerminalKey, shiftKey };
    armWatchdog();
    return { kind: "terminal" };
  }

  return { kind: "passthrough" };
}

/**
 * Release the latch because the editor is ready (or has decided it will not
 * take focus). Returns the edit-ending key that arrived too early, if any, so
 * the caller can replay it through the editor's own handlers.
 */
export function endEditorOpen(): PendingTerminal | null {
  if (!openWindow) return null;
  const terminal = openWindow.terminal;
  if (openWindow.watchdog !== null) clearTimeout(openWindow.watchdog);
  openWindow = null;
  return terminal;
}

/**
 * Release the latch and discard everything -- the open never happened (an edit
 * guard blocked it, there was no selection, the edit ended).
 */
export function abortEditorOpen(): void {
  if (!openWindow) return;
  if (openWindow.watchdog !== null) clearTimeout(openWindow.watchdog);
  openWindow = null;
}
