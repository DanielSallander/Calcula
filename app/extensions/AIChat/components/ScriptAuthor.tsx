//! FILENAME: app/extensions/AIChat/components/ScriptAuthor.tsx
// PURPOSE: The GUIDED path: two fields, then a background job you can walk away
//          from and come back to.
// CONTEXT: 2026-08-24, after three rounds of trying to make free chat produce a
//          script on a local model. The measured failure is TOOL SELECTION —
//          "is this a script?" and "which of two dozen tools?" — not code
//          generation. This screen deletes both questions by asking the user
//          instead, which takes one dropdown and one sentence.
//
//          WHY TWO FIELDS AND NOT A FORM. The intent is genuinely free text and
//          a form for "what should it do" is a worse text box. Only ONE thing
//          needs to be a control: the object type, because it decides which API
//          slice the model is shown and `draftGate` currently has to guess it
//          silently. Here the guess is visible and correctable.
//
//          THE SCREEN OWNS NOTHING. The run lives in `lib/authorJobs.ts`, and
//          this is a VIEW of it: closing the pane, or switching to another one,
//          no longer abandons a job that has spent minutes of a slow model's
//          time. Reported the same day — along with the layout below, where the
//          form, the log and the result all competed for one scrolling column
//          and the result ended up in a two-line slot. Once a job exists the
//          form collapses to a summary line and the progress gets the space.

import React, { useState, useCallback, useSyncExternalStore } from "react";
import { DRAFT_OBJECT_TYPES } from "../lib/chatTools";
import {
  startAuthorJob, cancelJob, subscribeToJobs, latestJob, formatElapsed,
  type AuthorJob, type JobStep,
} from "../lib/authorJobs";
import { dryRunCaveat } from "../lib/dryRunNotes";
import { ActivityDot, type ActivityStatus } from "../../_shared/components/ActivityDot";
import { hasScriptEditorProvider, requireScriptEditorProvider } from "@api";

const wrap: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 10, padding: 12, flex: 1, minHeight: 0 };
const label: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: "#444" };
const hint: React.CSSProperties = { fontSize: 11, color: "#777", margin: 0, lineHeight: 1.45 };
const area: React.CSSProperties = { resize: "vertical", padding: 6, border: "1px solid #CCC", borderRadius: 4, fontFamily: "inherit", fontSize: 12, minHeight: 64 };
const select: React.CSSProperties = { padding: "5px 8px", border: "1px solid #CCC", borderRadius: 4, fontSize: 12, background: "#FFF", color: "#333" };
const btn: React.CSSProperties = { padding: "6px 14px", border: "none", borderRadius: 4, background: "#0078D4", color: "#FFF", cursor: "pointer", fontSize: 12 };
const stopBtn: React.CSSProperties = { ...btn, background: "#C62828" };
const ghostBtn: React.CSSProperties = { padding: "5px 12px", fontSize: 11, border: "1px solid #CCC", borderRadius: 4, background: "#FFF", color: "#555", cursor: "pointer" };
const openBtn: React.CSSProperties = { padding: "5px 12px", fontSize: 11, border: "1px solid #0078D4", borderRadius: 4, background: "#FFF", color: "#0078D4", cursor: "pointer" };
/** The recap of what was asked for, once the form is out of the way. */
const recapStyle: React.CSSProperties = { background: "#F3F6F9", border: "1px solid #DDE5EC", borderRadius: 6, padding: "8px 10px", fontSize: 11, color: "#455", lineHeight: 1.5 };
/** The live line. Given its own emphasis because it is the anti-hang signal. */
const liveStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 6, background: "#EEF4FB", border: "1px solid #CBDCEE", fontSize: 12, color: "#24547E" };
/** THE LOG GETS THE SPARE ROOM — flex:1 + minHeight:0, not a fixed maxHeight. */
const logBox: React.CSSProperties = { flex: 1, minHeight: 90, overflowY: "auto", background: "#FFF", border: "1px solid #E2E8EE", borderRadius: 6, padding: "6px 8px", fontFamily: "Consolas, monospace", fontSize: 11, color: "#456" };
const stepRow: React.CSSProperties = { display: "flex", gap: 6, padding: "1px 0", whiteSpace: "pre-wrap", wordBreak: "break-word" };
const stepTime: React.CSSProperties = { color: "#9AA7B2", flexShrink: 0, minWidth: 44, textAlign: "right" };
const okBox: React.CSSProperties = { background: "#EDF7ED", border: "1px solid #C6E7C6", borderRadius: 6, padding: "8px 10px", fontSize: 12, color: "#245C24", lineHeight: 1.45 };
const badBox: React.CSSProperties = { background: "#FDECEA", border: "1px solid #F5C6C2", borderRadius: 6, padding: "8px 10px", fontSize: 12, color: "#A1241B", lineHeight: 1.45 };
/** Amber, not red: "changed nothing" is something to check, not a failure. */
const warnBox: React.CSSProperties = { background: "#FFF8E6", border: "1px solid #EBD9A8", borderRadius: 6, padding: "8px 10px", fontSize: 12, color: "#6B5A1E", lineHeight: 1.45 };
const srcBox: React.CSSProperties = { background: "#FFF", border: "1px solid #E0E0E0", borderRadius: 6, padding: "8px 10px", fontFamily: "Consolas, monospace", fontSize: 11, whiteSpace: "pre", overflowX: "auto", maxHeight: 200, overflowY: "auto", color: "#222" };

