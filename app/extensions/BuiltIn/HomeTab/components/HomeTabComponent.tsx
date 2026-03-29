//! FILENAME: app/extensions/BuiltIn/HomeTab/components/HomeTabComponent.tsx
// PURPOSE: The Home ribbon tab component showing quick-access formatting commands.
// CONTEXT: Renders configurable groups of formatting buttons in the ribbon.

import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { css } from "@emotion/css";
import { useGridState, cellEvents } from "../../../../src/api";
import { CommandRegistry, CoreCommands } from "../../../../src/api/commands";
import { DialogExtensions } from "../../../../src/api/ui";
import {
  getCell,
  getStyle,
  applyFormatting,
  setCellRichText,
} from "../../../../src/api/lib";
import type { RichTextRun, CellData } from "../../../../src/api/types";
import type { RibbonContext } from "../../../../src/api/extensions";
import type { StyleData } from "../../../../src/api/types";
import {
  loadLayout,
  ITEMS_BY_ID,
  type HomeTabLayout,
  type HomeTabItem,
} from "../homeTabConfig";
import { CellStylesGallery } from "./CellStylesGallery";
import type { CellStyleDefinition } from "./CellStylesGallery";
import { useRibbonCollapse, RibbonGroup } from "../../../../src/api/ribbonCollapse";

// ============================================================================
// Styles
// ============================================================================

const styles = {
  container: css`
    display: flex;
    align-items: stretch;
    height: 100%;
    width: 100%;
    font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
    font-size: 12px;
    position: relative;
  `,
  groupContent: css`
    display: flex;
    gap: 3px;
    align-items: center;
    flex: 1;
  `,
  cogContainer: css`
    position: absolute;
    right: 4px;
    top: 2px;
    display: flex;
    align-items: center;
    justify-content: center;
  `,
  cogButton: css`
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border: none;
    border-radius: 3px;
    background: transparent;
    cursor: pointer;
    color: #999;
    font-size: 14px;
    padding: 0;

    &:hover {
      background: #e5e5e5;
      color: #555;
    }
  `,
};

const btnBase = css`
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 26px;
  height: 26px;
  padding: 2px 5px;
  border: 1px solid transparent;
  border-radius: 3px;
  background: transparent;
  cursor: pointer;
  font-size: 13px;
  color: #333;
  font-family: inherit;

  &:hover:not(:disabled) {
    background: #e5e5e5;
    border-color: #c0c0c0;
  }

  &:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
`;

const btnActive = css`
  background: #cce4f7;
  border-color: #84b8de;

  &:hover:not(:disabled) {
    background: #b8d7f0;
    border-color: #6aadde;
  }
`;

const colorBtnStyle = css`
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-width: 30px;
  height: 26px;
  padding: 1px 4px;
  border: 1px solid transparent;
  border-radius: 3px;
  background: transparent;
  cursor: pointer;
  font-size: 13px;
  color: #333;
  font-family: inherit;
  gap: 0;

  &:hover:not(:disabled) {
    background: #e5e5e5;
    border-color: #c0c0c0;
  }
`;

// ============================================================================
// Collapse configuration
// ============================================================================

/** Collapse priority by group ID. Lower = collapses first. */
const COLLAPSE_ORDER: Record<string, number> = {
  styles: 1,
  colors: 2,
  editing: 3,
  insert: 4,
  number: 5,
  alignment: 6,
  font: 7,
  clipboard: 8,
};

/** Icons for collapsed group buttons */
const GROUP_ICONS: Record<string, string> = {
  clipboard: "\u2702",
  font: "A",
  alignment: "\u2261",
  number: "#",
  styles: "\u2728",
  colors: "\uD83C\uDFA8",
  editing: "\u270E",
  insert: "+",
};

/** Estimated expanded width per item in pixels */
const WIDTH_PER_ITEM = 32;
const GROUP_PADDING = 24;

// ============================================================================
// Color Palette (compact for ribbon dropdown)
// ============================================================================

