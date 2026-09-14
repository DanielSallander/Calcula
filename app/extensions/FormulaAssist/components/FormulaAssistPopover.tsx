//! FILENAME: app/extensions/FormulaAssist/components/FormulaAssistPopover.tsx
// PURPOSE: The one surface of the feature: ask in your own words, watch it
//          work, read what the engine computed, then decide.
// CONTEXT: Registered once as an overlay at activation and rendered
//          permanently — it returns null while the store says `open: false`,
//          which is the FormulaAutocomplete pattern and costs nothing.
//
// THREE RULES THIS COMPONENT EXISTS TO KEEP:
//
//  1. NOTHING WRITES BEFORE A CLICK. Every path to `insertProposal` starts in
//     an onClick handler. There is no effect, no auto-accept, no "it was
//     verified so we applied it". A verified formula is still a suggestion.
//
//  2. THE BADGE IS EARNED, NOT DECORATIVE. "Verified by Calcula's engine"
//     renders if and only if `status === "verified"`, which the ladder grants
//     only for verdict `verified` AND rung f2 — the formula actually evaluated
//     at the target cell. An unverified formula gets the same monospace box
//     with no badge and its findings underneath; a DECLINED one gets the reason
//     and NO formula preview at all, because a preview is an implicit claim
//     that something was checked.
//
//  3. SILENCE READS AS A HANG. A local CPU model takes about fifteen seconds
//     per generation, and a repair round doubles that. The phase line names
//     what is happening right now and which round it is on, so a person can
//     tell "thinking" from "broken" without a spinner that means neither.
//
// The window is movable through `useDialogWindow`, the standing hook every new
// dialog is supposed to wire — a popover pinned over the cell it is writing is
// a popover covering the data the user wants to look at while they read it.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OverlayProps } from "@api";
import {
  columnToLetter,
  dispatchGridAction,
  getAiCompletionProvider,
  startEditing,
} from "@api";
import { useDialogWindow } from "@api/dialogWindow";
import { getGridStateSnapshot } from "@api/grid";
import type { FormulaProposal } from "@api/formulaAssistService";
import { ModelChooserRow } from "../../_shared/components/ModelChooserRow";
import { POPOVER_WIDTH, popoverPosition } from "../lib/anchor";
import { assistFormula, defaultLadderDeps } from "../lib/ladder";
import type { LadderPhase } from "../lib/ladder";
import { explainCell } from "../lib/explain";
import { insertProposal } from "../lib/insert";
import {
  closeAssist,
  getAssistState,
  setAssistState,
  useAssistState,
} from "../lib/store";

// ---------------------------------------------------------------------------
// The phase line
// ---------------------------------------------------------------------------

/** One sentence per rung, naming the round so a repair is visibly a repair. */
export function phaseText(phase: LadderPhase): string {
  switch (phase.kind) {
    case "context":
      return "Reading the data around the cell…";
    case "retrieval":
      return "Finding worked examples…";
    case "asking":
      return phase.round === 1
        ? `Asking ${phase.model}…`
        : `Asking ${phase.model} again (try ${phase.round})…`;
    case "verifying":
      return "Checking the formula with Calcula's engine…";
    case "repairing":
      return `Sending the engine's findings back for repair (try ${phase.round})…`;
  }
}

// ---------------------------------------------------------------------------
// Running a request
// ---------------------------------------------------------------------------

/**
 * Ask, and put the answer in the store.
 *
 * Exported so a test can drive the whole popover through its real code path
 * rather than poking state into it. Rejects for nothing: a transport failure
 * becomes `failure`, which the popover renders as a sentence.
 */
export async function runAssist(signal?: AbortSignal): Promise<void> {
  const { target, intent } = getAssistState();
  if (!target || !intent.trim()) return;

  setAssistState({
    running: true,
    phase: "Reading the data around the cell…",
    proposal: null,
    failure: null,
    inserted: null,
  });

  try {
    const proposal = await assistFormula(
      {
        intent: intent.trim(),
        sheetIndex: target.sheetIndex,
        row: target.row,
        col: target.col,
        signal,
      },
      defaultLadderDeps((phase) => setAssistState({ phase: phaseText(phase) })),
    );
    setAssistState({ running: false, phase: "", proposal });
  } catch (err) {
    setAssistState({
      running: false,
      phase: "",
      failure: messageOf(err),
    });
  }
}

