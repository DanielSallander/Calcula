//! FILENAME: app/extensions/AIChat/components/ChatView.tsx
// PURPOSE: The in-app AI chat. Runs an agentic TOOL-USE LOOP against WHICHEVER
//          model the user picked — local or cloud, any vendor — and executes each
//          tool call through ai_chat_run_tool (the same workbook tools the MCP
//          server exposes: undoable, gated, audited).
// CONTEXT: This file used to speak Anthropic's wire format directly. It now
//          speaks Calcula's own shape (lib/aiTypes.ts, mirroring ai/wire.rs) and
//          a Rust provider renders it per vendor. That is what turned "use a
//          different model" from a rewrite into a dropdown.
// SECURITY: keys live in the OS keychain, one slot per provider, and are never
//          handled here — the picker posts one to the backend and never reads it
//          back. Selecting a local provider means nothing leaves the machine.

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { TaskPaneViewProps } from "@api";
import { listenTauriEvent } from "@api";
import { aiChatBackend } from "../lib/aiChatBackend";
import { TOOLS, SYSTEM_PROMPT } from "../lib/chatTools";
import { AI_STREAM_EVENT, type ChatBlock, type ChatMessage, type ChatResponse, type StreamEvent } from "../lib/aiTypes";
import { isComplete, readSelection } from "../lib/providerSelection";
import { gateToolCall } from "../lib/draftGate";
import { ModelPicker } from "./ModelPicker";

const MAX_TOOL_TURNS = 8;

/**
 * Correlation id for one streamed turn.
 *
 * Tauri event listeners are global, so every open chat sees every stream. The id
 * is what keeps two panes — or two turns racing after a cancel — from writing
 * into each other's bubble.
 */
