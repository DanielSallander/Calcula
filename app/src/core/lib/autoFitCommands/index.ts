//! FILENAME: app/src/core/lib/autoFitCommands/index.ts
// PURPOSE: Excel's AutoFit Column Width / AutoFit Row Height commands in Core
//          (the Format menu's, with the `{ growOnly }` option).

export {
  runAutoFitColumnWidth,
  runAutoFitRowHeight,
  readAutoFitArgs,
  type AutoFitArgs,
  type AutoFitCommandHost,
} from "./autoFitCommands";
