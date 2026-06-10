//! FILENAME: app/src/shell/registries/index.ts
// PURPOSE: Barrel exports for the shell registries module
// CONTEXT: All extension registries now live in Shell per microkernel architecture.
//          The Core is kept "dumb" regarding extensions; Shell owns extension hosting.
// NOTE: These are the IMPLEMENTATIONS. Extensions should import from api/ layer instead.

// Extension Registry (Shell implementation)
export { ExtensionRegistry } from "./ExtensionRegistry";
export type {
  AddInManifest,
  CommandDefinition,
  RibbonTabDefinition,
  RibbonGroupDefinition,
  RibbonContext,
} from "./ExtensionRegistry";

// Grid extensions (Shell implementation)
export {
  gridExtensions,
  registerCoreGridContextMenu,
  GridMenuGroups,
} from "./gridExtensions";
export type {
  GridMenuContext,
  GridContextMenuItem,
} from "./gridExtensions";

// Re-export core primitives that gridExtensions uses
export { gridCommands, isClickWithinSelection } from "../../core/lib/gridCommands";

// Sheet extensions (Shell implementation)
export { sheetExtensions, registerCoreSheetContextMenu } from "./sheetExtensions";
export type {
  SheetContext,
  SheetContextMenuItem,
} from "./sheetExtensions";

// TaskPane extensions (Shell implementation)
export { TaskPaneExtensions } from "./taskPaneExtensions";

// Dialog extensions (Shell implementation)
export { DialogExtensions } from "./dialogExtensions";

// Overlay extensions (Shell implementation)
export { OverlayExtensions } from "./overlayExtensions";

// Panel Registry (Shell implementation - location-agnostic panels)
export { panelRegistry } from "./panelRegistry";
export { usePanelPlacementStore } from "./usePanelPlacementStore";

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
  PanelDefinition,
  PanelPlacement,
  PanelViewProps,
} from "../../api/uiTypes";