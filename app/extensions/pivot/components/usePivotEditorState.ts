//! FILENAME: app/extensions/pivot/components/usePivotEditorState.ts
import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import type {
  SourceField,
  ZoneField,
  DragField,
  DropZoneType,
  AggregationType,
  LayoutConfig,
  UpdatePivotFieldsRequest,
  CalculatedFieldDef,
  ValueColumnRefDef,
  PivotId,
} from './types';
import { getDefaultAggregation } from './types';
import { emitAppEvent, onAppEvent } from '@api';
import { PivotEvents } from '../../_shared/lib/pivotEvents';
import { registerDragOutRemoval } from '../../_shared/components/useDragDrop';
import type { ValueFieldSettings } from './ValueFieldSettingsModal';
import { buildPivotFieldsRequest, mergeCalculatedIntoValues, replaceValueField, type PivotZones } from '../lib/pivotFieldsRequest';
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
  /** How the value and calculated columns interleave (definition.value_column_order);
   *  absent = values first, then the calculated fields. */
  initialValueColumnOrder?: ValueColumnRefDef[];
  onUpdate?: (request: UpdatePivotFieldsRequest, hiddenItemEdits: HiddenItemEditBatch) => void;
  /**
   * Read the pivot's row/column/filter fields as its definition holds them
   * NOW (null when it cannot be read). Called after each change of the
   * pivot's view, so the chips' item filters follow what the header dropdown,
   * the context menu, a slicer or a ribbon filter did to the pivot.
   */
  readPivotFields?: () => Promise<PivotHiddenItemsSnapshot | null>;
  /**
   * Read the pivot's four zones as its definition holds them NOW, seeded the
   * way the editor is (null when it cannot be read). Called when another door
   * changed the pivot's fields (`PivotEvents.PIVOT_FIELDS_EDITED_ELSEWHERE`:
   * the value-cell menu, a header's Remove), so the zones are re-seeded and
   * the next edit here does not send the old fields back (BUG-0466).
   */
  readPivotZones?: () => Promise<PivotZones | null>;
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
  initialValueColumnOrder,
  onUpdate,
  readPivotFields,
  readPivotZones,
}: UsePivotEditorStateOptions) {
  // Merge initial calculated fields into the values array as ZoneField entries,
  // each at its place in the pivot's column order (the ONE recipe the menu's
  // headless edits use too, lib/pivotFieldsRequest.ts). Appending them moved an
  // interleaved calculated column to the end on the first edit (BUG-0465).
  const mergedInitialValues = useMemo(
    () => mergeCalculatedIntoValues(initialValues, initialCalculatedFields, initialValueColumnOrder),
    [initialValues, initialCalculatedFields, initialValueColumnOrder],
  );

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
  const valueColumnOrderRef = useRef<ValueColumnRefDef[] | undefined>(
    initialValueColumnOrder && initialValueColumnOrder.length > 0 ? initialValueColumnOrder : undefined
  );

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

  // Another door changed this pivot's FIELDS (the value-cell menu's Remove /
  // Summarize Values By / Show Values As, a header's Remove): re-seed the
  // zones from the definition (BUG-0466). The editor seeds its zones once, and
  // every request it sends REPLACES the pivot's fields, so without this the
  // next edit in the open pane sent the pre-edit fields back and silently
  // undid the menu's change. Re-seeding sends nothing (no update is
  // scheduled); pending item-filter edits stay pending. Only the latest read
  // is applied, and none after the editor moved to another pivot.
  const readPivotZonesRef = useRef(readPivotZones);
  readPivotZonesRef.current = readPivotZones;
  // The zones of the last re-seed (null until one, and again after a switch to
  // another pivot): what `resetZones` goes back to after a failed request.
  const reseededZonesRef = useRef<PivotZones | null>(null);
  useEffect(() => {
    reseededZonesRef.current = null;
    let disposed = false;
    let latest = 0;
    const off = onAppEvent<{ pivotId?: PivotId }>(PivotEvents.PIVOT_FIELDS_EDITED_ELSEWHERE, (detail) => {
      if (detail?.pivotId === undefined || String(detail.pivotId) !== String(pivotId)) return;
      const read = readPivotZonesRef.current;
      if (!read) return;
      const mine = ++latest;
      read().then(
        (zones) => {
          if (disposed || mine !== latest || !zones) return;
          reseededZonesRef.current = zones;
          setRows(zones.rows);
          setColumns(zones.columns);
          setValues(zones.values);
          setFilters(zones.filters);
        },
        (err) => {
          console.warn("[PivotEditor] Could not re-read the pivot's fields after an edit made elsewhere:", err);
        },
      );
    });
    return () => {
      disposed = true;
      off();
    };
  }, [pivotId]);

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

  // Build the update request from current state -- through the ONE builder
  // the menu's headless value-field edits use too (lib/pivotFieldsRequest.ts).
  // The values array may interleave regular value fields and calculated fields
  // (isCalculated=true); the builder separates them and builds the ordering.
  // The chips' hidden items are DISPLAY lists: PivotEditor sends a real
  // field's list only when it was edited here (biFieldsRequest.ts), and the
  // chips re-read the pivot's definition after each view change
  // (syncHiddenItemsFromPivot) so the DSL shows what the pivot hides now.
  const buildUpdateRequest = useCallback((): UpdatePivotFieldsRequest => {
    const built = buildPivotFieldsRequest(pivotId, { rows, columns, values, filters }, layout);
    // Sync the refs so the DesignEditor serializer can access them
    calculatedFieldsRef.current = built.calculatedFields;
    valueColumnOrderRef.current = built.valueColumnOrder;
    return built.request;
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
      // A default name follows the aggregation ("Sum of Units" -> "Max of
      // Units"); replaceValueField carries the rename into calculated fields.
      setValues((prev) => (prev[index] ? replaceValueField(prev, index, { ...prev[index], aggregation }) : prev));
      scheduleUpdate();
    },
    [scheduleUpdate]
  );

  // Handle value field settings change (from modal)
  const handleValueFieldSettings = useCallback(
    (index: number, settings: ValueFieldSettings) => {
      // A new name (a custom one, or a default that follows the aggregation)
      // is carried into the calculated fields by replaceValueField.
      setValues((prev) =>
        prev[index]
          ? replaceValueField(prev, index, {
              ...prev[index],
              aggregation: settings.aggregation,
              customName: settings.customName,
              showValuesAs: settings.showValuesAs,
              numberFormat: settings.numberFormat,
              // A format the user CHANGED is an override from now on; the
              // one the model gave (shown unchanged in the modal) stays the
              // model's, so it is never frozen into an override (BUG-0478).
              numberFormatFromModel:
                prev[index].numberFormatFromModel === true && settings.numberFormat === prev[index].numberFormat
                  ? true
                  : undefined,
              // The base the calculation is relative to (kept, and sent as
              // the showAs rule; it was dropped here, e2e fixall-pivot X1).
              baseField: settings.baseField,
              baseItem: settings.baseItem,
            })
          : prev
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
          // The user chose it: an override, never the model's (BUG-0478).
          i === index ? { ...f, numberFormat: numberFormat || undefined, numberFormatFromModel: undefined } : f
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
          field.numberFormatFromModel = undefined;
          field.showValuesAs = undefined;
          field.baseField = undefined;
          field.baseItem = undefined;
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
    // Merge calculated fields into the values array as ZoneField entries, at
    // their place in the DSL's column order (an inline CALC between two
    // values stays between them; appending moved it to the end, BUG-0465).
    const mergedValues = mergeCalculatedIntoValues(newValues, newCalculatedFields, newValueColumnOrder);
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
    // The pivot's own state is the last re-seed when there was one (a field
    // edit made elsewhere since mount, BUG-0466), else the mount-time seed.
    const reseeded = reseededZonesRef.current;
    setRows(reseeded ? reseeded.rows : initialRows);
    setColumns(reseeded ? reseeded.columns : initialColumns);
    setValues(reseeded ? reseeded.values : mergedInitialValues);
    setFilters(reseeded ? reseeded.filters : initialFilters);
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