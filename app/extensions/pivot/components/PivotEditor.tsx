//! FILENAME: app/extensions/pivot/components/PivotEditor.tsx
import React, { useCallback, useRef, useState, useEffect, useMemo } from 'react';
import { styles } from './PivotEditor.styles';
import { FieldList } from './FieldList';
import { DropZones } from './DropZones';
import { ValueFieldSettingsModal, type ValueFieldSettings } from './ValueFieldSettingsModal';
import { NumberFormatModal } from './NumberFormatModal';
import { usePivotEditorState } from './usePivotEditorState';
import { pivot } from '../../../src/api/pivot';
import { TableFieldList } from '../../_shared/components/TableFieldList';
import type {
  SourceField,
  ZoneField,
  LayoutConfig,
  UpdatePivotFieldsRequest,
  UpdateBiPivotFieldsRequest,
  BiPivotModelInfo,
  BiFieldRef,
  BiValueFieldRef,
  MeasureField,
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
  biModel?: BiPivotModelInfo;
  onClose?: () => void;
  onViewUpdate?: () => void;
}

/** Parse a BI field key "Table.Column" into a BiFieldRef, optionally marking as lookup */
function toBiFieldRef(name: string, isLookup?: boolean): BiFieldRef {
  const dotIndex = name.indexOf('.');
  if (dotIndex === -1) return { table: '', column: name, isLookup };
  return { table: name.substring(0, dotIndex), column: name.substring(dotIndex + 1), isLookup };
}

/** Parse a BI measure field key "[MeasureName]" into a BiValueFieldRef */
function toBiValueFieldRef(name: string): BiValueFieldRef {
  // Strip brackets: "[Revenue]" -> "Revenue"
  const measureName = name.startsWith('[') && name.endsWith(']')
    ? name.substring(1, name.length - 1)
    : name;
  return { measureName };
}

