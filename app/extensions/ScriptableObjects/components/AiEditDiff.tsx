//! FILENAME: app/extensions/ScriptableObjects/components/AiEditDiff.tsx
// PURPOSE: Show what the AI proposes, side by side with what is there now, say
//          WHY the run ended the way it did, and make the author choose.
// CONTEXT: 2026-08-25. Requested directly: "when AI edits a script it does not
//          save it directly but rather we get like a diff window and the user is
//          then prompted to either accept or reject". This is that window.
//
//          It renders for BOTH document kinds, and says something different for
//          each, because the consequence of Accept differs. An object script is
//          applied when the author presses Save. A recorded MACRO auto-persists
//          about a second after the buffer changes — so for a macro, Accept IS
//          effectively the save, and the button says so instead of pretending
//          there is another step in between.
//
//          2026-08-26 — "I saw the diff page (it looked nice), however it did
//          not change anything (maybe that was as it should be) but I could not
//          see the reasoning or the results from the chat." Two defects, both
//          here. The header printed ONE sentence — "The model read the script
//          and made no change to it" — for a model that genuinely found nothing
//          to change, for a model that reformatted whitespace, for a run that
//          exhausted every repair round, and for an author who had typed while
//          it ran and would have LOST that typing on Accept. And nothing in this
//          window showed a word the model said.
//
//          THE WORDING IS NOT DECIDED HERE. `editVerdict` owns it, so the strip
//          and this window cannot describe one run two ways, and a re-collapse
//          of two facts into one sentence reds a distinctness test rather than
//          shipping.

import React from "react";
import { DiffEditor } from "@monaco-editor/react";
import { dryRunCaveat } from "@api/scriptHost/scriptPreview/dryRunCaveat";
import { editVerdict, outcomeOf, type AuthoringRun } from "@api/scriptHost/authoringRun";
import { RunLog } from "../../_shared/components/RunLog";
import { formatElapsed } from "../../_shared/formatElapsed";
import { runLogRows } from "../lib/runLogRows";
import type { AiEditDocumentKind } from "../lib/crossWindowEvents";

interface AiEditDiffProps {
  documentName: string;
  documentKind: AiEditDocumentKind;
  /** What is in the buffer right now. */
  original: string;
  /** What the model proposes to replace it with. */
  proposed: string;
  language: string;
  /** The model's account of what it did. */
  summary: string;
  /**
   * The whole run — how it ended, what each attempt said, how long it took.
   *
   * NULL rather than absent: a provider that runs no repair loop, and a payload
   * built by an older main window, both have to land somewhere this component
   * can read without indexing into `undefined`.
   */
  run: AuthoringRun | null;
  /** The author's own words, echoed back so the diff restates the question. */
  instruction: string;
  /**
   * The source the model was HANDED.
   *
   * EMPTY MEANS "NOT KNOWN", never "known to be unchanged": a replayed result
   * carries none, and accusing the author of edits they did not make is worse
   * than saying nothing.
   */
  askedAgainst: string;
  /** Fallback for a payload with no `run` — a hand-written test double, or a
   *  third-party provider that legitimately runs no repair loop. */
  unchangedFallback?: boolean;
  /**
   * Handlers the proposed script registers that the preview never fired.
   *
   * REQUIRED, and normalised to `[]` by `aiEditClient` — a diff that silently
   * omitted this would tell the author the run "changed no cells" about code the
   * run never reached. Used only when the run itself carries none.
   */
  unexercisedHooks: string[];
  onAccept: () => void;
  onReject: () => void;
}

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

