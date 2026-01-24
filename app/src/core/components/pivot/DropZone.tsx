import React, { useCallback, useState } from 'react';
import { styles } from './PivotEditor.styles';
import { ZoneFieldItem } from './ZoneFieldItem';
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
  onDragStart,
  onDragEnd,
}: DropZoneProps): React.ReactElement {
  const [isDragOver, setIsDragOver] = useState(false);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) {
      return;
    }
    setIsDragOver(false);
    setDropIndex(null);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      setDropIndex(null);

      try {
        const data = e.dataTransfer.getData('application/json');
        if (!data) return;

        const dragField: DragField = JSON.parse(data);

        if (dragField.fromZone === zone && dragField.fromIndex !== undefined) {
          // Reordering within the same zone
          const targetIndex = dropIndex ?? fields.length;
          if (targetIndex !== dragField.fromIndex) {
            onReorder(zone, dragField.fromIndex, targetIndex);
          }
        } else {
          // Dropping from field list or another zone
          onDrop(zone, dragField, dropIndex ?? undefined);
        }
      } catch (err) {
        console.error('Failed to parse drag data:', err);
      }
    },
    [zone, fields.length, dropIndex, onDrop, onReorder]
  );

  const handleFieldDragOver = useCallback(
    (e: React.DragEvent, index: number) => {
      e.preventDefault();
      setDropIndex(index);
    },
    []
  );

  const handleFieldDrop = useCallback(
    (e: React.DragEvent, index: number) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);

      try {
        const data = e.dataTransfer.getData('application/json');
        if (!data) return;

        const dragField: DragField = JSON.parse(data);

        if (dragField.fromZone === zone && dragField.fromIndex !== undefined) {
          if (index !== dragField.fromIndex) {
            onReorder(zone, dragField.fromIndex, index);
          }
        } else {
          onDrop(zone, dragField, index);
        }
      } catch (err) {
        console.error('Failed to parse drag data:', err);
      }

      setDropIndex(null);
    },
    [zone, onDrop, onReorder]
  );

  const placeholder = getPlaceholder(zone);

  return (
    <div
      className={`${styles.dropZone} ${isDragOver ? 'drag-over' : ''} ${
        fullWidth ? 'full-width' : ''
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className={styles.dropZoneTitle}>{title}</div>
      <div className={styles.dropZoneContent}>
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
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onDragOver={handleFieldDragOver}
              onDrop={handleFieldDrop}
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