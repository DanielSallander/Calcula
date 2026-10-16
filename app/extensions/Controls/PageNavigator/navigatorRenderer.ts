//! FILENAME: app/extensions/Controls/PageNavigator/navigatorRenderer.ts
// PURPOSE: Paint a Page Navigator: one button per listed page, divided equally
//          inside its box, the current page's in the selected colours (WP-B,
//          D-NAV).
// CONTEXT: Called synchronously every frame for each visible navigator region
//          (Controls/index.ts `renderFloatingControl`). It paints only from the
//          navigator's read-only description (describe.ts) and lays the items
//          out in the REGION's canvas box with the same pure functions the
//          zone uses (navigatorModel.ts `navigatorItemArea` +
//          `layoutNavigatorItems`), so what a reader sees is what a press hits.
//
//          THE ONE FETCH TRIGGER. This is the only place that starts the read of
//          the navigator's settings (`fetchPageNavigatorProps`): when nothing
//          is cached or the cache was invalidated, exactly as the button
//          renderer starts `fetchButtonData`. The fetch dedupes itself while a
//          read is on its way, and its arrival requests a redraw; until then the
//          frame paints the previous settings (stale while refetching) or the
//          defaults. It never calls `getSheets`: the page list is the
//          @api/reportPages snapshot, which Controls keeps live.
//
//          WHAT IT DRAWS, per item: a radius-3 face in the item's fill (the
//          CURRENT page's in `selectedFill`), its border, its caption clipped
//          to the item in the item's colour (`selectedColor` when current); a
//          PRESSED item gets the button's pressed wash and its caption one
//          pixel down and right; a hidden page's item (listed only with Show
//          hidden pages) is drawn faded -- it cannot be opened. In Design Mode
//          an unselected navigator shows the dotted outline every control
//          shows, and a selected ITEM a 2-px inset outline. With no page to
//          list, Design Mode says "No pages" and run mode draws nothing.

import type { OverlayRenderContext } from "@api/gridOverlays";
import type { ContainerRegion } from "@api/visualContainerPaint";
import {
  overlayGetColHeaderHeight,
  overlayGetRowHeaderWidth,
  overlaySheetToCanvas,
} from "@api/gridOverlays";
import { getDesignMode } from "../lib/designMode";
import { isFloatingControlSelected } from "../Button/floatingSelection";
import { BUTTON_PRESSED_SHADE } from "../Button/floatingRenderer";
import { describePageNavigatorView } from "./describe";
import { fetchPageNavigatorProps, getPageNavigatorProps, isPageNavigatorCacheFresh } from "./navigatorCache";
import { layoutNavigatorItems, navigatorItemArea } from "./navigatorModel";

/** Corner radius of an item's face (the button's). */
const ITEM_RADIUS = 3;
/** How faded a hidden page's item is drawn. */
export const HIDDEN_PAGE_ITEM_ALPHA = 0.45;
/** The Design-Mode outline colour (the button's). */
const DESIGN_OUTLINE = "#0078d4";
/** What an empty navigator says in Design Mode, and in which colour. */
export const NO_PAGES_TEXT = "No pages";
const NO_PAGES_COLOR = "#888";

