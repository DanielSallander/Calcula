//! FILENAME: app/extensions/CanvasSheet/lib/canvasNotes.ts
// PURPOSE: What the canvas tells the user when a layout command cannot run
//          -- the Canvas tab's disabled-control tooltips and the stacking
//          service's refusal -- in one place, so every route says the same thing
//          for the same reason.

/** Why a control is disabled on a subscribed canvas, shown as its tooltip. */
export const SUBSCRIBED_NOTE =
  "This canvas comes from an application, so its layout is the publisher's. Detach the sheet to change it.";

/** Why an Arrange control is disabled with nothing selected. */
export const NOTHING_SELECTED_NOTE = "Select one or more objects on the page first.";
