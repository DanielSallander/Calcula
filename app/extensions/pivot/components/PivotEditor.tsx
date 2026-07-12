//! FILENAME: app/extensions/pivot/components/PivotEditor.tsx
import React, { useCallback, useRef, useState, useEffect, useMemo } from 'react';
import { css } from '@emotion/css';
import { styles } from './PivotEditor.styles';
import { FieldList } from './FieldList';
import { DropZones } from './DropZones';
import { ValueFieldSettingsModal, type ValueFieldSettings } from './ValueFieldSettingsModal';
import { NumberFormatModal } from './NumberFormatModal';
import { DesignEditor } from './DesignEditor';
import { SaveLoadToolbar } from './SaveLoadToolbar';
import { usePivotEditorState } from './usePivotEditorState';
import { buildSourceSignature } from '../lib/namedConfigs';
import { pivot, savePivotLayout } from '@api/pivot';
import { openTaskPane, getBiConnectionService } from '@api';
import type { SavePivotLayoutRequest } from '@api/pivot';
import { TableFieldList } from '../../_shared/components/TableFieldList';
import { getConnectionBiModel, setPivotPerspective } from '../lib/pivot-api';
import type {
  SourceField,
  ZoneField,
  LayoutConfig,
  UpdatePivotFieldsRequest,
  UpdateBiPivotFieldsRequest,
  BiPivotModelInfo,
  BiFieldRef,
  BiValueFieldRef,
  BiHierarchyFieldRef,
  BiPerspectiveInfo,
  MeasureField,
  PivotId,
  CalculatedFieldDef,
  AppliedCalcGroup,
} from './types';
import { useJsonToggle, JsonToggleButton, JsonToggleEditor } from "../../_shared/components/jsonToggle";

type EditorTab = 'fields' | 'design';

interface PivotEditorProps {
  pivotId: PivotId;
  sourceFields: SourceField[];
  initialRows?: ZoneField[];
  initialColumns?: ZoneField[];
  initialValues?: ZoneField[];
  initialFilters?: ZoneField[];
  initialLayout?: LayoutConfig;
  initialCalculatedFields?: CalculatedFieldDef[];
  biModel?: BiPivotModelInfo;
  sourceTableName?: string;
  onClose?: () => void;
  onViewUpdate?: () => void;
}

/** Banner showing BI connection status with connect action */
function BiConnectionBanner({ connectionId, onConnected }: {
  connectionId: string;
  onConnected: () => void;
}) {
  const [isConnected, setIsConnected] = useState<boolean | null>(null);
  const [connName, setConnName] = useState("");
  const [isConnecting, setIsConnecting] = useState(false);

  useEffect(() => {
    getBiConnectionService()?.getConnections().then(conns => {
      const conn = conns.find(c => c.id === connectionId);
      if (conn) {
        setIsConnected(conn.isConnected);
        setConnName(conn.name);
      }
    }).catch(() => {});
  }, [connectionId]);

  const handleConnect = useCallback(async () => {
    const biService = getBiConnectionService();
    if (!biService) return;
    try {
      const conns = await biService.getConnections();
      const conn = conns.find(c => c.id === connectionId);
      if (!conn) return;

      if (!conn.connectionString) {
        const server = conn.server || "localhost";
        const db = conn.database || "mydb";
        const password = window.prompt(
          `Connect to ${conn.name}\nServer: ${server}\nDatabase: ${db}\n\nEnter password:`,
        );
        if (password === null) return;
        await biService.updateConnection({ id: connectionId, connectionString: `__PASSWORD_ONLY__:${password}` });
      }

      setIsConnecting(true);
      await biService.connect(connectionId);
      setIsConnected(true);
      onConnected();
    } catch (err) {
      window.alert(`Failed to connect: ${err}`);
    } finally {
      setIsConnecting(false);
    }
  }, [connectionId, onConnected]);

  if (isConnected === null) return null;

  const bgColor = isConnected ? '#f0f7ff' : '#fff8e1';
  const borderColor = isConnected ? '#d0e4f5' : '#ffe082';
  const dotColor = isConnected ? '#4caf50' : '#ff9800';

  return (
    <div style={{
      padding: '6px 10px',
      fontSize: '11px',
      color: '#555',
      background: bgColor,
      borderBottom: `1px solid ${borderColor}`,
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
    }}>
      <span style={{
        width: '7px', height: '7px', borderRadius: '50%',
        background: dotColor, display: 'inline-block', flexShrink: 0,
      }} />
      {isConnected ? (
        <span>{connName}</span>
      ) : (
        <>
          <span style={{ color: '#e65100' }}>
            {connName || 'Data source'} — disconnected
          </span>
          <button
            onClick={handleConnect}
            disabled={isConnecting}
            style={{
              marginLeft: 'auto', padding: '2px 8px', fontSize: '11px',
              background: '#1976d2', color: '#fff', border: 'none',
              borderRadius: '3px', cursor: isConnecting ? 'wait' : 'pointer',
            }}
          >
            {isConnecting ? 'Connecting...' : 'Connect'}
          </button>
        </>
      )}
    </div>
  );
}

