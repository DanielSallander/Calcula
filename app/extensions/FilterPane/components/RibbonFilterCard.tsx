//! FILENAME: app/extensions/FilterPane/components/RibbonFilterCard.tsx
// PURPOSE: Compact filter card in the ribbon — field name, summary, dropdown arrow.
//          Clicking the arrow opens a checklist dropdown anchored below the card.

import React, { useState, useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { RibbonFilter, SlicerItem } from "../lib/filterPaneTypes";
import {
  getCachedItems,
  refreshFilterItems,
  updateFilterSelectionAsync,
  deleteFilterAsync,
  updateFilterAsync,
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

  // Sync local selection when filter prop changes
  useEffect(() => {
    setLocalSelectedItems(filter.selectedItems);
  }, [filter.selectedItems]);

  // Load items on mount
  useEffect(() => {
    const loadItems = async () => {
      await refreshFilterItems(filter.id);
      const cached = getCachedItems(filter.id);
      if (cached) setItems(cached);
    };
    loadItems();

    const onChanged = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.filterId && detail.filterId !== filter.id) {
        loadItems();
      }
    };
    window.addEventListener(FilterPaneEvents.FILTER_SELECTION_CHANGED, onChanged);
    window.addEventListener(FilterPaneEvents.FILTERS_REFRESHED, loadItems);
    return () => {
      window.removeEventListener(FilterPaneEvents.FILTER_SELECTION_CHANGED, onChanged);
      window.removeEventListener(FilterPaneEvents.FILTERS_REFRESHED, loadItems);
    };
  }, [filter.id]);

  const toggleDropdown = useCallback(() => {
    if (!dropdownOpen && cardRef.current) {
      setDropdownAnchor(cardRef.current.getBoundingClientRect());
    }
    setDropdownOpen((prev) => !prev);
  }, [dropdownOpen]);

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

  const handleMoveScope = useCallback(async () => {
    setDropdownOpen(false);
    const newScope = filter.scope === "sheet" ? "workbook" : "sheet";
    await updateFilterAsync(filter.id, {
      scope: newScope as "workbook" | "sheet",
      sheetIndex: newScope === "sheet" ? 0 : null,
    });
  }, [filter.id, filter.scope]);

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

  return (
    <>
      <div
        ref={cardRef}
        style={{
          ...styles.card,
          borderColor: hasFilter ? "#0078d4" : "#c0c0c0",
          background: hasFilter ? "#edf4fc" : "#fff",
        }}
        title={`${filter.fieldName}\n${hasFilter ? `Filtered: ${localSelectedItems?.length ?? 0} of ${totalCount}` : "No filter applied"}`}
      >
        <div style={styles.fieldName}>{shortName}:</div>
        <div style={styles.summary}>{summaryText}</div>
        <button
          style={styles.arrow}
          onClick={toggleDropdown}
        >
          {dropdownOpen ? "\u25B2" : "\u25BC"}
        </button>
      </div>

      {/* Dropdown */}
      {dropdownOpen && dropdownAnchor && (
        <FilterDropdown
          fieldName={filter.fieldName}
          items={items}
          selectedItems={localSelectedItems}
          anchorRect={dropdownAnchor}
          onApply={handleSelectionApply}
          onClose={() => setDropdownOpen(false)}
          onDelete={handleDelete}
          onMoveScope={handleMoveScope}
          scopeLabel={filter.scope === "sheet" ? "Move to Workbook" : "Move to Sheet"}
          connectedSources={filter.connectedSources}
        />
      )}
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
