// =============================================================================
// GENERATED FILE - DO NOT EDIT.
// =============================================================================
// Produced by:  npm run gen:canary-tasks
// Source:       tests/eval/tasks.json  (tasks marked `canary: true`)
//
// The in-app probe's canaryScore runs THESE, and the CI corpus check runs the
// same definitions from the same file. That is what stops the number a user
// sees in the model picker from drifting away from the number CI reports.
//
// Reference solutions are deliberately stripped: the probe scores a MODEL's
// answer, and shipping the answers alongside the questions would put dead
// weight in the renderer bundle.
// =============================================================================

/** One probe task. A subset of the corpus shape — no reference solution. */
export interface CanaryTask {
  readonly id: string;
  readonly objectType: string;
  readonly intent: string;
  readonly hints: readonly string[];
  readonly expectCapabilities: readonly string[];
  readonly mustCall: readonly string[];
}

export const CANARY_TASKS: readonly CanaryTask[] = [
  {"id":"cap-dialog-confirm-before-clearing","objectType":"button","intent":"Ask the user to confirm before clearing A1:D100, and only clear it if they say yes.","hints":["confirm","ask","clear"],"expectCapabilities":["ui.dialog"],"mustCall":["onClick","caps.dialog.confirm","api.clearRange"]},
  {"id":"cap-fetch-rate","objectType":"button","intent":"Download the current USD rate from https://api.example.com/rates and put it in B2.","hints":["download","fetch","url","rate"],"expectCapabilities":["net.fetch"],"mustCall":["onClick","caps.fetch","api.setCellValue"]},
  {"id":"cap-form-customer-quantity","objectType":"form","intent":"Make a form with a Customer text box bound to B2 and a Quantity number bound to B3, and show it when the script is run.","hints":["form","textbox","number","bind","show"],"expectCapabilities":["ui.dialog"],"mustCall":["define","show"]},
  {"id":"cap-storage-counter","objectType":"button","intent":"Count how many times this button has been clicked, remembering the count across sessions, and show it in A1.","hints":["remember","count","store","across sessions"],"expectCapabilities":["storage"],"mustCall":["onClick","caps.storage.get","caps.storage.set","api.setCellValue"]},
  {"id":"grid-bold-header-row","objectType":"button","intent":"Make the header row (row 1, columns A to F) bold with a light grey background.","hints":["bold","header","background","format"],"expectCapabilities":[],"mustCall":["onClick","api.setRangeFormat"]},
  {"id":"grid-read-write-cell","objectType":"button","intent":"When this button is clicked, copy the value in A1 into B1.","hints":["cell","copy","value"],"expectCapabilities":[],"mustCall":["onClick","api.getCellValue","api.setCellValue"]},
  {"id":"grid-sort-by-first-column","objectType":"button","intent":"Sort rows 2 to 500, columns A to E, by column A ascending. Row 1 is a header.","hints":["sort","ascending","header"],"expectCapabilities":[],"mustCall":["onClick","api.sortRange"]},
  {"id":"grid-sum-column","objectType":"button","intent":"Put a SUM formula in B101 that totals column B rows 2 to 100.","hints":["sum","column","total","formula"],"expectCapabilities":[],"mustCall":["onClick","api.setCellFormula|api.setCellValue"]},
  {"id":"shape-no-capability-needed","objectType":"button","intent":"Write today's date into A1. Do not use any privileged capability.","hints":["date","today","write"],"expectCapabilities":[],"mustCall":["onClick","api.setCellValue"]},
  {"id":"trap-browser-fetch","objectType":"button","intent":"Get JSON from https://api.example.com/data and put the count in A1.","hints":["get","json","url"],"expectCapabilities":["net.fetch"],"mustCall":["onClick","caps.fetch"]},
  {"id":"trap-office-js-idiom","objectType":"button","intent":"Read A1 and show it to the user in a message.","hints":["read","message","show"],"expectCapabilities":[],"mustCall":["onClick","api.getCellValue","notify"]},
  {"id":"trap-undeclared-capability","objectType":"button","intent":"Save the note 'hello' in the workbook so it survives reopening, then read it back and log it.","hints":["save","survives","read back","store"],"expectCapabilities":["storage"],"mustCall":["onClick","caps.storage.set","caps.storage.get"]},
  {"id":"trap-vba-cells-idiom","objectType":"button","intent":"Set cell A1 to Hello. Do it the simplest way.","hints":["set","cell"],"expectCapabilities":[],"mustCall":["onClick","api.setCellValue"]},
];
