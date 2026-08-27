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
  // The job strip subscribes to the real job store, which toasts on completion.
  showToast: vi.fn(),
}));

// The gate needs a Worker realm it does not have here; it is proved separately
// in draftGate.test.ts. Allow everything so this file tests only the wiring.
//
// MUTABLE, and reset in `beforeEach`. The verdict now carries fields the CHAT
// renders, so a test has to be able to set one — and a case that forgets to
// reset it would decorate every later transcript with a stray bubble.
let gateVerdict: Record<string, unknown> = { allow: true };
vi.mock("../lib/draftGate", () => ({ gateToolCall: async () => gateVerdict }));

// ScriptAuthor is reachable from the chat now; its own suite proves it.
vi.mock("../lib/authorRunner", () => ({ runAuthor: () => new Promise(() => {}) }));

const { ChatView } = await import("../components/ChatView");
// The REAL job store: the strip below is a view of it, and doubling it would
// test the double rather than the wiring.
const { startAuthorJob, __resetJobs } = await import("../lib/authorJobs");

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

async function render(): Promise<void> {
  await act(async () => { root.render(React.createElement(ChatView, {} as never)); });
}

beforeEach(async () => {
  invoke.mockReset();
  confirmAsync.mockReset();
  openDraftInEditor.mockClear();
  // Miss this and one case's verdict decorates every transcript after it.
  gateVerdict = { allow: true };
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

describe("an invented name is answered the same way however it arrives", () => {
  // Measured against a live Ollama on 2026-08-22: qwen2.5-coder:3b emits
  // `formatSelectedCellsBackgroundColor` as a REAL, NATIVE tool call — not as
  // prose. The first fix only taught the salvage path, so a native invention
  // reached `ai_chat_run_tool`, came back as a bare `Unknown tool 'x'.` with no
  // hint, and the model answered by inventing a second name and giving up.

  function nativeInvention(name: string, then: ChatResponse) {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ai_chat_complete_stream") {
        const nth = invoke.mock.calls.filter((c) => c[0] === "ai_chat_complete_stream").length;
        if (nth === 1) {
          return {
            blocks: [{ type: "toolUse", id: "call_1", name, input: { backgroundColor: "#FFFF00" } }],
            stopReason: "toolUse", model: "qwen2.5-coder:3b",
          } as ChatResponse;
        }
        return then;
      }
      return "ok";
    });
  }

  it("never dispatches a NATIVE call whose name does not exist", async () => {
    nativeInvention("formatSelectedCellsBackgroundColor", textReply("Sorry."));
    await ask("colour the selected cells");
    expect(
      runToolCalls(),
      "the backend must not be asked for a tool that cannot exist",
    ).toEqual([]);
  });

  it("tells the model what DOES exist, and points at the nearest real tool", async () => {
    nativeInvention("formatSelectedCellsBackgroundColor", textReply("Understood."));
    await ask("colour the selected cells");
    const repair = JSON.stringify(sentMessages(1));
    expect(repair).toContain("There is no tool called");
    expect(repair, "the real neighbour").toContain("apply_formatting");
    // The closed set is restated, which is what the bare backend error lacked.
    expect(repair).toContain("draft_object_script");
  });

  it("shows the user the failed call rather than a silent 4ms nothing", async () => {
    nativeInvention("formatSelectedCellsBackgroundColor", textReply("Understood."));
    await ask("colour the selected cells");
    expect(container.textContent).toContain("[!]");
    expect(container.textContent).toContain("No tool named");
  });

  it("stops and blames the MODEL after two all-invented turns", async () => {
    // A weak model answers the repair with a second invention about as often as
    // with a real name. Eight rounds of red is worse than an honest verdict.
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ai_chat_complete_stream") {
        const nth = invoke.mock.calls.filter((c) => c[0] === "ai_chat_complete_stream").length;
        return {
          blocks: [{ type: "toolUse", id: `call_${nth}`, name: `madeUpTool${nth}`, input: {} }],
          stopReason: "toolUse", model: "qwen2.5-coder:3b",
        } as ChatResponse;
      }
      return "ok";
    });
    await ask("colour the selected cells");
    const streamCalls = invoke.mock.calls.filter((c) => c[0] === "ai_chat_complete_stream");
    expect(streamCalls.length, "must not burn all 8 turns").toBe(2);
    expect(container.textContent).toContain("keeps calling tools that do not exist");
    expect(container.textContent, "the model is named, so the user knows what to change")
      .toContain("qwen2.5-coder:3b");
  });

  it("does not blame the model when it recovers after one bad name", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ai_chat_complete_stream") {
        const nth = invoke.mock.calls.filter((c) => c[0] === "ai_chat_complete_stream").length;
        if (nth === 1) {
          return {
            blocks: [{ type: "toolUse", id: "c1", name: "formatCells", input: {} }],
            stopReason: "toolUse", model: "m",
          } as ChatResponse;
        }
        if (nth === 2) {
          return {
            blocks: [{ type: "toolUse", id: "c2", name: "list_charts", input: {} }],
            stopReason: "toolUse", model: "m",
          } as ChatResponse;
        }
        return textReply("There are no charts.");
      }
      return "(no charts)";
    });
    await ask("charts?");
    expect(runToolCalls().map((c) => c.name)).toEqual(["list_charts"]);
    expect(container.textContent).not.toContain("keeps calling tools that do not exist");
  });
});

