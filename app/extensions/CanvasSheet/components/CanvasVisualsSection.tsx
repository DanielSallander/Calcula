//! FILENAME: app/extensions/CanvasSheet/components/CanvasVisualsSection.tsx
// PURPOSE: The Canvas tab's VISUALS group (Power BI's Visualizations pane, on
//          the ribbon): two 28px rows of icon buttons laid out like the pane's
//          first two rows, and an All Visuals hero whose card is the whole
//          catalogue (lib/canvasVisuals.ts).
// CONTEXT: The ribbon grammar's fill rule (docs/design/ribbon-design-system.md):
//          two 28px rows fill the band's 61px box, and the hero beside them is
//          one tall column.
//
//          THE CARD is a TileGallery: six columns, grouped under the
//          catalogue's headings, a single-select listbox whose arrow keys move
//          in two dimensions across the groups (the kit's rule). Captions off:
//          Power BI's pane is pictures only, each named by its tooltip and its
//          accessible name. A pick closes the card, gives focus back to the
//          hero and inserts the visual through its owner.
//
//          IN A PANEL (the sidebar, or the band's launcher flyout once the
//          group has folded) there is no band to fill: the whole catalogue is
//          shown inline as the same gallery -- the Chart Design type gallery's
//          precedent. There the Matrix and Slicer TILES carry the kept ids
//          (below): a panel has no band rows, so without them the ids live
//          specs press would vanish whenever the group folds.
//
//          TEST IDS. A row button is `canvas-visual-<id>`, except the two rows
//          that ARE the old Insert heroes and keep their ids: Matrix
//          (`canvas-insert-pivot`) and Slicer (`canvas-insert-slicer`) -- live
//          E2E specs press them. A gallery tile is `canvas-visual-gallery-<id>`
//          (Chart Design's "chart-type" / "chart-type-gallery" precedent), so a
//          row and its tile never share an id while the card is open over the
//          band -- except IN A PANEL, where the Matrix and Slicer tiles take the
//          kept ids themselves (`visualRowTestId`): no row exists there to
//          collide with, and the kept ids must exist wherever the group is.
//
//          A SUBSCRIBED canvas is the publisher's layout: every insert is
//          disabled with the one note every Canvas group shows.

import React, { useEffect, useRef, useState } from "react";
import type { PanelSectionProps } from "@api/uiTypes";
import {
  CommandButton,
  ControlGrid,
  ControlGridBreak,
  ControlRow,
  GAP_XS,
  HERO_ICON_SIZE,
  ICON_SIZE_MD,
  ICON_SIZE_SM,
  IconButton,
  Popover,
  StatusText,
  SurfaceLayoutProvider,
  TileGallery,
  popoverLayout,
  useSurfaceLayout,
  type TileGalleryItem,
} from "@api/layout";
import { RibbonIcon } from "@api/ribbonIcons";
import {
  CANVAS_VISUALS,
  CANVAS_VISUAL_ROWS,
  canvasVisual,
  VISUAL_GALLERY_TEST_ID,
  insertCanvasVisual,
  visualRowTestId,
  type CanvasVisualId,
} from "../lib/canvasVisuals";
import { SUBSCRIBED_NOTE } from "../lib/canvasNotes";
import { IconByKey } from "./tabParts";
import { useCanvasSheet } from "./canvasHooks";

/** Columns of the All Visuals card (Power BI's pane is six wide). */
const CARD_COLUMNS = 6;
/** Columns of the inline gallery in a panel (a sidebar is narrower). */
const PANEL_COLUMNS = 4;

const GALLERY_ITEMS: readonly TileGalleryItem<CanvasVisualId>[] = CANVAS_VISUALS.map((v) => ({
  value: v.id,
  label: v.label,
  group: v.group,
  icon: <IconByKey name={v.icon} size={ICON_SIZE_MD} />,
}));

