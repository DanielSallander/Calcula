//! FILENAME: app/extensions/Table/components/TableDesignTab.tsx
// PURPOSE: "Table Design" panel sections: Properties, Tools, Table Style Options,
//          JSON, and the Table Styles gallery.
// CONTEXT: Registered as a contextual, ribbon-placed panel while the selection is
//          inside a table (see handlers/selectionHandler.ts). The shell owns all
//          cluster chrome (card, caption, launcher demotion), so each section
//          renders only its controls. Sections communicate with the Table
//          extension via custom events (TABLE_STATE / TABLE_REQUEST_STATE).
//
//          Built from the @api/layout control grammar (the Calcula Clusters
//          redesign, docs/design/ribbon-design-system.md), and every section
//          obeys THE FILL RULE of the band's 61px content box:
//
//            Properties     TWO ROWS   name field / Resize Table
//            Tools          TWO ROWS   three columns of icon buttons
//            Style Options  TWO ROWS   four columns of checkboxes
//            JSON           ONE TALL   the JSON hero (opens the "table-json" pane)
//            Table Styles   ONE TALL   the StyleGallery strip
//
//          Colours come only from tokens (LT); this file is under the chrome
//          hex-ban in app/eslint.boundaries.js. The style thumbnails' colours
//          are DATA in ../lib/tableStyles.ts.

import React, { useState, useEffect, useCallback, useId, useMemo, useRef } from "react";
import { css } from "@emotion/css";
import {
  onAppEvent,
  emitAppEvent,
  showDialog,
  useGridState,
  RibbonIcon,
  openTaskPane,
  closeTaskPane,
  useIsTaskPaneOpen,
  useTaskPaneOpenPaneIds,
} from "@api";
import type { PanelSection, PanelSectionProps } from "@api/uiTypes";
import {
  Stack,
  ControlRow,
  Field,
  Input,
  Button,
  Checkbox,
  CommandButton,
  LT,
  useSurfaceLayout,
  CONTROL_HEIGHT_MD,
  FONT_FAMILY,
  GAP_SM,
  GAP_XS,
  HERO_ICON_SIZE,
  ICON_SIZE_MD,
  ICON_SIZE_SM,
  ROW_GAP,
} from "@api/layout";
import { TableEvents } from "../lib/tableEvents";
import {
  updateTableStyleAsync,
  toggleTotalsRowAsync,
  convertToRangeAsync,
  deleteTableAsync,
  renameTableAsync,
  resizeTableAsync,
  type Table,
  type TableStyleOptions,
} from "../lib/tableStore";
import {
  applyTableStyleAsync,
  tableStyleIdForName,
  TABLE_STYLE_NONE_ID,
} from "../lib/tableStyles";
import { TableStylesGallery } from "./TableStylesGallery";
import { TABLE_JSON_PANE_ID } from "./TableJsonPane";
import { confirmAsync } from "@api/dialogs";

// ============================================================================
// Styles (tokens only)
// ============================================================================

