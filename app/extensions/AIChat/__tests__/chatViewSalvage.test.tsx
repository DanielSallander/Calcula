//! FILENAME: app/extensions/AIChat/__tests__/chatViewSalvage.test.tsx
// PURPOSE: The reported failure, end to end through the real component: a model
//          that PRINTS a tool call instead of emitting one must still get the
//          work done — and a recovered call that would change the workbook must
//          ask the user first.
// CONTEXT: 2026-08-22. "create a script that formats the background color of
//          each selected cell" -> the model replied with a fenced ```json block
//          and nothing happened. The parser is unit-tested in
//          textToolCalls.test.ts; what THIS file pins is the WIRING, which had
//          no coverage of any kind — no unit test imported ChatView and no E2E
//          journey drove it. The wiring is where the load-bearing detail lives:
//          a synthetic toolUse block must be added to the ASSISTANT MESSAGE as
//          well as dispatched, or the toolResult that follows references a call
//          the provider never saw and the next turn is rejected outright.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ChatMessage, ChatResponse } from "../lib/aiTypes";

// --- Backend -----------------------------------------------------------------
const invoke = vi.fn();
vi.mock("../lib/aiChatBackend", () => ({
  aiChatBackend: { invoke: (...a: unknown[]) => invoke(...a) },
}));

// --- @api --------------------------------------------------------------------
const confirmAsync = vi.fn();
const openDraftInEditor = vi.fn(async () => {});
const store = new Map<string, string>([
  ["calcula.ai-chat:providerId", "ollama"],
  ["calcula.ai-chat:model", "qwen2.5-coder:3b"],
  ["calcula.ai-chat:baseUrl", "http://127.0.0.1:11434/v1"],
]);
vi.mock("@api", () => ({
  getSetting: (ext: string, k: string, d: string) => store.get(`${ext}:${k}`) ?? d,
  setSetting: (ext: string, k: string, v: string) => void store.set(`${ext}:${k}`, String(v)),
  listenTauriEvent: async () => () => {},
  // The Tauri SHAPE: a Promise<boolean>. A synchronous boolean double is what
  // let the window.confirm defect pass review six times.
  confirmAsync: (...a: unknown[]) => confirmAsync(...a),
  hasScriptEditorProvider: () => true,
  requireScriptEditorProvider: () => ({ openDraftInEditor, openMacroInEditor: async () => {} }),
  AppEvents: { SELECTION_CHANGED: "app:selection-changed" },
  onAppEvent: () => () => {},
  a1Rect: (r1: number, c1: number, r2: number, c2: number) => `R${r1}C${c1}:R${r2}C${c2}`,
}));

// The gate needs a Worker realm it does not have here; it is proved separately
// in draftGate.test.ts. Allow everything so this file tests only the wiring.
vi.mock("../lib/draftGate", () => ({ gateToolCall: async () => ({ allow: true }) }));

const { ChatView } = await import("../components/ChatView");

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

/** The `messages` array of the n-th ai_chat_complete_stream call. */
function sentMessages(call: number): ChatMessage[] {
  const streamCalls = invoke.mock.calls.filter((c) => c[0] === "ai_chat_complete_stream");
  return (streamCalls[call][1] as { request: { messages: ChatMessage[] } }).request.messages;
}

function sentSystem(call: number): string {
  const streamCalls = invoke.mock.calls.filter((c) => c[0] === "ai_chat_complete_stream");
  return (streamCalls[call][1] as { request: { system: string } }).request.system;
}

function runToolCalls(): Array<{ name: string; input: unknown }> {
  return invoke.mock.calls
    .filter((c) => c[0] === "ai_chat_run_tool")
    .map((c) => c[1] as { name: string; input: unknown });
}

const textReply = (text: string): ChatResponse => ({
  blocks: [{ type: "text", text }],
  stopReason: "endTurn",
  model: "qwen2.5-coder:3b",
});

