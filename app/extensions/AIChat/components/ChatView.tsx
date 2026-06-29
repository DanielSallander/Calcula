//! FILENAME: app/extensions/AIChat/components/ChatView.tsx
// PURPOSE: A REAL in-app Claude chat (C1). Talks to the Anthropic Messages API
//          via the ai_chat_complete backend command, and runs an agentic
//          TOOL-USE LOOP: when Claude returns tool_use blocks, each is executed
//          through ai_chat_run_tool (the same workbook tools the MCP server
//          exposes — undoable, gated) and the tool_result is fed back until the
//          model finishes (stop_reason: end_turn).
// SECURITY: the API key is stored in the OS keychain by the backend and is never
//          handled here beyond the one-time "save key" input.

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { TaskPaneViewProps } from "@api";
import { invokeBackend } from "@api/backend";

// ---------------------------------------------------------------------------
// AI tool surface (Anthropic wire schema) — mirrors the ai_chat_run_tool
// dispatcher in ai_chat.rs. Read tools + cell write + structure creation.
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "get_sheet_summary",
    description:
      "Get an AI-optimized summary of the workbook: sheet dimensions, column types, formula patterns, sample data, and inventories of charts, named ranges, tables, and pivots. Call this first to understand the workbook.",
    input_schema: {
      type: "object",
      properties: { max_chars: { type: "number", description: "Max summary length (default 8000)." } },
    },
  },
  {
    name: "read_cell_range",
    description: "Read the values of a rectangular cell range (0-based, inclusive).",
    input_schema: {
      type: "object",
      properties: {
        start_row: { type: "number" }, start_col: { type: "number" },
        end_row: { type: "number" }, end_col: { type: "number" },
      },
      required: ["start_row", "start_col", "end_row", "end_col"],
    },
  },
  {
    name: "set_cell_value",
    description: "Set a single cell's value or formula (use '=' prefix for formulas). Undoable.",
    input_schema: {
      type: "object",
      properties: {
        row: { type: "number", description: "0-based row" },
        col: { type: "number", description: "0-based column (A=0)" },
        value: { type: "string" },
      },
      required: ["row", "col", "value"],
    },
  },
  { name: "list_charts", description: "List every chart in the workbook.", input_schema: { type: "object", properties: {} } },
  { name: "list_named_ranges", description: "List every named range.", input_schema: { type: "object", properties: {} } },
  { name: "list_tables", description: "List every structured table.", input_schema: { type: "object", properties: {} } },
  { name: "list_pivots", description: "List every pivot table with its fields.", input_schema: { type: "object", properties: {} } },
  {
    name: "create_named_range",
    description: "Create a workbook-defined name. Undoable.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        refers_to: { type: "string", description: "e.g. \"=Sheet1!$A$1:$B$10\" or \"=0.25\"" },
        sheet_index: { type: "number", description: "Omit for workbook scope" },
        comment: { type: "string" },
      },
      required: ["name", "refers_to"],
    },
  },
  {
    name: "create_table",
    description: "Create a structured table over a cell range (0-based, inclusive). Undoable.",
    input_schema: {
      type: "object",
      properties: {
        start_row: { type: "number" }, start_col: { type: "number" },
        end_row: { type: "number" }, end_col: { type: "number" },
        has_headers: { type: "boolean" }, name: { type: "string" },
      },
      required: ["start_row", "start_col", "end_row", "end_col"],
    },
  },
];

const SYSTEM_PROMPT =
  "You are an AI assistant embedded in Calcula, a spreadsheet application. You help the user " +
  "read and edit the open workbook using the provided tools. Prefer get_sheet_summary to orient " +
  "yourself before reading/writing. Cell coordinates are 0-based (row 0 = row 1, col 0 = column A). " +
  "Keep replies concise. Confirm destructive or large edits before making them.";

const MAX_TOOL_TURNS = 8;

