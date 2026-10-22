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

/**
 * The Writeback tab's accent: THE theme token behind the contextual tab's
 * colour (manifest.ts `WRITEBACK_TAB_COLOR`) and the region frame on the grid
 * (writebackOutline.ts `FRAME_ACCENT_TOKEN`), which reads as belonging to the
 * tab only while both name the same token -- so both are built from this one.
 */
export const WRITEBACK_ACCENT_TOKEN = "--tab-accent-writeback";

/** The publisher's Collected Responses pane (the review dashboard). */
export const PUBLISHER_DASHBOARD_PANE_ID = "collaboration:publisherDashboard";

/** The Designate / Edit Writeback Region dialog. */
export const DESIGNATE_WRITEBACK_DIALOG_ID = "collaboration:designateWritebackDialog";

/** Emitted after one of this workbook's own (author-side) writeback regions is
 *  added, updated or removed, so everything listing or framing them re-reads. */
export const WRITEBACK_REGIONS_CHANGED_EVENT = "collaboration:writebackRegionsChanged";

/** Emitted after Writeback > Collect From changed which streams this workbook
 *  collects, so Collected Responses (and anything else showing the choice)
 *  re-reads. */
export const WRITEBACK_COLLECTION_STREAMS_CHANGED_EVENT = "collaboration:writebackCollectionStreamsChanged";
