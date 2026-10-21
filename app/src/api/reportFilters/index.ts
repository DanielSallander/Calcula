//! FILENAME: app/src/api/reportFilters/index.ts
// PURPOSE: @api/reportFilters -- the ONE target-aware filter seam of a report.
//          Filtering families PUBLISH (model slicers on their page, ribbon
//          filters on their scope), visuals SELECT (cross-filter selections),
//          a page says which visual filters which (interactions), and every
//          querying visual asks ONE question: resolveFiltersFor(page, target,
//          connection).
// CONTEXT: P4 (canvas round 2), replacing @api/pageFilters. Pages are SHEET IDS
//          end to end (a sheet index shifts on every move). Imported as the
//          subpath `@api/reportFilters`, like @api/objectBindings: it is not
//          re-exported from the @api barrel.
//
//          LIFETIME. `startReportFilters()` is reference-counted like
//          startReportPages, which it starts -- a publisher converts a sheet
//          index to its id through that page list, and the list is empty until
//          someone starts it. It also installs the File > New / Open reset of
//          the selections. It reads AppEvents only inside the call, never at
//          module load (reportPages.ts:266-273). Every consuming extension calls
//          it from activation and pushes the stop on its cleanup list.
//
//          Seams point one way: this folder imports nothing from app/extensions.

import { startReportPages } from "../reportPages";
import { installSelectionReset } from "./selections";

export type {
  VisualRef,
  InteractionMode,
  MemberCoord,
  MemberPath,
  ReportFilterScope,
  ReportFilterInput,
  ReportFilter,
  CrossFilterSelection,
  ResolvedFieldFilter,
  ResolvedTupleFilter,
  ResolvedFilters,
  ResolveTarget,
  ResolveOptions,
  ReportFiltersChange,
  PageInteractions,
} from "./types";
export { publishReportFilters, getReportFilters } from "./publishers";
export {
  setCrossFilter,
  addToCrossFilter,
  clearCrossFilter,
  clearCrossFilters,
  getCrossFilters,
  pruneCrossFilter,
  pruneMissingCrossFilterSources,
  isCrossFilterSource,
} from "./selections";
export { publishPageInteractions, interactionFor } from "./interactions";
export { resolvePageBase, resolveFiltersFor, isRectangular } from "./resolve";
export { onReportFiltersChange } from "./changes";

let starters = 0;
let stopInstalled: (() => void) | null = null;

/**
 * Start the seam's lifetime services: the page list (startReportPages) and the
 * File > New / Open selection reset. Returns this starter's stop; both go when
 * the last starter stops.
 */
export function startReportFilters(): () => void {
  starters++;
  if (!stopInstalled) {
    const stopPages = startReportPages();
    const stopReset = installSelectionReset();
    stopInstalled = () => {
      stopReset();
      stopPages();
    };
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    starters = Math.max(0, starters - 1);
    if (starters === 0 && stopInstalled) {
      const stop = stopInstalled;
      stopInstalled = null;
      stop();
    }
  };
}
