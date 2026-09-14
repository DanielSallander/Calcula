//! FILENAME: app/extensions/_shared/dsl/pivotLayout/describeQuery/DescribeQueryPanel.tsx
// PURPOSE: Describe a report in words, see what the model proposes against what
//          you already have, and decide.
// CONTEXT: Replaces `DescribeQueryRow`, which was a single-line input that
//          OVERWROTE the editor the instant a draft arrived.
//
// FOUR RULES THIS PANEL KEEPS — the first three inherited, the fourth new:
//
//  1. NOTHING IS CREATED BY A DRAFT. The query lands in the EDITOR, where the
//     host's own Create / Save / Apply is still the person's click.
//
//  2. THE SENTENCE IS EARNED. "Compiled by Calcula" appears only when the
//     compiler produced a request; "ran on the model" only when a dry run
//     answered. A declined reply puts nothing anywhere.
//
//  3. SILENCE READS AS A HANG. A local CPU model takes seconds per generation,
//     so the phase line says which round it is on and what is happening.
//
//  4. NOTHING IS OVERWRITTEN WITHOUT BEING SHOWN. A draft that would replace
//     existing text waits behind a side-by-side diff and an explicit Accept.
//     An EMPTY editor is the exception and is applied straight through: there is
//     nothing to lose, and a diff against nothing is a worse way to read a query
//     than the query. That exception is why `onApply` is still called without a
//     click in one case, and why the prop was renamed from `onDraft` — every
//     call site had to be re-read rather than silently keeping auto-apply.
//
// WHY A TRANSCRIPT AND NOT A SINGLE PENDING DRAFT. Because a follow-up needs the
// turn it refines (owner decision 2026-09-14: "make it monthly" should edit the
// previous query, not start over), and because an answer you discarded is still
// worth seeing while you write the next ask.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAiCompletionProvider, hasAiCompletionProvider } from "@api";
import type { DesignQueryModel } from "@api/designQueryAssist";
import { draftDesignQuery, type DraftPhase } from "../draft";
import { compileDesignQuery, type DesignQueryRequest } from "../designQuery";
import type { BiPivotModelInfo } from "../../../components/types";
import type { DryRunSummary } from "../draft";
import { DraftTurnView } from "./DraftTurnView";
import { ModelChooserRow } from "../../../components/ModelChooserRow";
import * as SZ from "./panelSize";
import * as S from "./styles";
import { dispositionFor, priorFor, recheck, type DraftTurn } from "./turns";

/** What a host has to supply for the panel to draft against its model. */
export interface DesignQueryAssistHost {
  connectionId: string;
  /** Run a compiled request without materialising anything. Optional. */
  dryRun?: (request: DesignQueryRequest) => Promise<DryRunSummary>;
}

export interface DescribeQueryPanelProps {
  biModel: BiPivotModelInfo | null | undefined;
  host: DesignQueryAssistHost;
  /**
   * The editor's text NOW. Every diff and every Accept is computed against this
   * value, never against a copy taken when the draft arrived.
   */
  currentDsl: string;
  /** Put a query into the editor. Called from an Accept, or on an empty editor. */
  onApply: (dsl: string) => void;
}

/** One sentence per phase, naming the round so a repair is visibly a repair. */
export function phaseText(phase: DraftPhase): string {
  switch (phase.kind) {
    case "asking":
      return phase.round === 1
        ? `Asking ${phase.model}…`
        : `Asking ${phase.model} again (try ${phase.round})…`;
    case "compiling":
      return "Compiling the query with Calcula…";
    case "repairing":
      return `Sending the compiler's findings back for repair (try ${phase.round})…`;
    case "running":
      return "Running it on the model…";
  }
}

