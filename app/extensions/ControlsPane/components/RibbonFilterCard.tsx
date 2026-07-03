//! FILENAME: app/extensions/ControlsPane/components/RibbonFilterCard.tsx
// PURPOSE: Compact filter card in the ribbon — field name, summary, dropdown
//          arrow, plus the model connection the filter is sourced from
//          (visible so multi-model workbooks stay unambiguous).
//          Clicking the arrow opens a checklist dropdown anchored below the card.

import React, { useState, useCallback, useEffect, useRef } from "react";
import type { RibbonFilter, SlicerItem } from "../lib/filterPaneTypes";
import {
  getCachedItems,
  refreshFilterItems,
  updateFilterSelectionAsync,
  deleteFilterAsync,
  getFilterById,
  getConnectionName,
} from "../lib/filterPaneStore";
import { FilterPaneEvents } from "../lib/filterPaneEvents";
import { FilterDropdown } from "./FilterDropdown";

interface Props {
  filter: RibbonFilter;
}

export function RibbonFilterCard({ filter }: Props): React.ReactElement {
  const [items, setItems] = useState<SlicerItem[]>(
    getCachedItems(filter.id) ?? [],
  );
  const [localSelectedItems, setLocalSelectedItems] = useState<string[] | null>(
    filter.selectedItems,
  );
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [dropdownAnchor, setDropdownAnchor] = useState<DOMRect | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const closedAtRef = useRef(0);

  // Sync local selection when filter prop changes
  useEffect(() => {
    setLocalSelectedItems(filter.selectedItems);
  }, [filter.selectedItems]);

  // Load items lazily — only when dropdown is opened, not on mount.
  // This avoids taking the BI engine during card creation which would
  // conflict with pivot operations the user might be doing.
  const [itemsLoaded, setItemsLoaded] = useState(false);

  useEffect(() => {
    // Refresh on cross-filter events from OTHER filters or slicers
    const onFilterChanged = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.filterId && detail.filterId !== filter.id && itemsLoaded) {
        refreshFilterItems(filter.id).then(() => {
          const cached = getCachedItems(filter.id);
          if (cached) setItems(cached);
        });
      }
    };
    const onSlicerChanged = () => {
      if (itemsLoaded) {
        refreshFilterItems(filter.id).then(() => {
          const cached = getCachedItems(filter.id);
          if (cached) setItems(cached);
        });
      }
    };
    window.addEventListener(FilterPaneEvents.FILTER_SELECTION_CHANGED, onFilterChanged);
    window.addEventListener("slicer:selectionChanged", onSlicerChanged);
    return () => {
      window.removeEventListener(FilterPaneEvents.FILTER_SELECTION_CHANGED, onFilterChanged);
      window.removeEventListener("slicer:selectionChanged", onSlicerChanged);
    };
  }, [filter.id, itemsLoaded]);

  const toggleDropdown = useCallback(async () => {
    // If the dropdown was just closed by an outside click (<100ms ago),
    // don't reopen it — the user intended to close, not toggle.
    if (Date.now() - closedAtRef.current < 200) return;
    if (!dropdownOpen && cardRef.current) {
      setDropdownAnchor(cardRef.current.getBoundingClientRect());
      // Load items on first open (lazy loading)
      if (!itemsLoaded) {
        await refreshFilterItems(filter.id);
        const cached = getCachedItems(filter.id);
        if (cached) setItems(cached);
        setItemsLoaded(true);
      }
    }
    setDropdownOpen((prev) => !prev);
  }, [dropdownOpen, itemsLoaded, filter.id]);

  const handleDropdownClose = useCallback(() => {
    closedAtRef.current = Date.now();
    setDropdownOpen(false);
  }, []);

  const handleSelectionApply = useCallback(
    (selectedItems: string[] | null) => {
      setLocalSelectedItems(selectedItems);
      setDropdownOpen(false);
      updateFilterSelectionAsync(filter.id, selectedItems);
    },
    [filter.id],
  );

  const handleDelete = useCallback(async () => {
    setDropdownOpen(false);
    await deleteFilterAsync(filter.id);
  }, [filter.id]);


  // Build summary text
  const hasFilter = localSelectedItems !== null;
  const totalCount = items.length;
  let summaryText: string;
  if (!hasFilter) {
    summaryText = "(All)";
  } else if (localSelectedItems.length === 0) {
    summaryText = "(None)";
  } else if (localSelectedItems.length === 1) {
    summaryText = localSelectedItems[0];
  } else {
    summaryText = `${localSelectedItems.length} of ${totalCount}`;
  }

  // Shorten field name: "dim_customer.city" -> "city"
  const shortName = filter.fieldName.includes(".")
    ? filter.fieldName.split(".").pop()!
    : filter.fieldName;

  // Model connection attribution — always visible so it's unambiguous
  // which model each filter comes from when several connections exist.
  const connectionName = getConnectionName(filter.connectionId);
  const connectionMissing = connectionName === undefined;

  return (
    <>
      <div
        ref={cardRef}
        style={{
          ...styles.card,
          borderColor: hasFilter ? "#0078d4" : "#c0c0c0",
          background: hasFilter ? "#edf4fc" : "#fff",
        }}
        title={
          `${filter.fieldName}\nModel: ${connectionName ?? "(connection missing)"}\n` +
          (hasFilter
            ? `Filtered: ${localSelectedItems?.length ?? 0} of ${totalCount}`
            : "No filter applied")
        }
      >
        <div style={styles.cardBody}>
          <div style={styles.topRow}>
            <div style={styles.fieldName}>{shortName}:</div>
            <div style={styles.summary}>{summaryText}</div>
          </div>
          <div
            style={{
              ...styles.connectionRow,
              ...(connectionMissing ? styles.connectionMissing : {}),
            }}
          >
            {connectionName ?? "(connection missing)"}
          </div>
        </div>
        <button
          style={styles.arrow}
          onClick={toggleDropdown}
        >
          {dropdownOpen ? "▲" : "▼"}
        </button>
      </div>

      {/* Dropdown — read fresh filter from store to avoid stale props */}
      {dropdownOpen && dropdownAnchor && (() => {
        const f = getFilterById(filter.id) ?? filter;
        return (
          <FilterDropdown
            fieldName={f.fieldName}
            items={items}
            selectedItems={localSelectedItems}
            anchorRect={dropdownAnchor}
            onApply={handleSelectionApply}
            onClose={handleDropdownClose}
            filterId={f.id}
            onDelete={handleDelete}
            connectionId={f.connectionId}
            connectionMode={f.connectionMode ?? "manual"}
            crossFilterTargets={f.crossFilterTargets ?? []}
            crossFilterSlicerTargets={f.crossFilterSlicerTargets ?? []}
            advancedFilter={f.advancedFilter ?? null}
            fieldDataType={f.fieldDataType ?? "unknown"}
            connectedPivots={f.connectedPivots}
            connectedSheets={f.connectedSheets}
            hideNoData={f.hideNoData ?? false}
            indicateNoData={f.indicateNoData ?? true}
            sortNoDataLast={f.sortNoDataLast ?? true}
            showSelectAll={f.showSelectAll ?? false}
            singleSelect={f.singleSelect ?? false}
          />
        );
      })()}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    padding: "4px 6px 4px 10px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderRadius: "3px",
    cursor: "default",
    height: "56px",
    flexShrink: 0,
    maxWidth: "220px",
    minWidth: "120px",
  },
  cardBody: {
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    gap: "2px",
    flex: 1,
    minWidth: 0,
  },
  topRow: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    minWidth: 0,
  },
  fieldName: {
    fontSize: "11px",
    fontWeight: 600,
    color: "#333",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  summary: {
    fontSize: "11px",
    color: "#666",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    flex: 1,
  },
  connectionRow: {
    fontSize: "9px",
    color: "#8a8a8a",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  connectionMissing: {
    color: "#c00",
    fontStyle: "italic",
  },
  arrow: {
    border: "none",
    background: "none",
    cursor: "pointer",
    fontSize: "10px",
    color: "#555",
    padding: "4px",
    flexShrink: 0,
  },
};
