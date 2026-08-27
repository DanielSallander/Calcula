//! FILENAME: app/extensions/ScriptableObjects/components/ScriptHistoryPanel.tsx
// PURPOSE: Read the conversation that produced this script — what was asked,
//          what the model said back, what the checks made of it, and what was
//          decided.
// CONTEXT: 2026-08-26, reported: "I could not see the reasoning or the results
//          from the chat." There was nowhere to look. The reply's prose was
//          discarded at `extractScript`, the reasoning deltas were dropped by
//          the stream listener, and nothing was ever written down — so the run
//          that produced a script existed only as one summary sentence, and
//          only until the window closed.
//
//          THE LIVE RUN COMES FIRST, and that ordering is the report itself.
//          The author was looking at an UNDECIDED proposal when they went
//          looking for the reasoning; a panel that reads only the backend would
//          have shown them nothing at that exact moment, because an EDIT run is
//          not persisted until a human presses Accept, Reject or Save. (A
//          CREATE draft's run, by contrast, is already on the backend under its
//          `draft-*` id — session-only until Save adopts it.)
//
//          IT IS A VIEW. Loading and deleting are the app's, so this file has no
//          backend import and no opinion about when a read happens.

import React from "react";
import { RunLog } from "../../_shared/components/RunLog";
import { formatElapsed } from "../../_shared/formatElapsed";
import { runLogRows, dryRunLine } from "../lib/runLogRows";
import type { AuthoringRun, RunAttempt, RunOutcome, RunDecision } from "@api/scriptHost/authoringRun";

const OVERLAY: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  backgroundColor: "rgba(0,0,0,0.55)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 3000,
};

const PANEL: React.CSSProperties = {
  width: "min(1100px, 94vw)",
  height: "min(760px, 90vh)",
  backgroundColor: "#1E1E1E",
  border: "1px solid #454545",
  borderRadius: 4,
  display: "flex",
  flexDirection: "column",
  boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
  overflow: "hidden",
};

const CARD: React.CSSProperties = {
  border: "1px solid #333",
  borderRadius: 4,
  backgroundColor: "#252526",
  padding: "8px 10px",
  marginBottom: 10,
};

const MONO: React.CSSProperties = {
  fontFamily: "Consolas, monospace",
  fontSize: 11,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  backgroundColor: "#1E1E1E",
  border: "1px solid #333",
  borderRadius: 4,
  padding: "5px 7px",
  maxHeight: 220,
  overflowY: "auto",
  color: "#D4D4D4",
};

/** Plain second-person wording. The enum is a machine's word, not a reader's. */
const OUTCOME_TEXT: Record<RunOutcome, string> = {
  changed: "It proposed a change",
  unchanged: "It returned the script unchanged",
  stalled: "It made the same mistake every attempt",
  exhausted: "It ran out of attempts",
  failed: "The run did not finish",
  cancelled: "You stopped it",
  refused: "It never started",
};

const DECISION_TEXT: Record<RunDecision, string> = {
  accepted: "you accepted it",
  rejected: "you rejected it",
  saved: "you saved it",
};

function whenText(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString();
}

function AttemptBlock(props: { attempt: RunAttempt }): React.ReactElement {
  const a = props.attempt;
  const errors = a.findings.filter((f) => f.severity === "error");
  const notices = a.findings.filter((f) => f.severity === "notice");
  return (
    <div
      data-testid="script-history-round"
      data-round={String(a.attempt)}
      style={{ borderTop: "1px solid #333", paddingTop: 6, marginTop: 6 }}
    >
      <div style={{ color: a.ok ? "#6A9955" : "#D7BA7D", fontWeight: 600 }}>
        Attempt {a.attempt} &mdash; {a.ok ? "passed every check" : "rejected"} &middot;{" "}
        {formatElapsed(a.durationMs)}
      </div>
      {errors.length > 0 && (
        <div style={{ color: "#F48771", marginTop: 2, lineHeight: 1.5 }}>
          {errors.map((f, i) => (
            <div key={i}>- {f.message}</div>
          ))}
        </div>
      )}
      {notices.length > 0 && (
        <div style={{ color: "#E3B341", marginTop: 2, lineHeight: 1.5 }}>
          {notices.map((f, i) => (
            <div key={i}>- {f.message}</div>
          ))}
        </div>
      )}
      {a.dryRun && (
        <div style={{ color: "#9A9A9A", marginTop: 2 }}>Run against a copy: {dryRunLine(a.dryRun)}</div>
      )}
      {/* THE WHOLE REPLY, prose and all. Not the extracted script: the sentence
          the author went looking for is the one the model wrote AROUND its
          code, and this is the only place it survives. */}
      <div style={{ color: "#9A9A9A", margin: "5px 0 2px" }}>
        What it replied
        {a.replyChars > a.reply.length
          ? ` (shortened from ${a.replyChars} characters)`
          : ""}
      </div>
      <div data-testid="script-history-reply" style={MONO}>
        {a.reply || "(it said nothing)"}
      </div>
      {a.reasoning && (
        <details style={{ marginTop: 4 }}>
          <summary style={{ cursor: "pointer", color: "#9CDCFE" }}>
            Show reasoning
            {a.reasoningChars > a.reasoning.length
              ? ` (${a.reasoningChars} characters, shortened)`
              : ""}
          </summary>
          <div data-testid="script-history-reasoning" style={{ ...MONO, marginTop: 4 }}>
            {a.reasoning}
          </div>
        </details>
      )}
    </div>
  );
}

