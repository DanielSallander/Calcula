//! FILENAME: app/extensions/_shared/components/ZoneFieldItem.tsx
import React, { useCallback, useState, useMemo } from 'react';
import { styles } from './EditorStyles';
import { FieldPillMenu } from './FieldPillMenu';
import { useDraggable } from './useDragDrop';
import {
  type ZoneField,
  type DragField,
  type DropZoneType,
  type AggregationType,
  getValueFieldDisplayName,
} from './types';

interface ZoneFieldItemProps {
  field: ZoneField;
  zone: DropZoneType;
  index: number;
  totalFieldsInZone: number;
  onRemove: (zone: DropZoneType, index: number) => void;
  onReorder: (zone: DropZoneType, fromIndex: number, toIndex: number) => void;
  onAggregationChange?: (index: number, aggregation: AggregationType) => void;
  onMoveField?: (fromZone: DropZoneType, fromIndex: number, toZone: DropZoneType) => void;
  // Legacy props kept for API compatibility - not used with mouse-based drag
  onDragStart?: (field: DragField) => void;
  onDragEnd?: () => void;
  /** Callback to open value field settings modal */
  onOpenValueSettings?: (index: number) => void;
  /** Callback to open number format modal */
  onOpenNumberFormat?: (index: number) => void;
}

export function ZoneFieldItem({
  field,
  zone,
  index,
  totalFieldsInZone,
  onRemove,
  onReorder,
  onAggregationChange,
  onMoveField,
  onOpenValueSettings,
  onOpenNumberFormat,
}: ZoneFieldItemProps): React.ReactElement {
  const [showMenu, setShowMenu] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 });

  const displayName =
    zone === 'values' && field.aggregation
      ? getValueFieldDisplayName(field.name, field.aggregation)
      : field.name;

  const dragData: DragField = useMemo(
    () => ({
      sourceIndex: field.sourceIndex,
      name: field.name,
      isNumeric: field.isNumeric,
      fromZone: zone,
      fromIndex: index,
    }),
    [field.sourceIndex, field.name, field.isNumeric, zone, index]
  );

  const { isDragging, dragHandleProps } = useDraggable(dragData, displayName);

  const handleRemove = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onRemove(zone, index);
  }, [zone, index, onRemove]);

  const handleDropdownClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      const rect = (e.target as HTMLElement).getBoundingClientRect();
      setMenuPosition({
        x: rect.left,
        y: rect.bottom + 4,
      });
      setShowMenu(true);
    },
    []
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setMenuPosition({
        x: e.clientX,
        y: e.clientY,
      });
      setShowMenu(true);
    },
    []
  );

  const handleAggregationChange = useCallback(
    (aggregation: AggregationType) => {
      if (onAggregationChange) {
        onAggregationChange(index, aggregation);
      }
    },
    [index, onAggregationChange]
  );

  const handleMoveUp = useCallback(() => {
    if (index > 0) {
      onReorder(zone, index, index - 1);
    }
  }, [zone, index, onReorder]);

  const handleMoveDown = useCallback(() => {
    if (index < totalFieldsInZone - 1) {
      onReorder(zone, index, index + 2);
    }
  }, [zone, index, totalFieldsInZone, onReorder]);

  const handleMoveToBeginning = useCallback(() => {
    if (index > 0) {
      onReorder(zone, index, 0);
    }
  }, [zone, index, onReorder]);

  const handleMoveToEnd = useCallback(() => {
    if (index < totalFieldsInZone - 1) {
      onReorder(zone, index, totalFieldsInZone);
    }
  }, [zone, index, totalFieldsInZone, onReorder]);

  const handleMoveTo = useCallback(
    (targetZone: DropZoneType) => {
      if (onMoveField) {
        onMoveField(zone, index, targetZone);
      }
    },
    [zone, index, onMoveField]
  );

  const handleValueFieldSettings = useCallback(() => {
    if (onOpenValueSettings) {
      onOpenValueSettings(index);
    }
  }, [index, onOpenValueSettings]);

  const handleNumberFormat = useCallback(() => {
    if (onOpenNumberFormat) {
      onOpenNumberFormat(index);
    }
  }, [index, onOpenNumberFormat]);

  return (
    <>
      <div
        {...dragHandleProps}
        className={`${styles.zoneField} ${isDragging ? 'dragging' : ''}`}
        onContextMenu={handleContextMenu}
      >
        <span className={styles.zoneFieldName} title={displayName}>
          {displayName}
        </span>
        <button
          className={styles.zoneFieldDropdown}
          onClick={handleDropdownClick}
          title="Field options"
        >
          {'\u25BC'}
        </button>
        <button
          className={styles.zoneFieldRemove}
          onClick={handleRemove}
          title="Remove field"
        >
          {'\u00D7'}
        </button>
      </div>
      {showMenu && (
        <FieldPillMenu
          position={menuPosition}
          zone={zone}
          fieldIndex={index}
          totalFieldsInZone={totalFieldsInZone}
          aggregation={field.aggregation}
          onMoveUp={handleMoveUp}
          onMoveDown={handleMoveDown}
          onMoveToBeginning={handleMoveToBeginning}
          onMoveToEnd={handleMoveToEnd}
          onMoveTo={handleMoveTo}
          onRemove={() => onRemove(zone, index)}
          onValueFieldSettings={
            zone === 'values' ? handleValueFieldSettings : undefined
          }
          onNumberFormat={
            zone === 'values' ? handleNumberFormat : undefined
          }
          onAggregationChange={
            zone === 'values' ? handleAggregationChange : undefined
          }
          onClose={() => setShowMenu(false)}
        />
      )}
    </>
  );
}
