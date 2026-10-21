// FILENAME: app/extensions/Collaboration/lib/writebackIds.ts
// PURPOSE: The writeback surfaces' ids, in a module that imports nothing.
// CONTEXT: manifest.ts builds the contextual Writeback tab's panel definition
//          from the sections file, and the sections' actions need the pane id.
//          Keeping the ids here (manifest.ts re-exports them) means the actions
//          never import the manifest, so the manifest -> sections -> actions
//          chain has no cycle.

/** The Writeback task pane (draft review, consent, per-region status). */
export const WRITEBACK_PANE_ID = "collaboration:writeback";

/**
 * The contextual "Writeback" ribbon tab. Deliberately NOT the menu id
 * (`WRITEBACK_MENU_ID` = "writeback"): the top-level menu and the tab share a
 * label, never an id.
 */
export const WRITEBACK_TAB_ID = "writeback-tab";
