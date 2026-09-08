//! FILENAME: app/extensions/FormulaAssist/__tests__/FormulaAssistPopover.test.tsx
// PURPOSE: Prove the five states each render what they promise, and — the one
//          that actually matters — that NOTHING writes a cell before a click.
// CONTEXT: The badge is the product's whole claim. "Verified by Calcula's
//          engine" on a formula the engine did not verify would be worse than
//          having no assistant at all, so the badge, the value preview and the
//          absence of a preview on a declined answer are each asserted against
//          the rendered DOM rather than against the store.
//
//          Mocked: @api (the facade), and the insert module — the latter so a
//          test can assert it was NOT called, which is the only way to prove a
//          negative about writing. The store, the popover's own markup and
//          `useDialogWindow` all run for real.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const insertProposalMock = vi.fn();
const dispatchGridActionMock = vi.fn();
const startEditingMock = vi.fn((cell: unknown) => ({ type: "START_EDITING", cell }));
let configuredModel: string | null = "qwen2.5-coder:1.5b";

vi.mock("@api", () => ({
  columnToLetter: (col: number) => String.fromCharCode(65 + col),
  dispatchGridAction: (...args: unknown[]) => dispatchGridActionMock(...args),
  startEditing: (cell: unknown) => startEditingMock(cell),
  getAiCompletionProvider: () =>
    configuredModel === null
      ? null
      : {
          isConfigured: () => true,
          modelLabel: () => configuredModel,
          isLocal: () => true,
          honorsSchema: () => true,
          complete: async () => {
            throw new Error("the popover must not call the model directly");
          },
        },
  getAllFunctions: async () => ({ functions: [] }),
  getFormulaEvalPlan: async () => {
    throw new Error("not used here");
  },
}));

vi.mock("@api/grid", () => ({
  getGridStateSnapshot: () => ({
    selection: { startRow: 5, startCol: 2, endRow: 5, endCol: 2, type: "cells" },
    sheetContext: { activeSheetIndex: 0, activeSheetName: "Sales" },
  }),
  rowHeaderGutter: () => 22,
  colHeaderGutter: () => 20,
}));

vi.mock("../lib/insert", () => ({
  insertProposal: (...args: unknown[]) => insertProposalMock(...args),
}));

import type { FormulaProposal } from "@api/formulaAssistService";
import { FormulaAssistPopover } from "../components/FormulaAssistPopover";
import { openAssist, resetAssistStore, setAssistState } from "../lib/store";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

const TARGET = {
  sheetIndex: 0,
  row: 5,
  col: 2,
  a1: "C6",
  existingFormula: null as string | null,
};

function proposal(overrides: Partial<FormulaProposal> = {}): FormulaProposal {
  return {
    status: "verified",
    formulaInvariant: "=SUM(B2:B6)",
    formulaLocalized: "=SUMMA(B2:B6)",
    explanation: "Adds up the Amount column.",
    assumptions: [],
    fillDown: false,
    verification: {
      verified: true,
      display: "500",
      fillDownDisplays: [],
      findings: [],
    },
    target: { sheetIndex: 0, row: 5, col: 2, a1: "C6" },
    rounds: 1,
    model: "qwen2.5-coder:1.5b",
    summary: "Verified by Calcula's engine on C6.",
    ...overrides,
  };
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(<FormulaAssistPopover onClose={() => {}} />);
  });
}

function text(): string {
  return container.textContent ?? "";
}

function buttonLabelled(label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label,
  );
  if (!match) throw new Error(`no button labelled "${label}"`);
  return match as HTMLButtonElement;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  configuredModel = "qwen2.5-coder:1.5b";
  insertProposalMock.mockReset();
  insertProposalMock.mockResolvedValue({
    a1: "C6",
    cellsWritten: 1,
    selectionMoved: false,
    fillDownEmpty: false,
  });
  dispatchGridActionMock.mockReset();
  startEditingMock.mockClear();
  resetAssistStore();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetAssistStore();
});

// ---------------------------------------------------------------------------

describe("the popover renders nothing until it is opened", () => {
  it("is empty while the store is closed", async () => {
    await render();
    expect(container.innerHTML).toBe("");
  });
});

describe("no model configured", () => {
  it("names where to turn one on instead of disabling a control silently", async () => {
    configuredModel = null;
    openAssist({ target: TARGET, anchor: null });
    await render();

    expect(text()).toContain("No AI model is selected");
    expect(text()).toContain("AI Chat");
    expect(text()).toContain("Explain and Verify work without one");
  });

  it("disables Ask, because there is nothing to ask", async () => {
    configuredModel = null;
    openAssist({ target: TARGET, anchor: null, intent: "sum the column" });
    await render();

    expect(buttonLabelled("Ask").disabled).toBe(true);
  });
});

describe("running", () => {
  it("shows the live phase line, because silence reads as a hang", async () => {
    openAssist({ target: TARGET, anchor: null, intent: "sum it" });
    setAssistState({ running: true, phase: "Asking qwen2.5-coder:1.5b again (try 2)…" });
    await render();

    const status = container.querySelector("[role='status']");
    expect(status?.textContent).toContain("Asking qwen2.5-coder:1.5b again (try 2)");
  });
});

