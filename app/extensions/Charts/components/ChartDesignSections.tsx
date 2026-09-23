//! FILENAME: app/extensions/Charts/components/ChartDesignSections.tsx
// PURPOSE: The contextual "Chart Design" panel — six clusters built from the
//          @api/layout control grammar: Type, Elements, Layout, Style, Data,
//          Actions.
// CONTEXT: This was fourteen sections of hand-rolled chrome: 42px buttons with
//          20x16 icons painted in Office colours, seven native <select>s, a
//          checkbox grid, unicode glyph icons and a `position: fixed` JSON
//          overlay. It is now the Calcula Clusters layout from the approved
//          plan ("The Chart Design tab — 14 sections -> 6 clusters"):
//
//            Type      one tall row: six 44x61 type tiles + a More tile that
//                      opens every type as a gallery
//            Elements  one tall pill of icon-only toggles; Title / Legend /
//                      Data labels are split, their chevron half opening the
//                      options (title text, legend position, label position
//                      and size) that used to be three more sections
//            Layout    (axis charts only) the stacking pill + a "Bars" /
//                      "Line" / "Area" hero whose card holds the mark sliders;
//                      a combo chart gets the "2nd axis" switch
//            Style     two rows: the palette strip, then "Series" (per-series
//                      colour, the preserved SeriesColorsSection)
//            Data      two rows (Filter + its "N of M" chip, Trendline + its
//                      chip) beside the "Switch" row/column hero
//            Actions   heroes: Edit Chart, Save Image, Format Point (when a
//                      data point is selected), JSON (opens the chart-json
//                      task pane)
//
//          THE FILL RULE. Every cluster's band content is either one tall row
//          of 61px or two 28px rows with a 5px gap — never one short row
//          alone. That is why a control that does not apply to the current
//          mark is sometimes DISABLED rather than removed (the stacking pill on
//          a scatter chart, the Series button on a pie): removing it would
//          leave a cluster that is one short row floating in a tall card.
//
//          ONLY LAYOUT IS CONDITIONAL. The section list changes only on an
//          axis-chart <-> radial-chart flip, so handlers/selectionHandler.ts
//          re-registers the panel only then; every other type switch re-renders
//          the same six components in place (no remount flash).
//
//          AUTHORITY: the band configures the WHOLE chart. Axis titles and
//          bounds left it for the Format pane (ChartFormatPane's AxisSections
//          edits the title on the Text tab and min/max on the Axis tab), which
//          formats the current selection.
//
//          Imports from "@api" are limited to the event/dialog helpers; the
//          icon set, task-pane calls and layout primitives come from their
//          @api/* modules.

import React, { useState, useEffect, useCallback, useReducer, useRef } from "react";
import { css } from "@emotion/css";
import { emitAppEvent, onAppEvent, AppEvents, showDialog } from "@api";
import { openTaskPane, closeTaskPane, useTaskPaneOpenPaneIds, useIsTaskPaneOpen } from "@api/ui";
import { RibbonIcon, type RibbonIconKey } from "@api/ribbonIcons";
import type { PanelSection, PanelSectionProps } from "@api/uiTypes";
import {
  useSurfaceLayout,
  SurfaceLayoutProvider,
  popoverLayout,
  Button,
  IconButton,
  CommandButton,
  DropdownChevron,
  Segmented,
  SegmentedChoice,
  Popover,
  Menu,
  MenuButton,
  MenuItem,
  MenuSeparator,
  Dropdown,
  Checkbox,
  Switch,
  Chip,
  Slider,
  Input,
  ColorSwatch,
  Tile,
  TileGallery,
  PaletteStrip,
  StatusText,
  normalizeHex,
  LT,
  FONT_FAMILY,
  GAP_XS,
  GAP_SM,
  ROW_GAP,
  CONTROL_HEIGHT_MD,
  TALL_CONTROL_HEIGHT,
  ICON_SIZE_SM,
  ICON_SIZE_MD,
  HERO_ICON_SIZE,
} from "@api/layout";
import { alertAsync } from "@api/dialogs";

import type {
  ChartType,
  ChartSpec,
  ChartFilters,
  StackMode,
  BarMarkOptions,
  LineMarkOptions,
  AreaMarkOptions,
  TrendlineSpec,
  TrendlineType,
  ComboMarkOptions,
  DataLabelSpec,
  DataLabelPosition,
  LineInterpolation,
  SeriesOrientation,
} from "../types";
import { isPivotDataSource, isCartesianChart } from "../types";
import { ChartFilterDropdown, summarizeChartFilters } from "./ChartFilterDropdown";
import { CHART_JSON_PANE_ID } from "./ChartJsonPane";
import {
  CHART_TYPES,
  QUICK_CHART_TYPES,
  chartTypeEntry,
  chartTypeName,
} from "./chartTypeCatalog";
import { getChartById, updateChartSpec, syncChartRegions } from "../lib/chartStore";
import { invalidateChartCache, getCachedChartData } from "../rendering/chartRenderer";
import { getCurrentChartId, getSubSelection } from "../handlers/selectionHandler";
import { toAuthoringIndices } from "../lib/dataPointOverrides";
import { ChartEvents } from "../lib/chartEvents";
import { PALETTES, PALETTE_NAMES, getSeriesColor } from "../rendering/chartTheme";
import { CHART_DESIGN_TAB_ID, CHART_DIALOG_ID } from "../manifest";
import { exportChartAsImage } from "../lib/chartExport";
import {
  autoDetectSeriesForOrientation,
  readSeriesColor,
  seriesColorPatch,
} from "../lib/chartDataReader";
import { resolveDataSource } from "../lib/dataSourceResolver";
import { getStackModeFromSpec, setStackModeInOptions, supportsStacking } from "../lib/stackMode";

// ============================================================================
// Layout (tokens only — the band's geometry is the fill rule)
// ============================================================================

/** One tall row: fills the 61px content box. */
const bandRow = css`
  display: inline-flex;
  align-items: center;
  gap: ${GAP_XS}px;
  box-sizing: border-box;
  height: ${TALL_CONTROL_HEIGHT}px;
`;

/** Two rows, 28 + 5 + 28 = 61. */
const bandColumn = css`
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: ${ROW_GAP}px;
  box-sizing: border-box;
  height: ${TALL_CONTROL_HEIGHT}px;
`;

/** One 28px row inside a two-row column. */
const bandLine = css`
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  gap: ${GAP_XS}px;
  height: ${CONTROL_HEIGHT_MD}px;
`;

