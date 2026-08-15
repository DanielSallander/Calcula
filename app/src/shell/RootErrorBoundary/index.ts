//! FILENAME: app/src/shell/RootErrorBoundary/index.ts
// PURPOSE: Folder-as-module entry for the root error boundary.
// CONTEXT: Imported by DEEP PATH from all five window entry points
//          (`src/main.tsx` and the four standalone editors). Deliberately NOT
//          re-exported from `src/shell/index.ts`: the standalone windows
//          document that they do not load Shell, and pulling the barrel would
//          drag the whole spreadsheet frame into the Chart Spec Editor bundle
//          for the sake of one leaf component.

export { RootErrorBoundary, formatFailureReport } from "./RootErrorBoundary";
export type { RootErrorBoundaryProps } from "./RootErrorBoundary";
