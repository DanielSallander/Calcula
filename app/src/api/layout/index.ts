//! FILENAME: app/src/api/layout/index.ts
// PURPOSE: Barrel export for the surface-layout system (@api/layout).
// CONTEXT: Extensions compose panel sections from these primitives; the same
//          JSX renders horizontally in the ribbon band and vertically in the
//          sidebar. Content with no horizontal form (ItemList/Tall/Gallery)
//          gets a Launcher flyout in the band — so ANY panel is placeable on
//          EITHER surface with no per-extension layout code.
//
//          This is also THE control grammar of the Calcula Clusters redesign
//          (docs/design/ribbon-design-system.md): every button, pill, menu,
//          dropdown, toggle, chip, slider, colour picker, tile and gallery the
//          ribbon, sidebar and flyouts show is exported from here, so a
//          third-party extension that composes from this barrel gets the same
//          look as a built-in without writing a line of CSS.

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

/** The token table every primitive paints with (var(--token, lightFallback)). */
export { LT } from "./theme";
export type { LayoutThemeKey } from "./theme";

/** Test helper: hardcoded colour literals in a rendered subtree. */
export { findHardcodedColours } from "./testing";

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

export { Field, FieldGrid, NumberField, NUMBER_FIELD_WIDTH } from "./primitives/fields";
export type { FieldProps, FieldGridProps, NumberFieldProps } from "./primitives/fields";

export { ItemList, Tall, Gallery } from "./primitives/blocks";
export type { ItemListProps, TallProps, GalleryProps } from "./primitives/blocks";

export {
  Button,
  ToggleButton,
  IconButton,
  CommandButton,
  DropdownChevron,
} from "./primitives/Button";
export type {
  LayoutButtonProps,
  ToggleButtonProps,
  IconButtonProps,
  IconButtonSize,
  CommandButtonProps,
} from "./primitives/Button";

export { Tooltip } from "./primitives/Tooltip";
export type { TooltipProps, TooltipPlacement } from "./primitives/Tooltip";

export { Badge } from "./primitives/Badge";
export type { BadgeProps, BadgeTone } from "./primitives/Badge";

export { Segmented, SegmentedChoice } from "./primitives/Segmented";
export type {
  SegmentedProps,
  SegmentedSize,
  SegmentedChoiceProps,
  SegmentedChoiceOption,
} from "./primitives/Segmented";

export { SegmentedTabs } from "./primitives/SegmentedTabs";
export type { SegmentedTabsProps, SegmentedTab } from "./primitives/SegmentedTabs";

export { MenuButton, Menu, MenuItem, MenuSeparator, MenuHeading } from "./primitives/Menu";
export type { MenuButtonProps, MenuProps, MenuItemProps, MenuItemRole } from "./primitives/Menu";

export { Dropdown } from "./primitives/Dropdown";
export type { DropdownProps, DropdownOption } from "./primitives/Dropdown";

export { Checkbox, Switch } from "./primitives/toggles";
export type { CheckboxProps, SwitchProps } from "./primitives/toggles";

export { Chip } from "./primitives/Chip";
export type { ChipProps, ChipTone } from "./primitives/Chip";

export { Slider, SLIDER_BAND_WIDTH } from "./primitives/Slider";
export type { SliderProps } from "./primitives/Slider";

export { Input } from "./primitives/Input";
export type { LayoutInputProps } from "./primitives/Input";

export { Select } from "./primitives/Select";
export type { LayoutSelectProps } from "./primitives/Select";

export { Popover } from "./primitives/Popover";
export type { PopoverProps, PopoverPlacement } from "./primitives/Popover";

export {
  STANDARD_COLORS,
  QUICK_COLORS,
  DEFAULT_PICKER_COLOR,
  colorLabel,
  normalizeHex,
  sameColor,
} from "./colors";
export { ColorSwatch, ColorPopover } from "./primitives/Color";
export type {
  ColorSwatchProps,
  ColorPopoverProps,
  ColorPopoverAction,
  ColorSwatchVariant,
  ColorSwatchSize,
} from "./primitives/Color";

export { Tile, TileGallery } from "./primitives/Tile";
export type { TileProps, TileSize, TileGalleryProps, TileGalleryItem } from "./primitives/Tile";

export { PaletteStrip } from "./primitives/PaletteStrip";
export type { PaletteStripProps, PaletteOption } from "./primitives/PaletteStrip";

export { StyleGallery } from "./primitives/StyleGallery";
export type { StyleGalleryProps, StyleGalleryItem, StyleThumbSize } from "./primitives/StyleGallery";