function messageOf(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const box: React.CSSProperties = {
  position: "fixed",
  width: POPOVER_WIDTH,
  maxHeight: "70vh",
  overflowY: "auto",
  background: "#FFF",
  border: "1px solid #D0D0D0",
  borderRadius: 6,
  boxShadow: "0 6px 20px rgba(0,0,0,0.18)",
  fontFamily: "Segoe UI, Tahoma, sans-serif",
  fontSize: 12,
  color: "#222",
  zIndex: 10000,
};

const header: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "8px 10px",
  borderBottom: "1px solid #EAEAEA",
  cursor: "move",
  fontWeight: 600,
};

const body: React.CSSProperties = { padding: 10 };

const intentInput: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "6px 8px",
  fontSize: 12,
  border: "1px solid #CCC",
  borderRadius: 3,
  outline: "none",
};

const mono: React.CSSProperties = {
  fontFamily: "Consolas, 'Courier New', monospace",
  fontSize: 12.5,
  background: "#F6F7F9",
  border: "1px solid #E2E4E8",
  borderRadius: 3,
  padding: "6px 8px",
  marginTop: 8,
  wordBreak: "break-all",
};

const badge: React.CSSProperties = {
  display: "inline-block",
  background: "#E8F5E9",
  color: "#1B5E20",
  border: "1px solid #A5D6A7",
  borderRadius: 10,
  padding: "1px 8px",
  fontSize: 11,
  fontWeight: 600,
};

const btn: React.CSSProperties = {
  padding: "4px 10px",
  fontSize: 11,
  border: "1px solid #CCC",
  borderRadius: 3,
  background: "#FFF",
  cursor: "pointer",
};

const btnPrimary: React.CSSProperties = {
  ...btn,
  background: "#4A86C8",
  borderColor: "#4A86C8",
  color: "#FFF",
};

const muted: React.CSSProperties = { color: "#666", marginTop: 6 };

