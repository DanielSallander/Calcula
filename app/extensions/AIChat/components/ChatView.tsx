//! FILENAME: app/extensions/AIChat/components/ChatView.tsx
// PURPOSE: The in-app AI chat. Runs an agentic TOOL-USE LOOP against WHICHEVER
//          model the user picked — local or cloud, any vendor — and executes each
//          tool call through ai_chat_run_tool (the same workbook tools the MCP
//          server exposes: undoable, gated, audited).
// CONTEXT: This file used to speak Anthropic's wire format directly. It now
//          speaks Calcula's own shape (lib/aiTypes.ts, mirroring ai/wire.rs) and
//          a Rust provider renders it per vendor. That is what turned "use a
//          different model" from a rewrite into a dropdown.
//
//          THE 2026-08-22 REPORT and what changed. A local model was asked to
//          "create a script that formats the background color of each selected
//          cell" and replied with a fenced ```json block naming a tool that does
//          not exist. Nothing ran, nothing was created, and the turn ended
//          looking exactly like a normal answer. Three fixes meet here:
//
//            1. A TEXTUAL TOOL CALL IS RECOVERED (lib/textToolCalls.ts). When a
//               turn produces no native tool call, the prose is searched for one.
//               Read-only tools and draft_object_script run; anything that
//               mutates the document asks the user first (SALVAGE_AUTORUN).
//            2. A DRAFT IS REACHABLE FROM HERE. The bubble for a
//               draft_object_script call carries the draft id and an "Open in
//               editor" button, through the @api scriptEditorService seam. The
//               editor auto-opens once on arrival; this is the way back after it
//               is closed.
//            3. PROGRESS IS VISIBLE. Every tool call is one bubble that resolves
//               with a duration ([..] -> [OK]/[!]); the turn counter, elapsed
//               time and current activity replace the single literal "…"; the
//               model's thinking is shown; and Stop actually stops.
//
// SECURITY: keys live in the OS keychain, one slot per provider, and are never
//          handled here — the picker posts one to the backend and never reads it
//          back. Selecting a local provider means nothing leaves the machine.
//          A SALVAGED call is dispatched through the same ai_chat_run_tool as a
//          native one, so it inherits the identical window guard, script-security
//          tier and audit trail; the extra confirmation below is about the
//          PROVENANCE OF THE PARSE, not about reach.

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { TaskPaneViewProps } from "@api";
import { listenTauriEvent, confirmAsync, hasScriptEditorProvider, requireScriptEditorProvider } from "@api";
import { aiChatBackend } from "../lib/aiChatBackend";
import { TOOLS, TOOL_NAMES, SALVAGE_AUTORUN, SYSTEM_PROMPT } from "../lib/chatTools";
import {
  AI_STREAM_EVENT, STREAM_CANCELLED,
  type ChatBlock, type ChatMessage, type ChatResponse, type StreamEvent,
} from "../lib/aiTypes";
import { isComplete, readSelection } from "../lib/providerSelection";
import { gateToolCall } from "../lib/draftGate";
import { salvageTextualToolCalls, stripSpans, unknownToolMessage } from "../lib/textToolCalls";
import { installSelectionTracking, withSelection } from "../lib/selectionContext";
import {
  startTool, finishTool, failTool, settleRunning, formatToolBubble, truncate, draftIdFromResult,
  type Bubble,
} from "../lib/toolTimeline";
import { ModelPicker } from "./ModelPicker";

const MAX_TOOL_TURNS = 8;

/** The Tauri event a script draft arrives on (`mcp/drafts.rs`). */
const SCRIPT_DRAFT_EVENT = "mcp:script-draft";

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
  return `${name}(${truncate(JSON.stringify(args), 160)})`;
}

/**
 * Whether a salvaged call may run without asking.
 *
 * A NATIVE call is never subject to this — the model emitted it through the
 * interface built for the purpose and the user chose the model. A SALVAGED one
 * was recovered from prose by a heuristic, and a heuristic must not be the sole
 * authority for a silent edit to someone's workbook. Reads and drafting are
 * exempt because neither can damage anything: `draft_object_script` produces a
 * review-queue entry a human must then approve in the editor.
 */