/** Data: the two-row column beside its hero. */
const bandPair = css`
  display: inline-flex;
  align-items: center;
  gap: ${GAP_SM}px;
  height: ${TALL_CONTROL_HEIGHT}px;
`;

/** Sidebar / flyout: rows stack and wrap. */
const panelStack = css`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: ${GAP_SM}px;
  min-width: 0;
`;

const panelLine = css`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: ${GAP_XS}px;
  min-width: 0;
`;

/** The inside of every card popover this panel opens. */
const cardBody = css`
  display: flex;
  flex-direction: column;
  gap: ${GAP_SM}px;
  min-width: 220px;
  font-family: ${FONT_FAMILY};
  color: ${LT.text};
`;

/** Slider rows in a card share a label column so the tracks line up. */
const sliderAligned = css`
  & > label {
    min-width: 52px;
  }
`;

const chevronSlot = css`
  display: inline-flex;
  align-items: center;
  flex: none;
  color: ${LT.textSecondary};
`;

const seriesColumn = css`
  display: flex;
  flex-direction: column;
  gap: ${ROW_GAP}px;
  min-width: 200px;
`;

const swatchRow = css`
  display: flex;
  align-items: center;
  gap: ${GAP_XS}px;
`;

// ============================================================================
// Small shared pieces
// ============================================================================

/** The secondary-coloured dropdown affordance after a button label. */
function Chevron(): React.ReactElement {
  return (
    <span className={chevronSlot} aria-hidden>
      <DropdownChevron size={9} />
    </span>
  );
}

/** A RibbonIcon drawing looked up by key (the catalog stores keys, not elements). */
function ChartIcon({ name, size }: { name: RibbonIconKey; size: number }): React.ReactElement {
  const Glyph = RibbonIcon[name] as React.ComponentType<{ size?: number }>;
  return <Glyph size={size} />;
}

/** What a just-opened card should focus: the checked radio / selected option /
 *  first field, else the first enabled button. */
const FIRST_FOCUSABLE =
  'input:not([disabled]):not([type="hidden"]), [role="combobox"]:not([disabled]), [tabindex="0"], button:not([disabled]):not([tabindex="-1"])';

/**
 * Move focus into a card popover once it is visible. Deferred one task on
 * purpose: Popover renders hidden for the layout pass that measures it, and a
 * hidden element cannot take focus. Skipped when focus is already inside.
 */
function useFocusOnOpen(open: boolean, ref: React.RefObject<HTMLElement>): void {
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      const box = ref.current;
      if (!box || box.contains(document.activeElement)) return;
      box.querySelector<HTMLElement>(FIRST_FOCUSABLE)?.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [open, ref]);
}

/**
 * Open/close state for one anchored card popover. The card's body ref is the
 * caller's own `useRef` (paired with {@link useFocusOnOpen}), never part of
 * this result: a ref travelling inside a render-time object is a ref read
 * during render as far as the hooks linter can tell.
 */
function useCardPopover<T extends HTMLElement>(): {
  anchor: T | null;
  setAnchor: (el: T | null) => void;
  open: boolean;
  toggle: () => void;
  close: () => void;
} {
  const [anchor, setAnchor] = useState<T | null>(null);
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  const close = useCallback(() => setOpen(false), []);
  return { anchor, setAnchor, open, toggle, close };
}

// ============================================================================
// Shared design state (per-section replacement for the monolith's state)
// ============================================================================

interface ChartDesignState {
  chartId: string | null;
  spec: ChartSpec | null;
  updateSpec: (updates: Partial<ChartSpec>) => void;
  refreshFromStore: () => void;
}

/**
 * Tracks the selected chart's id + spec and provides the shared spec-update
 * pipeline (store write, cache invalidation, region sync, repaint events).
 * The former monolithic tab held this state once; each section now holds its
 * own copy, kept in sync via CHART_UPDATED. Sub-selection advances and
 * chart-to-chart switches don't fire CHART_UPDATED (the monolith caught them
 * through ambient ribbon re-renders), so sections also subscribe to
 * CHART_SELECTION_CHANGED and force a re-render.
 */
function useChartDesignState(): ChartDesignState {
  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  const [chartId, setChartId] = useState<string | null>(() => getCurrentChartId());
  const [spec, setSpec] = useState<ChartSpec | null>(() => {
    const id = getCurrentChartId();
    return id != null ? getChartById(id)?.spec ?? null : null;
  });

  const refreshFromStore = useCallback(() => {
    const id = getCurrentChartId();
    setChartId(id);
    if (id != null) {
      const chart = getChartById(id);
      setSpec(chart?.spec ?? null);
    } else {
      setSpec(null);
    }
  }, []);

  useEffect(() => {
    // Re-read on mount: the store is external state that may have moved
    // between the initial-state read and this subscription.
    refreshFromStore(); // eslint-disable-line react-hooks/set-state-in-effect -- syncing from an external store at subscribe time
    const handleRefresh = () => refreshFromStore();
    window.addEventListener(ChartEvents.CHART_UPDATED, handleRefresh);
    const unsubSelection = onAppEvent(AppEvents.CHART_SELECTION_CHANGED, () => {
      refreshFromStore();
      forceRender();
    });
    return () => {
      window.removeEventListener(ChartEvents.CHART_UPDATED, handleRefresh);
      unsubSelection();
    };
  }, [refreshFromStore]);

  const updateSpec = useCallback(
    (updates: Partial<ChartSpec>) => {
      if (chartId == null) return;
      updateChartSpec(chartId, updates);
      invalidateChartCache(chartId);
      syncChartRegions();
      window.dispatchEvent(new Event(ChartEvents.CHART_UPDATED));
      emitAppEvent(AppEvents.GRID_REFRESH);
      const chart = getChartById(chartId);
      if (chart) setSpec({ ...chart.spec });
    },
    [chartId],
  );

  return { chartId, spec, updateSpec, refreshFromStore };
}

// ============================================================================
// 1. Type — six quick tiles + More (all 18 types)
// ============================================================================

/**
 * Chart type. Band: a tall radio pill of the six common types (44x61, 30px
 * duotone icons, named "Column chart"...) plus a More tile whose card holds
 * every type as a captioned gallery. Sidebar/flyout: that gallery inline.
 */
