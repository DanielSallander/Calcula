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
import { onAppEvent } from '@api/events';
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
  BiCultureInfo,
  BiCalcGroup,
  MeasureField,
  PivotId,
  CalculatedFieldDef,
  DropZoneType,
  DragField,
} from './types';
import { CALC_GROUP_TABLE } from './types';
import { useJsonToggle, JsonToggleButton, JsonToggleEditor } from "../../_shared/components/jsonToggle";
import { splitBiFieldKey } from "../../_shared/lib/biFieldKey";

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

/** Parse a BI field key "Table.Column" into a BiFieldRef, optionally marking as lookup.
 *  Table names can contain dots, so resolve against the model's table names. */
function toBiFieldRef(name: string, tableNames: string[], isLookup?: boolean): BiFieldRef {
  const { table, column } = splitBiFieldKey(name, tableNames);
  return { table, column, isLookup };
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

  // Model table names for field-key parsing (table names can contain dots).
  const biTableNames = useMemo(
    () => (biModel ? biModel.tables.map((t) => t.name) : []),
    [biModel],
  );

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
  // Mirrors lookupColumns for the persistence effect below. Auto-lookup on
  // add pre-syncs it so a lookup change carried by an accompanying zone
  // update doesn't fire a second BI query.
  const lookupColumnsRef = React.useRef(lookupColumns);

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
  // The perspectives/cultures/calculation groups stored in pivot metadata are
  // a snapshot from pivot creation; overlay the model's CURRENT lists when the
  // connection is live (offline falls back to the snapshot, so the picker
  // still works). Re-fetched on "bi:model-changed" so Model Editor edits
  // (e.g. a newly added calculation group) appear without reopening the pivot.
  const [liveModelMeta, setLiveModelMeta] = useState<{
    perspectives?: BiPerspectiveInfo[];
    cultures?: BiCultureInfo[];
    calculationGroups?: BiCalcGroup[];
  } | null>(null);
  useEffect(() => {
    // Drop any previous connection's overlay so a failed fetch can never show
    // another connection's perspectives/cultures.
    setLiveModelMeta(null);
    if (!biModel?.connectionId) return;
    let cancelled = false;
    const connectionId = biModel.connectionId;
    const fetchLiveMeta = () => {
      getConnectionBiModel(connectionId)
        .then((m) => {
          if (!cancelled && m) {
            setLiveModelMeta({
              perspectives: m.perspectives,
              cultures: m.cultures,
              calculationGroups: m.calculationGroups,
            });
          }
        })
        .catch(() => {});
    };
    fetchLiveMeta();
    const offModelChanged = onAppEvent<{ connectionId?: string }>(
      'bi:model-changed',
      (detail) => {
        if (!detail?.connectionId || detail.connectionId === connectionId) {
          fetchLiveMeta();
        }
      },
    );
    return () => {
      cancelled = true;
      offModelChanged();
    };
  }, [biModel?.connectionId]);
  const fieldListModel = useMemo(() => {
    if (!biModel || !liveModelMeta) return biModel;
    return {
      ...biModel,
      perspectives: liveModelMeta.perspectives ?? biModel.perspectives,
      cultures: liveModelMeta.cultures ?? biModel.cultures,
      calculationGroups:
        liveModelMeta.calculationGroups ?? biModel.calculationGroups,
    };
  }, [biModel, liveModelMeta]);
  // Calculation groups are placed as DIMENSION fields (Power BI-style). Their
  // zone chips carry the plain group name; on the wire they become pseudo
  // refs { table: CALC_GROUP_TABLE, column: <group> }.
  const calcGroupNames = useMemo(() => {
    const set = new Set<string>();
    for (const g of fieldListModel?.calculationGroups ?? []) set.add(g.name);
    return set;
  }, [fieldListModel?.calculationGroups]);

  // The active UI locale for culture (translation) resolution. Read once —
  // there is no app-wide locale service yet; null shows raw names.
  const uiLocale = useMemo<string | null>(() => {
    try {
      return window.localStorage.getItem('calcula.locale');
    } catch {
      return null;
    }
  }, []);
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
      const isCalcGroupField = (f: { name: string }) => calcGroupNames.has(f.name);
      const isRealBiField = (f: { name: string }) =>
        (f.name.includes('.') && !isHierarchyField(f.name)) || isCalcGroupField(f);
      // A calculation-group chip becomes its pseudo ref; hiddenItems carry the
      // item subset for every zone (the backend reads them off the placement).
      const toBiRef = (f: { name: string; hiddenItems?: string[] }) =>
        isCalcGroupField(f)
          ? { table: CALC_GROUP_TABLE, column: f.name, hiddenItems: f.hiddenItems }
          : { ...toBiFieldRef(f.name, biTableNames, lookupColumns.has(f.name)), hiddenItems: f.hiddenItems };
      const biFilterFields = (request.filterFields ?? [])
        .filter(isRealBiField)
        .map(toBiRef);

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
        valueFields: (request.valueFields ?? [])
          .filter((f) => !isCalcGroupField(f))
          .map((f) => toBiValueFieldRef(f.name, f.customName)),
        filterFields: biFilterFields,
        rowHierarchies: rowHierarchies.length > 0 ? rowHierarchies : undefined,
        columnHierarchies: columnHierarchies.length > 0 ? columnHierarchies : undefined,
        layout: request.layout,
        lookupColumns: [...lookupColumns],
        calculatedFields: request.calculatedFields,
        valueColumnOrder: request.valueColumnOrder,
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
  }, [isBiPivot, biTableNames, lookupColumns, calcGroupNames, onViewUpdate]);

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
    setZoneFieldHiddenItems,
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
            const fieldTable = splitBiFieldKey(f.name, biTableNames).table;
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
    [lookupColumns, biTableNames, rows, columns, filters]
  );

  // Auto-lookup on add: a writeback column is typed per LEAF row, which
  // requires LOOKUP placement. Default it to lookup when first added to the
  // report, respecting the same-table GROUP guardrail (the backend rejects a
  // lookup with no GROUP field from its table). The ref pre-sync makes the
  // accompanying zone update carry (and persist) the new lookup set, so the
  // lookup effect below doesn't fire a second BI query.
  const autoLookupWritebackColumn = useCallback(
    (fieldName: string) => {
      if (!biModel) return;
      if (!fieldName.includes('.')) return;
      const { table, column } = splitBiFieldKey(fieldName, biTableNames);
      const colMeta = biModel.tables
        .find((t) => t.name === table)
        ?.columns.find((c) => c.name === column);
      if (!colMeta?.isWritebackColumn || lookupColumnsRef.current.has(fieldName)) return;
      const hasSameTableGroup = [...rows, ...columns, ...filters].some((f) => {
        return (
          f.name.includes('.') &&
          splitBiFieldKey(f.name, biTableNames).table === table &&
          f.name !== fieldName &&
          !lookupColumnsRef.current.has(f.name)
        );
      });
      if (!hasSameTableGroup) return;
      const next = new Set(lookupColumnsRef.current);
      next.add(fieldName);
      lookupColumnsRef.current = next;
      setLookupColumns(next);
    },
    [biModel, biTableNames, rows, columns, filters]
  );

  // BI column toggle: add/remove dimension field
  const handleBiColumnToggle = useCallback(
    (table: string, column: string, _isNumeric: boolean, checked: boolean) => {
      const fieldName = `${table}.${column}`;
      if (checked) {
        autoLookupWritebackColumn(fieldName);
      }
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
    [handleFieldToggle, autoLookupWritebackColumn]
  );

  // Drop wrapper: fresh field-list drops of a writeback column into Rows
  // default to LOOKUP (zone-to-zone moves keep the user's chosen mode).
  const handleDropWithAutoLookup = useCallback(
    (zone: DropZoneType, dragField: DragField, insertIndex?: number) => {
      // A calculation-group chip is a dimension — it can never enter VALUES.
      if (isBiPivot && zone === 'values' && calcGroupNames.has(dragField.name)) {
        return;
      }
      if (isBiPivot && zone === 'rows' && dragField.sourceIndex === -1 && !dragField.fromZone) {
        autoLookupWritebackColumn(dragField.name);
      }
      handleDrop(zone, dragField, insertIndex);
    },
    [isBiPivot, calcGroupNames, autoLookupWritebackColumn, handleDrop]
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
    const isCalcGroupField = (f: { name: string }) => calcGroupNames.has(f.name);
    const isRealBiField = (f: { name: string }) =>
      (f.name.includes('.') && !isHierarchyField(f.name)) || isCalcGroupField(f);
    const toBiRef = (f: { name: string; hiddenItems?: string[] }) =>
      isCalcGroupField(f)
        ? { table: CALC_GROUP_TABLE, column: f.name, hiddenItems: f.hiddenItems }
        : { ...toBiFieldRef(f.name, biTableNames, lookupColumns.has(f.name)), hiddenItems: f.hiddenItems };
    const rowHierarchies = rows.filter(f => isHierarchyField(f.name)).map(f => toHierarchyFieldRef(f.name));
    const columnHierarchies = columns.filter(f => isHierarchyField(f.name)).map(f => toHierarchyFieldRef(f.name));
    const biRequest: UpdateBiPivotFieldsRequest = {
      pivotId,
      rowFields: rows.filter(isRealBiField).map(toBiRef),
      columnFields: columns.filter(isRealBiField).map(toBiRef),
      valueFields: values
        .filter((f) => !isCalcGroupField(f))
        .map((f) => toBiValueFieldRef(f.name, f.customName)),
      filterFields: filters.filter(isRealBiField).map(toBiRef),
      rowHierarchies: rowHierarchies.length > 0 ? rowHierarchies : undefined,
      columnHierarchies: columnHierarchies.length > 0 ? columnHierarchies : undefined,
      lookupColumns: [...lookupColumns],
    };
    pivot.updateBiFields(biRequest).then(() => {
      if (onViewUpdate) onViewUpdate();
    }).catch((err) => {
      console.error('Failed to update pivot after lookup toggle:', err);
    });
  }, [lookupColumns, calcGroupNames, isBiPivot, biTableNames, pivotId, rows, columns, values, filters, onViewUpdate, deferUpdate, markPendingChanges]);

  // The calculation group currently PLACED on this pivot: the zone chip named
  // after a model calculation group, wherever it sits (rows/columns/filters).
  // Its hiddenItems carry the item-subset selection.
  const placedCalcGroup = useMemo(() => {
    for (const f of [...rows, ...columns, ...filters]) {
      if (calcGroupNames.has(f.name)) {
        return { group: f.name, hiddenItems: f.hiddenItems ?? [] };
      }
    }
    return null;
  }, [rows, columns, filters, calcGroupNames]);

  // Place/remove a calculation group as a dimension chip. handleFieldToggle
  // adds non-numeric fields to ROWS by default (drag the chip to Columns or
  // Filters afterwards); unchecking removes it from every zone by name.
  const placeCalcGroup = useCallback(
    (groupName: string, place: boolean) => {
      handleFieldToggle({ index: -1, name: groupName, isNumeric: false }, place);
    },
    [handleFieldToggle],
  );

  // Field-list adapters (Power BI-style): the group node's checkbox places the
  // group as a dimension; only one group can be placed at a time, so checking
  // a second group swaps the first out. Item checkboxes edit the chip's
  // hidden-items subset; checking an item of a non-placed group places the
  // group with only that item visible; unchecking the last item removes it.
  const handleFieldListCalcGroupToggle = useCallback(
    (group: BiCalcGroup, checked: boolean) => {
      if (checked && placedCalcGroup && placedCalcGroup.group !== group.name) {
        placeCalcGroup(placedCalcGroup.group, false);
      }
      placeCalcGroup(group.name, checked);
    },
    [placedCalcGroup, placeCalcGroup],
  );
  // Field-list display state: items = the VISIBLE subset ([] = all items).
  const fieldListCalcGroupState = useMemo(() => {
    if (!placedCalcGroup) return null;
    if (placedCalcGroup.hiddenItems.length === 0) {
      return { group: placedCalcGroup.group, items: [] as string[] };
    }
    const def = fieldListModel?.calculationGroups?.find(
      (g) => g.name === placedCalcGroup.group,
    );
    const visible = (def?.items ?? [])
      .map((i) => i.name)
      .filter((n) => !placedCalcGroup.hiddenItems.includes(n));
    return { group: placedCalcGroup.group, items: visible };
  }, [placedCalcGroup, fieldListModel?.calculationGroups]);

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
            appliedCalcGroup={fieldListCalcGroupState}
            onCalcGroupToggle={handleFieldListCalcGroupToggle}
            calcGroupsDisabledReason={
              lookupColumns.size > 0 && !placedCalcGroup
                ? 'Remove lookup columns to place a calculation group.'
                : null
            }
            selectedPerspective={selectedPerspective}
            onPerspectiveChange={handlePerspectiveChange}
            cultures={fieldListModel?.cultures}
            locale={uiLocale}
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
          onDrop={handleDropWithAutoLookup}
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