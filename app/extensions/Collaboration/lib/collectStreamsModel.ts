//! FILENAME: app/extensions/Collaboration/lib/collectStreamsModel.ts
// PURPOSE: The pure decisions behind Writeback > Collect From: what a click on a
//          stream row asks for, which row may not be unticked, the hero's badge
//          and tooltip, and the rows' test ids.
// CONTEXT: The choice itself lives in Rust (the workbook's working-copy link,
//          `calp_collection_streams`); the Writeback tab's hero and the
//          Collected Responses pane are two views of it through one store
//          (collectStreamsStore.ts). Nothing here talks to the backend, so every
//          rule is unit-tested without a DOM.
//
//          Owner decision 2026-10-22: the DEFAULT is the pipeline's LAST
//          environment (every stream when there are none); "All streams"
//          includes environments defined later; an explicit set does NOT, and a
//          new environment then shows unticked with a "not collected" note; an
//          empty set is refused.

import type { CollectionStreamsView, CollectStreamsChoice, StreamChoice } from "@api/collaboration";

/** The hero's tooltip when the workbook has published nothing yet. */
export const NOT_PUBLISHED_TOOLTIP =
  "Publish this workbook's application first (Collaboration > Publish Application); then choose which streams its Collected Responses and model tables collect from.";

/** The menu's accessible name and heading. */
export const COLLECT_FROM_HEADING = "Collect responses from";

/** The streams a view collects now, as an explicit set (the default and "All
 *  streams" resolved to the rows they tick). */
function includedStreams(view: CollectionStreamsView): Set<string> {
  if (view.mode === "only" && view.selection) return new Set(view.selection);
  return new Set(view.choices.filter((c) => c.included).map((c) => c.stream));
}

/**
 * What a click on a stream row asks for: the current choice with that stream
 * toggled, always as an EXPLICIT set. From "All streams" that is every listed
 * stream -- including names only answers still carry -- minus the clicked one,
 * so nothing listed is dropped in silence. `"refuse"` when the click would
 * leave nothing collected.
 */
export function nextChoice(view: CollectionStreamsView, stream: string): CollectStreamsChoice | "refuse" {
  const next = includedStreams(view);
  if (next.has(stream)) next.delete(stream);
  else next.add(stream);
  if (next.size === 0) return "refuse";
  return { only: [...next].sort() };
}

/** Whether `choice` is the ONLY collected row: it may not be unticked (an
 *  empty choice is refused), so the menu disables it. */
export function isLastIncluded(view: CollectionStreamsView, choice: StreamChoice): boolean {
  return choice.included && includedStreams(view).size === 1;
}

/** The tooltip and menu line when the view could not be read. */
export function readErrorText(error: string): string {
  return `Could not read which streams this workbook collects: ${error}`;
}

/** The count pill: "!" when an explicit choice leaves environments out (a new
 *  one, typically) or the last read failed, the number of chosen streams for an
 *  explicit choice, nothing for the default or "All streams". */
export function heroBadge(view: CollectionStreamsView | null, error?: string | null): string | number | undefined {
  if (error) return "!";
  if (!view || !view.linked) return undefined;
  if (view.notCollected.length > 0) return "!";
  if (view.mode === "only" && view.selection) return view.selection.length;
  return undefined;
}

/**
 * The hero's tooltip: what is collected, what is not, and who may change it. A
 * READ THAT FAILED is said as such -- never "publish first" for an application
 * that is published, and never a stale view presented as current.
 */
export function heroTooltip(view: CollectionStreamsView | null, error?: string | null): string {
  if (error && (!view || !view.linked)) return readErrorText(error);
  if (!view || !view.linked) return NOT_PUBLISHED_TOOLTIP;
  const parts = [`Collecting from: ${view.summary}.`];
  if (error) parts.push(`The latest re-read failed, so this may be out of date. ${readErrorText(error)}.`);
  if (view.notCollected.length > 0) parts.push(`Not collected: ${view.notCollected.join(", ")}.`);
  if (view.environmentsError) parts.push(view.environmentsError);
  parts.push("Collected Responses, exports, scripts and the model tables of this workbook's regions use this choice.");
  if (!view.canChange && view.changeRefusal) parts.push(view.changeRefusal);
  return parts.join(" ");
}

/** The pane's warning line, or null. */
export function notCollectedText(view: CollectionStreamsView | null): string | null {
  if (!view || !view.linked || view.notCollected.length === 0) return null;
  const names = view.notCollected.join(", ");
  return `Not collected: ${names}. Tick ${view.notCollected.length === 1 ? "it" : "them"} in Writeback > Collect From to include ${view.notCollected.length === 1 ? "its" : "their"} answers.`;
}

/** The menu row for "use the default" -- shown only when the workbook holds
 *  another choice and the pipeline has a last environment. */
export function defaultRowLabel(view: CollectionStreamsView): string | null {
  if (view.mode === "default" || !view.defaultStream) return null;
  return `Default: the last environment (${view.defaultStream})`;
}

/** The test id of a stream row. */
export function choiceTestId(stream: string): string {
  return stream === "" ? "writeback-collect-stream-development-line" : `writeback-collect-stream-${stream}`;
}