describe("the tool surface shrinks when the model cannot hold it", () => {
  // MEASURED against a live Ollama, 2026-08-22, replaying the user's exact
  // request: qwen2.5-coder:3b named a real tool 0/4 times with 24 tool schemas
  // and 4/4 with 12. The surface SIZE is the lever — not the prompt, and not the
  // temperature (temp 0 at 24 tools was 0/4, just deterministically wrong).

  function toolsSent(call: number): string[] {
    const streamCalls = invoke.mock.calls.filter((c) => c[0] === "ai_chat_complete_stream");
    const req = streamCalls[call][1] as { request: { tools: Array<{ name: string }> } };
    return req.request.tools.map((t) => t.name);
  }

  it("sends the FULL surface first — a capable model loses nothing", async () => {
    invoke.mockImplementation(async () => textReply("Nothing to do."));
    await ask("hello");
    expect(toolsSent(0).length).toBeGreaterThanOrEqual(20);
  });

  it("narrows to the core set after one all-invented turn, and retries", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ai_chat_complete_stream") {
        const nth = invoke.mock.calls.filter((c) => c[0] === "ai_chat_complete_stream").length;
        if (nth === 1) {
          return {
            blocks: [{ type: "toolUse", id: "c1", name: "formatSelectedCellsBackgroundColor", input: {} }],
            stopReason: "toolUse", model: "qwen2.5-coder:3b",
          } as ChatResponse;
        }
        if (nth === 2) {
          return {
            blocks: [{ type: "toolUse", id: "c2", name: "apply_formatting", input: { start_row: 0, start_col: 0, end_row: 2, end_col: 0, background_color: "#FFFF00" } }],
            stopReason: "toolUse", model: "qwen2.5-coder:3b",
          } as ChatResponse;
        }
        return textReply("Done.");
      }
      return "formatted";
    });

    // The model invented a name, so its later mutating calls are now
    // confirmed (see the safety guard). Grant it: this test is about the
    // narrowing, not about the confirmation.
    confirmAsync.mockReturnValue(Promise.resolve(true));
    await ask("colour the selected cells by their content");

    const first = toolsSent(0);
    const second = toolsSent(1);
    expect(second.length, "the retry must carry FEWER tools").toBeLessThan(first.length);
    expect(container.textContent).toContain("Retrying with a smaller set");
    // ...and the retry actually worked.
    expect(runToolCalls().map((c) => c.name)).toEqual(["apply_formatting"]);
  });

  it("keeps the script path in the core set — it is the headline use case", async () => {
    // The naive "first twelve tools" slice drops draft_object_script, which
    // produced a model that formatted cells when asked for a SCRIPT.
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ai_chat_complete_stream") {
        const nth = invoke.mock.calls.filter((c) => c[0] === "ai_chat_complete_stream").length;
        if (nth === 1) {
          return {
            blocks: [{ type: "toolUse", id: "c1", name: "madeUp", input: {} }],
            stopReason: "toolUse", model: "m",
          } as ChatResponse;
        }
        return textReply("ok");
      }
      return "";
    });
    await ask("make me a script");
    const narrowed = toolsSent(1);
    expect(narrowed).toContain("draft_object_script");
    expect(narrowed).toContain("apply_formatting");
    expect(narrowed).toContain("get_sheet_summary");
  });

  it("narrows the PROMPT with the tools, never promising an absent one", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ai_chat_complete_stream") {
        const nth = invoke.mock.calls.filter((c) => c[0] === "ai_chat_complete_stream").length;
        if (nth === 1) {
          return {
            blocks: [{ type: "toolUse", id: "c1", name: "madeUp", input: {} }],
            stopReason: "toolUse", model: "m",
          } as ChatResponse;
        }
        return textReply("ok");
      }
      return "";
    });
    await ask("do something");

    const prompt = sentSystem(1);
    const sent = toolsSent(1);
    // Every name the narrowed prompt claims exists must actually be offered.
    for (const dropped of ["create_pivot", "cube_kpi", "list_bi_connections"]) {
      expect(sent).not.toContain(dropped);
      expect(prompt, `${dropped} is not offered and must not be named`).not.toContain(dropped);
    }
    for (const kept of sent) expect(prompt).toContain(kept);
  });

  it("does not narrow when the model simply used a real tool", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ai_chat_complete_stream") {
        const nth = invoke.mock.calls.filter((c) => c[0] === "ai_chat_complete_stream").length;
        if (nth === 1) {
          return {
            blocks: [{ type: "toolUse", id: "c1", name: "list_charts", input: {} }],
            stopReason: "toolUse", model: "m",
          } as ChatResponse;
        }
        return textReply("None.");
      }
      return "(none)";
    });
    await ask("charts?");
    expect(toolsSent(1).length).toBe(toolsSent(0).length);
    expect(container.textContent).not.toContain("Retrying with a smaller set");
  });
});

