//! FILENAME: app/extensions/Controls/PageNavigator/describe.ts
// PURPOSE: THE read of a Page Navigator as a reader sees it right now: its
//          settings, its items (one per listed page, derived live), which item
//          is the current page, which one is pressed, and where each sits
//          (WP-B, D-NAV).
// CONTEXT: The paint, the zone (hover + press routing), the run-mode press and
//          the live E2E proof all ask HERE, so they cannot disagree about which
//          item is where or which page is current.
//
//          READ-ONLY, AND THAT IS A CONTRACT. `describePageNavigator` is called
//          from the control's `zoneAt`, which @api/gridOverlays requires to be
//          PURE (no store writes, no dispatch): it is asked on every hover move
//          and once per press, before the press selects anything. So nothing
//          here fetches, writes or dispatches. With no settings cached yet it
//          describes the navigator from PAGE_NAVIGATOR_DEFAULTS; the renderer
//          (navigatorRenderer.ts) is the ONE place that starts the read that
//          fills the cache, and its arrival repaints.
//
//          THE CURRENT PAGE IS DECIDED BY ID: the grid's active sheet INDEX
//          (paint-time truth) -> the @api/reportPages snapshot's page at that
//          index -> its key (`currentPageKey`). A page renamed while active is
//          still current.

import { PAGE_NAVIGATOR_CONTROL_TYPE } from "@api/buttonControlService";
import { getGridStateSnapshot } from "@api/grid";
import { getReportPagesSnapshot } from "@api/reportPages";
import { isFloatingButtonPressed } from "../lib/buttonPress";
import { getFloatingControl } from "../lib/floatingStore";
import { getControlContainer } from "../lib/controlContainer";
import { getPageNavigatorProps } from "./navigatorCache";
import { getSelectedNavigatorItem } from "./navigatorItemSelection";
import {
  currentPageKey,
  layoutNavigatorItems,
  navigatorItemArea,
  navigatorItems,
  readPageNavigatorProps,
  type NavigatorItem,
  type NavigatorRect,
  type PageNavigatorProps,
} from "./navigatorModel";

/** One item of a described navigator: its page, its style, its state. */
export interface DescribedNavigatorItem extends NavigatorItem {
  /** Where it sits, in SHEET px (the navigator's box is region.floating). */
  rect: NavigatorRect;
  /** Its page is the one on screen (by sheet id). */
  current: boolean;
  /** A run-mode press on it is held with the pointer over it. */
  pressed: boolean;
  /** Selected in Design Mode (the second press of the chart-ladder model). */
  selected: boolean;
}

/** A navigator as a reader sees it right now. */
export interface PageNavigatorDescription {
  controlId: string;
  /** The navigator's box, SHEET px (region.floating). */
  box: NavigatorRect;
  /** Its settings: cached, or the defaults while the first read is on its way. */
  props: PageNavigatorProps;
  /** One per listed page, in tab order. */
  items: DescribedNavigatorItem[];
}

/** The settings and items of a navigator, without geometry. */
export interface PageNavigatorView {
  props: PageNavigatorProps;
  items: Array<NavigatorItem & { current: boolean; pressed: boolean; selected: boolean }>;
}

/**
 * The settings and the items of navigator `controlId` with their state --
 * everything but WHERE they are, which depends on the box the caller works in
 * (sheet px for `describePageNavigator`, canvas px for the zone and the paint).
 * Never null: an unknown id has default settings. Read-only.
 */
export function describePageNavigatorView(controlId: string): PageNavigatorView {
  const props = getPageNavigatorProps(controlId) ?? readPageNavigatorProps(null);
  const pages = getReportPagesSnapshot().pages;
  const currentKey = currentPageKey(pages, getGridStateSnapshot()?.sheetContext?.activeSheetIndex);
  // The Design-Mode item selection (the second press, navigatorItemSelection.ts).
  // A selection whose key is no longer one of THESE items marks nothing: the
  // read never writes, so the stale key is simply not found (the selection
  // module drops it on the page-list change that removed it).
  const sel = getSelectedNavigatorItem();
  const selectedKey = sel !== null && sel.controlId === controlId ? sel.itemKey : null;
  const items = navigatorItems(pages, props).map((item) => ({
    ...item,
    current: currentKey !== null && item.key === currentKey,
    pressed: isFloatingButtonPressed(controlId, item.key),
    selected: selectedKey !== null && item.key === selectedKey,
  }));
  return { props, items };
}

/**
 * Navigator `controlId` as a reader sees it right now, in SHEET px, or null
 * when no Page Navigator with that id is loaded. READ-ONLY: never fetches,
 * never writes a store, never dispatches (it is the zone's read too).
 */
export function describePageNavigator(controlId: string): PageNavigatorDescription | null {
  const ctrl = getFloatingControl(controlId);
  if (!ctrl || ctrl.controlType !== PAGE_NAVIGATOR_CONTROL_TYPE) return null;
  const box: NavigatorRect = { x: ctrl.x, y: ctrl.y, width: ctrl.width, height: ctrl.height };
  const { props, items } = describePageNavigatorView(controlId);
  // The container the region is published with (WP-C D-FORMAT): the same
  // content rect the paint and the zone divide.
  const rects = layoutNavigatorItems(
    navigatorItemArea(box, props, { regionId: controlId, container: getControlContainer(controlId) }),
    items.length,
    props,
  );
  return {
    controlId,
    box,
    props,
    items: items.map((item, i) => ({ ...item, rect: rects[i] })),
  };
}
