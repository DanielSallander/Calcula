//! FILENAME: app/extensions/Tablix/components/TablixDropZones.tsx
// PURPOSE: Drop zones layout for the Tablix editor.
// CONTEXT: Tablix-specific zone labels (Row Groups, Column Groups, Data Fields).

import React from 'react';
import { css } from '@emotion/css';
import { styles } from '../../_shared/components/EditorStyles';
import { DropZone } from '../../_shared/components/DropZone';
import { DataFieldModeToggle } from './DataFieldModeToggle';
import type {
  ZoneField,
  DragField,
  DropZoneType,
  AggregationType,
} from '../../_shared/components/types';
import type { DataFieldMode } from '../types';

interface TablixDropZonesProps {
  filters: ZoneField[];
  columnGroups: ZoneField[];
  rowGroups: ZoneField[];
  dataFields: ZoneField[];
  onDrop: (zone: DropZoneType, field: DragField, insertIndex?: number) => void;
  onRemove: (zone: DropZoneType, index: number) => void;
  onReorder: (zone: DropZoneType, fromIndex: number, toIndex: number) => void;
  onAggregationChange: (index: number, aggregation: AggregationType) => void;
  onDataFieldModeChange: (index: number, mode: DataFieldMode) => void;
  onOpenNumberFormat?: (index: number) => void;
  onDragStart: (field: DragField) => void;
  onDragEnd: () => void;
}

// Styles for the data field mode toggles rendered below the data fields zone
const dataFieldModeListStyle = css`
  margin-top: 4px;
  padding: 0 2px;
`;

const dataFieldModeItemStyle = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 0;
  font-size: 11px;
  color: #555;

  .field-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }
`;

export function TablixDropZones({
  filters,
  columnGroups,
  rowGroups,
  dataFields,
  onDrop,
  onRemove,
  onReorder,
  onAggregationChange,
  onDataFieldModeChange,
  onOpenNumberFormat,
  onDragStart,
  onDragEnd,
}: TablixDropZonesProps): React.ReactElement {
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
          title="Column Groups"
          fields={columnGroups}
          onDrop={onDrop}
          onRemove={onRemove}
          onReorder={onReorder}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        />
        <DropZone
          zone="rows"
          title="Row Groups"
          fields={rowGroups}
          onDrop={onDrop}
          onRemove={onRemove}
          onReorder={onReorder}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        />
        <DropZone
          zone="values"
          title="Data Fields"
          fields={dataFields}
          fullWidth
          placeholder="Drag fields here for values or details"
          onDrop={onDrop}
          onRemove={onRemove}
          onReorder={onReorder}
          onAggregationChange={onAggregationChange}
          onOpenNumberFormat={onOpenNumberFormat}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        />
      </div>

      {/* Data field mode toggles */}
      {dataFields.length > 0 && (
        <div className={dataFieldModeListStyle}>
          {dataFields.map((field, index) => (
            <div key={`${field.sourceIndex}-${index}`} className={dataFieldModeItemStyle}>
              <span className="field-name">{field.name}</span>
              <DataFieldModeToggle
                mode={(field.mode as DataFieldMode) || 'aggregated'}
                onChange={(mode) => onDataFieldModeChange(index, mode)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
