//! FILENAME: app/src/core/hooks/useMouseSelection/selection/index.ts
// PURPOSE: Public API for selection-related hooks and utilities.
// CONTEXT: Re-exports selection functionality including auto-scroll
// management and cell/header selection handlers.

export { useAutoScroll } from "./useAutoScroll";
export { createCellSelectionHandlers } from "./cellSelectionHandlers";
export { createHeaderSelectionHandlers } from "./headerSelectionHandlers";