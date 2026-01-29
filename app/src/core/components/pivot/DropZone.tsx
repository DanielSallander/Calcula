//! FILENAME: app/src/core/components/pivot/DropZone.tsx

import React, { useCallback, useRef, useState, useEffect } from 'react';
import { css } from '@emotion/css';
import { styles } from './PivotEditor.styles';
import { ZoneFieldItem } from './ZoneFieldItem';
import { useDropZone, useDragState } from './useDragDrop';
import type {
  ZoneField,
  DragField,
  DropZoneType,
  AggregationType,
} from './types';

// Insert indicator style - blue line shown when dragging between fields
const insertIndicatorStyle = css`
  position: absolute;
  left: 0;
  right: 0;
  height: 2px;
  background: #0078d4;
  pointer-events: none;
  z-index: 10;

  &::before,
  &::after {
    content: '';
    position: absolute;
    width: 6px;
    height: 6px;
    background: #0078d4;
    border-radius: 50%;
    top: -2px;
  }

  &::before {
    left: -3px;
  }

  &::after {
    right: -3px;
  }
`;

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
  const [insertIndicatorIndex, setInsertIndicatorIndex] = useState<number | null>(null);
  const { isDragging } = useDragState();

  // Handle drop - either reorder within zone or drop from outside
  const handleDrop = useCallback(
    (dragField: DragField, insertIndex?: number) => {
      setInsertIndicatorIndex(null);
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
        // Skip the insert indicator element
        if (child.classList.contains(insertIndicatorStyle)) continue;
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

  // Update insert indicator position during drag
  useEffect(() => {
    if (!isDragOver || !contentRef.current) {
      setInsertIndicatorIndex(null);
      return;
    }

    const handleMouseMove = (e: MouseEvent) => {
      const idx = getInsertIndex(e.clientY);
      setInsertIndicatorIndex(idx);
    };

    document.addEventListener('mousemove', handleMouseMove);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
    };
  }, [isDragOver, getInsertIndex]);

  // Clear insert indicator when dragging ends
  useEffect(() => {
    if (!isDragging) {
      setInsertIndicatorIndex(null);
    }
  }, [isDragging]);

  const placeholder = getPlaceholder(zone);

  // Calculate insert indicator position
  const getIndicatorTop = (): number => {
    if (insertIndicatorIndex === null || !contentRef.current) return 0;
    const children = Array.from(contentRef.current.children).filter(
      (child) => !(child as HTMLElement).classList.contains(insertIndicatorStyle)
    );

    if (insertIndicatorIndex === 0) {
      return 0;
    }
    if (insertIndicatorIndex >= children.length) {
      const lastChild = children[children.length - 1] as HTMLElement;
      if (lastChild) {
        return lastChild.offsetTop + lastChild.offsetHeight + 2;
      }
      return 0;
    }
    const targetChild = children[insertIndicatorIndex] as HTMLElement;
    return targetChild ? targetChild.offsetTop - 2 : 0;
  };

  return (
    <div
      {...dropZoneProps}
      className={`${styles.dropZone} ${isDragOver ? 'drag-over' : ''} ${
        fullWidth ? 'full-width' : ''
      }`}
    >
      <div className={styles.dropZoneTitle}>{title}</div>
      <div ref={contentRef} className={styles.dropZoneContent} style={{ position: 'relative' }}>
        {/* Insert indicator line */}
        {isDragOver && insertIndicatorIndex !== null && fields.length > 0 && (
          <div
            className={insertIndicatorStyle}
            style={{ top: getIndicatorTop() }}
          />
        )}
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