/** Type a message and press Send, then let every microtask settle. */
async function ask(text: string): Promise<void> {
  const textarea = container.querySelector("textarea")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, "value",
    )!.set!;
    setter.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const send = [...container.querySelectorAll("button")].find((b) => b.textContent === "Send")!;
  await act(async () => {
    send.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

beforeEach(async () => {
  invoke.mockReset();
  confirmAsync.mockReset();
  openDraftInEditor.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(ChatView, {} as never));
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

// ---------------------------------------------------------------------------

describe("a tool call written as text still runs", () => {
  it("recovers a fenced draft_object_script call and dispatches it", async () => {
    // The reported prompt, and the shape the model actually replied with.
    const source = "export function setup(context) {\n  context.onClick(async () => {});\n}";
    const printed =
      "Here is the script:\n```json\n" +
      JSON.stringify({
        name: "draft_object_script",
        arguments: { name: "Paint by value", object_type: "button", source },
      }) +
      "\n```";

    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ai_chat_complete_stream") {
        const nth = invoke.mock.calls.filter((c) => c[0] === "ai_chat_complete_stream").length;
        return nth === 1 ? textReply(printed) : textReply("Done — it is queued for your review.");
      }
      if (cmd === "ai_chat_run_tool") {
        return 'Drafted object script "Paint by value" (id=draft-ab12cd34) for button.';
      }
      return null;
    });

    await ask("format the background of each selected cell by its content");

    const dispatched = runToolCalls();
    expect(dispatched.map((c) => c.name), "the printed call must actually run").toEqual([
      "draft_object_script",
    ]);
    expect((dispatched[0].input as { source: string }).source).toBe(source);
  });

  it("puts the synthetic call in the ASSISTANT message, not only in the dispatch", async () => {
    // THE detail an implementation gets wrong. A toolResult whose toolUseId has
    // no matching toolUse in the transcript is rejected by both vendors, so the
    // NEXT turn dies — and the symptom is a provider error, far from the cause.
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ai_chat_complete_stream") {
        const nth = invoke.mock.calls.filter((c) => c[0] === "ai_chat_complete_stream").length;
        return nth === 1
          ? textReply('```json\n{"name":"list_charts","arguments":{}}\n```')
          : textReply("There are no charts.");
      }
      return "(no charts)";
    });

    await ask("what charts are there?");

    const second = sentMessages(1);
    const uses = second.flatMap((m) => m.content).filter((b) => b.type === "toolUse");
    const results = second.flatMap((m) => m.content).filter((b) => b.type === "toolResult");
    expect(uses, "the recovered call must be in the transcript").toHaveLength(1);
    expect(results).toHaveLength(1);
    const useId = (uses[0] as { id: string }).id;
    const resultId = (results[0] as { toolUseId: string }).toolUseId;
    expect(resultId, "every result must reference a call the provider can see").toBe(useId);
  });

  it("keeps the prose and drops the JSON blob from the bubble", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ai_chat_complete_stream") {
        const nth = invoke.mock.calls.filter((c) => c[0] === "ai_chat_complete_stream").length;
        return nth === 1
          ? textReply('Let me look at the charts.\n```json\n{"name":"list_charts","arguments":{}}\n```')
          : textReply("None found.");
      }
      return "(no charts)";
    });

    await ask("charts?");

    expect(container.textContent).toContain("Let me look at the charts.");
    expect(container.textContent, "the raw call is noise once it is running")
      .not.toContain('"name":"list_charts"');
    expect(container.textContent).toContain("wrote its tool call as text");
  });

  it("tells the model what exists when it invents a name, instead of ending the turn", async () => {
    // `format_cells` — the exact invention from the report.
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ai_chat_complete_stream") {
        const nth = invoke.mock.calls.filter((c) => c[0] === "ai_chat_complete_stream").length;
        return nth === 1
          ? textReply('```json\n{"name":"format_cells","arguments":{"cells":["A1"]}}\n```')
          : textReply("Understood.");
      }
      return "";
    });

    await ask("colour the cells");

    const streamCalls = invoke.mock.calls.filter((c) => c[0] === "ai_chat_complete_stream");
    expect(streamCalls, "the turn must continue, not end silently").toHaveLength(2);
    const repair = JSON.stringify(sentMessages(1));
    expect(repair).toContain("There is no tool called");
    expect(repair, "and it must be pointed at the real one").toContain("apply_formatting");
    // Nothing was dispatched under a made-up name.
    expect(runToolCalls()).toEqual([]);
  });

  it("does not salvage when the model emitted a real call as well", async () => {
    // A model that calls a tool AND describes one is not asking for the
    // description to run.
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ai_chat_complete_stream") {
        const nth = invoke.mock.calls.filter((c) => c[0] === "ai_chat_complete_stream").length;
        if (nth === 1) {
          return {
            blocks: [
              { type: "text", text: 'I could also run:\n```json\n{"name":"run_script","arguments":{"code":"x"}}\n```' },
              { type: "toolUse", id: "call_1", name: "list_charts", input: {} },
            ],
            stopReason: "toolUse",
            model: "m",
          } as ChatResponse;
        }
        return textReply("Done.");
      }
      return "(no charts)";
    });

    await ask("charts?");

    expect(runToolCalls().map((c) => c.name)).toEqual(["list_charts"]);
    expect(confirmAsync).not.toHaveBeenCalled();
  });
});

