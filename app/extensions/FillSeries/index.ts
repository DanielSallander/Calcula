//! FILENAME: app/extensions/FillSeries/index.ts
// PURPOSE: Fill Series extension entry point.
// CONTEXT: Registers Excel's Series dialog and the `fill.series` command that
//          opens it -- the Home tab's Fill > Series... runs it. The rules,
//          measured in live Excel, are in lib/seriesPlan.ts; the write (one
//          undo step) in lib/runSeries.ts. Uses ExtensionModule lifecycle
//          (Path A).

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { ExtensionCommands } from "@api/commands";
import { showDialog } from "@api/ui";
import { showToast } from "@api/notifications";
import { SeriesDialog } from "./components/SeriesDialog";
import { resolveCellTarget } from "@api/cellTarget";
import { seriesPlaceFor } from "./lib/runSeries";
import { defaultSeriesIn } from "./lib/seriesPlan";

export const SERIES_DIALOG_ID = "fill-series";

const cleanupFns: (() => void)[] = [];

/**
 * Open the Series dialog -- refused first, out loud, when the series could not
 * be written anyway (an object owns the selection, a canvas sheet, several
 * areas), so the dialog never opens over nothing it may fill. A floating
 * grid's cells are a target the series fills (P3).
 */
export function openSeriesDialog(): void {
  const t = resolveCellTarget("Series", "content");
  if (t === null) return;
  const place = seriesPlaceFor(t);
  if ("refusal" in place) {
    showToast(place.refusal, { variant: "info" });
    return;
  }
  showDialog(SERIES_DIALOG_ID, { seriesIn: defaultSeriesIn(place.range) });
}

function activate(context: ExtensionContext): void {
  console.log("[FillSeries] Activating...");

  context.ui.dialogs.register({ id: SERIES_DIALOG_ID, component: SeriesDialog, priority: 100 });
  cleanupFns.push(() => context.ui.dialogs.unregister(SERIES_DIALOG_ID));

  context.commands.register(ExtensionCommands.FILL_SERIES, () => openSeriesDialog());
  cleanupFns.push(() => context.commands.unregister(ExtensionCommands.FILL_SERIES));

  console.log("[FillSeries] Activated successfully.");
}

function deactivate(): void {
  console.log("[FillSeries] Deactivating...");
  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[FillSeries] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;
  console.log("[FillSeries] Deactivated.");
}

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.fill-series",
    name: "Fill Series",
    version: "1.0.0",
    description: "Excel's Series dialog: linear, growth, date and AutoFill series with a step, a stop and a trend.",
  },
  activate,
  deactivate,
};

export default extension;
