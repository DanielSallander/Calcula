//! FILENAME: app/src/core/hooks/useMouseSelection/index.ts
// PURPOSE: Public API entry point for the useMouseSelection hook module.
// CONTEXT: This file re-exports the main hook and types, allowing external code
// to import from the folder path without breaking existing import statements.

export { useMouseSelection } from "./useMouseSelection";
export type {
  AutoScrollConfig,
  ResizeState,
  UseMouseSelectionProps,
  UseMouseSelectionReturn,
} from "./types";