export function ChartTypeSection(_props: PanelSectionProps): React.ReactElement | null {
  const { chartId, spec, updateSpec } = useChartDesignState();
  const layout = useSurfaceLayout();
  const {
    anchor: moreAnchor,
    setAnchor: setMoreAnchor,
    open: moreOpen,
    toggle: toggleMore,
    close: closeMore,
  } = useCardPopover<HTMLButtonElement>();
  const moreBodyRef = useRef<HTMLDivElement>(null);
  useFocusOnOpen(moreOpen, moreBodyRef);

  if (!chartId || !spec) return null;

  const setMark = (mark: ChartType): void => {
    if (mark !== spec.mark) updateSpec({ mark });
  };
  const current = chartTypeEntry(spec.mark);
  const galleryItems = CHART_TYPES.map((t) => ({
    value: t.value,
    label: t.label,
    icon: <ChartIcon name={t.icon} size={ICON_SIZE_MD} />,
  }));

  if (layout.container !== "band") {
    return (
      <TileGallery<ChartType>
        items={galleryItems}
        value={current?.value ?? null}
        onChange={setMark}
        columns={4}
        testIdPrefix="chart-type"
        ariaLabel="Chart type"
      />
    );
  }

  const underMore = current !== undefined && !current.quick;

  return (
    <div className={bandRow}>
      <SegmentedChoice<ChartType>
        value={spec.mark as ChartType}
        onChange={setMark}
        size="tall"
        iconOnly
        ariaLabel="Chart type"
        testId="chart-type-quick"
        options={QUICK_CHART_TYPES.map((t) => ({
          value: t.value,
          label: chartTypeName(t),
          icon: <ChartIcon name={t.icon} size={HERO_ICON_SIZE} />,
          testId: `chart-type-${t.value}`,
        }))}
      />
      <Tile
        ref={setMoreAnchor}
        icon={<RibbonIcon.More size={HERO_ICON_SIZE} />}
        label="More chart types"
        selected={underMore}
        tooltip={underMore && current ? `More chart types (current: ${current.label})` : "More chart types"}
        testId="chart-type-more"
        aria-haspopup="dialog"
        aria-expanded={moreOpen}
        onClick={toggleMore}
      />
      <Popover card anchorEl={moreAnchor} open={moreOpen} onClose={closeMore} heading="Chart types">
        <SurfaceLayoutProvider value={popoverLayout()}>
          <div ref={moreBodyRef}>
            <TileGallery<ChartType>
              items={galleryItems}
              value={current?.value ?? null}
              onChange={(mark) => {
                closeMore();
                moreAnchor?.focus();
                setMark(mark);
              }}
              columns={4}
              testIdPrefix="chart-type-gallery"
              ariaLabel="All chart types"
            />
          </div>
        </SurfaceLayoutProvider>
      </Popover>
    </div>
  );
}

// ============================================================================
// 2. Elements — one tall pill of toggles, three of them split
// ============================================================================

type ElementOptionsKey = "title" | "legend" | "dataLabels";

const LEGEND_POSITIONS: ReadonlyArray<{ value: "bottom" | "top" | "left" | "right"; label: string }> = [
  { value: "bottom", label: "Bottom" },
  { value: "top", label: "Top" },
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
];

const DATA_LABEL_POSITIONS: ReadonlyArray<{ value: DataLabelPosition; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "above", label: "Above" },
  { value: "below", label: "Below" },
  { value: "center", label: "Center" },
  { value: "inside", label: "Inside" },
  { value: "outside", label: "Outside" },
];

/**
 * Chart elements. One click on an icon turns that element on or off (its
 * pressed state IS the element's visibility); the chevron half of Title,
 * Legend and Data labels opens their options. Gridlines and Axis labels
 * exist only on axis charts.
 */
