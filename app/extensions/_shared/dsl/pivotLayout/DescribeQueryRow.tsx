//! FILENAME: app/extensions/_shared/dsl/pivotLayout/DescribeQueryRow.tsx
// PURPOSE: "Describe the report in words" above a design-query editor: ask,
//          watch it work, and get a compiled query put into the editor.
// CONTEXT: One row, mounted by the shared editor for reports and charts and
//          by the pivot's Design tab. It renders nothing when no AI provider
//          is registered at all (the AI Chat extension is not loaded), and
//          explains itself when one is registered but no model is picked —
//          a disabled control with no reason is the failure this programme
//          keeps fixing.
//
// THREE RULES THIS COMPONENT KEEPS:
//
//  1. NOTHING IS CREATED BY THE DRAFT. The query lands in the EDITOR, where
//     the host's own Create / Save / Apply is still the person's click. A
//     compiled query is a suggestion with a green sentence under it.
//
//  2. THE SENTENCE IS EARNED. "Compiled by Calcula" appears only when the
//     compiler produced a request; "ran on the model" only when a dry run
//     answered. An invalid query still goes into the editor — with its errors
//     marked there and listed here — because the markers are the fastest way
//     to fix it. A declined reply puts nothing anywhere.
//
//  3. SILENCE READS AS A HANG. A local CPU model takes seconds per generation;
//     the phase line says which round it is on and what is happening.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { getAiCompletionProvider, hasAiCompletionProvider } from "@api";
import type { DesignQueryModel } from "@api/designQueryAssist";
import { draftDesignQuery, type DesignQueryDraft, type DraftPhase, type DryRunSummary } from "./draft";
import { compileDesignQuery, type DesignQueryRequest } from "./designQuery";
import type { BiPivotModelInfo } from "../../components/types";

/** What a host has to supply for the row to draft against its model. */
export interface DesignQueryAssistHost {
  connectionId: string;
  /** Run a compiled request without materialising anything. Optional. */
  dryRun?: (request: DesignQueryRequest) => Promise<DryRunSummary>;
}

interface DescribeQueryRowProps {
  biModel: BiPivotModelInfo | null | undefined;
  host: DesignQueryAssistHost;
  /** Put a drafted query into the editor. Called for compiled AND invalid drafts. */
  onDraft: (dsl: string) => void;
}

/** One sentence per phase, naming the round so a repair is visibly a repair. */
export function phaseText(phase: DraftPhase): string {
  switch (phase.kind) {
    case "asking":
      return phase.round === 1 ? `Asking ${phase.model}…` : `Asking ${phase.model} again (try ${phase.round})…`;
    case "compiling":
      return "Compiling the query with Calcula…";
    case "repairing":
      return `Sending the compiler's findings back for repair (try ${phase.round})…`;
    case "running":
      return "Running it on the model…";
  }
}

const rowStyle: React.CSSProperties = {
  display: "flex", gap: 6, alignItems: "center", marginBottom: 6,
};
const inputStyle: React.CSSProperties = {
  flex: 1, padding: "5px 8px", fontSize: 12,
  border: "1px solid var(--border-color, #d0d7de)", borderRadius: 4,
  background: "var(--input-bg, #fff)", color: "inherit",
};
const buttonStyle: React.CSSProperties = {
  padding: "5px 12px", fontSize: 12, borderRadius: 4, border: "none",
  background: "var(--accent-color, #2e7d5b)", color: "#fff", cursor: "pointer", whiteSpace: "nowrap",
};
const noteStyle: React.CSSProperties = {
  fontSize: 11, color: "var(--text-secondary, #666)", margin: "0 0 8px", whiteSpace: "pre-wrap",
};
const okStyle: React.CSSProperties = { ...noteStyle, color: "var(--success-color, #1f7a3f)" };
const badStyle: React.CSSProperties = { ...noteStyle, color: "var(--error-color, #b42318)" };

export function DescribeQueryRow({ biModel, host, onDraft }: DescribeQueryRowProps): React.ReactElement | null {
  const [intent, setIntent] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("");
  const [result, setResult] = useState<DesignQueryDraft | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const run = useCallback(async () => {
    const text = intent.trim();
    if (!text || busy) return;
    const provider = getAiCompletionProvider();
    if (!provider) return;
    if (!provider.isConfigured()) {
      setFailure("No AI model is selected. Choose one in the AI Chat panel, then try again.");
      return;
    }
    if (!biModel) {
      setFailure("The connection's model is still loading. Try again in a moment.");
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setFailure(null);
    setResult(null);
    try {
      const draft = await draftDesignQuery(text, biModel as DesignQueryModel, {
        provider,
        compile: (dsl) => compileDesignQuery(dsl, host.connectionId, biModel),
        dryRun: host.dryRun,
        onPhase: (p) => setPhase(phaseText(p)),
        signal: controller.signal,
      });
      if (draft.status !== "declined") onDraft(draft.dsl);
      setResult(draft);
    } catch (e) {
      if (!controller.signal.aborted) setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setPhase("");
      abortRef.current = null;
    }
  }, [intent, busy, biModel, host, onDraft]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  if (!hasAiCompletionProvider()) return null;

  const modelLabel = getAiCompletionProvider()?.modelLabel() || "";

  return (
    <div data-testid="describe-query-row">
      <div style={rowStyle}>
        <input
          type="text"
          value={intent}
          placeholder={modelLabel ? `Describe the report in words — ${modelLabel} drafts the query` : "Describe the report in words"}
          disabled={busy}
          onChange={(e) => setIntent(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void run();
            }
          }}
          style={inputStyle}
          aria-label="Describe the report in words"
        />
        {busy ? (
          <button type="button" onClick={stop} style={{ ...buttonStyle, background: "#C62828" }}>Stop</button>
        ) : (
          <button type="button" onClick={() => void run()} disabled={!intent.trim()} style={{ ...buttonStyle, opacity: intent.trim() ? 1 : 0.5 }}>
            Draft
          </button>
        )}
      </div>
      {busy && phase ? <div style={noteStyle} data-testid="describe-query-phase">{phase}</div> : null}
      {failure ? <div style={badStyle} data-testid="describe-query-failure">{failure}</div> : null}
      {result ? (
        <div
          style={result.status === "compiled" ? okStyle : badStyle}
          data-testid={`describe-query-result-${result.status}`}
        >
          {result.summary}
          {result.explanation ? ` ${result.explanation}` : ""}
          {result.status === "invalid" && result.errors.length > 0
            ? "\n" + result.errors.slice(0, 4).map((e) => `- line ${e.location.line}: ${e.message}`).join("\n")
            : ""}
        </div>
      ) : null}
    </div>
  );
}
