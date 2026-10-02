//! FILENAME: app/src/shell/Announcer.tsx
// PURPOSE: The app's ONE polite live region. It is the sink behind
//          @api/announce: a feature announces a sentence, and this region
//          hands it to the screen reader.
// CONTEXT: M8 S6. Mounted exactly once, by Layout.tsx. It is visually hidden
//          (still in the accessibility tree, unlike display:none), takes no
//          layout space, is never focusable and never takes focus -- the grid
//          keeps DOM focus, so every key gate (isGridFocused, the dispatcher,
//          FloatingRange, Charts) keeps working unchanged.
//
// WHY CLEAR, THEN WRITE ONCE THE REGION HAS SETTLED
//   A live region is announced when its content CHANGES. Writing the same
//   sentence twice ("North, selected" after pressing Space twice) is no change
//   to a screen reader, so the second press would say nothing. The region is
//   therefore emptied first, and the sentence written ANNOUNCE_SETTLE_MS later.
//
//   Not on the next animation frame (M8 review, finding 2): a frame callback
//   runs in the same rendering update as the clear, BEFORE that update's
//   style, layout and accessibility pass, so the empty state never reached the
//   accessibility tree -- whether a repeat was re-spoken then depended on the
//   reader noticing a replaced text node, not on the clear. A short timeout is
//   the common live-announcer practice: the empty state is rendered for
//   several frames first.
//
//   The same delay is a TRAILING DEBOUNCE. A polite region does not interrupt:
//   it QUEUES. An OS key repeat (about 30 per second) is faster than any
//   reader, so a held arrow in a long slicer used to queue one sentence per
//   slot it passed and leave the reader seconds behind the ring. Now a new
//   announcement before the region settled REPLACES the pending one: a burst
//   is spoken once, where it stopped, ANNOUNCE_SETTLE_MS after the last key.
//   One rule for every speaker; none of them has to know about key repeat.
//
//   The text is written straight to the element rather than through React
//   state: the region renders no children, so React never reconciles its text,
//   and a key-repeat stream costs no re-render of the shell.

import React, { useEffect, useRef } from "react";
import { registerAnnouncer } from "../api/announce";

/**
 * How long the region stays EMPTY before a sentence is written (ms): longer
 * than a few frames, so the clear is rendered and seen by the accessibility
 * tree, and longer than an OS key repeat, so a held key's announcements
 * coalesce into the last one. Short enough not to feel late.
 */
export const ANNOUNCE_SETTLE_MS = 150;

/**
 * Visually hidden but present for assistive technology: 1x1 px, clipped, out
 * of the flex flow. (display:none or visibility:hidden would remove it from
 * the accessibility tree and nothing would be announced.)
 */
const VISUALLY_HIDDEN: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  border: 0,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
  pointerEvents: "none",
};

export function Announcer(): React.ReactElement {
  const regionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let pendingWrite: ReturnType<typeof setTimeout> | null = null;

    const unregister = registerAnnouncer((message) => {
      const region = regionRef.current;
      if (!region) return;
      // A newer sentence replaces one not yet written (a held key: the last wins).
      if (pendingWrite !== null) clearTimeout(pendingWrite);
      // Empty first, so the same sentence twice is still a change.
      region.textContent = "";
      pendingWrite = setTimeout(() => {
        pendingWrite = null;
        region.textContent = message;
      }, ANNOUNCE_SETTLE_MS);
    });

    return () => {
      unregister();
      if (pendingWrite !== null) clearTimeout(pendingWrite);
      pendingWrite = null;
    };
  }, []);

  return (
    <div
      ref={regionRef}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-testid="app-announcer"
      style={VISUALLY_HIDDEN}
    />
  );
}
