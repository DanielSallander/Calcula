//! FILENAME: app/extensions/_shared/dsl/pivotLayout/__tests__/designQueryBlade.test.tsx
// PURPOSE: The AI conversation sits BESIDE the query when a host asks for it,
//          and above it when one does not.
// CONTEXT: The 560px Reports dialog stacked a transcript over a 180px editor and
//          clipped the side-by-side diff mid-line, which reads as "the change is
//          smaller than it is". The blade is the fix, and it is a decision the
//          HOST makes: the pivot's Design tab is a narrow task pane where two
//          columns cannot fit, so `inline` has to stay the default and has to
//          keep working.
//
//          WHAT THIS CAN AND CANNOT CHECK. jsdom does no layout — every element
//          is 0x0 and `flex-wrap` never actually wraps — so a test here cannot
//          prove the columns sit side by side on screen. What it CAN prove is
//          the structure that makes them: which container each child is in, that
//          both columns are flex-basis'd so the wrap is possible at all, and
//          that the panel switches from its remembered height to filling the
//          column. The visual half belongs to a live check.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({ provider: { current: null as unknown } }));

vi.mock("@api", () => ({
  getAiCompletionProvider: () => h.provider.current,
  hasAiCompletionProvider: () => h.provider.current !== null,
}));

vi.mock("@monaco-editor/react", () => ({
  default: () => null,
  DiffEditor: () => null,
  loader: { init: () => Promise.resolve({}), config: () => undefined },
}));

const { DesignQueryEditor } = await import("../DesignQueryEditor");

const model = {
  connectionId: "c1",
  tables: [{ name: "Product", columns: [{ name: "Category", dataType: "String", isNumeric: false }] }],
  measures: [{ name: "Revenue", table: "Sales", sourceColumn: "", aggregation: "sum" as const }],
};

function provider() {
  return {
    isConfigured: () => true,
    modelLabel: () => "fake-model",
    isLocal: () => true,
    honorsSchema: () => true,
    honorsGrammar: () => false,
    listModels: async () => [],
    selectedModelKey: () => "",
    selectModel: vi.fn(),
    openModelPicker: vi.fn(),
    complete: vi.fn(),
  };
}

let container: HTMLDivElement;
let root: Root;

async function render(placement?: "inline" | "blade"): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(DesignQueryEditor, {
        value: "ROWS: Product.Category",
        onChange: vi.fn(),
        biModel: model as never,
        assist: { connectionId: "c1" },
        ...(placement ? { assistPlacement: placement } : {}),
      }),
    );
  });
}

const panel = () => container.querySelector("[data-testid='describe-query-row']");
const blade = () => container.querySelector("[data-testid='design-query-blade']");
const layout = () => container.querySelector("[data-testid='design-query-blade-layout']");

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  h.provider.current = provider();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("the design-query blade", () => {
  it("stacks the conversation above the editor by default", async () => {
    // The pivot's Design tab and the chart data tab both take this path, and a
    // two-column layout in a 240px task pane would leave neither column usable.
    await render();
    expect(layout()).toBeNull();
    expect(panel()).not.toBeNull();
  });

  it("puts the conversation in its own column when the host asks", async () => {
    await render("blade");
    expect(layout()).not.toBeNull();
    // The panel is INSIDE the blade column, not merely somewhere on the page —
    // the difference between a blade and a stacked panel with extra divs.
    expect(blade()?.contains(panel()!)).toBe(true);
  });

  it("keeps the editor out of the blade column", async () => {
    // If the editor ended up in the same column the layout would be a stack
    // wearing a blade's markup, and the diff would be as narrow as before.
    await render("blade");
    const editorBox = container.querySelector("[data-testid='design-query-blade-layout'] > div");
    expect(editorBox).not.toBeNull();
    expect(blade()?.contains(editorBox!)).toBe(false);
  });

  it("gives both columns a flex basis, which is what lets them wrap unaided", async () => {
    // The responsive half. Both columns are `flex: 1 1 <basis>` so a container
    // too narrow for both drops to one column with no media query, no
    // ResizeObserver (jsdom has none) and no measurement pass. A column with a
    // fixed width instead would overflow rather than wrap.
    await render("blade");
    const columns = [...layout()!.children] as HTMLElement[];
    expect(columns).toHaveLength(2);
    for (const col of columns) {
      expect(col.style.flex).toMatch(/^1 1 \d+px$/);
      // Without this a flex child refuses to shrink below its content and the
      // Monaco box pushes the column wider than its share.
      expect(col.style.minWidth).toBe("0px");
    }
    expect(layout()!.style.flexWrap).toBe("wrap");
  });

  it("switches the panel from its remembered height to filling the column", async () => {
    // Dragging a transcript height inside a column the dialog already sized
    // would fight the dialog, so in a blade the panel grows with the window
    // instead — which is the entire reason to want one.
    await render("blade");
    expect(panel()?.getAttribute("data-fill")).toBe("true");
    await render();
    expect(panel()?.getAttribute("data-fill")).toBeNull();
  });
});
