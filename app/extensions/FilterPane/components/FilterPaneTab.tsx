//! FILENAME: app/extensions/FilterPane/components/FilterPaneTab.tsx
// PURPOSE: Ribbon tab showing filter cards horizontally.
//          Each card shows field name + selection summary + dropdown arrow.

import React, { useState, useEffect, useCallback } from "react";
import type { RibbonContext } from "@api/extensions";
import { showDialog } from "@api";
import { FilterPaneEvents } from "../lib/filterPaneEvents";
import { getAllFilters } from "../lib/filterPaneStore";
import { ADD_FILTER_DIALOG_ID } from "../manifest";
import { RibbonFilterCard } from "./RibbonFilterCard";
import type { RibbonFilter } from "../lib/filterPaneTypes";

export function FilterPaneTab({
  context: _context,
}: {
  context: RibbonContext;
}): React.ReactElement {
  const [filters, setFilters] = useState<RibbonFilter[]>([]);

  const refreshList = useCallback(() => {
    setFilters([...getAllFilters()]);
  }, []);

  useEffect(() => {
    refreshList();
    const events = [
      FilterPaneEvents.FILTER_CREATED,
      FilterPaneEvents.FILTER_DELETED,
      FilterPaneEvents.FILTER_UPDATED,
      FilterPaneEvents.FILTERS_REFRESHED,
    ];
    events.forEach((ev) => window.addEventListener(ev, refreshList));
    return () => {
      events.forEach((ev) => window.removeEventListener(ev, refreshList));
    };
  }, [refreshList]);

  const handleAddFilter = useCallback(() => {
    showDialog(ADD_FILTER_DIALOG_ID);
  }, []);

  return (
    <div style={styles.container}>
      {/* Add Filter button */}
      <button style={styles.addButton} onClick={handleAddFilter} title="Add a filter">
        <span style={styles.addIcon}>+</span>
      </button>

      {filters.length === 0 && (
        <div style={styles.emptyHint}>Click + to add filters</div>
      )}

      {filters.map((f) => (
        <RibbonFilterCard key={f.id} filter={f} />
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    alignItems: "center",
    height: "100%",
    width: "100%",
    gap: "6px",
    padding: "0 4px",
    overflowX: "auto",
    overflowY: "hidden",
  },
  addButton: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "28px",
    height: "28px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#c0c0c0",
    borderRadius: "3px",
    background: "#fff",
    cursor: "pointer",
    fontSize: "16px",
    color: "#555",
    flexShrink: 0,
  },
  addIcon: {
    fontWeight: "bold",
    lineHeight: 1,
  },
  emptyHint: {
    fontSize: "11px",
    color: "#aaa",
    fontStyle: "italic",
    whiteSpace: "nowrap",
  },
};
