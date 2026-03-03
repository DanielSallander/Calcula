//! FILENAME: app/src/shell/Overlays/MiniFormatToolbar/MiniFormatToolbar.tsx
// PURPOSE: Mini format toolbar that appears above the context menu on right-click.
// CONTEXT: Shell overlay component. Uses the public API (applyFormatting) to apply
//          formatting to the current selection. Similar to Excel's mini toolbar.

import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  getCell,
  getStyle,
  applyFormatting,
} from "../../../api/lib";
import { cellEvents } from "../../../api";
import type { GridMenuContext } from "../../../api/extensions";
import * as S from "./MiniFormatToolbar.styles";

// ============================================================================
// Constants
// ============================================================================

const FONT_LIST: string[] = [
  "system-ui",
  "Arial",
  "Calibri",
  "Cambria",
  "Comic Sans MS",
  "Consolas",
  "Courier New",
  "Georgia",
  "Impact",
  "Segoe UI",
  "Tahoma",
  "Times New Roman",
  "Trebuchet MS",
  "Verdana",
];

const FONT_SIZES: number[] = [
  8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 28, 36, 48, 72,
];

const QUICK_COLORS = [
  // Row 1 - Dark colors
  "#000000", "#404040", "#808080", "#bfbfbf", "#ffffff",
  "#c00000", "#ff0000", "#ffc000", "#ffff00", "#92d050",
  // Row 2 - Theme accents
  "#00b050", "#00b0f0", "#0070c0", "#002060", "#7030a0",
  "#ff6699", "#ff9933", "#cccc00", "#66cc66", "#33cccc",
];

// ============================================================================
// Types
// ============================================================================

export interface MiniFormatToolbarProps {
  position: { x: number; y: number };
  context: GridMenuContext;
  onClose: () => void;
}

interface CurrentStyle {
  fontFamily: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  textColor: string;
  backgroundColor: string;
  textAlign: string;
}

const DEFAULT_STYLE: CurrentStyle = {
  fontFamily: "system-ui",
  fontSize: 11,
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
  textColor: "#000000",
  backgroundColor: "#ffffff",
  textAlign: "general",
};

// ============================================================================
// Helpers
// ============================================================================

function getSelectionRange(context: GridMenuContext) {
  const sel = context.selection;
  if (!sel) return null;
  const startRow = Math.min(sel.startRow, sel.endRow);
  const endRow = Math.max(sel.startRow, sel.endRow);
  const startCol = Math.min(sel.startCol, sel.endCol);
  const endCol = Math.max(sel.startCol, sel.endCol);
  const rows: number[] = [];
  const cols: number[] = [];
  for (let r = startRow; r <= endRow; r++) rows.push(r);
  for (let c = startCol; c <= endCol; c++) cols.push(c);
  return { rows, cols, startRow, startCol };
}

// ============================================================================
// Color Picker Popover (inline)
// ============================================================================

