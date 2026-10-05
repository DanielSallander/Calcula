//! FILENAME: app/extensions/BuiltIn/HomeTab/components/editing/index.ts
// PURPOSE: The Home tab's Editing group controls (Excel's Editing group), one
//          per catalog item, each taking HomeItemProps:
//            autoSum    -> AutoSumSplitButton    (icon split + menu)
//            fill       -> FillMenuButton        (icon menu button)
//            clear      -> ClearMenuButton       (icon menu button)
//            sortFilter -> SortFilterMenuButton  (hero menu button)
//            findSelect -> FindSelectMenuButton  (hero menu button)
// CONTEXT: HomeTabGroupComponent dispatches to these by item id. They run
//          every command through CommandRegistry (../runCommand, the Home
//          tab's one command door), so the group's formatting state is not
//          used.

export { AutoSumSplitButton, AUTOSUM_MENU_ROWS } from "./AutoSumSplitButton";
export type { AutoSumFunction } from "./AutoSumSplitButton";
export { FillMenuButton } from "./FillMenuButton";
export { ClearMenuButton } from "./ClearMenuButton";
export { SortFilterMenuButton } from "./SortFilterMenuButton";
export { FindSelectMenuButton, FIND_SELECT_QUICK_ROWS, FIND_SELECT_ROWS_ON_CANVAS } from "./FindSelectMenuButton";
