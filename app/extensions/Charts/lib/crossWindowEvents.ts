//! FILENAME: app/extensions/Charts/lib/crossWindowEvents.ts
// PURPOSE: Cross-window event bridge for the Chart Spec Editor.
// CONTEXT: Uses Tauri events to communicate between the main window and
//          the separate chart spec editor window. Follows the same pattern
//          as ScriptEditor/lib/crossWindowEvents.ts.

import { emitTauriEvent, listenTauriEvent } from "../../../src/api/backend";
import type { UnlistenFn } from "../../../src/api/backend";
import type { ChartSpec, ParsedChartData } from "../types";

// ============================================================================
// Event Names
// ============================================================================

export const ChartSpecEditorEvents = {
  /** Main -> Editor: transfer the current chart spec and preview data */
  OPEN_WITH_SPEC: "chart-spec-editor:open-with-spec",
  /** Editor -> Main: spec was edited, apply changes back to the dialog */
  SPEC_CHANGED: "chart-spec-editor:spec-changed",
  /** Main -> Editor: spec was updated from the main dialog (Data/Design tabs) */
  SPEC_UPDATED: "chart-spec-editor:spec-updated",
  /** Main -> Editor: preview data was updated */
  PREVIEW_DATA_UPDATED: "chart-spec-editor:preview-data-updated",
  /** Editor -> Main: editor window was closed */
  EDITOR_CLOSED: "chart-spec-editor:editor-closed",
  /** Editor -> Main: editor has mounted and listeners are ready */
  EDITOR_READY: "chart-spec-editor:editor-ready",
} as const;

// ============================================================================
// Payloads
// ============================================================================

export interface OpenWithSpecPayload {
  spec: ChartSpec;
  previewData: ParsedChartData | null;
}

export interface SpecChangedPayload {
  spec: Partial<ChartSpec>;
}

export interface SpecUpdatedPayload {
  spec: ChartSpec;
}

export interface PreviewDataUpdatedPayload {
  data: ParsedChartData | null;
}

// ============================================================================
// Emit Functions
// ============================================================================

export async function emitOpenWithSpec(spec: ChartSpec, previewData: ParsedChartData | null): Promise<void> {
  await emitTauriEvent(ChartSpecEditorEvents.OPEN_WITH_SPEC, { spec, previewData } satisfies OpenWithSpecPayload);
}

export async function emitSpecChanged(spec: Partial<ChartSpec>): Promise<void> {
  await emitTauriEvent(ChartSpecEditorEvents.SPEC_CHANGED, { spec } satisfies SpecChangedPayload);
}

export async function emitSpecUpdated(spec: ChartSpec): Promise<void> {
  await emitTauriEvent(ChartSpecEditorEvents.SPEC_UPDATED, { spec } satisfies SpecUpdatedPayload);
}

export async function emitPreviewDataUpdated(data: ParsedChartData | null): Promise<void> {
  await emitTauriEvent(ChartSpecEditorEvents.PREVIEW_DATA_UPDATED, { data } satisfies PreviewDataUpdatedPayload);
}

export async function emitChartSpecEditorClosed(): Promise<void> {
  await emitTauriEvent(ChartSpecEditorEvents.EDITOR_CLOSED);
}

// ============================================================================
// Listen Functions
// ============================================================================

export function onOpenWithSpec(
  callback: (payload: OpenWithSpecPayload) => void,
): Promise<UnlistenFn> {
  return listenTauriEvent<OpenWithSpecPayload>(ChartSpecEditorEvents.OPEN_WITH_SPEC, callback);
}

export function onSpecChanged(
  callback: (payload: SpecChangedPayload) => void,
): Promise<UnlistenFn> {
  return listenTauriEvent<SpecChangedPayload>(ChartSpecEditorEvents.SPEC_CHANGED, callback);
}

export function onSpecUpdated(
  callback: (payload: SpecUpdatedPayload) => void,
): Promise<UnlistenFn> {
  return listenTauriEvent<SpecUpdatedPayload>(ChartSpecEditorEvents.SPEC_UPDATED, callback);
}

export function onPreviewDataUpdated(
  callback: (payload: PreviewDataUpdatedPayload) => void,
): Promise<UnlistenFn> {
  return listenTauriEvent<PreviewDataUpdatedPayload>(ChartSpecEditorEvents.PREVIEW_DATA_UPDATED, callback);
}

export function onChartSpecEditorClosed(
  callback: () => void,
): Promise<UnlistenFn> {
  return listenTauriEvent(ChartSpecEditorEvents.EDITOR_CLOSED, callback);
}

export async function emitEditorReady(): Promise<void> {
  await emitTauriEvent(ChartSpecEditorEvents.EDITOR_READY);
}

export function onEditorReady(
  callback: () => void,
): Promise<UnlistenFn> {
  return listenTauriEvent(ChartSpecEditorEvents.EDITOR_READY, callback);
}
