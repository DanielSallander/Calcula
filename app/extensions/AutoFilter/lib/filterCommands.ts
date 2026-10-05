//! FILENAME: app/extensions/AutoFilter/lib/filterCommands.ts
// PURPOSE: The `autofilter.clear` and `autofilter.reapply` commands -- the
//          Home tab's Sort & Filter > Clear / Reapply, the Data menu's Clear
//          Filter / Reapply, and any script or key that names them.
// CONTEXT: Home tab 2026-10-04. Both existed only as Data-menu ACTIONS (a
//          callback with no id), so the ribbon had nothing to execute and a
//          second copy of each would have been the only way to add them -- the
//          drift the Seam Rule exists to prevent. They act on the SHEET's filter,
//          never on Core's selection, so they are not selection-owner doors
//          (exactly as removing a filter is not; see toggleFilter).

import { ExtensionCommands } from "@api/commands";
import { showToast } from "@api/notifications";
import { clearFilterCriteria, hasActiveFilter, reapplyFilterCriteria } from "./filterStore";

/** The slice of the command API this module needs (ExtensionContext.commands). */
interface CommandsLike {
  register(id: string, handler: (args?: unknown) => unknown): void;
  unregister(id: string): void;
}

function messageOf(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Clear every column's criteria; the filter (and its buttons) stays. With no
 * filter there is nothing to clear -- Excel greys the button; a command that
 * arrives anyway (a key, a script) says why it did nothing. A refusal (a
 * protected sheet) is shown, where the Data menu's old action dropped it.
 */
export async function clearFilterCommand(): Promise<void> {
  if (!hasActiveFilter()) {
    showToast("There is no filter on this sheet to clear.", { variant: "info" });
    return;
  }
  try {
    await clearFilterCriteria(null);
  } catch (err) {
    showToast(messageOf(err), { variant: "error" });
  }
}

/** Re-run the filter over the data as it is now (rows edited since it was
 *  applied are shown or hidden again). */
export async function reapplyFilterCommand(): Promise<void> {
  if (!hasActiveFilter()) {
    showToast("There is no filter on this sheet to reapply.", { variant: "info" });
    return;
  }
  try {
    await reapplyFilterCriteria();
  } catch (err) {
    showToast(messageOf(err), { variant: "error" });
  }
}

/** Register both commands; returns the cleanup for deactivation. */
export function registerAutoFilterCommands(commands: CommandsLike): () => void {
  commands.register(ExtensionCommands.FILTER_CLEAR, () => clearFilterCommand());
  commands.register(ExtensionCommands.FILTER_REAPPLY, () => reapplyFilterCommand());
  return () => {
    commands.unregister(ExtensionCommands.FILTER_CLEAR);
    commands.unregister(ExtensionCommands.FILTER_REAPPLY);
  };
}
