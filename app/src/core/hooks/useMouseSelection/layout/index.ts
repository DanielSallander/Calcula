// FILENAME: app/src/hooks/useMouseSelection/layout/index.ts
// PURPOSE: Public API for layout-related (resize) functionality.
// CONTEXT: Re-exports resize handlers for column width and row height
// adjustments via drag operations on header edges.

export { createResizeHandlers } from "./resizeHandlers";