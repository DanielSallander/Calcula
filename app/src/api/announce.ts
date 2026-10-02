//! FILENAME: app/src/api/announce.ts
// PURPOSE: The polite screen-reader announcement seam. A feature says WHAT a
//          screen reader should hear ("Region: North, selected, 2 of 5");
//          the shell's one live region (app/src/shell/Announcer.tsx) decides
//          HOW it reaches the reader.
// CONTEXT: M8 S6 (keyboard into a selected slicer or timeline). Canvas objects
//          are not in the accessibility tree, and app/src had no aria-live
//          region: only extension-local ones (FormulaAssistPopover, the Charts
//          Data tab), each of which speaks only while its own UI is mounted. A
//          keyboard user who also uses a screen reader must hear where an inner
//          focus is, and an extension must not mount a live region of its own
//          per gesture to say so.
//
// USE, as a SPEAKER (an extension or Core-facing feature):
//
//     import { announce } from "@api/announce";
//     announce("North, selected, 2 of 5");
//
// It is POLITE: the reader finishes what it is saying first. It never moves
// DOM focus and never shows anything on screen. Announcing is fire-and-forget
// and costs nothing when no screen reader is running, so a speaker never asks
// whether anyone is listening.
//
// USE, as the SINK (the shell, once):
//
//     useEffect(() => registerAnnouncer((message) => speak(message)), []);
//
// The shape follows setSelectionRefusalAnnouncer (core/lib/selectionOwner.ts):
// ONE slot, the last registration wins. Unlike that setter, registration
// returns its own cleanup, and a cleanup only clears the slot while it still
// holds ITS registration -- so a React StrictMode remount (mount, cleanup,
// mount) or a late unmount of an old shell can never silence the new one.
//
// Deliberately NOT re-exported from @api/index.ts: callers import
// "@api/announce" directly.

/** Receives one announcement (already trimmed and non-empty). */
export type AnnouncementSink = (message: string) => void;

/**
 * The current registration. A fresh record per registerAnnouncer call, so
 * registering the SAME function twice still yields two distinguishable
 * registrations and the first one's cleanup cannot clear the second.
 */
let current: { sink: AnnouncementSink } | null = null;

/**
 * Announce a sentence politely to assistive technology.
 *
 * - An empty or whitespace-only message is ignored (it would only clear the
 *   region).
 * - With no sink registered (before the shell mounts, in unit tests) it is a
 *   no-op.
 * - A sink that throws is contained and logged: a broken announcer must never
 *   break the key handler that called this.
 */
export function announce(message: string): void {
  if (typeof message !== "string") return;
  const text = message.trim();
  if (text === "") return;
  const registration = current;
  if (!registration) return;
  try {
    registration.sink(text);
  } catch (err) {
    console.error("[announce] the announcer threw; the message was not announced:", err);
  }
}

/**
 * Register the one sink that delivers announcements. The last registration
 * wins. Returns the cleanup, which clears the slot ONLY while the slot still
 * holds this registration: a stale cleanup leaves a newer sink in place.
 */
export function registerAnnouncer(sink: AnnouncementSink): () => void {
  const registration = { sink };
  current = registration;
  return () => {
    if (current === registration) current = null;
  };
}
