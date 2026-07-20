//! FILENAME: app/extensions/BuiltIn/HomeTab/components/HomeTabGroupComponent.tsx
// PURPOSE: Reusable component that renders a set of Home tab items.
// CONTEXT: Hosted as a panel section (one per layout group: Clipboard, Font, etc.),
// so the same JSX renders in the ribbon band and the sidebar. Generic buttons use
// the @api/layout primitives; specialized widgets (color pickers, style gallery)
// keep their own popover implementations. State comes from useHomeTabState.

import React, { useState } from "react";
import { css } from "@emotion/css";
import { DialogExtensions } from "@api/ui";
import { ControlRow, Button, ToggleButton } from "@api/layout";
import type { RibbonContext } from "@api/extensions";
import { ITEMS_BY_ID } from "../homeTabConfig";
import { CellStylesGallery } from "../../../_shared/components/CellStylesGallery";
import { useHomeTabState } from "./useHomeTabState";

// ============================================================================
// Styles (color-picker trigger only — generic buttons use @api/layout)
// ============================================================================

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
  color: var(--text-primary, #333);
  font-family: inherit;
  gap: 0;

  &:hover:not(:disabled) {
    background: var(--button-hover-bg, rgba(0, 0, 0, 0.06));
  }

  &:active:not(:disabled) {
    background: var(--button-active-bg, rgba(0, 0, 0, 0.1));
  }
`;

// ============================================================================
// Color Dropdown (specialized popover widget — kept as-is)
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
  onMoreOptions,
}: {
  currentColor: string;
  onColorSelect: (color: string) => void;
  onClose: () => void;
  onMoreOptions?: () => void;
}) {
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
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
        background: var(--bg-surface, #fff);
        border: 1px solid var(--border-default, #c0c0c0);
        border-radius: 4px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      `}
    >
      <div className={css`display: grid; grid-template-columns: repeat(10, 1fr); gap: 2px; margin-bottom: 4px;`}>
        {QUICK_COLORS.map((color) => (
          <button
            key={color}
            title={color}
            onClick={() => { onColorSelect(color); onClose(); }}
            className={css`
              width: 16px; height: 16px; padding: 0;
              border: ${currentColor.toLowerCase() === color.toLowerCase() ? "2px solid var(--button-pressed-border, rgba(16, 185, 129, 0.45))" : "1px solid var(--border-default, #ccc)"};
              border-radius: 2px; background-color: ${color}; cursor: pointer;
              &:hover { border: 2px solid var(--text-primary, #333); transform: scale(1.15); }
            `}
          />
        ))}
      </div>
      <div className={css`display: flex; align-items: center; gap: 4px; padding-top: 4px; border-top: 1px solid var(--border-default, #e0e0e0);`}>
        <span className={css`font-size: 11px; color: var(--text-secondary, #666);`}>Custom:</span>
        <input
          type="color"
          value={currentColor}
          onChange={(e) => { onColorSelect(e.target.value); onClose(); }}
          className={css`width: 22px; height: 18px; padding: 0; border: 1px solid var(--border-default, #ccc); border-radius: 2px; cursor: pointer;`}
        />
      </div>
      {onMoreOptions && (
        <button
          onClick={() => { onClose(); onMoreOptions(); }}
          className={css`
            display: block; width: 100%; padding: 4px 0; margin-top: 4px;
            border: none; border-top: 1px solid var(--border-default, #e0e0e0); background: none;
            font-size: 11px; color: var(--accent-primary, #0078d4); cursor: pointer; text-align: center;
            &:hover { text-decoration: underline; }
          `}
        >
          More Fill Options...
        </button>
      )}
    </div>
  );
}

// ============================================================================
// Group Component
// ============================================================================

interface HomeTabGroupComponentProps {
  context: RibbonContext;
  itemIds: string[];
}

/**
 * Renders a set of Home tab items (buttons, toggles, color pickers).
 * Used by each registered ribbon group.
 */
export function HomeTabGroupComponent({ itemIds }: HomeTabGroupComponentProps): React.ReactElement {
  const state = useHomeTabState();
  const [openColorPicker, setOpenColorPicker] = useState<string | null>(null);
  const [cellStylesOpen, setCellStylesOpen] = useState(false);

  const renderItem = (itemId: string) => {
    const item = ITEMS_BY_ID.get(itemId);
    if (!item) return null;

    if (item.type === "color") {
      const color = state.getCurrentColor(item.id);
      return (
        <div key={item.id} style={{ position: "relative" }}>
          <button
            className={colorBtnStyle}
            title={item.tooltip}
            onClick={() => setOpenColorPicker(openColorPicker === item.id ? null : item.id)}
          >
            <span style={{
              fontWeight: item.id === "textColor" ? 700 : 400,
              fontSize: item.id === "textColor" ? "13px" : "11px",
              lineHeight: 1,
            }}>
              {item.icon}
            </span>
            <span style={{
              display: "block", width: "18px", height: "3px",
              backgroundColor: color, borderRadius: "1px", marginTop: "-1px",
            }} />
          </button>
          {openColorPicker === item.id && (
            <ColorDropdown
              currentColor={color}
              onColorSelect={(c) => state.handleColorSelect(item.id, c)}
              onClose={() => setOpenColorPicker(null)}
              onMoreOptions={item.id === "backgroundColor" ? () => {
                DialogExtensions.openDialog("format-cells", { tab: "fill" });
              } : undefined}
            />
          )}
        </div>
      );
    }

    if (item.id === "cellStyles") {
      return (
        <div key={item.id} style={{ position: "relative" }}>
          <Button
            title={item.tooltip}
            onClick={() => setCellStylesOpen(!cellStylesOpen)}
          >
            <span style={{ fontSize: "11px" }}>{item.icon}</span>
            <span style={{ fontSize: "10px", marginLeft: "3px" }}>{"\u25BC"}</span>
          </Button>
          {cellStylesOpen && (
            <CellStylesGallery
              onApplyStyle={state.handleCellStyleApply}
              onClose={() => setCellStylesOpen(false)}
            />
          )}
        </div>
      );
    }

    const itemStyle: React.CSSProperties | undefined =
      item.id === "bold" ? { fontWeight: 700 } :
      item.id === "italic" ? { fontStyle: "italic" } :
      item.id === "underline" ? { textDecoration: "underline" } :
      item.id === "strikethrough" ? { textDecoration: "line-through" } :
      undefined;

    if (item.type === "toggle") {
      const active = state.isActive(item.id);
      return (
        <ToggleButton
          key={item.id}
          active={active}
          title={item.tooltip}
          data-testid={`fmt-${item.id}`}
          data-active={active || undefined}
          onClick={() => state.handleItemClick(item)}
          style={itemStyle}
        >
          {item.icon}
        </ToggleButton>
      );
    }

    return (
      <Button
        key={item.id}
        title={item.tooltip}
        data-testid={`fmt-${item.id}`}
        onClick={() => state.handleItemClick(item)}
        style={itemStyle}
      >
        {item.icon}
      </Button>
    );
  };

  return (
    <ControlRow gap={3}>
      {itemIds.map((id) => renderItem(id))}
    </ControlRow>
  );
}
