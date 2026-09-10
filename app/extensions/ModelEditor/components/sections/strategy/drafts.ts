// FILENAME: app/extensions/ModelEditor/components/sections/strategy/drafts.ts
// PURPOSE: The per-connection memory of an unsaved strategy draft.
// CONTEXT: Implements property (3): the tab UNMOUNTS on every section switch,
//          so a naive re-infer on each mount would silently throw away
//          confirmations nobody had saved. Keyed by connectionId and consulted
//          ONLY on the no-stored-document path. See the numbered list in
//          ../StrategySection.tsx.

import type { StrategyDoc } from "../../../lib/strategyTypes";

// ===========================================================================

/**
 * The unsaved draft for each connection.
 *
 * The tab is unmounted on every section switch, so without this the mount
 * effect would re-infer and the user's unsaved confirmations would vanish
 * between two clicks with no message and no undo. A STORED document always
 * wins — this is read only when the model has none, and is never merged over
 * one.
 */
export const unsavedDrafts = new Map<string, StrategyDoc>();

/** Drop every remembered draft. Exists so a test can start from a cold cache;
 *  the map is module state and would otherwise leak between cases. */
export function forgetUnsavedDrafts(): void {
  unsavedDrafts.clear();
}


// ===========================================================================
// Rule drafts (the modal's editable shape) and the guard that accepts one
