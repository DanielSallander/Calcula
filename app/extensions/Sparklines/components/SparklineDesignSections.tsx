//! FILENAME: app/extensions/Sparklines/components/SparklineDesignSections.tsx
// PURPOSE: Panel sections for the contextual "Sparkline" design panel.
// CONTEXT: One section per former ribbon group (Sparkline / Type / Show /
//          Style / Axis / Group). Composed from @api/layout primitives so the
//          same JSX renders horizontally in the ribbon band and vertically in
//          the sidebar; the shell owns group chrome, labels and collapse.
//          Registered via SparklineDesignPanelDefinition in manifest.ts and
//          shown/hidden by handlers/selectionHandler.ts.
//
//          THE FILL RULE (@api/layout tokens): in the band every section fills
//          the cluster's 61px content box one of two ways —
//            Sparkline  one tall row: the "Edit Data" hero
//            Type       one tall row: a 61px Line | Column | Win/Loss pill
//            Show       two rows: three columns of two checkboxes
//            Style      two rows: the preset strip over the two colour pickers
//            Axis       two rows: columns of two (axis + scale, min + max,
//                       empty cells + plot order)
//            Group      two rows: Group + Ungroup over Clear
//          Two-row sections that pair controls into COLUMNS use BandColumns
//          below rather than Stack's column-wrap: the columns are explicit, so
//          the section's max-content width (what the shell measures) is the
//          sum of the columns on every engine.
//
//          The eight Style presets and the picker colours are categorical DATA
//          and live in ../lib/sparklineColors.ts; everything here paints with
//          LT tokens.

import React, { useCallback, useEffect, useId, useState } from "react";
import { css } from "@emotion/css";
import type { PanelSectionProps } from "@api/uiTypes";
import type { Selection } from "@api";
import { RibbonIcon } from "@api/ribbonIcons";
import { useGridState } from "@api/state";
import { showDialog } from "@api/ui";
import { AppEvents, emitAppEvent, onAppEvent } from "@api/events";
import { refuseIfSelectionOwned } from "@api/selectionOwner";
import {
  Button,
  Checkbox,
  CommandButton,
  ControlGrid,
  ControlGridBreak,
  ControlRow,
  Dropdown,
  Field,
  FONT_FAMILY,
  GAP_SM,
  HERO_ICON_SIZE,
  ICON_SIZE_SM,
  LT,
  NumberField,
  PaletteStrip,
  ROW_GAP,
  SegmentedChoice,
  Stack,
  useSurfaceLayout,
  type DropdownOption,
  type PaletteOption,
  type SegmentedChoiceOption,
} from "@api/layout";
import {
  getSparklineForCell,
  updateSparklineGroup,
  removeSparklineGroup,
  groupSparklines as groupSparklinesFn,
  ungroupSparkline as ungroupSparklineFn,
} from "../store";
import type {
  SparklineGroup,
  SparklineType,
  AxisScaleType,
  EmptyCellHandling,
  PlotOrder,
} from "../types";
import { SPARKLINE_STYLE_PRESETS, presetColors } from "../lib/sparklineColors";
import { SparklineColorPicker } from "./SparklineColorPicker";
import { SPARKLINE_DIALOG_ID } from "../index";

// ============================================================================
// Option data
// ============================================================================

/** The Style strip's palettes: each preset shown as its own colours. */
const STYLE_PALETTES: readonly PaletteOption[] = SPARKLINE_STYLE_PRESETS.map((preset) => ({
  id: preset.id,
  name: preset.name,
  colors: presetColors(preset),
}));

const SCALE_OPTIONS: ReadonlyArray<DropdownOption<AxisScaleType>> = [
  { value: "auto", label: "Auto" },
  { value: "sameForAll", label: "Same for All" },
  { value: "custom", label: "Custom" },
];

