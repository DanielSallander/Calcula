//! FILENAME: app/src/api/extensions.ts
// PURPOSE: Extension system exports for add-ins.
// CONTEXT: Extensions register themselves using these APIs.

// Extension registry
export { ExtensionRegistry } from "../core/extensions";
export type {
  AddInManifest,
  CommandDefinition,
  RibbonTabDefinition,
  RibbonGroupDefinition,
  RibbonContext,
} from "../core/extensions";

// Grid extensions
export {
  gridExtensions,
  gridCommands,
  isClickWithinSelection,
  GridMenuGroups,
  registerCoreGridContextMenu,
} from "../core/extensions";
export type { GridMenuContext, GridContextMenuItem } from "../core/extensions";

// Sheet extensions
export {
  sheetExtensions,
  registerCoreSheetContextMenu,
} from "../core/extensions";
export type { SheetContext, SheetContextMenuItem } from "../core/extensions";

// NOTE: TaskPaneExtensions, DialogExtensions, OverlayExtensions
// are now exported from ./ui.ts for a cleaner API surface.