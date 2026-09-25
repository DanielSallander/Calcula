//! FILENAME: app/extensions/CanvasSheet/components/CanvasTabSections.tsx
// PURPOSE: The contextual "Canvas" ribbon tab: shown while a canvas sheet is
//          active, it holds the snap grid, the page and the view controls.
// CONTEXT: Composed from @api/layout primitives only (no CSS, no colours), so
//          it follows every skin and renders in the band, a launcher flyout or
//          the sidebar from one tree. Every section fills the band's 61px box in
//          one of the two sanctioned ways (docs/design/ribbon-design-system.md):
//          a tall row of heroes, or two 28px rows.
//
//          Every mounted copy (band, flyout, sidebar) reads the same store,
//          lib/canvasSheetStore.ts, through useSyncExternalStore, so a layout
//          changed by a script or an MCP tool shows here the moment its
//          announcement is re-read.
//
//          E2E contract: the contextual TAB is the only button whose text is
//          exactly "Canvas", so no control in this tab is labelled "Canvas".

import React, { useEffect, useState, useSyncExternalStore } from "react";
import { getDesignMode, onDesignModeChange, toggleDesignMode } from "@api";
import type { PanelDefinition, PanelSectionProps } from "@api/uiTypes";
import {
  ActionRow,
  Checkbox,
  ColorSwatch,
  CommandButton,
  ControlGrid,
  ControlGridBreak,
  Dropdown,
  Field,
  GAP_MD,
  GAP_XS,
  HERO_ICON_SIZE,
  ICON_SIZE_MD,
  ICON_SIZE_SM,
  ROW_GAP,
  Stack,
  type DropdownOption,
} from "@api/layout";
import { RibbonIcon } from "@api/ribbonIcons";
import {
  CANVAS_CUSTOM_PAGE_PRESET,
  CANVAS_MAX_GRID_SIZE_PX,
  CANVAS_MAX_PAGE_EDGE_PX,
  CANVAS_MIN_GRID_SIZE_PX,
  CANVAS_MIN_PAGE_EDGE_PX,
  CANVAS_PAGE_PRESETS,
  canvasPresetSize,
} from "@api/canvasSheet";
import {
  getCanvasSheetSnapshot,
  subscribeCanvasSheets,
  type CanvasSheetSnapshot,
} from "../lib/canvasSheetStore";
import {
  fitActiveCanvasToWindow,
  patchActiveCanvasLayout,
  showActiveCanvasAtActualSize,
} from "../lib/canvasActions";
import { CommitNumberField } from "./CommitNumberField";
import { insertOnCanvas, type CanvasInsertKind } from "../lib/insertOnCanvas";

export const CANVAS_TAB_ID = "canvas-sheet-tab";

/** The tab's accent: the skin's canvas token, with the light fallback. */
export const CANVAS_TAB_COLOR = "var(--tab-accent-canvas, #b0245f)";

function useCanvasSheet(): CanvasSheetSnapshot {
  return useSyncExternalStore(subscribeCanvasSheets, getCanvasSheetSnapshot, getCanvasSheetSnapshot);
}

function useDesignMode(): boolean {
  const [on, setOn] = useState(getDesignMode());
  useEffect(() => onDesignModeChange(setOn), []);
  return on;
}

/** Why a control is disabled on a subscribed canvas, shown as its tooltip. */
const SUBSCRIBED_NOTE =
  "This canvas comes from an application, so its layout is the publisher's. Detach the sheet to change it.";

// ============================================================================
// Section: Insert -- every object a canvas can hold, placed on the page
// ============================================================================

interface InsertItem {
  kind: CanvasInsertKind;
  label: string;
  tooltip: string;
  icon: React.ReactNode;
}

const INSERT_ITEMS: readonly InsertItem[] = [
  { kind: "chart", label: "Chart", tooltip: "Insert a chart of data on another sheet (type the range with its sheet, e.g. Sheet1!A1:B10)", icon: <RibbonIcon.ChartColumn size={HERO_ICON_SIZE} /> },
  { kind: "slicer", label: "Slicer", tooltip: "Insert a slicer that filters a table or a pivot table", icon: <RibbonIcon.Slicer size={HERO_ICON_SIZE} /> },
  { kind: "timeline", label: "Timeline", tooltip: "Insert a timeline that filters a pivot table by date", icon: <RibbonIcon.Timeline size={HERO_ICON_SIZE} /> },
  { kind: "floatingGrid", label: "Floating Grid", tooltip: "Insert a small grid of cells that floats on the page", icon: <RibbonIcon.Table size={HERO_ICON_SIZE} /> },
  { kind: "textBox", label: "Text Box", tooltip: "Insert a text box", icon: <RibbonIcon.Text size={HERO_ICON_SIZE} /> },
  { kind: "shape", label: "Shape", tooltip: "Insert a rectangle you can restyle", icon: <RibbonIcon.Layout size={HERO_ICON_SIZE} /> },
  { kind: "picture", label: "Picture", tooltip: "Insert a picture from a file", icon: <RibbonIcon.Image size={HERO_ICON_SIZE} /> },
  { kind: "button", label: "Button", tooltip: "Insert a button that can run a script", icon: <RibbonIcon.Controls size={HERO_ICON_SIZE} /> },
];

