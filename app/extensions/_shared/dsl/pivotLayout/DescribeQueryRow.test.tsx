//! FILENAME: app/extensions/_shared/dsl/pivotLayout/DescribeQueryRow.test.tsx
// PURPOSE: The "describe the report in words" row's WIRING: when it renders,
//          what it hands the loop, and what it does with each kind of answer.
// CONTEXT: The loop's decisions are proved in draft.test.ts; this file pins
//          the three rules the component keeps — nothing is created by a
//          draft, the green sentence is earned, and a declined reply puts
//          nothing anywhere.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  provider: { current: null as unknown },
  draft: vi.fn(),
}));

vi.mock("@api", () => ({
  getAiCompletionProvider: () => h.provider.current,
  hasAiCompletionProvider: () => h.provider.current !== null,
}));

vi.mock("./draft", () => ({
  draftDesignQuery: (...a: unknown[]) => h.draft(...a),
}));

const { DescribeQueryRow } = await import("./DescribeQueryRow");

const model = {
  connectionId: "c1",
  tables: [{ name: "Product", columns: [{ name: "Category", dataType: "String", isNumeric: false }] }],
  measures: [{ name: "Revenue", table: "Sales", sourceColumn: "", aggregation: "sum" as const }],
};

function configured(label = "qwen2.5-coder:1.5b", isConfigured = true) {
  return {
    isConfigured: () => isConfigured,
    modelLabel: () => label,
    isLocal: () => true,
    honorsSchema: () => true,
    honorsGrammar: () => false,
    complete: vi.fn(),
  };
}

let container: HTMLDivElement;
let root: Root;
const onDraft = vi.fn();
const dryRun = vi.fn(async () => ({ rowCount: 3, colCount: 2 }));

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(DescribeQueryRow, {
        biModel: model as never,
        host: { connectionId: "c1", dryRun },
        onDraft,
      }),
    );
  });
}

async function describeAndDraft(text: string): Promise<void> {
  const input = container.querySelector("input")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === "Draft")!;
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  h.draft.mockReset();
  onDraft.mockReset();
  dryRun.mockClear();
  h.provider.current = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("DescribeQueryRow", () => {
  it("renders nothing when no AI provider is registered at all", async () => {
    await render();
    expect(container.querySelector("[data-testid='describe-query-row']")).toBeNull();
  });

  it("explains itself when a provider exists but no model is picked, and drafts nothing", async () => {
    h.provider.current = configured("", false);
    await render();
    await describeAndDraft("revenue by category");
    expect(container.textContent).toContain("No AI model is selected");
    expect(h.draft).not.toHaveBeenCalled();
    expect(onDraft).not.toHaveBeenCalled();
  });

  it("hands the loop the intent, the model, a bound compiler and the host's dry run, then puts the query in the editor", async () => {
    h.provider.current = configured();
    h.draft.mockResolvedValue({
      status: "compiled", dsl: "ROWS: Product.Category\nVALUES: [Revenue]", explanation: "Revenue by category.",
      errors: [], warnings: [], request: {}, dryRun: { rowCount: 3, colCount: 2 }, rounds: 1,
      model: "qwen2.5-coder:1.5b", summary: "Compiled by Calcula. Ran on the model: 3 rows × 2 columns.",
      candidates: {}, grammarUsed: false,
    });
    await render();
    await describeAndDraft("revenue by category");

    expect(h.draft).toHaveBeenCalledTimes(1);
    const [intent, passedModel, deps] = h.draft.mock.calls[0] as [string, unknown, { compile: unknown; dryRun: unknown; provider: unknown }];
    expect(intent).toBe("revenue by category");
    expect(passedModel).toBe(model);
    expect(typeof deps.compile).toBe("function");
    expect(deps.dryRun).toBe(dryRun);
    expect(deps.provider).toBe(h.provider.current);

    expect(onDraft).toHaveBeenCalledWith("ROWS: Product.Category\nVALUES: [Revenue]");
    const result = container.querySelector("[data-testid='describe-query-result-compiled']");
    expect(result?.textContent).toContain("Compiled by Calcula");
    expect(result?.textContent).toContain("Revenue by category.");
  });

  it("puts an invalid query in the editor too, with its errors listed, and never claims it compiled", async () => {
    h.provider.current = configured();
    h.draft.mockResolvedValue({
      status: "invalid", dsl: "ROWS: Product.Colour\nVALUES: [Revenue]", explanation: "",
      errors: [{ message: 'Unknown field "Product.Colour"', location: { line: 1, column: 0, endColumn: 5 }, severity: "error" }],
      warnings: [], request: null, dryRun: null, rounds: 2, model: "m",
      summary: "m wrote a query Calcula could not compile even after a correction.", candidates: {}, grammarUsed: false,
    });
    await render();
    await describeAndDraft("revenue by colour");

    expect(onDraft).toHaveBeenCalledWith("ROWS: Product.Colour\nVALUES: [Revenue]");
    const result = container.querySelector("[data-testid='describe-query-result-invalid']");
    expect(result?.textContent).toContain("could not compile");
    expect(result?.textContent).toContain('line 1: Unknown field "Product.Colour"');
    expect(container.querySelector("[data-testid='describe-query-result-compiled']")).toBeNull();
  });

  it("puts nothing in the editor for a declined reply", async () => {
    h.provider.current = configured();
    h.draft.mockResolvedValue({
      status: "declined", dsl: "", explanation: "", errors: [], warnings: [], request: null, dryRun: null,
      rounds: 1, model: "m", summary: "m did not answer with a query.", candidates: {}, grammarUsed: false,
    });
    await render();
    await describeAndDraft("something");
    expect(onDraft).not.toHaveBeenCalled();
    expect(container.querySelector("[data-testid='describe-query-result-declined']")?.textContent).toContain("did not answer");
  });

  it("shows a transport failure as a sentence rather than a result", async () => {
    h.provider.current = configured();
    h.draft.mockRejectedValue(new Error("Could not reach Ollama"));
    await render();
    await describeAndDraft("revenue by category");
    expect(container.querySelector("[data-testid='describe-query-failure']")?.textContent).toContain("Could not reach Ollama");
    expect(onDraft).not.toHaveBeenCalled();
  });
});