const EMPTY_CELL_OPTIONS: ReadonlyArray<DropdownOption<EmptyCellHandling>> = [
  { value: "zero", label: "Zero" },
  { value: "gaps", label: "Gaps" },
  { value: "connect", label: "Connect" },
];

const PLOT_ORDER_OPTIONS: ReadonlyArray<DropdownOption<PlotOrder>> = [
  { value: "default", label: "Left to Right" },
  { value: "rightToLeft", label: "Right to Left" },
];

// ============================================================================
// Styles (only what no layout primitive covers: the empty-state message)
// ============================================================================

const emptyState = css`
  display: flex;
  align-items: center;
  height: 100%;
  color: ${LT.textTertiary};
  font-family: ${FONT_FAMILY};
  font-style: italic;
  font-size: 12px;
  white-space: nowrap;
`;

// ============================================================================
// BandColumns — controls paired into columns in the band, a list in a panel
// ============================================================================

/**
 * In the ribbon band: one column per entry, each a ROW_GAP stack of (at most)
 * two 28px controls — the fill rule's 28 + 5 + 28. In a panel or flyout: the
 * same controls in reading order as one vertical list.
 */
function BandColumns({ columns }: { columns: React.ReactNode[][] }): React.ReactElement {
  const layout = useSurfaceLayout();

  if (layout.container === "band") {
    return (
      <ControlRow gap={GAP_SM * 2}>
        {columns.map((column, c) => (
          <Stack key={c} gap={ROW_GAP}>
            {column.map((control, r) => (
              <React.Fragment key={r}>{control}</React.Fragment>
            ))}
          </Stack>
        ))}
      </ControlRow>
    );
  }

  return (
    <Stack gap={GAP_SM}>
      {columns.flatMap((column, c) =>
        column.map((control, r) => <React.Fragment key={`${c}-${r}`}>{control}</React.Fragment>),
      )}
    </Stack>
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
  // A context read: a selection change re-renders the section, and the group
  // below is looked up during render, so it always follows the selection.
  const gridState = useGridState();
  const sel = gridState.selection;

  // Force re-render when sparkline properties change (the store is not React
  // state, so a write re-renders nothing by itself).
  const [, forceUpdate] = useState(0);

  // Sections render independently: a mutation made in a sibling section
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

/** Icon size for a control that is 61px tall in the band and 28px elsewhere. */
function useTallIconSize(): number {
  return useSurfaceLayout().container === "band" ? 28 : ICON_SIZE_SM;
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
      <div className={emptyState} data-testid="sparkline-design-empty">
        Select a sparkline cell to see design options
      </div>
    );
  }

  return (
    <CommandButton
      icon={<RibbonIcon.Pencil size={HERO_ICON_SIZE} />}
      label="Edit Data"
      tooltip="Edit sparkline data and location ranges"
      data-testid="sparkline-edit-data"
      onClick={() => {
        showDialog(SPARKLINE_DIALOG_ID, {
          editGroupId: group.id,
          sparklineType: group.type,
        });
      }}
    />
  );
}

// ============================================================================
// Section: Type — Line / Column / Win-Loss
// ============================================================================

export function SparklineTypeSection(_props: PanelSectionProps): React.ReactElement | null {
  const { group, update } = useSparklineDesign();
  const band = useSurfaceLayout().container === "band";
  const iconSize = useTallIconSize();
  if (!group) return null;

  const options: ReadonlyArray<SegmentedChoiceOption<SparklineType>> = [
    {
      value: "line",
      label: "Line",
      icon: <RibbonIcon.SparkLine size={iconSize} />,
      tooltip: "Line sparkline",
      testId: "sparkline-type-line",
    },
    {
      value: "column",
      label: "Column",
      icon: <RibbonIcon.SparkColumn size={iconSize} />,
      tooltip: "Column sparkline",
      testId: "sparkline-type-column",
    },
    {
      value: "winloss",
      label: "Win/Loss",
      icon: <RibbonIcon.SparkWinLoss size={iconSize} />,
      tooltip: "Win/Loss sparkline",
      testId: "sparkline-type-winloss",
    },
  ];

  return (
    <SegmentedChoice<SparklineType>
      ariaLabel="Sparkline type"
      size={band ? "tall" : "md"}
      value={group.type}
      options={options}
      onChange={(type) => update({ type })}
      testId="sparkline-type"
    />
  );
}

