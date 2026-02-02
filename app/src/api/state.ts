//! FILENAME: app/src/api/state.ts
// PURPOSE: Public state API for extensions and shell.
// CONTEXT: Extensions and shell should import grid state hooks and action creators
// from here instead of directly from core/state internals.
// UPDATED: Removed Find actions - Find state now lives in the FindReplaceDialog extension.

// Grid context hooks
export {
  useGridContext,
  useGridState,
  useGridDispatch,
} from "../core/state/GridContext";

// Grid action creators used by extensions and shell
// NOTE: Find actions removed - use useFindStore from FindReplaceDialog extension instead
export {
  setSelection,
  scrollToCell,
  setFreezeConfig,
  setSheetContext,
  setActiveSheet,
} from "../core/state/gridActions";