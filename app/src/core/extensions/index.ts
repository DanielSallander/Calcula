//! FILENAME: app/src/core/extensions/index.ts
// PURPOSE: Barrel exports for the extensions module

export { ExtensionRegistry } from "./ExtensionRegistry";
export type {
  AddInManifest,
  CommandDefinition,
  RibbonTabDefinition,
  RibbonGroupDefinition,
  RibbonContext,
} from "./ExtensionRegistry";

export { registerCoreGridContextMenu } from "./gridExtensions";
export { sheetExtensions, registerCoreSheetContextMenu } from "./sheetExtensions";
export type {
  SheetContext,
  SheetContextMenuItem,
} from "./sheetExtensions";

export { TaskPaneExtensions } from "./taskPaneExtensions";

// Grid extensions
export {
  gridExtensions,
  gridCommands,
  isClickWithinSelection,
  GridMenuGroups,
} from "./gridExtensions";
export type {
  GridMenuContext,
  GridContextMenuItem,
} from "./gridExtensions";

// Dialog extensions
export { DialogExtensions } from "./dialogExtensions";

// Overlay extensions
export { OverlayExtensions } from "./overlayExtensions";

// UI extension types - re-exported from the canonical api/uiTypes.ts contract
export type {
  TaskPaneViewDefinition,
  TaskPaneViewProps,
  TaskPaneContextKey,
  DialogDefinition,
  DialogProps,
  OverlayDefinition,
  OverlayProps,
  OverlayLayer,
  AnchorRect,
} from "../../api/uiTypes";