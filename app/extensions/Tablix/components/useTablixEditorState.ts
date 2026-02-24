//! FILENAME: app/extensions/Tablix/components/useTablixEditorState.ts
// PURPOSE: State management hook for the Tablix editor panel.
// CONTEXT: Manages zone fields, drag-and-drop, and update scheduling.
// Adapted from usePivotEditorState with Tablix-specific data field modes.

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import type {
  SourceField,
  ZoneField,
  DragField,
  DropZoneType,
  AggregationType,
} from '../../_shared/components/types';
import { getDefaultAggregation, getValueFieldDisplayName } from '../../_shared/components/types';
import { registerDragOutRemoval } from '../../_shared/components/useDragDrop';
import type { DataFieldMode, TablixId, TablixLayoutConfig } from '../types';
import type {
  UpdateTablixFieldsRequest,
  TablixFieldConfig,
  TablixDataFieldConfig,
} from '../lib/tablix-api';

interface UseTablixEditorStateOptions {
  tablixId: TablixId;
  sourceFields: SourceField[];
  initialRowGroups?: ZoneField[];
  initialColumnGroups?: ZoneField[];
  initialDataFields?: ZoneField[];
  initialFilters?: ZoneField[];
  initialLayout?: Partial<TablixLayoutConfig>;
  onUpdate?: (request: UpdateTablixFieldsRequest) => void;
}

