//! FILENAME: app/extensions/_shared/dsl/pivotLayout/describeQuery/DraftTurnView.tsx
// PURPOSE: One turn of the transcript: what was asked, what came back, the diff
//          against the editor, and Accept / Reject.
// CONTEXT: THE DIFF LIVES INSIDE THE TURN. It was tempting to hold a single
//          "pending draft" beside the transcript, but then an older turn's
//          "use this one" and the pending draft's Accept are two buttons that
//          write the same editor from two different states, and there are two
//          answers to "accept against which text?". One turn, one Accept, one
//          answer.
//
//          ACCEPT RE-CHECKS. The turn was drafted against the editor as it was;
//          by the time the button is pressed the person may have accepted a
//          later turn, typed, or taken a suggestion chip. So the click asks
//          `recheck` first and can come back "that is the query you already
//          have" instead of writing. The neighbouring suggestion row settled
//          this exact question the same way.

import React, { useCallback } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { LANGUAGE_ID } from "../pivotDslLanguage";
import { dispositionNote, showsDiff, type DraftTurn } from "./turns";
import * as S from "./styles";

interface DraftTurnViewProps {
  turn: DraftTurn;
  /** The editor's text NOW — the diff's left pane and Accept's baseline. */
  currentDsl: string;
  onAccept: (turn: DraftTurn) => void;
  onReject: (turn: DraftTurn) => void;
}

export function DraftTurnView({
  turn,
  currentDsl,
  onAccept,
  onReject,
}: DraftTurnViewProps): React.ReactElement {
  const accept = useCallback(() => onAccept(turn), [onAccept, turn]);
  const reject = useCallback(() => onReject(turn), [onReject, turn]);

  const draft = turn.draft;
  const actionable = turn.disposition === "pending" || turn.disposition === "invalid";
  const withDiff = showsDiff(turn, currentDsl);
  const note = dispositionNote(turn);

  return (
    <div
      className="calcula-dq-turn"
      style={S.turnBox}
      data-testid={`describe-query-turn-${turn.id}`}
      data-disposition={turn.disposition}
    >
      <div style={S.askLine}>
        <span style={{ flex: 1 }}>{turn.intent}</span>
        {/* WHICH model answered THIS turn. Not the current selection: the model
            is switchable from the composer below, and relabelling history on a
            switch would misreport where these answers came from. */}
        <span style={S.meta}>{turn.model}</span>
      </div>

      {turn.failure ? (
        <div style={S.badNote} data-testid="describe-query-failure">
          {turn.failure}
        </div>
      ) : null}

      {draft ? (
        <div
          style={draft.status === "compiled" ? S.okNote : S.badNote}
          data-testid={`describe-query-result-${draft.status}`}
        >
          {draft.summary}
          {draft.explanation ? ` ${draft.explanation}` : ""}
          {draft.status === "invalid" && draft.errors.length > 0
            ? "\n" +
              draft.errors
                .slice(0, 4)
                .map((e) => `- line ${e.location.line}: ${e.message}`)
                .join("\n")
            : ""}
        </div>
      ) : null}

      {withDiff && draft ? (
        <div style={S.diffBox} data-testid="describe-query-diff">
          <DiffEditor
            // Tall enough for a whole short query rather than the two visible
            // lines the 560px dialog allowed — a diff clipped mid-line is worse
            // than no diff, because it looks like the change is smaller than it
            // is. Side-by-side halves the usable width, so this is the one place
            // in the panel that genuinely needs the blade's room.
            height="220px"
            original={currentDsl}
            modified={draft.dsl}
            language={LANGUAGE_ID}
            theme="vs"
            options={{
              readOnly: true,
              renderSideBySide: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              lineNumbers: "off",
              glyphMargin: false,
              folding: false,
              fontSize: 11,
              lineHeight: 16,
              renderOverviewRuler: false,
              overviewRulerLanes: 0,
              automaticLayout: true,
              scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
            }}
          />
        </div>
      ) : draft && actionable ? (
        // No left-hand side to compare against: show the query plainly. A diff
        // whose original pane is empty is a worse way to read a query than the
        // query itself.
        <pre style={S.queryPre} data-testid="describe-query-proposal">
          {draft.dsl}
        </pre>
      ) : null}

      {note ? <div style={S.note}>{note}</div> : null}

      {actionable ? (
        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
          <button
            type="button"
            onClick={accept}
            style={S.primaryButton}
            data-testid={`describe-query-accept-${turn.id}`}
          >
            {turn.disposition === "invalid" ? "Put it in the editor anyway" : "Use this query"}
          </button>
          <button
            type="button"
            onClick={reject}
            style={S.quietButton}
            data-testid={`describe-query-reject-${turn.id}`}
          >
            Discard
          </button>
        </div>
      ) : null}
    </div>
  );
}
