import React, { useCallback, useState, useRef } from 'react';
import { styles } from './PivotEditor.styles';
import { AggregationMenu } from './AggregationMenu';
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
  onDragStart: (field: DragField) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent, index: number) => void;
  onDrop: (e: React.DragEvent, index: number) => void;
}

export function ZoneFieldItem({
  field,
  zone,
  index,
  onRemove,
  onAggregationChange,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: ZoneFieldItemProps): React.ReactElement {
  const [isDragging, setIsDragging] = useState(false);
  const [showAggMenu, setShowAggMenu] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 });
  const itemRef = useRef<HTMLDivElement>(null);

  const displayName =
    zone === 'values' && field.aggregation
      ? getValueFieldDisplayName(field.name, field.aggregation)
      : field.name;

  const handleDragStart = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      const dragData: DragField = {
        sourceIndex: field.sourceIndex,
        name: field.name,
        isNumeric: field.isNumeric,
        fromZone: zone,
        fromIndex: index,
      };
      e.dataTransfer.setData('application/json', JSON.stringify(dragData));
      e.dataTransfer.effectAllowed = 'move';
      setIsDragging(true);
      onDragStart(dragData);
    },
    [field, zone, index, onDragStart]
  );

  const handleDragEnd = useCallback(() => {
    setIsDragging(false);
    onDragEnd();
  }, [onDragEnd]);

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

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      onDragOver(e, index);
    },
    [index, onDragOver]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      onDrop(e, index);
    },
    [index, onDrop]
  );

  return (
    <>
      <div
        ref={itemRef}
        className={`${styles.zoneField} ${isDragging ? 'dragging' : ''}`}
        draggable
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
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
    </>
  );
}