function RunCard(props: {
  run: AuthoringRun;
  index: number;
  live: boolean;
}): React.ReactElement {
  const r = props.run;
  return (
    <div
      data-testid={props.live ? "script-history-live" : "script-history-run"}
      data-run-index={String(props.index)}
      data-outcome={r.outcome}
      data-decision={r.decision ?? ""}
      style={CARD}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
        <div style={{ fontWeight: 600, color: "#E8E8E8", flex: 1 }}>
          {OUTCOME_TEXT[r.outcome]}
          {r.decision ? ` — ${DECISION_TEXT[r.decision]}` : ""}
        </div>
        <div style={{ color: "#7A7A7A" }}>
          {props.live ? "this proposal — not yet saved" : whenText(r.startedAt)}
        </div>
      </div>
      <div style={{ color: "#D4D4D4", marginTop: 3, lineHeight: 1.5 }}>
        You asked: &ldquo;{r.instruction}&rdquo;
      </div>
      <div style={{ color: "#9A9A9A", marginTop: 2 }}>
        {r.model || "no model"} &middot; {r.tier || "unknown tier"} &middot; {r.attempts.length}{" "}
        attempt{r.attempts.length === 1 ? "" : "s"} &middot; {formatElapsed(r.elapsedMs)} &middot;{" "}
        {r.surfaceTokens} tokens of API shown{r.surfaceTruncated ? " (truncated)" : ""}
      </div>
      {r.summary && <div style={{ color: "#9CDCFE", marginTop: 3 }}>{r.summary}</div>}
      {r.notices.length > 0 && (
        <div style={{ color: "#E3B341", marginTop: 3, lineHeight: 1.5 }}>
          {r.notices.map((n, i) => (
            <div key={i}>- {n}</div>
          ))}
        </div>
      )}
      {r.elided && (
        <div data-testid="script-history-elided" style={{ color: "#E3B341", marginTop: 3 }}>
          Some of this was shortened to keep the log small. What is missing is marked where it was
          cut.
        </div>
      )}
      {r.attempts.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <RunLog rows={runLogRows(r)} theme="dark" maxHeight={160} />
        </div>
      )}
      {r.attempts.map((a, i) => (
        <AttemptBlock key={i} attempt={a} />
      ))}
    </div>
  );
}

export interface ScriptHistoryPanelProps {
  scriptName: string;
  /** The proposal on screen that nobody has decided about yet, if any. */
  liveRun: AuthoringRun | null;
  /** What the workbook has recorded for this script, newest first. */
  runs: readonly AuthoringRun[];
  /** True while the backend read is in flight. */
  loading?: boolean;
  /** Forget the persisted runs. The author's own words, removable. */
  onClear: () => void;
  onClose: () => void;
}

export function ScriptHistoryPanel(props: ScriptHistoryPanelProps): React.ReactElement {
  const empty = !props.liveRun && props.runs.length === 0;
  return (
    <div
      style={OVERLAY}
      data-testid="script-history-panel"
      role="dialog"
      aria-modal="true"
      aria-label="How this script was written"
    >
      <div style={PANEL}>
        <div
          style={{
            padding: "10px 14px",
            borderBottom: "1px solid #333",
            backgroundColor: "#252526",
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#E8E8E8" }}>
              How this script was written &mdash; {props.scriptName}
            </div>
            <div style={{ fontSize: 11, color: "#9A9A9A", marginTop: 3, lineHeight: 1.5 }}>
              Every run you decided about is kept in this workbook. A proposal you have not
              decided about yet is shown first and is not saved with the script until you decide.
            </div>
          </div>
          <button className="ose-btn" data-testid="script-history-close" onClick={props.onClose}>
            Close
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "10px 14px", fontSize: 11 }}>
          {props.liveRun && <RunCard run={props.liveRun} index={-1} live />}
          {props.runs.map((r, i) => (
            <RunCard key={r.runId || i} run={r} index={i} live={false} />
          ))}
          {empty && (
            <div data-testid="script-history-empty" style={{ color: "#9A9A9A", lineHeight: 1.6 }}>
              {props.loading
                ? "Reading the history..."
                : "Nothing recorded. An edit is written down when you accept or reject it; a draft's creation run is recorded when the draft arrives and kept once you save it."}
            </div>
          )}
        </div>

        <div
          style={{
            padding: "10px 14px",
            borderTop: "1px solid #333",
            backgroundColor: "#252526",
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexShrink: 0,
          }}
        >
          <div style={{ flex: 1, fontSize: 11, color: "#9A9A9A", lineHeight: 1.4 }}>
            This is stored in the workbook, so it travels with the file. Deleting it cannot be
            undone.
          </div>
          <button
            className="ose-btn"
            data-testid="script-history-clear"
            onClick={props.onClear}
            disabled={props.runs.length === 0}
            title={
              props.runs.length === 0
                ? "There is nothing recorded to delete."
                : "Delete everything recorded about how this script was written"
            }
          >
            Delete this history
          </button>
        </div>
      </div>
    </div>
  );
}

export default ScriptHistoryPanel;
