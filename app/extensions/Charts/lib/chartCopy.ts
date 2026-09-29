//! FILENAME: app/extensions/Charts/lib/chartCopy.ts
// PURPOSE: A chart's share of the OBJECT CLIPBOARD (@api/objectClipboard):
//          snapshot a chart (its spec, size and place) for Copy / Duplicate,
//          and create a new chart from a snapshot for Paste / Duplicate.
// CONTEXT: W25 (the copy/duplicate half of open-items 2.af row 1). A canvas
//          multi-selection's Copy / Paste / Duplicate act on EVERY selected
//          object as ONE undo step; Charts had no copy of any kind, so a chart
//          in the selection could not be copied by any key. A chart is SIMPLE
//          to copy -- it is its spec plus a rectangle; the data it charts is
//          named by the spec (sheet ids, a pivot id, a model query) and stays
//          the original's -- so it gets one here, through its provider
//          (lib/chartObjectSelection.ts `copyChart` / `pasteCharts`).
//
//          The snapshot is a deep copy of the STORED spec (never a transient
//          hover preview, `getPreviewBaseSpec`), so a paste after the original
//          was edited or deleted still creates what was copied. A copy gets a
//          fresh id and the next auto name ("Chart N"), the way Insert names a
//          chart. Each creation is AWAITED until the backend has it
//          (`createChartLanded`): the seam runs a paste of several objects
//          inside one undo transaction, and a save still in flight at its
//          commit would record "Insert chart" as a separate Ctrl+Z step. A
//          refused create is REPORTED (the seam's one toast), never a dialog
//          of its own, and the chart it put in the store is gone again.

import { emitAppEvent, AppEvents } from "@api/events";
import { canvasObjectRef } from "@api/canvasSheet";
import type { CanvasObjectRef } from "@api";
import type { ObjectPasteResult, ObjectPasteTarget } from "@api/objectSelection";
import type { ChartSpec } from "../types";
import { createChartLanded, getChartById, getPreviewBaseSpec, syncChartRegions } from "./chartStore";
import { ChartEvents } from "./chartEvents";

/** What a copied chart is: enough to create an identical new one. */
export interface ChartSnapshot {
  /** Tag, so a paste never mistakes another family's snapshot for a chart's. */
  kind: "chart";
  x: number;
  y: number;
  width: number;
  height: number;
  /** A deep copy of the stored spec. */
  spec: ChartSpec;
}

function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Snapshot the chart `chartId` for the object clipboard -- a deep copy of its
 * STORED spec and its rectangle -- or null when there is no such chart.
 */
export function snapshotChart(chartId: string): ChartSnapshot | null {
  const chart = getChartById(chartId);
  if (!chart) return null;
  const spec = getPreviewBaseSpec(chartId) ?? chart.spec;
  return {
    kind: "chart",
    x: chart.x,
    y: chart.y,
    width: chart.width,
    height: chart.height,
    spec: deepCopy(spec),
  };
}

/** Whether `value` is a snapshot `snapshotChart` made. */
export function isChartSnapshot(value: unknown): value is ChartSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.kind === "chart" &&
    typeof v.x === "number" &&
    typeof v.y === "number" &&
    typeof v.width === "number" &&
    typeof v.height === "number" &&
    typeof v.spec === "object" &&
    v.spec !== null
  );
}

/**
 * Create a new chart from each snapshot on `target.sheetIndex`, at
 * `target.place(its rect)`, one after another, each awaited until the backend
 * has it. Resolves to the new charts' identities and the reasons of the ones
 * refused; never rejects. Every created chart is published and announced the
 * way Insert Chart does (regions, CHART_CREATED, a repaint); selecting them is
 * the seam's.
 */
export async function pasteChartSnapshots(
  snapshots: ReadonlyArray<unknown>,
  target: ObjectPasteTarget,
): Promise<ObjectPasteResult> {
  const created: CanvasObjectRef[] = [];
  const refused: string[] = [];
  for (const snapshot of snapshots) {
    if (!isChartSnapshot(snapshot)) {
      refused.push("A copied chart could not be read back.");
      continue;
    }
    const at = target.place({ x: snapshot.x, y: snapshot.y, width: snapshot.width, height: snapshot.height });
    const { chart, refusal } = await createChartLanded(
      // Each paste gets its OWN copy: the store keeps the spec object it is
      // handed, and the clipboard's snapshot must survive for the next paste.
      deepCopy(snapshot.spec),
      { sheetIndex: target.sheetIndex, x: at.x, y: at.y, width: snapshot.width, height: snapshot.height },
      { reportRefusal: false },
    );
    if (!chart) {
      refused.push(refusal ?? "The chart could not be created.");
      continue;
    }
    syncChartRegions();
    emitAppEvent(ChartEvents.CHART_CREATED, { chartId: chart.chartId });
    emitAppEvent(AppEvents.GRID_REFRESH);
    created.push(canvasObjectRef("chart", chart.chartId));
  }
  return { created, refused };
}
