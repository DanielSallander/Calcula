//! FILENAME: app/extensions/Insights/__tests__/chatHandoff.test.ts
// PURPOSE: The prompt handed to the chat carries the facts, the caveats and the
//          cap — and forbids the one thing the facts never claim.
// CONTEXT: The handoff is where a checkable answer meets an unchecked narrator,
//          so the three things it must not lose are each pinned here:
//
//          - the notes, because "sampled" and "hidden rows excluded" are what
//            make the numbers honest;
//          - the `dropped` count, because a capped list presented as complete is
//            a false picture nobody can spot;
//          - the ban on causes, because every Rust sentence is careful not to
//            claim one and a single "because" undoes that.
//
//          It also proves the control is a PREFILL: `autoSend` is never set.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  hasSink: vi.fn(() => false),
  openWithPrompt: vi.fn(() => false),
}));

vi.mock("@api/chatPromptService", () => ({
  hasChatPromptSink: () => h.hasSink(),
  openChatWithPrompt: (...args: unknown[]) => h.openWithPrompt(...(args as [])),
}));

const { buildChatPrompt, canSendToChat, sendBundleToChat } = await import("../lib/chatHandoff");

function bundle(overrides: Record<string, unknown> = {}) {
  return {
    source: "range" as const,
    insights: [],
    dropped: 0,
    markdown: "- Column B rises steadily from January to June.",
    factsJson: "{}",
    notes: [] as string[],
    ...overrides,
  };
}

beforeEach(() => {
  h.hasSink.mockReset();
  h.hasSink.mockReturnValue(false);
  h.openWithPrompt.mockReset();
  h.openWithPrompt.mockReturnValue(false);
});

describe("the chat prompt", () => {
  it("carries the bundle's markdown verbatim", () => {
    const text = buildChatPrompt(bundle(), "Sheet1!B2:B40");
    expect(text).toContain("- Column B rises steadily from January to June.");
  });

  it("names what the facts describe", () => {
    const text = buildChatPrompt(bundle(), "Sheet1!B2:B40");
    expect(text).toContain("Sheet1!B2:B40");
  });

  it("says the facts are deterministic, not a model's impression", () => {
    const text = buildChatPrompt(bundle(), null);
    expect(text).toContain("deterministic");
  });

  it("forbids the narrator from suggesting a cause", () => {
    const text = buildChatPrompt(bundle(), null);
    expect(text).toContain("Do not suggest a cause");
  });

  it("repeats every note as a stated limit", () => {
    const text = buildChatPrompt(
      bundle({ notes: ["Hidden rows were excluded.", "Sampled to 10,000 points."] }),
      null,
    );
    expect(text).toContain("Stated limits");
    expect(text).toContain("Hidden rows were excluded.");
    expect(text).toContain("Sampled to 10,000 points.");
  });

  it("omits the limits block entirely when the bundle has no notes", () => {
    expect(buildChatPrompt(bundle(), null)).not.toContain("Stated limits");
  });

  it("warns that a capped list is not the complete picture", () => {
    const text = buildChatPrompt(bundle({ dropped: 7 }), null);
    expect(text).toContain("7 further facts were ranked below the cut");
    expect(text).toContain("complete picture");
  });

  it("says nothing about a cap when nothing was dropped", () => {
    expect(buildChatPrompt(bundle(), null)).not.toContain("below the cut");
  });
});

describe("handing the bundle over", () => {
  it("reports no chat when there is no sink", () => {
    h.hasSink.mockReturnValue(false);
    expect(canSendToChat()).toBe(false);
  });

  it("reports a chat when a sink is available", () => {
    h.hasSink.mockReturnValue(true);
    expect(canSendToChat()).toBe(true);
  });

  it("returns false, and raises nothing, when there was no chat to hand it to", () => {
    h.openWithPrompt.mockReturnValue(false);
    expect(sendBundleToChat(bundle(), "Sheet1!B2:B40")).toBe(false);
  });

  it("prefills the composer and never asks the chat to send on its own", () => {
    h.openWithPrompt.mockReturnValue(true);
    expect(sendBundleToChat(bundle(), "Sheet1!B2:B40")).toBe(true);

    expect(h.openWithPrompt).toHaveBeenCalledTimes(1);
    const [text, options] = h.openWithPrompt.mock.calls[0] as unknown as [string, unknown];
    expect(text).toContain("- Column B rises steadily from January to June.");
    expect(options).toBeUndefined();
  });
});
