//! FILENAME: app/extensions/Tablix/components/TablixEditor.tsx
// PURPOSE: Main Tablix editor component with field list, drop zones, and layout options.
// CONTEXT: Adapted from PivotEditor with Tablix-specific data field mode handling.

import React, { useCallback, useState } from 'react';
import { styles } from '../../_shared/components/EditorStyles';
import { FieldList } from '../../_shared/components/FieldList';
import { NumberFormatModal } from '../../_shared/components/NumberFormatModal';
import { ComponentToggle } from '../../_shared/components/ComponentToggle';
import type { ComponentType } from '../../_shared/components/ComponentToggle';
import { TablixDropZones } from './TablixDropZones';
import { TablixLayoutOptions } from './TablixLayoutOptions';
import { useTablixEditorState } from './useTablixEditorState';
import { updateTablixFields, convertTablixToPivot } from '../lib/tablix-api';
import {
  openTaskPane,
  addTaskPaneContextKey,
  removeTaskPaneContextKey,
  showToast,
} from '../../../src/api';
import type { SourceField, ZoneField } from '../../_shared/components/types';
import type { TablixId, TablixLayoutConfig } from '../types';
import type { UpdateTablixFieldsRequest } from '../lib/tablix-api';

interface TablixEditorProps {
  tablixId: TablixId;
  sourceFields: SourceField[];
  initialRowGroups?: ZoneField[];
  initialColumnGroups?: ZoneField[];
  initialDataFields?: ZoneField[];
  initialFilters?: ZoneField[];
  initialLayout?: Partial<TablixLayoutConfig>;
  onClose?: () => void;
  onViewUpdate?: () => void;
}

export function TablixEditor({
  tablixId,
  sourceFields,
  initialRowGroups = [],
  initialColumnGroups = [],
  initialDataFields = [],
  initialFilters = [],
  initialLayout = {},
  onClose,
  onViewUpdate,
}: TablixEditorProps): React.ReactElement {
  // Modal state for number format
  const [numberFormatIndex, setNumberFormatIndex] = useState<number | null>(null);

  const handleUpdate = useCallback(async (request: UpdateTablixFieldsRequest) => {
    try {
      await updateTablixFields(request);
      if (onViewUpdate) {
        onViewUpdate();
      }
    } catch (error) {
      console.error('Failed to update tablix fields:', error);
    }
  }, [onViewUpdate]);

  const {
    usedFields,
    filters,
    columnGroups,
    rowGroups,
    dataFields,
    layout,
    handleFieldToggle,
    handleDrop,
    handleRemove,
    handleReorder,
    handleAggregationChange,
    handleDataFieldModeChange,
    handleNumberFormatChange,
    handleLayoutChange,
    handleDragStart,
    handleDragEnd,
  } = useTablixEditorState({
    tablixId,
    sourceFields,
    initialRowGroups,
    initialColumnGroups,
    initialDataFields,
    initialFilters,
    initialLayout,
    onUpdate: handleUpdate,
  });

  // Handle component type toggle (Tablix -> Pivot conversion)
  const handleComponentConvert = useCallback(async (targetType: ComponentType) => {
    if (targetType !== 'pivot') return;
    try {
      const result = await convertTablixToPivot(tablixId);
      // Show toast if detail fields were migrated
      if (result.migratedDetailFields && result.migratedDetailFields.length > 0) {
        showToast(
          'Detail fields were moved to Rows to maintain a collapsible list.',
          { variant: 'info' }
        );
      }
      // Switch context keys and task panes
      removeTaskPaneContextKey('tablix');
      addTaskPaneContextKey('pivot');
      // Trigger pivot region refresh so the new pivot regions are fetched
      window.dispatchEvent(new Event('pivot:refresh'));
      // Open the Pivot editor pane
      openTaskPane('pivot-editor');
    } catch (error) {
      console.error('Failed to convert Tablix to Pivot:', error);
      showToast('Failed to convert to PivotTable. Please try again.', { variant: 'error' });
    }
  }, [tablixId]);

  // Number format modal handlers
  const handleOpenNumberFormat = useCallback((index: number) => {
    setNumberFormatIndex(index);
  }, []);

  const handleSaveNumberFormat = useCallback((format: string) => {
    if (numberFormatIndex !== null) {
      handleNumberFormatChange(numberFormatIndex, format);
      setNumberFormatIndex(null);
    }
  }, [numberFormatIndex, handleNumberFormatChange]);

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span>Tablix Fields</span>
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

      <ComponentToggle currentType="tablix" onConvert={handleComponentConvert} />

      <div className={styles.content}>
        <FieldList
          fields={sourceFields}
          usedFields={usedFields}
          onFieldToggle={handleFieldToggle}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        />

        <TablixDropZones
          filters={filters}
          columnGroups={columnGroups}
          rowGroups={rowGroups}
          dataFields={dataFields}
          onDrop={handleDrop}
          onRemove={handleRemove}
          onReorder={handleReorder}
          onAggregationChange={handleAggregationChange}
          onDataFieldModeChange={handleDataFieldModeChange}
          onOpenNumberFormat={handleOpenNumberFormat}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        />

        <TablixLayoutOptions layout={layout} onChange={handleLayoutChange} />
      </div>

      {/* Number Format Modal */}
      {numberFormatIndex !== null && dataFields[numberFormatIndex] && (
        <NumberFormatModal
          isOpen={true}
          currentFormat={dataFields[numberFormatIndex].numberFormat || ''}
          onSave={handleSaveNumberFormat}
          onCancel={() => setNumberFormatIndex(null)}
        />
      )}
    </div>
  );
}