/** Render one Page Navigator region. */
export function renderFloatingPageNavigator(overlayCtx: OverlayRenderContext): void {
  const { ctx, region } = overlayCtx;
  if (!region.floating) return;

  const sheetIndex = region.data?.sheetIndex as number;
  const row = region.data?.row as number;
  const col = region.data?.col as number;
  if (sheetIndex == null || row == null || col == null) return;

  const controlId = region.id;
  // THE one fetch trigger: missing or invalidated settings are read again.
  if (!getPageNavigatorProps(controlId) || !isPageNavigatorCacheFresh(controlId)) {
    void fetchPageNavigatorProps(controlId, sheetIndex, row, col);
  }

  const rowHeaderWidth = overlayGetRowHeaderWidth(overlayCtx);
  const colHeaderHeight = overlayGetColHeaderHeight(overlayCtx);
  const { canvasX, canvasY } = overlaySheetToCanvas(overlayCtx, region.floating.x, region.floating.y);
  const box = { x: canvasX, y: canvasY, width: region.floating.width, height: region.floating.height };

  // Off screen: nothing to paint (the fetch above still keeps the cache warm).
  if (box.x + box.width < rowHeaderWidth || box.y + box.height < colHeaderHeight) return;
  if (box.x > overlayCtx.canvasWidth || box.y > overlayCtx.canvasHeight) return;

  const { props, items } = describePageNavigatorView(controlId);
  const designMode = getDesignMode();

  ctx.save();
  // Clip to the cell area (never over the headers).
  ctx.beginPath();
  ctx.rect(
    rowHeaderWidth,
    colHeaderHeight,
    overlayCtx.canvasWidth - rowHeaderWidth,
    overlayCtx.canvasHeight - colHeaderHeight,
  );
  ctx.clip();

  ctx.font = `${props.fontSize}px system-ui`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  if (items.length === 0) {
    if (designMode) {
      ctx.fillStyle = NO_PAGES_COLOR;
      ctx.fillText(NO_PAGES_TEXT, box.x + box.width / 2, box.y + box.height / 2);
    }
  } else {
    // The items divide the CONTENT RECT (WP-C D-FORMAT): Core painted the
    // container round it and answers its band, so paint, zone and press agree.
    const rects = layoutNavigatorItems(
      navigatorItemArea(box, props, { regionId: region.id, container: (region as ContainerRegion).container }),
      items.length,
      props,
    );
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const r = rects[i];
      if (!r || r.width <= 0 || r.height <= 0) continue;
      ctx.save();
      if (item.hiddenPage) ctx.globalAlpha = HIDDEN_PAGE_ITEM_ALPHA;
      const baseAlpha = ctx.globalAlpha;

      // 1. Face: the current page's in the selected fill.
      ctx.beginPath();
      ctx.roundRect(r.x, r.y, r.width, r.height, ITEM_RADIUS);
      ctx.fillStyle = item.current ? props.selectedFill : item.fill;
      ctx.fill();

      // 2. Pressed: the button's black wash over the face.
      if (item.pressed) {
        ctx.beginPath();
        ctx.roundRect(r.x, r.y, r.width, r.height, ITEM_RADIUS);
        ctx.fillStyle = "#000000";
        ctx.globalAlpha = baseAlpha * BUTTON_PRESSED_SHADE;
        ctx.fill();
        ctx.globalAlpha = baseAlpha;
      }

      // 3. Border.
      ctx.beginPath();
      ctx.roundRect(r.x + 0.5, r.y + 0.5, Math.max(0, r.width - 1), Math.max(0, r.height - 1), ITEM_RADIUS);
      ctx.lineWidth = 1;
      ctx.strokeStyle = item.borderColor;
      ctx.stroke();

      // 4. Caption, clipped to the item; one pixel down and right when pressed.
      const offset = item.pressed ? 1 : 0;
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.x + 4, r.y, Math.max(0, r.width - 8), r.height);
      ctx.clip();
      ctx.fillStyle = item.current ? props.selectedColor : item.color;
      ctx.fillText(item.caption, r.x + r.width / 2 + offset, r.y + r.height / 2 + offset);
      ctx.restore();

      // 5. Design Mode: the selected item's 2-px inset outline.
      if (designMode && item.selected) {
        ctx.beginPath();
        ctx.rect(r.x + 1, r.y + 1, Math.max(0, r.width - 2), Math.max(0, r.height - 2));
        ctx.lineWidth = 2;
        ctx.strokeStyle = DESIGN_OUTLINE;
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  // Design Mode: an UNSELECTED navigator shows the dotted outline every control
  // shows (a SELECTED one's outline and handles are Core's chrome).
  if (designMode && !isFloatingControlSelected(controlId)) {
    ctx.beginPath();
    ctx.roundRect(box.x - 1, box.y - 1, box.width + 2, box.height + 2, ITEM_RADIUS + 1);
    ctx.lineWidth = 1;
    ctx.strokeStyle = DESIGN_OUTLINE;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.restore();
}
