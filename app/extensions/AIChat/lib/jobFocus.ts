//! FILENAME: app/extensions/AIChat/lib/jobFocus.ts
// PURPOSE: Let anything in the app say "show me the running script job", and let
//          the AI Chat pane hear it.
// CONTEXT: 2026-08-25. The status-bar indicator proved a job was alive but was
//          not a way BACK to it — the user had to find the pane, open it, and
//          switch to the guided screen by hand. Two things have to happen to
//          honour a click, and they live in different places:
//
//            1. OPEN THE PANE. Only the extension's `activate` has the
//               `ExtensionContext` that can do that, so it registers an opener
//               here at activation, the same shape `aiChatBackend.set` uses.
//            2. SWITCH THAT PANE TO THE GUIDED SCREEN. Only ChatView knows its
//               own mode, so it subscribes and flips.
//
//          Kept OUT of `authorJobs.ts` deliberately: that module is the state of
//          a run, and this is navigation. Mixing them would mean a job's data
//          could not be read without dragging in the UI's routing.

type Opener = () => void;
type FocusListener = () => void;

let opener: Opener | null = null;
const listeners = new Set<FocusListener>();

/**
 * Register the "bring the AI Chat pane up" action. Returns the unregister
 * function for the extension's cleanup list.
 *
 * Last registration wins, and unregistering only clears it if it is still the
 * one that was registered — the same rule `registerScriptEditorProvider` uses,
 * for the same reason: a re-activation must not leave a dead opener installed.
 */
export function registerJobViewOpener(next: Opener): () => void {
  opener = next;
  return () => {
    if (opener === next) opener = null;
  };
}

/**
 * Subscribe to focus requests. ChatView uses this to switch to the guided
 * screen when the user clicks the status bar.
 */
export function onJobViewRequested(listener: FocusListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Ask for the running job to be shown.
 *
 * Opens the pane FIRST, then notifies: a listener that switched mode before the
 * pane existed would be flipping a component that is about to mount fresh and
 * read its own initial state. Safe to call when nothing is registered — the
 * status bar can outlive a deactivated extension, and a click that quietly does
 * nothing beats a thrown error in the status bar.
 */
export function requestJobView(): void {
  opener?.();
  // Copied before iteration: a listener that unsubscribes while being notified
  // would otherwise mutate the set being walked.
  for (const l of [...listeners]) l();
}

/** Test hook: forget the opener and every listener. */
export function __resetJobFocus(): void {
  opener = null;
  listeners.clear();
}