type AnyBlock = { type: string; text?: string; id?: string; name?: string; input?: unknown };
type RawMsg = { role: "user" | "assistant"; content: string | AnyBlock[] };
type Bubble = { kind: "user" | "assistant" | "tool" | "error"; text: string };

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const container: React.CSSProperties = { display: "flex", flexDirection: "column", height: "100%", fontFamily: "Segoe UI, Tahoma, sans-serif", fontSize: 12, backgroundColor: "#FAFAFA" };
const log: React.CSSProperties = { flex: 1, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 8 };
const inputRow: React.CSSProperties = { display: "flex", gap: 6, padding: 8, borderTop: "1px solid #E0E0E0" };
const textArea: React.CSSProperties = { flex: 1, resize: "none", padding: 6, border: "1px solid #CCC", borderRadius: 4, fontFamily: "inherit", fontSize: 12 };
const btn: React.CSSProperties = { padding: "6px 14px", border: "none", borderRadius: 4, background: "#0078D4", color: "#FFF", cursor: "pointer" };

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
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const rawRef = useRef<RawMsg[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    invokeBackend<boolean>("ai_chat_has_api_key").then(setHasKey).catch(() => setHasKey(false));
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [bubbles]);

  const addBubble = useCallback((b: Bubble) => setBubbles((prev) => [...prev, b]), []);

  const saveKey = useCallback(async () => {
    try {
      await invokeBackend("ai_chat_set_api_key", { key: keyInput.trim() });
      setKeyInput("");
      setHasKey(true);
    } catch (e) {
      addBubble({ kind: "error", text: `Could not save key: ${e}` });
    }
  }, [keyInput, addBubble]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    addBubble({ kind: "user", text });
    setBusy(true);

    let raw: RawMsg[] = [...rawRef.current, { role: "user", content: text }];
    try {
      for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
        const resp = await invokeBackend<any>("ai_chat_complete", {
          messages: raw,
          tools: TOOLS,
          system: SYSTEM_PROMPT,
        });
        const content: AnyBlock[] = Array.isArray(resp?.content) ? resp.content : [];
        raw = [...raw, { role: "assistant", content }];

        const say = content.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("\n").trim();
        if (say) addBubble({ kind: "assistant", text: say });

        const toolUses = content.filter((b) => b.type === "tool_use");
        if (resp?.stop_reason !== "tool_use" || toolUses.length === 0) break;

        const toolResults: AnyBlock[] = [];
        for (const tu of toolUses) {
          addBubble({ kind: "tool", text: `${tu.name}(${JSON.stringify(tu.input ?? {})})` });
          let result: string;
          try {
            result = await invokeBackend<string>("ai_chat_run_tool", { name: tu.name, input: tu.input ?? {} });
          } catch (e) {
            result = `Error: ${e}`;
          }
          toolResults.push({ type: "tool_result", id: tu.id, text: result } as AnyBlock);
        }
        // Anthropic tool_result blocks: { type, tool_use_id, content }.
        raw = [...raw, {
          role: "user",
          content: toolResults.map((t) => ({ type: "tool_result", tool_use_id: t.id, content: t.text })) as AnyBlock[],
        }];
      }
    } catch (e) {
      addBubble({ kind: "error", text: `${e}` });
    } finally {
      rawRef.current = raw;
      setBusy(false);
    }
  }, [input, busy, addBubble]);

  // --- API-key setup gate ---
  if (hasKey === false) {
    return h("div", { style: { ...container, padding: 16, gap: 10, justifyContent: "center" } },
      h("h3", { key: "t", style: { margin: 0 } }, "Connect Claude"),
      h("p", { key: "d", style: { color: "#666", margin: 0 } },
        "Paste an Anthropic API key to chat with Claude about this workbook. The key is stored in your OS keychain and never leaves this machine."),
      h("input", {
        key: "i", type: "password", value: keyInput, placeholder: "sk-ant-...",
        style: { ...textArea, height: 28 },
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setKeyInput(e.target.value),
      }),
      h("button", { key: "b", style: btn, disabled: !keyInput.trim(), onClick: saveKey }, "Save key"),
    );
  }

  return h("div", { style: container },
    h("div", { key: "log", ref: logRef, style: log },
      bubbles.length === 0
        ? h("div", { key: "empty", style: { color: "#999", textAlign: "center", marginTop: 20 } },
            "Ask Claude about your workbook — it can read cells, summarize data, and make undoable edits.")
        : bubbles.map((b, i) => h("div", { key: i, style: bubbleStyle(b.kind) }, b.text)),
      busy ? h("div", { key: "busy", style: { ...bubbleStyle("assistant"), color: "#999" } }, "…") : null,
    ),
    h("div", { key: "in", style: inputRow },
      h("textarea", {
        key: "ta", style: textArea, rows: 2, value: input, placeholder: "Message Claude…", disabled: busy,
        onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setInput(e.target.value),
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
        },
      }),
      h("button", { key: "send", style: { ...btn, opacity: busy || !input.trim() ? 0.5 : 1 }, disabled: busy || !input.trim(), onClick: () => void send() }, "Send"),
    ),
  );
}
