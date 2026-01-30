//! FILENAME: app/src/api/state.ts
// PURPOSE: Public state API for extensions.
// CONTEXT: Extensions should import grid state hooks and action creators from here
// instead of directly from core/state internals.

// Grid context hook
export { useGridContext } from "../core/state/GridContext";

// Grid action creators used by extensions
export {
  setSelection,
  scrollToCell,
  setFindResults,
  setFindCurrentIndex,
  closeFind,
  setFindOptions,
} from "../core/state/gridActions";