describe("verified", () => {
  beforeEach(() => {
    openAssist({ target: TARGET, anchor: null, intent: "sum the Amount column" });
    setAssistState({ proposal: proposal() });
  });

  it("shows the badge, the localized formula and the computed value", async () => {
    await render();

    expect(text()).toContain("Verified by Calcula's engine");
    // The LOCALIZED form is what the user sees and what gets typed into a cell.
    expect(text()).toContain("=SUMMA(B2:B6)");
    expect(text()).toContain("would show");
    expect(text()).toContain("500");
  });

  it("writes nothing until Insert is clicked", async () => {
    await render();
    expect(insertProposalMock).not.toHaveBeenCalled();

    await click(buttonLabelled("Insert"));
    expect(insertProposalMock).toHaveBeenCalledTimes(1);
    expect(insertProposalMock.mock.calls[0][0].formulaLocalized).toBe("=SUMMA(B2:B6)");
  });

  it("asks for a fill-down only when the fill-down button is the one clicked", async () => {
    await render();

    await click(buttonLabelled("Insert and fill down"));
    expect(insertProposalMock.mock.calls[0][0].fillDown).toBe(true);
  });

  it("puts the formula in the editor on Edit without committing it", async () => {
    await render();

    await click(buttonLabelled("Edit"));
    expect(insertProposalMock).not.toHaveBeenCalled();
    expect(startEditingMock).toHaveBeenCalledTimes(1);
    expect(startEditingMock.mock.calls[0][0]).toMatchObject({
      row: 5,
      col: 2,
      value: "=SUMMA(B2:B6)",
    });
  });

  it("writes nothing on Discard", async () => {
    await render();

    await click(buttonLabelled("Discard"));
    expect(insertProposalMock).not.toHaveBeenCalled();
    expect(container.innerHTML).toBe("");
  });

  it("says which cell was written after an insert", async () => {
    await render();
    await click(buttonLabelled("Insert"));

    expect(text()).toContain("Written to C6");
  });

  it("says so when the selection had moved away before the click", async () => {
    insertProposalMock.mockResolvedValue({
      a1: "C6",
      cellsWritten: 1,
      selectionMoved: true,
      fillDownEmpty: false,
    });
    await render();
    await click(buttonLabelled("Insert"));

    expect(text()).toContain("the formula went to the cell you asked about");
  });
});

describe("a fill-down preview", () => {
  it("shows the first three filled rows with their addresses", async () => {
    openAssist({ target: TARGET, anchor: null, intent: "commission per row" });
    setAssistState({
      proposal: proposal({
        fillDown: true,
        verification: {
          verified: true,
          display: "25",
          fillDownDisplays: ["50", "75", "100"],
          findings: [],
        },
      }),
    });
    await render();

    expect(text()).toContain("C7 = 50");
    expect(text()).toContain("C8 = 75");
    expect(text()).toContain("C9 = 100");
  });

  it("reports the spill shape when the formula spills", async () => {
    openAssist({ target: TARGET, anchor: null, intent: "unique regions" });
    setAssistState({
      proposal: proposal({
        verification: {
          verified: true,
          display: "North",
          fillDownDisplays: [],
          findings: [],
          spill: [4, 2],
        },
      }),
    });
    await render();

    expect(text()).toContain("Spills over 4 rows × 2 columns");
  });
});

describe("unverified", () => {
  it("withholds the badge and shows the findings", async () => {
    openAssist({ target: TARGET, anchor: null, intent: "sum it" });
    setAssistState({
      proposal: proposal({
        status: "unverified",
        summary: "Calcula could not verify this formula: B2:B99 reaches past the data.",
        verification: {
          verified: false,
          display: "",
          fillDownDisplays: [],
          findings: ["B2:B99 reaches past the data. Use B2:B6."],
        },
      }),
    });
    await render();

    expect(text()).not.toContain("Verified by Calcula's engine");
    expect(text()).toContain("Not verified");
    expect(text()).toContain("B2:B99 reaches past the data. Use B2:B6.");
  });

  it("still lets the user insert it, because an unchecked guess is theirs to take", async () => {
    openAssist({ target: TARGET, anchor: null, intent: "sum it" });
    setAssistState({
      proposal: proposal({
        status: "unverified",
        verification: { verified: false, display: "", fillDownDisplays: [], findings: [] },
      }),
    });
    await render();

    expect(buttonLabelled("Insert").disabled).toBe(false);
  });
});

describe("declined", () => {
  beforeEach(() => {
    openAssist({ target: TARGET, anchor: null, intent: "sum it" });
    setAssistState({
      proposal: proposal({
        status: "declined",
        formulaInvariant: "",
        formulaLocalized: "",
        summary: "The model's reply contained no formula.",
        verification: {
          verified: false,
          display: "",
          fillDownDisplays: [],
          findings: [],
          declineReason: "The model's reply contained no formula.",
        },
      }),
    });
  });

  it("shows the reason", async () => {
    await render();
    expect(text()).toContain("The model's reply contained no formula.");
  });

  it("shows NO formula preview — a preview would imply something was checked", async () => {
    await render();
    expect(container.querySelectorAll("*").length).toBeGreaterThan(0);
    expect(text()).not.toContain("=SUMMA");
    expect(text()).not.toContain("would show");
  });

  it("cannot be inserted", async () => {
    await render();
    expect(buttonLabelled("Insert").disabled).toBe(true);
    expect(buttonLabelled("Insert and fill down").disabled).toBe(true);
  });
});

describe("the cell the request is bound to", () => {
  it("names the captured cell in the title, not the current selection", async () => {
    openAssist({
      target: { ...TARGET, row: 9, col: 4, a1: "E10" },
      anchor: null,
    });
    await render();

    expect(text()).toContain("Formula for E10");
    // The mocked snapshot still says C6 is selected, so the popover must say
    // so rather than silently retargeting.
    expect(text()).toContain("The selection has moved");
  });
});