// ============================================================================
// Section: Show — Point visibility checkboxes
// ============================================================================

export function SparklineShowSection(_props: PanelSectionProps): React.ReactElement | null {
  const { group, update } = useSparklineDesign();
  if (!group) return null;

  // Excel's pairing: the extremes, the ends, then negatives and markers.
  return (
    <BandColumns
      columns={[
        [
          <Checkbox
            label="High Point"
            checked={group.showHighPoint}
            onChange={(showHighPoint) => update({ showHighPoint })}
            testId="sparkline-show-high"
          />,
          <Checkbox
            label="Low Point"
            checked={group.showLowPoint}
            onChange={(showLowPoint) => update({ showLowPoint })}
            testId="sparkline-show-low"
          />,
        ],
        [
          <Checkbox
            label="First Point"
            checked={group.showFirstPoint}
            onChange={(showFirstPoint) => update({ showFirstPoint })}
            testId="sparkline-show-first"
          />,
          <Checkbox
            label="Last Point"
            checked={group.showLastPoint}
            onChange={(showLastPoint) => update({ showLastPoint })}
            testId="sparkline-show-last"
          />,
        ],
        [
          <Checkbox
            label="Negative Points"
            checked={group.showNegativePoints}
            onChange={(showNegativePoints) => update({ showNegativePoints })}
            testId="sparkline-show-negative"
          />,
          <Checkbox
            label="Markers"
            checked={group.showMarkers}
            onChange={(showMarkers) => update({ showMarkers })}
            testId="sparkline-show-markers"
          />,
        ],
      ]}
    />
  );
}

// ============================================================================
// Section: Style — preset strip + colour pickers (two rows)
// ============================================================================

export function SparklineStyleSection(_props: PanelSectionProps): React.ReactElement | null {
  const { group, update } = useSparklineDesign();
  if (!group) return null;

  // Exact match on the two colours a preset sets, as the old strip did.
  const active = SPARKLINE_STYLE_PRESETS.find(
    (preset) => group.color === preset.color && group.negativeColor === preset.negativeColor,
  );

  return (
    <Stack gap={ROW_GAP}>
      <PaletteStrip
        palettes={STYLE_PALETTES}
        value={active?.id ?? ""}
        ariaLabel="Sparkline style"
        moreLabel="More styles"
        popoverHeading="Sparkline styles"
        testIdPrefix="sparkline-style"
        onChange={(id) => {
          const preset = SPARKLINE_STYLE_PRESETS.find((p) => p.id === id);
          if (!preset) return;
          update({
            color: preset.color,
            negativeColor: preset.negativeColor,
            markerColor: preset.markerColor,
          });
        }}
      />
      <ControlRow gap={GAP_SM * 2}>
        <SparklineColorPicker
          label="Sparkline Color"
          value={group.color}
          onChange={(color) => update({ color })}
          testId="sparkline-color"
        />
        <SparklineColorPicker
          label="Marker Color"
          value={group.markerColor || group.color}
          onChange={(markerColor) => update({ markerColor })}
          testId="sparkline-marker-color"
        />
      </ControlRow>
    </Stack>
  );
}

// ============================================================================
// Section: Axis — axis line, scaling, empty cells, plot order
// ============================================================================

