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
//               mutates the document asks the user first (AUTORUN_TOOLS).
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
import {
  TOOLS, TOOL_NAMES, CORE_TOOLS, CORE_TOOL_NAMES, AUTORUN_TOOLS, buildSystemPrompt,
} from "../lib/chatTools";
import {
  AI_STREAM_EVENT, STREAM_CANCELLED, TOOL_USE_TEMPERATURE,
  type ChatBlock, type ChatMessage, type ChatResponse, type StreamEvent,
} from "../lib/aiTypes";
import { isComplete, readSelection } from "../lib/providerSelection";
import { gateToolCall } from "../lib/draftGate";
import { salvageTextualToolCalls, stripSpans, unknownToolMessage } from "../lib/textToolCalls";
import { installSelectionTracking, withSelection } from "../lib/selectionContext";
import { apiSurfaceSection } from "../lib/apiSurface";
import {
  startTool, finishTool, failTool, settleRunning, formatToolBubble, truncate, draftIdFromResult,
  type Bubble,
} from "../lib/toolTimeline";
import { detectScriptIntent, guessObjectType } from "../lib/scriptIntent";
import { ModelPicker } from "./ModelPicker";
import { ScriptAuthor } from "./ScriptAuthor";

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

/** Why a call is being second-guessed, or null when it is not. */
type DoubtReason = "salvaged" | "invented-a-name";

/**
 * Whether this call has to be confirmed with the user first.
 *
 * NOT about reach — every call goes through the same `ai_chat_run_tool`, guard,
 * tier and audit either way. It is about whether anything in THIS message has
 * given us cause to doubt the model's next move:
 *
 *   - `salvaged`: the call was recovered from prose by a heuristic rather than
 *     delivered by the transport.
 *   - `misbehaved`: the model already called a tool that does not exist during
 *     this message. Observed on qwen2.5:7b — it invented `format_selected_cells`,
 *     was told what exists, and then reformatted fifteen cells the user had not
 *     selected, with properties nobody asked for, and reported success.
 *
 * An ordinary native call from a model that has behaved is never second-guessed:
 * the user chose the model, and a confirmation on every write would train them
 * to click through it.
 */
function doubtAbout(name: string, salvaged: boolean, misbehaved: boolean): DoubtReason | null {
  if (AUTORUN_TOOLS.has(name)) return null;
  if (salvaged) return "salvaged";
  if (misbehaved) return "invented-a-name";
  return null;
}

