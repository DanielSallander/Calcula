// FILENAME: core/extensions/index.ts
// PURPOSE: Barrel exports for extensions module
// CONTEXT: Central export point for the extension system that allows
// extensions to register ribbon tabs, commands, and sheet customizations.

export { ExtensionRegistry } from "./ExtensionRegistry";
export * from "./ExtensionRegistry";

// Sheet extensions
export {
  sheetExtensions,
  registerCoreSheetContextMenu,
} from "./sheetExtensions";
export type {
  SheetContext,
  SheetContextMenuItem,
  SheetEventType,
  SheetEventPayload,
  SheetEventHandler,
} from "./sheetExtensions";

// Grid extensions
export {
  gridExtensions,
  registerCoreGridContextMenu,
  isClickWithinSelection,
  GridMenuGroups,
} from "./gridExtensions";
export type {
  GridMenuContext,
  GridContextMenuItem,
} from "./gridExtensions";