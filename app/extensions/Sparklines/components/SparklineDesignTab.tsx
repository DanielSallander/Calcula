//! FILENAME: app/extensions/Sparklines/components/SparklineDesignTab.tsx
// PURPOSE: Ribbon "Sparkline" contextual tab for sparkline design options.
// CONTEXT: Appears in the ribbon when a sparkline cell is selected. Allows changing
//          sparkline type, toggling point markers, changing colors, editing data,
//          and managing groups. Matches Excel's Sparkline Design ribbon layout.

import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { css } from "@emotion/css";
import { useGridState, showDialog, emitAppEvent, AppEvents } from "@api";
import type { RibbonContext } from "@api/extensions";
import { getSparklineForCell, updateSparklineGroup, removeSparklineGroup, getAllGroups, groupSparklines as groupSparklinesFn, ungroupSparkline as ungroupSparklineFn } from "../store";
import type { SparklineGroup, SparklineType, EmptyCellHandling, AxisScaleType, PlotOrder } from "../types";
import { SparklineColorPicker } from "./SparklineColorPicker";
import { SPARKLINE_DIALOG_ID } from "../index";
import { useRibbonCollapse, RibbonGroup } from "@api/ribbonCollapse";

// ============================================================================
// Style presets (predefined color combos for the Style gallery)
// ============================================================================

const STYLE_PRESETS: Array<{ color: string; negativeColor: string; markerColor: string }> = [
  { color: "#4472C4", negativeColor: "#D94735", markerColor: "#4472C4" },
  { color: "#ED7D31", negativeColor: "#D94735", markerColor: "#ED7D31" },
  { color: "#A5A5A5", negativeColor: "#D94735", markerColor: "#A5A5A5" },
  { color: "#FFC000", negativeColor: "#D94735", markerColor: "#FFC000" },
  { color: "#5B9BD5", negativeColor: "#D94735", markerColor: "#5B9BD5" },
  { color: "#70AD47", negativeColor: "#D94735", markerColor: "#70AD47" },
  { color: "#264478", negativeColor: "#D94735", markerColor: "#264478" },
  { color: "#636363", negativeColor: "#D94735", markerColor: "#636363" },
];

// ============================================================================
// Styles
// ============================================================================

