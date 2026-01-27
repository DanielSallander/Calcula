//! FILENAME: app/src/core/components/pivot/DropZones.tsx
import React from 'react';
import { styles } from './PivotEditor.styles';
import { DropZone } from './DropZone';
import type {
  ZoneField,
  DragField,
  DropZoneType,
  AggregationType,
} from './types';

interface DropZonesProps {
  filters: ZoneField[];
  columns: ZoneField[];
  rows: ZoneField[];
  values: ZoneField[];
  onDrop: (zone: DropZoneType, field: DragField, insertIndex?: number) => void;
  onRemove: (zone: DropZoneType, index: number) => void;
  onReorder: (zone: DropZoneType, fromIndex: number, toIndex: number) => void;
  onValuesAggregationChange: (index: number, aggregation: AggregationType) => void;
  onDragStart: (field: DragField) => void;
  onDragEnd: () => void;
}

export function DropZones({
  filters,
  columns,
  rows,
  values,
  onDrop,
  onRemove,
  onReorder,
  onValuesAggregationChange,
  onDragStart,
  onDragEnd,
}: DropZonesProps): React.ReactElement {
  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>Drag fields between areas below</div>
      <div className={styles.dropZonesContainer}>
        <DropZone
          zone="filters"
          title="Filters"
          fields={filters}
          fullWidth
          onDrop={onDrop}
          onRemove={onRemove}
          onReorder={onReorder}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        />
        <DropZone
          zone="columns"
          title="Columns"
          fields={columns}
          onDrop={onDrop}
          onRemove={onRemove}
          onReorder={onReorder}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        />
        <DropZone
          zone="rows"
          title="Rows"
          fields={rows}
          onDrop={onDrop}
          onRemove={onRemove}
          onReorder={onReorder}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        />
        <DropZone
          zone="values"
          title="Values"
          fields={values}
          fullWidth
          onDrop={onDrop}
          onRemove={onRemove}
          onReorder={onReorder}
          onAggregationChange={onValuesAggregationChange}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        />
      </div>
    </div>
  );
}