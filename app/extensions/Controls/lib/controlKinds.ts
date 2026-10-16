//! FILENAME: app/extensions/Controls/lib/controlKinds.ts
// PURPOSE: THE one table of what each control KIND is called and how it
//          behaves across Design Mode (WP-B).
// CONTEXT: Three copies of "the generic word for a control" had grown apart --
//          the paste refusal (controlClipboard.ts), the right-click menu's
//          header (ControlContextMenu.tsx) and the Name Box label
//          (controlObjectSelection.ts) -- and a new kind (the Page Navigator)
//          would have needed a fourth edit in three places. They all read this
//          table now.
//
//          NOT the Properties pane's HEADER: that keeps its own, more specific
//          wording (a shape's catalog name such as "Rectangle", and "Image").
//
//          `isDesignModeOnlyControl` is THE list of kinds that are CONTENT in
//          run mode (a press acts: a button runs, a navigator item navigates)
//          and can be SELECTED only in Design Mode. Every rule that used to say
//          `controlType === "button"` for that reason asks here instead --
//          Controls' Design-Mode click hint, the Design-Mode-ends deselect, and
//          WP-C's object-pane open policy.

import { PAGE_NAVIGATOR_CONTROL_TYPE } from "@api/buttonControlService";

/** The generic word for each known control kind. */
export const CONTROL_KIND_LABELS: ReadonlyMap<string, string> = new Map([
  ["button", "Button"],
  ["shape", "Shape"],
  ["image", "Picture"],
  [PAGE_NAVIGATOR_CONTROL_TYPE, "Page navigator"],
]);

/** What a user calls a control of `controlType`: "" -> "Control"; an unknown kind, Capitalised. */
export function controlKindLabel(controlType: string): string {
  if (controlType === "") return "Control";
  return CONTROL_KIND_LABELS.get(controlType) ?? controlType.charAt(0).toUpperCase() + controlType.slice(1);
}

/** Kinds a run-mode press ACTS on, so they are selectable only in Design Mode. */
const DESIGN_MODE_ONLY_KINDS: ReadonlySet<string> = new Set(["button", PAGE_NAVIGATOR_CONTROL_TYPE]);

/** A control that is selected only in Design Mode and is content (acts) in run mode: button | pageNavigator. */
export function isDesignModeOnlyControl(controlType: string): boolean {
  return DESIGN_MODE_ONLY_KINDS.has(controlType);
}
