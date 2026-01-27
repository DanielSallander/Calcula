//! FILENAME: app/src/core/state/index.ts
// PURPOSE: Barrel export file for state management modules.
// CONTEXT: This module re-exports all state-related exports
// for convenient importing throughout the application.

export { GridProvider, useGridContext, useGridState, useGridDispatch } from "./GridContext";
export { gridReducer, getInitialState } from "./gridReducer";
export * from "./gridActions";