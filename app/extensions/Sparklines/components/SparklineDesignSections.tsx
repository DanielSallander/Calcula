//! FILENAME: app/extensions/Sparklines/components/SparklineDesignSections.tsx
// PURPOSE: Panel sections for the contextual "Sparkline" design panel.
// CONTEXT: One section per former ribbon group (Sparkline / Type / Show /
//          Style / Axis / Group). Composed from @api/layout primitives so the
//          same JSX renders horizontally in the ribbon band and vertically in
//          the sidebar; the shell owns group chrome, labels and collapse.
//          Replaces the monolithic SparklineDesignTab (useRibbonCollapse +
//          RibbonGroup). Registered via SparklineDesignPanelDefinition in
//          manifest.ts and shown/hidden by handlers/selectionHandler.ts.

import React, { useCallback, useEffect, useState } from "react";
import { css } from "@emotion/css";
import type { PanelSectionProps } from "@api/uiTypes";
import type { Selection } from "@api";
import { useGridState } from "@api/state";
import { showDialog } from "@api/ui";
import { AppEvents, emitAppEvent, onAppEvent } from "@api/events";
import {
  ActionRow,
  Button,
  ControlRow,
  Field,
  Input,
  Stack,
  ToggleButton,
} from "@api/layout";
import {
  getSparklineForCell,
  updateSparklineGroup,
  removeSparklineGroup,
  groupSparklines as groupSparklinesFn,
  ungroupSparkline as ungroupSparklineFn,
} from "../store";
import type { SparklineGroup, AxisScaleType, EmptyCellHandling, PlotOrder } from "../types";
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
// Styles (only for content the layout primitives do not cover: checkbox
// labels, compact selects, and the style-preset swatch strip)
// ============================================================================

