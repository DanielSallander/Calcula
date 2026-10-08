//! FILENAME: app/extensions/Controls/lib/buttonActionOfControl.ts
// PURPOSE: The ONE reading of a control's declarative button action for the
//          floating store (Canvas contract §4.4): every door a button enters
//          the store by -- creation, the sheet load, a paste or duplicate, the
//          Properties pane's change event -- asks this, so they cannot disagree
//          about what counts as an action.
// CONTEXT: Its own file, importing nothing but the seam's reader, so the
//          clipboard (and its tests) can use it without pulling in the sheet
//          switch, the page history and the slicer seam that PERFORMING an
//          action needs (lib/buttonActions.ts).

import { readButtonAction, type ButtonAction, type ButtonPropertyBag } from "@api/buttonControlService";

/**
 * The action a control's properties declare, or undefined for anything that
 * is not a button, or a button without one.
 */
export function buttonActionOfControl(
  controlType: string,
  properties: ButtonPropertyBag | undefined | null,
): ButtonAction | undefined {
  if (controlType !== "button") return undefined;
  return readButtonAction(properties) ?? undefined;
}
