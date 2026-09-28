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
import { PivotEvents } from '../../_shared/lib/pivotEvents';
import { registerDragOutRemoval } from '../../_shared/components/useDragDrop';
import type { ValueFieldSettings } from './ValueFieldSettingsModal';
import {
  diffHiddenItemEdits,
  reconcileChipHiddenItems,
  sameHiddenItems,
  type HiddenItemEdits,
  type PivotHiddenItemsSnapshot,
} from './biFieldsRequest';

/**
 * The item-filter edits one request carries (see `biFieldsRequest.ts`), and
 * how to retire them once the backend has taken the request.
 */
export interface HiddenItemEditBatch {
  /** Field name -> hidden items to send (`[]` = the filter was removed). */
  edits: HiddenItemEdits;
  /**
   * Call after the backend ACCEPTED the request that carried `edits`: forgets
   * each edit unless a newer edit of the same field replaced it meanwhile. An
   * edit whose request failed or was superseded stays pending, so the next
   * request sends it again instead of losing it.
   */
  acknowledge: () => void;
}

interface UsePivotEditorStateOptions {
  pivotId: PivotId;
  sourceFields: SourceField[];
  initialRows?: ZoneField[];
  initialColumns?: ZoneField[];
  initialValues?: ZoneField[];
  initialFilters?: ZoneField[];
  initialLayout?: LayoutConfig;
  initialCalculatedFields?: CalculatedFieldDef[];
  onUpdate?: (request: UpdatePivotFieldsRequest, hiddenItemEdits: HiddenItemEditBatch) => void;
  /**
   * Read the pivot's row/column/filter fields as its definition holds them
   * NOW (null when it cannot be read). Called after each change of the
   * pivot's view, so the chips' item filters follow what the header dropdown,
   * the context menu, a slicer or a ribbon filter did to the pivot.
   */
  readPivotFields?: () => Promise<PivotHiddenItemsSnapshot | null>;
}