const sectionStyles = {
  disabledMessage: css`
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: ${LT.textSecondary};
    font-family: ${FONT_FAMILY};
    font-style: italic;
    font-size: 12px;
    white-space: nowrap;
  `,
  inlineError: css`
    font-family: ${FONT_FAMILY};
    font-size: 11px;
    color: ${LT.dangerFg};
    max-width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  /** Band: two 28px rows filled column by column (28 + 5 + 28 = 61), so the
   *  controls line up in columns the way Excel's small-button groups do. */
  bandColumns: css`
    display: grid;
    grid-auto-flow: column;
    grid-template-rows: repeat(2, ${CONTROL_HEIGHT_MD}px);
    row-gap: ${ROW_GAP}px;
    align-content: center;
    align-items: center;
    justify-items: start;
    height: 100%;
    min-width: 0;
  `,
  panelList: css`
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    min-width: 0;
  `,
  panelWrap: css`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: ${GAP_XS}px;
    min-width: 0;
  `,
};

/**
 * The two-row column grid of the band. Outside the band the same children
 * render as a vertical list (`panel="list"`) or a wrapping toolbar row
 * (`panel="wrap"`).
 */
function TwoRowColumns({
  columnGap,
  panel,
  children,
}: {
  columnGap: number;
  panel: "list" | "wrap";
  children: React.ReactNode;
}): React.ReactElement {
  const layout = useSurfaceLayout();
  if (layout.container === "band") {
    return (
      <div className={sectionStyles.bandColumns} style={{ columnGap }}>
        {children}
      </div>
    );
  }
  return (
    <div className={panel === "list" ? sectionStyles.panelList : sectionStyles.panelWrap}>
      {children}
    </div>
  );
}

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
  const gridState = useGridState();
  const [tableName, setTableName] = useState("");
  const [savedName, setSavedName] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const nameInputId = useId();

  // Sync the editable name whenever a table-state broadcast arrives. Also
  // clears any stale error so switching tables doesn't carry the last one over.
  useEffect(() => {
    if (tableState?.table) {
      setTableName(tableState.table.name);
      setSavedName(tableState.table.name);
      setRenameError(null);
    }
  }, [tableState]);

  const table = tableState?.table ?? null;

  // Re-broadcast so every Design section refreshes its own cached copy of the
  // table (each section holds its own), instead of showing pre-change values.
  const refreshTableState = useCallback(() => {
    emitAppEvent(TableEvents.TABLE_DEFINITIONS_UPDATED);
    emitAppEvent(TableEvents.TABLE_REQUEST_STATE);
  }, []);

  // The rename must reach the BACKEND. This used to update local React state
  // only, so the box accepted a new name, showed it, and reverted on the next
  // table-state broadcast — structured references kept resolving against the
  // old name and nothing said why.
  //
  // `inFlight` guards the Enter path: onKeyDown calls this and then blurs, and
  // the blur handler calls it again before the first await has resolved
  // (savedName is only updated after), which fired two renames and two undo
  // entries for one keystroke.
  const renameInFlight = useRef(false);
  const saveTableName = useCallback(async () => {
    if (!table || renameInFlight.current || tableName === savedName) return;
    const trimmed = tableName.trim();
    if (trimmed === "" || trimmed === savedName) {
      setTableName(savedName);
      return;
    }
    renameInFlight.current = true;
    setRenameError(null);
    try {
      const result = await renameTableAsync(table.id, trimmed);
      if (result.ok) {
        setSavedName(trimmed);
        setTableName(trimmed);
        refreshTableState();
      } else {
        // Duplicate or invalid name: revert the box and say why.
        setRenameError(result.error ?? "Rename failed");
        setTableName(savedName);
      }
    } finally {
      renameInFlight.current = false;
    }
  }, [table, tableName, savedName, refreshTableState]);

  // Resize to the CURRENT SELECTION. Excel opens a range picker prefilled with
  // the table's range; selecting first and then clicking is the same gesture
  // without a modal, and it reuses the selection the user already has.
  //
  // Selection is ANCHOR -> ACTIVE, not min/max: dragging up or left yields
  // end < start. Normalize before comparing or the button stays disabled for
  // exactly the drags that grow a table upward.
  const selection = gridState.selection;
  const selRange = useMemo(
    () =>
      selection
        ? {
            startRow: Math.min(selection.startRow, selection.endRow),
            endRow: Math.max(selection.startRow, selection.endRow),
            startCol: Math.min(selection.startCol, selection.endCol),
            endCol: Math.max(selection.startCol, selection.endCol),
          }
        : null,
    [selection],
  );

  const canResize =
    !!table &&
    !!selRange &&
    // A table needs a header row plus at least one data row.
    selRange.endRow > selRange.startRow &&
    !(
      selRange.startRow === table.startRow &&
      selRange.startCol === table.startCol &&
      selRange.endRow === table.endRow &&
      selRange.endCol === table.endCol
    );

  const handleResize = useCallback(async () => {
    if (!table || !selRange) return;
    setRenameError(null);
    const updated = await resizeTableAsync(
      table.id,
      selRange.startRow,
      selRange.startCol,
      selRange.endRow,
      selRange.endCol,
    );
    if (!updated) {
      setRenameError("Resize failed — the range may overlap another table.");
      return;
    }
    refreshTableState();
  }, [table, selRange, refreshTableState]);

  if (!tableState) {
    return (
      <div className={sectionStyles.disabledMessage}>
        Select a Table to see design options
      </div>
    );
  }

  // TWO ROWS: the name field, then Resize Table (and the last error, which
  // shares the second row rather than adding a third that would not fit).
  return (
    <Stack gap={ROW_GAP}>
      <Field label="Table Name:" htmlFor={nameInputId}>
        <Input
          ref={nameInputRef}
          id={nameInputId}
          type="text"
          width={120}
          value={tableName}
          data-testid="table-design-name"
          onChange={(e) => setTableName(e.target.value)}
          onBlur={() => { void saveTableName(); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              void saveTableName();
              nameInputRef.current?.blur();
            }
          }}
        />
      </Field>
      <ControlRow gap={GAP_SM}>
        <Button
          icon={<RibbonIcon.Resize size={ICON_SIZE_SM} />}
          disabled={!canResize}
          onClick={() => { void handleResize(); }}
          data-testid="table-design-resize"
          // A native title, not a Tooltip: the hint matters most while the
          // button is DISABLED, and a disabled button receives no pointer
          // events for a Tooltip to open on.
          title={
            canResize
              ? "Resize this table to the selected range"
              : "Select the new range on the grid first"
          }
        >
          Resize Table
        </Button>
        {renameError && (
          <span className={sectionStyles.inlineError} title={renameError} role="alert">
            {renameError}
          </span>
        )}
      </ControlRow>
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

  const handleConvertToRange = useCallback(async () => {
    if (!table) return;
    // AWAITED. `!confirmed` on a Promise was always false, so Cancel converted
    // the table anyway and rewrote every structured reference to A1 form.
    const confirmed = await confirmAsync(
      "Do you want to convert the table to a normal range?\n\n" +
        "Structured references in formulas will be converted to cell references.",
      { title: "Convert to range" },
    );
    if (!confirmed) return;
    convertToRangeAsync(table.id).then((success) => {
      if (success) {
        setTableState(null);
        // Clear every mounted Table Design section (each holds its own copy)
        window.dispatchEvent(new Event("table:deselected"));
        // NO TABLE_DEFINITIONS_UPDATED HERE. The store announces the `objects`
        // domain itself now (BUG-0051), and the Shell translator dispatches
        // that event from it. Re-emitting from the button was the reason the
        // defect was invisible from this screen and reproducible from every
        // other route.
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
        // See handleConvertToRange: the store owns this announcement.
      }
    });
  }, [table, setTableState]);

  if (!tableState) return null;

  // TWO ROWS, filled column by column: analyse | slice | change the table.
  return (
    <TwoRowColumns columnGap={GAP_XS} panel="wrap">
      <Button
        icon={<RibbonIcon.Pivot size={ICON_SIZE_SM} />}
        onClick={handleSummarizeWithPivot}
        data-testid="table-design-summarize-pivot"
      >
        Summarize with PivotTable
      </Button>
      <Button
        icon={<RibbonIcon.DeleteRow size={ICON_SIZE_SM} />}
        onClick={handleRemoveDuplicates}
        data-testid="table-design-remove-duplicates"
      >
        Remove Duplicates
      </Button>
      <Button
        icon={<RibbonIcon.Slicer size={ICON_SIZE_SM} />}
        onClick={handleInsertSlicer}
        data-testid="table-design-insert-slicer"
      >
        Insert Slicer
      </Button>
      <Button
        icon={<RibbonIcon.Table size={ICON_SIZE_SM} />}
        onClick={() => void handleConvertToRange()}
        data-testid="table-design-convert-to-range"
      >
        Convert to Range
      </Button>
      <Button
        icon={<RibbonIcon.Script size={ICON_SIZE_SM} />}
        onClick={handleEditScript}
        data-testid="table-design-edit-script"
      >
        Edit Script...
      </Button>
      <Button
        icon={<RibbonIcon.Delete size={ICON_SIZE_SM} />}
        tone="danger"
        onClick={handleDeleteTable}
        data-testid="table-design-delete"
      >
        Delete Table
      </Button>
    </TwoRowColumns>
  );
}

// ============================================================================
// Table Style Options section
// ============================================================================

/** The seven flags, paired so each band column reads as one idea: the
 *  header/total rows, the banding, the emphasised columns, the filter. */
const STYLE_OPTIONS: ReadonlyArray<{ key: keyof TableStyleOptions; label: string }> = [
  { key: "headerRow", label: "Header Row" },
  { key: "totalRow", label: "Total Row" },
  { key: "bandedRows", label: "Banded Rows" },
  { key: "bandedColumns", label: "Banded Columns" },
  { key: "firstColumn", label: "First Column" },
  { key: "lastColumn", label: "Last Column" },
  { key: "showFilterButton", label: "Filter Button" },
];

/** What an absent flag shows: the filter button is on unless turned off. */
function optionChecked(opts: TableStyleOptions | undefined, key: keyof TableStyleOptions): boolean {
  return opts?.[key] ?? key === "showFilterButton";
}

export function StyleOptionsSection(_props: PanelSectionProps): React.ReactElement | null {
  const { tableState, setTableState } = useDesignTableState();
  const table = tableState?.table ?? null;
  const opts = table?.styleOptions;

  const setOption = useCallback(
    (key: keyof TableStyleOptions, value: boolean) => {
      if (!table || !opts) return;
      if (key === "totalRow") {
        toggleTotalsRowAsync(table.id, value).then((updated) => {
          if (updated) {
            setTableState({ table: updated });
            emitAppEvent(TableEvents.TABLE_DEFINITIONS_UPDATED);
          }
        });
      } else {
        updateTableStyleAsync(table.id, { [key]: value }).then((updated) => {
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

  // TWO ROWS in the band (four columns of checkboxes); one list elsewhere.
  return (
    <TwoRowColumns columnGap={12} panel="list">
      {STYLE_OPTIONS.map(({ key, label }) => (
        <Checkbox
          key={key}
          label={label}
          checked={optionChecked(opts, key)}
          onChange={(checked) => setOption(key, checked)}
          testId={`table-style-option-${key}`}
        />
      ))}
    </TwoRowColumns>
  );
}

// ============================================================================
// JSON section — opens the "table-json" task pane
// ============================================================================

export function JsonSection(_props: PanelSectionProps): React.ReactElement | null {
  const { tableState } = useDesignTableState();
  const taskPaneOpen = useIsTaskPaneOpen();
  const openPaneIds = useTaskPaneOpenPaneIds();
  const showing = taskPaneOpen && openPaneIds.includes(TABLE_JSON_PANE_ID);

  if (!tableState) return null;
  const { table } = tableState;

  return (
    <CommandButton
      icon={<RibbonIcon.Code size={HERO_ICON_SIZE} />}
      label="JSON"
      active={showing}
      tooltip="Edit this table as JSON"
      data-testid="table-json-toggle"
      onClick={() => {
        if (showing) closeTaskPane(TABLE_JSON_PANE_ID);
        else openTaskPane(TABLE_JSON_PANE_ID, { tableId: table.id, tableName: table.name });
      }}
    />
  );
}

// ============================================================================
// Table Styles section (gallery)
// ============================================================================

export function StylesSection(_props: PanelSectionProps): React.ReactElement | null {
  const { tableState, setTableState } = useDesignTableState();
  const table = tableState?.table ?? null;

  // The gallery WRITES the table's style name. Its highlight is derived from
  // what the table stores (`styleName`), never kept locally: the old gallery
  // held the choice in React state, wrote nothing, and forgot it on remount.
  const applyStyle = useCallback(
    async (styleId: string) => {
      if (!table) return;
      const updated = await applyTableStyleAsync(table.id, styleId);
      if (updated) {
        setTableState({ table: updated });
        emitAppEvent(TableEvents.TABLE_DEFINITIONS_UPDATED);
      }
    },
    [table, setTableState],
  );

  if (!table) return null;

  return (
    <TableStylesGallery
      selectedStyleId={tableStyleIdForName(table.styleName)}
      onStyleSelect={(styleId) => void applyStyle(styleId)}
      onStyleClear={() => void applyStyle(TABLE_STYLE_NONE_ID)}
    />
  );
}

// ============================================================================
// Section list
// ============================================================================

// One PanelSection per ribbon cluster. collapsePriority preserves the old
// collapse order (Properties first, then Tools, then Style Options — lower
// collapses to a launcher first). The JSON hero and the styles gallery are
// band-designed (each is exactly one 61px row), so they are trusted "inline"
// (never height-probed) and collapse last.
export const TABLE_DESIGN_SECTIONS: PanelSection[] = [
  {
    id: "table-design.properties",
    label: "Properties",
    icon: <RibbonIcon.Settings size={ICON_SIZE_MD} />,
    component: PropertiesSection,
    collapsePriority: 1,
  },
  {
    id: "table-design.tools",
    label: "Tools",
    icon: <RibbonIcon.Lightning size={ICON_SIZE_MD} />,
    component: ToolsSection,
    collapsePriority: 2,
  },
  {
    id: "table-design.styleOptions",
    label: "Table Style Options",
    icon: <RibbonIcon.BandedRows size={ICON_SIZE_MD} />,
    component: StyleOptionsSection,
    collapsePriority: 3,
  },
  {
    id: "table-design.json",
    label: "JSON",
    icon: <RibbonIcon.Code size={ICON_SIZE_MD} />,
    component: JsonSection,
    ribbonPresentation: "inline",
    collapsePriority: 100,
  },
  {
    id: "table-design.styles",
    label: "Table Styles",
    icon: <RibbonIcon.TableStyle size={ICON_SIZE_MD} />,
    component: StylesSection,
    ribbonPresentation: "inline",
    collapsePriority: 200,
  },
];
