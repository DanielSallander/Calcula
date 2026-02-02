//! FILENAME: app/extensions/pivot/components/ZoneFieldItem.tsx
import React, { useCallback, useState, useMemo } from 'react';
import { styles } from './PivotEditor.styles';
import { AggregationMenu } from './AggregationMenu';
import { ValueFieldContextMenu } from './ValueFieldContextMenu';
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
  onRemove: (zone: DropZoneType, index: number) => void;
  onAggregationChange?: (index: number, aggregation: AggregationType) => void;
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
  onRemove,
  onAggregationChange,
  onOpenValueSettings,
  onOpenNumberFormat,
}: ZoneFieldItemProps): React.ReactElement {
  const [showAggMenu, setShowAggMenu] = useState(false);
  const [showContextMenu, setShowContextMenu] = useState(false);
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

  const handleRemove = useCallback(() => {
    onRemove(zone, index);
  }, [zone, index, onRemove]);

  const handleDropdownClick = useCallback(
    (e: React.MouseEvent) => {
      if (zone !== 'values' || !onAggregationChange) return;

      const rect = (e.target as HTMLElement).getBoundingClientRect();
      setMenuPosition({
        x: rect.left,
        y: rect.bottom + 4,
      });
      setShowAggMenu(true);
    },
    [zone, onAggregationChange]
  );

  const handleAggregationSelect = useCallback(
    (aggregation: AggregationType) => {
      if (onAggregationChange) {
        onAggregationChange(index, aggregation);
      }
    },
    [index, onAggregationChange]
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      // Only show context menu for values zone
      if (zone !== 'values') return;

      e.preventDefault();
      setMenuPosition({
        x: e.clientX,
        y: e.clientY,
      });
      setShowContextMenu(true);
    },
    [zone]
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
        {zone === 'values' && onAggregationChange && (
          <button
            className={styles.zoneFieldDropdown}
            onClick={handleDropdownClick}
            title="Change aggregation"
          >
            v
          </button>
        )}
        <button
          className={styles.zoneFieldRemove}
          onClick={handleRemove}
          title="Remove field"
        >
          x
        </button>
      </div>
      {showAggMenu && field.aggregation && (
        <AggregationMenu
          currentAggregation={field.aggregation}
          position={menuPosition}
          onSelect={handleAggregationSelect}
          onClose={() => setShowAggMenu(false)}
        />
      )}
      {showContextMenu && zone === 'values' && (
        <ValueFieldContextMenu
          position={menuPosition}
          onValueFieldSettings={handleValueFieldSettings}
          onNumberFormat={handleNumberFormat}
          onRemove={handleRemove}
          onClose={() => setShowContextMenu(false)}
        />
      )}
    </>
  );
}
