//! FILENAME: app/extensions/Animation/lib/documentBoundaryUnload.ts
// PURPOSE: Unload the Animation driver at every DOCUMENT boundary (open, new,
//          close) -- and make a CLOSE wait for it (E8).
// CONTEXT: A driver is bound to cells / charts / scenarios of the workbook it
//          was configured against; carrying it into a different document (or
//          into no document) leaves a transport pointing at coordinates that
//          mean something else. `clearDriver` restores first and then unloads,
//          so this is a strict superset of `stopAndRestore` -- the transient
//          guarantee is unchanged. Excel parity: File > New gives a clean
//          workbook, with no chrome carried over from the last one.
//
//          The restore is ASYNC (it writes the model back), and BEFORE_CLOSE is
//          an event nobody awaits: the close prompt's Save wrote the file the
//          moment the event returned, so a close-then-Save during playback
//          could save the TRANSIENT frame into the workbook. The close now
//          awaits the unload through a close preparation
//          (@api/lifecycleGuards), which the shell runs after BEFORE_CLOSE and
//          before it writes the file or destroys the window.

import { onAppEvent, AppEvents } from "@api/events";
import { registerClosePreparation } from "@api/lifecycleGuards";

/** What the unload needs of the playback engine. */
export interface UnloadableEngine {
  /** Restore the model, then drop the driver. */
  clearDriver(): Promise<void>;
}

/** Install the boundary unloads and the close preparation. Returns the cleanup. */
export function installDocumentBoundaryUnload(engine: UnloadableEngine): () => void {
  let unloading: Promise<void> | null = null;
  const unload = (): Promise<void> => {
    const pending = engine.clearDriver();
    unloading = pending;
    void pending
      .catch((err) => {
        console.error("[Animation] restoring the model at a document boundary failed:", err);
      })
      .finally(() => {
        if (unloading === pending) unloading = null;
      });
    return pending;
  };

  const cleanups: (() => void)[] = [];
  for (const ev of [AppEvents.BEFORE_OPEN, AppEvents.BEFORE_NEW, AppEvents.BEFORE_CLOSE]) {
    cleanups.push(
      onAppEvent(ev, () => {
        void unload();
      }),
    );
  }
  cleanups.push(
    registerClosePreparation("Animation: restore the model from the transient frame", async () => {
      // BEFORE_CLOSE normally started the unload; a close that reaches the
      // preparations without it unloads here. Either way the close waits.
      await (unloading ?? unload());
    }),
  );
  return () => {
    for (let i = cleanups.length - 1; i >= 0; i--) cleanups[i]();
  };
}
