//! FILENAME: app/src/shell/FormulaBar/referenceNavigator.ts
// PURPOSE: Register the Name Box's navigator (NameBox.navigate.ts) with
//          @api/referenceNavigation, so Excel's Go To dialog (the GoToSpecial
//          extension) navigates exactly as the Name Box does -- with or without
//          the formula bar on screen.
// CONTEXT: Home tab 2026-10-04. Installed by the FormulaBar barrel (index.ts),
//          like Insert Function, because the bar component unmounts when the
//          formula bar is hidden. Outside React, so the grid is reached through
//          the non-React dispatch bridge and the grid-state snapshot, read at
//          the moment of each navigation.

import { registerReferenceNavigator } from "../../api/referenceNavigation";
import { dispatchGridAction } from "../../api/gridDispatch";
import { getGridStateSnapshot } from "../../core/state/GridContext";
import { createReferenceNavigator } from "./NameBox.navigate";

let installed = false;

export function installReferenceNavigator(): void {
  if (installed) return;
  installed = true;
  const navigator = createReferenceNavigator({
    dispatch: dispatchGridAction,
    activeSheetIndex: () => getGridStateSnapshot()?.sheetContext.activeSheetIndex ?? 0,
  });
  registerReferenceNavigator((text) => navigator.navigate(text.trim()));
}
