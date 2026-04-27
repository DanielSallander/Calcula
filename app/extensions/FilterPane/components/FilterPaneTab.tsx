//! FILENAME: app/extensions/FilterPane/components/FilterPaneTab.tsx
// PURPOSE: Ribbon tab showing filter cards horizontally.
//          Each card shows field name + selection summary + dropdown arrow.

import React, { useState, useEffect, useCallback } from "react";
import type { RibbonContext } from "@api/extensions";
import { showDialog } from "@api";
import { FilterPaneEvents } from "../lib/filterPaneEvents";
import { getAllFilters, getWorkbookFilters, getSheetFilters } from "../lib/filterPaneStore";
import { getGridStateSnapshot } from "@api/state";
import { ADD_FILTER_DIALOG_ID } from "../manifest";
import { RibbonFilterCard } from "./RibbonFilterCard";
import type { RibbonFilter } from "../lib/filterPaneTypes";

export function FilterPaneTab({
  context: _context,
}: {
  context: RibbonContext;
}): React.ReactElement {
  const [workbookFilters, setWorkbookFilters] = useState<RibbonFilter[]>([]);
  const [sheetFilters, setSheetFilters] = useState<RibbonFilter[]>([]);

  const refreshLists = useCallback(() => {
    setWorkbookFilters(getWorkbookFilters());
    const snapshot = getGridStateSnapshot();
    const activeSheet = snapshot?.activeSheet ?? 0;
    setSheetFilters(getSheetFilters(activeSheet));
  }, []);

  useEffect(() => {
    refreshLists();
    const events = [
      FilterPaneEvents.FILTER_CREATED,
      FilterPaneEvents.FILTER_DELETED,
      FilterPaneEvents.FILTER_UPDATED,
      FilterPaneEvents.FILTERS_REFRESHED,
      "sheet:activated",
    ];
    events.forEach((ev) => window.addEventListener(ev, refreshLists));
    return () => {
      events.forEach((ev) => window.removeEventListener(ev, refreshLists));
    };
  }, [refreshLists]);

  const handleAddFilter = useCallback(() => {
    showDialog(ADD_FILTER_DIALOG_ID);
  }, []);

  const hasFilters = workbookFilters.length > 0 || sheetFilters.length > 0;

  return (
    <div style={styles.container}>
      {/* Add Filter button */}
      <button style={styles.addButton} onClick={handleAddFilter} title="Add a filter">
        <span style={styles.addIcon}>+</span>
      </button>

      {!hasFilters && (
        <div style={styles.emptyHint}>Click + to add filters</div>
      )}

      {/* Workbook filters */}
      {workbookFilters.length > 0 && (
        <>
          <div style={styles.scopeLabel}>Workbook:</div>
          {workbookFilters.map((f) => (
            <RibbonFilterCard key={f.id} filter={f} />
          ))}
        </>
      )}

      {/* Divider between scopes */}
      {workbookFilters.length > 0 && sheetFilters.length > 0 && (
        <div style={styles.divider} />
      )}

      {/* Sheet filters */}
      {sheetFilters.length > 0 && (
        <>
          <div style={styles.scopeLabel}>Sheet:</div>
          {sheetFilters.map((f) => (
            <RibbonFilterCard key={f.id} filter={f} />
          ))}
        </>
      )}
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
  scopeLabel: {
    fontSize: "10px",
    color: "#888",
    fontWeight: 600,
    textTransform: "uppercase" as const,
    letterSpacing: "0.5px",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  divider: {
    width: "1px",
    height: "50px",
    background: "#d0d0d0",
    flexShrink: 0,
  },
};