const QUICK_COLORS = [
  "#000000", "#1a1a2e", "#0f3460", "#7c3aed", "#dc2626", "#ea580c",
  "#d97706", "#65a30d", "#059669", "#0284c7",
  "#ffffff", "#bfbfbf", "#808080", "#404040", "#ef4444", "#f97316",
  "#eab308", "#84cc16", "#10b981", "#38bdf8",
];

function ColorDropdown({
  currentColor,
  onColorSelect,
  onClose,
}: {
  currentColor: string;
  onColorSelect: (color: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className={css`
        position: absolute;
        top: 100%;
        left: 0;
        z-index: 1100;
        margin-top: 2px;
        padding: 6px;
        background: #fff;
        border: 1px solid #c0c0c0;
        border-radius: 4px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      `}
    >
      <div
        className={css`
          display: grid;
          grid-template-columns: repeat(10, 1fr);
          gap: 2px;
          margin-bottom: 4px;
        `}
      >
        {QUICK_COLORS.map((color) => (
          <button
            key={color}
            title={color}
            onClick={() => {
              onColorSelect(color);
              onClose();
            }}
            className={css`
              width: 16px;
              height: 16px;
              padding: 0;
              border: ${currentColor.toLowerCase() === color.toLowerCase()
                ? "2px solid #0078d4"
                : "1px solid #ccc"};
              border-radius: 2px;
              background-color: ${color};
              cursor: pointer;

              &:hover {
                border: 2px solid #333;
                transform: scale(1.15);
              }
            `}
          />
        ))}
      </div>
      <div
        className={css`
          display: flex;
          align-items: center;
          gap: 4px;
          padding-top: 4px;
          border-top: 1px solid #e0e0e0;
        `}
      >
        <span className={css`font-size: 11px; color: #666;`}>Custom:</span>
        <input
          type="color"
          value={currentColor}
          onChange={(e) => {
            onColorSelect(e.target.value);
            onClose();
          }}
          className={css`
            width: 22px;
            height: 18px;
            padding: 0;
            border: 1px solid #ccc;
            border-radius: 2px;
            cursor: pointer;
          `}
        />
      </div>
    </div>
  );
}

// ============================================================================
// Component
// ============================================================================

export function HomeTabComponent({
  context: _context,
}: {
  context: RibbonContext;
}): React.ReactElement {
  const gridState = useGridState();
  const [layout, setLayout] = useState<HomeTabLayout>(loadLayout);
  const [currentStyle, setCurrentStyle] = useState<StyleData | null>(null);
  const [currentCellData, setCurrentCellData] = useState<CellData | null>(null);
  const [openColorPicker, setOpenColorPicker] = useState<string | null>(null);
  const [cellStylesOpen, setCellStylesOpen] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);

  const groupDefs = useMemo(
    () =>
      layout.groups.map((g) => ({
        collapseOrder: COLLAPSE_ORDER[g.id] ?? 50,
        expandedWidth: g.items.length * WIDTH_PER_ITEM + GROUP_PADDING,
      })),
    [layout.groups],
  );
  const collapsed = useRibbonCollapse(containerRef, groupDefs);

  // Reload layout when the customize dialog saves
  useEffect(() => {
    const handler = () => setLayout(loadLayout());
    window.addEventListener("homeTab:layoutChanged", handler);
    return () => window.removeEventListener("homeTab:layoutChanged", handler);
  }, []);

  // Load style of active cell when selection changes
  useEffect(() => {
    const sel = gridState.selection;
    if (!sel) {
      setCurrentStyle(null);
      return;
    }
    let cancelled = false;
    getCell(sel.startRow, sel.startCol).then((cell) => {
      if (cancelled || !cell) return;
      setCurrentCellData(cell);
      return getStyle(cell.styleIndex).then((style) => {
        if (!cancelled) setCurrentStyle(style);
      });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [gridState.selection]);

  // Get the rows/cols arrays for current selection
  const getSelectionRange = useCallback(() => {
    const sel = gridState.selection;
    if (!sel) return null;
    const startRow = Math.min(sel.startRow, sel.endRow);
    const endRow = Math.max(sel.startRow, sel.endRow);
    const startCol = Math.min(sel.startCol, sel.endCol);
    const endCol = Math.max(sel.startCol, sel.endCol);
    const rows: number[] = [];
    const cols: number[] = [];
    for (let r = startRow; r <= endRow; r++) rows.push(r);
    for (let c = startCol; c <= endCol; c++) cols.push(c);
    return { rows, cols };
  }, [gridState.selection]);

  // Apply formatting and refresh
  const applyFormat = useCallback(
    async (formatting: Record<string, unknown>) => {
      const range = getSelectionRange();
      if (!range) return;
      try {
        const result = await applyFormatting(
          range.rows,
          range.cols,
          formatting as Parameters<typeof applyFormatting>[2]
        );
        for (const cell of result.cells) {
          cellEvents.emit({
            row: cell.row,
            col: cell.col,
            oldValue: undefined,
            newValue: cell.display,
            formula: cell.formula,
          });
        }
        window.dispatchEvent(new CustomEvent("styles:refresh"));
        window.dispatchEvent(new CustomEvent("grid:refresh"));
        // Reload current cell style
        const sel = gridState.selection;
        if (sel) {
          const cell = await getCell(sel.startRow, sel.startCol);
          if (cell) {
            const style = await getStyle(cell.styleIndex);
            setCurrentStyle(style);
          }
        }
      } catch (err) {
        console.error("[HomeTab] Failed to apply formatting:", err);
      }
    },
    [getSelectionRange, gridState.selection]
  );

  // Handle item click
  const handleItemClick = useCallback(
    async (item: HomeTabItem) => {
      switch (item.id) {
        // Clipboard
        case "cut":
          await CommandRegistry.execute(CoreCommands.CUT);
          break;
        case "copy":
          await CommandRegistry.execute(CoreCommands.COPY);
          break;
        case "paste":
          await CommandRegistry.execute(CoreCommands.PASTE);
          break;
        case "formatPainter":
          await CommandRegistry.execute(CoreCommands.FORMAT_PAINTER);
          break;

        // Font toggles
        case "bold":
          await applyFormat({ bold: !(currentStyle?.bold ?? false) });
          break;
        case "italic":
          await applyFormat({ italic: !(currentStyle?.italic ?? false) });
          break;
        case "underline":
          await applyFormat({ underline: !(currentStyle?.underline ?? false) });
          break;
        case "strikethrough":
          await applyFormat({ strikethrough: !(currentStyle?.strikethrough ?? false) });
          break;

        // Superscript / Subscript (rich text operations)
        case "superscript":
        case "subscript": {
          const sel = gridState.selection;
          if (!sel) break;
          const isSuperscript = itemId === "superscript";
          const cellData = await getCell(sel.startRow, sel.startCol);
          const cellText = cellData?.display ?? "";
          if (!cellText) break;

          // Check current state from rich text runs
          const runs = cellData?.richText;
          const isCurrentlyActive = runs?.length === 1 &&
            (isSuperscript ? runs[0].superscript : runs[0].subscript);

          if (isCurrentlyActive) {
            // Turn off: clear rich text
            await setCellRichText(sel.startRow, sel.startCol, null);
          } else {
            // Turn on: wrap entire cell in a single run
            const run: RichTextRun = {
              text: cellText,
              superscript: isSuperscript,
              subscript: !isSuperscript,
            };
            await setCellRichText(sel.startRow, sel.startCol, [run]);
          }
          // Refresh cell data
          const updated = await getCell(sel.startRow, sel.startCol);
          if (updated) setCurrentCellData(updated);
          break;
        }

        // Format Cells dialog
        case "formatCells":
          await CommandRegistry.execute(CoreCommands.FORMAT_CELLS);
          break;

        // Alignment
        case "alignLeft":
          await applyFormat({ textAlign: currentStyle?.textAlign === "left" ? "general" : "left" });
          break;
        case "alignCenter":
          await applyFormat({ textAlign: currentStyle?.textAlign === "center" ? "general" : "center" });
          break;
        case "alignRight":
          await applyFormat({ textAlign: currentStyle?.textAlign === "right" ? "general" : "right" });
          break;
        case "wrapText":
          await applyFormat({ wrapText: !(currentStyle?.wrapText ?? false) });
          break;
        case "increaseIndent":
          await applyFormat({ indent: Math.min(15, (currentStyle?.indent ?? 0) + 1) });
          break;
        case "decreaseIndent":
          await applyFormat({ indent: Math.max(0, (currentStyle?.indent ?? 0) - 1) });
          break;
        case "mergeCells":
          await CommandRegistry.execute(CoreCommands.MERGE_CELLS);
          break;

        // Number formats
        case "percentFormat":
          await applyFormat({ numberFormat: "0%" });
          break;
        case "commaFormat":
          await applyFormat({ numberFormat: "#,##0" });
          break;
        case "increaseDecimal": {
          const fmt = currentStyle?.numberFormat ?? "General";
          const decimals = (fmt.match(/0/g) || []).length;
          const newFmt = decimals === 0 ? "0.0" : fmt.replace(/(0*)$/, "$10");
          await applyFormat({ numberFormat: newFmt === fmt ? "0.0" : newFmt });
          break;
        }
        case "decreaseDecimal": {
          const fmt = currentStyle?.numberFormat ?? "General";
          if (fmt.includes(".")) {
            const parts = fmt.split(".");
            const after = parts[1].replace(/0$/, "");
            const newFmt = after ? `${parts[0]}.${after}` : parts[0] || "0";
            await applyFormat({ numberFormat: newFmt });
          }
          break;
        }

        // Editing
        case "undo":
          await CommandRegistry.execute(CoreCommands.UNDO);
          break;
        case "redo":
          await CommandRegistry.execute(CoreCommands.REDO);
          break;
        case "find":
          await CommandRegistry.execute(CoreCommands.FIND);
          break;
        case "clearContents":
          await CommandRegistry.execute(CoreCommands.CLEAR_CONTENTS);
          break;

        // Insert
        case "insertRow":
          await CommandRegistry.execute(CoreCommands.INSERT_ROW);
          break;
        case "insertColumn":
          await CommandRegistry.execute(CoreCommands.INSERT_COLUMN);
          break;
        case "deleteRow":
          await CommandRegistry.execute(CoreCommands.DELETE_ROW);
          break;
        case "deleteColumn":
          await CommandRegistry.execute(CoreCommands.DELETE_COLUMN);
          break;
      }
    },
    [applyFormat, currentStyle]
  );

  // Handle cell style gallery selection
  const handleCellStyleApply = useCallback(
    async (formatting: CellStyleDefinition["formatting"]) => {
      await applyFormat(formatting as Record<string, unknown>);
    },
    [applyFormat]
  );

  // Handle color selection
  const handleColorSelect = useCallback(
    async (itemId: string, color: string) => {
      if (itemId === "textColor") {
        await applyFormat({ textColor: color });
      } else if (itemId === "backgroundColor") {
        await applyFormat({ backgroundColor: color });
      }
    },
    [applyFormat]
  );

  // Check if a toggle item is active
  const isActive = useCallback(
    (itemId: string): boolean => {
      if (!currentStyle) return false;
      switch (itemId) {
        case "bold": return currentStyle.bold;
        case "italic": return currentStyle.italic;
        case "underline": return currentStyle.underline;
        case "strikethrough": return currentStyle.strikethrough;
        case "wrapText": return currentStyle.wrapText;
        case "alignLeft": return currentStyle.textAlign === "left";
        case "alignCenter": return currentStyle.textAlign === "center";
        case "alignRight": return currentStyle.textAlign === "right";
        case "superscript": {
          const runs = currentCellData?.richText;
          return !!(runs?.length === 1 && runs[0].superscript);
        }
        case "subscript": {
          const runs = currentCellData?.richText;
          return !!(runs?.length === 1 && runs[0].subscript);
        }
        default: return false;
      }
    },
    [currentStyle, currentCellData]
  );

  // Get current color for color items
  const getCurrentColor = useCallback(
    (itemId: string): string => {
      if (!currentStyle) return itemId === "textColor" ? "#000000" : "#ffffff";
      if (itemId === "textColor") return currentStyle.textColor;
      if (itemId === "backgroundColor") return currentStyle.backgroundColor;
      return "#000000";
    },
    [currentStyle]
  );

  const openCustomizeDialog = useCallback(() => {
    DialogExtensions.openDialog("home-tab-customize");
  }, []);

  // Render a single item
  const renderItem = (itemId: string) => {
    const item = ITEMS_BY_ID.get(itemId);
    if (!item) return null;

    // Color picker buttons
    if (item.type === "color") {
      const color = getCurrentColor(item.id);
      return (
        <div key={item.id} style={{ position: "relative" }}>
          <button
            className={colorBtnStyle}
            title={item.tooltip}
            onClick={() =>
              setOpenColorPicker(openColorPicker === item.id ? null : item.id)
            }
          >
            <span style={{
              fontWeight: item.id === "textColor" ? 700 : 400,
              fontSize: item.id === "textColor" ? "13px" : "11px",
              lineHeight: 1,
            }}>
              {item.icon}
            </span>
            <span
              style={{
                display: "block",
                width: "18px",
                height: "3px",
                backgroundColor: color,
                borderRadius: "1px",
                marginTop: "-1px",
              }}
            />
          </button>
          {openColorPicker === item.id && (
            <ColorDropdown
              currentColor={color}
              onColorSelect={(c) => handleColorSelect(item.id, c)}
              onClose={() => setOpenColorPicker(null)}
            />
          )}
        </div>
      );
    }

    // Cell Styles gallery dropdown
    if (item.id === "cellStyles") {
      return (
        <div key={item.id} style={{ position: "relative" }}>
          <button
            className={btnBase}
            title={item.tooltip}
            onClick={() => setCellStylesOpen(!cellStylesOpen)}
          >
            <span style={{ fontSize: "11px" }}>{item.icon}</span>
            <span style={{ fontSize: "10px", marginLeft: "3px" }}>{"\u25BC"}</span>
          </button>
          {cellStylesOpen && (
            <CellStylesGallery
              onApplyStyle={handleCellStyleApply}
              onClose={() => setCellStylesOpen(false)}
            />
          )}
        </div>
      );
    }

    // Regular buttons and toggles
    const active = item.type === "toggle" && isActive(item.id);
    return (
      <button
        key={item.id}
        className={`${btnBase} ${active ? btnActive : ""}`}
        title={item.tooltip}
        onClick={() => handleItemClick(item)}
        style={
          item.id === "bold" ? { fontWeight: 700 } :
          item.id === "italic" ? { fontStyle: "italic" } :
          item.id === "underline" ? { textDecoration: "underline" } :
          item.id === "strikethrough" ? { textDecoration: "line-through" } :
          undefined
        }
      >
        {item.icon}
      </button>
    );
  };

  return (
    <div ref={containerRef} className={styles.container}>
      {layout.groups.map((group, idx) => (
        <RibbonGroup
          key={group.id}
          label={group.label}
          icon={GROUP_ICONS[group.id] ?? "\u2630"}
          collapsed={collapsed[idx] ?? false}
        >
          <div className={styles.groupContent}>
            {group.items.map((itemId) => renderItem(itemId))}
          </div>
        </RibbonGroup>
      ))}

      {/* Cog wheel icon for customization */}
      <div className={styles.cogContainer}>
        <button
          className={styles.cogButton}
          title="Customize Home tab"
          onClick={openCustomizeDialog}
        >
          {"\u2699"}
        </button>
      </div>
    </div>
  );
}