export function ChartElementsSection(_props: PanelSectionProps): React.ReactElement | null {
  const { chartId, spec, updateSpec } = useChartDesignState();
  const layout = useSurfaceLayout();
  const [openKey, setOpenKey] = useState<ElementOptionsKey | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpenKey(null), []);
  useFocusOnOpen(openKey !== null, bodyRef);

  if (!chartId || !spec) return null;

  const band = layout.container === "band";
  const size = band ? "tall" : "md";
  const iconSize = band ? 28 : ICON_SIZE_SM;
  const cartesian = isCartesianChart(spec.mark);

  const titleOn = Boolean(spec.title);
  const gridOn = Boolean(spec.yAxis?.gridLines);
  const legendOn = Boolean(spec.legend?.visible);
  const axisLabelsOn = Boolean(spec.xAxis?.showLabels);
  const dl = spec.dataLabels;
  const labelsOn = dl?.enabled ?? false;

  const openOptions =
    (key: ElementOptionsKey) =>
    (e: React.MouseEvent<HTMLButtonElement>): void => {
      setAnchor(e.currentTarget);
      setOpenKey((k) => (k === key ? null : key));
    };

  const chevronProps = (key: ElementOptionsKey): React.ButtonHTMLAttributes<HTMLButtonElement> =>
    ({
      // eslint-disable-next-line @typescript-eslint/naming-convention -- a DOM attribute name
      "data-testid": `chart-elem-${key}-options`,
      // eslint-disable-next-line @typescript-eslint/naming-convention -- a DOM attribute name
      "aria-haspopup": key === "legend" ? "menu" : "dialog",
      // eslint-disable-next-line @typescript-eslint/naming-convention -- a DOM attribute name
      "aria-expanded": openKey === key,
    }) as React.ButtonHTMLAttributes<HTMLButtonElement>;

  /** Close a card and put focus back on the chevron that opened it. */
  const closeToAnchor = (): void => {
    setOpenKey(null);
    anchor?.focus();
  };

  // Choosing a legend position or a label option while the element is off
  // turns it on: the reader asked to SEE it there.
  const setDataLabels = (patch: Partial<DataLabelSpec>): void => {
    updateSpec({ dataLabels: { ...(dl ?? { enabled: false }), ...patch, enabled: true } });
  };

  return (
    <>
      <Segmented ariaLabel="Chart elements" size={band ? "tall" : "md"}>
        <IconButton
          split
          size={size}
          icon={<RibbonIcon.ChartTitle size={iconSize} />}
          label="Title"
          pressed={titleOn}
          data-testid="chart-elem-title"
          onClick={() => updateSpec({ title: titleOn ? null : spec.title || "Chart" })}
          onChevronClick={openOptions("title")}
          chevronLabel="Title options"
          chevronProps={chevronProps("title")}
        />
        {cartesian && (
          <IconButton
            size={size}
            icon={<RibbonIcon.Gridlines size={iconSize} />}
            label="Gridlines"
            pressed={gridOn}
            data-testid="chart-elem-gridlines"
            onClick={() => updateSpec({ yAxis: { ...spec.yAxis, gridLines: !gridOn } })}
          />
        )}
        <IconButton
          split
          size={size}
          icon={<RibbonIcon.Legend size={iconSize} />}
          label="Legend"
          pressed={legendOn}
          data-testid="chart-elem-legend"
          onClick={() => updateSpec({ legend: { ...spec.legend, visible: !legendOn } })}
          onChevronClick={openOptions("legend")}
          chevronLabel="Legend options"
          chevronProps={chevronProps("legend")}
        />
        {cartesian && (
          <IconButton
            size={size}
            icon={<RibbonIcon.AxisLabels size={iconSize} />}
            label="Axis labels"
            pressed={axisLabelsOn}
            data-testid="chart-elem-axisLabels"
            onClick={() => updateSpec({ xAxis: { ...spec.xAxis, showLabels: !axisLabelsOn } })}
          />
        )}
        <IconButton
          split
          size={size}
          icon={<RibbonIcon.DataLabels size={iconSize} />}
          label="Data labels"
          pressed={labelsOn}
          data-testid="chart-elem-dataLabels"
          onClick={() =>
            updateSpec({ dataLabels: { ...(dl ?? { enabled: false }), enabled: !labelsOn } })
          }
          onChevronClick={openOptions("dataLabels")}
          chevronLabel="Data label options"
          chevronProps={chevronProps("dataLabels")}
        />
      </Segmented>

      <Popover card anchorEl={anchor} open={openKey === "title"} onClose={close} heading="Chart title" width={240}>
        <SurfaceLayoutProvider value={popoverLayout()}>
          <div ref={bodyRef} className={cardBody}>
            <Input
              type="text"
              value={spec.title ?? ""}
              placeholder="Chart title"
              aria-label="Chart title"
              data-testid="chart-title-input"
              onChange={(e) => updateSpec({ title: e.target.value || null })}
            />
          </div>
        </SurfaceLayoutProvider>
      </Popover>

      <Popover card anchorEl={anchor} open={openKey === "legend"} onClose={close} heading="Legend position">
        <div ref={bodyRef}>
          <Menu ariaLabel="Legend position">
            {LEGEND_POSITIONS.map((p) => (
              <MenuItem
                key={p.value}
                role="menuitemradio"
                checked={legendOn && spec.legend?.position === p.value}
                testId={`chart-legend-${p.value}`}
                onSelect={() => {
                  closeToAnchor();
                  updateSpec({ legend: { ...spec.legend, visible: true, position: p.value } });
                }}
              >
                {p.label}
              </MenuItem>
            ))}
          </Menu>
        </div>
      </Popover>

      <Popover
        card
        anchorEl={anchor}
        open={openKey === "dataLabels"}
        onClose={close}
        heading="Data labels"
        width={344}
      >
        <SurfaceLayoutProvider value={popoverLayout()}>
          <div ref={bodyRef} className={cardBody}>
            <SegmentedChoice<DataLabelPosition>
              value={dl?.position ?? "auto"}
              onChange={(position) => setDataLabels({ position })}
              ariaLabel="Label position"
              testId="chart-datalabel-position"
              options={DATA_LABEL_POSITIONS.map((p) => ({
                value: p.value,
                label: p.label,
                testId: `chart-datalabel-position-${p.value}`,
              }))}
            />
            <Slider
              className={sliderAligned}
              label="Size"
              value={dl?.fontSize ?? 10}
              min={7}
              max={20}
              step={1}
              suffix="px"
              title="Label font size (px)"
              testId="chart-datalabel-size"
              onChange={(fontSize) => setDataLabels({ fontSize })}
            />
          </div>
        </SurfaceLayoutProvider>
      </Popover>
    </>
  );
}

// ============================================================================
// 3. Layout — stacking + mark options (axis charts only)
// ============================================================================

const STACK_OPTIONS: ReadonlyArray<{ value: StackMode; label: string; icon: RibbonIconKey }> = [
  { value: "none", label: "Grouped", icon: "Grouped" },
  { value: "stacked", label: "Stacked", icon: "Stacked" },
  { value: "percentStacked", label: "100% stacked", icon: "Stacked100" },
];

const LINE_SHAPES: ReadonlyArray<{ value: LineInterpolation; label: string; icon: RibbonIconKey }> = [
  { value: "linear", label: "Straight", icon: "LineStraight" },
  { value: "smooth", label: "Smooth", icon: "LineSmooth" },
  { value: "step", label: "Stepped", icon: "LineStep" },
];

type MarksKind = "bar" | "line" | "area";

const MARKS_LABEL: Record<MarksKind, string> = { bar: "Bars", line: "Line", area: "Area" };

function marksKindOf(mark: string): MarksKind | null {
  return mark === "bar" || mark === "line" || mark === "area" ? mark : null;
}

/** Gap / overlap / corner radius — the column chart's mark options. */
function BarMarkControls({
  opts,
  setOpt,
}: {
  opts: BarMarkOptions;
  setOpt: (patch: Partial<BarMarkOptions>) => void;
}): React.ReactElement {
  return (
    <>
      <Slider
        className={sliderAligned}
        label="Gap"
        value={opts.gapWidth ?? 150}
        min={0}
        max={500}
        step={10}
        suffix="%"
        title="Gap between category groups, as % of bar width (Excel: Gap Width)"
        testId="chart-bars-gap"
        onChange={(gapWidth) => setOpt({ gapWidth })}
      />
      <Slider
        className={sliderAligned}
        label="Overlap"
        value={opts.seriesOverlap ?? 0}
        min={-100}
        max={100}
        step={5}
        suffix="%"
        title="Overlap between series bars; negative adds a gap (Excel: Series Overlap)"
        testId="chart-bars-overlap"
        onChange={(seriesOverlap) => setOpt({ seriesOverlap })}
      />
      <Slider
        className={sliderAligned}
        label="Radius"
        value={opts.borderRadius ?? 2}
        min={0}
        max={20}
        step={1}
        suffix="px"
        title="Bar corner radius (px)"
        testId="chart-bars-radius"
        onChange={(borderRadius) => setOpt({ borderRadius })}
      />
    </>
  );
}