function newStreamId(): string {
  return `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

type Bubble = { kind: "user" | "assistant" | "tool" | "error"; text: string };

/**
 * One line describing a tool call, for the transcript.
 *
 * Most tools take small arguments and reading them verbatim is useful. Script
 * drafting does not: `source` is an entire macro, and dumping it JSON-escaped
 * into a chat bubble buries the conversation — while the readable copy is
 * already opening in the Object Script Editor, which is where review belongs.
 */
function summarizeToolCall(name: string, input: unknown): string {
  const args = (input ?? {}) as Record<string, unknown>;
  if (name === "draft_object_script") {
    const target = args.instance_id ? `${args.object_type}/${args.instance_id}` : `${args.object_type}`;
    const lines = typeof args.source === "string" ? args.source.split("\n").length : 0;
    return `draft_object_script("${args.name}" -> ${target}, ${lines} lines) — for review, not mounted`;
  }
  return `${name}(${JSON.stringify(args)})`;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const container: React.CSSProperties = { display: "flex", flexDirection: "column", height: "100%", fontFamily: "Segoe UI, Tahoma, sans-serif", fontSize: 12, backgroundColor: "#FAFAFA" };
const log: React.CSSProperties = { flex: 1, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 8 };
const inputRow: React.CSSProperties = { display: "flex", gap: 6, padding: 8, borderTop: "1px solid #E0E0E0" };
const textArea: React.CSSProperties = { flex: 1, resize: "none", padding: 6, border: "1px solid #CCC", borderRadius: 4, fontFamily: "inherit", fontSize: 12 };
const btn: React.CSSProperties = { padding: "6px 14px", border: "none", borderRadius: 4, background: "#0078D4", color: "#FFF", cursor: "pointer" };
const bar: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "4px 8px", borderBottom: "1px solid #E0E0E0", background: "#F3F3F3", color: "#555" };
const linkBtn: React.CSSProperties = { background: "none", border: "none", color: "#0078D4", cursor: "pointer", padding: 0, fontSize: 11, textDecoration: "underline" };

function bubbleStyle(kind: Bubble["kind"]): React.CSSProperties {
  const base: React.CSSProperties = { padding: "6px 10px", borderRadius: 8, maxWidth: "90%", whiteSpace: "pre-wrap", wordBreak: "break-word" };
  switch (kind) {
    case "user": return { ...base, alignSelf: "flex-end", background: "#0078D4", color: "#FFF" };
    case "assistant": return { ...base, alignSelf: "flex-start", background: "#FFF", border: "1px solid #E0E0E0", color: "#222" };
    case "tool": return { ...base, alignSelf: "flex-start", background: "#F0F4F8", border: "1px solid #D6E2EE", color: "#456", fontFamily: "Consolas, monospace", fontSize: 11 };
    case "error": return { ...base, alignSelf: "flex-start", background: "#FDECEA", border: "1px solid #F5C6C2", color: "#A1241B" };
  }
}

const h = React.createElement;

export function ChatView(_props: TaskPaneViewProps): React.ReactElement {
  const [selection, setSelection] = useState(readSelection);
  const [picking, setPicking] = useState(false);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  /** Text arriving from the stream for the turn in flight. */
  const [streaming, setStreaming] = useState("");
  const rawRef = useRef<ChatMessage[]>([]);
  const logRef = useRef<HTMLDivElement>(null);
  /** The turn currently being streamed; anything else on the wire is not ours. */
  const streamIdRef = useRef<string>("");

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [bubbles, streaming]);

  // One listener for the pane's lifetime rather than one per turn: registering
  // inside `send` would leak a listener on every message, and unregistering
  // precisely across an await is exactly the kind of bookkeeping that goes wrong
  // when a request fails.
  useEffect(() => {
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void listenTauriEvent<StreamEvent>(AI_STREAM_EVENT, (event) => {
      if (!event || event.streamId !== streamIdRef.current) return;
      if (event.type === "textDelta") {
        setStreaming((prev) => prev + event.text);
      } else if (event.type === "toolCallStarted") {
        // Shown before the arguments finish arriving, so a slow local model
        // does not look hung while it writes a long tool call.
        setBubbles((prev) => [...prev, { kind: "tool", text: `${event.name}…` }]);
      }
      // `done` / `failed` are handled by the command's own resolve/reject: the
      // return value is the authority, and reacting to both would double-apply
      // the turn.
    }).then((off) => {
      if (cancelled) off();
      else dispose = off;
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  const addBubble = useCallback((b: Bubble) => setBubbles((prev) => [...prev, b]), []);

  const closePicker = useCallback(() => {
    setSelection(readSelection());
    setPicking(false);
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    addBubble({ kind: "user", text });
    setBusy(true);

    let messages: ChatMessage[] = [
      ...rawRef.current,
      { role: "user", content: [{ type: "text", text }] },
    ];
    try {
      for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
        const streamId = newStreamId();
        streamIdRef.current = streamId;
        setStreaming("");

        // Streaming is a TRANSPORT detail: the command still returns the same
        // ChatResponse the blocking one does, and the loop below is unchanged.
        // The deltas are for the eye — which matters most exactly where the
        // blocking call was worst, a local model writing sixty lines.
        const resp = await aiChatBackend.invoke<ChatResponse>("ai_chat_complete_stream", {
          request: {
            providerId: selection.providerId,
            model: selection.model,
            system: SYSTEM_PROMPT,
            messages,
            tools: TOOLS,
          },
          streamId,
          baseUrlOverride: selection.baseUrl || null,
        });

        // The live text is replaced by the authoritative blocks below, so the
        // partial is cleared BEFORE they render or the answer appears twice.
        streamIdRef.current = "";
        setStreaming("");

        messages = [...messages, { role: "assistant", content: resp.blocks }];

        const say = resp.blocks
          .filter((b): b is Extract<ChatBlock, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        if (say) addBubble({ kind: "assistant", text: say });

        const toolUses = resp.blocks.filter(
          (b): b is Extract<ChatBlock, { type: "toolUse" }> => b.type === "toolUse",
        );
        if (resp.stopReason !== "toolUse" || toolUses.length === 0) break;

        const results: ChatBlock[] = [];
        for (const tu of toolUses) {
          addBubble({ kind: "tool", text: summarizeToolCall(tu.name, tu.input) });
          try {
            // The validation ladder runs BEFORE a draft reaches the user's review
            // queue. A rejection comes back as the tool result, so the model's own
            // agentic loop performs the repair — no second repair loop needed.
            const verdict = await gateToolCall(tu.name, tu.input);
            if (!verdict.allow) {
              addBubble({ kind: "error", text: "Draft rejected — sent back for correction." });
              results.push({
                type: "toolResult",
                toolUseId: tu.id,
                content: verdict.message ?? "The script was not accepted.",
                isError: true,
              });
              continue;
            }
            const result = await aiChatBackend.invoke<string>("ai_chat_run_tool", {
              name: tu.name,
              input: tu.input ?? {},
            });
            results.push({ type: "toolResult", toolUseId: tu.id, content: result, isError: false });
          } catch (e) {
            // Flagged as an error rather than passed off as a normal result, so
            // the model can tell "the tool refused" from "the tool answered".
            results.push({ type: "toolResult", toolUseId: tu.id, content: `Error: ${e}`, isError: true });
          }
        }
        messages = [...messages, { role: "user", content: results }];
      }
    } catch (e) {
      addBubble({ kind: "error", text: `${e}` });
    } finally {
      // Always cleared, including on the error path: leaving a partial answer on
      // screen after a failed turn reads as an answer the model never finished
      // giving, and the next turn would append to it.
      streamIdRef.current = "";
      setStreaming("");
      rawRef.current = messages;
      setBusy(false);
    }
  }, [input, busy, addBubble, selection]);

  // --- First run, or the user asked to change model ---
  if (picking || !isComplete(selection)) {
    return h("div", { style: container },
      h(ModelPicker, { key: "picker", onDone: closePicker, embedded: picking }),
    );
  }

  return h("div", { style: container },
    h("div", { key: "bar", style: bar },
      h("span", { key: "m" }, selection.model),
      h("button", { key: "c", style: linkBtn, onClick: () => setPicking(true) }, "Change model"),
    ),
    h("div", { key: "log", ref: logRef, style: log },
      bubbles.length === 0
        ? h("div", { key: "empty", style: { color: "#999", textAlign: "center", marginTop: 20 } },
            "Ask about your workbook — it can read cells, summarize data, make undoable edits, and draft scripts for you to review.")
        : bubbles.map((b, i) => h("div", { key: i, style: bubbleStyle(b.kind) }, b.text)),
      // The answer as it is written. Replaced by the finished blocks when the
      // turn resolves, so it is never double-rendered.
      streaming
        ? h("div", { key: "stream", style: bubbleStyle("assistant") }, streaming)
        : busy
          ? h("div", { key: "busy", style: { ...bubbleStyle("assistant"), color: "#999" } }, "…")
          : null,
    ),
    h("div", { key: "in", style: inputRow },
      h("textarea", {
        key: "ta", style: textArea, rows: 2, value: input, placeholder: "Message…", disabled: busy,
        onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setInput(e.target.value),
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
        },
      }),
      h("button", { key: "send", style: { ...btn, opacity: busy || !input.trim() ? 0.5 : 1 }, disabled: busy || !input.trim(), onClick: () => void send() }, "Send"),
    ),
  );
}