export function CanvasInsertSection(_props: PanelSectionProps): React.ReactElement | null {
  const { active, activeSubscribed } = useCanvasSheet();
  if (!active) return null;
  return (
    <ActionRow gap={GAP_XS}>
      {INSERT_ITEMS.map((item) => (
        <CommandButton
          key={item.kind}
          icon={item.icon}
          label={item.label}
          disabled={activeSubscribed}
          tooltip={activeSubscribed ? SUBSCRIBED_NOTE : item.tooltip}
          data-testid={`canvas-insert-${item.kind}`}
          onClick={() => void insertOnCanvas(item.kind)}
        />
      ))}
    </ActionRow>
  );
}

// ============================================================================
// Section: Snap -- the snap command, the grid size, and whether it is shown
// ============================================================================

export function CanvasSnapSection(_props: PanelSectionProps): React.ReactElement | null {
  const { active, activeSubscribed } = useCanvasSheet();
  if (!active) return null;
  const { layout } = active;
  const locked = activeSubscribed;
  return (
    <ActionRow gap={GAP_MD}>
      <CommandButton
        icon={<RibbonIcon.Gridlines size={HERO_ICON_SIZE} />}
        label="Snap to Grid"
        active={layout.snapToGrid}
        disabled={locked}
        tooltip={
          locked
            ? SUBSCRIBED_NOTE
            : "Snap an object's edges to the grid while you drag or resize it. Hold Alt to move freely."
        }
        data-testid="canvas-snap-to-grid"
        onClick={() => void patchActiveCanvasLayout({ snapToGrid: !layout.snapToGrid })}
      />
      <Stack gap={ROW_GAP}>
        <Field label="Grid size">
          <CommitNumberField
            value={layout.gridSizePx}
            min={CANVAS_MIN_GRID_SIZE_PX}
            max={CANVAS_MAX_GRID_SIZE_PX}
            step={1}
            width={56}
            suffix="px"
            ariaLabel="Grid size in pixels"
            disabled={locked}
            testId="canvas-grid-size"
            onCommit={(gridSizePx) => void patchActiveCanvasLayout({ gridSizePx })}
          />
        </Field>
        <Checkbox
          label="Show grid"
          checked={layout.showGrid}
          disabled={locked}
          tooltip="Show the snap grid's dots on the page while you lay it out"
          testId="canvas-show-grid"
          onChange={(showGrid) => void patchActiveCanvasLayout({ showGrid })}
        />
      </Stack>
    </ActionRow>
  );
}

// ============================================================================
// Section: Page -- its size (preset or custom) and its background
// ============================================================================

const PAGE_OPTIONS: ReadonlyArray<DropdownOption<string>> = [
  ...CANVAS_PAGE_PRESETS.map((p) => ({
    value: p.id,
    label: p.label,
    hint: `${p.width} x ${p.height} px`,
  })),
  { value: CANVAS_CUSTOM_PAGE_PRESET, label: "Custom" },
];

