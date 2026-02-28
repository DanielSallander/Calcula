//! FILENAME: app/extensions/Sparklines/components/SparklineDesignTab.tsx
// PURPOSE: Ribbon "Sparkline" contextual tab for sparkline design options.
// CONTEXT: Appears in the ribbon when a sparkline cell is selected. Allows changing
//          sparkline type, toggling point markers, changing colors, editing data,
//          and managing groups. Matches Excel's Sparkline Design ribbon layout.

import React, { useState, useEffect, useCallback } from "react";
import { css } from "@emotion/css";
import { useGridState, showDialog, emitAppEvent, AppEvents } from "../../../src/api";
import type { RibbonContext } from "../../../src/api/extensions";
import { getSparklineForCell, updateSparklineGroup, removeSparklineGroup, getAllGroups } from "../store";
import type { SparklineGroup, SparklineType } from "../types";
import { SparklineColorPicker } from "./SparklineColorPicker";
import { SPARKLINE_DIALOG_ID } from "../index";

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
  group: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 2px 12px;
    border-right: 1px solid #e0e0e0;

    &:last-child {
      border-right: none;
    }
  `,
  groupLabel: css`
    font-size: 10px;
    color: #666;
    text-align: center;
    margin-top: auto;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    padding-top: 2px;
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
};

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
    <div className={tabStyles.container}>
      {/* ================================================================ */}
      {/* Sparkline Group - Edit Data                                       */}
      {/* ================================================================ */}
      <div className={tabStyles.group}>
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
        <div className={tabStyles.groupLabel}>Sparkline</div>
      </div>

      {/* ================================================================ */}
      {/* Type Group - Line / Column / Win-Loss                             */}
      {/* ================================================================ */}
      <div className={tabStyles.group}>
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
        <div className={tabStyles.groupLabel}>Type</div>
      </div>

      {/* ================================================================ */}
      {/* Show Group - Point visibility checkboxes                          */}
      {/* ================================================================ */}
      <div className={tabStyles.group}>
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
        <div className={tabStyles.groupLabel}>Show</div>
      </div>

      {/* ================================================================ */}
      {/* Style Group - Gallery + Color pickers                             */}
      {/* ================================================================ */}
      <div className={tabStyles.group}>
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
        <div className={tabStyles.groupLabel}>Style</div>
      </div>

      {/* ================================================================ */}
      {/* Group Group - Group, Ungroup, Clear, Axis                         */}
      {/* ================================================================ */}
      <div className={tabStyles.group}>
        <div className={tabStyles.groupContent}>
          <div className={tabStyles.actionButtonGroup}>
            <div className={tabStyles.actionRow}>
              <button
                className={tabStyles.actionButton}
                onClick={() => groupSparklines(group)}
                title="Group sparklines"
              >
                <span className={tabStyles.actionIcon}>&#x229E;</span>
                Group
              </button>
              <button
                className={tabStyles.actionButton}
                onClick={() => ungroupSparkline(group)}
                title="Ungroup sparklines"
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
        <div className={tabStyles.groupLabel}>Group</div>
      </div>
    </div>
  );
}

// ============================================================================
// Group / Ungroup helpers (future expansion)
// ============================================================================

function groupSparklines(group: SparklineGroup): void {
  // Future: merge adjacent single-cell sparkline groups into one multi-cell group
  console.log("[Sparklines] Group not yet implemented for group:", group.id);
}

function ungroupSparkline(group: SparklineGroup): void {
  // Future: split a multi-cell sparkline group into individual single-cell groups
  console.log("[Sparklines] Ungroup not yet implemented for group:", group.id);
}
