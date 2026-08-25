//! FILENAME: app/extensions/AIChat/components/ScriptAuthor.tsx
// PURPOSE: The GUIDED path: two fields, then the built authoring pipeline.
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
//          silently. Here the guess is visible and correctable, which is the
//          whole improvement.

import React, { useState, useCallback, useRef } from "react";
import { DRAFT_OBJECT_TYPES } from "../lib/chatTools";
import { runAuthor, type AuthorRound } from "../lib/authorRunner";
import { hasScriptEditorProvider, requireScriptEditorProvider } from "@api";

const wrap: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 10, padding: 12, overflowY: "auto", flex: 1 };
const label: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: "#444" };
const hint: React.CSSProperties = { fontSize: 11, color: "#777", margin: 0, lineHeight: 1.45 };
const area: React.CSSProperties = { resize: "vertical", padding: 6, border: "1px solid #CCC", borderRadius: 4, fontFamily: "inherit", fontSize: 12, minHeight: 64 };
const select: React.CSSProperties = { padding: "5px 8px", border: "1px solid #CCC", borderRadius: 4, fontSize: 12, background: "#FFF", color: "#333" };
const btn: React.CSSProperties = { padding: "6px 14px", border: "none", borderRadius: 4, background: "#0078D4", color: "#FFF", cursor: "pointer", fontSize: 12 };
const stopBtn: React.CSSProperties = { ...btn, background: "#C62828" };
const openBtn: React.CSSProperties = { padding: "5px 12px", fontSize: 11, border: "1px solid #0078D4", borderRadius: 4, background: "#FFF", color: "#0078D4", cursor: "pointer" };
const logBox: React.CSSProperties = { background: "#F0F4F8", border: "1px solid #D6E2EE", borderRadius: 6, padding: "8px 10px", fontFamily: "Consolas, monospace", fontSize: 11, color: "#456", whiteSpace: "pre-wrap", maxHeight: 220, overflowY: "auto" };
const okBox: React.CSSProperties = { background: "#EDF7ED", border: "1px solid #C6E7C6", borderRadius: 6, padding: "8px 10px", fontSize: 12, color: "#245C24" };
const badBox: React.CSSProperties = { background: "#FDECEA", border: "1px solid #F5C6C2", borderRadius: 6, padding: "8px 10px", fontSize: 12, color: "#A1241B" };
const srcBox: React.CSSProperties = { background: "#FFF", border: "1px solid #E0E0E0", borderRadius: 6, padding: "8px 10px", fontFamily: "Consolas, monospace", fontSize: 11, whiteSpace: "pre", overflowX: "auto", maxHeight: 240, overflowY: "auto", color: "#222" };

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

/** One progress line per round. ASCII markers, per CLAUDE.md. */
function roundLine(r: AuthorRound): string {
  const head = `[${r.ok ? "OK" : "..."}] round ${r.round + 1}`;
  return r.problems.length ? `${head} — ${r.problems.join(" | ")}` : head;
}

export function ScriptAuthor(props: ScriptAuthorProps): React.ReactElement {
  const [intent, setIntent] = useState(props.initialIntent ?? "");
  const [objectType, setObjectType] = useState(props.initialObjectType ?? "button");
  const [busy, setBusy] = useState(false);
  const [rounds, setRounds] = useState<AuthorRound[]>([]);
  const [result, setResult] = useState<null | { ok: boolean; summary: string; source: string; draftId?: string; deliveryError?: string }>(null);
  const [error, setError] = useState("");
  const cancelRef = useRef(false);

  const author = useCallback(async () => {
    const task = intent.trim();
    if (!task || busy) return;
    setBusy(true);
    setRounds([]);
    setResult(null);
    setError("");
    cancelRef.current = false;
    try {
      const res = await runAuthor({
        intent: task,
        objectType,
        providerId: props.providerId,
        model: props.model,
        baseUrl: props.baseUrl,
        onRound: (r) => setRounds((prev) => [...prev, r]),
        isCancelled: () => cancelRef.current,
      });
      setResult(res);
    } catch (e) {
      // A cancelled run reads as an error from the pipeline's point of view; it
      // is not one from the user's.
      setError(cancelRef.current ? "" : `${e}`);
    } finally {
      setBusy(false);
    }
  }, [intent, objectType, busy, props.providerId, props.model, props.baseUrl]);

  const openDraft = useCallback(async (draftId: string) => {
    try {
      await requireScriptEditorProvider().openDraftInEditor(draftId);
    } catch (e) {
      setError(`${e}`);
    }
  }, []);

  return h("div", { style: wrap },
    h("p", { key: "lede", style: hint },
      "Describe what the script should do and what it attaches to. Calcula shows the model " +
      "Calcula's own API, checks what it writes, runs it against a copy of your workbook, and " +
      "sends anything wrong back to be corrected — then hands you the result to review. " +
      "Nothing is saved or run until you approve it in the editor."),

    h("label", { key: "l1", style: label }, "What should it do?"),
    h("textarea", {
      key: "intent", style: area, rows: 3, value: intent, disabled: busy,
      placeholder: "e.g. Set each selected cell's background colour to the colour written in that cell",
      onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setIntent(e.target.value),
    }),

    h("label", { key: "l2", style: label }, "What should it attach to?"),
    h("select", {
      key: "type", style: select, value: objectType, disabled: busy,
      onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setObjectType(e.target.value),
    }, DRAFT_OBJECT_TYPES.map((t) => h("option", { key: t, value: t }, t))),
    h("p", { key: "typehint", style: hint },
      "This decides which parts of the API the model is shown, and which events the script can " +
      "react to. A button script runs when the button is clicked."),

    h("div", { key: "actions", style: { display: "flex", gap: 8, alignItems: "center" } },
      busy
        ? h("button", { key: "stop", style: stopBtn, onClick: () => { cancelRef.current = true; } }, "Stop")
        : h("button", {
            key: "go", style: { ...btn, opacity: intent.trim() ? 1 : 0.5 },
            disabled: !intent.trim(), onClick: () => void author(),
          }, "Author the script"),
      h("button", { key: "back", style: { ...openBtn, borderColor: "#CCC", color: "#555" }, onClick: props.onBackToChat, disabled: busy }, "Back to chat"),
    ),

    rounds.length > 0
      ? h("div", { key: "log", style: logBox }, rounds.map(roundLine).join("\n"))
      : null,

    busy
      ? h("p", { key: "busy", style: hint },
          `Working with ${props.model}. A local model may take a minute or more per round — ` +
          "each round writes a whole script and has it checked.")
      : null,

    error ? h("div", { key: "err", style: badBox }, error) : null,

    result
      ? h("div", { key: "res", style: { display: "flex", flexDirection: "column", gap: 8 } },
          h("div", { style: result.ok ? okBox : badBox }, result.summary),
          result.deliveryError
            ? h("div", { style: badBox }, `The script was written but could not be queued for review: ${result.deliveryError}`)
            : null,
          result.ok && result.draftId && hasScriptEditorProvider()
            ? h("button", {
                style: openBtn,
                onClick: () => void openDraft(result.draftId as string),
              }, "Open in Object Script Editor")
            : null,
          result.source
            ? h(React.Fragment, null,
                h("div", { style: label }, result.ok ? "The script" : "Best attempt (not accepted)"),
                h("div", { style: srcBox }, result.source),
              )
            : null,
        )
      : null,
  );
}