export function useTablixEditorState({
  tablixId,
  sourceFields,
  initialRowGroups = [],
  initialColumnGroups = [],
  initialDataFields = [],
  initialFilters = [],
  initialLayout = {},
  onUpdate,
}: UseTablixEditorStateOptions) {
  const [rowGroups, setRowGroups] = useState<ZoneField[]>(initialRowGroups);
  const [columnGroups, setColumnGroups] = useState<ZoneField[]>(initialColumnGroups);
  const [dataFields, setDataFields] = useState<ZoneField[]>(initialDataFields);
  const [filters, setFilters] = useState<ZoneField[]>(initialFilters);
  const [layout, setLayout] = useState<Partial<TablixLayoutConfig>>(initialLayout);
  const [draggingField, setDraggingField] = useState<DragField | null>(null);

  // Track whether we should trigger an update (skip initial render)
  const isInitialMount = useRef(true);
  const pendingUpdate = useRef(false);

  // Track which fields are currently used in any zone
  const usedFields = useMemo(() => {
    const used = new Set<number>();
    [...rowGroups, ...columnGroups, ...dataFields, ...filters].forEach((f) =>
      used.add(f.sourceIndex)
    );
    return used;
  }, [rowGroups, columnGroups, dataFields, filters]);

  // Build the update request from current state
  const buildUpdateRequest = useCallback((): UpdateTablixFieldsRequest => {
    const rowGroupFields: TablixFieldConfig[] = rowGroups.map((f) => ({
      sourceIndex: f.sourceIndex,
      name: f.name,
    }));

    const columnGroupFields: TablixFieldConfig[] = columnGroups.map((f) => ({
      sourceIndex: f.sourceIndex,
      name: f.name,
    }));

    const dataFieldConfigs: TablixDataFieldConfig[] = dataFields.map((f) => {
      const mode: DataFieldMode = (f.mode as DataFieldMode) || 'aggregated';
      const aggregation = mode === 'aggregated'
        ? (f.aggregation ?? getDefaultAggregation(f.isNumeric))
        : undefined;
      const displayName = mode === 'aggregated'
        ? (f.customName || getValueFieldDisplayName(f.name, aggregation!))
        : f.name;
      return {
        sourceIndex: f.sourceIndex,
        name: displayName,
        mode,
        aggregation,
        numberFormat: f.numberFormat,
      };
    });

    const filterFields: TablixFieldConfig[] = filters.map((f) => ({
      sourceIndex: f.sourceIndex,
      name: f.name,
      hiddenItems: f.hiddenItems,
    }));

    return {
      tablixId,
      rowGroups: rowGroupFields,
      columnGroups: columnGroupFields,
      dataFields: dataFieldConfigs,
      filterFields,
      layout: layout as UpdateTablixFieldsRequest['layout'],
    };
  }, [tablixId, rowGroups, columnGroups, dataFields, filters, layout]);

  // Effect to trigger update when zones change
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }

    if (pendingUpdate.current && onUpdate) {
      pendingUpdate.current = false;
      console.log('[TablixEditor] Triggering update with current state:', {
        rowGroups: rowGroups.length,
        columnGroups: columnGroups.length,
        dataFields: dataFields.length,
      });
      onUpdate(buildUpdateRequest());
    }
  }, [rowGroups, columnGroups, dataFields, filters, layout, onUpdate, buildUpdateRequest]);

  // Mark that an update should be triggered after state changes
  const scheduleUpdate = useCallback(() => {
    pendingUpdate.current = true;
  }, []);

  // Map shared DropZoneType to Tablix zone setters:
  // 'filters' -> filters, 'columns' -> columnGroups,
  // 'rows' -> rowGroups, 'values' -> dataFields
  const getZoneSetter = useCallback(
    (zone: DropZoneType) => {
      switch (zone) {
        case 'filters':
          return setFilters;
        case 'columns':
          return setColumnGroups;
        case 'rows':
          return setRowGroups;
        case 'values':
          return setDataFields;
      }
    },
    []
  );

  // Handle field toggle from field list
  const handleFieldToggle = useCallback(
    (field: SourceField, checked: boolean) => {
      if (checked) {
        const zoneField: ZoneField = {
          sourceIndex: field.index,
          name: field.name,
          isNumeric: field.isNumeric,
          aggregation: field.isNumeric
            ? getDefaultAggregation(true)
            : undefined,
          mode: field.isNumeric ? 'aggregated' : undefined,
        };

        if (field.isNumeric) {
          // Numeric fields go to data fields with aggregated mode
          setDataFields((prev) => [...prev, zoneField]);
        } else {
          // Non-numeric fields go to row groups
          setRowGroups((prev) => [...prev, zoneField]);
        }
      } else {
        // Remove from all zones
        const removeFromZone = (prev: ZoneField[]) =>
          prev.filter((f) => f.sourceIndex !== field.index);

        setFilters(removeFromZone);
        setColumnGroups(removeFromZone);
        setRowGroups(removeFromZone);
        setDataFields(removeFromZone);
      }

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
        mode: zone === 'values' ? 'aggregated' : undefined,
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

  // Handle aggregation change for data fields
  const handleAggregationChange = useCallback(
    (index: number, aggregation: AggregationType) => {
      setDataFields((prev) =>
        prev.map((f, i) => (i === index ? { ...f, aggregation } : f))
      );
      scheduleUpdate();
    },
    [scheduleUpdate]
  );

  // Handle data field mode change (aggregated <-> detail)
  const handleDataFieldModeChange = useCallback(
    (index: number, mode: DataFieldMode) => {
      setDataFields((prev) =>
        prev.map((f, i) => {
          if (i !== index) return f;
          if (mode === 'aggregated') {
            return {
              ...f,
              mode: 'aggregated',
              aggregation: f.aggregation ?? getDefaultAggregation(f.isNumeric),
            };
          }
          return {
            ...f,
            mode: 'detail',
            aggregation: undefined,
          };
        })
      );
      scheduleUpdate();
    },
    [scheduleUpdate]
  );

  // Handle number format change for data field
  const handleNumberFormatChange = useCallback(
    (index: number, numberFormat: string) => {
      setDataFields((prev) =>
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
    (newLayout: Partial<TablixLayoutConfig>) => {
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
    columnGroups,
    rowGroups,
    dataFields,
    layout,
    draggingField,
    handleFieldToggle,
    handleDrop,
    handleRemove,
    handleReorder,
    handleAggregationChange,
    handleDataFieldModeChange,
    handleNumberFormatChange,
    handleFilterHiddenItemsChange,
    handleLayoutChange,
    handleDragStart,
    handleDragEnd,
    buildUpdateRequest,
  };
}
