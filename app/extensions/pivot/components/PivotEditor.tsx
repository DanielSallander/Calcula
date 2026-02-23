//! FILENAME: app/extensions/pivot/components/PivotEditor.tsx
import React, { useCallback, useState, useEffect } from 'react';
import { styles } from './PivotEditor.styles';
import { FieldList } from './FieldList';
import { DropZones } from './DropZones';
import { LayoutOptions } from './LayoutOptions';
import { ValueFieldSettingsModal, type ValueFieldSettings } from './ValueFieldSettingsModal';
import { NumberFormatModal } from './NumberFormatModal';
import { ComponentToggle } from '../../_shared/components/ComponentToggle';
import type { ComponentType } from '../../_shared/components/ComponentToggle';
import { usePivotEditorState } from './usePivotEditorState';
import { pivot } from '../../../src/api/pivot';
import { convertPivotToTablix } from '../../Tablix/lib/tablix-api';
import {
  openTaskPane,
  addTaskPaneContextKey,
  removeTaskPaneContextKey,
  showToast,
  emitAppEvent,
} from '../../../src/api';
import type {
  SourceField,
  ZoneField,
  LayoutConfig,
  UpdatePivotFieldsRequest,
  PivotId,
} from './types';

interface PivotEditorProps {
  pivotId: PivotId;
  sourceFields: SourceField[];
  initialRows?: ZoneField[];
  initialColumns?: ZoneField[];
  initialValues?: ZoneField[];
  initialFilters?: ZoneField[];
  initialLayout?: LayoutConfig;
  onClose?: () => void;
  onViewUpdate?: () => void;
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
  onViewUpdate,
}: PivotEditorProps): React.ReactElement {
  // Modal state
  const [valueSettingsIndex, setValueSettingsIndex] = useState<number | null>(null);
  const [numberFormatIndex, setNumberFormatIndex] = useState<number | null>(null);

  const handleUpdate = useCallback(async (request: UpdatePivotFieldsRequest) => {
    try {
      await pivot.updateFields(request);
      // Notify parent that the pivot view has been updated
      if (onViewUpdate) {
        onViewUpdate();
      }
    } catch (error) {
      console.error('Failed to update pivot fields:', error);
    }
  }, [onViewUpdate]);

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
    handleValueFieldSettings,
    handleNumberFormatChange,
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

  // Modal handlers
  const handleOpenValueSettings = useCallback((index: number) => {
    setValueSettingsIndex(index);
  }, []);

  const handleOpenNumberFormat = useCallback((index: number) => {
    setNumberFormatIndex(index);
  }, []);

  const handleSaveValueSettings = useCallback((settings: ValueFieldSettings) => {
    if (valueSettingsIndex !== null) {
      handleValueFieldSettings(valueSettingsIndex, settings);
      setValueSettingsIndex(null);
    }
  }, [valueSettingsIndex, handleValueFieldSettings]);

  const handleSaveNumberFormat = useCallback((format: string) => {
    if (numberFormatIndex !== null) {
      handleNumberFormatChange(numberFormatIndex, format);
      setNumberFormatIndex(null);
    }
  }, [numberFormatIndex, handleNumberFormatChange]);

  // Handle component type toggle (Pivot -> Tablix conversion)
  const handleComponentConvert = useCallback(async (targetType: ComponentType) => {
    if (targetType !== 'tablix') return;
    try {
      const result = await convertPivotToTablix(pivotId);
      // Switch context keys and task panes
      removeTaskPaneContextKey('pivot');
      addTaskPaneContextKey('tablix');
      // Emit events to refresh regions
      emitAppEvent('app:tablix-regions-updated', {});
      // Open the Tablix editor pane
      openTaskPane('tablix-editor');
    } catch (error) {
      console.error('Failed to convert Pivot to Tablix:', error);
      showToast('Failed to convert to Tablix. Please try again.', { variant: 'error' });
    }
  }, [pivotId]);

  // Notify Layout when filter fields change so it can show the FilterBar
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("pivot:filterFieldsChanged", {
        detail: {
          pivotId,
          filterFields: filters,
        },
      })
    );
  }, [pivotId, filters]);

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

      <ComponentToggle currentType="pivot" onConvert={handleComponentConvert} />

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
          onOpenValueSettings={handleOpenValueSettings}
          onOpenNumberFormat={handleOpenNumberFormat}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        />

        <LayoutOptions layout={layout} onChange={handleLayoutChange} />
      </div>

      {/* Value Field Settings Modal */}
      {valueSettingsIndex !== null && values[valueSettingsIndex] && (
        <ValueFieldSettingsModal
          isOpen={true}
          field={values[valueSettingsIndex]}
          onSave={handleSaveValueSettings}
          onCancel={() => setValueSettingsIndex(null)}
        />
      )}

      {/* Number Format Modal */}
      {numberFormatIndex !== null && values[numberFormatIndex] && (
        <NumberFormatModal
          isOpen={true}
          currentFormat={values[numberFormatIndex].numberFormat || ''}
          onSave={handleSaveNumberFormat}
          onCancel={() => setNumberFormatIndex(null)}
        />
      )}
    </div>
  );
}