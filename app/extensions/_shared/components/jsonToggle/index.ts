//! FILENAME: app/extensions/_shared/components/jsonToggle/index.ts
// PURPOSE: Shared "edit as JSON" toggle widget (button + Monaco JSON editor).
// CONTEXT: Used by multiple extensions' design tabs (Charts, Pivot, Slicer,
//   Table) and JsonView itself. Lives in _shared so extensions do not import
//   each other's internals (Independence Through Boundaries).

export { useJsonToggle } from "./useJsonToggle";
export { JsonToggleButton } from "./JsonToggleButton";
export { JsonToggleEditor } from "./JsonToggleEditor";
export { MonacoJsonEditor } from "./MonacoJsonEditor";