describe("a recovered call that changes the workbook asks first", () => {
  const printedWrite =
    '```json\n{"name":"set_cell_value","arguments":{"row":0,"col":0,"value":"hi"}}\n```';

  function mockWriteTurn(): void {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ai_chat_complete_stream") {
        const nth = invoke.mock.calls.filter((c) => c[0] === "ai_chat_complete_stream").length;
        return nth === 1 ? textReply(printedWrite) : textReply("Done.");
      }
      return "ok";
    });
  }

  it("runs the write when the user agrees", async () => {
    mockWriteTurn();
    confirmAsync.mockReturnValue(Promise.resolve(true));
    await ask("put hi in A1");
    expect(confirmAsync).toHaveBeenCalledTimes(1);
    expect(runToolCalls().map((c) => c.name)).toEqual(["set_cell_value"]);
  });

  it("does NOT run it when the user declines, and tells the model so", async () => {
    mockWriteTurn();
    confirmAsync.mockReturnValue(Promise.resolve(false));
    await ask("put hi in A1");
    expect(confirmAsync).toHaveBeenCalledTimes(1);
    expect(runToolCalls(), "a declined call must not reach the backend").toEqual([]);
    expect(JSON.stringify(sentMessages(1))).toContain("declined");
  });

  it("fails CLOSED when the dialog itself cannot be shown", async () => {
    // confirmAsync fails closed by contract; a rejection here must not be read
    // as consent.
    mockWriteTurn();
    // mockImplementation, not mockReturnValue: a rejected promise built in the
    // test body is unhandled until the click attaches a handler, and Node flags
    // that as an unhandled rejection even though the product code awaits it.
    confirmAsync.mockImplementation(() => Promise.reject(new Error("no dialog")));
    await ask("put hi in A1");
    expect(runToolCalls()).toEqual([]);
  });

  it("asks for nothing when the recovered call is read-only", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ai_chat_complete_stream") {
        const nth = invoke.mock.calls.filter((c) => c[0] === "ai_chat_complete_stream").length;
        return nth === 1
          ? textReply('```json\n{"name":"list_tables","arguments":{}}\n```')
          : textReply("Done.");
      }
      return "(none)";
    });
    await ask("tables?");
    expect(confirmAsync).not.toHaveBeenCalled();
    expect(runToolCalls().map((c) => c.name)).toEqual(["list_tables"]);
  });

  it("never asks about a NATIVE call, however mutating", async () => {
    // The confirmation is about the provenance of the PARSE, not about reach. A
    // model that emitted the call through the interface built for it is not
    // second-guessed.
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ai_chat_complete_stream") {
        const nth = invoke.mock.calls.filter((c) => c[0] === "ai_chat_complete_stream").length;
        if (nth === 1) {
          return {
            blocks: [{ type: "toolUse", id: "call_1", name: "set_cell_value", input: { row: 0, col: 0, value: "hi" } }],
            stopReason: "toolUse", model: "m",
          } as ChatResponse;
        }
        return textReply("Done.");
      }
      return "ok";
    });
    await ask("put hi in A1");
    expect(confirmAsync).not.toHaveBeenCalled();
    expect(runToolCalls().map((c) => c.name)).toEqual(["set_cell_value"]);
  });
});