const styles = {
  disabledMessage: css`
    display: flex;
    align-items: center;
    height: 100%;
    color: var(--text-tertiary, #999);
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
    color: var(--text-primary, #333);

    input {
      cursor: pointer;
      margin: 0;
    }
  `,
  styleGallery: css`
    display: flex;
    gap: 2px;
    align-items: center;
    padding: 2px;
    border: 1px solid var(--border-default, #e0e0e0);
    border-radius: 3px;
  `,
  stylePreset: css`
    width: 28px;
    height: 22px;
    border: 1px solid transparent;
    border-radius: 2px;
    cursor: pointer;
    padding: 2px;
    background: transparent;
    display: flex;
    align-items: center;
    justify-content: center;

    &:hover {
      background: var(--button-hover-bg, rgba(0, 0, 0, 0.06));
    }
  `,
  stylePresetActive: css`
    width: 28px;
    height: 22px;
    border: 2px solid var(--button-pressed-border, rgba(16, 185, 129, 0.45));
    border-radius: 2px;
    cursor: pointer;
    padding: 1px;
    background: var(--button-pressed-bg, rgba(16, 185, 129, 0.14));
    display: flex;
    align-items: center;
    justify-content: center;
  `,
  selectSmall: css`
    font-size: 11px;
    padding: 1px 4px;
    border: 1px solid var(--border-default, #ccc);
    border-radius: 3px;
    background: var(--bg-surface, #fff);
    cursor: pointer;
    min-width: 70px;
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
// Shared section state — the old tab's { selection -> group, update } logic
// ============================================================================

interface SparklineDesignContext {
  sel: Selection | null;
  group: SparklineGroup | undefined;
  /** Apply updates to the selected group, repaint, and re-render. */
  update: (updates: Partial<SparklineGroup>) => void;
  /** Repaint the grid and re-render this section (after group/ungroup/clear). */
  refresh: () => void;
}

function useSparklineDesign(): SparklineDesignContext {
  const gridState = useGridState();
  const sel = gridState.selection;

  // Force re-render when sparkline properties change
  const [, forceUpdate] = useState(0);

  // Re-read group on selection change
  useEffect(() => {
    forceUpdate((c) => c + 1);
  }, [sel?.endRow, sel?.endCol]);

  // Sections render independently now: a mutation made in a sibling section
  // (type change, clear, ungroup, style preset) must re-render this one too.
  // Every mutation path emits GRID_REFRESH, so subscribe once per section —
  // this reproduces the former tab-level forceUpdate.
  useEffect(
    () => onAppEvent(AppEvents.GRID_REFRESH, () => forceUpdate((c) => c + 1)),
    [],
  );

  const entry = sel ? getSparklineForCell(sel.endRow, sel.endCol) : undefined;
  const group = entry?.group;

  const refresh = useCallback(() => {
    emitAppEvent(AppEvents.GRID_REFRESH);
    forceUpdate((c) => c + 1);
  }, []);

  const update = useCallback(
    (updates: Partial<SparklineGroup>) => {
      if (!group) return;
      updateSparklineGroup(group.id, updates);
      emitAppEvent(AppEvents.GRID_REFRESH);
      forceUpdate((c) => c + 1);
    },
    [group],
  );

  return { sel, group, update, refresh };
}

// ============================================================================
// Section: Sparkline — Edit Data
// ============================================================================

export function SparklineEditSection(_props: PanelSectionProps): React.ReactElement | null {
  const { group } = useSparklineDesign();

  if (!group) {
    // Only the first section carries the empty-state message; siblings render
    // nothing so it is not repeated across the band.
    return (
      <div className={styles.disabledMessage}>
        Select a sparkline cell to see design options
      </div>
    );
  }

  return (
    <ActionRow>
      <Button
        onClick={() => {
          showDialog(SPARKLINE_DIALOG_ID, {
            editGroupId: group.id,
            sparklineType: group.type,
          });
        }}
        title="Edit sparkline data and location ranges"
      >
        <span>&#x270E;</span>
        Edit Data
      </Button>
    </ActionRow>
  );
}

// ============================================================================
// Section: Type — Line / Column / Win-Loss
// ============================================================================

export function SparklineTypeSection(_props: PanelSectionProps): React.ReactElement | null {
  const { group, update } = useSparklineDesign();
  if (!group) return null;

  return (
    <ControlRow gap={2}>
      <ToggleButton
        active={group.type === "line"}
        onClick={() => update({ type: "line" })}
        title="Line sparkline"
      >
        <span>&#x1F4C8;</span>
        Line
      </ToggleButton>
      <ToggleButton
        active={group.type === "column"}
        onClick={() => update({ type: "column" })}
        title="Column sparkline"
      >
        <span>&#x1F4CA;</span>
        Column
      </ToggleButton>
      <ToggleButton
        active={group.type === "winloss"}
        onClick={() => update({ type: "winloss" })}
        title="Win/Loss sparkline"
      >
        <span>&#x1F4CA;</span>
        Win/Loss
      </ToggleButton>
    </ControlRow>
  );
}

// ============================================================================
// Section: Show — Point visibility checkboxes
// ============================================================================

export function SparklineShowSection(_props: PanelSectionProps): React.ReactElement | null {
  const { group, update } = useSparklineDesign();
  if (!group) return null;

  return (
    <Stack gap={1}>
      <label className={styles.checkboxLabel}>
        <input
          type="checkbox"
          checked={group.showHighPoint}
          onChange={(e) => update({ showHighPoint: e.target.checked })}
        />
        High Point
      </label>
      <label className={styles.checkboxLabel}>
        <input
          type="checkbox"
          checked={group.showFirstPoint}
          onChange={(e) => update({ showFirstPoint: e.target.checked })}
        />
        First Point
      </label>
      <label className={styles.checkboxLabel}>
        <input
          type="checkbox"
          checked={group.showLowPoint}
          onChange={(e) => update({ showLowPoint: e.target.checked })}
        />
        Low Point
      </label>
      <label className={styles.checkboxLabel}>
        <input
          type="checkbox"
          checked={group.showLastPoint}
          onChange={(e) => update({ showLastPoint: e.target.checked })}
        />
        Last Point
      </label>
      <label className={styles.checkboxLabel}>
        <input
          type="checkbox"
          checked={group.showNegativePoints}
          onChange={(e) => update({ showNegativePoints: e.target.checked })}
        />
        Negative Points
      </label>
      <label className={styles.checkboxLabel}>
        <input
          type="checkbox"
          checked={group.showMarkers}
          onChange={(e) => update({ showMarkers: e.target.checked })}
        />
        Markers
      </label>
    </Stack>
  );
}

// ============================================================================
// Section: Style — preset gallery + color pickers (band-designed widgets,
// hosted as-is; the section is declared "inline" in the manifest)
// ============================================================================

export function SparklineStyleSection(_props: PanelSectionProps): React.ReactElement | null {
  const { group, update } = useSparklineDesign();
  if (!group) return null;

  return (
    <ControlRow gap={8}>
      {/* Style presets gallery */}
      <div className={styles.styleGallery}>
        {STYLE_PRESETS.map((preset, idx) => {
          const isActive =
            group.color === preset.color &&
            group.negativeColor === preset.negativeColor;
          return (
            <button
              key={idx}
              className={isActive ? styles.stylePresetActive : styles.stylePreset}
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
      <Stack gap={3}>
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
      </Stack>
    </ControlRow>
  );
}

// ============================================================================
// Section: Axis — axis line, scaling, empty cells, plot order
// ============================================================================

export function SparklineAxisSection(_props: PanelSectionProps): React.ReactElement | null {
  const { group, update } = useSparklineDesign();
  if (!group) return null;

  return (
    <Stack gap={2}>
      <label className={styles.checkboxLabel}>
        <input
          type="checkbox"
          checked={group.showAxis}
          onChange={(e) => update({ showAxis: e.target.checked })}
        />
        Show Axis
      </label>

      <Field label="Scale:">
        <select
          className={styles.selectSmall}
          value={group.axisScaleType}
          onChange={(e) => update({ axisScaleType: e.target.value as AxisScaleType })}
        >
          <option value="auto">Auto</option>
          <option value="sameForAll">Same for All</option>
          <option value="custom">Custom</option>
        </select>
      </Field>

      {group.axisScaleType === "custom" && (
        <ControlRow gap={6}>
          <Field label="Min:">
            <Input
              type="number"
              width={56}
              value={group.axisMinValue ?? ""}
              onChange={(e) => update({ axisMinValue: e.target.value === "" ? null : parseFloat(e.target.value) })}
              placeholder="Auto"
            />
          </Field>
          <Field label="Max:">
            <Input
              type="number"
              width={56}
              value={group.axisMaxValue ?? ""}
              onChange={(e) => update({ axisMaxValue: e.target.value === "" ? null : parseFloat(e.target.value) })}
              placeholder="Auto"
            />
          </Field>
        </ControlRow>
      )}

      <Field label="Empty Cells:">
        <select
          className={styles.selectSmall}
          value={group.emptyCellHandling}
          onChange={(e) => update({ emptyCellHandling: e.target.value as EmptyCellHandling })}
        >
          <option value="zero">Zero</option>
          <option value="gaps">Gaps</option>
          <option value="connect">Connect</option>
        </select>
      </Field>

      <Field label="Plot Order:">
        <select
          className={styles.selectSmall}
          value={group.plotOrder}
          onChange={(e) => update({ plotOrder: e.target.value as PlotOrder })}
        >
          <option value="default">Left to Right</option>
          <option value="rightToLeft">Right to Left</option>
        </select>
      </Field>
    </Stack>
  );
}

// ============================================================================
// Section: Group — group, ungroup, clear
// ============================================================================

export function SparklineGroupSection(_props: PanelSectionProps): React.ReactElement | null {
  const { sel, group, refresh } = useSparklineDesign();
  if (!group) return null;

  return (
    <Stack gap={2}>
      <ActionRow gap={4}>
        <Button
          size="sm"
          onClick={() => {
            if (!sel) return;
            const result = groupSparklinesFn(sel.startRow, sel.startCol, sel.endRow, sel.endCol);
            if (result) {
              refresh();
            }
          }}
          title="Group selected sparklines into one group"
        >
          <span>&#x229E;</span>
          Group
        </Button>
        <Button
          size="sm"
          onClick={() => {
            const count = ungroupSparklineFn(group.id);
            if (count > 0) {
              refresh();
            }
          }}
          title="Split sparkline group into individual sparklines"
        >
          <span>&#x229F;</span>
          Ungroup
        </Button>
      </ActionRow>
      <ActionRow gap={4}>
        <Button
          size="sm"
          style={{ color: "#c42b1c" }}
          onClick={() => {
            removeSparklineGroup(group.id);
            refresh();
          }}
          title="Clear selected sparklines"
        >
          <span>&#x2716;</span>
          Clear
        </Button>
      </ActionRow>
    </Stack>
  );
}