/** Width / shape / markers (+ fill for an area) — the line and area options. */
function LineMarkControls({
  isArea,
  opts,
  setOpt,
}: {
  isArea: boolean;
  opts: LineMarkOptions & AreaMarkOptions;
  setOpt: (patch: Partial<LineMarkOptions & AreaMarkOptions>) => void;
}): React.ReactElement {
  const showMarkers = opts.showMarkers ?? !isArea;
  return (
    <>
      <Slider
        className={sliderAligned}
        label="Width"
        value={opts.lineWidth ?? 2}
        min={1}
        max={10}
        step={0.5}
        suffix="px"
        title="Line width (px)"
        testId="chart-line-width"
        onChange={(lineWidth) => setOpt({ lineWidth })}
      />
      <SegmentedChoice<LineInterpolation>
        value={opts.interpolation ?? "linear"}
        onChange={(interpolation) => setOpt({ interpolation })}
        ariaLabel="Line shape"
        testId="chart-line-shape"
        options={LINE_SHAPES.map((s) => ({
          value: s.value,
          label: s.label,
          icon: <ChartIcon name={s.icon} size={ICON_SIZE_SM} />,
          testId: `chart-line-shape-${s.value}`,
        }))}
      />
      <Checkbox
        label="Markers"
        checked={showMarkers}
        testId="chart-line-markers"
        onChange={(on) => setOpt({ showMarkers: on })}
      />
      {showMarkers && (
        <Slider
          className={sliderAligned}
          label="Size"
          value={opts.markerRadius ?? 4}
          min={1}
          max={12}
          step={1}
          suffix="px"
          title="Marker radius (px)"
          testId="chart-line-marker-size"
          onChange={(markerRadius) => setOpt({ markerRadius })}
        />
      )}
      {isArea && (
        <Slider
          className={sliderAligned}
          label="Fill"
          value={Math.round((opts.fillOpacity ?? 0.3) * 100)}
          min={0}
          max={100}
          step={5}
          suffix="%"
          title="Area fill opacity"
          testId="chart-area-fill"
          onChange={(pct) => setOpt({ fillOpacity: pct / 100 })}
        />
      )}
    </>
  );
}

/**
 * Layout (axis charts only). The stacking pill applies to column, bar, line
 * and area; on other axis charts it stays in place disabled so the cluster
 * keeps its shape. Column/line/area add a hero whose card holds their mark
 * options; a combo chart adds the "2nd axis" switch.
 */
export function ChartLayoutSection(_props: PanelSectionProps): React.ReactElement | null {
  const { chartId, spec, updateSpec } = useChartDesignState();
  const layout = useSurfaceLayout();
  const {
    anchor: marksAnchor,
    setAnchor: setMarksAnchor,
    open: marksOpen,
    toggle: toggleMarks,
    close: closeMarks,
  } = useCardPopover<HTMLButtonElement>();
  const marksBodyRef = useRef<HTMLDivElement>(null);
  useFocusOnOpen(marksOpen, marksBodyRef);

  if (!chartId || !spec) return null;
  // Registered only for axis charts; a type switch re-renders this once
  // before the panel re-registers without it.
  if (!isCartesianChart(spec.mark)) return null;

  const band = layout.container === "band";
  const stackable = supportsStacking(spec.mark);
  const stackMode = getStackModeFromSpec(spec);
  const isCombo = spec.mark === "combo";
  const comboOpts = (isCombo ? spec.markOptions ?? {} : {}) as ComboMarkOptions;
  const marks = marksKindOf(spec.mark);

  const stacking = (
    <SegmentedChoice<StackMode>
      value={stackMode}
      onChange={(mode) => updateSpec({ markOptions: setStackModeInOptions(spec, mode) })}
      ariaLabel="Stacking"
      size={band ? "tall" : "md"}
      iconOnly={band}
      testId="chart-stacking"
      options={STACK_OPTIONS.map((o) => ({
        value: o.value,
        label: o.label,
        icon: <ChartIcon name={o.icon} size={band ? 28 : ICON_SIZE_SM} />,
        tooltip: stackable ? o.label : `${o.label} (column, bar, line and area charts)`,
        testId: `chart-stacking-${o.value}`,
        disabled: !stackable,
      }))}
    />
  );

  const secondaryAxis = isCombo ? (
    <Switch
      label="2nd axis"
      checked={comboOpts.secondaryYAxis ?? false}
      tooltip="Plot series against a secondary (right) value axis"
      testId="chart-secondary-axis"
      onChange={(on) => updateSpec({ markOptions: { ...comboOpts, secondaryYAxis: on } })}
    />
  ) : null;

  let marksControl: React.ReactNode = null;
  if (marks !== null) {
    const opts = (spec.markOptions ?? {}) as BarMarkOptions & LineMarkOptions & AreaMarkOptions;
    const setOpt = (patch: Partial<BarMarkOptions & LineMarkOptions & AreaMarkOptions>): void =>
      updateSpec({ markOptions: { ...opts, ...patch } });
    marksControl = (
      <>
        <CommandButton
          ref={setMarksAnchor}
          icon={<RibbonIcon.MarkOptions size={HERO_ICON_SIZE} />}
          label={MARKS_LABEL[marks]}
          chevron
          tooltip={marks === "bar" ? "Gap, overlap and corner radius" : "Width, shape and markers"}
          data-testid="chart-marks"
          aria-haspopup="dialog"
          aria-expanded={marksOpen}
          onClick={toggleMarks}
        />
        <Popover
          card
          anchorEl={marksAnchor}
          open={marksOpen}
          onClose={closeMarks}
          heading={MARKS_LABEL[marks]}
          width={300}
        >
          <SurfaceLayoutProvider value={popoverLayout()}>
            <div ref={marksBodyRef} className={cardBody} data-testid="chart-marks-card">
              {marks === "bar" ? (
                <BarMarkControls opts={opts} setOpt={setOpt} />
              ) : (
                <LineMarkControls isArea={marks === "area"} opts={opts} setOpt={setOpt} />
              )}
            </div>
          </SurfaceLayoutProvider>
        </Popover>
      </>
    );
  }

  return (
    <div className={band ? bandRow : panelStack}>
      {stacking}
      {marksControl}
      {secondaryAxis}
    </div>
  );
}

// ============================================================================
// 4. Style — palette strip over the Series colour card
// ============================================================================

