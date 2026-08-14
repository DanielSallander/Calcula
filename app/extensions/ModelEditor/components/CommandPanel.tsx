// FILENAME: app/extensions/ModelEditor/components/CommandPanel.tsx
// PURPOSE: The Model Editor's bottom command panel — now a thin binding of
//          the SHARED CLI panel (_shared/cli/components/CliPanel.tsx) to the
//          model domain: it supplies the Monaco language, the per-run
//          session/plan/execute driver over cli/execute.ts, and keeps the
//          historical localStorage keys (calcula.modelEditor.cli.*) so
//          existing history and saved scripts survive.
// CONTEXT: The panel chrome (prompt/script modes, history, confirmation
//          card, resize, saved scripts) lives in the shared component — the
//          main window's Command Line hosts the very same one.

import React, { useEffect, useMemo, useRef } from "react";
import type { ModelOverview } from "@api";
import { CliPanel } from "../../_shared/cli/components/CliPanel";
import type { CliPanelDriver, CliPanelPlan } from "../../_shared/cli/components/CliPanel";
import { createSession, executeRun, planRun } from "../cli/execute";
import { createLiveGateway } from "../cli/gateway";
import { CliError } from "../cli/lex";
import { CLI_LANGUAGE_ID, registerCliLanguage, setCliLanguageContext } from "../cli/cliLanguage";

export interface CommandPanelProps {
  connectionId: string;
  overview: ModelOverview | null;
  readOnly: boolean;
  /** Install a fresh overview in the app after a run changed the model. */
  onApplyOverview: (o: ModelOverview) => void;
  onClose: () => void;
  /** Whether the reference-guide side pane is currently open. */
  referenceOpen: boolean;
  /** Toggle the reference-guide side pane (lives beside the sections). */
  onToggleReference: () => void;
}

export function CommandPanel({
  connectionId,
  overview,
  readOnly,
  onApplyOverview,
  onClose,
  referenceOpen,
  onToggleReference,
}: CommandPanelProps): React.ReactElement {
  const gateway = useMemo(createLiveGateway, []);

  useEffect(() => {
    registerCliLanguage();
  }, []);
  useEffect(() => setCliLanguageContext(overview), [overview]);

  // Live ref so the driver (captured by the shared panel) sees current state.
  const stateRef = useRef({ connectionId, overview, readOnly });
  stateRef.current = { connectionId, overview, readOnly };

  const driver: CliPanelDriver = useMemo(
    () => ({
      languageId: CLI_LANGUAGE_ID,
      storagePrefix: "calcula.modelEditor.cli",
      banner: "Model Editor command line — type 'help' to get started.",
      readOnlyNote: readOnly ? "read-only model — edits disabled" : null,
      plan(text: string): CliPanelPlan {
        const st = stateRef.current;
        if (!st.overview) {
          throw new CliError("No model loaded for this connection.");
        }
        // A FRESH session per run, exactly as before: wildcard expansion and
        // read-modify-write carry operate on the overview at run entry.
        const session = createSession(st.connectionId, st.overview, st.readOnly, gateway);
        const plan = planRun(text, session);
        return {
          writeLabels: plan.writeLabels,
          needsConfirm: plan.needsConfirm,
          confirmNote: plan.writeLabels.length > 1 ? "one undo step, all-or-nothing" : null,
          async execute(io) {
            const outcome = await executeRun(plan, session, io);
            if (outcome.overview) onApplyOverview(outcome.overview);
          },
        };
      },
    }),
    [gateway, onApplyOverview, readOnly],
  );

  return (
    <CliPanel
      driver={driver}
      onClose={onClose}
      referenceOpen={referenceOpen}
      onToggleReference={onToggleReference}
      closeShortcut="Ctrl+`"
    />
  );
}