export function AiEditDiff(props: AiEditDiffProps): React.ReactElement {
  const { documentKind, original, proposed, run } = props;
  const identical = original === proposed;
  const isMacro = documentKind === "module";
  const outcome = run?.outcome ?? outcomeOf({ ok: true, unchanged: props.unchangedFallback });
  // UNKNOWN MUST NOT BE REPORTED AS MEASURED. A replayed result carries no
  // `askedAgainst`, and accusing the author of edits they did not make is worse
  // than saying nothing.
  const bufferMovedSinceAsk = props.askedAgainst ? props.askedAgainst !== original : false;
  const verdict = editVerdict({
    outcome,
    identicalToBuffer: identical,
    bufferMovedSinceAsk,
    model: run?.model ?? "",
    attempts: run?.attempts.length ?? 0,
    elapsedMs: run?.elapsedMs ?? 0,
  });
  const revertsTyping = outcome === "unchanged" && bufferMovedSinceAsk;
  const caveat = dryRunCaveat({
    changedNothing: run?.changedNothing ?? false,
    // THE RUN WINS ONLY WHEN IT HAS SOMETHING TO SAY. `run?.x ?? props.x` would
    // let a run that reported an EMPTY list silence a prop that was not empty,
    // and the sentence this decides — "it changed no cells" — is exactly the one
    // that must never stand alone when a handler was never fired.
    unexercisedHooks:
      run && run.unexercisedHooks.length > 0 ? run.unexercisedHooks : props.unexercisedHooks,
    tone: "review",
  });
  const logRows = React.useMemo(() => runLogRows(run), [run]);

  // Count changed lines cheaply, so the header can say how big this is before
  // the author reads a single line of it.
  const changed = React.useMemo(() => {
    if (identical) return 0;
    const a = original.split("\n");
    const b = proposed.split("\n");
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (
      tail < a.length - head &&
      tail < b.length - head &&
      a[a.length - 1 - tail] === b[b.length - 1 - tail]
    ) {
      tail++;
    }
    return Math.max(a.length - head - tail, b.length - head - tail);
  }, [original, proposed, identical]);

  return (
    <div
      style={OVERLAY}
      data-testid="ai-edit-diff"
      role="dialog"
      aria-modal="true"
      aria-label="Review the AI's proposed change"
    >
      <div style={PANEL}>
        {/* ---- Header ---- */}
        <div
          style={{
            padding: "10px 14px",
            borderBottom: "1px solid #333",
            flexShrink: 0,
            backgroundColor: "#252526",
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: "#E8E8E8" }}>
            Review the proposed change &mdash; {props.documentName}
          </div>
          {/* WHAT WAS ASKED. It rode the wire so a REPLAYED result can restate
              it: this window may have been closed and reopened since. */}
          {props.instruction && (
            <div
              data-testid="ai-edit-diff-instruction"
              style={{ fontSize: 11, color: "#9A9A9A", marginTop: 3, lineHeight: 1.5 }}
            >
              You asked: &ldquo;{props.instruction}&rdquo;
            </div>
          )}
          {verdict.headline && (
            <div
              data-testid="ai-edit-diff-verdict"
              style={{
                fontSize: 11,
                color: revertsTyping ? "#E3B341" : "#D4D4D4",
                fontWeight: 600,
                marginTop: 4,
                lineHeight: 1.5,
              }}
            >
              {verdict.headline}
            </div>
          )}
          {verdict.detail && (
            <div
              data-testid="ai-edit-diff-detail"
              style={{ fontSize: 11, color: "#B0B0B0", marginTop: 2, lineHeight: 1.5 }}
            >
              {verdict.detail}
            </div>
          )}
          {/* THE SCALE LINE ONLY WHEN THERE IS NOTHING BETTER TO SAY. A verdict
              that already explains the run must not be followed by a bare line
              count restating half of it. */}
          {verdict.headline === "" && (
            <div style={{ fontSize: 11, color: "#B0B0B0", marginTop: 3, lineHeight: 1.5 }}>
              <span data-testid="ai-edit-diff-scale">
                {changed} line{changed === 1 ? "" : "s"} differ. Nothing has been written to your
                script yet.
              </span>
            </div>
          )}
          {props.summary && (
            <div
              data-testid="ai-edit-diff-summary"
              style={{ fontSize: 11, color: "#9CDCFE", marginTop: 5, lineHeight: 1.5 }}
            >
              {props.summary}
            </div>
          )}
          {/* WHAT THE RUN COULD NOT MEASURE. The summary above reports what the
              preview saw; a handler it never fired produced no evidence at all,
              and "it changed no cells" read as a finding about the script is how
              a sound draft gets rejected — or a broken one accepted. */}
          {caveat && (
            <div
              data-testid="ai-edit-diff-unexercised"
              style={{ fontSize: 11, color: "#E3B341", marginTop: 5, lineHeight: 1.5 }}
            >
              {caveat}
            </div>
          )}
          {/* WHAT THE CHECKS NOTICED. Never a rejection — the scanner cannot
              follow computed access, and a notice is information for the person
              — but Accept is the gesture that grants a declared capability, so
              it belongs in front of the finger.

              THE HEADING IS DELIBERATELY NEUTRAL. The record carries whole
              sentences and no codes (it is mirrored in Rust and read as a log),
              so this box cannot tell a declaration notice from a run-target one
              — and "check what it declares" over "you will not be able to press
              Run on this" is the exact mis-filing the guided screen and the chat
              were just fixed for. A heading that is true of every notice beats a
              sharper one that is sometimes a lie. */}
          {run && run.notices.length > 0 && (
            <div
              data-testid="ai-edit-diff-notices"
              style={{ fontSize: 11, color: "#E3B341", marginTop: 5, lineHeight: 1.5 }}
            >
              <div style={{ fontWeight: 600 }}>
                Nothing here blocks the change, but read it before you accept:
              </div>
              {run.notices.map((n, i) => (
                <div key={i}>- {n}</div>
              ))}
            </div>
          )}
        </div>

        {/* ---- The diff ---- */}
        <div style={{ flex: 1, minHeight: 0 }}>
          <DiffEditor
            original={original}
            modified={proposed}
            language={props.language}
            theme="vs-dark"
            options={{
              readOnly: true,
              renderSideBySide: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              fontSize: 12,
              renderOverviewRuler: false,
              automaticLayout: true,
            }}
          />
        </div>

        {/* ---- What the model actually did ----
            OPEN unless the run simply changed the script: for an ordinary
            change the diff IS the answer and the log would push it off screen
            (this panel is min(760px,90vh) and the diff has flex: 1). For every
            other outcome the log is the answer, so it starts open. */}
        {run && (
          <details
            open={outcome !== "changed"}
            style={{
              flexShrink: 0,
              borderTop: "1px solid #333",
              backgroundColor: "#252526",
              padding: "6px 14px 8px",
              color: "#D4D4D4",
              fontSize: 11,
            }}
          >
            <summary style={{ cursor: "pointer", color: "#9CDCFE" }}>
              What the model did &mdash; {run.attempts.length} attempt
              {run.attempts.length === 1 ? "" : "s"}
            </summary>
            <div
              data-testid="ai-edit-run-stats"
              style={{ color: "#9A9A9A", margin: "4px 0 5px", lineHeight: 1.5 }}
            >
              {run.model || "model"} &middot; {run.attempts.length} attempt
              {run.attempts.length === 1 ? "" : "s"} &middot; {formatElapsed(run.elapsedMs)}
              {run.elided ? " · some of this was shortened to fit" : ""}
            </div>
            <RunLog
              rows={logRows}
              theme="dark"
              maxHeight={220}
              emptyText="The model was never reached."
              data-testid="ai-edit-run-log"
            />
          </details>
        )}

        {/* ---- The decision ---- */}
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
          <div style={{ flex: 1, fontSize: 11, color: revertsTyping ? "#E3B341" : "#9A9A9A", lineHeight: 1.4 }}>
            {revertsTyping
              ? "You have typed since you asked. Accepting replaces what you typed with the version the model was given. "
              : ""}
            {isMacro
              ? "Accepting replaces the macro in the editor and saves it within a second — the current version is then gone."
              : "Accepting replaces the text in the editor. Nothing runs until you press Save."}
          </div>
          <button
            className="ose-btn"
            data-testid="ai-edit-reject"
            onClick={props.onReject}
            title="Discard the proposal. Your script is left exactly as it is."
          >
            Reject
          </button>
          <button
            className="ose-btn primary"
            data-testid="ai-edit-accept"
            onClick={props.onAccept}
            disabled={identical}
            title={
              identical
                ? "The proposal is identical to your script; there is nothing to accept."
                : revertsTyping
                  ? "Replace what you have typed with the earlier version the model was given"
                  : isMacro
                    ? "Replace the macro with this and save it"
                    : "Replace the text in the editor with this"
            }
          >
            {identical
              ? "Nothing to accept"
              : revertsTyping
                ? "Accept (replaces your edits)"
                : isMacro
                  ? "Accept and save"
                  : "Accept"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default AiEditDiff;