function needsConfirmation(name: string, salvaged: boolean): boolean {
  return salvaged && !SALVAGE_AUTORUN.has(name);
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const container: React.CSSProperties = { display: "flex", flexDirection: "column", height: "100%", fontFamily: "Segoe UI, Tahoma, sans-serif", fontSize: 12, backgroundColor: "#FAFAFA" };
const log: React.CSSProperties = { flex: 1, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 8 };
const inputRow: React.CSSProperties = { display: "flex", gap: 6, padding: 8, borderTop: "1px solid #E0E0E0" };
const textArea: React.CSSProperties = { flex: 1, resize: "none", padding: 6, border: "1px solid #CCC", borderRadius: 4, fontFamily: "inherit", fontSize: 12 };
const btn: React.CSSProperties = { padding: "6px 14px", border: "none", borderRadius: 4, background: "#0078D4", color: "#FFF", cursor: "pointer" };
const stopBtn: React.CSSProperties = { ...btn, background: "#C62828" };
const bar: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "4px 8px", borderBottom: "1px solid #E0E0E0", background: "#F3F3F3", color: "#555" };
const linkBtn: React.CSSProperties = { background: "none", border: "none", color: "#0078D4", cursor: "pointer", padding: 0, fontSize: 11, textDecoration: "underline" };
/** The live activity line. Dim, monospace, one line — status, not conversation. */
const activityStyle: React.CSSProperties = { alignSelf: "flex-start", padding: "4px 10px", borderRadius: 8, background: "#EEF2F6", border: "1px dashed #C8D4E0", color: "#5A6B7C", fontFamily: "Consolas, monospace", fontSize: 11, whiteSpace: "pre-wrap" };
/** Model thinking. Dimmer still, and visibly not the answer. */
const thinkingStyle: React.CSSProperties = { alignSelf: "flex-start", maxWidth: "90%", padding: "6px 10px", borderRadius: 8, background: "#F7F5FA", border: "1px solid #E4DEEC", color: "#6B6478", fontFamily: "Consolas, monospace", fontSize: 11, whiteSpace: "pre-wrap", maxHeight: 160, overflowY: "auto" };
const openDraftBtn: React.CSSProperties = { marginTop: 6, padding: "3px 10px", fontSize: 11, border: "1px solid #0078D4", borderRadius: 4, background: "#FFF", color: "#0078D4", cursor: "pointer" };

