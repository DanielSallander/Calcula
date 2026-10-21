//! FILENAME: app/extensions/ControlsPane/components/FilterDropdown.tsx
// PURPOSE: Dropdown checklist anchored below a ribbon filter card.
//          Includes search, select all/none, OK/Cancel, and actions.
// CONTEXT: Report Connections only ever offer the visuals built on the
//          filter's own model connection: its BI pivots (from the backend, the
//          route that filters them) and every other model visual a family lists
//          on @api/modelVisuals (design-query charts, cards, KPIs, gauges).
//          "Selected visuals" writes the pivots to `connectedPivots` and the
//          rest to `connectedVisuals`; "Selected pages" and "All pages" reach
//          both kinds through the scope the filter publishes
//          (lib/filterReportPublisher.ts).
//
//          Hosted in an @api card Popover (Calcula Clusters): the Popover owns
//          positioning, the card chrome, and dismissal on Escape or a press
//          outside both the popover and its anchor (the filter card). It used
//          to be its own position:fixed body portal with a hardcoded white box and
//          its own document listeners; every colour is now a token, so the
//          checklist follows the skin in Dark. The filtering logic is
//          unchanged.
//
//          Items are MEMBERS (P2): the list SHOWS and searches each item's
//          app-locale `label` and SELECTS by its invariant `key` (what the
//          filter stores and every reader matches). An advanced condition
//          compares numbers and dates on the KEY against the user's text read
//          in the app locale, and text on the label (`evalCondition`).

