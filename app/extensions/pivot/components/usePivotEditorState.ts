//! FILENAME: app/extensions/pivot/components/usePivotEditorState.ts
import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import type {
  SourceField,
  ZoneField,
  DragField,
  DropZoneType,
  AggregationType,
  ShowValuesAs,
  LayoutConfig,
  UpdatePivotFieldsRequest,
  PivotFieldConfig,
  ValueFieldConfig,
  CalculatedFieldDef,
  ValueColumnRefDef,
  PivotId,
} from './types';
import { getDefaultAggregation, getValueFieldDisplayName } from './types';
import { emitAppEvent, onAppEvent } from '@api';
import { PivotEvents } from '../lib/pivotEvents';
import { registerDragOutRemoval } from '../../_shared/components/useDragDrop';
import type { ValueFieldSettings } from './ValueFieldSettingsModal';

interface UsePivotEditorStateOptions {
  pivotId: PivotId;
  sourceFields: SourceField[];
  initialRows?: ZoneField[];
  initialColumns?: ZoneField[];
  initialValues?: ZoneField[];
  initialFilters?: ZoneField[];
  initialLayout?: LayoutConfig;
  initialCalculatedFields?: CalculatedFieldDef[];
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
  initialCalculatedFields,
  onUpdate,
}: UsePivotEditorStateOptions) {
  // Merge initial calculated fields into the values array as ZoneField entries
  const mergedInitialValues = useMemo(() => {
    const merged = [...initialValues];
    if (initialCalculatedFields && initialCalculatedFields.length > 0) {
      for (const cf of initialCalculatedFields) {
        merged.push({
          sourceIndex: -2,  // Marker for calculated fields
          name: cf.name,
          isNumeric: true,
          isCalculated: true,
          customName: cf.name,
          calculatedFormula: cf.formula,
        });
      }
    }
    return merged;
  }, [initialValues, initialCalculatedFields]);

  const [rows, setRows] = useState<ZoneField[]>(initialRows);
  const [columns, setColumns] = useState<ZoneField[]>(initialColumns);
  const [values, setValues] = useState<ZoneField[]>(mergedInitialValues);
  const [filters, setFilters] = useState<ZoneField[]>(initialFilters);
  const [layout, setLayout] = useState<LayoutConfig>(initialLayout);
  const [draggingField, setDraggingField] = useState<DragField | null>(null);

  // Calculated fields from DSL CALC clauses or initial load from backend
  const calculatedFieldsRef = useRef<CalculatedFieldDef[] | undefined>(
    initialCalculatedFields && initialCalculatedFields.length > 0 ? initialCalculatedFields : undefined
  );

  // Unified column ordering (value fields + calculated fields interleaved)
  const valueColumnOrderRef = useRef<ValueColumnRefDef[] | undefined>(undefined);

  // Track all unique values per filter field (for smart serialization).
  // Key = field name, Value = all unique values.
  const filterUniqueValuesRef = useRef<Map<string, string[]>>(new Map());

  // Defer Layout Update: when true, changes accumulate without triggering updates
  const [deferUpdate, setDeferUpdate] = useState(false);
  const [hasPendingChanges, setHasPendingChanges] = useState(false);

  // Track whether we should trigger an update (skip initial render)
  const isInitialMount = useRef(true);
  const pendingUpdate = useRef(false);

  // When the pivotId changes (e.g. a new pivot is created after deleting the
  // old one), reset zone state to the new initial values. Without this,
  // useState keeps the previous pivot's field configuration.
  const prevPivotId = useRef(pivotId);
  useEffect(() => {
    if (prevPivotId.current !== pivotId) {
      prevPivotId.current = pivotId;
      isInitialMount.current = true;
      setRows(initialRows);
      setColumns(initialColumns);
      setValues(mergedInitialValues);
      setFilters(initialFilters);
      setLayout(initialLayout);
      setTimeout(() => { isInitialMount.current = false; }, 0);
    }
  }, [pivotId, initialRows, initialColumns, mergedInitialValues, initialFilters, initialLayout]);

  // Track which fields are currently used in any zone
  const usedFields = useMemo(() => {
    const used = new Set<number>();
    [...rows, ...columns, ...values, ...filters].forEach((f) =>
      used.add(f.sourceIndex)
    );
    return used;
  }, [rows, columns, values, filters]);

  // Build the update request from current state.
  // The values array may contain interleaved regular value fields and calculated
  // fields (isCalculated=true). We separate them and build the unified ordering.
  const buildUpdateRequest = useCallback((): UpdatePivotFieldsRequest => {
    const rowFields: PivotFieldConfig[] = rows.map((f) => ({
      sourceIndex: f.sourceIndex,
      name: f.name,
    }));

    const columnFields: PivotFieldConfig[] = columns.map((f) => ({
      sourceIndex: f.sourceIndex,
      name: f.name,
    }));

    // Separate regular values from calculated fields and build ordering
    const regularValues: ValueFieldConfig[] = [];
    const calcFields: CalculatedFieldDef[] = [];
    const columnOrder: ValueColumnRefDef[] = [];

    for (const f of values) {
      if (f.isCalculated) {
        const calcIdx = calcFields.length;
        calcFields.push({
          name: f.customName || f.name,
          formula: f.calculatedFormula || '',
          numberFormat: f.numberFormat,
        });
        columnOrder.push({ type: 'calculated', index: calcIdx });
      } else {
        const valIdx = regularValues.length;
        const aggregation = f.aggregation ?? getDefaultAggregation(f.isNumeric);
        const isBiField = f.sourceIndex === -1;
        const displayName = isBiField
          ? (f.customName || f.name)
          : (f.customName || getValueFieldDisplayName(f.name, aggregation));
        regularValues.push({
          sourceIndex: f.sourceIndex,
          name: displayName,
          aggregation,
          numberFormat: f.numberFormat,
          showValuesAs: f.showValuesAs as ShowValuesAs | undefined,
        });
        columnOrder.push({ type: 'value', index: valIdx });
      }
    }

    // Sync the ref so the DesignEditor serializer can access them
    calculatedFieldsRef.current = calcFields.length > 0 ? calcFields : undefined;
    valueColumnOrderRef.current = columnOrder.length > 0 ? columnOrder : undefined;

    // Build filter fields with hidden items
    const filterFields: PivotFieldConfig[] = filters.map((f) => ({
      sourceIndex: f.sourceIndex,
      name: f.name,
      hiddenItems: f.hiddenItems,
    }));

    return {
      pivotId: pivotId,
      rowFields: rowFields,
      columnFields: columnFields,
      valueFields: regularValues,
      filterFields: filterFields,
      layout,
      calculatedFields: calcFields.length > 0 ? calcFields : undefined,
      valueColumnOrder: columnOrder.length > 0 ? columnOrder : undefined,
    };
  }, [pivotId, rows, columns, values, filters, layout]);

  // Effect to trigger update when zones change (after state is actually updated)
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }

    if (pendingUpdate.current) {
      pendingUpdate.current = false;

      if (deferUpdate) {
        // In deferred mode, just mark that changes are pending
        setHasPendingChanges(true);
      } else if (onUpdate) {
        console.log('[PivotEditor] Triggering update with current state:', {
          rows: rows.length,
          columns: columns.length,
          values: values.length,
        });
        onUpdate(buildUpdateRequest());
      }
    }
  }, [rows, columns, values, filters, layout, onUpdate, buildUpdateRequest, deferUpdate]);

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
        // For BI fields (sourceIndex === -1), set customName to preserve the original
        // field name through buildUpdateRequest (prevents "Sum of [Revenue]" mangling)
        const isBiField = field.index === -1;
        const zoneField: ZoneField = {
          sourceIndex: field.index,
          name: field.name,
          isNumeric: field.isNumeric,
          aggregation: field.isNumeric
            ? getDefaultAggregation(true)
            : undefined,
          customName: isBiField ? field.name : undefined,
        };

        if (field.isNumeric) {
          setValues((prev) => [...prev, zoneField]);
        } else {
          setRows((prev) => [...prev, zoneField]);
        }
      } else {
        // Remove from all zones — use name-based match for BI fields (sourceIndex === -1)
        const isBiField = field.index === -1;
        const removeFromZone = (prev: ZoneField[]) =>
          prev.filter((f) =>
            isBiField ? f.name !== field.name : f.sourceIndex !== field.index
          );

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
      // Calculated fields can only live in the values zone
      if (dragField.sourceIndex === -2 && zone !== 'values') {
        return;
      }

      // Remove from source zone if moving between zones
      if (dragField.fromZone && dragField.fromIndex !== undefined) {
        const sourceSetter = getZoneSetter(dragField.fromZone);
        sourceSetter((prev) => prev.filter((_, i) => i !== dragField.fromIndex));
      }

      // Create zone field
      const isBiField = dragField.sourceIndex === -1;
      const zoneField: ZoneField = {
        sourceIndex: dragField.sourceIndex,
        name: dragField.name,
        isNumeric: dragField.isNumeric,
        aggregation:
          zone === 'values'
            ? getDefaultAggregation(dragField.isNumeric)
            : undefined,
        customName: isBiField ? dragField.name : undefined,
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

  // Keep a stable ref to handleRemove for the drag-out removal callback
  const handleRemoveRef = useRef(handleRemove);
  handleRemoveRef.current = handleRemove;

  // Register drag-out removal: when a field pill is dragged out of a zone
  // and released in empty space, remove it from the report
  useEffect(() => {
    return registerDragOutRemoval((field: DragField) => {
      if (field.fromZone !== undefined && field.fromIndex !== undefined) {
        handleRemoveRef.current(field.fromZone, field.fromIndex);
      }
    });
  }, []);

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
                numberFormat: settings.numberFormat,
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

  // Broadcast layout state to the Design ribbon tab
  useEffect(() => {
    if (isInitialMount.current) return;
    emitAppEvent(PivotEvents.PIVOT_LAYOUT_STATE, { pivotId, layout });
  }, [pivotId, layout]);

  // Also broadcast on initial mount so the Design tab picks up existing state
  useEffect(() => {
    emitAppEvent(PivotEvents.PIVOT_LAYOUT_STATE, { pivotId, layout });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pivotId]);

  // Respond to layout state requests from the Design tab (e.g. when it remounts
  // after the user switches away and back to the Design ribbon tab)
  useEffect(() => {
    return onAppEvent(PivotEvents.PIVOT_REQUEST_LAYOUT, () => {
      emitAppEvent(PivotEvents.PIVOT_LAYOUT_STATE, { pivotId, layout });
    });
  }, [pivotId, layout]);

  // Listen for layout changes from the Design ribbon tab
  useEffect(() => {
    return onAppEvent<{ pivotId: PivotId; layout: LayoutConfig }>(
      PivotEvents.PIVOT_LAYOUT_CHANGED,
      (detail) => {
        if (detail.pivotId === pivotId) {
          setLayout((prev) => ({
            ...detail.layout,
            // Preserve styleId from the previous state if already set
            styleId: detail.layout.styleId ?? prev.styleId,
          }));
          scheduleUpdate();
        }
      }
    );
  }, [pivotId, scheduleUpdate]);

  // Listen for filter applied events from the filter dropdown menu.
  // The filter dropdown bypasses the editor state (calls pivot.updateFields directly),
  // so we need to sync the hiddenItems back into our zone state.
  useEffect(() => {
    return onAppEvent<{
      pivotId: PivotId;
      fieldIndex: number;
      fieldName: string;
      hiddenItems?: string[];
      allValues?: string[];
    }>(PivotEvents.PIVOT_FILTER_APPLIED, (detail) => {
      if (detail.pivotId !== pivotId) return;

      // Store unique values for smart serialization (= vs NOT IN)
      if (detail.allValues && detail.fieldName) {
        filterUniqueValuesRef.current.set(detail.fieldName, detail.allValues);
      }

      setFilters((prev) =>
        prev.map((f) => {
          // Match by sourceIndex for regular pivots, by name for BI pivots (sourceIndex === -1)
          const isMatch = f.sourceIndex === -1
            ? f.name === detail.fieldName
            : f.sourceIndex === detail.fieldIndex;
          if (!isMatch) return f;
          return { ...f, hiddenItems: detail.hiddenItems };
        })
      );
      // Don't scheduleUpdate — the filter dropdown already sent the update to the backend
    });
  }, [pivotId]);

  // Handle moving a field from one zone to another (via pill menu)
  const handleMoveField = useCallback(
    (fromZone: DropZoneType, fromIndex: number, toZone: DropZoneType) => {
      // Calculated fields can only live in the values zone
      if (fromZone === 'values') {
        const field = values[fromIndex];
        if (field?.isCalculated && toZone !== 'values') return;
      }

      const fromSetter = getZoneSetter(fromZone);
      const toSetter = getZoneSetter(toZone);

      let movedField: ZoneField | undefined;

      fromSetter((prev) => {
        movedField = prev[fromIndex];
        return prev.filter((_, i) => i !== fromIndex);
      });

      // Use queueMicrotask to ensure removal state is processed before add
      queueMicrotask(() => {
        if (!movedField) return;
        const field = { ...movedField };

        if (toZone === 'values') {
          field.aggregation = field.aggregation ?? getDefaultAggregation(field.isNumeric);
        } else {
          field.aggregation = undefined;
          // Preserve customName for BI fields (sourceIndex === -1) since it's
          // the field identifier, not a user-set display name
          if (field.sourceIndex !== -1) {
            field.customName = undefined;
          }
          field.numberFormat = undefined;
          field.showValuesAs = undefined;
        }

        toSetter((prev) => [...prev, field]);
        scheduleUpdate();
      });
    },
    [getZoneSetter, scheduleUpdate]
  );

  // Drag handlers
  const handleDragStart = useCallback((field: DragField) => {
    setDraggingField(field);
  }, []);

  const handleDragEnd = useCallback(() => {
    setDraggingField(null);
  }, []);

  /** Mark that there are pending changes (for external callers like BI lookup toggle). */
  const markPendingChanges = useCallback(() => {
    setHasPendingChanges(true);
  }, []);

  /** Manually flush a deferred update (the "Update" button). */
  const flushUpdate = useCallback(() => {
    if (onUpdate) {
      setHasPendingChanges(false);
      onUpdate(buildUpdateRequest());
    }
  }, [onUpdate, buildUpdateRequest]);

  // When deferUpdate is turned OFF and there are pending changes, flush immediately
  const prevDeferRef = useRef(deferUpdate);
  useEffect(() => {
    if (prevDeferRef.current && !deferUpdate && hasPendingChanges) {
      // Defer was just unchecked with pending changes — flush now
      if (onUpdate) {
        setHasPendingChanges(false);
        onUpdate(buildUpdateRequest());
      }
    }
    prevDeferRef.current = deferUpdate;
  }, [deferUpdate, hasPendingChanges, onUpdate, buildUpdateRequest]);

  /**
   * Bulk-set all zones at once (for DSL editor sync).
   * Triggers a single update rather than five separate state changes.
   */
  const setAllZones = useCallback((
    newRows: ZoneField[],
    newColumns: ZoneField[],
    newValues: ZoneField[],
    newFilters: ZoneField[],
    newLayout: LayoutConfig,
    newCalculatedFields?: CalculatedFieldDef[],
    newValueColumnOrder?: ValueColumnRefDef[],
  ) => {
    // Merge calculated fields into the values array as ZoneField entries
    const mergedValues = [...newValues];
    if (newCalculatedFields && newCalculatedFields.length > 0) {
      for (const cf of newCalculatedFields) {
        mergedValues.push({
          sourceIndex: -2,
          name: cf.name,
          isNumeric: true,
          isCalculated: true,
          customName: cf.name,
          calculatedFormula: cf.formula,
          numberFormat: cf.numberFormat,
        });
      }
    }
    calculatedFieldsRef.current = newCalculatedFields;
    valueColumnOrderRef.current = newValueColumnOrder;
    setRows(newRows);
    setColumns(newColumns);
    setValues(mergedValues);
    setFilters(newFilters);
    setLayout(newLayout);
    scheduleUpdate();
  }, [scheduleUpdate]);

  /** Reset all zones to initial values (used on cancel to revert optimistic state). */
  const resetZones = useCallback(() => {
    // Prevent the useEffect from triggering an update for this reset
    isInitialMount.current = true;
    setRows(initialRows);
    setColumns(initialColumns);
    setValues(mergedInitialValues);
    setFilters(initialFilters);
    // Re-arm after React processes the state updates
    setTimeout(() => { isInitialMount.current = false; }, 0);
  }, [initialRows, initialColumns, mergedInitialValues, initialFilters]);

  return {
    sourceFields,
    usedFields,
    filters,
    columns,
    rows,
    values,
    layout,
    draggingField,
    deferUpdate,
    setDeferUpdate,
    hasPendingChanges,
    markPendingChanges,
    handleFieldToggle,
    handleDrop,
    handleRemove,
    handleReorder,
    handleMoveField,
    handleAggregationChange,
    handleValueFieldSettings,
    handleNumberFormatChange,
    handleFilterHiddenItemsChange,
    handleLayoutChange,
    handleDragStart,
    handleDragEnd,
    buildUpdateRequest,
    setAllZones,
    filterUniqueValues: filterUniqueValuesRef,
    calculatedFields: calculatedFieldsRef,
    flushUpdate,
    resetZones,
  };
}