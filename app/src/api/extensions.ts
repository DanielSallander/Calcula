//! FILENAME: app/src/api/extensions.ts
// PURPOSE: Extension system exports for add-ins.
// CONTEXT: Extensions register themselves using these APIs.
// NOTE: Imports from shell/registries, NOT core/registry (per microkernel architecture).

// Extension registry - now from Shell
export { ExtensionRegistry } from "../shell/registries";
export type {
  AddInManifest,
  CommandDefinition,
  RibbonTabDefinition,
  RibbonGroupDefinition,
  RibbonContext,
} from "../shell/registries";

// Grid extensions - now from Shell
export {
  gridExtensions,
  gridCommands,
  isClickWithinSelection,
  GridMenuGroups,
  registerCoreGridContextMenu,
} from "../shell/registries";
export type { GridMenuContext, GridContextMenuItem } from "../shell/registries";

// Sheet extensions - now from Shell
export {
  sheetExtensions,
  registerCoreSheetContextMenu,
} from "../shell/registries";
export type { SheetContext, SheetContextMenuItem } from "../shell/registries";

// NOTE: TaskPaneExtensions, DialogExtensions, OverlayExtensions
// are now exported from ./ui.ts for a cleaner API surface.