describe("the model is shown the script API before being asked to write one", () => {
  // MEASURED 2026-08-23, live Ollama, the reporter's own prompt, 10-tool core,
  // temperature 0: qwen2.5:7b with no API docs was 3/3 TEXT-ONLY — it explained
  // what it would write and never called a tool. With the docs: 2/3 drafts whose
  // source passes the whole validation ladder. The chat had never sent them.

  it("prefixes the API surface onto the system prompt", async () => {
    invoke.mockImplementation(async () => textReply("ok"));
    await ask("create a script that colours the selected cells");
    const system = sentSystem(0);
    expect(system).toContain("Calcula object-script API");
    expect(system, "the exhaustiveness claim is the point").toContain("do not invent one");
    // The rules survive alongside the reference.
    expect(system).toContain("EMIT A TOOL CALL");
  });

  it("ranks the surface by the USER's words, not a fixed slice", async () => {
    invoke.mockImplementation(async () => textReply("ok"));
    await ask("format the background of each selected cell");
    // Without hints drawn from the request, api.getSelection falls outside the
    // budget entirely — and a script about "selected cells" cannot be written
    // without it, because it reads the selection at RUN time.
    expect(sentSystem(0)).toContain("api.getSelection");
  });

  it("keeps the system prompt byte-identical across the turns of one message", async () => {
    // A varying prompt misses the provider's prefix cache on every round, which
    // on a local model means re-processing ~6k tokens per turn.
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ai_chat_complete_stream") {
        const nth = invoke.mock.calls.filter((c) => c[0] === "ai_chat_complete_stream").length;
        if (nth === 1) {
          return {
            blocks: [{ type: "toolUse", id: "c1", name: "list_charts", input: {} }],
            stopReason: "toolUse", model: "m",
          } as ChatResponse;
        }
        return textReply("None.");
      }
      return "(none)";
    });
    await ask("what charts are there?");
    expect(sentSystem(1)).toBe(sentSystem(0));
  });
});