export function PivotEditor({
  pivotId,
  sourceFields,
  initialRows = [],
  initialColumns = [],
  initialValues = [],
  initialFilters = [],
  initialLayout = {},
  biModel,
  onClose,
  onViewUpdate,
}: PivotEditorProps): React.ReactElement {
  const isBiPivot = !!biModel;

  // Modal state
  const [valueSettingsIndex, setValueSettingsIndex] = useState<number | null>(null);
  const [numberFormatIndex, setNumberFormatIndex] = useState<number | null>(null);

  // Lookup state: tracks which columns are in LOOKUP mode (vs GROUP).
  // Key format: "TableName.ColumnName"
  // Initialize from: 1) biModel.lookupColumns (full persisted set, including
  // fields not in zones), 2) zone fields with isLookup flag as fallback.
  const [lookupColumns, setLookupColumns] = useState<Set<string>>(() => {
    const set = new Set<string>();
    // Primary source: full persisted set from backend
    if (biModel?.lookupColumns) {
      for (const key of biModel.lookupColumns) {
        set.add(key);
      }
    }
    // Fallback: zone fields with isLookup (covers edge cases)
    for (const f of [...initialRows, ...initialColumns, ...initialFilters]) {
      if (f.isLookup) {
        set.add(f.name);
      }
    }
    return set;
  });

  // Ref to resetZones (set after usePivotEditorState, used in handleUpdate catch)
  const resetZonesRef = useRef<(() => void) | null>(null);

  const handleUpdate = useCallback(async (request: UpdatePivotFieldsRequest) => {
    try {
      const t0 = performance.now();

      if (isBiPivot) {
        // Filter out synthetic "Total" field (internal pivot engine detail)
        // and any field without a "Table.Column" format (no dot = not a real BI field)
        const isRealBiField = (f: { name: string }) => f.name.includes('.');
        // Convert the generic UpdatePivotFieldsRequest to BI-specific request.
        // Mark fields as lookup based on the lookupColumns state.
        const toBiRef = (f: { name: string }) =>
          toBiFieldRef(f.name, lookupColumns.has(f.name));
        const biRequest: UpdateBiPivotFieldsRequest = {
          pivotId: request.pivotId,
          rowFields: (request.rowFields ?? []).filter(isRealBiField).map(toBiRef),
          columnFields: (request.columnFields ?? []).filter(isRealBiField).map(toBiRef),
          valueFields: (request.valueFields ?? []).map((f) => toBiValueFieldRef(f.name)),
          filterFields: (request.filterFields ?? []).filter(isRealBiField).map(toBiRef),
          layout: request.layout,
          lookupColumns: [...lookupColumns],
        };
        await pivot.updateBiFields(biRequest);
      } else {
        await pivot.updateFields(request);
      }

      const ipcMs = performance.now() - t0;
      // Notify parent that the pivot view has been updated
      if (onViewUpdate) {
        onViewUpdate();
      }
      const totalMs = performance.now() - t0;
      console.log(
        `[PERF][pivot] handleUpdate pivot_id=${request.pivotId} bi=${isBiPivot} | ipc=${ipcMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms`
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("cancelled")) {
        // User cancelled — revert the optimistic zone state
        resetZonesRef.current?.();
      } else {
        console.error('Failed to update pivot fields:', error);
      }
    }
  }, [isBiPivot, lookupColumns, onViewUpdate]);

  const {
    usedFields,
    filters,
    columns,
    rows,
    values,
    handleFieldToggle,
    handleDrop,
    handleRemove,
    handleReorder,
    handleAggregationChange,
    handleMoveField,
    handleValueFieldSettings,
    handleNumberFormatChange,
    handleDragStart,
    handleDragEnd,
    resetZones,
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

  // Wire up the reset ref so handleUpdate's catch block can access it
  resetZonesRef.current = resetZones;

  // BI-specific: compute used columns ("Table.Column" keys) and used measures
  const usedColumnsSet = useMemo(() => {
    if (!isBiPivot) return new Set<string>();
    const set = new Set<string>();
    for (const f of [...rows, ...columns, ...filters]) {
      set.add(f.name); // name is "Table.Column" for BI fields
    }
    return set;
  }, [isBiPivot, rows, columns, filters]);

  const usedMeasuresSet = useMemo(() => {
    if (!isBiPivot) return new Set<string>();
    const set = new Set<string>();
    for (const f of values) {
      // Strip brackets: "[Revenue]" -> "Revenue"
      const name = f.name.startsWith('[') && f.name.endsWith(']')
        ? f.name.substring(1, f.name.length - 1)
        : f.name;
      set.add(name);
    }
    return set;
  }, [isBiPivot, values]);

  // BI lookup toggle: switch a column between GROUP and LOOKUP mode.
  // Guardrail: a LOOKUP field requires at least one GROUP field from the same table.
  // Toggling triggers a pivot refresh so the query is rebuilt.
  const handleLookupToggle = useCallback(
    (table: string, column: string) => {
      const colKey = `${table}.${column}`;
      const isCurrentlyLookup = lookupColumns.has(colKey);

      // If toggling TO lookup, enforce the guardrail only when the field
      // is currently in a zone. A LOOKUP field requires at least one GROUP
      // field from the same table in some zone. For fields not yet in any
      // zone we allow the toggle freely — the constraint will be checked
      // when the field is actually added.
      if (!isCurrentlyLookup) {
        const allZoneFields = [...rows, ...columns, ...filters];
        const isFieldInZone = allZoneFields.some((f) => f.name === colKey);
        if (isFieldInZone) {
          const sameTableGroupFields = allZoneFields.filter((f) => {
            if (!f.name.includes('.')) return false;
            const fieldTable = f.name.substring(0, f.name.indexOf('.'));
            const fieldKey = f.name;
            return fieldTable === table && fieldKey !== colKey && !lookupColumns.has(fieldKey);
          });
          if (sameTableGroupFields.length === 0) {
            console.warn(
              `Cannot set ${colKey} to LOOKUP: no GROUP field from table '${table}' in any zone`
            );
            return;
          }
        }
      }

      setLookupColumns((prev) => {
        const next = new Set(prev);
        if (next.has(colKey)) {
          next.delete(colKey);
        } else {
          next.add(colKey);
        }
        return next;
      });
    },
    [lookupColumns, rows, columns, filters]
  );

  // BI column toggle: add/remove dimension field
  const handleBiColumnToggle = useCallback(
    (table: string, column: string, _isNumeric: boolean, checked: boolean) => {
      const fieldName = `${table}.${column}`;
      // Create a synthetic SourceField for the toggle handler.
      // Always set isNumeric=false so columns go to Rows (dimensions),
      // not Values. Only measures (via handleBiMeasureToggle) go to Values.
      const field: SourceField = {
        index: -1,  // BI fields use name-based references
        name: fieldName,
        isNumeric: false,
      };
      handleFieldToggle(field, checked);
    },
    [handleFieldToggle]
  );

  // BI measure toggle: add/remove measure to Values zone
  const handleBiMeasureToggle = useCallback(
    (measure: MeasureField, checked: boolean) => {
      const fieldName = `[${measure.name}]`;
      const field: SourceField = {
        index: -1,  // BI fields use name-based references
        name: fieldName,
        isNumeric: true, // Measures are always numeric
      };
      handleFieldToggle(field, checked);
    },
    [handleFieldToggle]
  );

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

  // Re-trigger pivot update when lookup state changes (only for BI pivots with active fields).
  // Only fires when the change affects a field that is currently in a zone — avoids
  // a race condition where toggling a badge on a field not yet in a zone would start
  // a concurrent BI query that conflicts with the subsequent field-add query.
  // Persist lookup columns to backend whenever they change.
  // Uses a lightweight command (no BI query) for metadata-only updates,
  // and only triggers a full re-query if the change affects a field in a zone.
  const lookupColumnsRef = React.useRef(lookupColumns);
  useEffect(() => {
    // Skip the initial render
    if (lookupColumnsRef.current === lookupColumns) return;
    const prevLookup = lookupColumnsRef.current;
    lookupColumnsRef.current = lookupColumns;

    if (!isBiPivot) return;

    // Always persist the full lookup set via the lightweight command
    // (no BI query, no grid update, no re-mount).
    pivot.setBiLookupColumns(pivotId, [...lookupColumns]).catch((err) => {
      console.error('Failed to persist lookup columns:', err);
    });

    // Only trigger a full BI re-query if the change affects a field in a zone
    // AND there are active dimension + value fields.
    const hasDimensions = rows.length > 0 || columns.length > 0;
    const hasValues = values.length > 0;
    if (!hasDimensions || !hasValues) return;

    const allZoneKeys = new Set(
      [...rows, ...columns, ...filters].map((f) => f.name)
    );
    const changed = [...lookupColumns].filter((k) => !prevLookup.has(k))
      .concat([...prevLookup].filter((k) => !lookupColumns.has(k)));
    const affectsZone = changed.some((k) => allZoneKeys.has(k));
    if (!affectsZone) return;

    // Build and send the update request directly (same as handleUpdate logic)
    const isRealBiField = (f: { name: string }) => f.name.includes('.');
    const toBiRef = (f: { name: string }) =>
      toBiFieldRef(f.name, lookupColumns.has(f.name));
    const biRequest: UpdateBiPivotFieldsRequest = {
      pivotId,
      rowFields: rows.filter(isRealBiField).map(toBiRef),
      columnFields: columns.filter(isRealBiField).map(toBiRef),
      valueFields: values.map((f) => toBiValueFieldRef(f.name)),
      filterFields: filters.filter(isRealBiField).map(toBiRef),
      lookupColumns: [...lookupColumns],
    };
    pivot.updateBiFields(biRequest).then(() => {
      if (onViewUpdate) onViewUpdate();
    }).catch((err) => {
      console.error('Failed to update pivot after lookup toggle:', err);
    });
  }, [lookupColumns, isBiPivot, pivotId, rows, columns, values, filters, onViewUpdate]);

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

      <div className={styles.content}>
        {isBiPivot && biModel ? (
          <TableFieldList
            biModel={biModel}
            usedColumns={usedColumnsSet}
            usedMeasures={usedMeasuresSet}
            lookupColumns={lookupColumns}
            onColumnToggle={handleBiColumnToggle}
            onMeasureToggle={handleBiMeasureToggle}
            onLookupToggle={handleLookupToggle}
          />
        ) : (
          <FieldList
            fields={sourceFields}
            usedFields={usedFields}
            onFieldToggle={handleFieldToggle}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          />
        )}

        <DropZones
          filters={filters}
          columns={columns}
          rows={rows}
          values={values}
          onDrop={handleDrop}
          onRemove={handleRemove}
          onReorder={handleReorder}
          onValuesAggregationChange={handleAggregationChange}
          onMoveField={handleMoveField}
          onOpenValueSettings={handleOpenValueSettings}
          onOpenNumberFormat={handleOpenNumberFormat}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        />
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