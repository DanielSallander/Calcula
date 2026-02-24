//! FILENAME: app/extensions/pivot/components/DropZones.tsx
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
  onMoveField?: (fromZone: DropZoneType, fromIndex: number, toZone: DropZoneType) => void;
  onOpenValueSettings?: (index: number) => void;
  onOpenNumberFormat?: (index: number) => void;
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
  onMoveField,
  onOpenValueSettings,
  onOpenNumberFormat,
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
          onDrop={onDrop}
          onRemove={onRemove}
          onReorder={onReorder}
          onMoveField={onMoveField}
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
          onMoveField={onMoveField}
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
          onMoveField={onMoveField}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        />
        <DropZone
          zone="values"
          title="Values"
          fields={values}
          onDrop={onDrop}
          onRemove={onRemove}
          onReorder={onReorder}
          onAggregationChange={onValuesAggregationChange}
          onMoveField={onMoveField}
          onOpenValueSettings={onOpenValueSettings}
          onOpenNumberFormat={onOpenNumberFormat}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        />
      </div>
    </div>
  );
}