/** Check if a field name represents a hierarchy field ("Table.__hierarchy__.Name") */
function isHierarchyField(name: string): boolean {
  return name.includes('.__hierarchy__.');
}

/** Parse a hierarchy field key "Table.__hierarchy__.Name" into a BiHierarchyFieldRef */
function toHierarchyFieldRef(name: string): BiHierarchyFieldRef {
  const parts = name.split('.__hierarchy__.');
  return { table: parts[0], hierarchy: parts[1], expanded: [] };
}

/** Parse a BI field key "Table.Column" into a BiFieldRef, optionally marking as lookup */
function toBiFieldRef(name: string, isLookup?: boolean): BiFieldRef {
  const dotIndex = name.indexOf('.');
  if (dotIndex === -1) return { table: '', column: name, isLookup };
  return { table: name.substring(0, dotIndex), column: name.substring(dotIndex + 1), isLookup };
}

/** Parse a BI measure field key "[MeasureName]" into a BiValueFieldRef */
function toBiValueFieldRef(name: string, customName?: string): BiValueFieldRef {
  // Strip brackets: "[Revenue]" -> "Revenue"
  const measureName = name.startsWith('[') && name.endsWith(']')
    ? name.substring(1, name.length - 1)
    : name;
  return { measureName, customName };
}

