//! FILENAME: app/src/api/editing.ts
// PURPOSE: Editing API for shell and extensions.
// CONTEXT: Exposes editing hooks and state management through the API facade.
// Shell components should import from here instead of core/hooks/useEditing.

export {
  useEditing,
  setGlobalIsEditing,
  getGlobalIsEditing,
  getGlobalEditingValue,
  isGlobalFormulaMode,
  setGlobalCursorPosition,
  getGlobalCursorPosition,
  setChartSeriesRefMode,
  insertTextIntoActiveFormula,
} from "../core/hooks/useEditing";

// External formula edit session seam: an extension-owned editor registers
// itself to receive grid reference picks while it is expecting a reference.
export {
  registerExternalFormulaTarget,
  getExternalFormulaTarget,
} from "../core/lib/formulaEditTarget";
export type {
  ExternalFormulaTarget,
  ExternalFormulaReference,
} from "../core/lib/formulaEditTarget";
