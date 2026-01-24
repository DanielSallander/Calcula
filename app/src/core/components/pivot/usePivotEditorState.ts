import { useState, useCallback, useMemo } from 'react';
import type {
  PivotEditorState,
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

    const valueFields: ValueFieldConfig[] = values.map((f) => ({
      source_index: f.sourceIndex,
      name: getValueFieldDisplayName(
        f.name,
        f.aggregation ?? getDefaultAggregation(f.isNumeric)
      ),
      aggregation: f.aggregation ?? getDefaultAggregation(f.isNumeric),
    }));

    return {
      pivot_id: pivotId,
      row_fields: rowFields,
      column_fields: columnFields,
      value_fields: valueFields,
      layout,
    };
  }, [pivotId, rows, columns, values, layout]);

  // Trigger update callback
  const triggerUpdate = useCallback(() => {
    if (onUpdate) {
      onUpdate(buildUpdateRequest());
    }
  }, [onUpdate, buildUpdateRequest]);

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

  // Get zone state
  const getZoneFields = useCallback(
    (zone: DropZoneType): ZoneField[] => {
      switch (zone) {
        case 'filters':
          return filters;
        case 'columns':
          return columns;
        case 'rows':
          return rows;
        case 'values':
          return values;
      }
    },
    [filters, columns, rows, values]
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

      // Defer update to next tick so state is updated
      setTimeout(triggerUpdate, 0);
    },
    [triggerUpdate]
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

      setTimeout(triggerUpdate, 0);
    },
    [getZoneSetter, triggerUpdate]
  );

  // Handle remove from zone
  const handleRemove = useCallback(
    (zone: DropZoneType, index: number) => {
      const setter = getZoneSetter(zone);
      setter((prev) => prev.filter((_, i) => i !== index));
      setTimeout(triggerUpdate, 0);
    },
    [getZoneSetter, triggerUpdate]
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
      setTimeout(triggerUpdate, 0);
    },
    [getZoneSetter, triggerUpdate]
  );

  // Handle aggregation change for values
  const handleAggregationChange = useCallback(
    (index: number, aggregation: AggregationType) => {
      setValues((prev) =>
        prev.map((f, i) => (i === index ? { ...f, aggregation } : f))
      );
      setTimeout(triggerUpdate, 0);
    },
    [triggerUpdate]
  );

  // Handle layout change
  const handleLayoutChange = useCallback(
    (newLayout: LayoutConfig) => {
      setLayout(newLayout);
      setTimeout(triggerUpdate, 0);
    },
    [triggerUpdate]
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
    handleLayoutChange,
    handleDragStart,
    handleDragEnd,
    buildUpdateRequest,
  };
}