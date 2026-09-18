//! FILENAME: app/extensions/Insights/lib/overlayMenu.ts
// PURPOSE: The overlay's entries on the chart context menu — the "popover"
//          of §4.8a, scoped to the cue the reader selected.
// CONTEXT: The chart context menu already takes contributions from other
//          extensions (`@api/chartContextMenu`, the seam "Explain this chart"
//          uses), and the transient store already knows which cue is selected
//          on a chart. So a right-click on a ringed bar after clicking it IS
//          the popover: the sentence is the tooltip, and the actions are
//          menu items visible only while a cue is selected. No new surface,
//          no new component, nothing to keep in sync.
//
//          The words come through `promptAsync` from `@api/dialogs` — the
//          in-app prompt that works under Tauri; the bare `prompt()` global is
//          banned repo-wide and would not even return a string here.

import { registerChartContextMenuContribution } from "@api/chartContextMenu";
import { getChartDataProvider } from "@api/chartData";
import { getSelectedChartCue, keepChartCue, snapshotChart } from "@api/chartCues";
import { registerChartQuickAction } from "@api/chartQuickActions";
import { promptAsync } from "@api/dialogs";
import { showToast } from "@api/notifications";
import { addComment, isOverlayOn, showOverlay, hideOverlay } from "./overlay";

export const OVERLAY_TOGGLE_CONTRIBUTION_ID = "insights.overlay.toggle";
export const OVERLAY_COMMENT_CONTRIBUTION_ID = "insights.overlay.addComment";
export const OVERLAY_KEEP_CONTRIBUTION_ID = "insights.overlay.keep";
export const OVERLAY_SNAPSHOT_CONTRIBUTION_ID = "insights.overlay.snapshot";
export const OVERLAY_TOGGLE_ACTION_ID = "insights.overlay.toggle.quickAction";
export const OVERLAY_SNAPSHOT_ACTION_ID = "insights.overlay.snapshot.quickAction";

export const SHOW_POINTS_LABEL = "Show points of interest";
export const HIDE_POINTS_LABEL = "Hide points of interest";

function report(err: unknown, fallback: string): void {
  showToast(err instanceof Error && err.message ? err.message : fallback, { variant: "warning" });
}

/**
 * Turn the overlay on or off for a chart, reporting what happened.
 *
 * One function behind BOTH surfaces that toggle it — the context menu and the
 * quick-access button — so the two can never come to mean different things.
 */
function toggleOverlayReporting(chartId: string): void {
  if (isOverlayOn(chartId)) {
    hideOverlay(chartId);
    return;
  }
  void showOverlay(chartId).then((r) => {
    if (r.outcome === "refused") showToast(r.reason, { variant: "warning" });
    else if (r.cueSet.cues.length === 0) showToast("Nothing stands out on this chart.", { variant: "info" });
  });
}

/** Contribute the menu items AND the two quick-access buttons. Returns one disposer. */
export function registerOverlayMenu(): () => void {
  const off: Array<() => void> = [];
  const available = () => getChartDataProvider() !== null;

  off.push(
    registerChartContextMenuContribution({
      id: OVERLAY_TOGGLE_CONTRIBUTION_ID,
      // The label is read at render time through `visible`'s sibling below;
      // contributions carry one label, so two entries alternate visibility.
      label: SHOW_POINTS_LABEL,
      order: 51,
      visible: (chartId) => available() && !isOverlayOn(chartId),
      onSelect: toggleOverlayReporting,
    }),
  );
  off.push(
    registerChartContextMenuContribution({
      id: `${OVERLAY_TOGGLE_CONTRIBUTION_ID}.off`,
      label: HIDE_POINTS_LABEL,
      order: 51,
      visible: (chartId) => available() && isOverlayOn(chartId),
      onSelect: (chartId) => hideOverlay(chartId),
    }),
  );
  off.push(
    registerChartContextMenuContribution({
      id: OVERLAY_COMMENT_CONTRIBUTION_ID,
      label: "Add comment on this point…",
      order: 52,
      visible: (chartId) => isOverlayOn(chartId) && getSelectedChartCue(chartId) !== null,
      onSelect: (chartId) => {
        const cue = getSelectedChartCue(chartId);
        if (!cue) return;
        void promptAsync(`Comment on "${cue.description ?? "this point"}":`, { title: "Add comment" }).then((text) => {
          if (text === null || text.trim() === "") return;
          return addComment(chartId, cue, text.trim()).then(() => undefined);
        }).catch((err) => report(err, "The comment could not be saved."));
      },
    }),
  );
  off.push(
    registerChartContextMenuContribution({
      id: OVERLAY_KEEP_CONTRIBUTION_ID,
      label: "Keep this mark in the chart",
      order: 53,
      visible: (chartId) => isOverlayOn(chartId) && getSelectedChartCue(chartId) !== null,
      onSelect: (chartId) => {
        const cue = getSelectedChartCue(chartId);
        if (!cue) return;
        void keepChartCue(chartId, cue)
          .then(() => showToast("Kept in the chart.", { variant: "success" }))
          .catch((err) => report(err, "This mark could not be kept."));
      },
    }),
  );
  off.push(
    registerChartContextMenuContribution({
      id: OVERLAY_SNAPSHOT_CONTRIBUTION_ID,
      label: "Snapshot with points of interest",
      order: 54,
      visible: (chartId) => isOverlayOn(chartId),
      onSelect: (chartId) => {
        void snapshotChart(chartId).catch((err) => report(err, "The snapshot could not be taken."));
      },
    }),
  );

  // The same two actions as buttons in the selected chart quick-access strip,
  // beside Elements / Styles / Filters. The owner asked for them there: the
  // overlay is something you turn on WHILE looking at a chart, and a right-click
  // menu is a poor home for a toggle you flip repeatedly.
  off.push(
    registerChartQuickAction({
      id: OVERLAY_TOGGLE_ACTION_ID,
      icon: "insight",
      order: 10,
      tooltip: (chartId) => (isOverlayOn(chartId) ? HIDE_POINTS_LABEL : SHOW_POINTS_LABEL),
      visible: () => available(),
      active: (chartId) => isOverlayOn(chartId),
      onSelect: toggleOverlayReporting,
    }),
  );
  off.push(
    registerChartQuickAction({
      id: OVERLAY_SNAPSHOT_ACTION_ID,
      icon: "camera",
      order: 11,
      tooltip: () => "Snapshot with points of interest",
      // Only while there is an overlay to snapshot, exactly as the menu item is:
      // a camera that copies a plain chart is not what this button promises.
      visible: (chartId) => isOverlayOn(chartId),
      onSelect: (chartId) => {
        void snapshotChart(chartId).catch((err) => report(err, "The snapshot could not be taken."));
      },
    }),
  );

  return () => {
    for (const f of off) f();
  };
}