export function DescribeQueryPanel({
  biModel,
  host,
  currentDsl,
  onApply,
}: DescribeQueryPanelProps): React.ReactElement | null {
  const [intent, setIntent] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("");
  const [turns, setTurns] = useState<DraftTurn[]>([]);
  const [height, setHeight] = useState<number>(() => SZ.readHeight());
  const [modelTick, setModelTick] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const nextId = useRef(1);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  // The editor's text, readable from a callback without making every callback
  // depend on it. Accept re-checks against THIS, which is why a stale closure
  // here would reintroduce the exact overwrite the panel exists to prevent.
  const currentRef = useRef(currentDsl);
  currentRef.current = currentDsl;

  useEffect(() => {
    S.ensureDescribeQueryStyles();
  }, []);
  useEffect(() => () => abortRef.current?.abort(), []);

  // Keep the newest turn in view. `scrollTop` only — no layout read, no
  // observer, and jsdom has neither `ResizeObserver` nor `scrollIntoView`.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, busy]);

  const run = useCallback(async () => {
    const text = intent.trim();
    if (!text || busy) return;
    const provider = getAiCompletionProvider();
    if (!provider) return;

    const id = nextId.current++;
    const modelLabel = provider.modelLabel() || "the model";

    if (!provider.isConfigured()) {
      setTurns((t) => [
        ...t,
        {
          id,
          intent: text,
          model: modelLabel,
          draft: null,
          failure:
            "No AI model is selected. Choose one below, or set one up in the AI Chat panel.",
          disposition: "failed",
        },
      ]);
      return;
    }
    if (!biModel) {
      setTurns((t) => [
        ...t,
        {
          id,
          intent: text,
          model: modelLabel,
          draft: null,
          failure: "The connection's model is still loading. Try again in a moment.",
          disposition: "failed",
        },
      ]);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setIntent("");

    // The turn being refined is decided BEFORE the ask, from the transcript as
    // it stands — the most recent answer the person did not discard.
    const prior = priorFor(turns) ?? undefined;

    try {
      const draft = await draftDesignQuery(text, biModel as DesignQueryModel, {
        provider,
        compile: (dsl) => compileDesignQuery(dsl, host.connectionId, biModel),
        dryRun: host.dryRun,
        onPhase: (p) => setPhase(phaseText(p)),
        signal: controller.signal,
        prior,
      });

      const baseline = currentRef.current;
      const disposition = dispositionFor(draft, baseline);
      const turn: DraftTurn = {
        id,
        intent: text,
        model: draft.model || modelLabel,
        draft,
        failure: null,
        disposition,
      };

      // THE EMPTY-EDITOR EXCEPTION (rule 4). Nothing to overwrite, so nothing to
      // review: the query goes straight in and the turn records that it did.
      if (disposition === "pending" && baseline.trim() === "") {
        onApply(draft.dsl);
        turn.disposition = "applied";
      }

      setTurns((t) => [...t, turn]);
    } catch (e) {
      if (!controller.signal.aborted) {
        setTurns((t) => [
          ...t,
          {
            id,
            intent: text,
            model: modelLabel,
            draft: null,
            failure: e instanceof Error ? e.message : String(e),
            disposition: "failed",
          },
        ]);
      }
    } finally {
      setBusy(false);
      setPhase("");
      abortRef.current = null;
    }
  }, [intent, busy, biModel, host, onApply, turns]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const accept = useCallback(
    (turn: DraftTurn) => {
      // RE-CHECKED, not trusted. Between this draft arriving and this click the
      // editor may have moved under it.
      const fresh = recheck(turn, currentRef.current);
      if (fresh.disposition !== "pending" && fresh.disposition !== "invalid") {
        setTurns((t) => t.map((x) => (x.id === turn.id ? fresh : x)));
        return;
      }
      if (!fresh.draft) return;
      onApply(fresh.draft.dsl);
      setTurns((t) => t.map((x) => (x.id === turn.id ? { ...fresh, disposition: "applied" } : x)));
    },
    [onApply],
  );

  const reject = useCallback((turn: DraftTurn) => {
    setTurns((t) => t.map((x) => (x.id === turn.id ? { ...x, disposition: "rejected" } : x)));
  }, []);

  // ---- The resize grip -------------------------------------------------
  // Pointer events on the grip with capture, so a fast drag that leaves the
  // 6px strip keeps resizing instead of stopping dead.
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const onGripDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { startY: e.clientY, startH: height };
    },
    [height],
  );
  const onGripMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    setHeight(SZ.clampHeight(d.startH + (e.clientY - d.startY)));
  }, []);
  const onGripUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return;
      dragRef.current = null;
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      SZ.writeHeight(height);
    },
    [height],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // STOPPED, not merely default-prevented. Two of the five mounts bind
      // Enter to their dialog's Create button and Escape to closing the whole
      // dialog, and neither handler reads `defaultPrevented` — so without
      // `stopPropagation` typing a description and pressing Enter creates the
      // chart, and Escape throws the transcript away.
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        void run();
        return;
      }
      if (e.key === "Escape" || e.key === "Enter") e.stopPropagation();
    },
    [run],
  );

  const modelNote = useMemo(() => {
    void modelTick; // re-read after a selection change
    const p = getAiCompletionProvider();
    if (!p) return "";
    return p.isConfigured() ? "" : "No model is selected yet.";
  }, [modelTick]);

  if (!hasAiCompletionProvider()) return null;

  return (
    <div style={S.panel} data-testid="describe-query-row">
      {turns.length > 0 || busy ? (
        <>
          <div
            ref={transcriptRef}
            style={{ ...S.transcript, height }}
            data-testid="describe-query-transcript"
          >
            {turns.map((turn) => (
              <DraftTurnView
                key={turn.id}
                turn={turn}
                currentDsl={currentDsl}
                onAccept={accept}
                onReject={reject}
              />
            ))}
            {busy && phase ? (
              <div style={S.note} data-testid="describe-query-phase">
                <span className="calcula-dq-dot" aria-hidden="true">
                  ●
                </span>
                <span className="calcula-dq-dot" aria-hidden="true">
                  ●
                </span>
                <span className="calcula-dq-dot" aria-hidden="true">
                  ●
                </span>{" "}
                {phase}
              </div>
            ) : null}
          </div>
          <div
            className="calcula-dq-grip"
            style={S.grip}
            onPointerDown={onGripDown}
            onPointerMove={onGripMove}
            onPointerUp={onGripUp}
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize the transcript"
            data-testid="describe-query-grip"
          />
        </>
      ) : null}

      <div className="calcula-dq-composer" style={S.composer}>
        <textarea
          className="calcula-dq-input"
          value={intent}
          rows={Math.min(5, Math.max(1, intent.split("\n").length))}
          placeholder={
            turns.length > 0
              ? "Change it… (e.g. \"make it monthly\", \"only the top 10\")"
              : "Describe the report in words"
          }
          disabled={busy}
          onChange={(e) => setIntent(e.target.value)}
          onKeyDown={onKeyDown}
          style={S.textarea}
          aria-label="Describe the report in words"
        />
        <div style={S.composerFooter}>
          <ModelChooserRow disabled={busy} onChanged={() => setModelTick((n) => n + 1)} />
          {busy ? (
            <button
              type="button"
              onClick={stop}
              style={{ ...S.primaryButton, background: S.T.dangerFg }}
              data-testid="describe-query-stop"
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void run()}
              disabled={!intent.trim()}
              style={{ ...S.primaryButton, opacity: intent.trim() ? 1 : 0.5 }}
              data-testid="describe-query-draft"
            >
              {turns.length > 0 ? "Refine" : "Draft"}
            </button>
          )}
        </div>
      </div>
      {modelNote ? <div style={S.note}>{modelNote}</div> : null}
    </div>
  );
}
