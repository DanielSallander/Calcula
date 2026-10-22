// FILENAME: app/extensions/Collaboration/lib/collectedResponsesFocus.ts
// PURPOSE: Which region Collected Responses should show when it is opened FOR
//          one region -- Writeback > Collected Responses with the cursor in the
//          second of several designated regions must show THAT region's inbox,
//          not whichever the list happens to put first.
// CONTEXT: The pane and the ribbon tab are both this extension's, so this is a
//          module of the extension, not an @api seam. A request is consumed by
//          the pane when it (re)loads its list, so a later reload never
//          overrides a region the publisher picked by hand.

let requested: string | null = null;
const listeners = new Set<(regionId: string) => void>();

/** Ask Collected Responses to show `regionId` (null clears a pending ask). An
 *  open pane switches at once; a pane opened next picks it up on load. */
export function focusCollectedResponsesRegion(regionId: string | null): void {
  requested = regionId;
  if (regionId === null) return;
  for (const listener of [...listeners]) listener(regionId);
}

/** The region asked for and not yet shown, consumed by this call. */
export function takeCollectedResponsesFocus(): string | null {
  const id = requested;
  requested = null;
  return id;
}

/** Follow asks made while the pane is open. Returns the unsubscribe. */
export function onCollectedResponsesFocus(listener: (regionId: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
