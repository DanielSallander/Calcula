//! FILENAME: app/extensions/_shared/components/index.ts
// PURPOSE: Barrel export for shared editor components used by Pivot and Tablix.

// Types
export type {
  FieldIndex,
  AggregationType,
  SortOrder,
  SourceField,
  DropZoneType,
  DragField,
  ZoneField,
  AggregationOption,
} from './types';
export {
  AGGREGATION_OPTIONS,
  getDefaultAggregation,
  getValueFieldDisplayName,
} from './types';

// Styles
export { styles } from './EditorStyles';

// Drag and Drop
export { useDraggable, useDropZone, useDragState } from './useDragDrop';

// Components
export { FieldItem } from './FieldItem';
export { FieldList } from './FieldList';
export { AggregationMenu } from './AggregationMenu';
export { ValueFieldContextMenu } from './ValueFieldContextMenu';
export type { ValueFieldContextMenuProps } from './ValueFieldContextMenu';
export { ZoneFieldItem } from './ZoneFieldItem';
export { DropZone } from './DropZone';
export { FilterDropdown } from './FilterDropdown';
export type { FilterDropdownProps } from './FilterDropdown';
export { NumberFormatModal, NUMBER_FORMAT_PRESETS } from './NumberFormatModal';
export type { NumberFormatModalProps, NumberFormatOption } from './NumberFormatModal';
export { ComponentToggle } from './ComponentToggle';
export type { ComponentType } from './ComponentToggle';
