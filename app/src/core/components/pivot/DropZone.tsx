//! FILENAME: app/src/core/components/pivot/DropZone.tsx

import React, { useCallback, useRef } from 'react';
import { styles } from './PivotEditor.styles';
import { ZoneFieldItem } from './ZoneFieldItem';
import { useDropZone } from './useDragDrop';
import type {
  ZoneField,
  DragField,
  DropZoneType,
  AggregationType,
} from './types';

interface DropZoneProps {
  zone: DropZoneType;
  title: string;
  fields: ZoneField[];
  fullWidth?: boolean;
  onDrop: (zone: DropZoneType, field: DragField, insertIndex?: number) => void;
  onRemove: (zone: DropZoneType, index: number) => void;
  onReorder: (zone: DropZoneType, fromIndex: number, toIndex: number) => void;
  onAggregationChange?: (index: number, aggregation: AggregationType) => void;
  onOpenValueSettings?: (index: number) => void;
  onOpenNumberFormat?: (index: number) => void;
  onDragStart: (field: DragField) => void;
  onDragEnd: () => void;
}

export function DropZone({
  zone,
  title,
  fields,
  fullWidth = false,
  onDrop,
  onRemove,
  onReorder,
  onAggregationChange,
  onOpenValueSettings,
  onOpenNumberFormat,
  onDragStart,
  onDragEnd,
}: DropZoneProps): React.ReactElement {
  const contentRef = useRef<HTMLDivElement>(null);

  // Handle drop - either reorder within zone or drop from outside
  const handleDrop = useCallback(
    (dragField: DragField, insertIndex?: number) => {
      if (dragField.fromZone === zone && dragField.fromIndex !== undefined) {
        // Reordering within the same zone
        const targetIndex = insertIndex ?? fields.length;
        if (targetIndex !== dragField.fromIndex) {
          onReorder(zone, dragField.fromIndex, targetIndex);
        }
      } else {
        // Dropping from field list or another zone
        onDrop(zone, dragField, insertIndex);
      }
    },
    [zone, fields.length, onDrop, onReorder]
  );

  // Calculate insert index based on Y position
  const getInsertIndex = useCallback(
    (y: number): number => {
      if (!contentRef.current || fields.length === 0) {
        return 0;
      }

      const children = contentRef.current.children;
      for (let i = 0; i < children.length; i++) {
        const child = children[i] as HTMLElement;
        const rect = child.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        if (y < midY) {
          return i;
        }
      }
      return fields.length;
    },
    [fields.length]
  );

  const { isDragOver, dropZoneProps } = useDropZone(zone, handleDrop, getInsertIndex);

  const placeholder = getPlaceholder(zone);

  return (
    <div
      {...dropZoneProps}
      className={`${styles.dropZone} ${isDragOver ? 'drag-over' : ''} ${
        fullWidth ? 'full-width' : ''
      }`}
    >
      <div className={styles.dropZoneTitle}>{title}</div>
      <div ref={contentRef} className={styles.dropZoneContent}>
        {fields.length === 0 ? (
          <div className={styles.dropZonePlaceholder}>{placeholder}</div>
        ) : (
          fields.map((field, index) => (
            <ZoneFieldItem
              key={`${field.sourceIndex}-${index}`}
              field={field}
              zone={zone}
              index={index}
              onRemove={onRemove}
              onAggregationChange={
                zone === 'values' ? onAggregationChange : undefined
              }
              onOpenValueSettings={
                zone === 'values' ? onOpenValueSettings : undefined
              }
              onOpenNumberFormat={
                zone === 'values' ? onOpenNumberFormat : undefined
              }
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
            />
          ))
        )}
      </div>
    </div>
  );
}

function getPlaceholder(zone: DropZoneType): string {
  switch (zone) {
    case 'filters':
      return 'Drag fields here to filter';
    case 'columns':
      return 'Drag fields here for columns';
    case 'rows':
      return 'Drag fields here for rows';
    case 'values':
      return 'Drag fields here to summarize';
  }
}
