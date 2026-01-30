//! FILENAME: app/src/api/cellEvents.ts
// PURPOSE: Public cell event API for extensions.
// CONTEXT: Extensions should import cellEvents from here instead of core/lib/cellEvents.

export { cellEvents } from "../core/lib/cellEvents";
export type { CellChangeListener } from "../core/lib/cellEvents";