const sectionLabel: React.CSSProperties = {
  fontSize: 11,
  color: "#666",
  marginTop: 10,
  marginBottom: 2,
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const FormulaAssistPopover: React.FC<OverlayProps> = () => {
  const state = useAssistState();
  const win = useDialogWindow({ minWidth: 340, minHeight: 200 });
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [insertError, setInsertError] = useState<string | null>(null);

  const provider = getAiCompletionProvider();
  const hasModel = provider !== null && provider.isConfigured();
  const modelLabel = provider?.modelLabel() ?? "";

  useEffect(() => {
    if (state.open) {
      win.reset();
      const id = window.setTimeout(() => inputRef.current?.focus(), 30);
      return () => window.clearTimeout(id);
    }
    return undefined;
    // `win` is recreated every render; keying on it would reset on each key
    // press. The open transition is the only thing that should refocus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.open]);

  // A request in flight when the popover closes must not keep a local model
  // busy for a person who has already walked away.
  useEffect(() => {
    if (!state.open && abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, [state.open]);

  const position = useMemo(() => {
    const anchor = state.anchor ?? { x: 220, y: 96, width: 0, height: 0 };
    return popoverPosition(anchor, {
      width: typeof window !== "undefined" ? window.innerWidth : 1280,
      height: typeof window !== "undefined" ? window.innerHeight : 800,
    });
  }, [state.anchor]);

  const ask = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setInsertError(null);
    void runAssist(controller.signal);
  }, []);

  const explain = useCallback(() => {
    const target = getAssistState().target;
    if (!target) return;
    setAssistState({ running: true, phase: "Reading the formula…" });
    void explainCell(target.row, target.col)
      .then((explanation) =>
        setAssistState({ running: false, phase: "", explanation }),
      )
      .catch((err) =>
        setAssistState({ running: false, phase: "", failure: messageOf(err) }),
      );
  }, []);

  const doInsert = useCallback(
    (fillDown: boolean) => {
      const proposal = getAssistState().proposal;
      if (!proposal) return;
      setInsertError(null);
      setAssistState({ inserting: true });
      void insertProposal(fillDown ? { ...proposal, fillDown: true } : proposal)
        .then((outcome) => {
          setAssistState({
            inserting: false,
            inserted: {
              a1: outcome.a1,
              cellsWritten: outcome.cellsWritten,
              selectionMoved: outcome.selectionMoved,
            },
          });
          if (outcome.refusal) setInsertError(outcome.refusal);
        })
        .catch((err) => {
          setAssistState({ inserting: false });
          setInsertError(messageOf(err));
        });
    },
    [],
  );

  const edit = useCallback(() => {
    const { proposal, target } = getAssistState();
    if (!proposal || !target) return;
    const snapshot = getGridStateSnapshot();
    // Puts the text in the editor WITHOUT committing: `startEditing` opens the
    // cell editor with a value; only Enter (or the formula bar's tick) writes.
    dispatchGridAction(
      startEditing({
        row: target.row,
        col: target.col,
        value: proposal.formulaLocalized,
        sourceSheetIndex: target.sheetIndex,
        sourceSheetName: snapshot?.sheetContext.activeSheetName,
      }),
    );
    closeAssist();
  }, []);

  if (!state.open || !state.target) return null;

  const target = state.target;
  const proposal = state.proposal;
  const snapshot = getGridStateSnapshot();
  const selectionMoved =
    !!snapshot?.selection &&
    (snapshot.selection.startRow !== target.row ||
      snapshot.selection.startCol !== target.col);

  return (
    <div
      ref={win.ref}
      role="dialog"
      aria-label="Formula Assist"
      style={{ ...box, left: position.left, top: position.top, ...win.style }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          closeAssist();
        }
      }}
    >
      <div style={header} onMouseDown={win.onHeaderMouseDown}>
        <span>Formula for {target.a1}</span>
        <button style={btn} onClick={closeAssist} aria-label="Close">
          ×
        </button>
      </div>

      <div style={body}>
        <input
          ref={inputRef}
          type="text"
          style={intentInput}
          placeholder="Describe the formula you want…"
          value={state.intent}
          disabled={state.running}
          onChange={(e) => setAssistState({ intent: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !state.running && state.intent.trim()) {
              e.preventDefault();
              ask();
            }
          }}
        />

        {selectionMoved && (
          <div style={muted}>
            The selection has moved. This request is still for {target.a1}.
          </div>
        )}

        {!hasModel && !state.running && !proposal && (
          <div style={muted} role="status">
            No AI model is selected. Choose one in the AI Chat panel to ask for a
            formula. Explain and Verify work without one.
          </div>
        )}

        {state.running && (
          <div style={{ ...muted, color: "#333" }} role="status" aria-live="polite">
            {state.phase || "Working…"}
          </div>
        )}

        {state.failure && !state.running && (
          <div style={{ ...muted, color: "#B3261E" }} role="alert">
            {state.failure}
          </div>
        )}

        {state.explanation && !proposal && (
          <div>
            <div style={sectionLabel}>What {target.a1} does</div>
            {state.explanation.bullets.length === 0 ? (
              <div>{state.explanation.text}</div>
            ) : (
              <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
                {state.explanation.bullets.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            )}
            {state.explanation.note && <div style={muted}>{state.explanation.note}</div>}
          </div>
        )}

        {proposal && <ResultCard proposal={proposal} />}

        {state.inserted && (
          <div style={{ ...muted, color: "#1B5E20" }} role="status">
            {state.inserted.cellsWritten === 1
              ? `Written to ${state.inserted.a1}.`
              : `Written to ${state.inserted.a1} and ${state.inserted.cellsWritten - 1} rows below it.`}
            {state.inserted.selectionMoved
              ? " Your selection had moved, so the formula went to the cell you asked about."
              : ""}
          </div>
        )}

        {insertError && (
          <div style={{ ...muted, color: "#B3261E" }} role="alert">
            {insertError}
          </div>
        )}

        <div
          style={{
            display: "flex",
            gap: 6,
            marginTop: 12,
            justifyContent: "flex-end",
            flexWrap: "wrap",
          }}
        >
          {target.existingFormula && !proposal && (
            <button style={btn} onClick={explain} disabled={state.running}>
              Explain
            </button>
          )}
          <button
            style={btn}
            onClick={ask}
            disabled={state.running || !state.intent.trim() || !hasModel}
          >
            Ask
          </button>
          <button
            style={btnPrimary}
            onClick={() => doInsert(false)}
            disabled={!canInsert(proposal) || state.inserting}
          >
            Insert
          </button>
          <button
            style={btn}
            onClick={() => doInsert(true)}
            disabled={!canInsert(proposal) || state.inserting}
          >
            Insert and fill down
          </button>
          <button
            style={btn}
            onClick={edit}
            disabled={!canInsert(proposal) || state.inserting}
          >
            Edit
          </button>
          <button style={btn} onClick={closeAssist}>
            Discard
          </button>
        </div>

        {proposal && proposal.model && (
          <div style={{ ...muted, fontSize: 11 }}>
            {proposal.model}
            {proposal.rounds > 1 ? ` · ${proposal.rounds} tries` : ""}
            {modelLabel && modelLabel !== proposal.model ? ` (model has since changed to ${modelLabel})` : ""}
          </div>
        )}

        {/* The model is changeable from EVERY AI surface, not just the chat and
            the report designer. A weak answer here is most often a weak MODEL,
            and being sent to another panel to fix that is the moment people give
            up on the feature. The chooser reaches the same one application
            preference, so switching here switches everywhere. */}
        <div style={{ marginTop: 6 }}>
          <ModelChooserRow hideScopeNote />
        </div>
      </div>
      {win.resizeHandles}
    </div>
  );
};

/**
 * A declined proposal has no insertable formula BY CONSTRUCTION — nothing was
 * checked, so there is nothing to offer.
 */
function canInsert(proposal: FormulaProposal | null): boolean {
  return (
    proposal !== null &&
    proposal.status !== "declined" &&
    proposal.status !== "no-model" &&
    proposal.formulaLocalized !== ""
  );
}

const ResultCard: React.FC<{ proposal: FormulaProposal }> = ({ proposal }) => {
  const v = proposal.verification;

  if (proposal.status === "declined") {
    // NO PREVIEW. Showing the formula here would imply it had been checked.
    return (
      <div style={{ marginTop: 10 }} role="status">
        <div style={{ fontWeight: 600, color: "#8A6D00" }}>Not offered</div>
        <div style={muted}>{v?.declineReason ?? proposal.summary}</div>
      </div>
    );
  }

  if (proposal.status === "no-model") {
    return (
      <div style={{ marginTop: 10 }} role="status">
        {proposal.summary}
      </div>
    );
  }

  const verified = proposal.status === "verified";

  return (
    <div style={{ marginTop: 10 }}>
      {verified ? (
        <span style={badge}>Verified by Calcula&apos;s engine</span>
      ) : (
        <span style={{ ...badge, background: "#FFF4E5", color: "#8A5300", borderColor: "#F0C68A" }}>
          Not verified
        </span>
      )}

      <div style={mono}>{proposal.formulaLocalized}</div>

      {v && v.display !== "" && (
        <div style={{ marginTop: 6 }}>
          <strong>{proposal.target.a1}</strong> would show{" "}
          <strong>{v.display}</strong>
          {v.error ? " (an error value)" : ""}
        </div>
      )}

      {proposal.fillDown && v && v.fillDownDisplays.length > 0 && (
        <div style={muted}>
          Filled down:{" "}
          {v.fillDownDisplays
            .map(
              (d, i) =>
                `${columnToLetter(proposal.target.col)}${proposal.target.row + 2 + i} = ${d}`,
            )
            .join(", ")}
        </div>
      )}

      {v?.spill && (
        <div style={muted}>
          Spills over {v.spill[0]} row{v.spill[0] === 1 ? "" : "s"} ×{" "}
          {v.spill[1]} column{v.spill[1] === 1 ? "" : "s"}.
        </div>
      )}

      {proposal.explanation && (
        <div style={{ marginTop: 8 }}>{proposal.explanation}</div>
      )}

      {proposal.assumptions.length > 0 && (
        <div>
          <div style={sectionLabel}>Assumptions</div>
          <ul style={{ margin: "2px 0 0 16px", padding: 0 }}>
            {proposal.assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      )}

      {!verified && (
        <div>
          <div style={sectionLabel}>Why it is not verified</div>
          <div>{proposal.summary}</div>
          {v && v.findings.length > 0 && (
            <ul style={{ margin: "2px 0 0 16px", padding: 0 }}>
              {v.findings.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};
