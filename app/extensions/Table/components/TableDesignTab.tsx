//! FILENAME: app/extensions/Table/components/TableDesignTab.tsx
// PURPOSE: Ribbon "Table Design" tab for table layout and style options.
// CONTEXT: Appears in the ribbon when a table is selected. Communicates with the
// Table extension via custom events (TABLE_STATE / TABLE_REQUEST_STATE).

import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { css } from "@emotion/css";
import { onAppEvent, emitAppEvent, AppEvents } from "../../../src/api";
import { TableEvents } from "../lib/tableEvents";
import {
  updateTableStyleAsync,
  toggleTotalsRowAsync,
  convertToRangeAsync,
  deleteTableAsync,
  type Table,
  type TableStyleOptions,
} from "../lib/tableStore";
import type { RibbonContext } from "../../../src/api/extensions";
import { useRibbonCollapse, RibbonGroup } from "../../../src/api/ribbonCollapse";
import { TableStylesGallery, DEFAULT_TABLE_STYLE_ID } from "./TableStylesGallery";

// ============================================================================
// Styles
// ============================================================================

const tabStyles = {
  container: css`
    display: flex;
    gap: 0;
    align-items: flex-start;
    height: 100%;
    width: 100%;
    min-width: 0;
    overflow: hidden;
    font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
    font-size: 12px;
  `,
  disabledMessage: css`
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    color: #999;
    font-style: italic;
    font-size: 12px;
  `,
  groupContent: css`
    display: flex;
    gap: 8px;
    align-items: center;
  `,
  groupContentVertical: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
  `,
  checkboxLabel: css`
    display: flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    white-space: nowrap;
    font-size: 11px;
    color: #333;

    input {
      cursor: pointer;
    }
  `,
  nameInput: css`
    padding: 3px 6px;
    border: 1px solid #d0d0d0;
    border-radius: 4px;
    font-size: 11px;
    font-family: inherit;
    background: #fff;
    color: #1a1a1a;
    min-width: 100px;
    max-width: 160px;

    &:hover {
      border-color: #999;
    }

    &:focus {
      outline: none;
      border-color: #005fb8;
    }
  `,
  toolButton: css`
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    border: 1px solid #d0d0d0;
    border-radius: 4px;
    background: #fff;
    color: #333;
    font-size: 11px;
    font-family: inherit;
    cursor: pointer;
    white-space: nowrap;

    &:hover {
      background: #e8e8e8;
      border-color: #999;
    }

    &:active {
      background: #d0d0d0;
    }

    &:disabled {
      opacity: 0.5;
      cursor: default;
      &:hover {
        background: #fff;
        border-color: #d0d0d0;
      }
    }
  `,
  toolButtonDanger: css`
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    border: 1px solid #d0d0d0;
    border-radius: 4px;
    background: #fff;
    color: #c42b1c;
    font-size: 11px;
    font-family: inherit;
    cursor: pointer;
    white-space: nowrap;

    &:hover {
      background: #fde7e7;
      border-color: #c42b1c;
    }

    &:active {
      background: #fbd0d0;
    }
  `,
  checkboxColumn: css`
    display: flex;
    flex-direction: column;
    gap: 3px;
  `,
};

// ============================================================================
// Collapse configuration
// ============================================================================

// Collapse order matches Excel: Properties first, then Tools, then Style Options.
// Table Styles handles its own responsive collapse via Quick Styles.
// Gallery is NOT included — it uses flex: 1 1 0 and its own ResizeObserver
// to progressively show fewer thumbnails as the ribbon narrows.
const GROUP_DEFS = [
  { collapseOrder: 1, expandedWidth: 140 },   // Properties
  { collapseOrder: 2, expandedWidth: 360 },   // Tools
  { collapseOrder: 3, expandedWidth: 320 },   // Table Style Options
];

// ============================================================================
// Component
// ============================================================================

interface TableState {
  table: Table;
}

export function TableDesignTab({
  context: _context,
}: {
  context: RibbonContext;
}): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const [tableState, setTableState] = useState<TableState | null>(null);
  const [tableName, setTableName] = useState("");
  const [savedName, setSavedName] = useState("");
  const [selectedStyleId, setSelectedStyleId] = useState(DEFAULT_TABLE_STYLE_ID);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const groupDefs = useMemo(() => GROUP_DEFS, []);
  const collapsed = useRibbonCollapse(containerRef, groupDefs, 0, 470);

  // Listen for table state broadcasts from the selection handler
  useEffect(() => {
    const unsub = onAppEvent<TableState>(
      TableEvents.TABLE_STATE,
      (detail) => {
        setTableState(detail);
        if (detail?.table) {
          setTableName(detail.table.name);
          setSavedName(detail.table.name);
        }
      },
    );
    emitAppEvent(TableEvents.TABLE_REQUEST_STATE);
    return unsub;
  }, []);

  // Clear state when table is deselected
  useEffect(() => {
    const handleClear = () => {
      setTableState(null);
      setTableName("");
      setSavedName("");
    };
    window.addEventListener("table:deselected", handleClear);
    return () => window.removeEventListener("table:deselected", handleClear);
  }, []);

  const table = tableState?.table ?? null;
  const opts = table?.styleOptions;

  const saveTableName = useCallback(() => {
    if (!table || tableName === savedName) return;
    const trimmed = tableName.trim();
    if (trimmed === "") {
      setTableName(savedName);
      return;
    }
    setSavedName(trimmed);
    setTableName(trimmed);
  }, [table, tableName, savedName]);

  const toggleOption = useCallback(
    (key: keyof TableStyleOptions) => {
      if (!table || !opts) return;
      if (key === "totalRow") {
        toggleTotalsRowAsync(table.id, !opts.totalRow).then((updated) => {
          if (updated) {
            setTableState({ table: updated });
            emitAppEvent(TableEvents.TABLE_DEFINITIONS_UPDATED);
          }
        });
      } else {
        updateTableStyleAsync(table.id, { [key]: !opts[key] }).then((updated) => {
          if (updated) {
            setTableState({ table: updated });
            emitAppEvent(TableEvents.TABLE_DEFINITIONS_UPDATED);
          }
        });
      }
    },
    [table, opts],
  );

  const handleConvertToRange = useCallback(() => {
    if (!table) return;
    const confirmed = window.confirm(
      "Do you want to convert the table to a normal range?\n\n" +
        "Structured references in formulas will be converted to cell references.",
    );
    if (!confirmed) return;
    convertToRangeAsync(table.id).then((success) => {
      if (success) {
        setTableState(null);
        emitAppEvent(TableEvents.TABLE_DEFINITIONS_UPDATED);
      }
    });
  }, [table]);

  const handleDeleteTable = useCallback(() => {
    if (!table) return;
    deleteTableAsync(table.id).then((success) => {
      if (success) {
        setTableState(null);
        emitAppEvent(TableEvents.TABLE_DEFINITIONS_UPDATED);
      }
    });
  }, [table]);

  const handleStyleSelect = useCallback((_styleId: string) => {
    setSelectedStyleId(_styleId);
  }, []);

  const handleStyleClear = useCallback(() => {
    setSelectedStyleId("");
  }, []);

  if (!tableState) {
    return (
      <div className={tabStyles.disabledMessage}>
        Select a Table to see design options
      </div>
    );
  }

  // Shared content renderers (used in both expanded and collapsed states)
  const propertiesContent = (
    <div className={tabStyles.groupContentVertical}>
      <span style={{ fontSize: 10, color: "#666" }}>Table Name:</span>
      <input
        ref={nameInputRef}
        type="text"
        className={tabStyles.nameInput}
        value={tableName}
        onChange={(e) => setTableName(e.target.value)}
        onBlur={saveTableName}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            saveTableName();
            nameInputRef.current?.blur();
          }
        }}
      />
      <button className={tabStyles.toolButton} disabled>
        Resize Table
      </button>
    </div>
  );

  const toolsContent = (
    <div className={tabStyles.groupContentVertical}>
      <div className={tabStyles.groupContent}>
        <button className={tabStyles.toolButton} disabled>
          Summarize with PivotTable
        </button>
        <button className={tabStyles.toolButton} disabled>
          Insert Slicer
        </button>
      </div>
      <div className={tabStyles.groupContent}>
        <button className={tabStyles.toolButton} disabled>
          Remove Duplicates
        </button>
        <button className={tabStyles.toolButton} onClick={handleConvertToRange}>
          Convert to Range
        </button>
        <button className={tabStyles.toolButtonDanger} onClick={handleDeleteTable}>
          Delete Table
        </button>
      </div>
    </div>
  );

  const styleOptionsContent = (
    <div className={tabStyles.groupContent}>
      <div className={tabStyles.checkboxColumn}>
        <label className={tabStyles.checkboxLabel}>
          <input type="checkbox" checked={opts?.headerRow ?? false} onChange={() => toggleOption("headerRow")} />
          Header Row
        </label>
        <label className={tabStyles.checkboxLabel}>
          <input type="checkbox" checked={opts?.totalRow ?? false} onChange={() => toggleOption("totalRow")} />
          Total Row
        </label>
        <label className={tabStyles.checkboxLabel}>
          <input type="checkbox" checked={opts?.bandedRows ?? false} onChange={() => toggleOption("bandedRows")} />
          Banded Rows
        </label>
      </div>
      <div className={tabStyles.checkboxColumn}>
        <label className={tabStyles.checkboxLabel}>
          <input type="checkbox" checked={opts?.firstColumn ?? false} onChange={() => toggleOption("firstColumn")} />
          First Column
        </label>
        <label className={tabStyles.checkboxLabel}>
          <input type="checkbox" checked={opts?.lastColumn ?? false} onChange={() => toggleOption("lastColumn")} />
          Last Column
        </label>
        <label className={tabStyles.checkboxLabel}>
          <input type="checkbox" checked={opts?.bandedColumns ?? false} onChange={() => toggleOption("bandedColumns")} />
          Banded Columns
        </label>
      </div>
      <div className={tabStyles.checkboxColumn}>
        <label className={tabStyles.checkboxLabel}>
          <input type="checkbox" checked={opts?.showFilterButton ?? true} onChange={() => toggleOption("showFilterButton")} />
          Filter Button
        </label>
      </div>
    </div>
  );

  return (
    <div ref={containerRef} className={tabStyles.container}>
      <RibbonGroup label="Properties" icon={"\u2699"} collapsed={collapsed[0]}>
        {propertiesContent}
      </RibbonGroup>

      <RibbonGroup label="Tools" icon={"\u2692"} collapsed={collapsed[1]}>
        {toolsContent}
      </RibbonGroup>

      <RibbonGroup label="Table Style Options" icon={"\u2611"} collapsed={collapsed[2]}>
        {styleOptionsContent}
      </RibbonGroup>

      <TableStylesGallery
        selectedStyleId={selectedStyleId}
        onStyleSelect={handleStyleSelect}
        onStyleClear={handleStyleClear}
      />
    </div>
  );
}
