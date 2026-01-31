//! FILENAME: app/src/core/components/pivot/usePivotEditorState.ts
import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import type {
  SourceField,
  ZoneField,
  DragField,
  DropZoneType,
  AggregationType,
  LayoutConfig,
  UpdatePivotFieldsRequest,
  PivotFieldConfig,
  ValueFieldConfig,
  PivotId,
} from './types';
import { getDefaultAggregation, getValueFieldDisplayName } from './types';
import type { ValueFieldSettings } from './ValueFieldSettingsModal';

interface UsePivotEditorStateOptions {
  pivotId: PivotId;
  sourceFields: SourceField[];
  initialRows?: ZoneField[];
  initialColumns?: ZoneField[];
  initialValues?: ZoneField[];
  initialFilters?: ZoneField[];
  initialLayout?: LayoutConfig;
  onUpdate?: (request: UpdatePivotFieldsRequest) => void;
}

export function usePivotEditorState({
  pivotId,
  sourceFields,
  initialRows = [],
  initialColumns = [],
  initialValues = [],
  initialFilters = [],
  initialLayout = {},
  onUpdate,
}: UsePivotEditorStateOptions) {
  const [rows, setRows] = useState<ZoneField[]>(initialRows);
  const [columns, setColumns] = useState<ZoneField[]>(initialColumns);
  const [values, setValues] = useState<ZoneField[]>(initialValues);
  const [filters, setFilters] = useState<ZoneField[]>(initialFilters);
  const [layout, setLayout] = useState<LayoutConfig>(initialLayout);
  const [draggingField, setDraggingField] = useState<DragField | null>(null);

  // Track whether we should trigger an update (skip initial render)
  const isInitialMount = useRef(true);
  const pendingUpdate = useRef(false);

  // Track which fields are currently used in any zone
  const usedFields = useMemo(() => {
    const used = new Set<number>();
    [...rows, ...columns, ...values, ...filters].forEach((f) =>
      used.add(f.sourceIndex)
    );
    return used;
  }, [rows, columns, values, filters]);

  // Build the update request from current state
  const buildUpdateRequest = useCallback((): UpdatePivotFieldsRequest => {
    const rowFields: PivotFieldConfig[] = rows.map((f) => ({
      source_index: f.sourceIndex,
      name: f.name,
    }));

    const columnFields: PivotFieldConfig[] = columns.map((f) => ({
      source_index: f.sourceIndex,
      name: f.name,
    }));

    const valueFields: ValueFieldConfig[] = values.map((f) => {
      const aggregation = f.aggregation ?? getDefaultAggregation(f.isNumeric);
      const displayName = f.customName || getValueFieldDisplayName(f.name, aggregation);
      return {
        source_index: f.sourceIndex,
        name: displayName,
        aggregation,
        number_format: f.numberFormat,
        show_values_as: f.showValuesAs,
      };
    });

    // Build filter fields with hidden items
    const filterFields: PivotFieldConfig[] = filters.map((f) => ({
      source_index: f.sourceIndex,
      name: f.name,
      hidden_items: f.hiddenItems,
    }));

    return {
      pivot_id: pivotId,
      row_fields: rowFields,
      column_fields: columnFields,
      value_fields: valueFields,
      filter_fields: filterFields,
      layout,
    };
  }, [pivotId, rows, columns, values, filters, layout]);

  // Effect to trigger update when zones change (after state is actually updated)
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }

    if (pendingUpdate.current && onUpdate) {
      pendingUpdate.current = false;
      console.log('[PivotEditor] Triggering update with current state:', {
        rows: rows.length,
        columns: columns.length,
        values: values.length,
      });
      onUpdate(buildUpdateRequest());
    }
  }, [rows, columns, values, filters, layout, onUpdate, buildUpdateRequest]);

  // Mark that an update should be triggered after state changes
  const scheduleUpdate = useCallback(() => {
    pendingUpdate.current = true;
  }, []);

  // Get zone state setter
  const getZoneSetter = useCallback(
    (zone: DropZoneType) => {
      switch (zone) {
        case 'filters':
          return setFilters;
        case 'columns':
          return setColumns;
        case 'rows':
          return setRows;
        case 'values':
          return setValues;
      }
    },
    []
  );

  // Handle field toggle from field list
  const handleFieldToggle = useCallback(
    (field: SourceField, checked: boolean) => {
      if (checked) {
        // Add to default zone based on field type
        const zoneField: ZoneField = {
          sourceIndex: field.index,
          name: field.name,
          isNumeric: field.isNumeric,
          aggregation: field.isNumeric
            ? getDefaultAggregation(true)
            : undefined,
        };

        if (field.isNumeric) {
          setValues((prev) => [...prev, zoneField]);
        } else {
          setRows((prev) => [...prev, zoneField]);
        }
      } else {
        // Remove from all zones
        const removeFromZone = (prev: ZoneField[]) =>
          prev.filter((f) => f.sourceIndex !== field.index);

        setFilters(removeFromZone);
        setColumns(removeFromZone);
        setRows(removeFromZone);
        setValues(removeFromZone);
      }

      // Schedule update to run after state is updated
      scheduleUpdate();
    },
    [scheduleUpdate]
  );

  // Handle drop into a zone
  const handleDrop = useCallback(
    (zone: DropZoneType, dragField: DragField, insertIndex?: number) => {
      // Remove from source zone if moving between zones
      if (dragField.fromZone && dragField.fromIndex !== undefined) {
        const sourceSetter = getZoneSetter(dragField.fromZone);
        sourceSetter((prev) => prev.filter((_, i) => i !== dragField.fromIndex));
      }

      // Create zone field
      const zoneField: ZoneField = {
        sourceIndex: dragField.sourceIndex,
        name: dragField.name,
        isNumeric: dragField.isNumeric,
        aggregation:
          zone === 'values'
            ? getDefaultAggregation(dragField.isNumeric)
            : undefined,
      };

      // Add to target zone
      const targetSetter = getZoneSetter(zone);
      targetSetter((prev) => {
        if (insertIndex !== undefined && insertIndex < prev.length) {
          const newFields = [...prev];
          newFields.splice(insertIndex, 0, zoneField);
          return newFields;
        }
        return [...prev, zoneField];
      });

      scheduleUpdate();
    },
    [getZoneSetter, scheduleUpdate]
  );

  // Handle remove from zone
  const handleRemove = useCallback(
    (zone: DropZoneType, index: number) => {
      const setter = getZoneSetter(zone);
      setter((prev) => prev.filter((_, i) => i !== index));
      scheduleUpdate();
    },
    [getZoneSetter, scheduleUpdate]
  );

  // Handle reorder within zone
  const handleReorder = useCallback(
    (zone: DropZoneType, fromIndex: number, toIndex: number) => {
      const setter = getZoneSetter(zone);
      setter((prev) => {
        const newFields = [...prev];
        const [removed] = newFields.splice(fromIndex, 1);
        const adjustedToIndex =
          toIndex > fromIndex ? toIndex - 1 : toIndex;
        newFields.splice(adjustedToIndex, 0, removed);
        return newFields;
      });
      scheduleUpdate();
    },
    [getZoneSetter, scheduleUpdate]
  );

  // Handle aggregation change for values
  const handleAggregationChange = useCallback(
    (index: number, aggregation: AggregationType) => {
      setValues((prev) =>
        prev.map((f, i) => (i === index ? { ...f, aggregation } : f))
      );
      scheduleUpdate();
    },
    [scheduleUpdate]
  );

  // Handle value field settings change (from modal)
  const handleValueFieldSettings = useCallback(
    (index: number, settings: ValueFieldSettings) => {
      setValues((prev) =>
        prev.map((f, i) =>
          i === index
            ? {
                ...f,
                aggregation: settings.aggregation,
                customName: settings.customName,
                showValuesAs: settings.showValuesAs,
              }
            : f
        )
      );
      scheduleUpdate();
    },
    [scheduleUpdate]
  );

  // Handle number format change for value field
  const handleNumberFormatChange = useCallback(
    (index: number, numberFormat: string) => {
      setValues((prev) =>
        prev.map((f, i) =>
          i === index ? { ...f, numberFormat: numberFormat || undefined } : f
        )
      );
      scheduleUpdate();
    },
    [scheduleUpdate]
  );

  // Handle filter change (update hidden items for a filter field)
  const handleFilterHiddenItemsChange = useCallback(
    (filterIndex: number, hiddenItems: string[]) => {
      setFilters((prev) =>
        prev.map((f, i) =>
          i === filterIndex
            ? { ...f, hiddenItems: hiddenItems.length > 0 ? hiddenItems : undefined }
            : f
        )
      );
      scheduleUpdate();
    },
    [scheduleUpdate]
  );

  // Handle layout change
  const handleLayoutChange = useCallback(
    (newLayout: LayoutConfig) => {
      setLayout(newLayout);
      scheduleUpdate();
    },
    [scheduleUpdate]
  );

  // Drag handlers
  const handleDragStart = useCallback((field: DragField) => {
    setDraggingField(field);
  }, []);

  const handleDragEnd = useCallback(() => {
    setDraggingField(null);
  }, []);

  return {
    sourceFields,
    usedFields,
    filters,
    columns,
    rows,
    values,
    layout,
    draggingField,
    handleFieldToggle,
    handleDrop,
    handleRemove,
    handleReorder,
    handleAggregationChange,
    handleValueFieldSettings,
    handleNumberFormatChange,
    handleFilterHiddenItemsChange,
    handleLayoutChange,
    handleDragStart,
    handleDragEnd,
    buildUpdateRequest,
  };
}