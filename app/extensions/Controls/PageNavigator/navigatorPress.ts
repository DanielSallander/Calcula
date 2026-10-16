//! FILENAME: app/extensions/Controls/PageNavigator/navigatorPress.ts
// PURPOSE: A RUN-MODE press on a Page Navigator item: it navigates at the
//          RELEASE over the same item, the button rule (WP-B, D-NAV).
// CONTEXT: In run mode a navigator item is CONTENT (lib/controlZoneAt.ts, part
//          `navItem:<key>`), so Core hands the press to
//          `floatingObject:bodyDragStart` and never moves the navigator. The
//          press is held by lib/buttonPress.ts exactly as a button's is -- the
//          item looks pressed while the pointer is over it, Escape / blur / a
//          lost release cancel -- with one more condition: the release must be
//          over the SAME item. A press on page A that slides onto page B and
//          lets go there opens neither.
//
//          WHAT RUNS is the declarative navigate action (lib/buttonActions.ts
//          `performButtonAction`), the same one a navigation button performs:
//          the switch through @api/sheetSwitch, a hidden page's info toast, and
//          nothing at all for the page already on screen. Never `button:clicked`
//          and never the script door: a navigator has no code (Rust's door
//          refuses a non-button anyway), and a report reader's navigation must
//          work with Script Security off and on a subscribed page.
//
//          The item is re-read BY KEY at the release, from the live
//          description, so the page it opens is the one the item names THEN (a
//          page renamed while the press was held still opens).
//
//          A press on the space between items (`navGap`) arms nothing.

import { beginFloatingButtonPress } from "../lib/buttonPress";
import { performButtonAction } from "../lib/buttonActions";
import { floatingControlCanvasPoint } from "../lib/controlHitTest";
import { describePageNavigatorView } from "./describe";
import { navigatorItemAt, parseNavItemPart } from "./navigatorModel";
import { getControlContainer } from "../lib/controlContainer";

/** A run-mode press on a navigator, as Controls' bodyDragStart listener hands it over. */
export interface PageNavigatorPress {
  /** The control's id (the floating store's key). */
  controlId: string;
  /** Its published region id. */
  regionId: string;
  /** The sheet the navigator sits on. */
  sheetIndex: number;
  /** The zone part Core carried (`navItem:<key>` or `navGap`). */
  part: string | null | undefined;
}

/** The key of the item of navigator `controlId` under a client point, or null (a gap, outside, not live). */
export function navigatorItemKeyAtClient(
  controlId: string,
  regionId: string,
  clientX: number,
  clientY: number,
): string | null {
  const at = floatingControlCanvasPoint(regionId, clientX, clientY);
  if (!at) return null;
  const { props, items } = describePageNavigatorView(controlId);
  return navigatorItemAt(at.bounds, items, props, at.point, { regionId, container: getControlContainer(controlId) })?.key ?? null;
}

/**
 * Start a run-mode press on a navigator item. Returns false (and arms nothing)
 * when the part names no item -- a press on a gap.
 */
export function pressPageNavigatorItem(press: PageNavigatorPress): boolean {
  const itemKey = parseNavItemPart(press.part);
  if (!itemKey) return false;
  const { controlId, regionId, sheetIndex } = press;
  beginFloatingButtonPress({
    controlId,
    regionId,
    itemKey,
    itemAtClient: (clientX, clientY) => navigatorItemKeyAtClient(controlId, regionId, clientX, clientY),
    run: () => {
      const item = describePageNavigatorView(controlId).items.find((i) => i.key === itemKey);
      // The page left the list while the press was held: nothing to open.
      if (!item) return;
      void performButtonAction(
        item.sheetId
          ? { kind: "navigate", sheetId: item.sheetId, sheetName: item.sheetName }
          : { kind: "navigate", sheetName: item.sheetName },
        sheetIndex,
      );
    },
  });
  return true;
}
