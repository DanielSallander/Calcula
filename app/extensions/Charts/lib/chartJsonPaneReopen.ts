//! FILENAME: app/extensions/Charts/lib/chartJsonPaneReopen.ts
// PURPOSE: View > Show "Chart JSON" opens the Chart JSON pane.
// CONTEXT: The View menu's "Show <pane>" item does not open a pane itself: it
//          clears the pane's manually-closed mark and dispatches
//          `taskpane:requestReopen` with the view id (StandardMenus/ViewMenu.ts),
//          and the pane's OWNER answers. Nothing answered for "chart-json", so
//          the menu item was offered while a chart was selected and did nothing
//          (WP-C S9a; the object pane answers for "object-pane" itself, Pivot
//          for "pivot-editor").

/** The event the View menu dispatches. */
export const TASK_PANE_REOPEN_EVENT = "taskpane:requestReopen";

/**
 * Answer `taskpane:requestReopen` for `viewId` by calling `open`. Returns the
 * uninstall.
 */
export function installTaskPaneReopen(viewId: string, open: () => void): () => void {
  const handler = (e: Event): void => {
    const detail = (e as CustomEvent<{ viewId?: string }>).detail;
    if (detail?.viewId === viewId) open();
  };
  window.addEventListener(TASK_PANE_REOPEN_EVENT, handler);
  return () => window.removeEventListener(TASK_PANE_REOPEN_EVENT, handler);
}