export function PivotEditor({
  pivotId,
  sourceFields,
  initialRows = [],
  initialColumns = [],
  initialValues = [],
  initialFilters = [],
  initialLayout = {},
  initialCalculatedFields,
  biModel,
  sourceTableName,
  onClose,
  onViewUpdate,
}: PivotEditorProps): React.ReactElement {
  const isBiPivot = !!biModel;

  // Track whether we've seen at least one successful update (or user-initiated change).
  // Suppresses the connect prompt on the initial auto-triggered mount update.
  const hasUserInteracted = useRef(false);

  // JSON toggle (Phase C)
  const jsonToggle = useJsonToggle("pivot", String(pivotId), onViewUpdate);

  // Tab state: Fields (visual drag-drop) or Design (DSL text editor)
  const [activeTab, setActiveTab] = useState<EditorTab>('fields');

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

  // Applied calculation group: the group whose items multiply the value fields
  // on the Values axis. v1 applies all items of the selected group (null = none).
  const [appliedCalcGroup, setAppliedCalcGroup] = useState<AppliedCalcGroup | null>(
    () => biModel?.appliedCalculationGroup ?? null,
  );

  // Perspective picker: which model perspective filters the field-list
  // DISPLAY (null = all fields). Persisted per pivot via set_pivot_perspective.
  const [selectedPerspective, setSelectedPerspective] = useState<string | null>(
    () => biModel?.selectedPerspective ?? null,
  );
  // The editor component may be REUSED across pivots (no key on the host) --
  // re-seed the selection from the new pivot's metadata when pivotId changes,
  // without clobbering in-session changes to the SAME pivot (the biModel prop
  // stays stale after setPivotPerspective until the next metadata fetch).
  const perspectivePivotRef = useRef(pivotId);
  useEffect(() => {
    if (perspectivePivotRef.current !== pivotId) {
      perspectivePivotRef.current = pivotId;
      setSelectedPerspective(biModel?.selectedPerspective ?? null);
    }
  }, [pivotId, biModel?.selectedPerspective]);
  // The perspectives stored in pivot metadata are a snapshot from pivot
  // creation; overlay the model's CURRENT list when the connection is live
  // (offline falls back to the snapshot, so the picker still works).
  const [livePerspectives, setLivePerspectives] = useState<BiPerspectiveInfo[] | null>(null);
  useEffect(() => {
    // Drop any previous connection's overlay so a failed fetch can never show
    // another connection's perspectives.
    setLivePerspectives(null);
    if (!biModel) return;
    let cancelled = false;
    getConnectionBiModel(biModel.connectionId)
      .then((m) => {
        if (!cancelled && m?.perspectives) setLivePerspectives(m.perspectives);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [biModel?.connectionId]);
  const fieldListModel = useMemo(() => {
    if (!biModel || !livePerspectives) return biModel;
    return { ...biModel, perspectives: livePerspectives };
  }, [biModel, livePerspectives]);
  const handlePerspectiveChange = useCallback(
    (name: string | null) => {
      setSelectedPerspective(name);
      // Persist per pivot; a failure (e.g. stale pivot id) only loses the
      // saved selection, never the display change.
      void setPivotPerspective(pivotId, name).catch(() => {});
    },
    [pivotId],
  );

  // Ref to resetZones (set after usePivotEditorState, used in handleUpdate catch)
  const resetZonesRef = useRef<(() => void) | null>(null);

  const handleUpdate = useCallback(async (request: UpdatePivotFieldsRequest) => {
    // Build BI request upfront (if applicable) so it's accessible in catch block for retry
    let biRequest: UpdateBiPivotFieldsRequest | undefined;
    if (isBiPivot) {
      const isRealBiField = (f: { name: string }) => f.name.includes('.') && !isHierarchyField(f.name);
      const toBiRef = (f: { name: string }) =>
        toBiFieldRef(f.name, lookupColumns.has(f.name));
      const biFilterFields = (request.filterFields ?? [])
        .filter(isRealBiField)
        .map(f => ({ ...toBiRef(f), hiddenItems: f.hiddenItems }));

      // Extract hierarchy fields from rows/columns
      const rowHierarchies = (request.rowFields ?? [])
        .filter(f => isHierarchyField(f.name))
        .map(f => toHierarchyFieldRef(f.name));
      const columnHierarchies = (request.columnFields ?? [])
        .filter(f => isHierarchyField(f.name))
        .map(f => toHierarchyFieldRef(f.name));

      biRequest = {
        pivotId: request.pivotId,
        rowFields: (request.rowFields ?? []).filter(isRealBiField).map(toBiRef),
        columnFields: (request.columnFields ?? []).filter(isRealBiField).map(toBiRef),
        valueFields: (request.valueFields ?? []).map((f) => toBiValueFieldRef(f.name, f.customName)),
        filterFields: biFilterFields,
        rowHierarchies: rowHierarchies.length > 0 ? rowHierarchies : undefined,
        columnHierarchies: columnHierarchies.length > 0 ? columnHierarchies : undefined,
        layout: request.layout,
        lookupColumns: [...lookupColumns],
        calculatedFields: request.calculatedFields,
        valueColumnOrder: request.valueColumnOrder,
        calculationGroup: appliedCalcGroup ?? undefined,
      };
    }

    try {
      const t0 = performance.now();

      if (isBiPivot && biRequest) {
        console.log(`[CALP-DIAG] PivotEditor.handleUpdate: BI pivot, pivotId=${request.pivotId}`);
        console.log(`[CALP-DIAG]   request rows=${request.rowFields?.length}, cols=${request.columnFields?.length}, vals=${request.valueFields?.length}`);
        console.log(`[CALP-DIAG]   biRequest: rows=${biRequest.rowFields.length} [${biRequest.rowFields.map(f => `${f.table}.${f.column}`).join(', ')}]`);
        console.log(`[CALP-DIAG]   biRequest: vals=${biRequest.valueFields.length} [${biRequest.valueFields.map(f => f.measureName).join(', ')}]`);
        await pivot.updateBiFields(biRequest);
      } else {
        await pivot.updateFields(request);
      }

      hasUserInteracted.current = true;
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
      if (msg.includes("superseded")) {
        // Superseded by a newer operation — do nothing, the newer one will finish
      } else if (msg.includes("cancelled")) {
        // User cancelled — revert the optimistic zone state
        resetZonesRef.current?.();
      } else {
        const errStr = String(error);
      console.error(`[CALP-DIAG] PivotEditor.handleUpdate FAILED: ${errStr}`);
      if (errStr.includes("Not connected") || errStr.includes("No connection")) {
        resetZonesRef.current?.();
        // Only show the connect prompt for user-initiated changes,
        // not the auto-triggered mount update
        if (hasUserInteracted.current) {
          const shouldConnect = window.confirm(
            "This pivot table is not connected to a data source.\n\n" +
            "Open the Connections panel to connect?"
          );
          if (shouldConnect) {
            openTaskPane("connections-pane");
          }
        } else {
          // First mount — silently skip, user hasn't done anything yet
          hasUserInteracted.current = true;
        }
      }
      }
    }
  }, [isBiPivot, lookupColumns, appliedCalcGroup, onViewUpdate]);

  const {
    usedFields,
    filters,
    columns,
    rows,
    values,
    layout: currentLayout,
    deferUpdate,
    setDeferUpdate,
    hasPendingChanges,
    markPendingChanges,
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
    setAllZones,
    filterUniqueValues,
    calculatedFields,
    flushUpdate,
    resetZones,
  } = usePivotEditorState({
    pivotId,
    sourceFields,
    initialRows,
    initialColumns,
    initialValues,
    initialFilters,
    initialLayout,
    initialCalculatedFields,
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

  // Track which hierarchies are placed in a zone ("Table.HierarchyName" keys)
  const usedHierarchiesSet = useMemo(() => {
    if (!isBiPivot) return new Set<string>();
    const set = new Set<string>();
    for (const f of [...rows, ...columns]) {
      // Hierarchy fields use the naming convention "Table.__hierarchy__.Name"
      if (f.name.includes('.__hierarchy__.')) {
        const parts = f.name.split('.__hierarchy__.');
        set.add(`${parts[0]}.${parts[1]}`);
      }
    }
    return set;
  }, [isBiPivot, rows, columns]);

  // Saved layouts: track current DSL text and saveAs name for the toolbar
  const [currentDslText, setCurrentDslText] = useState('');
  const [currentSaveAsName, setCurrentSaveAsName] = useState<string | undefined>();
  const [externalDslText, setExternalDslText] = useState<string | null>(null);

  const handleDslTextChange = useCallback((text: string, saveAsName?: string) => {
    setCurrentDslText(text);
    setCurrentSaveAsName(saveAsName);
  }, []);

  const handleSaveAs = useCallback((name: string, dslText: string) => {
    const sig = buildSourceSignature(sourceFields, biModel, sourceTableName);
    if (!sig) return; // raw-range pivot — save not allowed
    const request: SavePivotLayoutRequest = {
      name,
      dslText,
      sourceType: sig.type,
      sourceTableName: sig.tableName,
      sourceBiTables: sig.tables?.map(t => t.name) ?? [],
      sourceBiMeasures: sig.measures ?? [],
    };
    savePivotLayout(request).catch(err =>
      console.error('Failed to save pivot layout:', err),
    );
  }, [sourceFields, biModel, sourceTableName]);

  const handleLoadDsl = useCallback((dslText: string) => {
    setExternalDslText(dslText);
    // Reset after next render to allow re-loading same text
    requestAnimationFrame(() => setExternalDslText(null));
  }, []);

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

  // BI hierarchy toggle: add/remove hierarchy to Rows zone
  const handleBiHierarchyToggle = useCallback(
    (table: string, hierarchyName: string, checked: boolean) => {
      if (!biModel?.hierarchies) return;
      const hierarchy = biModel.hierarchies.find(
        (h) => h.table === table && h.name === hierarchyName
      );
      if (!hierarchy) return;

      const fieldName = `${table}.__hierarchy__.${hierarchyName}`;
      const field: SourceField = {
        index: -3, // Special marker for hierarchy fields
        name: fieldName,
        isNumeric: false,
      };
      handleFieldToggle(field, checked);
    },
    [biModel, handleFieldToggle]
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

    // In deferred mode, just mark pending — don't send the BI query
    if (deferUpdate) {
      markPendingChanges();
      return;
    }

    // Build and send the update request directly (same as handleUpdate logic)
    const isRealBiField = (f: { name: string }) => f.name.includes('.') && !isHierarchyField(f.name);
    const toBiRef = (f: { name: string }) =>
      toBiFieldRef(f.name, lookupColumns.has(f.name));
    const rowHierarchies = rows.filter(f => isHierarchyField(f.name)).map(f => toHierarchyFieldRef(f.name));
    const columnHierarchies = columns.filter(f => isHierarchyField(f.name)).map(f => toHierarchyFieldRef(f.name));
    const biRequest: UpdateBiPivotFieldsRequest = {
      pivotId,
      rowFields: rows.filter(isRealBiField).map(toBiRef),
      columnFields: columns.filter(isRealBiField).map(toBiRef),
      valueFields: values.map((f) => toBiValueFieldRef(f.name, f.customName)),
      filterFields: filters.filter(isRealBiField).map(toBiRef),
      rowHierarchies: rowHierarchies.length > 0 ? rowHierarchies : undefined,
      columnHierarchies: columnHierarchies.length > 0 ? columnHierarchies : undefined,
      lookupColumns: [...lookupColumns],
      calculationGroup: appliedCalcGroup ?? undefined,
    };
    pivot.updateBiFields(biRequest).then(() => {
      if (onViewUpdate) onViewUpdate();
    }).catch((err) => {
      console.error('Failed to update pivot after lookup toggle:', err);
    });
  }, [lookupColumns, appliedCalcGroup, isBiPivot, pivotId, rows, columns, values, filters, onViewUpdate, deferUpdate, markPendingChanges]);

  // Apply (or clear) a calculation group + its selected items, then re-run the
  // BI query so the value axis re-expands. items: [] means ALL items of the group.
  const applyCalcGroup = useCallback((next: AppliedCalcGroup | null) => {
    setAppliedCalcGroup(next);
    if (!isBiPivot) return;
    const isRealBiField = (f: { name: string }) => f.name.includes('.') && !isHierarchyField(f.name);
    const toBiRef = (f: { name: string }) => toBiFieldRef(f.name, lookupColumns.has(f.name));
    const rowHierarchies = rows.filter(f => isHierarchyField(f.name)).map(f => toHierarchyFieldRef(f.name));
    const columnHierarchies = columns.filter(f => isHierarchyField(f.name)).map(f => toHierarchyFieldRef(f.name));
    const biRequest: UpdateBiPivotFieldsRequest = {
      pivotId,
      rowFields: rows.filter(isRealBiField).map(toBiRef),
      columnFields: columns.filter(isRealBiField).map(toBiRef),
      valueFields: values.map((f) => toBiValueFieldRef(f.name, f.customName)),
      filterFields: filters.filter(isRealBiField).map(toBiRef),
      rowHierarchies: rowHierarchies.length > 0 ? rowHierarchies : undefined,
      columnHierarchies: columnHierarchies.length > 0 ? columnHierarchies : undefined,
      lookupColumns: [...lookupColumns],
      calculationGroup: next ?? undefined,
    };
    pivot.updateBiFields(biRequest).then(() => {
      if (onViewUpdate) onViewUpdate();
    }).catch((err) => {
      console.error('Failed to apply calculation group:', err);
    });
  }, [isBiPivot, pivotId, rows, columns, values, filters, lookupColumns, onViewUpdate]);

  // Select/clear the calculation group (defaults to all items).
  const handleCalcGroupChange = useCallback((groupName: string | null) => {
    applyCalcGroup(groupName ? { group: groupName, items: [] } : null);
  }, [applyCalcGroup]);

  // Toggle one calculation item. Empty items === all, so unchecking from "all"
  // materializes the full list minus that item; re-selecting every item collapses
  // back to the canonical [] (all). Never allows zero items.
  const handleCalcItemToggle = useCallback(
    (itemName: string, allItemNames: string[], checked: boolean) => {
      if (!appliedCalcGroup) return;
      const current = appliedCalcGroup.items.length > 0 ? appliedCalcGroup.items : allItemNames;
      const draft = checked ? [...current, itemName] : current.filter((i) => i !== itemName);
      // Restrict to known items, dedup, and preserve model declaration order.
      const nextItems = allItemNames.filter((i) => draft.includes(i));
      if (nextItems.length === 0) return; // keep at least one item
      const items = nextItems.length === allItemNames.length ? [] : nextItems;
      applyCalcGroup({ group: appliedCalcGroup.group, items });
    },
    [appliedCalcGroup, applyCalcGroup],
  );

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
        <div className={tabBarStyles.tabBar}>
          <button
            className={`${tabBarStyles.tab} ${activeTab === 'fields' ? tabBarStyles.tabActive : ''}`}
            onClick={() => setActiveTab('fields')}
          >
            Fields
          </button>
          <button
            className={`${tabBarStyles.tab} ${activeTab === 'design' ? tabBarStyles.tabActive : ''}`}
            onClick={() => setActiveTab('design')}
          >
            Design
          </button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <JsonToggleButton isActive={jsonToggle.isJsonMode} onClick={jsonToggle.toggle} />
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
      </div>

      {/* JSON editor (shown when toggle is active) */}
      {jsonToggle.isJsonMode ? (
        <div style={{ flex: 1, minHeight: 0 }}>
          <JsonToggleEditor
            json={jsonToggle.json}
            onChange={jsonToggle.setJson}
            onApply={jsonToggle.apply}
            onRevert={jsonToggle.revert}
            dirty={jsonToggle.dirty}
            error={jsonToggle.error}
            loading={jsonToggle.loading}
          />
        </div>
      ) : (
      <>
      {isBiPivot && biModel && biModel.connectionId && (
        <BiConnectionBanner
          connectionId={biModel.connectionId}
          onConnected={() => {
            // Retry any pending update after connecting
            if (onViewUpdate) onViewUpdate();
          }}
        />
      )}

      {/* Data snapshot freshness — when this pivot's data was last fetched.
          Especially relevant offline / after a cross-machine open, where the
          data is a snapshot embedded at save time. */}
      {isBiPivot && biModel?.dataAsOf && (
        <div
          style={{ padding: '4px 8px', fontSize: '11px', color: '#57606a' }}
          title={`Data last fetched from the database on ${new Date(biModel.dataAsOf).toLocaleString()}. Refresh to update.`}
        >
          Data as of {new Date(biModel.dataAsOf).toLocaleString()}
        </div>
      )}

      {/* Fields tab content */}
      <div className={styles.content} style={{ display: activeTab === 'fields' ? 'flex' : 'none' }}>
        {isBiPivot && fieldListModel ? (
          <TableFieldList
            biModel={fieldListModel}
            usedColumns={usedColumnsSet}
            usedMeasures={usedMeasuresSet}
            usedHierarchies={usedHierarchiesSet}
            lookupColumns={lookupColumns}
            onColumnToggle={handleBiColumnToggle}
            onMeasureToggle={handleBiMeasureToggle}
            onHierarchyToggle={handleBiHierarchyToggle}
            onLookupToggle={handleLookupToggle}
            selectedPerspective={selectedPerspective}
            onPerspectiveChange={handlePerspectiveChange}
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
        {isBiPivot && biModel?.calculationGroups && biModel.calculationGroups.length > 0 && (() => {
          // Calc groups can't combine with lookup columns (the backend rejects
          // it). Disable the control while any lookup column is active, unless a
          // group is already applied (so the user can still switch it off).
          const hasLookups = lookupColumns.size > 0;
          const disabled = hasLookups && !appliedCalcGroup;
          return (
          <div style={{ padding: '8px', borderTop: '1px solid #eaeef2', fontSize: '12px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', opacity: disabled ? 0.5 : 1 }}>
              <span style={{ fontWeight: 600 }}>Calculation group:</span>
              <select
                value={appliedCalcGroup?.group ?? ''}
                onChange={(e) =>
                  handleCalcGroupChange(e.target.value === '' ? null : e.target.value)
                }
                disabled={disabled}
                style={{ fontSize: '12px', flex: 1 }}
                title={
                  disabled
                    ? 'Remove lookup columns to apply a calculation group.'
                    : 'Apply a calculation group: each value field is shown once per ' +
                      'calculation item (e.g. Current, YTD, PY).'
                }
              >
                <option value="">None</option>
                {biModel.calculationGroups.map((g) => (
                  <option key={g.name} value={g.name}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
            {appliedCalcGroup && (() => {
              const group = biModel.calculationGroups?.find(g => g.name === appliedCalcGroup.group);
              const allItems = group?.items.map(i => i.name) ?? [];
              const isItemOn = (name: string) =>
                appliedCalcGroup.items.length === 0 || appliedCalcGroup.items.includes(name);
              return (
                <div style={{ marginTop: '6px' }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px' }}>
                    {allItems.map((name) => (
                      <label
                        key={name}
                        style={{ display: 'flex', alignItems: 'center', gap: '3px', fontSize: '11px' }}
                      >
                        <input
                          type="checkbox"
                          checked={isItemOn(name)}
                          onChange={(e) => handleCalcItemToggle(name, allItems, e.target.checked)}
                        />
                        {name}
                      </label>
                    ))}
                  </div>
                  <div style={{ marginTop: '3px', color: '#6639ba', fontSize: '11px' }}>
                    Applied to {values.length} measure{values.length === 1 ? '' : 's'} - totals off while applied
                  </div>
                </div>
              );
            })()}
          </div>
          );
        })()}
      </div>

      {/* Design tab content */}
      <div className={styles.content} style={{ display: activeTab === 'design' ? 'flex' : 'none', flexDirection: 'column' }}>
        <SaveLoadToolbar
          sourceFields={sourceFields}
          biModel={biModel}
          sourceTableName={sourceTableName}
          currentDslText={currentDslText}
          currentSaveAsName={currentSaveAsName}
          pivotId={pivotId}
          onLoadDsl={handleLoadDsl}
        />
        <DesignEditor
          sourceFields={sourceFields}
          biModel={biModel}
          rows={rows}
          columns={columns}
          values={values}
          filters={filters}
          layout={currentLayout}
          filterUniqueValues={filterUniqueValues.current}
          calculatedFields={calculatedFields.current}
          onZoneStateChange={setAllZones}
          onSaveAs={handleSaveAs}
          onDslTextChange={handleDslTextChange}
          externalDslText={externalDslText}
          isActive={activeTab === 'design'}
        />
      </div>

      {/* Defer Layout Update footer */}
      <div className={styles.deferFooter}>
        <label className={styles.deferCheckboxLabel}>
          <input
            type="checkbox"
            checked={deferUpdate}
            onChange={(e) => setDeferUpdate(e.target.checked)}
          />
          Defer Layout Update
        </label>
        <button
          className={styles.deferUpdateButton}
          disabled={!deferUpdate || !hasPendingChanges}
          onClick={flushUpdate}
        >
          Update
        </button>
      </div>

      </>
      )}

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

// --- Tab bar styles ---

const tabBarStyles = {
  tabBar: css`
    display: flex;
    gap: 0;
  `,
  tab: css`
    padding: 0 12px;
    background: none;
    border: none;
    cursor: pointer;
    font-family: inherit;
    font-size: 13px;
    font-weight: 400;
    color: #656d76;
    line-height: 1;
    border-bottom: 2px solid transparent;
    transition: color 0.12s, border-color 0.12s;
    padding-bottom: 2px;

    &:hover {
      color: #24292f;
    }
  `,
  tabActive: css`
    color: #24292f;
    font-weight: 600;
    border-bottom-color: #0969da;
  `,
};