//! FILENAME: app/extensions/Table/components/TableDesignTab.tsx
// PURPOSE: "Table Design" panel sections: Properties, Tools, Table Style Options,
//          JSON toggle, and the Table Styles gallery.
// CONTEXT: Registered as a contextual, ribbon-placed panel while the selection is
//          inside a table (see handlers/selectionHandler.ts). The shell owns all
//          group chrome (label below content, dividers) and width-collapse
//          behavior, so each section renders only its controls. Sections
//          communicate with the Table extension via custom events
//          (TABLE_STATE / TABLE_REQUEST_STATE).

import React, { useState, useEffect, useCallback, useRef } from "react";
import { css } from "@emotion/css";
import { onAppEvent, emitAppEvent, showDialog } from "@api";
import type { PanelSection, PanelSectionProps } from "@api/uiTypes";
import { Stack, ControlRow, Field, Input, Button } from "@api/layout";
import { TableEvents } from "../lib/tableEvents";
import {
  updateTableStyleAsync,
  toggleTotalsRowAsync,
  convertToRangeAsync,
  deleteTableAsync,
  type Table,
  type TableStyleOptions,
} from "../lib/tableStore";
import { TableStylesGallery, DEFAULT_TABLE_STYLE_ID } from "./TableStylesGallery";
import { useJsonToggle, JsonToggleButton, JsonToggleEditor } from "../../_shared/components/jsonToggle";

// ============================================================================
// Styles
// ============================================================================