import React, { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { getSheets, emitAppEvent, AppEvents } from "@api";
import { parseNumber, parseDate } from "@api/locale";
import { memberKeyNumber, memberKeyDate } from "@api/pivotMembers";
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
import { listModelVisuals, type ModelVisualInfo } from "@api/modelVisuals";
import type { VisualRef } from "@api/reportFilters";
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
  /** How an error sentence names the field: the WHOLE field key (e.g.
   *  "BI.dim_date.year"), never a last-dot short name that truncates a dotted
   *  column. */
  fieldLabel: string;
  items: SlicerItem[];
  /** Why the values could not be loaded, or null. Shown INSTEAD of the list,
   *  so a failed load never reads as "No matching values". */
  itemsError: string | null;
  /** Why the values are shown un-narrowed by the dependent filters, or null. */
  narrowingError: string | null;
  /** Load the values again (the alert's Retry). */
  onRetry: () => void;
  selectedItems: string[] | null;
  /** The filter card the popover hangs below (and never dismisses on). */
  anchorEl: HTMLElement;
  onApply: (selectedItems: string[] | null) => void;
  onClose: () => void;
  onDelete: () => void;
  /** The model connection this filter is sourced from. */
  connectionId: string;
  connectionMode: ConnectionMode;
  dependentFilters: string[];
  dependentSlicers: string[];
  advancedFilter: AdvancedFilter | null;
  fieldDataType: FieldDataType;
  connectedPivots?: string[];
  connectedSheets?: number[];
  /** Manual mode's non-pivot visuals (charts, cards, KPIs, gauges). */
  connectedVisuals?: VisualRef[];
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
  fieldLabel,
  items,
  itemsError,
  narrowingError,
  onRetry,
  selectedItems,
  anchorEl,
  onApply,
  onClose,
  onDelete,
  connectionId,
  connectionMode,
  dependentFilters,
  advancedFilter,
  fieldDataType,
  connectedPivots,
  connectedSheets,
  connectedVisuals,
  hideNoData,
  indicateNoData,
  sortNoDataLast,
  showSelectAll,
  singleSelect,
  filterLevel,
  dependentSlicers,
}: FilterDropdownProps): React.ReactElement {
  const cachedFilters = getAllFilters();
  const connectionName = getConnectionName(connectionId);
  // Local selection state for OK/Cancel pattern
  // Member KEYS: the selection stores keys, never labels.
  const allValues = useMemo(() => items.map((i) => i.key), [items]);
  const [localSelected, setLocalSelected] = useState<Set<string>>(() => {
    if (selectedItems === null) return new Set(allValues);
    return new Set(selectedItems);
  });
  // The values can arrive while the checklist is open (a Retry after a failed
  // load, a dependent filter's refresh). Until the user has ticked anything,
  // the local selection follows them: "(All)" must tick the values that
  // arrived, or OK would apply an empty selection the user never chose.
  const userEdited = useRef(false);
  useEffect(() => {
    if (userEdited.current) return;
    setLocalSelected(selectedItems === null ? new Set(allValues) : new Set(selectedItems));
  }, [allValues, selectedItems]);
  const [searchText, setSearchText] = useState("");
  const [filterMode, setFilterMode] = useState<"basic" | "advanced">(
    advancedFilter ? "advanced" : "basic",
  );

  // Sub-panel state
  type PanelView = "none" | "connections" | "dependents" | "settings";
  const [panelView, setPanelView] = useState<PanelView>("none");

  // Alias for backward compat in the JSX
  const showConnections = panelView === "connections";
  const setShowConnections = (v: boolean) => setPanelView(v ? "connections" : "none");
  const [localMode, setLocalMode] = useState<ConnectionMode>(connectionMode);
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [localSheets, setLocalSheets] = useState<Set<number>>(
    new Set(connectedSheets ?? []),
  );

  const [localDependentFilters, setLocalDependentFilters] = useState<Set<string>>(
    new Set(dependentFilters),
  );
  const [localDependentSlicers, setLocalDependentSlicers] = useState<Set<string>>(
    new Set(dependentSlicers),
  );
  const [availableSlicers, setAvailableSlicers] = useState<SlicerInfo[]>([]);

  // For manual mode: the connection's BI pivots available as targets
  const [availablePivots, setAvailablePivots] = useState<BiConnectionPivot[]>([]);
  const [localConnections, setLocalConnections] = useState<Set<string>>(() => {
    return new Set(connectedPivots ?? []);
  });
  // ...and its other model visuals (charts, cards, KPIs, gauges), by "kind:id".
  const [availableVisuals, setAvailableVisuals] = useState<ModelVisualInfo[]>([]);
  const [localVisuals, setLocalVisuals] = useState<Set<string>>(
    () => new Set((connectedVisuals ?? []).map(visualKey)),
  );

  // Load slicers when the dependent-filters panel opens
  useEffect(() => {
    if (panelView !== "dependents") return;
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
    setAvailableVisuals(selectableModelVisuals(connectionId));
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
      dependentFilters: Array.from(localDependentFilters),
      dependentSlicers: Array.from(localDependentSlicers),
    };
    if (localMode === "manual") {
      updates.connectedPivots = Array.from(localConnections);
      // The ticked visuals, plus any connected ref the list cannot show (its
      // family is not loaded): not listed is not unticked. A ref to a deleted
      // object is dropped by the backend at save.
      const listed = new Set(availableVisuals.map((v) => visualKey(v.ref)));
      updates.connectedVisuals = [
        ...availableVisuals.filter((v) => localVisuals.has(visualKey(v.ref))).map((v) => ({ ...v.ref })),
        ...(connectedVisuals ?? []).filter((r) => !listed.has(visualKey(r))).map((r) => ({ ...r })),
      ];
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

    // Trigger slicer refresh so the dependents' has_data is recalculated
    window.dispatchEvent(
      new CustomEvent("ribbonFilter:selectionChanged", {
        detail: { filterId },
      }),
    );

    setShowConnections(false);
  }, [filterId, fieldName, connectionMode, connectedSheets, availablePivots, availableVisuals, localMode, localSheets, localConnections, localVisuals, localDependentFilters, localDependentSlicers, connectedPivots, connectedVisuals]);

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
    userEdited.current = true;
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
    userEdited.current = true;
    setLocalSelected(new Set(allValues));
  }, [allValues]);

  const handleSelectNone = useCallback(() => {
    userEdited.current = true;
    setLocalSelected(new Set());
  }, []);

  const handleOk = useCallback(() => {
    // No values loaded: there is nothing to choose from, so nothing changes.
    if (itemsError !== null) return;
    // If all selected, clear filter (null = all)
    if (localSelected.size === allValues.length) {
      onApply(null);
    } else {
      onApply(Array.from(localSelected));
    }
  }, [itemsError, localSelected, allValues, onApply]);

  const filtered = useMemo(() => {
    let result = items;
    // Hide items with no data if setting is enabled
    if (hideNoData) {
      result = result.filter((i) => i.hasData);
    }
    // Filter by search text
    if (searchText) {
      const lower = searchText.toLowerCase();
      // Search what the user SEES (the label).
      result = result.filter((i) => i.label.toLowerCase().includes(lower));
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

              {/* The values are shown un-narrowed: say why, above the list. */}
              {itemsError === null && narrowingError !== null && (
                <div
                  style={styles.narrowingNotice}
                  data-testid="controls-pane-filter-narrowing-error"
                >
                  Values are not narrowed by dependent filters: {narrowingError}
                </div>
              )}

              {/* Items -- or, when they could not be loaded, why not. */}
              {itemsError !== null ? (
                <div style={styles.itemsErrorBox}>
                  <div role="alert" data-testid="controls-pane-filter-items-error">
                    Could not load the values of {fieldLabel}: {itemsError}
                  </div>
                  <div>
                    <Button
                      size="sm"
                      variant="outlined"
                      onClick={onRetry}
                      data-testid="controls-pane-filter-items-retry"
                    >
                      Retry
                    </Button>
                  </div>
                </div>
              ) : (
                <div style={styles.itemList}>
                  {filtered.map((item) => (
                    <label
                      key={item.key}
                      data-testid="controls-pane-filter-item"
                      data-value={item.key}
                      data-has-data={String(item.hasData)}
                      style={{
                        ...styles.itemRow,
                        opacity: indicateNoData && !item.hasData ? 0.45 : 1,
                      }}
                    >
                      <input
                        type={singleSelect ? "radio" : "checkbox"}
                        checked={localSelected.has(item.key)}
                        onChange={() => handleToggle(item.key)}
                        name={singleSelect ? `filter-${filterId}` : undefined}
                        style={styles.rowInput}
                      />
                      <span style={styles.itemLabel}>{item.label || "(Blank)"}</span>
                    </label>
                  ))}
                  {filtered.length === 0 && (
                    <div style={styles.noResults}>No matching values</div>
                  )}
                </div>
              )}

              {/* OK / Cancel */}
              <div style={styles.footer}>
                <Button
                  variant="outlined"
                  className={primaryButtonClass}
                  onClick={handleOk}
                  disabled={itemsError !== null}
                >
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
              <Button
                size="sm"
                data-testid="controls-pane-filter-dependents-open"
                onClick={() => setPanelView("dependents")}
              >
                Dependent filters
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
          ) : panelView === "dependents" ? (
            <div style={styles.connectionsPanel}>
              <div style={styles.connectionsHeader}>Dependent filters</div>
              <div style={styles.modeHint}>
                Choose the filters and slicers whose value lists follow this filter's selection.
                Their values with no matching data are dimmed.
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
                          checked={localDependentFilters.has(f.id)}
                          onChange={() => {
                            setLocalDependentFilters((prev) => {
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
                        checked={localDependentSlicers.has(s.id)}
                        onChange={() => {
                          setLocalDependentSlicers((prev) => {
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
                    No other filter on this model, and no slicer, can depend on this filter.
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
                    setLocalDependentFilters(new Set(dependentFilters));
                    setLocalDependentSlicers(new Set(dependentSlicers));
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
                    {CONNECTION_MODE_LABELS[mode]}
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
                  Filters every PivotTable, chart, card, KPI and gauge built on
                  this model, on every page, including ones added later.
                </div>
              )}

              {localMode === "manual" && (
                <div style={styles.sheetList}>
                  {availablePivots.length === 0 && availableVisuals.length === 0 ? (
                    <div style={styles.modeHint}>
                      No visuals use this model yet.
                    </div>
                  ) : (
                    <>
                    {availablePivots.map((pv) => (
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
                        <span style={styles.kindTag}>PivotTable</span>
                        <span>{pv.name}</span>
                      </label>
                    ))}
                    {availableVisuals.map((v) => {
                      const key = visualKey(v.ref);
                      return (
                        <label key={key} style={styles.itemRow} data-visual-ref={key}>
                          <input
                            type="checkbox"
                            checked={localVisuals.has(key)}
                            onChange={() => {
                              setLocalVisuals((prev) => {
                                const next = new Set(prev);
                                if (next.has(key)) next.delete(key);
                                else next.add(key);
                                return next;
                              });
                            }}
                            style={styles.rowInput}
                          />
                          <span style={styles.kindTag}>{v.label}</span>
                          <span>{v.name}</span>
                          {sheetNames[v.sheetIndex] !== undefined && (
                            <span style={styles.kindTag}>&nbsp;({sheetNames[v.sheetIndex]})</span>
                          )}
                        </label>
                      );
                    })}
                    </>
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
                    setLocalVisuals(new Set((connectedVisuals ?? []).map(visualKey)));
                    setLocalDependentFilters(new Set(dependentFilters));
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
// Report connections: modes and model visuals
// ============================================================================

/** What each connection mode is called (Power BI's words). */
export const CONNECTION_MODE_LABELS: Readonly<Record<ConnectionMode, string>> = {
  manual: "Selected visuals",
  bySheet: "Selected pages",
  workbook: "All pages",
};

/** A visual's identity as one string. */
function visualKey(ref: VisualRef): string {
  return `${ref.kind}:${ref.id}`;
}

/**
 * The model visuals on `connectionId` a ribbon filter can name in
 * "Selected visuals", besides its pivots: the ones that FOLLOW other filters
 * (role.target). Pivots come from the backend (getPivotsForBiConnection, the
 * route that filters them) and stay in `connectedPivots`; slicers narrow
 * through dependent filters instead.
 */
function selectableModelVisuals(connectionId: string): ModelVisualInfo[] {
  return listModelVisuals({ connectionId }).filter((v) => v.ref.kind === "chart" && v.role.target);
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

/** A number condition: the member KEY read invariantly ("3578.27") against
 *  the user's text read in the APP locale ("3.000,5" under de-DE). Either side
 *  that is not a number fails the condition. */
function compareNumbers(
  member: SlicerItem,
  target: string,
  holds: (value: number, bound: number) => boolean,
): boolean {
  const value = memberKeyNumber(member.key);
  const bound = parseNumber(target);
  return value !== null && bound !== null && holds(value, bound);
}

/** A date condition: the KEY's serial (an ISO key, read invariantly) against
 *  the user's text read as a date in the APP locale ("01.02.2024" under
 *  de-DE). Either side that is not a date fails the condition. */
function compareDates(
  member: SlicerItem,
  target: string,
  holds: (value: number, bound: number) => boolean,
): boolean {
  const value = memberKeyDate(member.key);
  const bound = parseDate(target);
  return value !== null && bound !== null && holds(value, bound);
}

/**
 * Evaluate one advanced-filter condition against a MEMBER:
 * - numeric comparisons compare the invariant KEY with the target read in the
 *   app locale; date comparisons the key's ISO date with the target read as an
 *   app-locale date (never a string comparison of display text);
 * - text comparisons (is, contains, starts with) read the LABEL, what the user
 *   sees and types;
 * - blank / empty read the KEY: the blank member's key is "" (ruling Q8),
 *   while its label reads "(Blank)".
 * It compared display text before (BUG-0519): "is blank" never matched the
 * blank member and a de-DE "3.000,5" was parseFloat'ed to 3.
 */
export function evalCondition(
  member: SlicerItem,
  op: AdvancedFilterOperator,
  target: string,
): boolean {
  const label = member.label;
  const vLower = label.toLowerCase();
  const tLower = target.toLowerCase();
  switch (op) {
    case "is": return vLower === tLower;
    case "isNot": return vLower !== tLower;
    case "contains": return vLower.includes(tLower);
    case "doesNotContain": return !vLower.includes(tLower);
    case "startsWith": return vLower.startsWith(tLower);
    case "doesNotStartWith": return !vLower.startsWith(tLower);
    case "isBlank": return member.key.trim() === "";
    case "isNotBlank": return member.key.trim() !== "";
    case "isEmpty": return member.key === "";
    case "isNotEmpty": return member.key !== "";
    case "isLessThan": return compareNumbers(member, target, (v, b) => v < b);
    case "isLessThanOrEqualTo": return compareNumbers(member, target, (v, b) => v <= b);
    case "isGreaterThan": return compareNumbers(member, target, (v, b) => v > b);
    case "isGreaterThanOrEqualTo": return compareNumbers(member, target, (v, b) => v >= b);
    case "isAfter": return compareDates(member, target, (v, b) => v > b);
    case "isOnOrAfter": return compareDates(member, target, (v, b) => v >= b);
    case "isBefore": return compareDates(member, target, (v, b) => v < b);
    case "isOnOrBefore": return compareDates(member, target, (v, b) => v <= b);
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
    // Evaluate the conditions against every MEMBER; the selection is the
    // matching members' KEYS.
    const matching = items
      .filter((i) => {
        const c1 = evalCondition(i, op1, val1);
        if (!hasCond2 || !val2) return c1;
        const c2 = evalCondition(i, op2, val2);
        return logic === "and" ? c1 && c2 : c1 || c2;
      })
      .map((i) => i.key);

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
  itemsErrorBox: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: "8px 4px",
    fontSize: 12,
    color: LT.dangerFg,
    overflowWrap: "anywhere",
  },
  narrowingNotice: {
    padding: "4px 4px",
    fontSize: 11,
    color: LT.warnFg,
    background: LT.warnBg,
    borderBottom: DIVIDER,
    overflowWrap: "anywhere",
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
