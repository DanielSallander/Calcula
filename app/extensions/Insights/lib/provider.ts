//! FILENAME: app/extensions/Insights/lib/provider.ts
// PURPOSE: The `InsightsProvider` implementation — the thing that makes the
//          chat's "analyse this" deterministic instead of an impression.
// CONTEXT: A caller (the AI chat's pre-route, a report generator, a future
//          ribbon button) asks `@api/insightsService` for facts about a range or
//          a model and gets a bundle back. It never learns that this extension
//          exists.
//
//          THE PROVIDER DOES NOT TOUCH THE PANE. It is tempting to have a chat
//          tool call also light up the Insights pane, and it is wrong: a tool
//          call is somebody else's turn, and hijacking a visible surface to show
//          its intermediate working steals the pane from whatever the user had
//          open there. The pane is driven by the pane's own controls, the
//          command, the grid menu and "Explain this chart" — all of which are
//          things a PERSON just clicked.
//
//          `hasModel()` and `modelConnections()` are synchronous by contract,
//          so they answer from the connection cache the store refreshes at
//          activation and on every document swap, never from a fresh IPC call.

import type {
  InsightBundle,
  InsightsProvider,
  ModelConnection,
  ModelInsightsRequest,
  RangeInsightsRequest,
} from "@api/insightsService";
import { analyzeModel, analyzeRange } from "./backend";
import { getState, hasModel } from "./store";

/**
 * Build the provider. One instance per activation, so the unregister returned
 * by `registerInsightsProvider` can identity-match and never clobber a
 * re-registration by a later activation.
 */
export function createInsightsProvider(): InsightsProvider {
  return {
    analyzeRange(req: RangeInsightsRequest): Promise<InsightBundle> {
      return analyzeRange(req);
    },
    analyzeModel(req: ModelInsightsRequest): Promise<InsightBundle> {
      return analyzeModel(req);
    },
    hasModel(): boolean {
      return hasModel();
    },
    modelConnections(): readonly ModelConnection[] {
      return getState().connections;
    },
  };
}
