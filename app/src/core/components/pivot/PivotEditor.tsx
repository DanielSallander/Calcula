import React, { useCallback } from 'react';
import { styles } from './PivotEditor.styles';
import { FieldList } from './FieldList';
import { DropZones } from './DropZones';
import { LayoutOptions } from './LayoutOptions';
import { usePivotEditorState } from './usePivotEditorState';
import type {
  SourceField,
  ZoneField,
  LayoutConfig,
  UpdatePivotFieldsRequest,
  PivotId,
} from './types';

// Mock API call - replace with actual Tauri invoke
async function updatePivotFields(
  request: UpdatePivotFieldsRequest
): Promise<void> {
  console.log('Updating pivot fields:', request);
  // TODO: Replace with actual Tauri command
  // await invoke('update_pivot_fields', { request });
}

interface PivotEditorProps {
  pivotId: PivotId;
  sourceFields: SourceField[];
  initialRows?: ZoneField[];
  initialColumns?: ZoneField[];
  initialValues?: ZoneField[];
  initialFilters?: ZoneField[];
  initialLayout?: LayoutConfig;
  onClose?: () => void;
}

export function PivotEditor({
  pivotId,
  sourceFields,
  initialRows = [],
  initialColumns = [],
  initialValues = [],
  initialFilters = [],
  initialLayout = {},
  onClose,
}: PivotEditorProps): React.ReactElement {
  const handleUpdate = useCallback(async (request: UpdatePivotFieldsRequest) => {
    try {
      await updatePivotFields(request);
    } catch (error) {
      console.error('Failed to update pivot fields:', error);
    }
  }, []);

  const {
    usedFields,
    filters,
    columns,
    rows,
    values,
    layout,
    handleFieldToggle,
    handleDrop,
    handleRemove,
    handleReorder,
    handleAggregationChange,
    handleLayoutChange,
    handleDragStart,
    handleDragEnd,
  } = usePivotEditorState({
    pivotId,
    sourceFields,
    initialRows,
    initialColumns,
    initialValues,
    initialFilters,
    initialLayout,
    onUpdate: handleUpdate,
  });

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span>PivotTable Fields</span>
        {onClose && (
          <button
            className={styles.closeButton}
            onClick={onClose}
            title="Close"
          >
            x
          </button>
        )}
      </div>

      <div className={styles.content}>
        <FieldList
          fields={sourceFields}
          usedFields={usedFields}
          onFieldToggle={handleFieldToggle}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        />

        <DropZones
          filters={filters}
          columns={columns}
          rows={rows}
          values={values}
          onDrop={handleDrop}
          onRemove={handleRemove}
          onReorder={handleReorder}
          onValuesAggregationChange={handleAggregationChange}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        />

        <LayoutOptions layout={layout} onChange={handleLayoutChange} />
      </div>
    </div>
  );
}