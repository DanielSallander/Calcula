//! FILENAME: app/extensions/Insights/__tests__/InsightsPane.test.tsx
// PURPOSE: What the pane shows, and — just as load-bearing — what it refuses to
//          show.
// CONTEXT: Every assertion here is a claim the feature makes out loud:
//
//          - An empty bundle is a calm ANSWER, not an error. If this ever turns
//            into a red box, a clean range starts looking like a broken pane.
//          - A capped list says it is capped.
//          - Notes are never hidden behind a disclosure control.
//          - The "why" affordance appears for a fact with provenance and does
//            NOT appear for one without. Both directions, because an affordance
//            that opens onto nothing teaches the reader to stop pressing it —
//            and that affordance is the strategy layer's whole visible payoff.
//          - "Send to chat" is absent when there is no chat, rather than present
//            and inert.
//          - With no BI connection there is NO source switch at all, not a
//            disabled "Model" tab promising something the workbook cannot do.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  hasSink: vi.fn(() => false),
  openWithPrompt: vi.fn(() => true),
  setActiveSheet: vi.fn(async () => undefined),
  navigateToRange: vi.fn(),
  showToast: vi.fn(),
  gridState: {
    current: {
      selection: { startRow: 1, startCol: 1, endRow: 9, endCol: 3, type: "cells" },
      sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" },
    } as unknown,
  },
}));

vi.mock("@api/backendCommands", () => ({
  createBackendChannel: () => ({
    set: () => undefined,
    invoke: (...args: unknown[]) => h.invoke(...args),
    bound: true,
  }),
}));
vi.mock("@api/grid", () => ({
  getGridStateSnapshot: () => h.gridState.current,
  navigateToRange: (...args: unknown[]) => h.navigateToRange(...args),
}));
vi.mock("@api/types", () => ({
  columnToLetter: (col: number) => String.fromCharCode(65 + col),
}));
vi.mock("@api/lib", () => ({
  setActiveSheet: (...args: unknown[]) => h.setActiveSheet(...(args as [])),
}));
vi.mock("@api/notifications", () => ({
  showToast: (...args: unknown[]) => h.showToast(...args),
}));
vi.mock("@api/extensions", () => ({
  ExtensionRegistry: { onSelectionChange: () => () => undefined },
}));
vi.mock("@api/chatPromptService", () => ({
  hasChatPromptSink: () => h.hasSink(),
  openChatWithPrompt: (...args: unknown[]) => h.openWithPrompt(...(args as [])),
}));

const { InsightsPane } = await import("../components/InsightsPane");
const store = await import("../lib/store");

// ============================================================================
// Fixtures
// ============================================================================

function insight(overrides: Record<string, unknown> = {}) {
  return {
    id: "i1",
    kind: "trend",
    score: 0.81,
    text: "Column B rises steadily from January to June.",
    evidence: [],
    provenance: [],
    ...overrides,
  };
}

function bundle(overrides: Record<string, unknown> = {}) {
  return {
    source: "range" as const,
    insights: [insight()],
    dropped: 0,
    markdown: "- Column B rises steadily from January to June.",
    factsJson: "{}",
    notes: [] as string[],
    ...overrides,
  } as never;
}

let container: HTMLDivElement;
let root: Root;

async function render(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(InsightsPane, {}));
  });
}

/** Put a computed bundle on screen without going through the backend. */
async function publish(b: unknown, label = "Sheet1!B2:D10"): Promise<void> {
  await act(async () => {
    const token = store.beginRun(label);
    store.completeRun(token, b as never);
  });
}

function all(testId: string): Element[] {
  return [...container.querySelectorAll(`[data-testid="${testId}"]`)];
}

function one(testId: string): Element | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

beforeEach(() => {
  h.invoke.mockReset();
  h.invoke.mockResolvedValue([]);
  h.hasSink.mockReset();
  h.hasSink.mockReturnValue(false);
  h.openWithPrompt.mockReset();
  h.openWithPrompt.mockReturnValue(true);
  h.setActiveSheet.mockReset();
  h.navigateToRange.mockReset();
  h.showToast.mockReset();
  h.gridState.current = {
    selection: { startRow: 1, startCol: 1, endRow: 9, endCol: 3, type: "cells" },
    sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" },
  };
  store.reset();
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
});

// ============================================================================
// Tests
// ============================================================================