describe("the narrowing is remembered for the session", () => {
  // Measured: BOTH the 3b and the 7b invent a name at 24 tools, so the narrowing
  // fires on essentially every first message to a local model. Re-learning it
  // per message would burn one round trip each time for no new information.

  function toolCounts(): number[] {
    return invoke.mock.calls
      .filter((c) => c[0] === "ai_chat_complete_stream")
      .map((c) => (c[1] as { request: { tools: unknown[] } }).request.tools.length);
  }

  it("a second message starts narrowed, with no wasted turn", async () => {
    let invented = true;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ai_chat_complete_stream") {
        if (invented) {
          invented = false;
          return {
            blocks: [{ type: "toolUse", id: "c1", name: "madeUpTool", input: {} }],
            stopReason: "toolUse", model: "m",
          } as ChatResponse;
        }
        return textReply("ok");
      }
      return "";
    });

    await ask("first message");
    const afterFirst = toolCounts();
    // Turn 1 full, turn 2 narrowed.
    expect(afterFirst[0]).toBeGreaterThan(afterFirst[1]);

    invoke.mockClear();
    invoke.mockImplementation(async () => textReply("ok"));
    await ask("second message");
    const second = toolCounts();
    expect(second, "the second message must not re-learn it").toHaveLength(1);
    expect(second[0], "and must start narrowed").toBeLessThan(afterFirst[0]);
  });
});

describe("a model that has started guessing does not get to edit silently", () => {
  // THE 2026-08-24 REPORT. qwen2.5:7b invented `format_selected_cells`, was told
  // what exists, and on the very next turn called the real `apply_formatting`
  // over B2:D6 — a range the user had not selected — setting a white
  // background, bold, right alignment and a "0.00" number format that nobody
  // asked for. Then: "Great! The formatting has been applied." Silently wrong
  // plus a false success claim is the worst outcome in this whole feature.

  /** Turn 1 invents a name; turn 2 calls a real mutating tool. */
  function inventThenMutate() {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ai_chat_complete_stream") {
        const nth = invoke.mock.calls.filter((c) => c[0] === "ai_chat_complete_stream").length;
        if (nth === 1) {
          return {
            blocks: [{ type: "toolUse", id: "c1", name: "format_selected_cells", input: {} }],
            stopReason: "toolUse", model: "qwen2.5:7b",
          } as ChatResponse;
        }
        if (nth === 2) {
          return {
            blocks: [{
              type: "toolUse", id: "c2", name: "apply_formatting",
              input: { start_row: 1, start_col: 1, end_row: 5, end_col: 3, background_color: "#FFFFFF", bold: true },
            }],
            stopReason: "toolUse", model: "qwen2.5:7b",
          } as ChatResponse;
        }
        return textReply("Great! The formatting has been applied.");
      }
      return "Applied formatting to 15 cell(s) (B2:D6)";
    });
  }

  it("asks before the fabricated edit, naming why", async () => {
    inventThenMutate();
    confirmAsync.mockReturnValue(Promise.resolve(true));
    await ask("create a script that colours each selected cell by its content");

    expect(confirmAsync).toHaveBeenCalledTimes(1);
    const asked = String(confirmAsync.mock.calls[0][0]);
    expect(asked, "the reason must be stated, not just 'are you sure'")
      .toContain("already called a tool that does not exist");
    // The SELECTED model, which is what the user can act on — not whatever
    // name the provider echoed back in the response.
    expect(asked).toContain("qwen2.5-coder:3b");
    expect(asked, "and what it would actually do").toContain("apply_formatting");
  });

  it("does NOT touch the workbook when the user says no", async () => {
    inventThenMutate();
    confirmAsync.mockReturnValue(Promise.resolve(false));
    await ask("create a script that colours each selected cell by its content");
    expect(runToolCalls(), "the 15-cell reformat must not happen").toEqual([]);
  });

  it("fails CLOSED if the dialog cannot be shown", async () => {
    inventThenMutate();
    confirmAsync.mockImplementation(() => Promise.reject(new Error("no dialog")));
    await ask("create a script that colours each selected cell by its content");
    expect(runToolCalls()).toEqual([]);
  });

  it("tells the model not to retry, so it stops rather than looping", async () => {
    inventThenMutate();
    confirmAsync.mockReturnValue(Promise.resolve(false));
    await ask("create a script that colours each selected cell by its content");
    expect(JSON.stringify(sentMessages(2))).toContain("Do not retry it");
  });

  it("still never asks about a READ, however much the model has misbehaved", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ai_chat_complete_stream") {
        const nth = invoke.mock.calls.filter((c) => c[0] === "ai_chat_complete_stream").length;
        if (nth === 1) {
          return {
            blocks: [{ type: "toolUse", id: "c1", name: "madeUp", input: {} }],
            stopReason: "toolUse", model: "m",
          } as ChatResponse;
        }
        if (nth === 2) {
          return {
            blocks: [{ type: "toolUse", id: "c2", name: "read_cell_range", input: { start_row: 0, start_col: 0, end_row: 2, end_col: 0 } }],
            stopReason: "toolUse", model: "m",
          } as ChatResponse;
        }
        return textReply("Here is what I found.");
      }
      return "1,2,3";
    });
    await ask("what is in the selection?");
    expect(confirmAsync).not.toHaveBeenCalled();
    expect(runToolCalls().map((c) => c.name)).toEqual(["read_cell_range"]);
  });

  it("a well-behaved model is never second-guessed", async () => {
    // The confirmation must not become something users click through by habit.
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ai_chat_complete_stream") {
        const nth = invoke.mock.calls.filter((c) => c[0] === "ai_chat_complete_stream").length;
        if (nth === 1) {
          return {
            blocks: [{ type: "toolUse", id: "c1", name: "apply_formatting", input: { start_row: 0, start_col: 0, end_row: 2, end_col: 0, background_color: "#FFFF00" } }],
            stopReason: "toolUse", model: "m",
          } as ChatResponse;
        }
        return textReply("Done.");
      }
      return "ok";
    });
    await ask("make A1:A3 yellow");
    expect(confirmAsync).not.toHaveBeenCalled();
    expect(runToolCalls().map((c) => c.name)).toEqual(["apply_formatting"]);
  });
});

