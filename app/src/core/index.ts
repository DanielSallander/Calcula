//! FILENAME: app/src/core/index.ts
// PURPOSE: Barrel exports for the core module
// CONTEXT: This is the public API that shell and add-ins can use

// Extension system (for add-ins)
export * from "./registry";

// State management
export * from "./state";

// Types
export * from "./types";

// Components
export { GridCanvas } from "./components/Grid";
export { InlineEditor } from "./components/InlineEditor";
export { Spreadsheet } from "./components/Spreadsheet";

// Hooks (for advanced usage)
export * from "./hooks";

// Libraries (for advanced usage)
export * from "./lib";

// Resolve ambiguous exports between ./state, ./types, and ./lib
export { setActiveSheet, setColumnWidth, setRowHeight } from "./state";
export type { FreezeConfig, MergeResult, MergedRegion, VisibleRange, SheetContext } from "./types";