/** The zones that carry item filters. */
type FilterZones = { rows: ZoneField[]; columns: ZoneField[]; filters: ZoneField[] };

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
  readPivotFields,
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

  // Item-filter edits the user made in THIS editor that the backend has not
  // acknowledged yet: field name -> the hidden items to send ([] = removed).
  // Only these reach the wire as a field's hidden items -- a chip's own list
  // is for display and may be stale (biFieldsRequest.ts explains why).
  const hiddenItemEditsRef = useRef<Map<string, string[]>>(new Map());
  // The zones as last rendered, for the edit bookkeeping below (read outside
  // a state updater, so a StrictMode double-invoke cannot record twice).
  const zonesRef = useRef<FilterZones>({
    rows: initialRows,
    columns: initialColumns,
    filters: initialFilters,
  });
  zonesRef.current = { rows, columns, filters };

  // Bumped whenever a request is built or acknowledged: a read of the pivot's
  // definition that was in flight across either may describe the pivot from
  // BEFORE the request, and is re-read rather than trusted (see the re-sync
  // effect below).
  const editGenerationRef = useRef(0);

  /** Record that the user set `name`'s item filter to `hidden` in the editor. */
  const recordHiddenItemEdit = useCallback((name: string, hidden: readonly string[]) => {
    hiddenItemEditsRef.current.set(name, [...hidden]);
  }, []);

  /**
   * A field LEAVES the zones: forget the pending edit of every field that is
   * not placed in `next` (rows, columns and filters as they will be after this
   * change). Re-adding a field later is not an item-filter edit and must not
   * resend a filter from before it left -- and under Defer Layout Update no
   * request runs between the removal and the re-add, so waiting for the next
   * take to prune it was too late (review3 finding 4).
   */
  const forgetEditsOfUnplaced = useCallback((next: FilterZones) => {
    const pending = hiddenItemEditsRef.current;
    if (pending.size === 0) return;
    const placed = new Set([...next.rows, ...next.columns, ...next.filters].map((z) => z.name));
    for (const name of [...pending.keys()]) {
      if (!placed.has(name)) pending.delete(name);
    }
  }, []);

  /**
   * The edits the next request carries. Edits of a field no longer placed in
   * any zone are dropped first: re-adding a field later is not an item-filter
   * edit, and must not resend a filter from before it left.
   */
  const takeHiddenItemEdits = useCallback((): HiddenItemEditBatch => {
    forgetEditsOfUnplaced(zonesRef.current);
    editGenerationRef.current++;
    const snapshot = new Map<string, string[]>();
    for (const [name, hidden] of hiddenItemEditsRef.current) snapshot.set(name, [...hidden]);
    return {
      edits: snapshot,
      acknowledge: () => {
        editGenerationRef.current++;
        for (const [name, sent] of snapshot) {
          const now = hiddenItemEditsRef.current.get(name);
          if (now !== undefined && sameHiddenItems(now, sent)) {
            hiddenItemEditsRef.current.delete(name);
          }
        }
      },
    };
  }, [forgetEditsOfUnplaced]);

  /**
   * The chips' item filters, brought up to the pivot's definition (a chip the
   * user has a pending edit on keeps it). Display only: no request is sent.
   */
  const syncHiddenItemsFromPivot = useCallback((snapshot: PivotHiddenItemsSnapshot) => {
    const reconcile = (prev: ZoneField[]) =>
      reconcileChipHiddenItems(prev, snapshot, hiddenItemEditsRef.current);
    setRows(reconcile);
    setColumns(reconcile);
    setFilters(reconcile);
  }, []);

  // Re-read the pivot's definition after each change of its VIEW (a field
  // edit, a filter, a slicer, a refresh: `PIVOT_VIEW_UPDATED`) and bring the
  // chips' item filters up to it. One read at a time; a view change during a
  // read asks for one more. A read that a request was built or acknowledged
  // across is not trusted -- it may describe the pivot from before that
  // request -- and is repeated. The view's version is the definition's, so a
  // re-fetch of an unchanged pivot (every grid refresh re-fetches views) does
  // not read at all.
  const readPivotFieldsRef = useRef(readPivotFields);
  readPivotFieldsRef.current = readPivotFields;
  useEffect(() => {
    let disposed = false;
    let reading = false;
    let readAgain = false;
    let lastVersion: number | undefined;
    const readAndSync = async (): Promise<void> => {
      if (reading) {
        readAgain = true;
        return;
      }
      reading = true;
      try {
        // Bounded: a request cannot be built or acknowledged forever.
        for (let attempt = 0; attempt < 5 && !disposed; attempt++) {
          readAgain = false;
          const read = readPivotFieldsRef.current;
          if (!read) return;
          const generation = editGenerationRef.current;
          let snapshot: PivotHiddenItemsSnapshot | null = null;
          try {
            snapshot = await read();
          } catch (err) {
            console.warn('[PivotEditor] Could not re-read the pivot\'s fields:', err);
            return;
          }
          if (disposed) return;
          if (editGenerationRef.current !== generation) continue;
          if (snapshot) syncHiddenItemsFromPivot(snapshot);
          if (!readAgain) return;
        }
      } finally {
        reading = false;
      }
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = onAppEvent<{ pivotId: PivotId; version?: number }>(
      PivotEvents.PIVOT_VIEW_UPDATED,
      (detail) => {
        if (detail?.pivotId !== pivotId) return;
        if (detail.version !== undefined && detail.version === lastVersion) return;
        lastVersion = detail.version;
        // The editor's OWN request announces its view before the request
        // resolves and is acknowledged; starting the read a task later lets
        // the acknowledgement land first, so that read is not thrown away.
        if (timer !== null) return;
        timer = setTimeout(() => {
          timer = null;
          void readAndSync();
        }, 0);
      },
    );
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      off();
    };
  }, [pivotId, syncHiddenItemsFromPivot]);

  // When the pivotId changes (e.g. a new pivot is created after deleting the
  // old one), reset zone state to the new initial values. Without this,
  // useState keeps the previous pivot's field configuration.
  const prevPivotId = useRef(pivotId);
  useEffect(() => {
    if (prevPivotId.current !== pivotId) {
      prevPivotId.current = pivotId;
      isInitialMount.current = true;
      hiddenItemEditsRef.current.clear();
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
    // Row/column fields carry hiddenItems too (a placed calculation group's
    // item subset rides on its chip like a field filter). For a BI pivot
    // these are the chips' DISPLAY lists: PivotEditor's BI request sends a
    // real field's list only when it was edited here (biFieldsRequest.ts).
    // A RANGE pivot's `update_pivot_fields` reads an absent list as CLEAR,
    // so it must send every chip's list -- which is why the chips re-read the
    // pivot's definition after each view change (syncHiddenItemsFromPivot):
    // a list the header dropdown or a slicer changed is echoed as it is now,
    // not as it was when the pane mounted.
    const rowFields: PivotFieldConfig[] = rows.map((f) => ({
      sourceIndex: f.sourceIndex,
      name: f.name,
      hiddenItems: f.hiddenItems,
    }));

    const columnFields: PivotFieldConfig[] = columns.map((f) => ({
      sourceIndex: f.sourceIndex,
      name: f.name,
      hiddenItems: f.hiddenItems,
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
        // For BI fields, keep the original [MeasureName] in `name` so
        // toBiValueFieldRef can extract the real measure name for the backend.
        // The custom display name travels separately via `customName`.
        const displayName = isBiField
          ? f.name
          : (f.customName || getValueFieldDisplayName(f.name, aggregation));
        regularValues.push({
          sourceIndex: f.sourceIndex,
          name: displayName,
          aggregation,
          numberFormat: f.numberFormat,
          showValuesAs: f.showValuesAs as ShowValuesAs | undefined,
          customName: f.customName || undefined,
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
        onUpdate(buildUpdateRequest(), takeHiddenItemEdits());
      }
    }
  }, [rows, columns, values, filters, layout, onUpdate, buildUpdateRequest, deferUpdate, takeHiddenItemEdits]);

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
        const isHierarchyField = field.index === -3;
        const zoneField: ZoneField = {
          sourceIndex: field.index,
          name: field.name,
          isNumeric: field.isNumeric,
          aggregation: field.isNumeric
            ? getDefaultAggregation(true)
            : undefined,
          customName: (isBiField || isHierarchyField) ? field.name : undefined,
        };

        if (field.isNumeric) {
          setValues((prev) => [...prev, zoneField]);
        } else {
          setRows((prev) => [...prev, zoneField]);
        }
      } else {
        // Remove from all zones — use name-based match for BI/hierarchy fields
        const useNameMatch = field.index === -1 || field.index === -3;
        const removeFromZone = (prev: ZoneField[]) =>
          prev.filter((f) =>
            useNameMatch ? f.name !== field.name : f.sourceIndex !== field.index
          );

        const z = zonesRef.current;
        forgetEditsOfUnplaced({
          rows: removeFromZone(z.rows),
          columns: removeFromZone(z.columns),
          filters: removeFromZone(z.filters),
        });
        setFilters(removeFromZone);
        setColumns(removeFromZone);
        setRows(removeFromZone);
        setValues(removeFromZone);
      }

      // Schedule update to run after state is updated
      scheduleUpdate();
    },
    [scheduleUpdate, forgetEditsOfUnplaced]
  );

  /**
   * Rows, columns and filters as they will be after removing `fromIndex` of
   * `fromZone` (when given) and adding `added` to `toZone` (when given). For
   * the pending-edit bookkeeping, which must know what is still placed.
   */
  const zonesAfter = useCallback(
    (
      from?: { zone: DropZoneType; index: number },
      to?: { zone: DropZoneType; field: ZoneField },
    ): FilterZones => {
      const next: FilterZones = { ...zonesRef.current };
      if (from && from.zone !== 'values') {
        next[from.zone] = next[from.zone].filter((_, i) => i !== from.index);
      }
      if (to && to.zone !== 'values') {
        next[to.zone] = [...next[to.zone], to.field];
      }
      return next;
    },
    []
  );

  // Handle drop into a zone
  const handleDrop = useCallback(
    (zone: DropZoneType, dragField: DragField, insertIndex?: number) => {
      // Calculated fields can only live in the values zone
      if (dragField.sourceIndex === -2 && zone !== 'values') {
        return;
      }

      // A chip MOVED from another zone keeps its item filter (and LOOKUP
      // flag), as the context menu's Move does: a calculation group's item
      // subset lives only on its chip, and a range pivot's request sends the
      // chip's list -- a fresh chip reset the subset to every item and cleared
      // the range field's filter (review3 finding 5).
      const moving = dragField.fromZone !== undefined && dragField.fromIndex !== undefined;
      const source = moving && dragField.fromZone !== 'values'
        ? zonesRef.current[dragField.fromZone!][dragField.fromIndex!]
        : undefined;
      const carried: Partial<ZoneField> =
        source && source.name === dragField.name && zone !== 'values'
          ? {
              ...(source.hiddenItems !== undefined ? { hiddenItems: [...source.hiddenItems] } : {}),
              ...(source.isLookup !== undefined ? { isLookup: source.isLookup } : {}),
            }
          : {};

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
        ...carried,
      };

      forgetEditsOfUnplaced(
        zonesAfter(
          moving ? { zone: dragField.fromZone!, index: dragField.fromIndex! } : undefined,
          { zone, field: zoneField },
        ),
      );

      // Remove from source zone if moving between zones
      if (moving) {
        const sourceSetter = getZoneSetter(dragField.fromZone!);
        sourceSetter((prev) => prev.filter((_, i) => i !== dragField.fromIndex));
      }

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
    [getZoneSetter, scheduleUpdate, forgetEditsOfUnplaced, zonesAfter]
  );

  // Handle remove from zone
  const handleRemove = useCallback(
    (zone: DropZoneType, index: number) => {
      forgetEditsOfUnplaced(zonesAfter({ zone, index }));
      const setter = getZoneSetter(zone);
      setter((prev) => prev.filter((_, i) => i !== index));
      scheduleUpdate();
    },
    [getZoneSetter, scheduleUpdate, forgetEditsOfUnplaced, zonesAfter]
  );

  // Set the hidden-items subset on a zone field wherever it is placed
  // (rows/columns/filters). Used by the calculation-group item checkboxes;
  // works for any name-matched field. A cleared subset is stored as `[]`,
  // never `undefined`: on the wire "none" means KEEP, `[]` means clear.
  const setZoneFieldHiddenItems = useCallback(
    (name: string, hiddenItems: string[] | undefined) => {
      const next = hiddenItems ?? [];
      const apply = (prev: ZoneField[]) =>
        prev.map((f) => (f.name === name ? { ...f, hiddenItems: [...next] } : f));
      setRows(apply);
      setColumns(apply);
      setFilters(apply);
      recordHiddenItemEdit(name, next);
      scheduleUpdate();
    },
    [scheduleUpdate, recordHiddenItemEdit]
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

  // Handle filter change (update hidden items for a filter field). A cleared
  // filter is stored -- and sent -- as `[]`: `undefined` would read as "keep".
  const handleFilterHiddenItemsChange = useCallback(
    (filterIndex: number, hiddenItems: string[]) => {
      const field = zonesRef.current.filters[filterIndex];
      setFilters((prev) =>
        prev.map((f, i) => (i === filterIndex ? { ...f, hiddenItems: [...hiddenItems] } : f))
      );
      if (field) recordHiddenItemEdit(field.name, hiddenItems);
      scheduleUpdate();
    },
    [scheduleUpdate, recordHiddenItemEdit]
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

  // Listen for filter applied events from the report-filter dropdown menu.
  // The dropdown filters the pivot itself (apply/clear_pivot_filter), so we
  // sync its hiddenItems -- and the field's full item list, which the DSL
  // needs to write and read `= (...)` -- back into our zone state. (The
  // definition re-read after the view change would bring the list too; this
  // is the immediate path, and the only one that knows the item list.)
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

      // Match by sourceIndex for regular pivots, by name for BI pivots (sourceIndex === -1)
      const isMatch = (f: ZoneField) =>
        f.sourceIndex === -1 ? f.name === detail.fieldName : f.sourceIndex === detail.fieldIndex;
      // The dropdown just put this filter on the pivot itself: an older,
      // unsent editor edit of the same field must not overwrite it later.
      for (const f of zonesRef.current.filters) {
        if (isMatch(f)) hiddenItemEditsRef.current.delete(f.name);
      }
      // A cleared dropdown arrives as no list: store `[]` (cleared), not
      // `undefined`.
      setFilters((prev) =>
        prev.map((f) => (isMatch(f) ? { ...f, hiddenItems: detail.hiddenItems ?? [] } : f))
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

      // Moving into Values takes the field out of the zones that filter.
      const movedNow = fromZone !== 'values' ? zonesRef.current[fromZone][fromIndex] : undefined;
      forgetEditsOfUnplaced(
        zonesAfter(
          { zone: fromZone, index: fromIndex },
          movedNow ? { zone: toZone, field: movedNow } : undefined,
        ),
      );

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
    [getZoneSetter, scheduleUpdate, forgetEditsOfUnplaced, zonesAfter]
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
      onUpdate(buildUpdateRequest(), takeHiddenItemEdits());
    }
  }, [onUpdate, buildUpdateRequest, takeHiddenItemEdits]);

  // When deferUpdate is turned OFF and there are pending changes, flush immediately
  const prevDeferRef = useRef(deferUpdate);
  useEffect(() => {
    if (prevDeferRef.current && !deferUpdate && hasPendingChanges) {
      // Defer was just unchecked with pending changes — flush now
      if (onUpdate) {
        setHasPendingChanges(false);
        onUpdate(buildUpdateRequest(), takeHiddenItemEdits());
      }
    }
    prevDeferRef.current = deferUpdate;
  }, [deferUpdate, hasPendingChanges, onUpdate, buildUpdateRequest, takeHiddenItemEdits]);

  /**
   * Bulk-set all zones at once (for DSL editor sync).
   * Triggers a single update rather than five separate state changes.
   *
   * The DSL is the editor's one item-filter control for real row, column and
   * filter fields, so this is where their edits are recorded: each incoming
   * field is compared with the previous zone entry of the same name
   * (`diffHiddenItemEdits`). A deleted `NOT IN` clause is stored and sent as
   * `[]`; a changed one as the new list; an untouched field sends nothing and
   * keeps whatever the pivot hides now (a slicer's, the header dropdown's).
   *
   * `unresolvedFilters` names the filter fields whose inclusion list the DSL
   * could not turn into hidden items (dslCompile.ts): they are NO edit and
   * keep their current list -- the compiler hands them back with no list,
   * which would otherwise read as a deleted clause and CLEAR the filter.
   * A field the new zones no longer place loses its pending edit.
   */
  const setAllZones = useCallback((
    newRows: ZoneField[],
    newColumns: ZoneField[],
    newValues: ZoneField[],
    newFilters: ZoneField[],
    newLayout: LayoutConfig,
    newCalculatedFields?: CalculatedFieldDef[],
    newValueColumnOrder?: ValueColumnRefDef[],
    unresolvedFilters?: ReadonlySet<string>,
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
    const before = zonesRef.current;
    const previous = [...before.rows, ...before.columns, ...before.filters];
    const settledRows = diffHiddenItemEdits(previous, newRows);
    const settledColumns = diffHiddenItemEdits(previous, newColumns);
    const settledFilters = diffHiddenItemEdits(previous, newFilters, unresolvedFilters);
    for (const settled of [settledRows, settledColumns, settledFilters]) {
      for (const [name, hidden] of settled.edits) recordHiddenItemEdit(name, hidden);
    }
    // A second DSL apply before the next render compares with THIS one.
    zonesRef.current = {
      rows: settledRows.fields,
      columns: settledColumns.fields,
      filters: settledFilters.fields,
    };
    forgetEditsOfUnplaced(zonesRef.current);
    setRows(settledRows.fields);
    setColumns(settledColumns.fields);
    setValues(mergedValues);
    setFilters(settledFilters.fields);
    setLayout(newLayout);
    scheduleUpdate();
  }, [scheduleUpdate, recordHiddenItemEdit, forgetEditsOfUnplaced]);

  /** Reset all zones to initial values (used on cancel to revert optimistic state). */
  const resetZones = useCallback(() => {
    // Prevent the useEffect from triggering an update for this reset
    isInitialMount.current = true;
    // The edits belonged to the cancelled change; the zones go back to the
    // pivot's own state, so there is nothing left to send.
    hiddenItemEditsRef.current.clear();
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
    setZoneFieldHiddenItems,
    setAllZones,
    takeHiddenItemEdits,
    filterUniqueValues: filterUniqueValuesRef,
    calculatedFields: calculatedFieldsRef,
    flushUpdate,
    resetZones,
  };
}