const tabStyles = {
  container: css`
    display: flex;
    gap: 0;
    align-items: stretch;
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
    gap: 6px;
    align-items: center;
    flex: 1;
  `,
  // -- Sparkline group --
  editDataButton: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 4px 10px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 3px;
    cursor: pointer;
    font-size: 11px;
    color: #333;
    white-space: nowrap;

    &:hover {
      background: #e8e8e8;
      border-color: #d0d0d0;
    }
  `,
  editDataIcon: css`
    font-size: 18px;
    line-height: 1;
  `,
  // -- Type group --
  typeButtonGroup: css`
    display: flex;
    gap: 2px;
  `,
  typeButton: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 4px 8px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 3px;
    cursor: pointer;
    font-size: 10px;
    color: #333;
    min-width: 50px;

    &:hover {
      background: #e8e8e8;
      border-color: #d0d0d0;
    }
  `,
  typeButtonActive: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 4px 8px;
    background: #d6e4f0;
    border: 1px solid #a0c0e0;
    border-radius: 3px;
    cursor: pointer;
    font-size: 10px;
    color: #1a1a1a;
    min-width: 50px;

    &:hover {
      background: #c0d8ec;
    }
  `,
  typeIcon: css`
    font-size: 20px;
    line-height: 1;
  `,
  // -- Show group --
  showGrid: css`
    display: grid;
    grid-template-columns: auto auto;
    gap: 1px 12px;
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
      margin: 0;
    }
  `,
  // -- Style group --
  styleContent: css`
    display: flex;
    gap: 8px;
    align-items: center;
  `,
  styleGallery: css`
    display: flex;
    gap: 2px;
    align-items: center;
    padding: 2px;
    border: 1px solid #e0e0e0;
    border-radius: 3px;
  `,
  stylePreset: css`
    width: 28px;
    height: 22px;
    border: 1px solid transparent;
    border-radius: 2px;
    cursor: pointer;
    padding: 2px;
    background: #fff;
    display: flex;
    align-items: center;
    justify-content: center;

    &:hover {
      border-color: #999;
      background: #f5f5f5;
    }
  `,
  stylePresetActive: css`
    width: 28px;
    height: 22px;
    border: 2px solid #005fb8;
    border-radius: 2px;
    cursor: pointer;
    padding: 1px;
    background: #e8f0fe;
    display: flex;
    align-items: center;
    justify-content: center;
  `,
  colorControls: css`
    display: flex;
    flex-direction: column;
    gap: 3px;
  `,
  // -- Group group (action buttons) --
  actionButtonGroup: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
  `,
  actionRow: css`
    display: flex;
    gap: 4px;
    align-items: center;
  `,
  actionButton: css`
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 3px;
    cursor: pointer;
    font-size: 11px;
    color: #333;
    white-space: nowrap;

    &:hover {
      background: #e8e8e8;
      border-color: #d0d0d0;
    }
  `,
  actionIcon: css`
    font-size: 14px;
    line-height: 1;
  `,
  clearButton: css`
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 3px;
    cursor: pointer;
    font-size: 11px;
    color: #c42b1c;
    white-space: nowrap;

    &:hover {
      background: #fce8e6;
      border-color: #f0c0b8;
    }
  `,
  // -- Axis group --
  axisGrid: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
  `,
  axisRow: css`
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    white-space: nowrap;
  `,
  selectSmall: css`
    font-size: 11px;
    padding: 1px 4px;
    border: 1px solid #ccc;
    border-radius: 3px;
    background: #fff;
    cursor: pointer;
    min-width: 70px;
  `,
  numberInput: css`
    font-size: 11px;
    padding: 1px 4px;
    border: 1px solid #ccc;
    border-radius: 3px;
    width: 50px;
  `,
};

// ============================================================================
// Collapse configuration
// ============================================================================

const GROUP_DEFS = [
  { collapseOrder: 1, expandedWidth: 100 },   // Sparkline
  { collapseOrder: 2, expandedWidth: 200 },   // Type
  { collapseOrder: 3, expandedWidth: 240 },   // Show
  { collapseOrder: 4, expandedWidth: 340 },   // Style
  { collapseOrder: 6, expandedWidth: 260 },   // Axis
  { collapseOrder: 5, expandedWidth: 160 },   // Group
];

// ============================================================================
// Mini sparkline preview for style gallery
// ============================================================================

function MiniSparklinePreview({ color }: { color: string }): React.ReactElement {
  // Draw a simple 5-point line preview
  const points = [3, 8, 2, 10, 5];
  const w = 24;
  const h = 16;
  const maxVal = 10;
  const coords = points.map((v, i) => {
    const x = (i / (points.length - 1)) * w;
    const y = h - (v / maxVal) * h;
    return `${x},${y}`;
  });
  const pathD = coords.map((c, i) => (i === 0 ? `M${c}` : `L${c}`)).join(" ");

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <path d={pathD} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

// ============================================================================
// Component
// ============================================================================

export function SparklineDesignTab({
  context: _context,
}: {
  context: RibbonContext;
}): React.ReactElement {
  const gridState = useGridState();
  const sel = gridState.selection;

  // Force re-render when sparkline properties change
  const [, forceUpdate] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const groupDefs = useMemo(() => GROUP_DEFS, []);
  const collapsed = useRibbonCollapse(containerRef, groupDefs);

  const entry = sel ? getSparklineForCell(sel.endRow, sel.endCol) : undefined;
  const group = entry?.group;

  // Re-read group on selection change
  useEffect(() => {
    forceUpdate((c) => c + 1);
  }, [sel?.endRow, sel?.endCol]);

  // Helper to update group and refresh
  const update = useCallback(
    (updates: Partial<SparklineGroup>) => {
      if (!group) return;
      updateSparklineGroup(group.id, updates);
      emitAppEvent(AppEvents.GRID_REFRESH);
      forceUpdate((c) => c + 1);
    },
    [group],
  );

  if (!group) {
    return (
      <div className={tabStyles.disabledMessage}>
        Select a sparkline cell to see design options
      </div>
    );
  }

  return (
    <div ref={containerRef} className={tabStyles.container}>
      {/* ================================================================ */}
      {/* Sparkline Group - Edit Data                                       */}
      {/* ================================================================ */}
      <RibbonGroup label="Sparkline" icon={"\u270E"} collapsed={collapsed[0]}>
        <div className={tabStyles.groupContent}>
          <button
            className={tabStyles.editDataButton}
            onClick={() => {
              showDialog(SPARKLINE_DIALOG_ID, {
                editGroupId: group.id,
                sparklineType: group.type,
              });
            }}
            title="Edit sparkline data and location ranges"
          >
            <span className={tabStyles.editDataIcon}>&#x270E;</span>
            Edit Data
          </button>
        </div>
      </RibbonGroup>

      {/* ================================================================ */}
      {/* Type Group - Line / Column / Win-Loss                             */}
      {/* ================================================================ */}
      <RibbonGroup label="Type" icon={"\u2500"} collapsed={collapsed[1]}>
        <div className={tabStyles.groupContent}>
          <div className={tabStyles.typeButtonGroup}>
            <button
              className={group.type === "line" ? tabStyles.typeButtonActive : tabStyles.typeButton}
              onClick={() => update({ type: "line" })}
              title="Line sparkline"
            >
              <span className={tabStyles.typeIcon}>&#x1F4C8;</span>
              Line
            </button>
            <button
              className={group.type === "column" ? tabStyles.typeButtonActive : tabStyles.typeButton}
              onClick={() => update({ type: "column" })}
              title="Column sparkline"
            >
              <span className={tabStyles.typeIcon}>&#x1F4CA;</span>
              Column
            </button>
            <button
              className={group.type === "winloss" ? tabStyles.typeButtonActive : tabStyles.typeButton}
              onClick={() => update({ type: "winloss" })}
              title="Win/Loss sparkline"
            >
              <span className={tabStyles.typeIcon}>&#x1F4CA;</span>
              Win/Loss
            </button>
          </div>
        </div>
      </RibbonGroup>

      {/* ================================================================ */}
      {/* Show Group - Point visibility checkboxes                          */}
      {/* ================================================================ */}
      <RibbonGroup label="Show" icon={"\u2611"} collapsed={collapsed[2]}>
        <div className={tabStyles.groupContent}>
          <div className={tabStyles.showGrid}>
            <label className={tabStyles.checkboxLabel}>
              <input
                type="checkbox"
                checked={group.showHighPoint}
                onChange={(e) => update({ showHighPoint: e.target.checked })}
              />
              High Point
            </label>
            <label className={tabStyles.checkboxLabel}>
              <input
                type="checkbox"
                checked={group.showFirstPoint}
                onChange={(e) => update({ showFirstPoint: e.target.checked })}
              />
              First Point
            </label>
            <label className={tabStyles.checkboxLabel}>
              <input
                type="checkbox"
                checked={group.showLowPoint}
                onChange={(e) => update({ showLowPoint: e.target.checked })}
              />
              Low Point
            </label>
            <label className={tabStyles.checkboxLabel}>
              <input
                type="checkbox"
                checked={group.showLastPoint}
                onChange={(e) => update({ showLastPoint: e.target.checked })}
              />
              Last Point
            </label>
            <label className={tabStyles.checkboxLabel}>
              <input
                type="checkbox"
                checked={group.showNegativePoints}
                onChange={(e) => update({ showNegativePoints: e.target.checked })}
              />
              Negative Points
            </label>
            <label className={tabStyles.checkboxLabel}>
              <input
                type="checkbox"
                checked={group.showMarkers}
                onChange={(e) => update({ showMarkers: e.target.checked })}
              />
              Markers
            </label>
          </div>
        </div>
      </RibbonGroup>

      {/* ================================================================ */}
      {/* Style Group - Gallery + Color pickers                             */}
      {/* ================================================================ */}
      <RibbonGroup label="Style" icon={"\u2728"} collapsed={collapsed[3]}>
        <div className={tabStyles.groupContent}>
          <div className={tabStyles.styleContent}>
            {/* Style presets gallery */}
            <div className={tabStyles.styleGallery}>
              {STYLE_PRESETS.map((preset, idx) => {
                const isActive =
                  group.color === preset.color &&
                  group.negativeColor === preset.negativeColor;
                return (
                  <button
                    key={idx}
                    className={isActive ? tabStyles.stylePresetActive : tabStyles.stylePreset}
                    onClick={() =>
                      update({
                        color: preset.color,
                        negativeColor: preset.negativeColor,
                        markerColor: preset.markerColor,
                      })
                    }
                    title={`Style ${idx + 1}`}
                  >
                    <MiniSparklinePreview color={preset.color} />
                  </button>
                );
              })}
            </div>

            {/* Color pickers */}
            <div className={tabStyles.colorControls}>
              <SparklineColorPicker
                label="Sparkline Color"
                value={group.color}
                onChange={(color) => update({ color })}
              />
              <SparklineColorPicker
                label="Marker Color"
                value={group.markerColor || group.color}
                onChange={(markerColor) => update({ markerColor })}
              />
            </div>
          </div>
        </div>
      </RibbonGroup>

      {/* ================================================================ */}
      {/* Axis Group - Axis line, scaling, empty cells, plot order           */}
      {/* ================================================================ */}
      <RibbonGroup label="Axis" icon={"\u2503"} collapsed={collapsed[4]}>
        <div className={tabStyles.groupContent}>
          <div className={tabStyles.axisGrid}>
            <label className={tabStyles.checkboxLabel}>
              <input
                type="checkbox"
                checked={group.showAxis}
                onChange={(e) => update({ showAxis: e.target.checked })}
              />
              Show Axis
            </label>

            <div className={tabStyles.axisRow}>
              <span>Scale:</span>
              <select
                className={tabStyles.selectSmall}
                value={group.axisScaleType}
                onChange={(e) => update({ axisScaleType: e.target.value as AxisScaleType })}
              >
                <option value="auto">Auto</option>
                <option value="sameForAll">Same for All</option>
                <option value="custom">Custom</option>
              </select>
            </div>

            {group.axisScaleType === "custom" && (
              <div className={tabStyles.axisRow}>
                <span>Min:</span>
                <input
                  type="number"
                  className={tabStyles.numberInput}
                  value={group.axisMinValue ?? ""}
                  onChange={(e) => update({ axisMinValue: e.target.value === "" ? null : parseFloat(e.target.value) })}
                  placeholder="Auto"
                />
                <span>Max:</span>
                <input
                  type="number"
                  className={tabStyles.numberInput}
                  value={group.axisMaxValue ?? ""}
                  onChange={(e) => update({ axisMaxValue: e.target.value === "" ? null : parseFloat(e.target.value) })}
                  placeholder="Auto"
                />
              </div>
            )}

            <div className={tabStyles.axisRow}>
              <span>Empty Cells:</span>
              <select
                className={tabStyles.selectSmall}
                value={group.emptyCellHandling}
                onChange={(e) => update({ emptyCellHandling: e.target.value as EmptyCellHandling })}
              >
                <option value="zero">Zero</option>
                <option value="gaps">Gaps</option>
                <option value="connect">Connect</option>
              </select>
            </div>

            <div className={tabStyles.axisRow}>
              <span>Plot Order:</span>
              <select
                className={tabStyles.selectSmall}
                value={group.plotOrder}
                onChange={(e) => update({ plotOrder: e.target.value as PlotOrder })}
              >
                <option value="default">Left to Right</option>
                <option value="rightToLeft">Right to Left</option>
              </select>
            </div>
          </div>
        </div>
      </RibbonGroup>

      {/* ================================================================ */}
      {/* Group Group - Group, Ungroup, Clear                               */}
      {/* ================================================================ */}
      <RibbonGroup label="Group" icon={"\u229E"} collapsed={collapsed[5]}>
        <div className={tabStyles.groupContent}>
          <div className={tabStyles.actionButtonGroup}>
            <div className={tabStyles.actionRow}>
              <button
                className={tabStyles.actionButton}
                onClick={() => {
                  if (!sel) return;
                  const result = groupSparklinesFn(sel.startRow, sel.startCol, sel.endRow, sel.endCol);
                  if (result) {
                    emitAppEvent(AppEvents.GRID_REFRESH);
                    forceUpdate((c) => c + 1);
                  }
                }}
                title="Group selected sparklines into one group"
              >
                <span className={tabStyles.actionIcon}>&#x229E;</span>
                Group
              </button>
              <button
                className={tabStyles.actionButton}
                onClick={() => {
                  const count = ungroupSparklineFn(group.id);
                  if (count > 0) {
                    emitAppEvent(AppEvents.GRID_REFRESH);
                    forceUpdate((c) => c + 1);
                  }
                }}
                title="Split sparkline group into individual sparklines"
              >
                <span className={tabStyles.actionIcon}>&#x229F;</span>
                Ungroup
              </button>
            </div>
            <div className={tabStyles.actionRow}>
              <button
                className={tabStyles.clearButton}
                onClick={() => {
                  removeSparklineGroup(group.id);
                  emitAppEvent(AppEvents.GRID_REFRESH);
                  forceUpdate((c) => c + 1);
                }}
                title="Clear selected sparklines"
              >
                <span className={tabStyles.actionIcon}>&#x2716;</span>
                Clear
              </button>
            </div>
          </div>
        </div>
      </RibbonGroup>
    </div>
  );
}

