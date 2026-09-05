//! FILENAME: app/extensions/ScriptableObjects/components/formDesigner/designerDrag.ts
// PURPOSE: What a designer drag carries, and the channel it travels on.
// CONTEXT: M5b of docs/design/typescript-forms.md §14. The gesture itself is
//          the shared one (`extensions/_shared/components/useDragDrop.ts`,
//          `useDragPayload` / `useDropTarget`) — this file only names the cargo.
//
//          TWO CARGOES, ONE CHANNEL. Adding a widget and moving one are the
//          same gesture from the user's side (pick it up, drop it where it
//          goes), and the drop target should not need to know which it is until
//          the moment it acts. So both travel as one union and the canvas
//          branches once, in one place.

import type { FormWidgetType } from "@api/scriptHost/scriptFormSpec";

import type { FormPath } from "./designerModel";

/** The channel id. Only designer targets receive designer drags. */
export const DESIGNER_DRAG_CHANNEL = "script-form-designer";

export type DesignerDrag =
  /** A new widget from the palette. */
  | { kind: "palette"; widgetType: FormWidgetType }
  /** The widget already at `path`, being moved. */
  | { kind: "move"; path: FormPath };
