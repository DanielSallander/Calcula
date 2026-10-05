//! FILENAME: app/extensions/Sorting/lib/sortCommands.ts
// PURPOSE: The sort.ascending / sort.descending / sort.customDialog commands --
//          the ids the Home tab's Sort & Filter menu and the Data menu both run.
// CONTEXT: Home tab 2026-10-04. Sort A to Z, Sort Z to A and Custom Sort...
//          were Data-menu ACTIONS with no command id, so the ribbon had nothing
//          to execute; StandardMenus-style "open the dialog by id" from the
//          ribbon would have copied the dialog's payload into a second place
//          (survey editing.md §4). The commands decide what to sort ONCE
//          (lib/quickSort.ts) for every door.

import { ExtensionCommands } from "@api/commands";
import { showDialog } from "@api/ui";
import { showToast } from "@api/notifications";
import { decideSortTarget, runQuickSort } from "./quickSort";

/** Registered by this extension (index.ts): the multi-level Sort dialog. */
export const SORT_DIALOG_ID = "sort-dialog";

/** The slice of the command API this module needs (ExtensionContext.commands). */
interface CommandsLike {
  register(id: string, handler: (args?: unknown) => unknown): void;
  unregister(id: string): void;
}

/**
 * Custom Sort...: the Sort dialog, opened on the SAME block and header choice
 * the quick sort would use (Excel asks its Sort Warning here too), so "My data
 * has headers" starts as Excel's guess rather than "more than one row".
 */
export async function openCustomSort(): Promise<void> {
  let target;
  try {
    target = await decideSortTarget("Custom Sort");
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), { variant: "error" });
    return;
  }
  if (!target) return;
  showDialog(SORT_DIALOG_ID, {
    range: { ...target.range },
    hasHeaders: target.hasHeaders,
    sortCol: target.sortCol,
  });
}

/** Register the three commands; returns the cleanup for deactivation. */
export function registerSortCommands(commands: CommandsLike): () => void {
  commands.register(ExtensionCommands.SORT_ASCENDING, () => runQuickSort(true));
  commands.register(ExtensionCommands.SORT_DESCENDING, () => runQuickSort(false));
  commands.register(ExtensionCommands.SORT_CUSTOM, () => openCustomSort());
  return () => {
    commands.unregister(ExtensionCommands.SORT_ASCENDING);
    commands.unregister(ExtensionCommands.SORT_DESCENDING);
    commands.unregister(ExtensionCommands.SORT_CUSTOM);
  };
}
