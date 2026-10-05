//! FILENAME: app/extensions/BuiltIn/HomeTab/components/homeItemProps.ts
// PURPOSE: The one props shape every Home-tab item component takes.
// CONTEXT: Excel's Home tab (2026-10-04) gave many catalog items a control of
//          their own -- the Paste and Insert/Delete split buttons, the Borders
//          and Underline splits, the Orientation, Fill, Clear, Sort & Filter and
//          Find & Select menus. Each lives in its own file under components/
//          and is dispatched by item id from HomeTabGroupComponent. They all
//          take THIS shape, so the dispatcher stays a lookup and a component
//          can be rendered alone in a test.

import type { HomeTabItem } from "../homeTabConfig";
import type { useHomeTabState } from "./useHomeTabState";

/** The shared formatting state and actions of one Home group
 *  (`useHomeTabState()`, called once per group by HomeTabGroupComponent). */
export type HomeTabState = ReturnType<typeof useHomeTabState>;

export interface HomeItemProps {
  /** The catalog entry this control renders. Its `id` is the control's
   *  `data-testid` suffix (`fmt-<id>`) and is persisted in saved layouts. */
  item: HomeTabItem;
  /** The group's shared state and formatting door (applyFormat refuses while
   *  something else owns the selection and refreshes the ribbon after). */
  state: HomeTabState;
  /** True in the ribbon band; false in the sidebar or a launcher flyout, where
   *  heroes render as standard 28px controls. */
  band: boolean;
}