function bubbleStyle(kind: Bubble["kind"]): React.CSSProperties {
  const base: React.CSSProperties = { padding: "6px 10px", borderRadius: 8, maxWidth: "90%", whiteSpace: "pre-wrap", wordBreak: "break-word" };
  switch (kind) {
    case "user": return { ...base, alignSelf: "flex-end", background: "#0078D4", color: "#FFF" };
    case "assistant": return { ...base, alignSelf: "flex-start", background: "#FFF", border: "1px solid #E0E0E0", color: "#222" };
    case "tool": return { ...base, alignSelf: "flex-start", background: "#F0F4F8", border: "1px solid #D6E2EE", color: "#456", fontFamily: "Consolas, monospace", fontSize: 11 };
    case "notice": return { ...base, alignSelf: "flex-start", background: "#F5F5F5", border: "1px solid #E0E0E0", color: "#777", fontStyle: "italic" };
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
  /** The model's reasoning for the turn in flight. NEVER merged into `streaming`. */
  const [thinking, setThinking] = useState("");
  /** One line saying what is happening right now. Replaces the old literal "…". */
  const [activity, setActivity] = useState("");
  /** Ticks once a second so the elapsed counter moves without re-rendering the log. */
  const [elapsed, setElapsed] = useState(0);
  const rawRef = useRef<ChatMessage[]>([]);
  const logRef = useRef<HTMLDivElement>(null);
  /** The turn currently being streamed; anything else on the wire is not ours. */
  const streamIdRef = useRef<string>("");
  /** Set by Stop, so a rejected invoke can be told from a real failure. */
  const stoppedRef = useRef(false);
  /**
   * Draft ids seen on `mcp:script-draft` during the turn, oldest first.
   *
   * The PREFERRED source of a draft id: it arrives as data. The result string is
   * parsed only as a fallback (`draftIdFromResult`), because matching a sentence
   * built in Rust is a cross-language coupling with no guard on it.
   */
  const draftIdsRef = useRef<string[]>([]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [bubbles, streaming, thinking, activity]);

  // Selection tracking for the pane's lifetime. Without it the model has no way
  // to know what "the selected cells" means and invents a range.
  useEffect(() => installSelectionTracking(), []);

  // One listener for the pane's lifetime rather than one per turn: registering
  // inside `send` would leak a listener on every message, and unregistering
  // precisely across an await is exactly the kind of bookkeeping that goes wrong
  // when a request fails.
  useEffect(() => {
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void listenTauriEvent<StreamEvent>(AI_STREAM_EVENT, (event) => {
      if (!event || event.streamId !== streamIdRef.current) return;
      switch (event.type) {
        case "requested":
          setActivity(`Sending to ${event.model} at ${event.endpoint}...`);
          break;
        case "opened":
          // The state a cold local model sits in for minutes. It used to be "…".
          setActivity(`Connected (HTTP ${event.status}). Waiting for the first token — a local model may be loading into memory...`);
          break;
        case "reasoningDelta":
          setActivity("Thinking...");
          setThinking((prev) => prev + event.text);
          break;
        case "textDelta":
          setActivity("");
          setStreaming((prev) => prev + event.text);
          break;
        case "toolCallStarted":
          // Shown before the arguments finish arriving, so a slow local model
          // does not look hung while it writes a long tool call. Keyed by the
          // provider's id so the dispatch loop below UPDATES this same bubble
          // rather than appending a second one that never resolves.
          setActivity("");
          setBubbles((prev) => startTool(prev, event.id, `${event.name}...`));
          break;
        default:
          // `done` / `failed` are handled by the command's own resolve/reject:
          // the return value is the authority, and reacting to both would
          // double-apply the turn.
          break;
      }
    }).then((off) => {
      if (cancelled) off();
      else dispose = off;
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  // Drafts arrive on their own channel. Recorded so the tool bubble can offer
  // "Open in editor" — the route back after the auto-opened window is closed.
  useEffect(() => {
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void listenTauriEvent<{ id?: unknown }>(SCRIPT_DRAFT_EVENT, (payload) => {
      const id = payload?.id;
      if (typeof id === "string" && id) draftIdsRef.current.push(id);
    }).then((off) => {
      if (cancelled) off();
      else dispose = off;
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  // The elapsed counter. One interval for the whole turn, cleared with it.
  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    setElapsed(0);
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, [busy]);

  const addBubble = useCallback((b: Bubble) => setBubbles((prev) => [...prev, b]), []);

  const closePicker = useCallback(() => {
    setSelection(readSelection());
    setPicking(false);
  }, []);

  /** Ask the backend to abandon the turn in flight. */
  const stop = useCallback(() => {
    const id = streamIdRef.current;
    if (!id) return;
    stoppedRef.current = true;
    setActivity("Stopping...");
    void aiChatBackend.invoke("ai_chat_cancel_stream", { streamId: id }).catch(() => {
      // The turn may already have finished. Nothing to report: the send path's
      // own resolve/reject remains the authority for what happened.
    });
  }, []);

  const openDraft = useCallback(async (draftId: string) => {
    try {
      await requireScriptEditorProvider().openDraftInEditor(draftId);
    } catch (e) {
      addBubble({ kind: "error", text: `${e}` });
    }
  }, [addBubble]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    addBubble({ kind: "user", text });
    setBusy(true);
    stoppedRef.current = false;
    draftIdsRef.current = [];

    let messages: ChatMessage[] = [
      ...rawRef.current,
      { role: "user", content: [{ type: "text", text }] },
    ];
    let turn = 0;
    try {
      for (turn = 0; turn < MAX_TOOL_TURNS; turn++) {
        const streamId = newStreamId();
        streamIdRef.current = streamId;
        setStreaming("");
        setThinking("");
        setActivity("Preparing the request...");

        // Streaming is a TRANSPORT detail: the command still returns the same
        // ChatResponse the blocking one does, and the loop below is unchanged.
        // The deltas are for the eye — which matters most exactly where the
        // blocking call was worst, a local model writing sixty lines.
        const resp = await aiChatBackend.invoke<ChatResponse>("ai_chat_complete_stream", {
          request: {
            providerId: selection.providerId,
            model: selection.model,
            // The selection is appended HERE and not baked into SYSTEM_PROMPT,
            // so it is whatever the user has selected at the moment they send.
            system: withSelection(SYSTEM_PROMPT),
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
        setThinking("");
        setActivity("");

        let say = resp.blocks
          .filter((b): b is Extract<ChatBlock, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();

        let toolUses = resp.blocks.filter(
          (b): b is Extract<ChatBlock, { type: "toolUse" }> => b.type === "toolUse",
        );
        // Which calls came out of prose rather than off the wire, by id.
        const salvagedIds = new Set<string>();
        let assistantBlocks: ChatBlock[] = resp.blocks;

        // ---- Recover a tool call the model wrote as text ----------------
        // Only when the turn produced NONE natively: a model that emitted a real
        // call and also described one is not asking for the description to run.
        if (toolUses.length === 0 && say) {
          const salvage = salvageTextualToolCalls(say, TOOL_NAMES);
          if (salvage.calls.length > 0) {
            const synthetic = salvage.calls.map((c, i) => ({
              type: "toolUse" as const,
              id: `salvaged-${turn}-${i}`,
              name: c.name,
              input: c.input as unknown,
            }));
            for (const s of synthetic) salvagedIds.add(s.id);
            toolUses = synthetic;
            // LOAD-BEARING: the synthetic calls must be in the assistant message
            // too. The toolResult blocks pushed below reference their ids, and
            // both vendors reject a result whose call is not in the transcript.
            assistantBlocks = [...resp.blocks, ...synthetic];
            say = stripSpans(say, salvage.consumedSpans);
            addBubble({
              kind: "notice",
              text:
                `The model wrote its tool call as text instead of emitting one. ` +
                `Recovered ${synthetic.length} call${synthetic.length === 1 ? "" : "s"} and running ` +
                `${synthetic.length === 1 ? "it" : "them"}.`,
            });
          } else if (salvage.unknownNames.length > 0) {
            // It tried to call something that does not exist. Tell it what does,
            // as a USER turn: there is no tool call to attach a result to.
            addBubble({
              kind: "notice",
              text: `The model called a tool that does not exist (${salvage.unknownNames.join(", ")}). Asking it to use a real one.`,
            });
            if (say) addBubble({ kind: "assistant", text: say });
            messages = [
              ...messages,
              { role: "assistant", content: resp.blocks },
              {
                role: "user",
                content: [{ type: "text", text: unknownToolMessage(salvage.unknownNames[0], TOOL_NAMES) }],
              },
            ];
            continue;
          }
        }

        messages = [...messages, { role: "assistant", content: assistantBlocks }];
        if (say) addBubble({ kind: "assistant", text: say });

        // `stopReason` can no longer gate the loop: a salvaged turn reports
        // "endTurn" because the provider genuinely thought it was finished.
        if (toolUses.length === 0) break;

        const results: ChatBlock[] = [];
        for (const tu of toolUses) {
          const salvaged = salvagedIds.has(tu.id);
          setBubbles((prev) => startTool(prev, tu.id, summarizeToolCall(tu.name, tu.input), { salvaged }));
          setActivity(`Running ${tu.name}...`);
          const started = performance.now();
          try {
            // A recovered call that would MUTATE the workbook is confirmed with
            // the user first. `confirmAsync` is awaited and fails CLOSED — a
            // dialog that cannot be shown is a refusal, never consent.
            if (needsConfirmation(tu.name, salvaged)) {
              const ok = await confirmAsync(
                `The model wrote this call as text rather than emitting it, so Calcula recovered it:\n\n` +
                  `  ${tu.name}\n\n` +
                  `It changes the workbook. Run it?`,
              );
              if (!ok) {
                setBubbles((prev) => failTool(prev, tu.id, "Declined by the user.", performance.now() - started));
                results.push({
                  type: "toolResult",
                  toolUseId: tu.id,
                  content: "The user declined to run this recovered tool call.",
                  isError: true,
                });
                continue;
              }
            }

            // The validation ladder runs BEFORE a draft reaches the user's review
            // queue. A rejection comes back as the tool result, so the model's own
            // agentic loop performs the repair — no second repair loop needed.
            const verdict = await gateToolCall(tu.name, tu.input);
            if (!verdict.allow) {
              setBubbles((prev) =>
                failTool(prev, tu.id, "Draft rejected — sent back for correction.", performance.now() - started),
              );
              results.push({
                type: "toolResult",
                toolUseId: tu.id,
                content: verdict.message ?? "The script was not accepted.",
                isError: true,
              });
              continue;
            }
            const before = draftIdsRef.current.length;
            const result = await aiChatBackend.invoke<string>("ai_chat_run_tool", {
              name: tu.name,
              input: tu.input ?? {},
            });
            const ms = performance.now() - started;
            // Prefer the id delivered as DATA on mcp:script-draft; fall back to
            // the backend's own result sentence only if no event arrived.
            const draftId =
              tu.name === "draft_object_script"
                ? draftIdsRef.current.slice(before)[0] ?? draftIdFromResult(result) ?? undefined
                : undefined;
            setBubbles((prev) => finishTool(prev, tu.id, { ms, detail: truncate(result, 140), draftId }));
            // The gate's dry-run note rides on the tool result so the model —
            // and the transcript — say what the draft would DO, not just that
            // it was queued. Empty for declined/inapplicable dry runs.
            results.push({
              type: "toolResult",
              toolUseId: tu.id,
              content: verdict.note ? result + verdict.note : result,
              isError: false,
            });
          } catch (e) {
            // Flagged as an error rather than passed off as a normal result, so
            // the model can tell "the tool refused" from "the tool answered" —
            // and shown on its own bubble, which it previously was NOT: a
            // throwing tool produced no UI at all while the loop burned turns.
            setBubbles((prev) => failTool(prev, tu.id, `${e}`, performance.now() - started));
            results.push({ type: "toolResult", toolUseId: tu.id, content: `Error: ${e}`, isError: true });
          }
        }
        setActivity("");
        messages = [...messages, { role: "user", content: results }];
      }
      if (turn >= MAX_TOOL_TURNS) {
        addBubble({
          kind: "notice",
          text: `Stopped after ${MAX_TOOL_TURNS} tool rounds without a final answer. Send another message to continue.`,
        });
      }
    } catch (e) {
      const message = `${e}`;
      if (stoppedRef.current || message.includes(STREAM_CANCELLED)) {
        // The user's own decision, not a failure. Said plainly, including what
        // stopping does NOT do — the provider was not reached.
        addBubble({
          kind: "notice",
          text: "Stopped. The partial answer was discarded; the model may keep generating on its side until it notices.",
        });
      } else {
        addBubble({ kind: "error", text: message });
      }
      setBubbles((prev) => settleRunning(prev, stoppedRef.current ? "Stopped." : "The turn ended before this call finished."));
    } finally {
      // Always cleared, including on the error path: leaving a partial answer on
      // screen after a failed turn reads as an answer the model never finished
      // giving, and the next turn would append to it.
      streamIdRef.current = "";
      setStreaming("");
      setThinking("");
      setActivity("");
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

  const canOpenEditor = hasScriptEditorProvider();

  return h("div", { style: container },
    h("div", { key: "bar", style: bar },
      h("span", { key: "m" }, selection.model),
      h("button", { key: "c", style: linkBtn, onClick: () => setPicking(true) }, "Change model"),
    ),
    h("div", { key: "log", ref: logRef, style: log },
      bubbles.length === 0
        ? h("div", { key: "empty", style: { color: "#999", textAlign: "center", marginTop: 20 } },
            "Ask about your workbook — it can read cells, summarize data, make undoable edits, and draft scripts for you to review.")
        : bubbles.map((b, i) =>
            b.kind === "tool"
              ? h("div", { key: i, style: bubbleStyle("tool") },
                  formatToolBubble(b),
                  // The route back to a draft once its editor window is closed.
                  b.draftId && canOpenEditor
                    ? h("div", { key: "open" },
                        h("button", {
                          style: openDraftBtn,
                          onClick: () => void openDraft(b.draftId as string),
                        }, "Open in Object Script Editor"),
                      )
                    : null,
                )
              : h("div", { key: i, style: bubbleStyle(b.kind) }, b.text),
          ),
      // The model's reasoning, visibly separate from its answer.
      thinking
        ? h("div", { key: "thinking", style: thinkingStyle }, `thinking...\n${thinking}`)
        : null,
      // The answer as it is written. Replaced by the finished blocks when the
      // turn resolves, so it is never double-rendered.
      streaming
        ? h("div", { key: "stream", style: bubbleStyle("assistant") }, streaming)
        : null,
      // What is happening right now. This is what used to be a literal "…".
      busy
        ? h("div", { key: "activity", style: activityStyle },
            `[${elapsed}s] ${activity || (streaming ? "Writing the answer..." : "Working...")}`,
          )
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
      busy
        ? h("button", { key: "stop", style: stopBtn, onClick: stop }, "Stop")
        : h("button", {
            key: "send",
            style: { ...btn, opacity: !input.trim() ? 0.5 : 1 },
            disabled: !input.trim(),
            onClick: () => void send(),
          }, "Send"),
    ),
  );
}
