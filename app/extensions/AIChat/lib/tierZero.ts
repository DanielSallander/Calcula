//! FILENAME: app/extensions/AIChat/lib/tierZero.ts
// PURPOSE: Compute the facts BEFORE the model sees an "analyse" message, so the
//          model's job is wording rather than arithmetic.
// CONTEXT: 2026-09-10. The Insights engine is Tier 0 — deterministic Rust, no
//          model, a quarter of a second — and until now the in-app chat never
//          called it: an "analyse this" message went to whichever model the user
//          picked, which read raw cells and formed an impression. This module
//          is the chat's half of `@api/insightsService`: it decides WHAT to
//          analyse from the message's context and hands the seam's own wording
//          of the bundle back to the send path, which appends it to the user's
//          message. The model then words checked facts, and a follow-up turn
//          still has them in the transcript.
//
//          WHAT IT ANALYSES, in order:
//            1. A multi-cell selection — the user pointed at something.
//            2. Otherwise the model, when the workbook has exactly ONE BI
//               connection: "what is going on with revenue" is a question about
//               measures, and the strategy-aware path is the one that can say
//               "worse". Two connections is a question the user has to answer,
//               and the model can still call analyze_model with an id.
//            3. Otherwise the single selected cell, expanded to its block, the
//               way the Insights pane's own button does.
//
//          A FAILURE IS NOT A REFUSAL. If the seam throws, the send path goes on
//          without facts and the model keeps its tools; a pre-route that could
//          block the chat would be worse than the impression it replaces.

import { a1Rect, describeBundleForModel, getInsightsProvider } from "@api";
import type { InsightBundle } from "@api";
import { currentSelection } from "./selectionContext";

export interface TierZeroFacts {
  /** The block appended to the user's message, in the seam's own wording. */
  text: string;
  /** What was analysed, for the notice shown to the person. */
  label: string;
  source: "range" | "model";
  /** How many facts the bundle carries, for the same notice. */
  factCount: number;
}

function facts(bundle: InsightBundle, label: string, source: "range" | "model"): TierZeroFacts {
  return {
    text: describeBundleForModel(bundle, label),
    label,
    source,
    factCount: bundle.insights.length,
  };
}

/**
 * The facts for the current context, or null when there is nothing to
 * analyse, no provider, or the analysis failed.
 */
export async function prepareTierZeroFacts(): Promise<TierZeroFacts | null> {
  const provider = getInsightsProvider();
  if (!provider) return null;

  const selection = currentSelection();
  const area = selection?.areas[0];
  const multiCell =
    area !== undefined && (area.startRow !== area.endRow || area.startCol !== area.endCol);

  try {
    if (selection && area && multiCell) {
      const label = `${a1Rect(area.startRow, area.startCol, area.endRow, area.endCol)} on sheet index ${selection.sheetIndex}`;
      const bundle = await provider.analyzeRange({
        sheetIndex: selection.sheetIndex,
        startRow: area.startRow,
        startCol: area.startCol,
        endRow: area.endRow,
        endCol: area.endCol,
      });
      return facts(bundle, label, "range");
    }

    const connections = provider.modelConnections();
    if (connections.length === 1) {
      const connection = connections[0];
      const bundle = await provider.analyzeModel({ connectionId: connection.id });
      return facts(bundle, connection.name, "model");
    }

    if (selection && area) {
      const label = `the block around ${a1Rect(area.startRow, area.startCol, area.endRow, area.endCol)} on sheet index ${selection.sheetIndex}`;
      const bundle = await provider.analyzeRange({
        sheetIndex: selection.sheetIndex,
        startRow: area.startRow,
        startCol: area.startCol,
        endRow: area.endRow,
        endCol: area.endCol,
        expandToRegion: true,
      });
      return facts(bundle, label, "range");
    }
  } catch {
    // The tool path remains. See the module header.
    return null;
  }
  return null;
}

/** The one-line notice shown above the model's answer. */
export function describeTierZero(found: TierZeroFacts, model: string): string {
  const n = found.factCount;
  const what = found.source === "model" ? `the model "${found.label}"` : found.label;
  return (
    `Calcula computed ${n} fact${n === 1 ? "" : "s"} about ${what} first — deterministic, ` +
    `no model involved — and handed them to ${model} to put into words.`
  );
}
