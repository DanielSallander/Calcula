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

// Task pane extensions
export { TaskPaneExtensions } from "../core/extensions";
export type {
  TaskPaneViewDefinition,
  TaskPaneViewProps,
  TaskPaneContextKey,
} from "../core/extensions";

// Dialog extensions
export { DialogExtensions } from "../core/extensions";
export type {
  DialogDefinition,
  DialogProps,
} from "../core/extensions";

// Overlay extensions
export { OverlayExtensions } from "../core/extensions";
export type {
  OverlayDefinition,
  OverlayProps,
  OverlayLayer,
  AnchorRect,
} from "../core/extensions";
