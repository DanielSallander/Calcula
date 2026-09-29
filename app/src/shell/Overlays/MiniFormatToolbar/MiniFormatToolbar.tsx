//! FILENAME: app/src/shell/Overlays/MiniFormatToolbar/MiniFormatToolbar.tsx
// PURPOSE: Mini format toolbar that appears above the context menu on right-click.
// CONTEXT: Shell overlay component. Uses the public API (applyFormatting) to apply
//          formatting to the current selection. Similar to Excel's mini toolbar.
//
//          Built from the @api/layout control grammar, so the app has ONE toolbar
//          language (Calcula Clusters, Open.dc.html board 4): the floating pill
//          (MiniFormatToolbar.styles.ts) holds the ribbon's own Segmented pills,
//          28px IconButtons with RibbonIcon glyphs, ColorSwatch bars with the
//          shared ColorPopover, and the shared Select. B / I / U / S stay
//          typographic, as they do on the Home tab.
//
//          TOOLTIPS open ABOVE the pill (placement "top"): below it is the
//          context menu the user is about to use. Each carries the control's
//          shortcut chip where the grid has one (the formatting shortcuts live
//          in the grid's own keyboard handler, not the keybinding registry, so
//          they are literals here). Every control asks for that through its OWN
//          props (`tooltipPlacement`, `tooltipZIndex`, ColorSwatch `zIndex`),
//          so each control shows exactly one tooltip. The two font Selects are
//          the exception only in form: a native <select> has no tooltip prop,
//          so a Tooltip attaches to it directly (it clones the element, adding
//          no wrapper).
//
//          LAYERS. The palettes and tooltips are portalled to <body>, and the
//          pill sits above the context menu, so each overlay is handed a
//          numeric layer above both (MINI_TOOLBAR_LAYER and
//          MINI_TOOLBAR_TOOLTIP_LAYER in the styles file).
//
//          PRESSES stay inside the toolbar: its root stops mousedown so the
//          context menu below does not treat a press on the toolbar as an
//          outside click and close. The same stop hides those presses from an
//          open colour palette's own outside-press dismissal, so the toolbar
//          closes the palette itself when a press inside the toolbar lands
//          outside that palette and its trigger (onMouseDownCapture below).
//
//          ONE PALETTE AT A TIME. The toolbar owns which colour palette is open
//          (`openColour`) and hands it to both ColorSwatches as controlled
//          `open` / `onOpenChange`, so opening Fill closes Font colour by
//          construction — no swatch is remounted, and focus and DOM identity
//          survive the switch.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { getCell, getStyle, applyFormatting } from "../../../api/lib";
import { cellEvents } from "../../../api";
import { refuseIfSelectionOwned } from "../../../api/selectionOwner";
import type { GridMenuContext } from "../../../api/extensions";
import {
  ColorSwatch,
  IconButton,
  QUICK_COLORS,
  Segmented,
  Select,
  Tooltip,
} from "../../../api/layout";
import { RibbonIcon } from "../../../api/ribbonIcons";
import { DEFAULT_STYLE as CELL_DEFAULT_STYLE } from "../../../core/types/types";
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

/** Icon size inside a 28px control. */
const ICON = 20;

/** Field widths: the longest font name in FONT_LIST, and "72" + chevron. */
const FONT_SELECT_WIDTH = 112;
const SIZE_SELECT_WIDTH = 56;

/** The two colour triggers. At most one palette is open at a time, and the
 *  toolbar owns which (see the header). */
type ColourSlot = "text" | "fill";

/** data-testid of each toolbar control (all prefixed, see the styles file). */
const tid = (name: string): string => `${S.TESTID_PREFIX}${name}`;
const COLOUR_TESTID: Record<ColourSlot, string> = {
  text: tid("text-color"),
  fill: tid("fill-color"),
};

/** Tooltip props for every IconButton on the pill: above it (the context menu
 *  is below), at a layer above the menu and any open palette. */
const TOP_TIP = {
  tooltipPlacement: "top",
  tooltipZIndex: S.MINI_TOOLBAR_TOOLTIP_LAYER,
} as const;

// ============================================================================
// Types
// ============================================================================

export interface MiniFormatToolbarProps {
  position: { x: number; y: number };
  /**
   * The context menu's final rectangle (top/bottom in viewport px). When
   * provided, the toolbar is placed directly above the menu's top edge so the
   * two never overlap — even if a tall menu was shifted up to fit the viewport.
   * Falls back to positioning above the raw click point when absent.
   */
  anchor?: { top: number; bottom: number };
  context: GridMenuContext;
  onClose: () => void;
}

