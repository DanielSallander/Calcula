//! FILENAME: app/extensions/Pivot/components/CanvasPivotBuildBody.tsx
// PURPOSE: A canvas pivot box's Fields / Design tabs in the ONE object pane
//          (WP-C D-PANE): the field-list editor (PivotEditor), LIFTED out of
//          the worksheet `pivot-editor` task pane so the object pane owns the
//          tab strip.
// CONTEXT: The object pane renders the active build tab into ONE slot that
//          stays mounted while Format is shown, and pivotObjectPane.ts returns
//          THIS component, keyed by the pivot id, from both the Fields and the
//          Design tab -- so ONE instance (and ONE PivotEditor) serves both:
//          the zones, a deferred update and the DSL text survive every switch
//          between Fields, Design and Format. Only `tab` changes; the editor is
//          CONTROLLED by it and renders no strip of its own.
//
//          The editor is seeded exactly as the worksheet pane is: the pivot's
//          info read at its hidden-grid anchor (`pivot.getAtCell`, which
//          resolves on the ACTIVE sheet -- the canvas) through
//          `buildPivotPaneData`. It is loaded once per pivot (and anchor);
//          the editor re-reads the definition itself after a change made
//          elsewhere (PIVOT_FIELDS_EDITED_ELSEWHERE, BUG-0466).
//
//          The value-field dialog contract (WP-A, lib/valueFieldDialogRequest.ts)
//          keeps working: its listener lives in PivotEditor, which takes the
//          pending request when it MOUNTS -- after this body's async load --
//          and on PIVOT_OPEN_VALUE_FIELD_DIALOG.
//
//          `onViewUpdate` re-reads the pivot regions and views and repaints
//          ("pivot:refresh"): the object pane is not the task pane container,
//          whose view `onUpdate` used to do it.

import React, { useEffect, useState } from "react";
import { pivot } from "@api/pivot";
import { PivotEditor, type PivotEditorTab } from "./PivotEditor";
import { buildPivotPaneData } from "../handlers/selectionHandler";
import type { PivotEditorViewData } from "../types";

export interface CanvasPivotBuildBodyProps {
  pivotId: string;
  /** The box's hidden-grid anchor (its region's startRow / startCol). */
  anchorRow: number;
  anchorCol: number;
  /** The tab the host shows (the editor is controlled by it). */
  tab: PivotEditorTab;
  /** The page is subscribed: the field list is read-only. */
  readOnly: boolean;
  readOnlyReason: string | null;
}

/** What the body says while it loads, or when the pivot cannot be read. */
export const CANVAS_PIVOT_LOADING = "Loading the PivotTable fields...";
export const CANVAS_PIVOT_UNREADABLE = "The PivotTable fields could not be read.";

const messageStyle: React.CSSProperties = {
  padding: "16px 12px",
  fontSize: 12,
  color: "#605e5c",
};

/** Ask the pivot extension to re-read its regions and views and repaint. */
function refreshPivotViews(): void {
  window.dispatchEvent(new CustomEvent("pivot:refresh"));
}

export function CanvasPivotBuildBody({
  pivotId,
  anchorRow,
  anchorCol,
  tab,
  readOnly,
  readOnlyReason,
}: CanvasPivotBuildBodyProps): React.ReactElement {
  const [data, setData] = useState<PivotEditorViewData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    pivot
      .getAtCell(anchorRow, anchorCol)
      .then((info) => {
        if (!live) return;
        if (!info || String(info.pivotId) !== String(pivotId)) {
          setError(CANVAS_PIVOT_UNREADABLE);
          return;
        }
        setData(buildPivotPaneData(info));
      })
      .catch((err) => {
        if (!live) return;
        console.error(`[Pivot] could not read pivot ${pivotId} for its field list:`, err);
        setError(CANVAS_PIVOT_UNREADABLE);
      });
    return () => {
      live = false;
    };
  }, [pivotId, anchorRow, anchorCol]);

  if (error) {
    return (
      <div style={messageStyle} data-testid="canvas-pivot-build-error">
        {error}
      </div>
    );
  }
  if (!data) {
    return (
      <div style={messageStyle} data-testid="canvas-pivot-build-loading">
        {CANVAS_PIVOT_LOADING}
      </div>
    );
  }

  return (
    <div
      data-testid="canvas-pivot-build"
      data-pivot-id={pivotId}
      data-tab={tab}
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 480 }}
    >
      {readOnly && readOnlyReason && (
        <div style={messageStyle} role="note" data-testid="canvas-pivot-build-readonly">
          {readOnlyReason}
        </div>
      )}
      <div
        style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", ...(readOnly ? { pointerEvents: "none", opacity: 0.6 } : {}) }}
        aria-disabled={readOnly || undefined}
      >
        <PivotEditor
          pivotId={data.pivotId}
          sourceFields={data.sourceFields}
          initialRows={data.initialRows}
          initialColumns={data.initialColumns}
          initialValues={data.initialValues}
          initialFilters={data.initialFilters}
          initialLayout={data.initialLayout}
          initialCalculatedFields={data.initialCalculatedFields}
          initialValueColumnOrder={data.initialValueColumnOrder}
          biModel={data.biModel}
          sourceTableName={data.sourceTableName}
          tab={tab}
          showTabStrip={false}
          onViewUpdate={refreshPivotViews}
        />
      </div>
    </div>
  );
}
