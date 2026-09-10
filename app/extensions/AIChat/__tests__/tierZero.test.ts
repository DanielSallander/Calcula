//! FILENAME: app/extensions/AIChat/__tests__/tierZero.test.ts
// PURPOSE: The pre-route analyses the right thing, in the right order, and
//          never blocks the chat when it cannot.
// CONTEXT: 2026-09-10. The three-rung order in tierZero.ts is the decision
//          under test: a multi-cell selection beats the model, one connection
//          beats a single cell, two connections is a question for the person.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  provider: { current: null as unknown },
}));

vi.mock("@api", () => ({
  getInsightsProvider: () => h.provider.current,
  describeBundleForModel: (bundle: { markdown: string }, label?: string | null) =>
    `FACTS for ${label ?? "?"}:\n${bundle.markdown}`,
  a1Rect: (r1: number, c1: number, r2: number, c2: number) => `R${r1}C${c1}:R${r2}C${c2}`,
  AppEvents: { SELECTION_CHANGED: "app:selection-changed" },
  onAppEvent: () => () => {},
}));

const { prepareTierZeroFacts, describeTierZero } = await import("../lib/tierZero");
const { __setSelectionForTest } = await import("../lib/selectionContext");

function bundle(markdown = "- Column B rises steadily.", count = 1) {
  return {
    source: "range",
    insights: Array.from({ length: count }, (_, i) => ({
      id: `i${i}`, kind: "trend", score: 0.5, text: "x", evidence: [], provenance: [],
    })),
    dropped: 0,
    markdown,
    factsJson: "{}",
    notes: [],
  };
}

function provider(overrides: Record<string, unknown> = {}) {
  return {
    analyzeRange: vi.fn(async () => bundle()),
    analyzeModel: vi.fn(async () => ({ ...bundle("- Revenue fell 4%.", 2), source: "model" })),
    hasModel: () => false,
    modelConnections: () => [],
    ...overrides,
  };
}

beforeEach(() => {
  h.provider.current = null;
  __setSelectionForTest(null);
});

describe("prepareTierZeroFacts", () => {
  it("returns null when no provider is registered", async () => {
    __setSelectionForTest({ sheetIndex: 0, areas: [{ startRow: 1, startCol: 1, endRow: 9, endCol: 3 }] });
    expect(await prepareTierZeroFacts()).toBeNull();
  });

  it("analyses a multi-cell selection, exactly as selected", async () => {
    const p = provider();
    h.provider.current = p;
    __setSelectionForTest({ sheetIndex: 2, areas: [{ startRow: 1, startCol: 1, endRow: 9, endCol: 3 }] });

    const found = await prepareTierZeroFacts();

    expect(p.analyzeRange).toHaveBeenCalledWith({
      sheetIndex: 2, startRow: 1, startCol: 1, endRow: 9, endCol: 3,
    });
    expect(found?.source).toBe("range");
    expect(found?.label).toBe("R1C1:R9C3 on sheet index 2");
    expect(found?.text).toContain("FACTS for R1C1:R9C3 on sheet index 2");
    expect(found?.text).toContain("- Column B rises steadily.");
    expect(found?.factCount).toBe(1);
  });

  it("prefers the selection over the model when the user pointed at something", async () => {
    const p = provider({ modelConnections: () => [{ id: "c1", name: "Sales" }] });
    h.provider.current = p;
    __setSelectionForTest({ sheetIndex: 0, areas: [{ startRow: 0, startCol: 0, endRow: 5, endCol: 1 }] });

    const found = await prepareTierZeroFacts();

    expect(p.analyzeRange).toHaveBeenCalledTimes(1);
    expect(p.analyzeModel).not.toHaveBeenCalled();
    expect(found?.source).toBe("range");
  });

  it("asks the model when there is exactly one connection and no multi-cell selection", async () => {
    const p = provider({ modelConnections: () => [{ id: "c1", name: "Sales" }] });
    h.provider.current = p;
    __setSelectionForTest({ sheetIndex: 0, areas: [{ startRow: 3, startCol: 3, endRow: 3, endCol: 3 }] });

    const found = await prepareTierZeroFacts();

    expect(p.analyzeModel).toHaveBeenCalledWith({ connectionId: "c1" });
    expect(p.analyzeRange).not.toHaveBeenCalled();
    expect(found?.source).toBe("model");
    expect(found?.label).toBe("Sales");
    expect(found?.factCount).toBe(2);
  });

  it("falls back to the block around a single cell when there is no model", async () => {
    const p = provider();
    h.provider.current = p;
    __setSelectionForTest({ sheetIndex: 1, areas: [{ startRow: 3, startCol: 3, endRow: 3, endCol: 3 }] });

    const found = await prepareTierZeroFacts();

    expect(p.analyzeRange).toHaveBeenCalledWith({
      sheetIndex: 1, startRow: 3, startCol: 3, endRow: 3, endCol: 3, expandToRegion: true,
    });
    expect(found?.label).toContain("the block around R3C3:R3C3");
  });

  it("leaves two connections to the person, and analyses the single cell's block instead", async () => {
    // Two models is a question the user has to answer; guessing one would
    // describe numbers they may not have meant.
    const p = provider({
      modelConnections: () => [{ id: "c1", name: "Sales" }, { id: "c2", name: "HR" }],
    });
    h.provider.current = p;
    __setSelectionForTest({ sheetIndex: 0, areas: [{ startRow: 0, startCol: 0, endRow: 0, endCol: 0 }] });

    const found = await prepareTierZeroFacts();

    expect(p.analyzeModel).not.toHaveBeenCalled();
    expect(found?.source).toBe("range");
  });

  it("returns null with no selection and no single model", async () => {
    h.provider.current = provider();
    expect(await prepareTierZeroFacts()).toBeNull();
  });

  it("returns null rather than throwing when the seam fails", async () => {
    h.provider.current = provider({ analyzeRange: vi.fn(async () => { throw new Error("engine busy"); }) });
    __setSelectionForTest({ sheetIndex: 0, areas: [{ startRow: 0, startCol: 0, endRow: 9, endCol: 0 }] });
    expect(await prepareTierZeroFacts()).toBeNull();
  });
});

describe("describeTierZero", () => {
  it("says what was computed, that no model was involved, and who words it", () => {
    const text = describeTierZero(
      { text: "", label: "R1C1:R9C3 on sheet index 0", source: "range", factCount: 3 },
      "qwen2.5-coder:3b",
    );
    expect(text).toContain("3 facts");
    expect(text).toContain("R1C1:R9C3");
    expect(text).toContain("no model involved");
    expect(text).toContain("qwen2.5-coder:3b");
  });

  it("names the model connection as a model, and counts one fact in the singular", () => {
    const text = describeTierZero({ text: "", label: "Sales", source: "model", factCount: 1 }, "m");
    expect(text).toContain('the model "Sales"');
    expect(text).toContain("1 fact ");
  });
});
