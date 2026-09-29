//! FILENAME: app/extensions/ControlsPane/components/FilterDropdown.tsx
// PURPOSE: Dropdown checklist anchored below a ribbon filter card.
//          Includes search, select all/none, OK/Cancel, and actions.
// CONTEXT: Report Connections only ever offer the BI pivots backed by the
//          filter's own model connection.
//
//          Hosted in an @api card Popover (Calcula Clusters): the Popover owns
//          positioning, the card chrome, and dismissal on Escape or a press
//          outside both the popover and its anchor (the filter card). It used
//          to be its own position:fixed body portal with a hardcoded white box and
//          its own document listeners; every colour is now a token, so the
//          checklist follows the skin in Dark. The filtering logic is
//          unchanged.

import React, { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { getSheets, emitAppEvent, AppEvents } from "@api";
import {
  Button,
  Input,
  LT,
  Popover,
  Select,
  SurfaceLayoutProvider,
  popoverLayout,
} from "@api/layout";
import { focusWhenVisible, primaryButtonClass } from "./paneChrome";
import { runStepThenConfirmOverwrite } from "@api/pivotOverwrite";
import type { SlicerItem, ConnectionMode, UpdateRibbonFilterParams, AdvancedFilter, AdvancedFilterOperator, AdvancedFilterLogic, FieldDataType } from "../lib/filterPaneTypes";
import { updateFilterAsync, updateFilterSelectionAsync, getAllFilters, getConnectionName } from "../lib/filterPaneStore";
import {
  applyRibbonFilter,
  clearModelColumnOnPivots,
  reportRibbonFilterFailures,
  type RibbonFilterFailure,
} from "../lib/filterPaneFilterBridge";
import {
  getAllSlicers as fetchAllSlicers,
  getPivotsForBiConnection,
  type SlicerInfo,
  type BiConnectionPivot,
} from "../lib/filterPaneApi";

export interface FilterDropdownProps {
  filterId: string;
  fieldName: string;
  items: SlicerItem[];
  selectedItems: string[] | null;
  /** The filter card the popover hangs below (and never dismisses on). */
  anchorEl: HTMLElement;
  onApply: (selectedItems: string[] | null) => void;
  onClose: () => void;
  onDelete: () => void;
  /** The model connection this filter is sourced from. */
  connectionId: string;
  connectionMode: ConnectionMode;
  crossFilterTargets: string[];
  crossFilterSlicerTargets: string[];
  advancedFilter: AdvancedFilter | null;
  fieldDataType: FieldDataType;
  connectedPivots?: string[];
  connectedSheets?: number[];
  hideNoData: boolean;
  indicateNoData: boolean;
  sortNoDataLast: boolean;
  showSelectAll: boolean;
  singleSelect: boolean;
  /** Filter level: 1 = ordinary, 2-9 = pinned. */
  filterLevel: number;
}

export function FilterDropdown({
  filterId,
  fieldName,
  items,
  selectedItems,
  anchorEl,
  onApply,
  onClose,
  onDelete,
  connectionId,
  connectionMode,
  crossFilterTargets,
  advancedFilter,
  fieldDataType,
  connectedPivots,
  connectedSheets,
  hideNoData,
  indicateNoData,
  sortNoDataLast,
  showSelectAll,
  singleSelect,
  filterLevel,
  crossFilterSlicerTargets,
}: FilterDropdownProps): React.ReactElement {
  const cachedFilters = getAllFilters();
  const connectionName = getConnectionName(connectionId);
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

  const [localCrossTargets, setLocalCrossTargets] = useState<Set<string>>(
    new Set(crossFilterTargets),
  );
  const [localCrossSlicerTargets, setLocalCrossSlicerTargets] = useState<Set<string>>(
    new Set(crossFilterSlicerTargets),
  );
  const [availableSlicers, setAvailableSlicers] = useState<SlicerInfo[]>([]);

  // For manual mode: the connection's BI pivots available as targets
  const [availablePivots, setAvailablePivots] = useState<BiConnectionPivot[]>([]);
  const [localConnections, setLocalConnections] = useState<Set<string>>(() => {
    return new Set(connectedPivots ?? []);
  });

  // Load slicers when cross-filter panel opens
  useEffect(() => {
    if (panelView !== "crossTargets") return;
    fetchAllSlicers().then(setAvailableSlicers).catch(console.error);
  }, [panelView]);

  // Load sheet names + this connection's pivots when showing connections
  useEffect(() => {
    if (!showConnections) return;
    getSheets().then((result) => {
      setSheetNames(result.sheets.map((s: { name: string }) => s.name));
    });
    getPivotsForBiConnection(connectionId)
      .then(setAvailablePivots)
      .catch(() => setAvailablePivots([]));
  }, [showConnections, connectionId]);

  const handleSaveConnections = useCallback(async () => {
    // Effective target sets before and after the change, resolved the same
    // way the bridge's resolveTargetPivots does. Diffing modes naively
    // (only the stored manual list) either left stale filters on pivots no
    // longer targeted, or cleared pivots that remain targets.
    const effectiveTargets = (
      mode: ConnectionMode,
      sheets: Set<number>,
      manualPivots: Set<string>,
    ): Set<string> => {
      if (mode === "manual") {
        return new Set(availablePivots.filter((p) => manualPivots.has(p.id)).map((p) => p.id));
      }
      if (mode === "bySheet") {
        return new Set(availablePivots.filter((p) => sheets.has(p.sheetIndex)).map((p) => p.id));
      }
      return new Set(availablePivots.map((p) => p.id));
    };
    const oldTargets = effectiveTargets(
      connectionMode,
      new Set(connectedSheets ?? []),
      new Set(connectedPivots ?? []),
    );
    const newTargets = effectiveTargets(localMode, localSheets, localConnections);

    const updates: UpdateRibbonFilterParams = {
      connectionMode: localMode,
      connectedSheets: localMode === "bySheet" ? Array.from(localSheets) : [],
      crossFilterTargets: Array.from(localCrossTargets),
      crossFilterSlicerTargets: Array.from(localCrossSlicerTargets),
    };
    if (localMode === "manual") {
      updates.connectedPivots = Array.from(localConnections);
    }

    // ONE Save is ONE undo step -- the connections, the clears and the apply
    // (the backend's settings update joins it: BUG-0200) -- and a Save that
    // grows a pivot over the user's cells is asked about ONCE after that step
    // committed; a decline takes the whole Save back, and the store's
    // reconcile re-derives the masks it did not record.
    // ONE Save is one gesture: the pivots that refuse the clears below and the
    // apply after them are told in ONE toast at the end.
    const refused: RibbonFilterFailure[] = [];
    await runStepThenConfirmOverwrite("Filter Connections", async (overwrites) => {
      const updated = await updateFilterAsync(filterId, updates);

      // Clear this filter's column on pivots that are no longer targeted, by
      // its "Table.Column" key: the Pivot owner resolves the column, and a pivot
      // that does not carry it is left alone. Never by a field index found
      // here -- BI cache names are bare, so "Customers.Region" matched the
      // first "Region" in the cache (Stores.Region on Rows) and wiped the
      // user's own row filter on it.
      const disconnected = Array.from(oldTargets).filter((pivotId) => !newTargets.has(pivotId));
      if (disconnected.length > 0) {
        await clearModelColumnOnPivots(fieldName, disconnected, {
          label: updated?.name ?? getAllFilters().find((f) => f.id === filterId)?.name,
          failures: refused,
          overwrites,
        });
        window.dispatchEvent(new Event("pivot:refresh"));
      }

      // Re-apply an active selection to the (possibly grown) target set —
      // newly targeted pivots have never seen this filter.
      if (updated && updated.selectedItems !== null) {
        await applyRibbonFilter(updated, refused, overwrites);
      }
    });
    reportRibbonFilterFailures(refused);

    emitAppEvent(AppEvents.GRID_REFRESH);

    // Trigger slicer refresh so cross-filter has_data is recalculated
    window.dispatchEvent(
      new CustomEvent("ribbonFilter:selectionChanged", {
        detail: { filterId },
      }),
    );

    setShowConnections(false);
  }, [filterId, fieldName, connectionMode, connectedSheets, availablePivots, localMode, localSheets, localConnections, localCrossTargets, localCrossSlicerTargets, connectedPivots]);

  // Escape and a press outside the popover and the card close it: the
  // Popover below owns both, so this component binds no document listeners.

  // The search box takes focus on open, as it always did. The autoFocus
  // attribute alone is lost: the Popover's first, measuring pass is hidden,
  // and a hidden input refuses focus (see focusWhenVisible).
  const searchRef = useRef<HTMLInputElement>(null);
  const showSearch = filterMode === "basic" && items.length > 8;
  useEffect(() => {
    if (!showSearch) return;
    return focusWhenVisible(() => searchRef.current);
  }, [showSearch]);

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

  return (
    <Popover
      anchorEl={anchorEl}
      open
      onClose={onClose}
      card
      width={POPOVER_WIDTH}
      ariaLabel={`Filter ${fieldName}`}
    >
      {/* Rendered from a card in the ribbon band, but it is a popover: the
          @api fields inside must take popover geometry (full width), not the
          band's compact defaults the portal would otherwise inherit. */}
      <SurfaceLayoutProvider value={popoverLayout()}>
        <div style={styles.root} data-testid="controls-pane-filter-dropdown">
          {/* Header + Mode selector */}
          <div style={styles.header}>
            <span style={styles.headerTitle}>{fieldName}</span>
            <Select
              width={MODE_SELECT_WIDTH}
              aria-label="Filtering mode"
              value={filterMode}
              onChange={(e) => setFilterMode(e.target.value as "basic" | "advanced")}
            >
              <option value="basic">Basic filtering</option>
              <option value="advanced">Advanced filtering</option>
            </Select>
          </div>

          {/* Basic filtering mode */}
          {filterMode === "basic" && (
            <>
              {/* Search */}
              {items.length > 8 && (
                <div style={styles.searchRow}>
                  <Input
                    ref={searchRef}
                    type="text"
                    placeholder="Search..."
                    aria-label="Search values"
                    value={searchText}
                    onChange={(e) => setSearchText(e.target.value)}
                  />
                </div>
              )}

              {/* Select All / None */}
              {!singleSelect && (showSelectAll || true) && (
                <div style={styles.bulkRow}>
                  <Button size="sm" variant="outlined" onClick={handleSelectAll}>
                    Select All
                  </Button>
                  <Button size="sm" variant="outlined" onClick={handleSelectNone}>
                    Select None
                  </Button>
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
                      style={styles.rowInput}
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
                <Button variant="outlined" className={primaryButtonClass} onClick={handleOk}>
                  OK
                </Button>
                <Button variant="outlined" onClick={onClose}>
                  Cancel
                </Button>
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
              <Button size="sm" onClick={() => setPanelView("connections")}>
                Connections
              </Button>
              <Button size="sm" onClick={() => setPanelView("crossTargets")}>
                Cross-filter
              </Button>
              <Button size="sm" onClick={() => setPanelView("settings")}>
                Settings
              </Button>
              <Button size="sm" tone="danger" onClick={onDelete}>
                Remove
              </Button>
            </div>
          ) : panelView === "settings" ? (
            <FilterSettingsPanel
              filterId={filterId}
              hideNoData={hideNoData}
              indicateNoData={indicateNoData}
              sortNoDataLast={sortNoDataLast}
              showSelectAll={showSelectAll}
              singleSelect={singleSelect}
              filterLevel={filterLevel}
              onClose={() => setPanelView("none")}
            />
          ) : panelView === "crossTargets" ? (
            <div style={styles.connectionsPanel}>
              <div style={styles.connectionsHeader}>Cross-filter targets</div>
              <div style={styles.modeHint}>
                Select which filters and slicers this filter should cross-filter.
                Target items will be dimmed when they have no matching data.
              </div>
              <div style={styles.sheetList}>
                {/* Other ribbon filters on the SAME model connection — item
                    availability can only be evaluated within one model */}
                {cachedFilters
                  .filter((f) => f.id !== filterId && f.connectionId === connectionId)
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
                          style={styles.rowInput}
                        />
                        <span style={styles.kindTag}>[F]</span>
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
                        style={styles.rowInput}
                      />
                      <span style={styles.kindTag}>[S]</span>
                      <span>{shortName}</span>
                    </label>
                  );
                })}
                {cachedFilters.filter((f) => f.id !== filterId && f.connectionId === connectionId).length === 0 &&
                  availableSlicers.length === 0 && (
                  <div style={styles.modeHint}>
                    No other filters on this model connection or slicers to cross-filter.
                  </div>
                )}
              </div>
              <div style={styles.connectionsFooter}>
                <Button variant="outlined" className={primaryButtonClass} onClick={handleSaveConnections}>
                  Save
                </Button>
                <Button
                  variant="outlined"
                  onClick={() => {
                    setLocalCrossTargets(new Set(crossFilterTargets));
                    setLocalCrossSlicerTargets(new Set(crossFilterSlicerTargets));
                    setPanelView("none");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div style={styles.connectionsPanel}>
              <div style={styles.connectionsHeader}>Report connections</div>
              <div style={styles.modeHint}>
                Model: {connectionName ?? "(connection missing)"}
              </div>
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
                        style={styles.rowInput}
                      />
                      <span>{name}</span>
                    </label>
                  ))}
                </div>
              )}

              {localMode === "workbook" && (
                <div style={styles.modeHint}>
                  Automatically connects to all pivot tables using this model
                  connection, including newly created ones.
                </div>
              )}

              {localMode === "manual" && (
                <div style={styles.sheetList}>
                  {availablePivots.length === 0 ? (
                    <div style={styles.modeHint}>
                      No pivot tables use this model connection yet.
                    </div>
                  ) : (
                    availablePivots.map((pv) => (
                      <label key={pv.id} style={styles.itemRow}>
                        <input
                          type="checkbox"
                          checked={localConnections.has(pv.id)}
                          onChange={() => {
                            setLocalConnections((prev) => {
                              const next = new Set(prev);
                              if (next.has(pv.id)) next.delete(pv.id);
                              else next.add(pv.id);
                              return next;
                            });
                          }}
                          style={styles.rowInput}
                        />
                        <span style={styles.kindTag}>[P]</span>
                        <span>{pv.name}</span>
                      </label>
                    ))
                  )}
                </div>
              )}

              <div style={styles.connectionsFooter}>
                <Button variant="outlined" className={primaryButtonClass} onClick={handleSaveConnections}>
                  Save
                </Button>
                <Button
                  variant="outlined"
                  onClick={() => {
                    setLocalMode(connectionMode);
                    setLocalSheets(new Set(connectedSheets ?? []));
                    setLocalConnections(new Set(connectedPivots ?? []));
                    setLocalCrossTargets(new Set(crossFilterTargets));
                    setPanelView("none");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      </SurfaceLayoutProvider>
    </Popover>
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
  filterLevel: initFilterLevel,
  onClose,
}: {
  filterId: string;
  hideNoData: boolean;
  indicateNoData: boolean;
  sortNoDataLast: boolean;
  showSelectAll: boolean;
  singleSelect: boolean;
  filterLevel: number;
  onClose: () => void;
}): React.ReactElement {
  const [localHideNoData, setLocalHideNoData] = useState(initHideNoData);
  const [localIndicateNoData, setLocalIndicateNoData] = useState(initIndicateNoData);
  const [localSortNoDataLast, setLocalSortNoDataLast] = useState(initSortNoDataLast);
  const [localShowSelectAll, setLocalShowSelectAll] = useState(initShowSelectAll);
  const [localSingleSelect, setLocalSingleSelect] = useState(initSingleSelect);
  const [localFilterLevel, setLocalFilterLevel] = useState(initFilterLevel || 1);

  const handleSave = useCallback(async () => {
    const levelChanged = localFilterLevel !== (initFilterLevel || 1);
    // ONE Save is ONE undo step (the backend's settings update joins it:
    // BUG-0200). A level change that re-routes an active selection and grows
    // a pivot over the user's cells is asked about ONCE after the step
    // committed; a decline takes back the whole Save.
    await runStepThenConfirmOverwrite("Filter Settings", async (overwrites) => {
      const updated = await updateFilterAsync(filterId, {
        hideNoData: localHideNoData,
        indicateNoData: localIndicateNoData,
        sortNoDataLast: localSortNoDataLast,
        showSelectAll: localShowSelectAll,
        singleSelect: localSingleSelect,
        filterLevel: localFilterLevel,
      });
      // A level change moves an ACTIVE selection between the host-side mask
      // and the engine-routed (pinned) filter — re-apply so target pivots
      // pick up the new routing.
      if (levelChanged && updated && updated.selectedItems !== null) {
        await applyRibbonFilter(updated, undefined, overwrites);
      }
    });
    onClose();
  }, [
    filterId, localHideNoData, localIndicateNoData, localSortNoDataLast,
    localShowSelectAll, localSingleSelect, localFilterLevel, initFilterLevel, onClose,
  ]);

  return (
    <div style={styles.connectionsPanel}>
      <div style={styles.connectionsHeader}>Filter settings</div>

      {/* Selection */}
      <div style={styles.settingsGroup}>
        Selection
      </div>
      <SettingsToggle label="Single select" checked={localSingleSelect} onChange={setLocalSingleSelect} />
      <SettingsToggle label={'Show "Select all" option'} checked={localShowSelectAll} onChange={setLocalShowSelectAll} />

      {/* Filtering */}
      <div style={{ ...styles.settingsGroup, marginTop: 8 }}>
        Filtering
      </div>
      <label
        style={{ ...styles.itemRow, justifyContent: "space-between" }}
        title="A pinned filter (level 2+) keeps filtering even when a measure uses CLEAR or RESET — only CLEAR(…, LEVEL n) at or above its level removes it."
      >
        <span style={{ fontSize: 11 }}>Filter level</span>
        <Select
          width={LEVEL_SELECT_WIDTH}
          aria-label="Filter level"
          value={String(localFilterLevel)}
          onChange={(e) => setLocalFilterLevel(Number(e.target.value))}
        >
          <option value="1">1 — ordinary</option>
          {[2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
            <option key={n} value={String(n)}>
              {n} — pinned
            </option>
          ))}
        </Select>
      </label>

      {/* Data display */}
      <div style={{ ...styles.settingsGroup, marginTop: 8 }}>
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
        <Button variant="outlined" className={primaryButtonClass} onClick={handleSave}>
          Save
        </Button>
        <Button variant="outlined" onClick={onClose}>
          Cancel
        </Button>
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
  filterId: string;
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
      <div style={styles.advIntro}>
        Show items when the value
      </div>

      <div style={styles.advStack}>
        {/* Condition 1 */}
        <Select
          aria-label="First condition"
          value={op1}
          onChange={(e) => setOp1(e.target.value as AdvancedFilterOperator)}
        >
          {operators.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </Select>
        {needsValue(op1) && (
          <Input
            type="text"
            aria-label="First value"
            value={val1}
            onChange={(e) => setVal1(e.target.value)}
            placeholder="Value..."
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
        <Select
          aria-label="Second condition"
          value={op2}
          onChange={(e) => {
            setOp2(e.target.value as AdvancedFilterOperator);
            setHasCond2(true);
          }}
        >
          {operators.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </Select>
        {needsValue(op2) && (
          <Input
            type="text"
            aria-label="Second value"
            value={val2}
            onChange={(e) => { setVal2(e.target.value); setHasCond2(true); }}
            placeholder="Value..."
          />
        )}
      </div>

      <div style={styles.connectionsFooter}>
        <Button variant="outlined" className={primaryButtonClass} onClick={handleApply}>
          Apply filter
        </Button>
        <Button variant="outlined" onClick={handleClear}>
          Clear
        </Button>
      </div>
    </div>
  );
}

/** Popover width: the checklist's historical 250px. */
const POPOVER_WIDTH = 250;
/** The header's mode picker ("Advanced filtering" fits). */
const MODE_SELECT_WIDTH = 138;
/** The settings panel's filter-level picker ("9 — pinned" fits). */
const LEVEL_SELECT_WIDTH = 116;

/** A hairline between the checklist's bands. */
const DIVIDER = `1px solid ${LT.controlDivider}`;

// Horizontal insets are small: the card Popover already pads 8px all round.
const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    fontSize: 13,
    color: LT.text,
  },
  header: {
    padding: "0 2px 8px",
    borderBottom: DIVIDER,
    fontWeight: 600,
    fontSize: "12px",
    color: LT.text,
    display: "flex",
    alignItems: "center",
    gap: "6px",
  },
  headerTitle: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  searchRow: {
    padding: "6px 2px",
    borderBottom: DIVIDER,
  },
  bulkRow: {
    padding: "6px 2px",
    borderBottom: DIVIDER,
    display: "flex",
    gap: "6px",
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
    padding: "3px 4px",
    cursor: "pointer",
    fontSize: 12,
    color: LT.text,
  },
  rowInput: {
    marginRight: 8,
  },
  itemLabel: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  kindTag: {
    fontSize: 10,
    color: LT.textSecondary,
    marginRight: 4,
  },
  noResults: {
    padding: "8px 4px",
    color: LT.textSecondary,
    fontStyle: "italic",
    fontSize: 12,
  },
  footer: {
    padding: "8px 2px 6px",
    borderTop: DIVIDER,
    display: "flex",
    justifyContent: "flex-end",
    gap: "6px",
  },
  actionsDivider: {
    height: "1px",
    background: LT.controlDivider,
  },
  actionsRow: {
    padding: "6px 0 0",
    display: "flex",
    flexWrap: "wrap",
    gap: "2px",
  },
  connectionsPanel: {
    padding: "8px 2px 2px",
  },
  connectionsHeader: {
    fontSize: 12,
    fontWeight: 600,
    marginBottom: 6,
    color: LT.text,
  },
  settingsGroup: {
    fontSize: 11,
    fontWeight: 600,
    color: LT.textSecondary,
    marginBottom: 4,
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
    color: LT.text,
    cursor: "pointer",
  },
  sheetList: {
    maxHeight: 120,
    overflowY: "auto" as const,
    border: DIVIDER,
    borderRadius: LT.radiusControl,
    padding: "4px 0",
    marginBottom: 6,
  },
  modeHint: {
    fontSize: 10,
    color: LT.textSecondary,
    fontStyle: "italic",
    marginBottom: 6,
    lineHeight: "1.4",
  },
  connectionsFooter: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 6,
    marginTop: 6,
  },
  advIntro: {
    fontSize: 11,
    color: LT.textSecondary,
    marginBottom: 6,
  },
  advStack: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  advLogicRow: {
    display: "flex",
    gap: 12,
    margin: "2px 0",
  },
};