interface CurrentStyle {
  fontFamily: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  underline: string;
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
  underline: "none",
  strikethrough: false,
  // A cell with no style of its own paints with the Core's defaults.
  textColor: CELL_DEFAULT_STYLE.textColor,
  backgroundColor: CELL_DEFAULT_STYLE.backgroundColor,
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
// Main Component
// ============================================================================

export function MiniFormatToolbar({
  position,
  anchor,
  context,
}: MiniFormatToolbarProps): React.ReactElement {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CurrentStyle>(DEFAULT_STYLE);
  // Which colour palette is open, if any. The ColorSwatches are controlled by
  // it, so there is one copy of this state and opening one palette closes the
  // other by construction (see the header).
  const [openColour, setOpenColour] = useState<ColourSlot | null>(null);

  /** A swatch asked to open or close its palette. Closing only clears the
   *  slot if it is still the open one: a stale close from the other swatch
   *  must never shut the palette that just opened. */
  const setColourOpen = useCallback((slot: ColourSlot, open: boolean) => {
    setOpenColour((prev) => (open ? slot : prev === slot ? null : prev));
  }, []);

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
          underline: s.underline || "none",
          strikethrough: !!s.strikethrough,
          textColor: s.textColor || CELL_DEFAULT_STYLE.textColor,
          backgroundColor: s.backgroundColor || CELL_DEFAULT_STYLE.backgroundColor,
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

    // Vertical placement: prefer sitting directly above the context menu's
    // actual top edge (so the two never overlap). Fall back to the raw click
    // point when the menu's rectangle hasn't been reported yet.
    const topRef = anchor ? anchor.top : position.y;
    let y = topRef - rect.height - 4;
    if (y < 8) {
      // No room above — drop below the menu (or the click point) instead.
      y = (anchor ? anchor.bottom : position.y) + 4;
    }

    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, [position, anchor]);

  // Close the open colour palette when a press inside the toolbar lands
  // outside it and its own trigger. The palette is portalled to <body>, but a
  // press inside it still reaches this capture handler through the React tree,
  // so it is recognised and left alone. See the header.
  const closeStrayColourPopover = useCallback(
    (target: EventTarget | null) => {
      const slot = openColour;
      const root = toolbarRef.current;
      if (slot === null || !root || !(target instanceof Node)) return;
      const trigger = root.querySelector(`[data-testid="${COLOUR_TESTID[slot]}"]`);
      if (trigger && trigger.contains(target)) return;
      const flyout = document
        .querySelector(`[data-testid="${COLOUR_TESTID[slot]}-popover"]`)
        ?.closest("[data-section-flyout]");
      if (flyout && flyout.contains(target)) return;
      setColourOpen(slot, false);
    },
    [openColour, setColourOpen],
  );

  // Apply formatting helper. Resolves false when the write was REFUSED
  // because something else holds the selection (BUG-0185: a floating grid's
  // selected cell, Core's selection hidden under it) -- the caller then leaves
  // its pressed/picked state alone, so the pill never shows a format it did
  // not apply. The refusal has already been announced, once.
  const apply = useCallback(
    async (formatting: Record<string, unknown>, action: string): Promise<boolean> => {
      if (refuseIfSelectionOwned(action)) return false;
      const range = getSelectionRange(context);
      if (!range) return true;
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
      return true;
    },
    [context],
  );

  // Toggle handlers
  const toggleBold = useCallback(async () => {
    const next = !style.bold;
    if (!(await apply({ bold: next }, "Bold"))) return;
    setStyle((s) => ({ ...s, bold: next }));
  }, [style.bold, apply]);

  const toggleItalic = useCallback(async () => {
    const next = !style.italic;
    if (!(await apply({ italic: next }, "Italic"))) return;
    setStyle((s) => ({ ...s, italic: next }));
  }, [style.italic, apply]);

  const toggleUnderline = useCallback(async () => {
    const next = style.underline !== "none" ? "none" as const : "single" as const;
    if (!(await apply({ underline: next }, "Underline"))) return;
    setStyle((s) => ({ ...s, underline: next }));
  }, [style.underline, apply]);

  const toggleStrikethrough = useCallback(async () => {
    const next = !style.strikethrough;
    if (!(await apply({ strikethrough: next }, "Strikethrough"))) return;
    setStyle((s) => ({ ...s, strikethrough: next }));
  }, [style.strikethrough, apply]);

  const changeFontFamily = useCallback(
    async (e: React.ChangeEvent<HTMLSelectElement>) => {
      const val = e.target.value;
      if (!(await apply({ fontFamily: val }, "Font"))) return;
      setStyle((s) => ({ ...s, fontFamily: val }));
    },
    [apply],
  );