const sectionStyles = {
  disabledMessage: css`
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: #999;
    font-style: italic;
    font-size: 12px;
    white-space: nowrap;
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
  // Danger variant layered on top of the standard layout Button
  // (&& doubles specificity so it wins over the Button base class).
  dangerButton: css`
    && {
      color: #c42b1c;
    }
    &&:hover:not(:disabled) {
      background: #fde7e7;
      border-color: #c42b1c;
    }
    &&:active:not(:disabled) {
      background: #fbd0d0;
    }
  `,
};

// ============================================================================
// Shared table-state hook
// ============================================================================

interface TableState {
  table: Table;
}

/**
 * Subscribe to the selection handler's table-state broadcasts.
 * Each mounted section holds its own copy; TABLE_STATE broadcasts and the
 * "table:deselected" window event keep all sections in sync.
 */
function useDesignTableState(): {
  tableState: TableState | null;
  setTableState: React.Dispatch<React.SetStateAction<TableState | null>>;
} {
  const [tableState, setTableState] = useState<TableState | null>(null);

  // Listen for table state broadcasts from the selection handler
  useEffect(() => {
    const unsub = onAppEvent<TableState>(TableEvents.TABLE_STATE, (detail) => {
      setTableState(detail);
    });
    emitAppEvent(TableEvents.TABLE_REQUEST_STATE);
    return unsub;
  }, []);

  // Clear state when the table is deselected (or converted/deleted)
  useEffect(() => {
    const handleClear = () => setTableState(null);
    window.addEventListener("table:deselected", handleClear);
    return () => window.removeEventListener("table:deselected", handleClear);
  }, []);

  return { tableState, setTableState };
}

// ============================================================================
// Properties section
// ============================================================================

export function PropertiesSection(_props: PanelSectionProps): React.ReactElement {
  const { tableState } = useDesignTableState();
  const [tableName, setTableName] = useState("");
  const [savedName, setSavedName] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Sync the editable name whenever a table-state broadcast arrives
  useEffect(() => {
    if (tableState?.table) {
      setTableName(tableState.table.name);
      setSavedName(tableState.table.name);
    }
  }, [tableState]);

  const table = tableState?.table ?? null;

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

  if (!tableState) {
    return (
      <div className={sectionStyles.disabledMessage}>
        Select a Table to see design options
      </div>
    );
  }

  return (
    <Stack gap={4}>
      <Field label="Table Name:">
        <Input
          ref={nameInputRef}
          type="text"
          width={120}
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
      </Field>
      <Button disabled>Resize Table</Button>
    </Stack>
  );
}

// ============================================================================
// Tools section
// ============================================================================

export function ToolsSection(_props: PanelSectionProps): React.ReactElement | null {
  const { tableState, setTableState } = useDesignTableState();
  const table = tableState?.table ?? null;

  const handleSummarizeWithPivot = useCallback(() => {
    if (!table) return;
    showDialog("pivot:createDialog", {
      selection: {
        startRow: table.startRow,
        startCol: table.startCol,
        endRow: table.endRow,
        endCol: table.endCol,
      },
      tableName: table.name,
    });
  }, [table]);

  const handleInsertSlicer = useCallback(() => {
    if (!table) return;
    showDialog("slicer:insertDialog", {
      sourceType: "table",
      sourceId: table.id,
    });
  }, [table]);

  const handleRemoveDuplicates = useCallback(() => {
    if (!table) return;
    showDialog("table:removeDuplicatesDialog", { table });
  }, [table]);

  const handleEditScript = useCallback(() => {
    if (!table) return;
    // Generic scriptable-objects seam: the ScriptableObjects extension scaffolds
    // + registers a "table" script keyed by the table's EntityId, then opens the
    // editor.
    emitAppEvent("scriptable-objects:edit-script", {
      objectType: "table",
      instanceId: String(table.id),
      objectName: table.name,
    });
  }, [table]);

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
        // Clear every mounted Table Design section (each holds its own copy)
        window.dispatchEvent(new Event("table:deselected"));
        emitAppEvent(TableEvents.TABLE_DEFINITIONS_UPDATED);
      }
    });
  }, [table, setTableState]);

  const handleDeleteTable = useCallback(() => {
    if (!table) return;
    deleteTableAsync(table.id).then((success) => {
      if (success) {
        setTableState(null);
        // Clear every mounted Table Design section (each holds its own copy)
        window.dispatchEvent(new Event("table:deselected"));
        emitAppEvent(TableEvents.TABLE_DEFINITIONS_UPDATED);
      }
    });
  }, [table, setTableState]);

  if (!tableState) return null;

  return (
    <Stack gap={4}>
      <ControlRow gap={4}>
        <Button onClick={handleSummarizeWithPivot}>Summarize with PivotTable</Button>
        <Button onClick={handleInsertSlicer}>Insert Slicer</Button>
        <Button onClick={handleRemoveDuplicates}>Remove Duplicates</Button>
      </ControlRow>
      <ControlRow gap={4}>
        <Button onClick={handleEditScript}>Edit Script...</Button>
        <Button onClick={handleConvertToRange}>Convert to Range</Button>
        <Button className={sectionStyles.dangerButton} onClick={handleDeleteTable}>
          Delete Table
        </Button>
      </ControlRow>
    </Stack>
  );
}

// ============================================================================
// Table Style Options section
// ============================================================================

export function StyleOptionsSection(_props: PanelSectionProps): React.ReactElement | null {
  const { tableState, setTableState } = useDesignTableState();
  const table = tableState?.table ?? null;
  const opts = table?.styleOptions;

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
    [table, opts, setTableState],
  );

  if (!tableState) return null;

  // A single Stack: the band caps at the ribbon content height and
  // column-wraps (Excel-style checkbox columns); the sidebar shows one list.
  return (
    <Stack gap={4}>
      <label className={sectionStyles.checkboxLabel}>
        <input type="checkbox" checked={opts?.headerRow ?? false} onChange={() => toggleOption("headerRow")} />
        Header Row
      </label>
      <label className={sectionStyles.checkboxLabel}>
        <input type="checkbox" checked={opts?.totalRow ?? false} onChange={() => toggleOption("totalRow")} />
        Total Row
      </label>
      <label className={sectionStyles.checkboxLabel}>
        <input type="checkbox" checked={opts?.bandedRows ?? false} onChange={() => toggleOption("bandedRows")} />
        Banded Rows
      </label>
      <label className={sectionStyles.checkboxLabel}>
        <input type="checkbox" checked={opts?.firstColumn ?? false} onChange={() => toggleOption("firstColumn")} />
        First Column
      </label>
      <label className={sectionStyles.checkboxLabel}>
        <input type="checkbox" checked={opts?.lastColumn ?? false} onChange={() => toggleOption("lastColumn")} />
        Last Column
      </label>
      <label className={sectionStyles.checkboxLabel}>
        <input type="checkbox" checked={opts?.bandedColumns ?? false} onChange={() => toggleOption("bandedColumns")} />
        Banded Columns
      </label>
      <label className={sectionStyles.checkboxLabel}>
        <input type="checkbox" checked={opts?.showFilterButton ?? true} onChange={() => toggleOption("showFilterButton")} />
        Filter Button
      </label>
    </Stack>
  );
}

// ============================================================================
// JSON section (Phase C toggle)
// ============================================================================

export function JsonSection(_props: PanelSectionProps): React.ReactElement | null {
  const { tableState } = useDesignTableState();

  const jsonToggle = useJsonToggle(
    "table",
    tableState?.table?.id != null ? String(tableState.table.id) : "",
    () => emitAppEvent(TableEvents.TABLE_REQUEST_STATE),
  );

  if (!tableState) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "2px 6px" }}>
      <JsonToggleButton
        isActive={jsonToggle.isJsonMode}
        onClick={jsonToggle.toggle}
        disabled={!tableState}
      />
      {jsonToggle.isJsonMode && (
        <div style={{ position: "fixed", right: 8, top: 140, width: 420, height: 400, zIndex: 500, border: "1px solid #555", borderRadius: 6, overflow: "hidden", boxShadow: "0 4px 16px rgba(0,0,0,0.4)" }}>
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
      )}
    </div>
  );
}

// ============================================================================
// Table Styles section (gallery)
// ============================================================================

export function StylesSection(_props: PanelSectionProps): React.ReactElement | null {
  const { tableState } = useDesignTableState();
  const [selectedStyleId, setSelectedStyleId] = useState(DEFAULT_TABLE_STYLE_ID);

  const handleStyleSelect = useCallback((_styleId: string) => {
    setSelectedStyleId(_styleId);
  }, []);

  const handleStyleClear = useCallback(() => {
    setSelectedStyleId("");
  }, []);

  if (!tableState) return null;

  return (
    <TableStylesGallery
      selectedStyleId={selectedStyleId}
      onStyleSelect={handleStyleSelect}
      onStyleClear={handleStyleClear}
    />
  );
}

// ============================================================================
// Section list
// ============================================================================

// One PanelSection per former ribbon group. collapsePriority preserves the old
// collapse order (Properties first, then Tools, then Style Options — lower
// collapses to a launcher first). The JSON toggle and the styles gallery never
// collapsed under the old system: they get high priorities, and both are
// band-designed widgets so they are trusted "inline" (never height-probed);
// the gallery keeps its own ResizeObserver-driven Quick Styles fallback.
export const TABLE_DESIGN_SECTIONS: PanelSection[] = [
  {
    id: "table-design.properties",
    label: "Properties",
    icon: "⚙",
    component: PropertiesSection,
    collapsePriority: 1,
  },
  {
    id: "table-design.tools",
    label: "Tools",
    icon: "⚒",
    component: ToolsSection,
    collapsePriority: 2,
  },
  {
    id: "table-design.styleOptions",
    label: "Table Style Options",
    icon: "☑",
    component: StyleOptionsSection,
    collapsePriority: 3,
  },
  {
    id: "table-design.json",
    label: "JSON",
    component: JsonSection,
    ribbonPresentation: "inline",
    collapsePriority: 100,
  },
  {
    id: "table-design.styles",
    label: "Table Styles",
    component: StylesSection,
    ribbonPresentation: "inline",
    collapsePriority: 200,
  },
];