/** The ids a band row keeps from the old Insert group (Matrix, Slicer). */
const KEPT_ROW_IDS: ReadonlySet<CanvasVisualId> = new Set(
  CANVAS_VISUALS.map((v) => v.id).filter((id) => visualRowTestId(id) !== `canvas-visual-${id}`),
);

/** The panel's gallery: the same tiles, the kept ones under their kept ids. */
const PANEL_ITEMS: readonly TileGalleryItem<CanvasVisualId>[] = GALLERY_ITEMS.map((item) =>
  KEPT_ROW_IDS.has(item.value) ? { ...item, testId: visualRowTestId(item.value) } : item,
);

function VisualsGallery({
  items,
  columns,
  onPick,
}: {
  items: readonly TileGalleryItem<CanvasVisualId>[];
  columns: number;
  onPick: (id: CanvasVisualId) => void;
}): React.ReactElement {
  return (
    <TileGallery<CanvasVisualId>
      items={items}
      value={null}
      onChange={onPick}
      columns={columns}
      showLabels={false}
      testIdPrefix={VISUAL_GALLERY_TEST_ID}
      ariaLabel="All visuals"
    />
  );
}

export function CanvasVisualsSection(_props: PanelSectionProps): React.ReactElement | null {
  const { active, activeSubscribed } = useCanvasSheet();
  const band = useSurfaceLayout().container === "band";
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Focus the gallery's first tile once the card is visible (it renders hidden
  // for the measuring pass, and a hidden element cannot take focus).
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      const box = bodyRef.current;
      if (!box || box.contains(document.activeElement)) return;
      box.querySelector<HTMLElement>('[role="option"][tabindex="0"]')?.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [open]);

  if (!active) return null;
  const subscribed = activeSubscribed;

  if (!band) {
    if (subscribed) return <StatusText>{SUBSCRIBED_NOTE}</StatusText>;
    return <VisualsGallery items={PANEL_ITEMS} columns={PANEL_COLUMNS} onPick={(id) => void insertCanvasVisual(id)} />;
  }

  const close = (): void => setOpen(false);
  const rowButton = (id: CanvasVisualId): React.ReactElement => {
    const v = canvasVisual(id);
    return (
      <IconButton
        key={id}
        icon={<IconByKey name={v.icon} size={ICON_SIZE_SM} />}
        label={v.label}
        // Power BI names a pane picture by its visual, nothing more.
        tooltip={subscribed ? SUBSCRIBED_NOTE : v.label}
        disabled={subscribed}
        data-testid={visualRowTestId(id)}
        onClick={() => void insertCanvasVisual(id)}
      />
    );
  };

  return (
    <ControlRow gap={GAP_XS} align="stretch">
      <ControlGrid bandRows={2} splitAt={0}>
        {CANVAS_VISUAL_ROWS[0].map(rowButton)}
        <ControlGridBreak />
        {CANVAS_VISUAL_ROWS[1].map(rowButton)}
      </ControlGrid>
      <CommandButton
        ref={setAnchor}
        icon={<RibbonIcon.AllVisuals size={HERO_ICON_SIZE} />}
        label="All Visuals"
        chevron
        disabled={subscribed}
        tooltip={subscribed ? SUBSCRIBED_NOTE : "Every visual a report page can hold: charts, cards, tables and filters"}
        aria-haspopup="dialog"
        aria-expanded={open && !subscribed}
        data-testid="canvas-all-visuals"
        onClick={() => setOpen((o) => !o)}
      />
      <Popover card anchorEl={anchor} open={open && !subscribed} onClose={close} heading="Visuals">
        <SurfaceLayoutProvider value={popoverLayout()}>
          <div ref={bodyRef}>
            <VisualsGallery
              items={GALLERY_ITEMS}
              columns={CARD_COLUMNS}
              onPick={(id) => {
                close();
                anchor?.focus();
                void insertCanvasVisual(id);
              }}
            />
          </div>
        </SurfaceLayoutProvider>
      </Popover>
    </ControlRow>
  );
}
