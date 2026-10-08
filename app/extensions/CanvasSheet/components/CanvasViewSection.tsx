//! FILENAME: app/extensions/CanvasSheet/components/CanvasViewSection.tsx
// PURPOSE: The Canvas tab's VIEW group (Power BI's View > Scale to fit and Page
//          options): Page View v (Fit to Page, Fit to Width, Actual Size), the
//          page options grid [Gridlines, Snap to Grid / Lock Objects, Grid
//          size], and Design Mode.
// CONTEXT: A hero, a two-row grid, a hero (the ribbon grammar's fill rule).
//
//          PAGE VIEW. Three radio rows, checked by the zoom the page is shown
//          at NOW (lib/canvasActions.ts `currentPageView`): a Page View is a
//          one-shot zoom in Calcula, so the menu never claims "Fit to Page"
//          for a page the user has since zoomed by hand. The rows are read
//          when the menu OPENS -- a zoom change announces nothing the tab
//          could re-render on.
//
//          PAGE OPTIONS. Gridlines shows the snap grid's dots; Snap to Grid
//          snaps a dragged or resized edge (Alt moves freely); Lock Objects is
//          Power BI's "Lock all objects on the canvas so that they can't be
//          moved or resized" (CanvasLayout.objectsLocked, enforced by the
//          backend, explained by lib/objectsLock.ts); Grid size is Calcula's
//          own pitch. None is undoable (decision D1, the backend's rule for
//          page settings); each is saved with the document.
//
//          DESIGN MODE: select buttons to move them instead of running them
//          (Core's session flag; a floating grid moves by its title bar in
//          any mode).
//
//          A SUBSCRIBED canvas: the page options are the publisher's layout
//          and are disabled with the one note; Page View and Design Mode are
//          how the READER looks at the page and stay theirs.

import React from "react";
import { toggleDesignMode } from "@api";
import type { PanelSectionProps } from "@api/uiTypes";
import {
  CommandButton,
  ControlGrid,
  ControlGridBreak,
  ControlRow,
  Field,
  GAP_XS,
  HERO_ICON_SIZE,
  ICON_SIZE_SM,
  MenuButton,
  MenuItem,
  ToggleButton,
} from "@api/layout";
import { RibbonIcon } from "@api/ribbonIcons";
import { CANVAS_MAX_GRID_SIZE_PX, CANVAS_MIN_GRID_SIZE_PX, canvasObjectsLocked } from "@api/canvasSheet";
import {
  currentPageView,
  fitActiveCanvasToWidth,
  fitActiveCanvasToWindow,
  patchActiveCanvasLayout,
  showActiveCanvasAtActualSize,
  type PageViewMode,
} from "../lib/canvasActions";
import { SUBSCRIBED_NOTE } from "../lib/canvasNotes";
import { CommitNumberField } from "./CommitNumberField";
import { useCanvasSheet, useDesignMode } from "./canvasHooks";

/** A menu row's picture size. */
const ROW_ICON = 20;

const PAGE_VIEW_ROWS: ReadonlyArray<{
  mode: PageViewMode;
  label: string;
  icon: React.ReactNode;
  run: () => void;
}> = [
  { mode: "fitPage", label: "Fit to Page", icon: <RibbonIcon.FitToPage size={ROW_ICON} />, run: () => fitActiveCanvasToWindow() },
  { mode: "fitWidth", label: "Fit to Width", icon: <RibbonIcon.FitToWidth size={ROW_ICON} />, run: () => fitActiveCanvasToWidth() },
  { mode: "actual", label: "Actual Size", icon: <RibbonIcon.ActualSize size={ROW_ICON} />, run: () => showActiveCanvasAtActualSize() },
];

/** The three rows, checked by the zoom read as the menu opens (see the header). */
function PageViewRows(): React.ReactElement {
  const mode = currentPageView();
  return (
    <>
      {PAGE_VIEW_ROWS.map((row) => (
        <MenuItem
          key={row.mode}
          role="menuitemradio"
          checked={mode === row.mode}
          icon={row.icon}
          testId={`canvas-page-view-${row.mode}`}
          onSelect={row.run}
        >
          {row.label}
        </MenuItem>
      ))}
    </>
  );
}

export function CanvasViewSection(_props: PanelSectionProps): React.ReactElement | null {
  const { active, activeSubscribed } = useCanvasSheet();
  const designMode = useDesignMode();
  if (!active) return null;
  const { layout } = active;
  const subscribed = activeSubscribed;
  const locked = canvasObjectsLocked(layout);
  const tip = (why: string): string => (subscribed ? SUBSCRIBED_NOTE : why);

  return (
    <ControlRow gap={GAP_XS} align="stretch">
      <MenuButton
        ariaLabel="Page view"
        trigger={
          <CommandButton
            icon={<RibbonIcon.FitToPage size={HERO_ICON_SIZE} />}
            label="Page View"
            labelLines={2}
            chevron
            tooltip="Show the page fitted to the window, fitted to its width, or at its actual size"
            data-testid="canvas-page-view"
          />
        }
      >
        <PageViewRows />
      </MenuButton>
      <ControlGrid bandRows={2}>
        <ToggleButton
          icon={<RibbonIcon.ShowGrid size={ICON_SIZE_SM} />}
          active={layout.showGrid}
          disabled={subscribed}
          tooltip={tip("Show the snap grid's dots on the page while you lay it out")}
          data-testid="canvas-show-grid"
          onClick={() => void patchActiveCanvasLayout({ showGrid: !layout.showGrid })}
        >
          Gridlines
        </ToggleButton>
        <ToggleButton
          icon={<RibbonIcon.SnapToGrid size={ICON_SIZE_SM} />}
          active={layout.snapToGrid}
          disabled={subscribed}
          tooltip={tip("Snap an object's edges to the grid while you drag or resize it. Hold Alt to move freely.")}
          data-testid="canvas-snap-to-grid"
          onClick={() => void patchActiveCanvasLayout({ snapToGrid: !layout.snapToGrid })}
        >
          Snap to Grid
        </ToggleButton>
        <ControlGridBreak />
        <ToggleButton
          icon={<RibbonIcon.LockObjects size={ICON_SIZE_SM} />}
          active={locked}
          disabled={subscribed}
          tooltip={tip(
            locked
              ? "The objects on this page are locked: they cannot be moved or resized. Click to unlock them."
              : "Lock every object on this page so it cannot be moved or resized. You can still select, format and delete them.",
          )}
          data-testid="canvas-lock-objects"
          onClick={() => void patchActiveCanvasLayout({ objectsLocked: !locked })}
        >
          Lock Objects
        </ToggleButton>
        <Field label="Grid size">
          <CommitNumberField
            value={layout.gridSizePx}
            min={CANVAS_MIN_GRID_SIZE_PX}
            max={CANVAS_MAX_GRID_SIZE_PX}
            step={1}
            width={56}
            suffix="px"
            ariaLabel="Grid size in pixels"
            disabled={subscribed}
            testId="canvas-grid-size"
            onCommit={(gridSizePx) => void patchActiveCanvasLayout({ gridSizePx })}
          />
        </Field>
      </ControlGrid>
      <CommandButton
        icon={<RibbonIcon.DesignMode size={HERO_ICON_SIZE} />}
        label="Design Mode"
        labelLines={2}
        active={designMode}
        tooltip="Design mode: select buttons to move them instead of running them. A floating grid moves by its title bar in any mode; in Design Mode one with no title bar also moves by its body"
        data-testid="canvas-design-mode"
        onClick={toggleDesignMode}
      />
    </ControlRow>
  );
}
