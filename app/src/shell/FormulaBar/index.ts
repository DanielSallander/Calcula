//! FILENAME: app/src/shell/FormulaBar/index.ts
// PURPOSE: Barrel export for FormulaBar components
// CONTEXT: Importing this barrel also INSTALLS Insert Function (its host in the
//          shell frame, and the core.formula.insertFunction command Shift+F3
//          and AutoSum > More Functions... run) and the reference navigator
//          Excel's Go To dialog uses (@api/referenceNavigation). Here and not in
//          the FormulaBar component, because the component unmounts when the
//          formula bar is hidden and both must keep working then; the shell's
//          Layout imports this barrel whatever the bar's visibility. See
//          insertFunctionHost.tsx and referenceNavigator.ts.

import { installInsertFunction } from "./insertFunctionHost";
import { installReferenceNavigator } from "./referenceNavigator";

installInsertFunction();
installReferenceNavigator();

export { FormulaBar } from "./FormulaBar";
export { NameBox } from "./NameBox";
export { FormulaInput } from "./FormulaInput";
export { InsertFunctionDialog } from "./InsertFunctionDialog";
export { openInsertFunction, InsertFunctionHost } from "./insertFunctionHost";
