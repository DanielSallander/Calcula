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
} from "../core/hooks/useEditing";