//! FILENAME: app/src/api/layout/index.ts
// PURPOSE: Barrel export for the surface-layout system (@api/layout).
// CONTEXT: Extensions compose panel sections from these primitives; the same
//          JSX renders horizontally in the ribbon band and vertically in the
//          sidebar. Content with no horizontal form (ItemList/Tall/Gallery)
//          gets a Launcher flyout in the band — so ANY panel is placeable on
//          EITHER surface with no per-extension layout code.

export {
  useSurfaceLayout,
  SurfaceLayoutProvider,
  DEFAULT_SURFACE_LAYOUT,
  bandLayout,
  panelLayout,
  popoverLayout,
} from "./context";
export type {
  SurfaceLayout,
  SurfaceOrientation,
  SurfaceContainer,
} from "./context";

export * from "./tokens";

export { Launcher } from "./primitives/Launcher";
export type { LauncherProps } from "./primitives/Launcher";

export {
  Group,
  Stack,
  ControlRow,
  ControlGrid,
  ControlGridBreak,
  Grow,
  ActionRow,
  StatusText,
} from "./primitives/containers";
export type {
  GroupProps,
  StackProps,
  ControlRowProps,
  ControlGridProps,
  ActionRowProps,
} from "./primitives/containers";

export { Field, FieldGrid } from "./primitives/fields";
export type { FieldProps, FieldGridProps } from "./primitives/fields";

export { ItemList, Tall, Gallery } from "./primitives/blocks";
export type { ItemListProps, TallProps, GalleryProps } from "./primitives/blocks";

export { Button, ToggleButton, CommandButton } from "./primitives/Button";
export type {
  LayoutButtonProps,
  ToggleButtonProps,
  CommandButtonProps,
} from "./primitives/Button";

export { Input } from "./primitives/Input";
export type { LayoutInputProps } from "./primitives/Input";

export { Select } from "./primitives/Select";
export type { LayoutSelectProps } from "./primitives/Select";

export { Popover } from "./primitives/Popover";
export type { PopoverProps } from "./primitives/Popover";
