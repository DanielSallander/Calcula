//! FILENAME: app/extensions/Pivot/lib/getPivotDataToggle.ts
// PURPOSE: Module-level state for the "Generate GetPivotData" toggle.
// CONTEXT: Separated from index.ts to avoid circular imports since
// PivotAnalyzeTab.tsx needs to read/write this state.

/** When true, clicking pivot cells in formula mode inserts GETPIVOTDATA */
let generateGetPivotData = true;

/** Get current state of the GETPIVOTDATA toggle */
export function isGenerateGetPivotDataEnabled(): boolean {
  return generateGetPivotData;
}

/** Set the GETPIVOTDATA toggle state */
export function setGenerateGetPivotData(enabled: boolean): void {
  generateGetPivotData = enabled;
}
