//! FILENAME: app/extensions/_shared/dsl/pivotLayout/describeQuery/__tests__/DescribeQueryPanel.test.tsx
// PURPOSE: The panel's WIRING: what it hands the drafting loop, what it does
//          with each kind of answer, and the two gestures that used to escape it.
// CONTEXT: The turn model's decisions are proved in turns.test.ts. This file
//          pins what only a render can reach — that a draft over EXISTING text
//          waits for a click, that a draft into an EMPTY editor does not, that a
//          follow-up carries the previous query, and that Enter and Escape do
//          not reach the dialog wrapped around this panel.

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

vi.mock("../../draft", () => ({
  draftDesignQuery: (...a: unknown[]) => h.draft(...a),
}));

// Monaco's diff editor needs a real DOM measurement pass jsdom does not do.
// The double keeps the panes readable so a test can assert what is compared.
vi.mock("@monaco-editor/react", () => ({
  DiffEditor: ({ original, modified }: { original?: string; modified?: string }) =>
    React.createElement("div", { "data-testid": "diff" }, `${original}>>>${modified}`),
  default: () => null,
  // `pivotDslLanguage` (imported for the diff's language id) reaches for the
  // loader at module scope; a mock missing it throws at IMPORT, before any test
  // body runs, which reads as the component being broken.
  loader: { init: () => Promise.resolve({}), config: () => undefined },
}));

const { DescribeQueryPanel } = await import("../DescribeQueryPanel");

const model = {
  connectionId: "c1",
  tables: [{ name: "Product", columns: [{ name: "Category", dataType: "String", isNumeric: false }] }],
  measures: [{ name: "Revenue", table: "Sales", sourceColumn: "", aggregation: "sum" as const }],
};

function provider(over: Record<string, unknown> = {}) {
  return {
    isConfigured: () => true,
    modelLabel: () => "qwen2.5-coder:1.5b",
    isLocal: () => true,
    honorsSchema: () => true,
    honorsGrammar: () => false,
    listModels: async () => [],
    selectedModelKey: () => "",
    selectModel: vi.fn(),
    openModelPicker: vi.fn(),
    complete: vi.fn(),
    ...over,
  };
}

function compiledDraft(dsl: string) {
  return {
    status: "compiled",
    dsl,
    explanation: "",
    errors: [],
    warnings: [],
    request: null,
    dryRun: null,
    rounds: 1,
    model: "qwen2.5-coder:1.5b",
    summary: "Compiled by Calcula.",
    candidates: {},
    grammarUsed: false,
  };
}

let container: HTMLDivElement;
let root: Root;
const onApply = vi.fn();

async function render(currentDsl: string): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(DescribeQueryPanel, {
        biModel: model as never,
        host: { connectionId: "c1" },
        currentDsl,
        onApply,
      }),
    );
  });
}

function textarea(): HTMLTextAreaElement {
  const el = container.querySelector("textarea");
  if (!el) throw new Error("composer not rendered");
  return el as HTMLTextAreaElement;
}