describe("the chat offers the guided path instead of guessing", () => {
  // The bridge. Asked for "a script that formats each selected cell by its
  // content", the model reached for `apply_formatting` — which takes ONE range
  // and ONE set of properties and cannot express a per-cell colour at all.
  // There is no correct choice among the non-script tools, so the chat says so.

  function offerButton(): HTMLButtonElement | undefined {
    return [...container.querySelectorAll("button")]
      .find((b) => b.textContent?.includes("Write it as a script")) as HTMLButtonElement | undefined;
  }

  it("offers after a message that reads like script work", async () => {
    invoke.mockImplementation(async () => textReply("Here is what I would do..."));
    await ask("create a script that colours each selected cell by its content");
    expect(container.textContent).toContain("reads like a request for a script");
    expect(offerButton(), "and it must be actionable").toBeTruthy();
  });

  it("stays silent for a plain request the tool loop handles well", async () => {
    invoke.mockImplementation(async () => textReply("Done."));
    await ask("make A1:A3 yellow");
    expect(container.textContent).not.toContain("reads like a request for a script");
    expect(offerButton()).toBeUndefined();
  });

  it("does not pre-empt the answer — it appears after the turn, not instead of it", async () => {
    invoke.mockImplementation(async () => textReply("I can do that."));
    await ask("write a macro to total the columns");
    // The model still got to answer.
    expect(container.textContent).toContain("I can do that.");
    expect(offerButton()).toBeTruthy();
  });

  it("switches to the guided screen, carrying the message across", async () => {
    invoke.mockImplementation(async () => textReply("ok"));
    await ask("create a script that colours each selected cell by its content");
    await act(async () => {
      offerButton()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    // The guided screen, prefilled with what the user already typed.
    expect(container.textContent).toContain("authoring a script");
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(ta.value).toBe("create a script that colours each selected cell by its content");
  });

  it("can be dismissed and stays dismissed", async () => {
    invoke.mockImplementation(async () => textReply("ok"));
    await ask("write a macro for this");
    const no = [...container.querySelectorAll("button")].find((b) => b.textContent === "Not now")!;
    await act(async () => {
      no.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(offerButton()).toBeUndefined();
  });

  it("reaches the guided screen directly from the header, with no offer needed", async () => {
    await render();
    const write = [...container.querySelectorAll("button")].find((b) => b.textContent === "Write a script")!;
    await act(async () => {
      write.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(container.textContent).toContain("authoring a script");
  });
});

describe("a running script job is visible from the chat", () => {
  // Reported 2026-08-24: clicking "Back to chat" mid-run left NO trace anywhere
  // that the work was still going. The job outlives the screen, so the chat has
  // to say so — and be a way back to it.
  function strip(): HTMLElement | undefined {
    return [...container.querySelectorAll("div")]
      .find((d) => d.textContent?.startsWith("Writing a script —")) as HTMLElement | undefined;
  }

  afterEach(() => __resetJobs());

  it("shows a strip naming the current phase while a job runs", async () => {
    invoke.mockImplementation(async () => textReply("ok"));
    await render();
    await act(async () => {
      startAuthorJob({ intent: "colour the cells", objectType: "button", providerId: "ollama", model: "qwen2.5:7b" });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(container.textContent).toContain("Writing a script");
  });

  it("clicking it returns to the run", async () => {
    invoke.mockImplementation(async () => textReply("ok"));
    await render();
    await act(async () => {
      startAuthorJob({ intent: "colour the cells", objectType: "button", providerId: "ollama", model: "qwen2.5:7b" });
      await new Promise((r) => setTimeout(r, 0));
    });
    const s = strip();
    expect(s, "the strip must exist to be clicked").toBeTruthy();
    await act(async () => {
      s!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(container.textContent).toContain("authoring a script");
  });

  it("shows nothing when no job has ever run", async () => {
    invoke.mockImplementation(async () => textReply("ok"));
    await render();
    expect(container.textContent).not.toContain("Writing a script");
  });
});

// ---------------------------------------------------------------------------
// T13 — what the gate computed reaches the TRANSCRIPT, not only the model
// ---------------------------------------------------------------------------

describe("the gate's verdict is shown to the person, not only to the model", () => {
  // The gate ran a preview, deduced that the draft needs the Unlocked tier and
  // listed the capabilities it declares but does not appear to use — then handed
  // all of it to the MODEL as a tool result and showed the user nothing. A draft
  // that mounts and does nothing looked exactly like one that works.

  function draftTurn(): void {
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
  }

  it("renders the tier warning in the user's own words", async () => {
    gateVerdict = {
      allow: true,
      needsUnlocked: true,
      note: " NOTE: ... Tell the user they must raise the script's access level to Unlocked.",
      userNote:
        " NOTE: this script does NOT run at the Restricted access level a draft is mounted with — " +
        "it only ran once the preview was raised to Unlocked. Raise the script's access level to " +
        "Unlocked in the Object Script Editor before mounting it, or it will do nothing.",
    };
    draftTurn();
    await ask("make me a button script");

    expect(container.textContent).toContain("does NOT run at the Restricted access level");
    expect(container.textContent).toContain("Unlocked");
    expect(container.textContent, "the model's copy is not for the user").not.toContain("Tell the user");
  });

  it("renders the ladder's notices", async () => {
    gateVerdict = {
      allow: true,
      notices: [
        {
          code: "declared-not-observed",
          message: "`net.fetch` is declared but no call requiring it was found.",
        },
      ],
    };
    draftTurn();
    await ask("make me a button script");

    expect(container.textContent).toContain("Before you mount it");
    expect(container.textContent).toContain("net.fetch");
  });

  it("does NOT file the run-target notice under 'check what it declares'", async () => {
    // Both notices arrive at the same SEVERITY, which is what made this easy to
    // get wrong: printed under one heading, "you will not be able to press Run
    // on this" reads as a complaint about the script's capability pragmas.
    gateVerdict = {
      allow: true,
      notices: [
        {
          code: "no-run-target",
          message: "Nothing in this script can be started on demand.",
        },
      ],
    };
    draftTurn();
    await ask("make me a button script");

    expect(container.textContent).toContain("you will not be able to press Run on it");
    expect(container.textContent, "wrong heading for this notice").not.toContain(
      "check what it declares",
    );
  });

  it("still sends the MODEL's copy on the tool result", async () => {
    // Both halves, not one instead of the other: the model needs the note to say
    // what the draft would do on its next turn.
    gateVerdict = {
      allow: true,
      note: " When run against a copy of the workbook it would change 3 cells (B2, B3, B4).",
      userNote: " When run against a copy of the workbook it would change 3 cells (B2, B3, B4).",
    };
    draftTurn();
    await ask("make me a button script");

    const results = sentMessages(1).flatMap((m) => m.content).filter((b) => b.type === "toolResult");
    expect(JSON.stringify(results)).toContain("would change 3 cells");
  });

  it("adds no bubble at all for a plain allow", async () => {
    draftTurn();
    await ask("make me a button script");
    expect(container.textContent).not.toContain("Before you mount it");
    expect(container.textContent).not.toContain("Restricted access level");
  });
});
