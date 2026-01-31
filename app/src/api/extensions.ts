//! FILENAME: app/src/api/extensions.ts
// PURPOSE: Extension system exports for add-ins.
// CONTEXT: Extensions register themselves using these APIs.

// Extension registry
export { ExtensionRegistry } from "../core/registry";
export type {
  AddInManifest,
  CommandDefinition,
  RibbonTabDefinition,
  RibbonGroupDefinition,
  RibbonContext,
} from "../core/registry";

// Grid extensions
export {
  gridExtensions,
  gridCommands,
  isClickWithinSelection,
  GridMenuGroups,
  registerCoreGridContextMenu,
} from "../core/registry";
export type { GridMenuContext, GridContextMenuItem } from "../core/registry";

// Sheet extensions
export {
  sheetExtensions,
  registerCoreSheetContextMenu,
} from "../core/registry";
export type { SheetContext, SheetContextMenuItem } from "../core/registry";

// NOTE: TaskPaneExtensions, DialogExtensions, OverlayExtensions
// are now exported from ./ui.ts for a cleaner API surface.