/** What the user is asked, in terms of what actually happened. */
function confirmationText(reason: DoubtReason, model: string, name: string, input: unknown): string {
  const preamble =
    reason === "salvaged"
      ? `${model} wrote this call as text rather than emitting it, so Calcula recovered it.`
      : `${model} has already called a tool that does not exist in this conversation, so this call is being double-checked.`;
  return (
    `${preamble}\n\n` +
    `It changes the workbook:\n\n  ${summarizeToolCall(name, input)}\n\n` +
    `Run it?`
  );
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
/** The "this looks like a script" offer. Distinct from every message colour. */
const offerStyle: React.CSSProperties = { alignSelf: "stretch", padding: "10px 12px", borderRadius: 8, background: "#FFF8E6", border: "1px solid #EBD9A8", color: "#6B5A1E", fontSize: 12, lineHeight: 1.45 };
const offerGoStyle: React.CSSProperties = { padding: "4px 12px", fontSize: 11, border: "none", borderRadius: 4, background: "#0078D4", color: "#FFF", cursor: "pointer" };
const offerDismissStyle: React.CSSProperties = { padding: "4px 12px", fontSize: 11, border: "1px solid #CCC", borderRadius: 4, background: "#FFF", color: "#555", cursor: "pointer" };

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
  /**
   * Which of the two paths the pane is showing.
   *
   * The chat's tool loop is genuinely good at reading, summarising and explicit
   * one-off edits. It is measurably bad at deciding that a request needs a
   * SCRIPT and then picking the tool for it. So the guided path is a separate
   * screen the user can reach directly, and the chat OFFERS it when a message
   * looks like script work rather than silently rerouting.
   */
  const [mode, setMode] = useState<"chat" | "author">("chat");
  /** Prefill carried across when the user accepts the chat's offer. */
  const [authorSeed, setAuthorSeed] = useState<{ intent?: string; objectType?: string }>({});
  /** The standing "this looks like a script" offer, or null. */
  const [offer, setOffer] = useState<null | { intent: string; objectType?: string; matched: string }>(null);
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
   * Whether this model has already proved it cannot hold the full tool surface.
   *
   * STICKY FOR THE SESSION, not per message. Measured 2026-08-23: with 24 tool
   * schemas, BOTH qwen2.5-coder:3b and qwen2.5:7b invented a tool name on 3-4 of
   * 4 trials; with 10, both named a real tool every time and the 7b produced
   * valid drafts. The narrowing therefore fires on essentially every first
   * message to a local model, and re-learning it each time would burn one round
   * trip per message for no new information.
   *
   * Reset when the user picks a different model — the lesson is about the model,
   * not about the pane.
   */
  const narrowedRef = useRef(false);
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
    const next = readSelection();
    // A new model has not proved anything yet: what the previous one could not
    // hold says nothing about this one, and starting it narrowed would silently
    // withhold pivots, charts and the BI tools from a model that can use them.
    if (next.model !== selection.model || next.providerId !== selection.providerId) {
      narrowedRef.current = false;
    }
    setSelection(next);
    setPicking(false);
  }, [selection.model, selection.providerId]);

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

    // THE BRIDGE. Offered, never automatic: the detector is a word list and it
    // will be wrong at the margins, so the user decides. It exists because the
    // model demonstrably cannot make this call itself — asked for "a script
    // that formats each selected cell by its content" it reached for
    // `apply_formatting`, which takes ONE range and ONE set of properties and
    // therefore cannot express a per-cell colour at all.
    const scriptish = detectScriptIntent(text);
    if (scriptish.looksLikeScript) {
      setOffer({ intent: text, objectType: guessObjectType(text) ?? undefined, matched: scriptish.matched ?? "" });
    }
    setBusy(true);
    stoppedRef.current = false;
    draftIdsRef.current = [];

    let messages: ChatMessage[] = [
      ...rawRef.current,
      { role: "user", content: [{ type: "text", text }] },
    ];
    let turn = 0;
    /**
     * Consecutive turns in which EVERY tool call named something that does not
     * exist.
     *
     * A weak model that has started inventing names tends to keep inventing
     * them: measured against qwen2.5-coder:3b, the repair message is answered
     * with a second invented name about as often as with a real one. Two such
     * turns is enough to stop and say so — burning all eight while the user
     * watches a column of red is worse than an honest verdict about the model.
     */
    let inventedStreak = 0;
    /**
     * The model has called a tool that does not exist during THIS message.
     *
     * Scoped to the message, not the turn, because the harm lands on the turn
     * AFTER: on 2026-08-24 qwen2.5:7b invented `format_selected_cells`, was told
     * what exists, and then called the real `apply_formatting` over a range the
     * user had not selected with four properties nobody asked for — and reported
     * success. From here on, its mutating calls are confirmed.
     */
    let misbehaved = false;
    /**
     * Whether the tool surface has been cut down to `CORE_TOOLS` for this turn
     * onward.
     *
     * MEASURED (see `CORE_TOOL_NAMES`): handed 24 tool schemas, qwen2.5-coder:3b
     * named a real tool 0 times out of 4; handed 12, it did so 4 times out of 4.
     * The surface SIZE is the lever, so the recovery for "this model keeps
     * inventing names" is to give it fewer names to hold — not to keep repeating
     * the list at it.
     *
     * ADAPTIVE rather than a setting, and rather than keyed off the model
     * profile: it needs no probe the user may never have run, it costs a capable
     * model nothing (it never triggers), and it reacts to the thing that
     * actually went wrong instead of to a prediction about it.
     */
    let narrowed = narrowedRef.current;

    // Built ONCE, from this message's own words, and reused for every turn of
    // its loop — the system prompt must stay byte-identical across turns or the
    // provider's prefix cache misses on each round. Measured: without this the
    // capable model explains what it would write and never calls the tool at
    // all (qwen2.5:7b, 3/3 text-only -> 2/3 valid drafts). See apiSurface.ts.
    // Awaited: the surface module is imported lazily so 167 KB of generated
    // reference data stays out of the extension's activation path.
    const surface = await apiSurfaceSection(text);
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
            // The prompt names the tools ACTUALLY being sent. Naming all 24
            // while sending 10 would be worse than the bug it fixes.
            // The selection is appended here rather than baked in, so it is
            // whatever the user has selected at the moment they send.
            system: withSelection(
              buildSystemPrompt(narrowed ? CORE_TOOL_NAMES : TOOL_NAMES) + surface,
            ),
            messages,
            tools: narrowed ? CORE_TOOLS : TOOLS,
            temperature: TOOL_USE_TEMPERATURE,
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
        let unknownThisTurn = 0;
        for (const tu of toolUses) {
          const salvaged = salvagedIds.has(tu.id);
          setBubbles((prev) => startTool(prev, tu.id, summarizeToolCall(tu.name, tu.input), { salvaged }));
          setActivity(`Running ${tu.name}...`);
          const started = performance.now();

          // A NAME THAT DOES NOT EXIST IS ANSWERED HERE, not by the backend.
          //
          // This check covers NATIVE calls too, and that is the whole point: a
          // small model invents names just as readily through the tool-calling
          // interface as in prose (measured — qwen2.5-coder:3b emitted
          // `formatSelectedCellsBackgroundColor` as a real tool call). Reaching
          // `ai_chat_run_tool` for it returns a bare `Unknown tool 'x'.` with no
          // hint, and a 3B model answers that by inventing a SECOND name, then
          // giving up. The repair names the closed set and the nearest real
          // tools, delivered as a tool RESULT so the model's own agentic loop
          // performs the fix — the same mechanism draftGate uses.
          if (!TOOL_NAMES.includes(tu.name)) {
            unknownThisTurn++;
            // Remembered for the REST OF THE MESSAGE, not just this turn: the
            // damage observed on 2026-08-24 happened on the turn AFTER the
            // invention, once the model had been told what exists and picked a
            // real tool with fabricated arguments.
            misbehaved = true;
            setBubbles((prev) =>
              failTool(prev, tu.id, `No tool named "${tu.name}". Told the model what exists.`, performance.now() - started),
            );
            results.push({
              type: "toolResult",
              toolUseId: tu.id,
              content: unknownToolMessage(tu.name, TOOL_NAMES),
              isError: true,
            });
            continue;
          }

          try {
            // A call we have cause to doubt, and which would MUTATE the
            // workbook, is confirmed first. `confirmAsync` is awaited and fails
            // CLOSED — a dialog that cannot be shown is a refusal, never consent.
            const doubt = doubtAbout(tu.name, salvaged, misbehaved);
            if (doubt) {
              const ok = await confirmAsync(
                confirmationText(doubt, selection.model, tu.name, tu.input),
              );
              if (!ok) {
                setBubbles((prev) => failTool(prev, tu.id, "Declined by the user.", performance.now() - started));
                results.push({
                  type: "toolResult",
                  toolUseId: tu.id,
                  content:
                    "The user declined to run this call. Do not retry it — explain what you " +
                    "intended to do and ask them what they want instead.",
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

        // Every call this turn named something that does not exist. Once is a
        // slip the repair message usually fixes; twice running means the model
        // cannot work this tool surface, and saying so is more use than eight
        // rounds of red.
        inventedStreak = unknownThisTurn === toolUses.length ? inventedStreak + 1 : 0;

        // FIRST all-invented turn: shrink the surface rather than lecture the
        // model again. This is the measured fix — 0/4 at 24 tools, 4/4 at 12.
        if (inventedStreak >= 1 && !narrowed) {
          narrowed = true;
          // Remembered, so the next message does not pay the same round trip to
          // learn the same thing about the same model.
          narrowedRef.current = true;
          addBubble({
            kind: "notice",
            text:
              `${selection.model} called a tool that does not exist. Retrying with a smaller set of ` +
              `${CORE_TOOL_NAMES.length} core tools — smaller models pick the right one far more ` +
              `reliably from a shorter list.`,
          });
          continue;
        }

        // Still inventing with ten tools in front of it. Further rounds will not
        // help, and eight of them is worse than an honest verdict.
        if (inventedStreak >= 2) {
          addBubble({
            kind: "notice",
            text:
              `${selection.model} keeps calling tools that do not exist, even from a short list. ` +
              `That is a limit of the model, not of your request. Try a larger model from ` +
              `"Change model", or ask for one step at a time ("read A1:A3", then "set the ` +
              `background of A1 to #FFFF00").`,
          });
          break;
        }
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

  // --- The GUIDED path ---
  // A separate screen rather than a mode the chat pretends to be in: the two
  // do genuinely different things, and the measured reason this exists is that
  // asking a local model to choose between them is what fails.
  if (mode === "author") {
    return h("div", { style: container },
      h("div", { key: "bar", style: bar },
        h("span", { key: "m" }, `${selection.model} — authoring a script`),
        h("button", { key: "c", style: linkBtn, onClick: () => setPicking(true) }, "Change model"),
      ),
      h(ScriptAuthor, {
        key: "author",
        providerId: selection.providerId,
        model: selection.model,
        baseUrl: selection.baseUrl,
        initialIntent: authorSeed.intent,
        initialObjectType: authorSeed.objectType,
        onBackToChat: () => setMode("chat"),
      }),
    );
  }

  const canOpenEditor = hasScriptEditorProvider();

  return h("div", { style: container },
    h("div", { key: "bar", style: bar },
      h("span", { key: "m" }, selection.model),
      h("span", { key: "sp", style: { flex: 1 } }),
      h("button", {
        key: "author",
        style: linkBtn,
        onClick: () => { setAuthorSeed({ intent: input.trim() || undefined, objectType: undefined }); setMode("author"); },
      }, "Write a script"),
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
      // The offer. Shown after the turn so it does not pre-empt an answer the
      // chat might have given perfectly well.
      offer && !busy
        ? h("div", { key: "offer", style: offerStyle },
            h("div", { key: "t", style: { marginBottom: 6 } },
              `That reads like a request for a script ("${offer.matched}"). ` +
              "Writing one through the guided path is far more reliable: it shows the model " +
              "Calcula's API, checks what it writes and corrects it, instead of asking it to " +
              "pick a tool."),
            h("div", { key: "b", style: { display: "flex", gap: 8 } },
              h("button", {
                style: offerGoStyle,
                onClick: () => {
                  setAuthorSeed({ intent: offer.intent, objectType: offer.objectType });
                  setOffer(null);
                  setMode("author");
                },
              }, "Write it as a script"),
              h("button", { style: offerDismissStyle, onClick: () => setOffer(null) }, "Not now"),
            ),
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
