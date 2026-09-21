//! FILENAME: app/extensions/Charts/components/DataPointFormatDialog.tsx
// PURPOSE: RETIRED. The modal "Format Data Point" box is gone; this is the
//          redirector that keeps its dialog id working and sends the reader to
//          the Format task pane instead.
// CONTEXT: WHY IT WAS RETIRED, and why a redirector rather than a deletion.
//
//          Excel has no modal for formatting a data point. It has ONE task pane
//          that re-targets as the selection moves, with every control applying
//          immediately and no OK/Cancel — and the pane now exists
//          (components/ChartFormatPane.tsx), with strictly more fields than
//          this box ever had (marker shape/size/fill, invert-if-negative).
//          Keeping both would be two sources of truth over the same
//          `dataPointOverrides` entry.
//
//          The old box also carried two defects that this file's existence used
//          to guarantee:
//
//          1. IT PAINTED ITS OWN FULL-SCREEN BACKDROP. Nothing about a
//             per-point colour needs to block the grid, and a modal cannot be
//             open while the reader clicks the NEXT bar — which is the whole
//             gesture this feature is for.
//          2. IT NEVER CONSUMED `data.__openCount`. `DialogContainer` keys by
//             dialog id, so re-showing an already-open dialog updates its props
//             WITHOUT remounting and every `useState` keeps what it held (see
//             `openDialog` in app/src/shell/registries/dialogExtensions.ts,
//             which documents two shipped bugs of exactly that kind). This box
//             seeded eight pieces of state from the override at MOUNT, so
//             formatting a second point while the box was open showed the first
//             point's colours and Apply wrote them onto the second point.
//
//          The redirector still depends on `__openCount`, because it has to act
//          on EVERY show and a second "Format Point" click with the pane
//          already open is exactly such a show.
//
//          THE TARGET IS THE SELECTION, NOT THE PAYLOAD. The caller's
//          `seriesIndex`/`categoryIndex` are AUTHORING-space indices
//          (ChartDesignSections translates them before opening this), while the
//          ladder holds PAINTER-space ones. Re-deriving a selection from them
//          would put the pane on the wrong datum under an active filter, so
//          nothing is re-derived: the button that opens this only exists at
//          `level: "dataPoint"`, so the selection is already the datum the
//          reader means, and the pane reads it from `@api/chartSelection`.

import React, { useEffect } from "react";
import type { DialogProps } from "@api";
import { openTaskPane } from "@api";

import { CHART_FORMAT_PANE_ID } from "./ChartFormatPane";

export function DataPointFormatDialog({ onClose, data }: DialogProps): React.ReactElement | null {
  const openCount = data?.__openCount;

  useEffect(() => {
    openTaskPane(CHART_FORMAT_PANE_ID);
    onClose();
    // `openCount` is the dependency that makes a repeat show observable; see
    // the header. `onClose` is stable per dialog instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openCount]);

  return null;
}