function InlineColorPicker({
  colors,
  currentColor,
  onPick,
  onClose,
}: {
  colors: string[];
  currentColor: string;
  onPick: (color: string) => void;
  onClose: () => void;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const timeout = setTimeout(() => {
      document.addEventListener("mousedown", handle);
    }, 0);
    return () => {
      clearTimeout(timeout);
      document.removeEventListener("mousedown", handle);
    };
  }, [onClose]);

  return (
    <S.ColorDropdown ref={ref} onClick={(e) => e.stopPropagation()}>
      <S.ColorGrid>
        {colors.map((color) => (
          <S.ColorCell
            key={color}
            $color={color}
            $selected={currentColor.toLowerCase() === color.toLowerCase()}
            onClick={() => {
              onPick(color);
              onClose();
            }}
            title={color}
          />
        ))}
      </S.ColorGrid>
    </S.ColorDropdown>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function MiniFormatToolbar({
  position,
  context,
  onClose,
}: MiniFormatToolbarProps): React.ReactElement {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CurrentStyle>(DEFAULT_STYLE);
  const [textColorOpen, setTextColorOpen] = useState(false);
  const [fillColorOpen, setFillColorOpen] = useState(false);

  // Load the active cell's current style
  useEffect(() => {
    async function load() {
      try {
        const sel = context.selection;
        if (!sel) return;
        const row = Math.min(sel.startRow, sel.endRow);
        const col = Math.min(sel.startCol, sel.endCol);
        const cell = await getCell(row, col);
        if (!cell) return;
        const s = await getStyle(cell.styleIndex);
        setStyle({
          fontFamily: s.fontFamily || "system-ui",
          fontSize: s.fontSize || 11,
          bold: !!s.bold,
          italic: !!s.italic,
          underline: !!s.underline,
          strikethrough: !!s.strikethrough,
          textColor: s.textColor || "#000000",
          backgroundColor: s.backgroundColor || "#ffffff",
          textAlign: s.textAlign || "general",
        });
      } catch (err) {
        console.error("[MiniFormatToolbar] Failed to load style:", err);
      }
    }
    load();
  }, [context]);

  // Position adjustment to keep within viewport
  useEffect(() => {
    if (!toolbarRef.current) return;
    const el = toolbarRef.current;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;

    let x = position.x;
    // Center the toolbar above the context menu position
    x = position.x - rect.width / 2;
    // Keep within horizontal bounds
    if (x + rect.width > vw - 8) x = vw - rect.width - 8;
    if (x < 8) x = 8;
    // Place it above the context menu click point
    let y = position.y - rect.height - 4;
    if (y < 8) y = position.y + 4; // If no room above, place below

    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, [position]);

  // Apply formatting helper
  const apply = useCallback(
    async (formatting: Record<string, unknown>) => {
      const range = getSelectionRange(context);
      if (!range) return;
      try {
        const result = await applyFormatting(range.rows, range.cols, formatting as never);
        // Emit cell change events
        for (const cell of result.cells) {
          cellEvents.emit({
            row: cell.row,
            col: cell.col,
            oldValue: undefined,
            newValue: cell.display,
            formula: cell.formula,
          });
        }
        // Refresh grid
        window.dispatchEvent(new CustomEvent("styles:refresh"));
        window.dispatchEvent(new CustomEvent("grid:refresh"));
      } catch (err) {
        console.error("[MiniFormatToolbar] Failed to apply formatting:", err);
      }
    },
    [context],
  );

  // Toggle handlers
  const toggleBold = useCallback(async () => {
    const next = !style.bold;
    setStyle((s) => ({ ...s, bold: next }));
    await apply({ bold: next });
  }, [style.bold, apply]);

  const toggleItalic = useCallback(async () => {
    const next = !style.italic;
    setStyle((s) => ({ ...s, italic: next }));
    await apply({ italic: next });
  }, [style.italic, apply]);

  const toggleUnderline = useCallback(async () => {
    const next = !style.underline;
    setStyle((s) => ({ ...s, underline: next }));
    await apply({ underline: next });
  }, [style.underline, apply]);

  const toggleStrikethrough = useCallback(async () => {
    const next = !style.strikethrough;
    setStyle((s) => ({ ...s, strikethrough: next }));
    await apply({ strikethrough: next });
  }, [style.strikethrough, apply]);

  const changeFontFamily = useCallback(
    async (e: React.ChangeEvent<HTMLSelectElement>) => {
      const val = e.target.value;
      setStyle((s) => ({ ...s, fontFamily: val }));
      await apply({ fontFamily: val });
    },
    [apply],
  );

  const changeFontSize = useCallback(
    async (e: React.ChangeEvent<HTMLSelectElement>) => {
      const val = parseFloat(e.target.value);
      if (!isNaN(val) && val > 0) {
        setStyle((s) => ({ ...s, fontSize: val }));
        await apply({ fontSize: val });
      }
    },
    [apply],
  );

  const increaseFontSize = useCallback(async () => {
    const current = style.fontSize;
    const next = FONT_SIZES.find((s) => s > current) ?? current + 2;
    setStyle((s) => ({ ...s, fontSize: next }));
    await apply({ fontSize: next });
  }, [style.fontSize, apply]);

  const decreaseFontSize = useCallback(async () => {
    const current = style.fontSize;
    const smaller = FONT_SIZES.filter((s) => s < current);
    const next = smaller.length > 0 ? smaller[smaller.length - 1] : Math.max(1, current - 2);
    setStyle((s) => ({ ...s, fontSize: next }));
    await apply({ fontSize: next });
  }, [style.fontSize, apply]);

  const changeTextColor = useCallback(
    async (color: string) => {
      setStyle((s) => ({ ...s, textColor: color }));
      await apply({ textColor: color });
    },
    [apply],
  );

  const changeFillColor = useCallback(
    async (color: string) => {
      setStyle((s) => ({ ...s, backgroundColor: color }));
      await apply({ backgroundColor: color });
    },
    [apply],
  );

  const changeAlign = useCallback(
    async (align: string) => {
      setStyle((s) => ({ ...s, textAlign: align }));
      await apply({ textAlign: align });
    },
    [apply],
  );

  const applyPercentFormat = useCallback(async () => {
    await apply({ numberFormat: "0%" });
  }, [apply]);

  const applyCommaFormat = useCallback(async () => {
    await apply({ numberFormat: "#,##0.00" });
  }, [apply]);

  const increaseDecimals = useCallback(async () => {
    // A simple approach: apply a format with more decimals
    await apply({ numberFormat: "#,##0.000" });
  }, [apply]);

  const decreaseDecimals = useCallback(async () => {
    await apply({ numberFormat: "#,##0" });
  }, [apply]);

  const disabled = !context.selection;

  return (
    <S.ToolbarContainer
      ref={toolbarRef}
      style={{ left: position.x, top: position.y }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {/* Font Family & Size */}
      <S.ButtonGroup>
        <S.FontFamilySelect
          value={style.fontFamily}
          onChange={changeFontFamily}
          disabled={disabled}
          title="Font"
        >
          {FONT_LIST.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </S.FontFamilySelect>

        <S.FontSizeSelect
          value={style.fontSize}
          onChange={changeFontSize}
          disabled={disabled}
          title="Font Size"
        >
          {FONT_SIZES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </S.FontSizeSelect>

        <S.ToolbarButton
          onClick={increaseFontSize}
          disabled={disabled}
          title="Increase Font Size"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <text x="1" y="12" fontSize="11" fontWeight="bold" fill="currentColor">A</text>
            <text x="9" y="8" fontSize="7" fontWeight="bold" fill="currentColor">A</text>
          </svg>
        </S.ToolbarButton>

        <S.ToolbarButton
          onClick={decreaseFontSize}
          disabled={disabled}
          title="Decrease Font Size"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <text x="1" y="12" fontSize="8" fontWeight="bold" fill="currentColor">A</text>
            <text x="8" y="12" fontSize="11" fontWeight="bold" fill="currentColor">A</text>
          </svg>
        </S.ToolbarButton>
      </S.ButtonGroup>

      {/* Bold, Italic, Underline, Strikethrough */}
      <S.ButtonGroup>
        <S.ToolbarButton
          $active={style.bold}
          onClick={toggleBold}
          disabled={disabled}
          title="Bold (Ctrl+B)"
        >
          <strong>B</strong>
        </S.ToolbarButton>

        <S.ToolbarButton
          $active={style.italic}
          onClick={toggleItalic}
          disabled={disabled}
          title="Italic (Ctrl+I)"
        >
          <em style={{ fontFamily: "serif" }}>I</em>
        </S.ToolbarButton>

        <S.ToolbarButton
          $active={style.underline}
          onClick={toggleUnderline}
          disabled={disabled}
          title="Underline (Ctrl+U)"
        >
          <span style={{ textDecoration: "underline" }}>U</span>
        </S.ToolbarButton>

        <S.ToolbarButton
          $active={style.strikethrough}
          onClick={toggleStrikethrough}
          disabled={disabled}
          title="Strikethrough"
        >
          <span style={{ textDecoration: "line-through" }}>S</span>
        </S.ToolbarButton>
      </S.ButtonGroup>

      {/* Text Color & Fill Color */}
      <S.ButtonGroup>
        <div style={{ position: "relative" }}>
          <S.ToolbarButton
            onClick={() => {
              setTextColorOpen(!textColorOpen);
              setFillColorOpen(false);
            }}
            disabled={disabled}
            title="Font Color"
          >
            <span style={{ fontWeight: "bold", fontSize: "12px" }}>A</span>
            <S.ColorIndicator $color={style.textColor} />
          </S.ToolbarButton>
          {textColorOpen && (
            <InlineColorPicker
              colors={QUICK_COLORS}
              currentColor={style.textColor}
              onPick={changeTextColor}
              onClose={() => setTextColorOpen(false)}
            />
          )}
        </div>

        <div style={{ position: "relative" }}>
          <S.ToolbarButton
            onClick={() => {
              setFillColorOpen(!fillColorOpen);
              setTextColorOpen(false);
            }}
            disabled={disabled}
            title="Fill Color"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <rect x="1" y="1" width="12" height="10" rx="1" fill={style.backgroundColor} stroke="currentColor" strokeWidth="1" />
            </svg>
            <S.ColorIndicator $color={style.backgroundColor} />
          </S.ToolbarButton>
          {fillColorOpen && (
            <InlineColorPicker
              colors={QUICK_COLORS}
              currentColor={style.backgroundColor}
              onPick={changeFillColor}
              onClose={() => setFillColorOpen(false)}
            />
          )}
        </div>
      </S.ButtonGroup>

      {/* Alignment */}
      <S.ButtonGroup>
        <S.ToolbarButton
          $active={style.textAlign === "left"}
          onClick={() => changeAlign("left")}
          disabled={disabled}
          title="Align Left"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
            <line x1="2" y1="3" x2="12" y2="3" />
            <line x1="2" y1="6" x2="9" y2="6" />
            <line x1="2" y1="9" x2="12" y2="9" />
            <line x1="2" y1="12" x2="9" y2="12" />
          </svg>
        </S.ToolbarButton>

        <S.ToolbarButton
          $active={style.textAlign === "center"}
          onClick={() => changeAlign("center")}
          disabled={disabled}
          title="Align Center"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
            <line x1="2" y1="3" x2="12" y2="3" />
            <line x1="3.5" y1="6" x2="10.5" y2="6" />
            <line x1="2" y1="9" x2="12" y2="9" />
            <line x1="3.5" y1="12" x2="10.5" y2="12" />
          </svg>
        </S.ToolbarButton>

        <S.ToolbarButton
          $active={style.textAlign === "right"}
          onClick={() => changeAlign("right")}
          disabled={disabled}
          title="Align Right"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
            <line x1="2" y1="3" x2="12" y2="3" />
            <line x1="5" y1="6" x2="12" y2="6" />
            <line x1="2" y1="9" x2="12" y2="9" />
            <line x1="5" y1="12" x2="12" y2="12" />
          </svg>
        </S.ToolbarButton>
      </S.ButtonGroup>

      {/* Number Format shortcuts */}
      <S.ButtonGroup>
        <S.ToolbarButton
          onClick={applyPercentFormat}
          disabled={disabled}
          title="Percent Style"
        >
          <span style={{ fontSize: "11px", fontWeight: 500 }}>%</span>
        </S.ToolbarButton>

        <S.ToolbarButton
          onClick={applyCommaFormat}
          disabled={disabled}
          title="Comma Style"
        >
          <span style={{ fontSize: "11px", fontWeight: 500 }}>,</span>
        </S.ToolbarButton>

        <S.ToolbarButton
          onClick={increaseDecimals}
          disabled={disabled}
          title="Increase Decimal"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <text x="0" y="11" fontSize="8" fill="currentColor">.0</text>
            <text x="8" y="6" fontSize="7" fill="currentColor">+</text>
          </svg>
        </S.ToolbarButton>

        <S.ToolbarButton
          onClick={decreaseDecimals}
          disabled={disabled}
          title="Decrease Decimal"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <text x="0" y="11" fontSize="8" fill="currentColor">.0</text>
            <text x="8" y="6" fontSize="7" fill="currentColor">-</text>
          </svg>
        </S.ToolbarButton>
      </S.ButtonGroup>
    </S.ToolbarContainer>
  );
}