  const changeFontSize = useCallback(
    async (e: React.ChangeEvent<HTMLSelectElement>) => {
      const val = parseFloat(e.target.value);
      if (!isNaN(val) && val > 0) {
        if (!(await apply({ fontSize: val }, "Font Size"))) return;
        setStyle((s) => ({ ...s, fontSize: val }));
      }
    },
    [apply],
  );

  const increaseFontSize = useCallback(async () => {
    const current = style.fontSize;
    const next = FONT_SIZES.find((s) => s > current) ?? current + 2;
    if (!(await apply({ fontSize: next }, "Increase Font Size"))) return;
    setStyle((s) => ({ ...s, fontSize: next }));
  }, [style.fontSize, apply]);

  const decreaseFontSize = useCallback(async () => {
    const current = style.fontSize;
    const smaller = FONT_SIZES.filter((s) => s < current);
    const next = smaller.length > 0 ? smaller[smaller.length - 1] : Math.max(1, current - 2);
    if (!(await apply({ fontSize: next }, "Decrease Font Size"))) return;
    setStyle((s) => ({ ...s, fontSize: next }));
  }, [style.fontSize, apply]);

  const changeTextColor = useCallback(
    async (color: string) => {
      if (!(await apply({ textColor: color }, "Font Color"))) return;
      setStyle((s) => ({ ...s, textColor: color }));
    },
    [apply],
  );

  const changeFillColor = useCallback(
    async (color: string) => {
      if (!(await apply({ backgroundColor: color }, "Fill Color"))) return;
      setStyle((s) => ({ ...s, backgroundColor: color }));
    },
    [apply],
  );

  const changeAlign = useCallback(
    async (align: string) => {
      if (!(await apply({ textAlign: align }, "Alignment"))) return;
      setStyle((s) => ({ ...s, textAlign: align }));
    },
    [apply],
  );

  const applyPercentFormat = useCallback(async () => {
    await apply({ numberFormat: "0%" }, "Percent Style");
  }, [apply]);

  const applyCommaFormat = useCallback(async () => {
    await apply({ numberFormat: "#,##0.00" }, "Comma Style");
  }, [apply]);

  const increaseDecimals = useCallback(async () => {
    // A simple approach: apply a format with more decimals
    await apply({ numberFormat: "#,##0.000" }, "Increase Decimal");
  }, [apply]);

  const decreaseDecimals = useCallback(async () => {
    await apply({ numberFormat: "#,##0" }, "Decrease Decimal");
  }, [apply]);

  const disabled = !context.selection;

  // A cell whose font or size is not in the lists still shows what it is,
  // instead of the select silently displaying the first option.
  const fontOptions = FONT_LIST.includes(style.fontFamily)
    ? FONT_LIST
    : [style.fontFamily, ...FONT_LIST];
  const sizeOptions = FONT_SIZES.includes(style.fontSize)
    ? FONT_SIZES
    : [...FONT_SIZES, style.fontSize].sort((a, b) => a - b);

