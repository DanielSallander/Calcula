//! FILENAME: app/extensions/Charts/components/FormatAxisDialog.tsx
// PURPOSE: RETIRED. The modal "Format Axis" box is gone; this is the redirector
//          that keeps its dialog id working, points the selection at the axis
//          the caller named, and sends the reader to the Format task pane.
// CONTEXT: WHY IT WAS RETIRED, and why a redirector rather than a deletion.
//
//          Excel has no modal Format Axis. It has ONE task pane that re-targets
//          as the selection moves, with every control applying immediately and
//          no Apply button — and the pane now exists
//          (components/ChartFormatPane.tsx) carrying every field this box had:
//          bounds, major/minor units, scale type, display units, reverse,
//          crosses-at, tick marks, label position and angle, number format,
//          axis line colour/width and gridlines.
//
//          The old box also carried two defects that this file's existence used
//          to guarantee:
//
//          1. IT PAINTED ITS OWN FULL-SCREEN BACKDROP over a 760px modal, so
//             the chart it was formatting was behind the thing formatting it —
//             an axis bound cannot be judged without seeing the axis.
//          2. IT NEVER CONSUMED `data.__openCount`. `DialogContainer` keys by
//             dialog id, so re-showing an already-open dialog updates its props
//             WITHOUT remounting and every `useState` keeps what it held (see
//             `openDialog` in app/src/shell/registries/dialogExtensions.ts,
//             which documents two shipped bugs of exactly that kind). This box
//             seeded TWENTY-TWO pieces of state from the axis at MOUNT, so
//             right-clicking the X axis while the box was open on the Y axis
//             showed the Y axis's twenty-two values under an "X" heading, and
//             Apply wrote every one of them onto the X axis.
//
//          The redirector still depends on `__openCount`, because it has to act
//          on EVERY show and a right-click on the OTHER axis with the pane
//          already open is exactly such a show. That repeat show is also why it
//          re-states the sub-selection every time rather than only on mount.
//
//          IT STATES THE SELECTION, it does not nudge it. The caller (the axis
//          context menu) knows which axis was right-clicked, and a right-click
//          does not advance the ladder — so the pane would otherwise re-target
//          onto whatever was selected before. `setSubSelection` is the door for
//          a gesture that decides its own answer, and it ignores a chartId that
//          is not the selected chart, so this can never move the selection onto
//          a chart nobody selected.

import React, { useEffect } from "react";
import type { DialogProps } from "@api";
import { openTaskPane } from "@api";

import { setSubSelection } from "../handlers/selectionHandler";
import { CHART_FORMAT_PANE_ID, publishCurrentChartSelection } from "./ChartFormatPane";

export function FormatAxisDialog({ onClose, data }: DialogProps): React.ReactElement | null {
  const chartId = data?.chartId as string | undefined;
  const axisType = data?.axisType as "x" | "y" | undefined;
  const openCount = data?.__openCount;

  useEffect(() => {
    if (chartId != null && (axisType === "x" || axisType === "y")) {
      setSubSelection(chartId, { level: "axis", axisType });
      publishCurrentChartSelection();
    }
    openTaskPane(CHART_FORMAT_PANE_ID);
    onClose();
    // `openCount` is the dependency that makes a repeat show observable; see
    // the header. `onClose` is stable per dialog instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openCount, chartId, axisType]);

  return null;
}
