// FILENAME: app/extensions/ModelEditor/__tests__/tablesDisclosures.test.tsx
// PURPOSE: The Tables detail pane folds the set-once sections and gives the
//          height to the columns — and a folded section always says what it is
//          hiding.
// CONTEXT: THE SUMMARY IS THE WHOLE DESIGN. A collapsed section showing only
//          its title makes the reader open it to find out whether it matters,
//          so they open all of them and the folding bought nothing. That is why
//          `Disclosure` takes `summary` as a REQUIRED prop and why these tests
//          assert on its text rather than only on the folding.
//
//          Measured before: on a 940px window the Columns header sat 337px down
//          on an ordinary table and 607px down on an InMemory one — an InMemory
//          table spent 270px to render "No strategies." — leaving six of ten
//          column rows on screen. After: 198px and 227px, all rows visible.
//
//          THE OPEN-STATE LIVES IN THE SECTION, not in the cards. The cards
//          remount when the selected table changes, so card-local state would
//          re-open everything on every click in the master list. The test for
//          that switches tables and looks again.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { ModelOverview, ModelTableInfo } from "@api";
import { TablesSection } from "../components/sections/TablesSection";

vi.mock("@api/dialogs", () => ({
  confirmAsync: vi.fn(),
  alertAsync: vi.fn(),
  promptAsync: vi.fn(),
}));

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

function table(name: string, over: Partial<ModelTableInfo> = {}): ModelTableInfo {
  return {
    name,
    columns: [
      { name: "id", dataType: "Int64" },
      { name: "amount", dataType: "Float64" },
    ],
    displayName: null,
    description: null,
    isHidden: false,
    bound: true,
    sourceId: "src-1",
    storageMode: "DirectQuery",
    refreshStrategies: [],
    incrementalRefresh: null,
    transformSteps: [],
    transformScript: "",
    sourceColumns: [],
    ...over,
  } as unknown as ModelTableInfo;
}

function overview(tables: ModelTableInfo[]): ModelOverview {
  return {
    editable: true,
    readOnlyReason: null,
    tables,
    relationships: [],
    hierarchies: [],
    kpis: [],
    securityRoles: [],
    perspectives: [],
    cultures: [],
    calculationGroups: [],
    measures: [],
    contexts: [],
    contextColumns: [],
    tableVariables: [],
    globalVariables: [],
    scriptFunctions: [],
    dateTable: null,
    defaultLookupResolution: null,
    modelName: "Test",
    modelVersion: null,
    modelAuthor: null,
    modelDescription: null,
    sources: [],
    writebackColumns: [],
  } as unknown as ModelOverview;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function mount(tables: ModelTableInfo[]): Promise<void> {
  const ctx = {
    connectionId: "conn-1",
    overview: overview(tables),
    readOnly: false,
    applyOverview: vi.fn(),
    applyMeasures: vi.fn(),
    reportError: vi.fn(),
    navigate: vi.fn(),
    runCommand: vi.fn().mockResolvedValue([]),
  };
  await act(async () => {
    root.render(<TablesSection ctx={ctx as never} />);
  });
}

const disclosure = (id: string): HTMLButtonElement | null =>
  container.querySelector(`[data-testid="disclosure-${id}"]`);
const summary = (id: string): string | null =>
  container.querySelector(`[data-testid="disclosure-summary-${id}"]`)?.textContent ?? null;
const click = async (el: Element): Promise<void> => {
  await act(async () => {
    (el as HTMLElement).click();
  });
};

describe("the Tables detail pane folds what is set once", () => {
  it("starts with every section CLOSED", async () => {
    await mount([table("Sales")]);
    expect(disclosure("table-settings")?.getAttribute("aria-expanded")).toBe("false");
    expect(disclosure("transforms")?.getAttribute("aria-expanded")).toBe("false");
    // The columns grid is what the pane is for, and it is not behind anything.
    expect(container.textContent).toContain("Columns (2)");
  });

  it("says what each folded section is hiding", async () => {
    await mount([table("Sales")]);
    // Not "Settings" alone: the reader must be able to decide whether to open
    // it WITHOUT opening it.
    expect(summary("table-settings")).toBe("not renamed");
    expect(summary("transforms")).toBe("No steps — the table loads as the source returns it");
  });

  it("states a FACT rather than an absence", async () => {
    // "no display name" was the first wording and reads as a warning about
    // something missing, when a table carrying its own name is the ordinary
    // case.
    await mount([table("Sales")]);
    expect(summary("table-settings")).not.toContain("no ");

    await mount([table("Sales", { displayName: "Sales facts", isHidden: true, description: "x" })]);
    expect(summary("table-settings")).toBe('shown as "Sales facts" · described · hidden');
  });

  it("shows the Refresh section only for an InMemory table, and says what NO strategies means", async () => {
    // A DirectQuery table has no cache to refresh, so the section would be a
    // row that cannot apply.
    await mount([table("Sales")]);
    expect(disclosure("refresh"), "DirectQuery has no refresh section").toBeNull();

    await mount([table("Sales", { storageMode: "InMemory" })]);
    expect(disclosure("refresh")).not.toBeNull();
    // The expanded card never said this: a reader had to already know that no
    // strategy implies cache-once to read an empty list as a decision.
    expect(summary("refresh")).toBe("No strategies — cached once, refreshed manually");
  });

  it("counts strategies and the incremental filter in the summary", async () => {
    await mount([
      table("Sales", {
        storageMode: "InMemory",
        refreshStrategies: [{ kind: "interval", seconds: 60 }],
        incrementalRefresh: "date >= TODAY()",
      } as Partial<ModelTableInfo>),
    ]);
    expect(summary("refresh")).toBe("1 strategy · incremental filter set");
  });

  it("opens a section on click, and the summary gives way to the contents", async () => {
    await mount([table("Sales")]);
    await click(disclosure("table-settings") as Element);
    expect(disclosure("table-settings")?.getAttribute("aria-expanded")).toBe("true");
    // The summary is hidden while open: the contents are right there, and
    // repeating them above would state the same fact twice.
    expect(summary("table-settings")).toBeNull();
    expect(container.textContent).toContain("Save table");
  });

  it("keeps a fold across a change of table", async () => {
    // The reason the open-state lives in the section rather than in the cards:
    // they remount per selection, so card-local state would re-open everything
    // on every click in the master list, and a fold you must redo six times is
    // worse than no fold.
    await mount([table("Sales"), table("Dim")]);
    await click(disclosure("table-settings") as Element);
    expect(disclosure("table-settings")?.getAttribute("aria-expanded")).toBe("true");

    const other = [...container.querySelectorAll("strong")].find((s) => s.textContent === "Dim");
    await click(other as Element);
    expect(container.textContent).toContain("Dim");
    expect(
      disclosure("table-settings")?.getAttribute("aria-expanded"),
      "the fold is a preference about the SECTION, not about the table",
    ).toBe("true");
  });

  it("keeps Edit transforms reachable while Transformations is folded", async () => {
    // It opens a modal, so making the user expand the section first would be a
    // click whose only effect is revealing the button they already wanted.
    await mount([table("Sales")]);
    expect(disclosure("transforms")?.getAttribute("aria-expanded")).toBe("false");
    const edit = [...container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").startsWith("Edit transforms"),
    );
    expect(edit, "the action stays on the folded row").toBeDefined();
  });
});