  return (
    <div
      ref={toolbarRef}
      className={S.toolbar}
      style={{ left: position.x, top: position.y }}
      role="toolbar"
      aria-label="Format"
      data-testid={tid("toolbar")}
      onMouseDownCapture={(e) => closeStrayColourPopover(e.target)}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {/* Font family & size. A native <select> has no tooltip prop, so the
          Tooltip attaches to it directly (it clones, it does not wrap). */}
      <Tooltip content="Font" placement="top" zIndex={S.MINI_TOOLBAR_TOOLTIP_LAYER}>
        <Select
          width={FONT_SELECT_WIDTH}
          value={style.fontFamily}
          onChange={changeFontFamily}
          disabled={disabled}
          aria-label="Font"
          data-testid={tid("font")}
        >
          {fontOptions.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </Select>
      </Tooltip>

      <Tooltip content="Font size" placement="top" zIndex={S.MINI_TOOLBAR_TOOLTIP_LAYER}>
        <Select
          width={SIZE_SELECT_WIDTH}
          value={style.fontSize}
          onChange={changeFontSize}
          disabled={disabled}
          aria-label="Font size"
          data-testid={tid("size")}
        >
          {sizeOptions.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
      </Tooltip>

      <Segmented ariaLabel="Font size steps">
        <IconButton
          {...TOP_TIP}
          icon={<RibbonIcon.FontSizeUp size={ICON} />}
          label="Increase font size"
          onClick={increaseFontSize}
          disabled={disabled}
          data-testid={tid("grow")}
        />
        <IconButton
          {...TOP_TIP}
          icon={<RibbonIcon.FontSizeDown size={ICON} />}
          label="Decrease font size"
          onClick={decreaseFontSize}
          disabled={disabled}
          data-testid={tid("shrink")}
        />
      </Segmented>

      {/* Bold, Italic, Underline, Strikethrough */}
      <Segmented ariaLabel="Emphasis">
        <IconButton
          {...TOP_TIP}
          icon={<span className={S.glyph.bold}>B</span>}
          label="Bold"
          shortcut="Ctrl+B"
          pressed={style.bold}
          onClick={toggleBold}
          disabled={disabled}
          data-testid={tid("bold")}
        />
        <IconButton
          {...TOP_TIP}
          icon={<span className={S.glyph.italic}>I</span>}
          label="Italic"
          shortcut="Ctrl+I"
          pressed={style.italic}
          onClick={toggleItalic}
          disabled={disabled}
          data-testid={tid("italic")}
        />
        <IconButton
          {...TOP_TIP}
          icon={<span className={S.glyph.underline}>U</span>}
          label="Underline"
          shortcut="Ctrl+U"
          pressed={style.underline !== "none"}
          onClick={toggleUnderline}
          disabled={disabled}
          data-testid={tid("underline")}
        />
        <IconButton
          {...TOP_TIP}
          icon={<span className={S.glyph.strikethrough}>S</span>}
          label="Strikethrough"
          shortcut="Ctrl+5"
          pressed={style.strikethrough}
          onClick={toggleStrikethrough}
          disabled={disabled}
          data-testid={tid("strikethrough")}
        />
      </Segmented>

      {/* Text colour & fill colour: one palette open at a time (see the
          header). The palette opens at MINI_TOOLBAR_LAYER; ColorSwatch lays
          its swatch tooltips and its own trigger tooltip above that. */}
      <span className={S.colourPair}>
        <ColorSwatch
          variant="bar"
          icon={<RibbonIcon.FontColor size={ICON} />}
          label="Font colour"
          tooltipPlacement="top"
          zIndex={S.MINI_TOOLBAR_LAYER}
          open={openColour === "text"}
          onOpenChange={(open) => setColourOpen("text", open)}
          color={style.textColor}
          onChange={changeTextColor}
          colors={QUICK_COLORS}
          showTheme={false}
          disabled={disabled}
          testId={COLOUR_TESTID.text}
        />
        <ColorSwatch
          variant="bar"
          icon={<RibbonIcon.FillColor size={ICON} />}
          label="Fill colour"
          tooltipPlacement="top"
          zIndex={S.MINI_TOOLBAR_LAYER}
          open={openColour === "fill"}
          onOpenChange={(open) => setColourOpen("fill", open)}
          color={style.backgroundColor}
          onChange={changeFillColor}
          colors={QUICK_COLORS}
          showTheme={false}
          disabled={disabled}
          testId={COLOUR_TESTID.fill}
        />
      </span>

      {/* Alignment */}
      <Segmented ariaLabel="Horizontal alignment">
        <IconButton
          {...TOP_TIP}
          icon={<RibbonIcon.AlignLeft size={ICON} />}
          label="Align left"
          pressed={style.textAlign === "left"}
          onClick={() => changeAlign("left")}
          disabled={disabled}
          data-testid={tid("align-left")}
        />
        <IconButton
          {...TOP_TIP}
          icon={<RibbonIcon.AlignCenter size={ICON} />}
          label="Center"
          pressed={style.textAlign === "center"}
          onClick={() => changeAlign("center")}
          disabled={disabled}
          data-testid={tid("align-center")}
        />
        <IconButton
          {...TOP_TIP}
          icon={<RibbonIcon.AlignRight size={ICON} />}
          label="Align right"
          pressed={style.textAlign === "right"}
          onClick={() => changeAlign("right")}
          disabled={disabled}
          data-testid={tid("align-right")}
        />
      </Segmented>

      {/* Number format shortcuts */}
      <Segmented ariaLabel="Number format">
        <IconButton
          {...TOP_TIP}
          icon={<RibbonIcon.Percent size={ICON} />}
          label="Percent style"
          shortcut="Ctrl+Shift+%"
          onClick={applyPercentFormat}
          disabled={disabled}
          data-testid={tid("percent")}
        />
        <IconButton
          {...TOP_TIP}
          icon={<RibbonIcon.Comma size={ICON} />}
          label="Comma style"
          onClick={applyCommaFormat}
          disabled={disabled}
          data-testid={tid("comma")}
        />
        <IconButton
          {...TOP_TIP}
          icon={<RibbonIcon.DecimalIncrease size={ICON} />}
          label="Increase decimal"
          onClick={increaseDecimals}
          disabled={disabled}
          data-testid={tid("decimal-increase")}
        />
        <IconButton
          {...TOP_TIP}
          icon={<RibbonIcon.DecimalDecrease size={ICON} />}
          label="Decrease decimal"
          onClick={decreaseDecimals}
          disabled={disabled}
          data-testid={tid("decimal-decrease")}
        />
      </Segmented>
    </div>
  );
}