describe("the Insights pane", () => {
  it("shows the range it would analyse, so the button is predictable", async () => {
    await render();
    expect(one("insights-target")?.textContent).toContain("Sheet1!B2:D10");
  });

  it("analyses nothing until the button is pressed", async () => {
    await render();
    expect(h.invoke).not.toHaveBeenCalledWith("insights_analyze_range", expect.anything());
  });

  it("answers an empty bundle calmly, and renders no cards", async () => {
    await render();
    await publish(bundle({ insights: [] }));

    expect(one("insights-empty")?.textContent).toBe("Nothing stands out in this range.");
    expect(all("insight-card")).toHaveLength(0);
    expect(one("insights-error")).toBeNull();
  });

  it("says how many facts the cap discarded", async () => {
    await render();
    await publish(bundle({ dropped: 7 }));

    expect(one("insights-dropped")?.textContent).toContain("and 7 more");
  });

  it("does not claim there are more when nothing was dropped", async () => {
    await render();
    await publish(bundle());

    expect(one("insights-dropped")).toBeNull();
  });

  it("renders the notes as a footnote, never hidden", async () => {
    await render();
    await publish(bundle({ notes: ["Hidden rows were excluded.", "Sampled to 10,000 points."] }));

    const notes = one("insights-notes");
    expect(notes).not.toBeNull();
    expect(notes?.textContent).toContain("Hidden rows were excluded.");
    expect(notes?.textContent).toContain("Sampled to 10,000 points.");
  });

  it("renders the notes even when there is not a single fact to show", async () => {
    await render();
    await publish(bundle({ insights: [], notes: ["The dimension could not be reached."] }));

    expect(one("insights-empty")).not.toBeNull();
    expect(one("insights-notes")?.textContent).toContain("The dimension could not be reached.");
  });

  it("offers a why affordance for a fact the strategy layer decided", async () => {
    await render();
    await publish(
      bundle({
        insights: [
          insight({
            provenance: [
              { attribute: "direction", value: "lower is better", source: "kpi:Cost per order" },
            ],
          }),
        ],
      }),
    );

    const toggle = one("insight-why-toggle") as HTMLButtonElement | null;
    expect(toggle).not.toBeNull();
    expect(one("insight-why-list")).toBeNull();

    await act(async () => {
      toggle!.click();
    });

    const why = one("insight-why-list");
    expect(why?.textContent).toContain("direction: lower is better (kpi:Cost per order)");
  });

  it("offers NO why affordance for a raw-grid fact with no provenance", async () => {
    await render();
    await publish(bundle({ insights: [insight({ provenance: [] })] }));

    expect(all("insight-card")).toHaveLength(1);
    expect(one("insight-why-toggle")).toBeNull();
    expect(one("insight-why-list")).toBeNull();
  });

  it("hides Send to chat when there is no chat to send to", async () => {
    h.hasSink.mockReturnValue(false);
    await render();
    await publish(bundle());

    expect(one("insights-copy")).not.toBeNull();
    expect(one("insights-send-to-chat")).toBeNull();
  });

  it("offers Send to chat when a chat is available", async () => {
    h.hasSink.mockReturnValue(true);
    await render();
    await publish(bundle());

    const send = one("insights-send-to-chat") as HTMLButtonElement | null;
    expect(send).not.toBeNull();

    await act(async () => {
      send!.click();
    });
    expect(h.openWithPrompt).toHaveBeenCalledTimes(1);
  });

  it("renders no source switch at all when the workbook has no model", async () => {
    await render();
    expect(one("insights-source-switch")).toBeNull();
    expect(container.textContent).not.toContain("Model");
  });

  it("renders the source switch once the workbook has a BI connection", async () => {
    h.invoke.mockResolvedValue([{ id: "conn-1", name: "Sales" }]);
    await render();
    await act(async () => {
      await store.refreshConnections();
    });

    expect(one("insights-source-switch")).not.toBeNull();
  });

  it("offers Create report sheet only on the model source", async () => {
    h.invoke.mockResolvedValue([{ id: "conn-1", name: "Sales" }]);
    await render();
    await act(async () => {
      await store.refreshConnections();
    });
    await publish(bundle({ source: "model" }), "Sales");

    expect(one("insights-create-report")).toBeNull();

    await act(async () => {
      store.setSource("model");
    });
    expect(one("insights-create-report")).not.toBeNull();
  });

  it("stamps an as-of line on a model answer and leaves a range answer bare", async () => {
    await render();
    await publish(bundle({ source: "model" }), "Sales");
    expect(one("insight-asof")).not.toBeNull();

    await publish(bundle({ source: "range" }));
    expect(one("insight-asof")).toBeNull();
  });

  it("selects the cells behind a range evidence, switching sheets first", async () => {
    await render();
    await publish(
      bundle({
        insights: [
          insight({
            evidence: [
              {
                kind: "range",
                label: "Sheet2!B2:B25",
                sheetIndex: 1,
                startRow: 1,
                startCol: 1,
                endRow: 24,
                endCol: 1,
              },
            ],
          }),
        ],
      }),
    );

    const link = one("insight-evidence-range") as HTMLButtonElement | null;
    expect(link?.textContent).toBe("Sheet2!B2:B25");

    await act(async () => {
      link!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(h.setActiveSheet).toHaveBeenCalledWith(1);
    expect(h.navigateToRange).toHaveBeenCalledWith(1, 1, 24, 1);
  });

  it("renders a query evidence as text, because there is no pivot to open", async () => {
    await render();
    await publish(
      bundle({
        source: "model",
        insights: [
          insight({
            evidence: [
              {
                kind: "query",
                label: "Revenue by Region",
                measures: ["Revenue"],
                groupBy: ["Region", "Month"],
              },
            ],
          }),
        ],
      }),
      "Sales",
    );

    expect(one("insight-evidence-range")).toBeNull();
    expect(one("insight-evidence-query")?.textContent).toBe("Revenue by Region, Month");
  });

  it("shows a refusal a reader can act on when there is nothing selected", async () => {
    h.gridState.current = null;
    await render();

    const button = one("insights-analyse") as HTMLButtonElement | null;
    expect(button?.disabled).toBe(true);

    await act(async () => {
      await store.analyzeSelection();
    });
    expect(one("insights-error")?.textContent).toContain("Select a range on the grid");
  });
});
