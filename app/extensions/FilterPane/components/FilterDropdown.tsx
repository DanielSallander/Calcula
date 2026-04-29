//! FILENAME: app/extensions/FilterPane/components/FilterDropdown.tsx
// PURPOSE: Dropdown checklist anchored below a ribbon filter card.
//          Includes search, select all/none, OK/Cancel, and actions.

import React, { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { getSheets, emitAppEvent, AppEvents } from "@api";
import { invokeBackend, getAllPivotTables } from "@api/backend";
import type { SlicerItem, SlicerConnection, ConnectionMode, UpdateRibbonFilterParams, AdvancedFilter, AdvancedFilterOperator, AdvancedFilterLogic, FieldDataType } from "../lib/filterPaneTypes";
import { updateFilterAsync, updateFilterSelectionAsync, getAllFilters } from "../lib/filterPaneStore";
import { getAllSlicers as fetchAllSlicers, type SlicerInfo } from "../lib/filterPaneApi";

/** Resolve a pivot field's index from its name. */
async function resolveFieldIndex(
  pivotId: number,
  fieldName: string,
): Promise<number> {
  try {
    const info = await invokeBackend<{
      hierarchies: Array<{ index: number; name: string }>;
    }>("get_pivot_hierarchies", { pivotId });
    let field = info.hierarchies.find((h) => h.name === fieldName);
    if (!field && fieldName.includes(".")) {
      const colPart = fieldName.split(".").pop()!;
      field = info.hierarchies.find((h) => h.name === colPart);
    }
    return field ? field.index : -1;
  } catch {
    return -1;
  }
}

export interface FilterDropdownProps {
  filterId: number;
  fieldName: string;
  items: SlicerItem[];
  selectedItems: string[] | null;
  anchorRect: DOMRect;
  onApply: (selectedItems: string[] | null) => void;
  onClose: () => void;
  onDelete: () => void;
  connectionMode: ConnectionMode;
  crossFilterTargets: number[];
  crossFilterSlicerTargets: number[];
  advancedFilter: AdvancedFilter | null;
  fieldDataType: FieldDataType;
  connectedSources?: SlicerConnection[];
  connectedSheets?: number[];
  hideNoData: boolean;
  indicateNoData: boolean;
  sortNoDataLast: boolean;
  showSelectAll: boolean;
  singleSelect: boolean;
}

export function FilterDropdown({
  filterId,
  fieldName,
  items,
  selectedItems,
  anchorRect,
  onApply,
  onClose,
  onDelete,
  connectionMode,
  crossFilterTargets,
  advancedFilter,
  fieldDataType,
  connectedSources,
  connectedSheets,
  hideNoData,
  indicateNoData,
  sortNoDataLast,
  showSelectAll,
  singleSelect,
  crossFilterSlicerTargets,
}: FilterDropdownProps): React.ReactElement {
  const cachedFilters = getAllFilters();
  // Local selection state for OK/Cancel pattern
  const allValues = useMemo(() => items.map((i) => i.value), [items]);
  const [localSelected, setLocalSelected] = useState<Set<string>>(() => {
    if (selectedItems === null) return new Set(allValues);
    return new Set(selectedItems);
  });
  const [searchText, setSearchText] = useState("");
  const [filterMode, setFilterMode] = useState<"basic" | "advanced">(
    advancedFilter ? "advanced" : "basic",
  );
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Sub-panel state
  type PanelView = "none" | "connections" | "crossTargets" | "settings";
  const [panelView, setPanelView] = useState<PanelView>("none");

  // Alias for backward compat in the JSX
  const showConnections = panelView === "connections";
  const setShowConnections = (v: boolean) => setPanelView(v ? "connections" : "none");
  const [localMode, setLocalMode] = useState<ConnectionMode>(connectionMode);
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [localSheets, setLocalSheets] = useState<Set<number>>(
    new Set(connectedSheets ?? []),
  );

  const [localCrossTargets, setLocalCrossTargets] = useState<Set<number>>(
    new Set(crossFilterTargets),
  );
  const [localCrossSlicerTargets, setLocalCrossSlicerTargets] = useState<Set<number>>(
    new Set(crossFilterSlicerTargets),
  );
  const [availableSlicers, setAvailableSlicers] = useState<SlicerInfo[]>([]);

  // For manual mode: list of all available pivots + tables
  interface SourceEntry {
    type: "pivot" | "table";
    id: number;
    name: string;
  }
  const [availableSources, setAvailableSources] = useState<SourceEntry[]>([]);
  const [localConnections, setLocalConnections] = useState<Set<string>>(() => {
    return new Set(
      (connectedSources ?? []).map((c) => `${c.sourceType}:${c.sourceId}`),
    );
  });

  // Load slicers when cross-filter panel opens
  useEffect(() => {
    if (panelView !== "crossTargets") return;
    fetchAllSlicers().then(setAvailableSlicers).catch(console.error);
  }, [panelView]);

  // Load sheet names + available sources when showing connections
  useEffect(() => {
    if (!showConnections) return;
    getSheets().then((result) => {
      setSheetNames(result.sheets.map((s: { name: string }) => s.name));
    });
    // Load all pivots and tables for manual mode
    (async () => {
      const entries: SourceEntry[] = [];
      try {
        const pivots = await getAllPivotTables<
          Array<{ id: number; name: string; sourceRange: string }>
        >();
        for (const pv of pivots) {
          entries.push({ type: "pivot", id: pv.id, name: pv.name });
        }
      } catch { /* no pivots */ }
      try {
        const tables = await invokeBackend<
          Array<{ id: number; name: string; sheetIndex: number }>
        >("get_all_tables", {});
        for (const t of tables) {
          entries.push({ type: "table", id: t.id, name: t.name });
        }
      } catch { /* no tables */ }
      setAvailableSources(entries);
    })();
  }, [showConnections]);

  const handleSaveConnections = useCallback(async () => {
    // Find connections that were removed so we can clear their filters
    const oldKeys = new Set(
      (connectedSources ?? []).map((c) => `${c.sourceType}:${c.sourceId}`),
    );

    const updates: UpdateRibbonFilterParams = {
      connectionMode: localMode,
      connectedSheets: localMode === "bySheet" ? Array.from(localSheets) : [],
      crossFilterTargets: Array.from(localCrossTargets),
      crossFilterSlicerTargets: Array.from(localCrossSlicerTargets),
    };
    if (localMode === "manual") {
      updates.connectedSources = Array.from(localConnections).map((key) => {
        const [type, id] = key.split(":");
        return { sourceType: type as "pivot" | "table", sourceId: Number(id) };
      });
    }
    await updateFilterAsync(filterId, updates);

    // Clear filters on removed connections
    const newKeys = localMode === "manual" ? localConnections : new Set<string>();
    for (const oldKey of oldKeys) {
      if (localMode !== "manual" || !newKeys.has(oldKey)) {
        const [type, id] = oldKey.split(":");
        try {
          if (type === "pivot") {
            // Clear pivot filter for this field
            const fieldIndex = await resolveFieldIndex(Number(id), fieldName);
            if (fieldIndex >= 0) {
              await invokeBackend("clear_pivot_filter", {
                request: { pivotId: Number(id), fieldIndex },
              });
              window.dispatchEvent(new Event("pivot:refresh"));
            }
          } else if (type === "table") {
            await invokeBackend("clear_column_filter", { columnIndex: 0 });
          }
        } catch {
          // Best effort
        }
      }
    }

    emitAppEvent(AppEvents.GRID_DATA_REFRESH);

    // Trigger slicer refresh so cross-filter has_data is recalculated
    window.dispatchEvent(
      new CustomEvent("ribbonFilter:selectionChanged", {
        detail: { filterId },
      }),
    );

    setShowConnections(false);
  }, [filterId, fieldName, localMode, localSheets, localConnections, localCrossTargets, localCrossSlicerTargets, connectedSources]);

  // Close on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Delay to avoid closing immediately from the toggle click
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClick);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleToggle = useCallback((value: string) => {
    if (singleSelect) {
      // Single-select: only one item at a time
      setLocalSelected(new Set([value]));
    } else {
      setLocalSelected((prev) => {
        const next = new Set(prev);
        if (next.has(value)) next.delete(value);
        else next.add(value);
        return next;
      });
    }
  }, [singleSelect]);

  const handleSelectAll = useCallback(() => {
    setLocalSelected(new Set(allValues));
  }, [allValues]);

  const handleSelectNone = useCallback(() => {
    setLocalSelected(new Set());
  }, []);

  const handleOk = useCallback(() => {
    // If all selected, clear filter (null = all)
    if (localSelected.size === allValues.length) {
      onApply(null);
    } else {
      onApply(Array.from(localSelected));
    }
  }, [localSelected, allValues, onApply]);

  const filtered = useMemo(() => {
    let result = items;
    // Hide items with no data if setting is enabled
    if (hideNoData) {
      result = result.filter((i) => i.hasData);
    }
    // Filter by search text
    if (searchText) {
      const lower = searchText.toLowerCase();
      result = result.filter((i) => i.value.toLowerCase().includes(lower));
    }
    // Sort items with no data to the bottom
    if (sortNoDataLast && !hideNoData) {
      result = [...result].sort((a, b) => {
        if (a.hasData === b.hasData) return 0;
        return a.hasData ? -1 : 1;
      });
    }
    return result;
  }, [items, searchText, hideNoData, sortNoDataLast]);

  // Position: below the card, aligned left
  const top = anchorRect.bottom + 2;
  const left = Math.min(anchorRect.left, window.innerWidth - 260);

  return createPortal(
    <div
      ref={dropdownRef}
      style={{
        position: "fixed",
        left,
        top,
        width: 250,
        maxHeight: 420,
        backgroundColor: "#fff",
        border: "1px solid #d1d5db",
        borderRadius: 4,
        boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
        zIndex: 10000,
        display: "flex",
        flexDirection: "column",
        fontSize: 13,
        color: "#333",
      }}
    >
      {/* Header + Mode selector */}
      <div style={styles.header}>
        <span style={{ flex: 1 }}>{fieldName}</span>
        <select
          value={filterMode}
          onChange={(e) => setFilterMode(e.target.value as "basic" | "advanced")}
          style={styles.modeSelect}
        >
          <option value="basic">Basic filtering</option>
          <option value="advanced">Advanced filtering</option>
        </select>
      </div>

      {/* Basic filtering mode */}
      {filterMode === "basic" && (
        <>
          {/* Search */}
          {items.length > 8 && (
            <div style={styles.searchRow}>
              <input
                type="text"
                placeholder="Search..."
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                style={styles.searchInput}
                autoFocus
              />
            </div>
          )}

          {/* Select All / None */}
          {!singleSelect && (showSelectAll || true) && (
            <div style={styles.bulkRow}>
              <button onClick={handleSelectAll} style={styles.bulkButton}>
                Select All
              </button>
              <button onClick={handleSelectNone} style={styles.bulkButton}>
                Select None
              </button>
            </div>
          )}

          {/* Items */}
          <div style={styles.itemList}>
            {filtered.map((item) => (
              <label
                key={item.value}
                style={{
                  ...styles.itemRow,
                  opacity: indicateNoData && !item.hasData ? 0.45 : 1,
                }}
              >
                <input
                  type={singleSelect ? "radio" : "checkbox"}
                  checked={localSelected.has(item.value)}
                  onChange={() => handleToggle(item.value)}
                  name={singleSelect ? `filter-${filterId}` : undefined}
                  style={{ marginRight: 8 }}
                />
                <span style={styles.itemLabel}>{item.value || "(Blank)"}</span>
              </label>
            ))}
            {filtered.length === 0 && (
              <div style={styles.noResults}>No matching values</div>
            )}
          </div>

          {/* OK / Cancel */}
          <div style={styles.footer}>
            <button onClick={handleOk} style={styles.okButton}>
              OK
            </button>
            <button onClick={onClose} style={styles.cancelButton}>
              Cancel
            </button>
          </div>
        </>
      )}

      {/* Advanced filtering mode */}
      {filterMode === "advanced" && (
        <AdvancedFilterPanel
          filterId={filterId}
          currentFilter={advancedFilter}
          fieldDataType={fieldDataType}
          items={items}
          onApply={(selected) => {
            onApply(selected);
          }}
          onClose={onClose}
        />
      )}

      {/* Actions separator */}
      <div style={styles.actionsDivider} />

      {/* Actions / Sub-panels */}
      {panelView === "none" ? (
        <div style={styles.actionsRow}>
          <button onClick={() => setPanelView("connections")} style={styles.actionLink}>
            Connections
          </button>
          <button onClick={() => setPanelView("crossTargets")} style={styles.actionLink}>
            Cross-filter
          </button>
          <button onClick={() => setPanelView("settings")} style={styles.actionLink}>
            Settings
          </button>
          <button onClick={onDelete} style={{ ...styles.actionLink, color: "#c00" }}>
            Remove
          </button>
        </div>
      ) : panelView === "settings" ? (
        <FilterSettingsPanel
          filterId={filterId}
          hideNoData={hideNoData}
          indicateNoData={indicateNoData}
          sortNoDataLast={sortNoDataLast}
          showSelectAll={showSelectAll}
          singleSelect={singleSelect}
          onClose={() => setPanelView("none")}
        />
      ) : panelView === "crossTargets" ? (
        <div style={styles.connectionsPanel}>
          <div style={styles.connectionsHeader}>Cross-filter Targets</div>
          <div style={styles.modeHint}>
            Select which filters and slicers this filter should cross-filter.
            Target items will be dimmed when they have no matching data.
          </div>
          <div style={styles.sheetList}>
            {/* Other ribbon filters */}
            {cachedFilters
              .filter((f) => f.id !== filterId)
              .map((f) => {
                const shortName = f.fieldName.includes(".")
                  ? f.fieldName.split(".").pop()!
                  : f.fieldName;
                return (
                  <label key={`f-${f.id}`} style={styles.itemRow}>
                    <input
                      type="checkbox"
                      checked={localCrossTargets.has(f.id)}
                      onChange={() => {
                        setLocalCrossTargets((prev) => {
                          const next = new Set(prev);
                          if (next.has(f.id)) next.delete(f.id);
                          else next.add(f.id);
                          return next;
                        });
                      }}
                      style={{ marginRight: 8 }}
                    />
                    <span style={{ fontSize: 10, color: "#888", marginRight: 4 }}>[F]</span>
                    <span>{shortName}</span>
                  </label>
                );
              })}
            {/* Canvas slicers */}
            {availableSlicers.map((s) => {
              const shortName = s.fieldName.includes(".")
                ? s.fieldName.split(".").pop()!
                : s.fieldName;
              return (
                <label key={`s-${s.id}`} style={styles.itemRow}>
                  <input
                    type="checkbox"
                    checked={localCrossSlicerTargets.has(s.id)}
                    onChange={() => {
                      setLocalCrossSlicerTargets((prev) => {
                        const next = new Set(prev);
                        if (next.has(s.id)) next.delete(s.id);
                        else next.add(s.id);
                        return next;
                      });
                    }}
                    style={{ marginRight: 8 }}
                  />
                  <span style={{ fontSize: 10, color: "#888", marginRight: 4 }}>[S]</span>
                  <span>{shortName}</span>
                </label>
              );
            })}
            {cachedFilters.filter((f) => f.id !== filterId).length === 0 &&
              availableSlicers.length === 0 && (
              <div style={styles.modeHint}>No other filters or slicers to cross-filter.</div>
            )}
          </div>
          <div style={styles.connectionsFooter}>
            <button onClick={handleSaveConnections} style={styles.okButton}>Save</button>
            <button
              onClick={() => {
                setLocalCrossTargets(new Set(crossFilterTargets));
                setLocalCrossSlicerTargets(new Set(crossFilterSlicerTargets));
                setPanelView("none");
              }}
              style={styles.cancelButton}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div style={styles.connectionsPanel}>
          <div style={styles.connectionsHeader}>Report Connections</div>
          {/* Mode selector */}
          <div style={styles.modeRow}>
            {(["manual", "bySheet", "workbook"] as const).map((mode) => (
              <label key={mode} style={styles.modeLabel}>
                <input
                  type="radio"
                  name="connMode"
                  checked={localMode === mode}
                  onChange={() => setLocalMode(mode)}
                />
                {mode === "manual"
                  ? "Manual"
                  : mode === "bySheet"
                    ? "By Sheet"
                    : "Workbook"}
              </label>
            ))}
          </div>

          {/* Sheet list (only for bySheet mode) */}
          {localMode === "bySheet" && (
            <div style={styles.sheetList}>
              {sheetNames.map((name, idx) => (
                <label key={idx} style={styles.itemRow}>
                  <input
                    type="checkbox"
                    checked={localSheets.has(idx)}
                    onChange={() => {
                      setLocalSheets((prev) => {
                        const next = new Set(prev);
                        if (next.has(idx)) next.delete(idx);
                        else next.add(idx);
                        return next;
                      });
                    }}
                    style={{ marginRight: 8 }}
                  />
                  <span>{name}</span>
                </label>
              ))}
            </div>
          )}

          {localMode === "workbook" && (
            <div style={styles.modeHint}>
              Automatically connects to all pivot tables and tables in the
              workbook, including newly created ones.
            </div>
          )}

          {localMode === "manual" && (
            <div style={styles.sheetList}>
              {availableSources.length === 0 ? (
                <div style={styles.modeHint}>
                  No pivot tables or tables found in the workbook.
                </div>
              ) : (
                availableSources.map((src) => {
                  const key = `${src.type}:${src.id}`;
                  return (
                    <label key={key} style={styles.itemRow}>
                      <input
                        type="checkbox"
                        checked={localConnections.has(key)}
                        onChange={() => {
                          setLocalConnections((prev) => {
                            const next = new Set(prev);
                            if (next.has(key)) next.delete(key);
                            else next.add(key);
                            return next;
                          });
                        }}
                        style={{ marginRight: 8 }}
                      />
                      <span style={{ fontSize: 10, color: "#888", marginRight: 4 }}>
                        {src.type === "pivot" ? "[P]" : "[T]"}
                      </span>
                      <span>{src.name}</span>
                    </label>
                  );
                })
              )}
            </div>
          )}

          <div style={styles.connectionsFooter}>
            <button onClick={handleSaveConnections} style={styles.okButton}>
              Save
            </button>
            <button
              onClick={() => {
                setLocalMode(connectionMode);
                setLocalSheets(new Set(connectedSheets ?? []));
                setLocalCrossTargets(new Set(crossFilterTargets));
                setPanelView("none");
              }}
              style={styles.cancelButton}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}

// ============================================================================
// Filter Settings Panel
// ============================================================================

function FilterSettingsPanel({
  filterId,
  hideNoData: initHideNoData,
  indicateNoData: initIndicateNoData,
  sortNoDataLast: initSortNoDataLast,
  showSelectAll: initShowSelectAll,
  singleSelect: initSingleSelect,
  onClose,
}: {
  filterId: number;
  hideNoData: boolean;
  indicateNoData: boolean;
  sortNoDataLast: boolean;
  showSelectAll: boolean;
  singleSelect: boolean;
  onClose: () => void;
}): React.ReactElement {
  const [localHideNoData, setLocalHideNoData] = useState(initHideNoData);
  const [localIndicateNoData, setLocalIndicateNoData] = useState(initIndicateNoData);
  const [localSortNoDataLast, setLocalSortNoDataLast] = useState(initSortNoDataLast);
  const [localShowSelectAll, setLocalShowSelectAll] = useState(initShowSelectAll);
  const [localSingleSelect, setLocalSingleSelect] = useState(initSingleSelect);

  const handleSave = useCallback(async () => {
    await updateFilterAsync(filterId, {
      hideNoData: localHideNoData,
      indicateNoData: localIndicateNoData,
      sortNoDataLast: localSortNoDataLast,
      showSelectAll: localShowSelectAll,
      singleSelect: localSingleSelect,
    });
    onClose();
  }, [
    filterId, localHideNoData, localIndicateNoData, localSortNoDataLast,
    localShowSelectAll, localSingleSelect, onClose,
  ]);

  return (
    <div style={styles.connectionsPanel}>
      <div style={styles.connectionsHeader}>Filter Settings</div>

      {/* Selection */}
      <div style={{ fontSize: 11, fontWeight: 600, color: "#555", marginBottom: 4 }}>
        Selection
      </div>
      <SettingsToggle label="Single select" checked={localSingleSelect} onChange={setLocalSingleSelect} />
      <SettingsToggle label={'Show "Select all" option'} checked={localShowSelectAll} onChange={setLocalShowSelectAll} />

      {/* Data display */}
      <div style={{ fontSize: 11, fontWeight: 600, color: "#555", marginTop: 8, marginBottom: 4 }}>
        Data display
      </div>
      <SettingsToggle label="Hide items with no data" checked={localHideNoData} onChange={setLocalHideNoData} />
      <SettingsToggle
        label="Visually indicate items with no data"
        checked={localIndicateNoData}
        onChange={setLocalIndicateNoData}
        disabled={localHideNoData}
      />
      <SettingsToggle
        label="Show items with no data last"
        checked={localSortNoDataLast}
        onChange={setLocalSortNoDataLast}
        disabled={localHideNoData}
      />

      <div style={styles.connectionsFooter}>
        <button onClick={handleSave} style={styles.okButton}>Save</button>
        <button onClick={onClose} style={styles.cancelButton}>Cancel</button>
      </div>
    </div>
  );
}

function SettingsToggle({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <label
      style={{
        ...styles.itemRow,
        opacity: disabled ? 0.45 : 1,
        pointerEvents: disabled ? "none" : "auto",
        justifyContent: "space-between",
      }}
    >
      <span style={{ fontSize: 11 }}>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={() => onChange(!checked)}
        disabled={disabled}
      />
    </label>
  );
}

// ============================================================================
// Advanced Filter Panel
// ============================================================================

const TEXT_OPERATORS: { value: AdvancedFilterOperator; label: string }[] = [
  { value: "contains", label: "contains" },
  { value: "doesNotContain", label: "does not contain" },
  { value: "startsWith", label: "starts with" },
  { value: "doesNotStartWith", label: "does not start with" },
  { value: "is", label: "is" },
  { value: "isNot", label: "is not" },
  { value: "isBlank", label: "is blank" },
  { value: "isNotBlank", label: "is not blank" },
  { value: "isEmpty", label: "is empty" },
  { value: "isNotEmpty", label: "is not empty" },
];

const NUMBER_OPERATORS: { value: AdvancedFilterOperator; label: string }[] = [
  { value: "isLessThan", label: "is less than" },
  { value: "isLessThanOrEqualTo", label: "is less than or equal to" },
  { value: "isGreaterThan", label: "is greater than" },
  { value: "isGreaterThanOrEqualTo", label: "is greater than or equal to" },
  { value: "is", label: "is" },
  { value: "isNot", label: "is not" },
  { value: "isBlank", label: "is blank" },
  { value: "isNotBlank", label: "is not blank" },
];

const DATE_OPERATORS: { value: AdvancedFilterOperator; label: string }[] = [
  { value: "is", label: "is" },
  { value: "isNot", label: "is not" },
  { value: "isAfter", label: "is after" },
  { value: "isOnOrAfter", label: "is on or after" },
  { value: "isBefore", label: "is before" },
  { value: "isOnOrBefore", label: "is on or before" },
  { value: "isBlank", label: "is blank" },
  { value: "isNotBlank", label: "is not blank" },
];

function getOperatorsForType(
  dataType: FieldDataType,
): { value: AdvancedFilterOperator; label: string }[] {
  switch (dataType) {
    case "number": return NUMBER_OPERATORS;
    case "date": return DATE_OPERATORS;
    case "text": return TEXT_OPERATORS;
    default: return TEXT_OPERATORS; // default to text operators for unknown
  }
}

function needsValue(op: AdvancedFilterOperator): boolean {
  return op !== "isBlank" && op !== "isNotBlank";
}

/** Evaluate a single condition against a value. */
function evalCondition(
  value: string,
  op: AdvancedFilterOperator,
  target: string,
): boolean {
  const vLower = value.toLowerCase();
  const tLower = target.toLowerCase();
  switch (op) {
    case "is": return vLower === tLower;
    case "isNot": return vLower !== tLower;
    case "contains": return vLower.includes(tLower);
    case "doesNotContain": return !vLower.includes(tLower);
    case "startsWith": return vLower.startsWith(tLower);
    case "doesNotStartWith": return !vLower.startsWith(tLower);
    case "isBlank": return value.trim() === "";
    case "isNotBlank": return value.trim() !== "";
    case "isEmpty": return value === "";
    case "isNotEmpty": return value !== "";
    case "isLessThan": return parseFloat(value) < parseFloat(target);
    case "isLessThanOrEqualTo": return parseFloat(value) <= parseFloat(target);
    case "isGreaterThan": return parseFloat(value) > parseFloat(target);
    case "isGreaterThanOrEqualTo": return parseFloat(value) >= parseFloat(target);
    case "isAfter": return value > target;
    case "isOnOrAfter": return value >= target;
    case "isBefore": return value < target;
    case "isOnOrBefore": return value <= target;
    default: return true;
  }
}

function AdvancedFilterPanel({
  filterId,
  currentFilter,
  fieldDataType,
  items,
  onApply,
  onClose,
}: {
  filterId: number;
  currentFilter: AdvancedFilter | null;
  fieldDataType: FieldDataType;
  items: SlicerItem[];
  onApply: (selectedItems: string[] | null) => void;
  onClose: () => void;
}): React.ReactElement {
  const operators = getOperatorsForType(fieldDataType);
  const defaultOp = operators[0]?.value ?? "is";

  const [op1, setOp1] = useState<AdvancedFilterOperator>(
    currentFilter?.condition1.operator ?? defaultOp,
  );
  const [val1, setVal1] = useState(currentFilter?.condition1.value ?? "");
  const [logic, setLogic] = useState<AdvancedFilterLogic>(
    currentFilter?.logic ?? "and",
  );
  const [op2, setOp2] = useState<AdvancedFilterOperator>(
    currentFilter?.condition2?.operator ?? defaultOp,
  );
  const [val2, setVal2] = useState(currentFilter?.condition2?.value ?? "");
  const [hasCond2, setHasCond2] = useState(!!currentFilter?.condition2);

  const handleApply = useCallback(async () => {
    // Evaluate conditions against all item values
    const matching = items
      .map((i) => i.value)
      .filter((v) => {
        const c1 = evalCondition(v, op1, val1);
        if (!hasCond2 || !val2) return c1;
        const c2 = evalCondition(v, op2, val2);
        return logic === "and" ? c1 && c2 : c1 || c2;
      });

    // Save the advanced filter definition
    const af: AdvancedFilter = {
      condition1: { operator: op1, value: val1 },
      condition2: hasCond2 && val2 ? { operator: op2, value: val2 } : null,
      logic,
    };
    await updateFilterAsync(filterId, { advancedFilter: af });

    // Apply the matching items as the selection
    if (matching.length === items.length) {
      onApply(null); // All match = clear filter
    } else {
      onApply(matching);
    }
  }, [filterId, op1, val1, logic, op2, val2, hasCond2, items, onApply]);

  const handleClear = useCallback(async () => {
    // Clear advanced filter and selection together, awaiting both
    // to ensure the backend is fully updated before closing.
    await updateFilterAsync(filterId, { advancedFilter: null });
    await updateFilterSelectionAsync(filterId, null);
    onApply(null);
  }, [filterId, onApply]);

  return (
    <div style={styles.connectionsPanel}>
      <div style={{ fontSize: 11, color: "#666", marginBottom: 6 }}>
        Show items when the value
      </div>

      {/* Condition 1 */}
      <select
        value={op1}
        onChange={(e) => setOp1(e.target.value as AdvancedFilterOperator)}
        style={styles.advSelect}
      >
        {operators.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {needsValue(op1) && (
        <input
          type="text"
          value={val1}
          onChange={(e) => setVal1(e.target.value)}
          placeholder="Value..."
          style={styles.advInput}
        />
      )}

      {/* Logic toggle */}
      <div style={styles.advLogicRow}>
        <label style={styles.modeLabel}>
          <input
            type="radio"
            name="advLogic"
            checked={logic === "and"}
            onChange={() => setLogic("and")}
          />
          And
        </label>
        <label style={styles.modeLabel}>
          <input
            type="radio"
            name="advLogic"
            checked={logic === "or"}
            onChange={() => setLogic("or")}
          />
          Or
        </label>
      </div>

      {/* Condition 2 */}
      <select
        value={op2}
        onChange={(e) => {
          setOp2(e.target.value as AdvancedFilterOperator);
          setHasCond2(true);
        }}
        style={styles.advSelect}
      >
        {operators.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {needsValue(op2) && (
        <input
          type="text"
          value={val2}
          onChange={(e) => { setVal2(e.target.value); setHasCond2(true); }}
          placeholder="Value..."
          style={styles.advInput}
        />
      )}

      <div style={styles.connectionsFooter}>
        <button onClick={handleApply} style={styles.okButton}>
          Apply filter
        </button>
        <button onClick={handleClear} style={styles.cancelButton}>
          Clear
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  header: {
    padding: "8px 12px",
    borderBottom: "1px solid #e5e7eb",
    fontWeight: 600,
    fontSize: "12px",
    color: "#333",
    display: "flex",
    alignItems: "center",
    gap: "6px",
  },
  modeSelect: {
    fontSize: 10,
    padding: "2px 4px",
    border: "1px solid #d1d5db",
    borderRadius: 3,
    background: "#f9fafb",
    color: "#555",
    cursor: "pointer",
    flexShrink: 0,
  },
  searchRow: {
    padding: "6px 12px",
    borderBottom: "1px solid #e5e7eb",
  },
  searchInput: {
    width: "100%",
    padding: "5px 8px",
    border: "1px solid #d1d5db",
    borderRadius: 3,
    fontSize: 12,
    outline: "none",
    boxSizing: "border-box" as const,
  },
  bulkRow: {
    padding: "4px 12px",
    borderBottom: "1px solid #e5e7eb",
    display: "flex",
    gap: "6px",
  },
  bulkButton: {
    padding: "3px 8px",
    border: "1px solid #d1d5db",
    borderRadius: 3,
    background: "#f9fafb",
    cursor: "pointer",
    fontSize: 11,
    color: "#333",
  },
  itemList: {
    flex: 1,
    overflowY: "auto" as const,
    maxHeight: 200,
    padding: "4px 0",
  },
  itemRow: {
    display: "flex",
    alignItems: "center",
    padding: "3px 12px",
    cursor: "pointer",
    fontSize: 12,
  },
  itemLabel: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  noResults: {
    padding: "8px 12px",
    color: "#999",
    fontStyle: "italic",
    fontSize: 12,
  },
  footer: {
    padding: "6px 12px",
    borderTop: "1px solid #e5e7eb",
    display: "flex",
    justifyContent: "flex-end",
    gap: "6px",
  },
  okButton: {
    padding: "4px 16px",
    border: "none",
    borderRadius: 3,
    background: "#0078d4",
    color: "#fff",
    cursor: "pointer",
    fontSize: 12,
  },
  cancelButton: {
    padding: "4px 12px",
    border: "1px solid #d1d5db",
    borderRadius: 3,
    background: "#fff",
    cursor: "pointer",
    fontSize: 12,
    color: "#333",
  },
  actionsDivider: {
    height: "1px",
    background: "#e5e7eb",
  },
  actionsRow: {
    padding: "4px 12px 6px",
    display: "flex",
    gap: "8px",
  },
  actionLink: {
    border: "none",
    background: "none",
    cursor: "pointer",
    fontSize: 11,
    color: "#0078d4",
    padding: "2px 0",
    textDecoration: "underline",
  },
  connectionsPanel: {
    padding: "8px 12px",
  },
  connectionsHeader: {
    fontSize: 12,
    fontWeight: 600,
    marginBottom: 6,
    color: "#333",
  },
  modeRow: {
    display: "flex",
    gap: "10px",
    marginBottom: 6,
  },
  modeLabel: {
    display: "flex",
    alignItems: "center",
    gap: "3px",
    fontSize: 11,
    cursor: "pointer",
  },
  sheetList: {
    maxHeight: 120,
    overflowY: "auto" as const,
    border: "1px solid #e5e7eb",
    borderRadius: 3,
    padding: "4px 0",
    marginBottom: 6,
  },
  modeHint: {
    fontSize: 10,
    color: "#888",
    fontStyle: "italic",
    marginBottom: 6,
    lineHeight: "1.4",
  },
  connectionsFooter: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 6,
  },
  advSelect: {
    width: "100%",
    padding: "4px 6px",
    fontSize: 11,
    border: "1px solid #d1d5db",
    borderRadius: 3,
    marginBottom: 4,
    boxSizing: "border-box" as const,
  },
  advInput: {
    width: "100%",
    padding: "4px 6px",
    fontSize: 11,
    border: "1px solid #d1d5db",
    borderRadius: 3,
    marginBottom: 4,
    boxSizing: "border-box" as const,
  },
  advLogicRow: {
    display: "flex",
    gap: 12,
    margin: "4px 0",
  },
};