describe("the draft is reachable from the chat", () => {
  it("offers Open in Object Script Editor and routes the id through the seam", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ai_chat_complete_stream") {
        const nth = invoke.mock.calls.filter((c) => c[0] === "ai_chat_complete_stream").length;
        if (nth === 1) {
          return {
            blocks: [{
              type: "toolUse", id: "call_1", name: "draft_object_script",
              input: { name: "Paint", object_type: "button", source: "export function setup(c){}" },
            }],
            stopReason: "toolUse", model: "m",
          } as ChatResponse;
        }
        return textReply("Queued for your review.");
      }
      return 'Drafted object script "Paint" (id=draft-ab12cd34) for button.';
    });

    await ask("make me a button script");

    const open = [...container.querySelectorAll("button")]
      .find((b) => b.textContent?.includes("Open in Object Script Editor"));
    expect(open, "the chat must offer a way back to the draft").toBeTruthy();

    await act(async () => {
      open!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    // The id parsed out of the backend's own result sentence, since no
    // mcp:script-draft event is delivered in this harness.
    expect(openDraftInEditor).toHaveBeenCalledWith("draft-ab12cd34");
  });

  it("shows no button for a call that produced no draft", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "ai_chat_complete_stream" ? textReply("No charts here.") : "",
    );
    await ask("charts?");
    const open = [...container.querySelectorAll("button")]
      .find((b) => b.textContent?.includes("Open in Object Script Editor"));
    expect(open).toBeUndefined();
  });
});

describe("progress and failure are visible", () => {
  it("resolves a finished tool call rather than leaving it running", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ai_chat_complete_stream") {
        const nth = invoke.mock.calls.filter((c) => c[0] === "ai_chat_complete_stream").length;
        if (nth === 1) {
          return {
            blocks: [{ type: "toolUse", id: "call_1", name: "list_charts", input: {} }],
            stopReason: "toolUse", model: "m",
          } as ChatResponse;
        }
        return textReply("None.");
      }
      return "3 charts";
    });
    await ask("charts?");
    expect(container.textContent).toContain("[OK]");
    expect(container.textContent).toContain("3 charts");
    expect(container.textContent, "no call may be left spinning").not.toContain("[..]");
  });

  it("shows a THROWN tool as a failure instead of nothing at all", async () => {
    // Previously invisible: the message went to the model and the user saw
    // nothing while the loop burned turns.
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ai_chat_complete_stream") {
        const nth = invoke.mock.calls.filter((c) => c[0] === "ai_chat_complete_stream").length;
        if (nth === 1) {
          return {
            blocks: [{ type: "toolUse", id: "call_1", name: "run_script", input: { code: "x" } }],
            stopReason: "toolUse", model: "m",
          } as ChatResponse;
        }
        return textReply("I could not.");
      }
      throw new Error("Script Security refused execution.");
    });
    await ask("run it");
    expect(container.textContent).toContain("[!]");
    expect(container.textContent).toContain("Script Security refused execution.");
  });

  it("reports a provider failure as an error the user can read", async () => {
    invoke.mockRejectedValue(new Error("Ollama error 400: model not found"));
    await ask("hello");
    expect(container.textContent).toContain("Ollama error 400");
  });
});

describe("the selection reaches the model", () => {
  it("is absent from the prompt when nothing is selected", async () => {
    invoke.mockImplementation(async () => textReply("ok"));
    await ask("hello");
    expect(sentSystem(0)).not.toContain("CURRENT SELECTION is");
  });

  it("is appended when there is one", async () => {
    const { __setSelectionForTest } = await import("../lib/selectionContext");
    __setSelectionForTest({ sheetIndex: 0, areas: [{ startRow: 2, startCol: 1, endRow: 5, endCol: 1 }] });
    invoke.mockImplementation(async () => textReply("ok"));
    await ask("colour the selected cells");
    expect(sentSystem(0)).toContain("CURRENT SELECTION");
    expect(sentSystem(0)).toContain("rows 2-5");
    __setSelectionForTest(null);
  });
});
