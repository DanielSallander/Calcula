//! FILENAME: app/src/core/lib/fillCommands/index.ts
// PURPOSE: Excel's Fill Down / Right / Up / Left in Core -- the plan (which
//          cells are copied where) and the command behind the fill grid commands.

export { fillPlan, runFillCommand, type FillDirection, type FillPlan, type FillCommandHost } from "./fillCommands";