const h = React.createElement;

export interface ScriptAuthorProps {
  providerId: string;
  model: string;
  baseUrl?: string;
  /** Prefilled when the user arrived from the chat's "author it properly" card. */
  initialIntent?: string;
  initialObjectType?: string;
  onBackToChat: () => void;
}

const STEP_MARK: Record<JobStep["kind"], string> = {
  info: "   ",
  roundOk: "[OK]",
  roundBad: "[!] ",
  done: "[OK]",
  error: "[!] ",
};

const STEP_COLOUR: Record<JobStep["kind"], string> = {
  info: "#556",
  roundOk: "#2E7D32",
  roundBad: "#B4690E",
  done: "#2E7D32",
  error: "#A1241B",
};

function statusOf(job: AuthorJob | undefined): ActivityStatus {
  if (!job) return "idle";
  if (job.state === "running") return "running";
  if (job.state === "failed") return "failed";
  if (job.state === "cancelled") return "idle";
  return job.result?.ok ? "done" : "failed";
}

/**
 * Subscribe to the job store.
 *
 * `useSyncExternalStore` rather than a `useEffect` + `useState` pair: the store
 * changes several times per second during a run, and this is the hook built for
 * an external mutable source — it cannot tear, and it re-reads on mount, which
 * is what makes re-opening the pane mid-run show the CURRENT state rather than
 * whatever was there when the component last died.
 */
function useLatestJob(): AuthorJob | undefined {
  return useSyncExternalStore(
    subscribeToJobs,
    latestJob,
    // Server snapshot: the pane never server-renders, but the hook requires a
    // stable callee and a missing one throws in strict mode.
    latestJob,
  );
}

/** Re-render once a second while a job runs, so the elapsed clock moves. */
function useTicker(active: boolean): void {
  const [, setTick] = useState(0);
  React.useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
}

