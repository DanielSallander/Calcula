//! FILENAME: app/extensions/AIChat/__tests__/toolTimeline.test.ts
// PURPOSE: A tool call is ONE bubble that resolves. Pin the three failures the
//          append-only transcript had: two bubbles per call, an ellipsis that
//          never cleared, and a thrown tool that produced no UI at all.

import { describe, it, expect } from "vitest";
import {
  startTool, finishTool, failTool, settleRunning,
  formatToolBubble, formatMs, stateMarker, truncate, draftIdFromResult,
  type Bubble,
} from "../lib/toolTimeline";

const base: Bubble[] = [{ kind: "user", text: "sum column B" }];

describe("one call is one bubble", () => {
  it("announcing the same call twice updates rather than duplicates", () => {
    // The exact old bug: `toolCallStarted` appended, then the dispatch loop
    // appended again, and the first never resolved.
    let b = startTool(base, "call_1", "read_cell_range...");
    b = startTool(b, "call_1", "read_cell_range({\"start_row\":0})");
    const tools = b.filter((x) => x.kind === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0].text).toBe("read_cell_range({\"start_row\":0})");
    expect(tools[0].state).toBe("running");
  });

  it("two different calls stay two bubbles", () => {
    let b = startTool(base, "call_1", "list_charts");
    b = startTool(b, "call_2", "list_tables");
    expect(b.filter((x) => x.kind === "tool")).toHaveLength(2);
  });

  it("the same tool called twice in a conversation resolves the LIVE one", () => {
    let b = startTool(base, "call_1", "list_charts");
    b = finishTool(b, "call_1", { ms: 10 });
    b = startTool(b, "call_2", "list_charts");
    b = finishTool(b, "call_2", { ms: 20 });
    const tools = b.filter((x) => x.kind === "tool");
    expect(tools.map((t) => t.ms)).toEqual([10, 20]);
  });

  it("a finished call is never reopened by a late announcement", () => {
    let b = startTool(base, "call_1", "list_charts");
    b = finishTool(b, "call_1", { ms: 5 });
    b = startTool(b, "call_1", "list_charts");
    expect(b.filter((x) => x.kind === "tool")[0].state).toBe("done");
  });

  it("never mutates its input", () => {
    const before = startTool(base, "call_1", "x");
    const snapshot = JSON.parse(JSON.stringify(before));
    finishTool(before, "call_1", { ms: 1 });
    expect(before).toEqual(snapshot);
  });
});

describe("every call reaches a terminal state", () => {
  it("finishing records the duration and the result excerpt", () => {
    let b = startTool(base, "call_1", "read_cell_range");
    b = finishTool(b, "call_1", { ms: 1400, detail: "12 rows" });
    const t = b.filter((x) => x.kind === "tool")[0];
    expect(t.state).toBe("done");
    expect(formatToolBubble(t)).toBe("[OK] read_cell_range  1.4s - 12 rows");
  });

  it("a THROWN tool becomes a visible error on its own bubble", () => {
    // Previously invisible: the message went to the model and the user saw
    // nothing, so the loop could fail eight times in silence.
    let b = startTool(base, "call_1", "run_script");
    b = failTool(b, "call_1", "Script Security refused execution.", 30);
    const t = b.filter((x) => x.kind === "tool")[0];
    expect(t.state).toBe("error");
    expect(formatToolBubble(t)).toContain("[!] run_script");
    expect(formatToolBubble(t)).toContain("Script Security refused execution.");
  });

  it("a call dispatched without ever being announced still appears", () => {
    // The salvage case: no `toolCallStarted` arrives, because the model never
    // emitted a native call.
    const b = finishTool(base, "salv-0-0", { text: "apply_formatting", ms: 8 });
    const t = b.filter((x) => x.kind === "tool")[0];
    expect(t.text).toBe("apply_formatting");
    expect(t.state).toBe("done");
  });

  it("settleRunning clears an orphan left by a turn that threw", () => {
    // Without this a `[..]` stays on screen for the rest of the session,
    // permanently claiming something is still happening.
    let b = startTool(base, "call_1", "list_charts");
    b = startTool(b, "call_2", "list_tables");
    b = finishTool(b, "call_2", { ms: 3 });
    b = settleRunning(b, "The turn failed before this call ran.");
    const states = b.filter((x) => x.kind === "tool").map((t) => t.state);
    expect(states).toEqual(["error", "done"]);
  });

  it("settleRunning is a no-op when nothing is running", () => {
    const b = finishTool(startTool(base, "c", "x"), "c", { ms: 1 });
    expect(settleRunning(b, "msg")).toEqual(b);
  });
});

describe("formatting", () => {
  it("uses ASCII markers only", () => {
    // CLAUDE.md bans Unicode in this kind of output.
    for (const m of [stateMarker("running"), stateMarker("done"), stateMarker("error")]) {
      expect(m).toMatch(/^[\x20-\x7E]+$/);
    }
    expect(stateMarker(undefined)).toBe("");
  });

  it("renders durations at a readable scale", () => {
    expect(formatMs(320)).toBe("320ms");
    expect(formatMs(1400)).toBe("1.4s");
    expect(formatMs(undefined)).toBe("");
    expect(formatMs(-1)).toBe("");
  });

  it("collapses a multi-line tool result to one capped line", () => {
    const long = "line one\nline two\n" + "x".repeat(500);
    const out = truncate(long, 60);
    expect(out).toHaveLength(60);
    expect(out).not.toContain("\n");
    expect(out.endsWith("...")).toBe(true);
  });

  it("keeps a short result whole", () => {
    expect(truncate("12 rows", 60)).toBe("12 rows");
  });
});

describe("draftIdFromResult", () => {
  it("reads the id out of the backend's own result sentence", () => {
    // The exact string mcp/drafts.rs builds.
    const result =
      'Drafted object script "Paint by value" (id=draft-8f2ab1c94d5e4f0) for button.\n' +
      "Declared capabilities: none (grid-only).";
    expect(draftIdFromResult(result)).toBe("draft-8f2ab1c94d5e4f0");
  });

  it("returns null rather than guessing", () => {
    expect(draftIdFromResult("queued for review")).toBeNull();
    expect(draftIdFromResult("(id=not-a-draft)")).toBeNull();
  });
});