/** "default" -> "Default". */
function paletteDisplayName(id: string): string {
  return id.length === 0 ? id : id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * Per-series colour override (name-keyed, all sources) — the ONE writer is
 * `seriesColorPatch`, read back through `readSeriesColor`. Hosted in the Style
 * cluster's "Series" card; kept as a named export because the OB-1 tests
 * render it directly.
 */
export function SeriesColorsSection(_props: PanelSectionProps): React.ReactElement | null {
  const { chartId, spec, updateSpec } = useChartDesignState();
  const [seriesIdx, setSeriesIdx] = useState(0);
  if (!chartId || !spec) return null;
  if (!isCartesianChart(spec.mark)) return null;

  const seriesList = getCachedChartData(chartId)?.data?.series ?? [];
  if (seriesList.length === 0) return null;
  const idx = Math.min(seriesIdx, seriesList.length - 1);
  const name = seriesList[idx].name;
  const override = readSeriesColor(spec, name);
  const effective = override ?? getSeriesColor(spec.palette, idx, seriesList[idx].color ?? null);

  /** Commit through the ONE writer, or do nothing when it says there is nothing to do. */
  const write = (hex: string | null): void => {
    const patch = seriesColorPatch(spec, name, hex);
    if (patch !== null) updateSpec(patch);
  };

  return (
    <div className={seriesColumn}>
      <Dropdown<number>
        value={idx}
        options={seriesList.map((sr, i) => ({ value: i, label: sr.name }))}
        onChange={setSeriesIdx}
        ariaLabel="Series"
        testId="chart-series-picker"
        optionTestIdPrefix="chart-series-option-"
      />
      <div className={swatchRow}>
        <ColorSwatch
          native
          // <input type=color> only speaks #rrggbb; anything else shows the
          // default palette's first colour rather than black.
          color={normalizeHex(effective) ?? PALETTES.default[0]}
          onChange={(hex) => write(hex)}
          label="Series colour"
          testId="chart-series-colour"
        />
        <Button
          disabled={!override}
          onClick={() => write(null)}
          tooltip="Reset this series to its palette colour"
          data-testid="chart-series-auto"
        >
          Auto
        </Button>
      </div>
    </div>
  );
}

/**
 * Style: the palette strip (row 1) and the Series colour card (row 2). The
 * Series button stays in place, disabled, on charts without per-series fills
 * (a pie colours by slice), so the cluster keeps its two rows.
 */
export function ChartStyleSection(_props: PanelSectionProps): React.ReactElement | null {
  const { chartId, spec, updateSpec } = useChartDesignState();
  const layout = useSurfaceLayout();
  const {
    anchor: seriesAnchor,
    setAnchor: setSeriesAnchor,
    open: seriesOpen,
    toggle: toggleSeries,
    close: closeSeries,
  } = useCardPopover<HTMLButtonElement>();
  const seriesBodyRef = useRef<HTMLDivElement>(null);
  useFocusOnOpen(seriesOpen, seriesBodyRef);

  if (!chartId || !spec) return null;

  const band = layout.container === "band";
  const cartesian = isCartesianChart(spec.mark);
  const hasSeries = (getCachedChartData(chartId)?.data?.series?.length ?? 0) > 0;
  const palettes = PALETTE_NAMES.map((id) => ({
    id,
    name: paletteDisplayName(id),
    colors: PALETTES[id],
  }));

  return (
    <div className={band ? bandColumn : panelStack}>
      <div className={band ? bandLine : panelLine}>
        <PaletteStrip
          palettes={palettes}
          value={spec.palette}
          onChange={(palette) => updateSpec({ palette })}
          testIdPrefix="chart-palette"
          ariaLabel="Colour palette"
        />
      </div>
      <div className={band ? bandLine : panelLine}>
        <Button
          ref={setSeriesAnchor}
          icon={<RibbonIcon.Series size={ICON_SIZE_SM} />}
          disabled={!cartesian}
          tooltip={
            cartesian
              ? "Colour one series"
              : "Series colours apply to charts with axes; format a slice from the Format pane"
          }
          data-testid="chart-series"
          aria-haspopup="dialog"
          aria-expanded={seriesOpen}
          onClick={toggleSeries}
        >
          Series
          <Chevron />
        </Button>
      </div>
      <Popover
        card
        anchorEl={seriesAnchor}
        open={seriesOpen && cartesian}
        onClose={closeSeries}
        heading="Series colour"
      >
        <SurfaceLayoutProvider value={popoverLayout()}>
          <div ref={seriesBodyRef} className={cardBody}>
            {hasSeries ? (
              <SeriesColorsSection placement="sidebar" />
            ) : (
              <StatusText>This chart has no series to colour yet.</StatusText>
            )}
          </div>
        </SurfaceLayoutProvider>
      </Popover>
    </div>
  );
}

// ============================================================================
// 5. Data — Filter + Trendline rows beside the Switch hero
// ============================================================================

const TRENDLINE_TYPES: ReadonlyArray<{ value: TrendlineType | "none"; label: string }> = [
  { value: "none", label: "None" },
  { value: "linear", label: "Linear" },
  { value: "exponential", label: "Exponential" },
  { value: "polynomial", label: "Polynomial" },
  { value: "logarithmic", label: "Logarithmic" },
  { value: "power", label: "Power" },
  { value: "movingAverage", label: "Moving average" },
];

function trendlineLabel(type: TrendlineType): string {
  return TRENDLINE_TYPES.find((t) => t.value === type)?.label ?? type;
}

/**
 * Data: Filter (series/category visibility, with an "N of M" chip while
 * anything is hidden) and Trendline (a menu of types plus the equation and
 * R-squared toggles, with a chip naming the type), beside the "Switch"
 * row/column hero for range-sourced charts.
 */
export function ChartDataSection(_props: PanelSectionProps): React.ReactElement | null {
  const { chartId, spec, updateSpec } = useChartDesignState();
  const layout = useSurfaceLayout();
  const {
    anchor: filterAnchor,
    setAnchor: setFilterAnchor,
    open: filterOpen,
    toggle: toggleFilter,
    close: closeFilter,
  } = useCardPopover<HTMLButtonElement>();
  const filterBodyRef = useRef<HTMLDivElement>(null);
  useFocusOnOpen(filterOpen, filterBodyRef);

  if (!chartId || !spec) return null;

  const band = layout.container === "band";
  const isPivot = isPivotDataSource(spec.data);
  const cartesian = isCartesianChart(spec.mark);
  const supportsTrendline = cartesian && spec.mark !== "waterfall" && spec.mark !== "histogram";
  // A pivot chart has no Switch hero; keeping its Trendline row (disabled when
  // it does not apply) is what keeps the cluster two rows rather than one.
  const showTrendlineRow = supportsTrendline || isPivot;
  const unfilteredData = getCachedChartData(chartId)?.unfilteredData;
  const summary = summarizeChartFilters(spec.filters, unfilteredData);
  const currentTrendline: TrendlineSpec | null = spec.trendlines?.[0] ?? null;

  const setTrendlineType = (type: TrendlineType | "none"): void => {
    if (type === "none") {
      updateSpec({ trendlines: [] });
      return;
    }
    const tl: TrendlineSpec = {
      type,
      seriesIndex: currentTrendline?.seriesIndex ?? 0,
      ...(type === "polynomial" ? { polynomialDegree: currentTrendline?.polynomialDegree ?? 2 } : {}),
      ...(type === "movingAverage" ? { movingAveragePeriod: currentTrendline?.movingAveragePeriod ?? 3 } : {}),
    };
    updateSpec({ trendlines: [tl] });
  };

  const switchRowCol = async (): Promise<void> => {
    if (chartId == null || !spec) return;
    try {
      const dataRef = await resolveDataSource(spec.data);
      const newOrientation: SeriesOrientation =
        spec.seriesOrientation === "columns" ? "rows" : "columns";
      const detected = await autoDetectSeriesForOrientation(
        dataRef, spec.hasHeaders, newOrientation,
      );
      updateSpec({
        seriesOrientation: newOrientation,
        categoryIndex: detected.categoryIndex,
        series: detected.series,
        seriesRefs: undefined,
      });
    } catch (err) {
      console.error("[Charts] Switch Row/Column failed:", err);
    }
  };

  const chipTitle =
    summary === null
      ? undefined
      : summary.shown !== null
        ? `${summary.shown} of ${summary.total} ${summary.noun} shown`
        : `${summary.hidden} hidden`;

  const filterRow = (
    <div className={band ? bandLine : panelLine}>
      <Button
        ref={setFilterAnchor}
        icon={<RibbonIcon.Filter size={ICON_SIZE_SM} />}
        tooltip="Show or hide series and categories"
        data-testid="chart-filter"
        aria-haspopup="dialog"
        aria-expanded={filterOpen}
        onClick={toggleFilter}
      >
        Filter
        <Chevron />
      </Button>
      {summary !== null && (
        <Chip tone="info" testId="chart-filter-chip" title={chipTitle}>
          {summary.shown !== null ? (
            <>
              <b>{summary.shown}</b> of {summary.total}
            </>
          ) : (
            <>
              <b>{summary.hidden}</b> hidden
            </>
          )}
        </Chip>
      )}
    </div>
  );

  const trendlineRow = showTrendlineRow ? (
    <div className={band ? bandLine : panelLine}>
      <MenuButton
        ariaLabel="Trendline"
        trigger={
          <Button
            icon={<RibbonIcon.Trendline size={ICON_SIZE_SM} />}
            disabled={!supportsTrendline}
            tooltip={
              supportsTrendline
                ? "Add a trendline to the first series"
                : "Trendlines apply to charts with a value axis"
            }
            data-testid="chart-trendline"
          >
            Trendline
            <Chevron />
          </Button>
        }
      >
        {TRENDLINE_TYPES.map((t) => (
          <MenuItem
            key={t.value}
            role="menuitemradio"
            checked={(currentTrendline?.type ?? "none") === t.value}
            testId={`chart-trendline-${t.value}`}
            onSelect={() => setTrendlineType(t.value)}
          >
            {t.label}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem
          role="menuitemcheckbox"
          checked={currentTrendline?.showEquation ?? false}
          disabled={currentTrendline === null}
          testId="chart-trendline-equation"
          onSelect={() => {
            if (currentTrendline === null) return;
            updateSpec({
              trendlines: [{ ...currentTrendline, showEquation: !(currentTrendline.showEquation ?? false) }],
            });
          }}
        >
          Show equation
        </MenuItem>
        <MenuItem
          role="menuitemcheckbox"
          checked={currentTrendline?.showRSquared ?? false}
          disabled={currentTrendline === null}
          testId="chart-trendline-rsquared"
          onSelect={() => {
            if (currentTrendline === null) return;
            updateSpec({
              trendlines: [{ ...currentTrendline, showRSquared: !(currentTrendline.showRSquared ?? false) }],
            });
          }}
        >
          Show R<sup>2</sup>
        </MenuItem>
      </MenuButton>
      {supportsTrendline && currentTrendline !== null && (
        <Chip testId="chart-trendline-chip" title={`Trendline: ${trendlineLabel(currentTrendline.type)}`}>
          <b>{trendlineLabel(currentTrendline.type)}</b>
        </Chip>
      )}
    </div>
  ) : null;

  const switchHero = isPivot ? null : (
    <CommandButton
      icon={<RibbonIcon.SwitchRowCol size={HERO_ICON_SIZE} />}
      label="Switch"
      aria-label="Switch row/column"
      tooltip="Switch between rows and columns as data series"
      data-testid="chart-switch-rowcol"
      onClick={() => void switchRowCol()}
    />
  );

  const filterCardPopover = (
    <Popover
      card
      anchorEl={filterAnchor}
      open={filterOpen}
      onClose={closeFilter}
      heading="Filter chart"
    >
      <SurfaceLayoutProvider value={popoverLayout()}>
        <div ref={filterBodyRef}>
          <ChartFilterDropdown
            spec={spec}
            unfilteredData={unfilteredData}
            onFiltersChange={(newFilters: ChartFilters) => updateSpec({ filters: newFilters })}
          />
        </div>
      </SurfaceLayoutProvider>
    </Popover>
  );

  if (!band) {
    return (
      <div className={panelStack}>
        {filterRow}
        {trendlineRow}
        {switchHero}
        {filterCardPopover}
      </div>
    );
  }

  return (
    <div className={bandPair}>
      <div className={bandColumn}>
        {filterRow}
        {trendlineRow}
      </div>
      {switchHero}
      {filterCardPopover}
    </div>
  );
}

// ============================================================================
// 6. Actions — Edit Chart, Save Image, Format Point, JSON
// ============================================================================

/**
 * Actions. Format Point appears only while a single data point is selected;
 * JSON is pressed while the chart-json task pane is open and toggles it.
 */
export function ChartActionsSection(_props: PanelSectionProps): React.ReactElement | null {
  const { chartId, spec } = useChartDesignState();
  const layout = useSurfaceLayout();
  const openPaneIds = useTaskPaneOpenPaneIds();
  const paneContainerOpen = useIsTaskPaneOpen();

  if (!chartId || !spec) return null;

  const band = layout.container === "band";
  const isPivot = isPivotDataSource(spec.data);
  const jsonOpen = paneContainerOpen && openPaneIds.includes(CHART_JSON_PANE_ID);

  let formatPoint: React.ReactNode = null;
  const subSel = getSubSelection();
  if (subSel.level === "dataPoint") {
    const isPieOrDonut = spec.mark === "pie" || spec.mark === "donut";
    const cachedData = getCachedChartData(chartId);
    // subSel indices are PAINTER (post-filter) space; the painted point's
    // label is in the same space (the filtered data's categories).
    const categoryName = cachedData?.data?.categories?.[subSel.categoryIndex ?? 0] ?? "";
    // dataPointOverrides are keyed in AUTHORING (unfiltered) space — translate
    // the painter sub-selection so the override anchors to the right datum
    // even with a series/category filter active.
    const authoring = cachedData
      ? toAuthoringIndices(cachedData.data, subSel.seriesIndex ?? 0, subSel.categoryIndex ?? 0)
      : { seriesIndex: subSel.seriesIndex ?? 0, categoryIndex: subSel.categoryIndex ?? 0 };
    formatPoint = (
      <CommandButton
        icon={<RibbonIcon.FormatPoint size={HERO_ICON_SIZE} />}
        label="Format Point"
        tooltip="Format the selected data point"
        data-testid="chart-format-point"
        onClick={() => {
          showDialog("chart:dataPointFormat", {
            chartId,
            seriesIndex: authoring.seriesIndex,
            categoryIndex: authoring.categoryIndex,
            categoryName,
            isPieOrDonut,
          });
        }}
      />
    );
  }

  return (
    <div className={band ? bandRow : panelLine}>
      <CommandButton
        icon={<RibbonIcon.EditChart size={HERO_ICON_SIZE} />}
        label="Edit Chart"
        tooltip="Open the full chart editor"
        data-testid="chart-edit"
        onClick={() => {
          if (isPivot) {
            const pivotId = (spec.data as { pivotId: string }).pivotId;
            showDialog(CHART_DIALOG_ID, { pivotId, editChartId: chartId });
          } else {
            showDialog(CHART_DIALOG_ID, { editChartId: chartId });
          }
        }}
      />
      <CommandButton
        icon={<RibbonIcon.SaveImage size={HERO_ICON_SIZE} />}
        label="Save Image"
        tooltip="Save the chart as a PNG image"
        data-testid="chart-save-image"
        onClick={async () => {
          try {
            await exportChartAsImage(chartId);
          } catch (err) {
            console.error("[Charts] Export failed:", err);
            void alertAsync("Failed to export chart: " + String(err));
          }
        }}
      />
      {formatPoint}
      <CommandButton
        icon={<RibbonIcon.Code size={HERO_ICON_SIZE} />}
        label="JSON"
        active={jsonOpen}
        tooltip={jsonOpen ? "Close the chart JSON pane" : "Edit the chart as JSON in a task pane"}
        data-testid="chart-json-toggle"
        onClick={() => {
          if (jsonOpen) closeTaskPane(CHART_JSON_PANE_ID);
          else openTaskPane(CHART_JSON_PANE_ID);
        }}
      />
    </div>
  );
}

// ============================================================================
// Section list builder
// ============================================================================

/** Launcher flyout width for every Chart Design cluster. */
const CHART_FLYOUT_WIDTH = 320;

/** Section icon (launcher slot, sidebar header) — the duotone set at 24. */
function sectionIcon(name: RibbonIconKey): React.ReactNode {
  return <ChartIcon name={name} size={ICON_SIZE_MD} />;
}

/**
 * Build the section list for the currently selected chart: Type, Elements,
 * [Layout — axis charts only], Style, Data, Actions.
 *
 * Layout is the ONLY conditional section, so the selection handler (which
 * re-registers the panel when the id list changes) remounts the band only on
 * an axis <-> radial flip. collapsePriority: lower demotes to a launcher
 * first — Layout (3), then Actions (5), Data (6), Style (8), Elements (9),
 * and Type (10) last.
 */
export function buildChartDesignSections(): PanelSection[] {
  const chartId = getCurrentChartId();
  const spec = chartId != null ? getChartById(chartId)?.spec ?? null : null;
  const cartesian = spec != null && isCartesianChart(spec.mark);

  const sections: PanelSection[] = [
    {
      id: `${CHART_DESIGN_TAB_ID}.type`,
      label: "Type",
      icon: sectionIcon("ChartColumn"),
      component: ChartTypeSection,
      ribbonPresentation: "inline",
      collapsePriority: 10,
      flyoutWidth: CHART_FLYOUT_WIDTH,
    },
    {
      id: `${CHART_DESIGN_TAB_ID}.elements`,
      label: "Elements",
      icon: sectionIcon("ChartTitle"),
      component: ChartElementsSection,
      ribbonPresentation: "inline",
      collapsePriority: 9,
      flyoutWidth: CHART_FLYOUT_WIDTH,
    },
  ];

  if (cartesian) {
    sections.push({
      id: `${CHART_DESIGN_TAB_ID}.layout`,
      label: "Layout",
      icon: sectionIcon("Stacked"),
      component: ChartLayoutSection,
      ribbonPresentation: "auto",
      collapsePriority: 3,
      flyoutWidth: CHART_FLYOUT_WIDTH,
    });
  }

  sections.push(
    {
      id: `${CHART_DESIGN_TAB_ID}.style`,
      label: "Style",
      icon: sectionIcon("Palette"),
      component: ChartStyleSection,
      ribbonPresentation: "inline",
      collapsePriority: 8,
      flyoutWidth: CHART_FLYOUT_WIDTH,
    },
    {
      id: `${CHART_DESIGN_TAB_ID}.data`,
      label: "Data",
      icon: sectionIcon("Filter"),
      component: ChartDataSection,
      ribbonPresentation: "inline",
      collapsePriority: 6,
      flyoutWidth: CHART_FLYOUT_WIDTH,
    },
    {
      id: `${CHART_DESIGN_TAB_ID}.actions`,
      label: "Actions",
      icon: sectionIcon("EditChart"),
      component: ChartActionsSection,
      ribbonPresentation: "auto",
      collapsePriority: 5,
      flyoutWidth: CHART_FLYOUT_WIDTH,
    },
  );

  return sections;
}