export function ScriptAuthor(props: ScriptAuthorProps): React.ReactElement {
  const job = useLatestJob();
  const running = job?.state === "running";
  useTicker(running);

  const [intent, setIntent] = useState(props.initialIntent ?? "");
  const [objectType, setObjectType] = useState(props.initialObjectType ?? "button");
  /** Set when the user asks to change the request after a run. */
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");

  const showForm = editing || !job;

  const start = useCallback(() => {
    const task = intent.trim();
    if (!task) return;
    setError("");
    setEditing(false);
    startAuthorJob({
      intent: task,
      objectType,
      providerId: props.providerId,
      model: props.model,
      baseUrl: props.baseUrl,
    });
  }, [intent, objectType, props.providerId, props.model, props.baseUrl]);

  const openDraft = useCallback(async (draftId: string) => {
    try {
      await requireScriptEditorProvider().openDraftInEditor(draftId);
    } catch (e) {
      setError(`${e}`);
    }
  }, []);

  const elapsed = job ? (job.endedAt ?? Date.now()) - job.startedAt : 0;
  const result = job?.result;
  // ONE sentence, chosen in ONE place -- see `dryRunNotes.ts`. The rule it
  // enforces is negative ("changed no cells" must never stand alone when a
  // handler was never fired), and a negative rule expressed as two ternaries in
  // the tree below disappears silently on the next edit.
  const caveat = result
    ? dryRunCaveat({
        changedNothing: !!result.changedNothing,
        unexercisedHooks: result.unexercisedHooks,
      })
    : "";

  return h("div", { style: wrap },
    showForm
      ? h(React.Fragment, { key: "form" },
          h("p", { style: hint },
            "Describe what the script should do and what it attaches to. Calcula shows the model " +
            "Calcula's own API, checks what it writes, runs it against a copy of your workbook, and " +
            "sends anything wrong back to be corrected. Nothing is saved or run until you approve " +
            "it in the editor."),
          h("label", { style: label }, "What should it do?"),
          h("textarea", {
            style: area, rows: 3, value: intent,
            placeholder: "e.g. Set each selected cell's background colour to the colour written in that cell",
            onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setIntent(e.target.value),
          }),
          h("label", { style: label }, "What should it attach to?"),
          h("select", {
            style: select, value: objectType,
            onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setObjectType(e.target.value),
          }, DRAFT_OBJECT_TYPES.map((t) => h("option", { key: t, value: t }, t))),
          h("p", { style: hint },
            "This decides which parts of the API the model is shown, and which events the script " +
            "can react to. A button script runs when the button is clicked."),
          h("div", { style: { display: "flex", gap: 8 } },
            h("button", {
              style: { ...btn, opacity: intent.trim() ? 1 : 0.5 },
              disabled: !intent.trim(), onClick: start,
            }, job ? "Start again" : "Author the script"),
            job
              ? h("button", { style: ghostBtn, onClick: () => setEditing(false) }, "Cancel")
              : null,
            h("button", { style: ghostBtn, onClick: props.onBackToChat }, "Back to chat"),
          ),
        )
      : null,

    // --- The run ---
    job && !showForm
      ? h(React.Fragment, { key: "job" },
          // What was asked for, compact, so the form is not in the way.
          h("div", { style: recapStyle },
            h("div", { style: { fontWeight: 600, marginBottom: 2 } }, job.intent),
            h("div", null, `attached to a ${job.objectType} — ${job.model}`),
          ),

          // THE LIVE LINE. The dot keeps moving on the compositor, so it stays
          // alive even while the main thread is busy — which is exactly when a
          // static label would look wedged.
          h("div", { style: liveStyle },
            h(ActivityDot, { status: statusOf(job), title: job.phase }),
            h("span", { style: { flex: 1 } },
              job.live ? `${job.phase} — ${job.live}` : job.phase),
            h("span", { style: { color: "#5C7FA3", fontVariantNumeric: "tabular-nums" } },
              formatElapsed(elapsed)),
          ),

          h("div", { style: logBox },
            job.steps.length === 0
              ? h("div", { style: { color: "#9AA7B2" } }, "Starting...")
              : job.steps.map((s, i) =>
                  h("div", { key: i, style: stepRow },
                    h("span", { style: stepTime }, formatElapsed(s.at)),
                    h("span", { style: { color: STEP_COLOUR[s.kind] } },
                      `${STEP_MARK[s.kind]} ${s.text}${s.detail ? ` — ${s.detail}` : ""}`),
                  ),
                ),
          ),

          running
            ? h("p", { style: hint },
                "You can close this pane and carry on working — the job keeps running and you will " +
                "be told when it finishes.")
            : null,

          h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
            running
              ? h("button", { style: stopBtn, onClick: () => cancelJob(job.id) }, "Stop")
              : h("button", { style: btn, onClick: () => setEditing(true) }, "New script"),
            result?.ok && result.draftId && hasScriptEditorProvider()
              ? h("button", {
                  style: openBtn,
                  onClick: () => void openDraft(result.draftId as string),
                }, "Open in Object Script Editor")
              : null,
            h("button", { style: ghostBtn, onClick: props.onBackToChat }, "Back to chat"),
          ),

          error ? h("div", { style: badBox }, error) : null,
          job.error ? h("div", { style: badBox }, job.error) : null,

          result
            ? h(React.Fragment, null,
                h("div", { style: result.ok ? okBox : badBox }, result.summary),
                result.deliveryError
                  ? h("div", { style: badBox },
                      `The script was written but could not be queued for review: ${result.deliveryError}`)
                  : null,
                // THE TEXT IS NOT DECIDED HERE. The old literal blamed the open
                // sheet unconditionally, and when the zero came from a handler
                // the preview never fired that was the opposite of the truth.
                caveat ? h("div", { style: warnBox }, caveat) : null,
                // WHAT IT ASKS FOR THAT IT DOES NOT APPEAR TO USE. §11.2 calls
                // these information for the reviewer, never a rejection -- and
                // this screen showed only the error count, so "passed every
                // check" was the last word on a script declaring a capability
                // nothing in it needs.
                result.notices?.length
                  ? h("div", { style: warnBox },
                      h("div", { style: { fontWeight: 600, marginBottom: 2 } },
                        "Check what it declares before you mount it"),
                      ...result.notices.map((n, i) => h("div", { key: i }, `- ${n}`)),
                    )
                  : null,
                result.source
                  ? h(React.Fragment, null,
                      h("div", { style: label }, result.ok ? "The script" : "Best attempt (not accepted)"),
                      h("div", { style: srcBox }, result.source),
                    )
                  : null,
              )
            : null,
        )
      : null,
  );
}
