//! FILENAME: app/extensions/pivot/lib/pivotEvents.ts
// PURPOSE: Pivot-specific event constants.
// CONTEXT: Extension-defined events that are NOT part of the Core event system.
// Uses the generic emitAppEvent/onAppEvent from the API with custom strings.

export const PivotEvents = {
  /** Emitted after a new pivot table is created */
  PIVOT_CREATED: "app:pivot-created",
  /** Emitted when pivot regions are updated (added/removed/changed) */
  PIVOT_REGIONS_UPDATED: "app:pivot-regions-updated",
  /** Emitted to open the filter dropdown menu for a pivot field */
  PIVOT_OPEN_FILTER_MENU: "app:pivot-open-filter-menu",
  /** Emitted to open the header filter dropdown (Row Labels / Column Labels) */
  PIVOT_OPEN_HEADER_FILTER_MENU: "app:pivot-open-header-filter-menu",
  /** Emitted by the PivotEditor to broadcast current layout state to the Design tab */
  PIVOT_LAYOUT_STATE: "app:pivot-layout-state",
  /** Emitted by the Design tab when the user changes a layout option */
  PIVOT_LAYOUT_CHANGED: "app:pivot-layout-changed",
  /** Emitted by the Design tab on mount to request the PivotEditor re-broadcast layout state */
  PIVOT_REQUEST_LAYOUT: "app:pivot-request-layout",
  /** Emitted when filter values are applied via the filter dropdown */
  PIVOT_FILTER_APPLIED: "app:pivot-filter-applied",
  /**
   * Emitted whenever a pivot's VIEW is replaced by a fresh backend response —
   * a field change, a filter, a sort, a group toggle, whichever path asked.
   * Payload `{ pivotId, version }`. `PIVOT_REGIONS_UPDATED` fires only when the
   * region SYNC runs, which the API paths (a filter applied by a script or a
   * test) never trigger; anything that must follow a pivot's cells listens
   * here. Found live by the insight overlay, whose cue stayed in the column a
   * filtered-out category had vacated.
   */
  PIVOT_VIEW_UPDATED: "app:pivot-view-updated",
  /**
   * A value-field modal (Value Field Settings / Number Format) was requested
   * for a pivot -- by the value-cell context menu, through
   * `requestValueFieldDialog` (Pivot/lib/valueFieldDialogRequest.ts). Payload
   * `{ pivotId, valueFieldIndex, dialog }`. The listener lives INSIDE the
   * PivotEditor component, which takes the pending request and opens the
   * modal, wherever the editor is mounted.
   */
  PIVOT_OPEN_VALUE_FIELD_DIALOG: "app:pivot-open-value-field-dialog",
  /**
   * A pivot's FIELDS were changed by a door other than the field-list editor --
   * the value-cell menu's Remove / Summarize Values By / Show Values As
   * (Pivot/lib/valueFieldEdits.ts) or a header's Remove "<field>". Payload
   * `{ pivotId }`. An open editor re-seeds its zones from the definition
   * (usePivotEditorState): every editor request REPLACES the zones, so a stale
   * editor's next edit would otherwise send the old fields back (BUG-0466).
   */
  PIVOT_FIELDS_EDITED_ELSEWHERE: "app:pivot-fields-edited-elsewhere",
  /** Emitted by the backend during long-running pivot operations (Tauri event) */
  PIVOT_PROGRESS: "pivot:progress",
} as const;

export type PivotEventType = (typeof PivotEvents)[keyof typeof PivotEvents];

/** Payload for pivot:progress Tauri events from the backend. */
export interface PivotProgressEvent {
  pivotId: string;
  stage: string;
  stageIndex: number;
  totalStages: number;
}