export function SparklineAxisSection(_props: PanelSectionProps): React.ReactElement | null {
  const { group, update } = useSparklineDesign();
  const minId = useId();
  const maxId = useId();
  if (!group) return null;

  const columns: React.ReactNode[][] = [
    [
      <Checkbox
        label="Show Axis"
        checked={group.showAxis}
        onChange={(showAxis) => update({ showAxis })}
        testId="sparkline-axis-show"
      />,
      <Field label="Scale">
        <Dropdown<AxisScaleType>
          ariaLabel="Axis scale"
          value={group.axisScaleType}
          options={SCALE_OPTIONS}
          onChange={(axisScaleType) => update({ axisScaleType })}
          testId="sparkline-axis-scale"
          optionTestIdPrefix="sparkline-axis-scale-"
        />
      </Field>,
    ],
  ];

  if (group.axisScaleType === "custom") {
    columns.push([
      <Field label="Min" htmlFor={minId}>
        <NumberField
          id={minId}
          width={56}
          blankMeans="auto"
          value={group.axisMinValue ?? null}
          onChange={(axisMinValue) => update({ axisMinValue })}
          testId="sparkline-axis-min"
        />
      </Field>,
      <Field label="Max" htmlFor={maxId}>
        <NumberField
          id={maxId}
          width={56}
          blankMeans="auto"
          value={group.axisMaxValue ?? null}
          onChange={(axisMaxValue) => update({ axisMaxValue })}
          testId="sparkline-axis-max"
        />
      </Field>,
    ]);
  }

  columns.push([
    <Field label="Empty Cells">
      <Dropdown<EmptyCellHandling>
        ariaLabel="Empty cells"
        value={group.emptyCellHandling}
        options={EMPTY_CELL_OPTIONS}
        onChange={(emptyCellHandling) => update({ emptyCellHandling })}
        testId="sparkline-axis-empty-cells"
        optionTestIdPrefix="sparkline-axis-empty-cells-"
      />
    </Field>,
    <Field label="Plot Order">
      <Dropdown<PlotOrder>
        ariaLabel="Plot order"
        value={group.plotOrder}
        options={PLOT_ORDER_OPTIONS}
        onChange={(plotOrder) => update({ plotOrder })}
        testId="sparkline-axis-plot-order"
        optionTestIdPrefix="sparkline-axis-plot-order-"
      />
    </Field>,
  ]);

  return <BandColumns columns={columns} />;
}

// ============================================================================
// Section: Group — group, ungroup, clear
// ============================================================================

export function SparklineGroupSection(_props: PanelSectionProps): React.ReactElement | null {
  const { sel, group, refresh } = useSparklineDesign();
  if (!group) return null;

  return (
    <ControlGrid>
      <Button
        icon={<RibbonIcon.Group size={ICON_SIZE_SM} />}
        tooltip="Group selected sparklines into one group"
        data-testid="sparkline-group"
        onClick={() => {
          if (!sel) return;
          // Group reads its RANGE from Core's selection -- hidden while
          // something else owns the selection (a floating grid's selected
          // cell), since this tab follows Core's selection alone -- so it
          // refuses, once (BUG-0185 class). Ungroup and Clear act on the group
          // the tab shows, as Table Design's actions act on the table it names.
          if (refuseIfSelectionOwned("Group Sparklines")) return;
          const result = groupSparklinesFn(sel.startRow, sel.startCol, sel.endRow, sel.endCol);
          if (result) {
            refresh();
          }
        }}
      >
        Group
      </Button>
      <Button
        icon={<RibbonIcon.Layout size={ICON_SIZE_SM} />}
        tooltip="Split sparkline group into individual sparklines"
        data-testid="sparkline-ungroup"
        onClick={() => {
          const count = ungroupSparklineFn(group.id);
          if (count > 0) {
            refresh();
          }
        }}
      >
        Ungroup
      </Button>
      <ControlGridBreak />
      <Button
        tone="danger"
        icon={<RibbonIcon.Delete size={ICON_SIZE_SM} />}
        tooltip="Clear selected sparklines"
        data-testid="sparkline-clear"
        onClick={() => {
          removeSparklineGroup(group.id);
          refresh();
        }}
      >
        Clear
      </Button>
    </ControlGrid>
  );
}