async function ask(text: string): Promise<void> {
  const el = textarea();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    container
      .querySelector<HTMLButtonElement>('[data-testid="describe-query-draft"]')
      ?.click();
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  h.provider.current = provider();
  h.draft.mockReset();
  onApply.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("DescribeQueryPanel", () => {
  it("renders nothing at all when no AI provider is registered", async () => {
    // Not a disabled control: the AI Chat extension may simply not be loaded,
    // and an affordance that can never work is worse than no affordance.
    h.provider.current = null;
    await render("");
    expect(container.querySelector('[data-testid="describe-query-row"]')).toBeNull();
  });

  it("applies a first draft straight into an EMPTY editor", async () => {
    // The gate exists to protect existing work. There is none here, and a diff
    // against nothing is a worse way to read a query than the query.
    h.draft.mockResolvedValue(compiledDraft("ROWS: Product.Category"));
    await render("");
    await ask("revenue by category");
    expect(onApply).toHaveBeenCalledWith("ROWS: Product.Category");
    expect(container.querySelector('[data-testid="diff"]')).toBeNull();
  });

  it("does NOT overwrite existing text — it waits behind a diff", async () => {
    // THE ASK. Before this, `onDraft` replaced the editor the instant a draft
    // arrived, and a query someone had been editing was simply gone.
    h.draft.mockResolvedValue(compiledDraft("ROWS: Product.Category"));
    await render("VALUES: [Cost]");
    await ask("revenue by category");
    expect(onApply).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="diff"]')?.textContent).toBe(
      "VALUES: [Cost]>>>ROWS: Product.Category",
    );
  });

  it("applies only on the Accept click, and reports what it did", async () => {
    h.draft.mockResolvedValue(compiledDraft("ROWS: Product.Category"));
    await render("VALUES: [Cost]");
    await ask("revenue by category");
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="describe-query-accept-1"]')
        ?.click();
    });
    expect(onApply).toHaveBeenCalledWith("ROWS: Product.Category");
    expect(
      container.querySelector('[data-testid="describe-query-turn-1"]')?.getAttribute("data-disposition"),
    ).toBe("applied");
  });

  it("writes nothing when the draft is discarded", async () => {
    h.draft.mockResolvedValue(compiledDraft("ROWS: Product.Category"));
    await render("VALUES: [Cost]");
    await ask("revenue by category");
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="describe-query-reject-1"]')
        ?.click();
    });
    expect(onApply).not.toHaveBeenCalled();
  });

  it("hands a follow-up the previous query to change", async () => {
    // Owner decision 2026-09-14. Without `prior`, "make it monthly" is an
    // instruction with no object and the model invents a whole new report.
    h.draft.mockResolvedValue(compiledDraft("ROWS: Product.Category"));
    await render("");
    await ask("revenue by category");

    h.draft.mockResolvedValue(compiledDraft("ROWS: Date.Month"));
    await ask("make it monthly");

    const second = h.draft.mock.calls[1];
    expect(second[2].prior).toEqual({
      intent: "revenue by category",
      dsl: "ROWS: Product.Category",
    });
  });

  it("sends no prior on the FIRST ask", async () => {
    h.draft.mockResolvedValue(compiledDraft("ROWS: Product.Category"));
    await render("");
    await ask("revenue by category");
    expect(h.draft.mock.calls[0][2].prior).toBeUndefined();
  });

  it("keeps Enter and Escape away from the dialog around it", async () => {
    // Two of the five mounts bind Enter to their dialog's Create button and
    // Escape to closing the dialog, and NEITHER handler reads
    // `defaultPrevented` — so `preventDefault` alone never stopped them.
    // Typing a description and pressing Enter used to create the chart, and
    // Escape closed the dialog with the transcript in it.
    //
    // The ancestor handler is a REACT one, deliberately. React delegates at the
    // root container, so a NATIVE listener there runs before React has
    // processed the event at all and could never observe `stopPropagation` —
    // it would fail this test against correct code. The dialogs use React
    // `onKeyDown`, which is what this doubles.
    const ancestor = vi.fn();
    h.draft.mockResolvedValue(compiledDraft("ROWS: Product.Category"));
    await act(async () => {
      root.render(
        React.createElement(
          "div",
          { onKeyDown: ancestor },
          React.createElement(DescribeQueryPanel, {
            biModel: model as never,
            host: { connectionId: "c1" },
            currentDsl: "",
            onApply,
          }),
        ),
      );
    });

    const el = textarea();
    await act(async () => {
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    expect(ancestor).not.toHaveBeenCalled();
  });

  it("lets Shift+Enter through as a newline rather than sending", async () => {
    h.draft.mockResolvedValue(compiledDraft("ROWS: Product.Category"));
    await render("");
    const el = textarea();
    await act(async () => {
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }),
      );
    });
    expect(h.draft).not.toHaveBeenCalled();
  });

  it("records a failure as a turn instead of losing it", async () => {
    h.draft.mockRejectedValue(new Error("the runtime went away"));
    await render("");
    await ask("revenue by category");
    expect(container.querySelector('[data-testid="describe-query-failure"]')?.textContent).toContain(
      "the runtime went away",
    );
    expect(onApply).not.toHaveBeenCalled();
  });

  it("says so, and applies nothing, when the model proposes what is already there", async () => {
    // `sameDesignQuery` canonically equal → nothing to accept. An Accept button
    // here would write identical bytes and register as a change.
    h.draft.mockResolvedValue(compiledDraft("VALUES: [Cost]"));
    await render("VALUES: [Cost]");
    await ask("cost");
    expect(onApply).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="describe-query-turn-1"]')?.getAttribute("data-disposition"),
    ).toBe("noop");
    expect(container.querySelector('[data-testid="describe-query-accept-1"]')).toBeNull();
  });
});