export function CanvasPageSection(_props: PanelSectionProps): React.ReactElement | null {
  const { active, activeSubscribed } = useCanvasSheet();
  if (!active) return null;
  const { layout } = active;
  const locked = activeSubscribed;
  return (
    <ControlGrid>
      <Dropdown<string>
        ariaLabel="Page size"
        tooltip={locked ? SUBSCRIBED_NOTE : "The size of the page"}
        value={layout.pagePreset}
        options={PAGE_OPTIONS}
        disabled={locked}
        testId="canvas-page-size"
        optionTestIdPrefix="canvas-page-size-"
        onChange={(pagePreset) => {
          if (pagePreset === layout.pagePreset) return;
          // A named preset carries its own size; "Custom" keeps the current
          // one and unlocks the width and height fields' meaning.
          const size = canvasPresetSize(pagePreset);
          void patchActiveCanvasLayout(
            size
              ? { pagePreset, pageWidth: size.width, pageHeight: size.height }
              : { pagePreset },
          );
        }}
      />
      <ColorSwatch
        label="Page background"
        color={layout.background || null}
        variant="bar"
        icon={<RibbonIcon.Background size={ICON_SIZE_SM} />}
        allowAutomatic
        automaticLabel="Theme default"
        onAutomatic={() => void patchActiveCanvasLayout({ background: "" })}
        onChange={(hex) => void patchActiveCanvasLayout({ background: hex })}
        disabled={locked}
        testId="canvas-page-background"
      />
      <ControlGridBreak />
      <CommitNumberField
        label="W"
        ariaLabel="Page width in pixels"
        value={layout.pageWidth}
        min={CANVAS_MIN_PAGE_EDGE_PX}
        max={CANVAS_MAX_PAGE_EDGE_PX}
        step={1}
        width={62}
        disabled={locked}
        testId="canvas-page-width"
        // An explicit size is a custom page (the backend says the same).
        onCommit={(pageWidth) => void patchActiveCanvasLayout({ pagePreset: CANVAS_CUSTOM_PAGE_PRESET, pageWidth })}
      />
      <CommitNumberField
        label="H"
        ariaLabel="Page height in pixels"
        value={layout.pageHeight}
        min={CANVAS_MIN_PAGE_EDGE_PX}
        max={CANVAS_MAX_PAGE_EDGE_PX}
        step={1}
        width={62}
        disabled={locked}
        testId="canvas-page-height"
        onCommit={(pageHeight) => void patchActiveCanvasLayout({ pagePreset: CANVAS_CUSTOM_PAGE_PRESET, pageHeight })}
      />
    </ControlGrid>
  );
}

// ============================================================================
// Section: View -- fit / actual size, and design mode
// ============================================================================

export function CanvasViewSection(_props: PanelSectionProps): React.ReactElement | null {
  const { active } = useCanvasSheet();
  const designMode = useDesignMode();
  if (!active) return null;
  return (
    <ActionRow gap={GAP_XS}>
      <CommandButton
        icon={<RibbonIcon.Resize size={HERO_ICON_SIZE} />}
        label="Fit to Window"
        tooltip="Zoom so the whole page is in view"
        data-testid="canvas-fit-page"
        onClick={fitActiveCanvasToWindow}
      />
      <CommandButton
        icon={<RibbonIcon.Search size={HERO_ICON_SIZE} />}
        label="Actual Size"
        tooltip="Show the page at 100%"
        data-testid="canvas-actual-size"
        onClick={showActiveCanvasAtActualSize}
      />
      <CommandButton
        icon={<RibbonIcon.Pencil size={HERO_ICON_SIZE} />}
        label="Design Mode"
        active={designMode}
        tooltip="Design mode: select buttons and floating grids to move them instead of using them"
        data-testid="canvas-design-mode"
        onClick={toggleDesignMode}
      />
    </ActionRow>
  );
}

// ============================================================================
// The panel
// ============================================================================

export const CanvasPanelDefinition: PanelDefinition = {
  id: CANVAS_TAB_ID,
  title: "Canvas",
  icon: <RibbonIcon.Layout size={ICON_SIZE_SM} />,
  sections: [
    {
      id: "canvas-tab.insert",
      label: "Insert",
      icon: <RibbonIcon.Plus size={ICON_SIZE_MD} />,
      component: CanvasInsertSection,
      // Eight heroes: the widest section, so it is the one that folds into a
      // launcher first when the window is narrow -- the snap controls stay.
      collapsePriority: 2,
    },
    {
      id: "canvas-tab.snap",
      label: "Snap",
      icon: <RibbonIcon.Gridlines size={ICON_SIZE_MD} />,
      component: CanvasSnapSection,
      ribbonPresentation: "inline",
      collapsePriority: 4,
    },
    {
      id: "canvas-tab.page",
      label: "Page",
      icon: <RibbonIcon.PageSize size={ICON_SIZE_MD} />,
      component: CanvasPageSection,
      ribbonPresentation: "inline",
      collapsePriority: 3,
    },
    {
      id: "canvas-tab.view",
      label: "View",
      icon: <RibbonIcon.Eye size={ICON_SIZE_MD} />,
      component: CanvasViewSection,
      ribbonPresentation: "inline",
      collapsePriority: 1,
    },
  ],
  defaultPlacement: "ribbon",
  ribbonOrder: 505,
  ribbonColor: CANVAS_TAB_COLOR,
  // Navigating to a canvas brings its tab forward, and leaving puts the tab
  // the user had back (RibbonContainer's activate-on-register rule).
  ribbonActivateOnRegister: true,
  priority: 1000 - 505,
};
