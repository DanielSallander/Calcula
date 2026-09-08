// FILENAME: app/extensions/ModelEditor/__tests__/StrategySection.test.tsx
// PURPOSE: The Strategy tab in jsdom — the confirmed/inferred contrast that is
//          the whole point of the surface, what Confirm touches, what Save
//          does with a REFUSAL, what the scope editor will not accept, and
//          whether Infer asks before it discards.
// CONTEXT: @testing-library/react is not installed in this repo, so this file
//          drives react-dom + `act` directly, as its sibling component tests do
//          (ScriptableObjects/__tests__/scriptPaneSection.test.tsx).
//
//          THE INFER TEST DOUBLES THE TAURI SHAPE. `confirmAsync` is mocked
//          with `mockReturnValue(Promise.resolve(false))`, not `false`. A
//          synchronous double passes even when the code never awaits — which
//          is exactly how six shipped consent gates failed open under Tauri,
//          where `window.confirm` returns a Promise and `!Promise` is always
//          false.
//
//          THE SAVE TEST ASSERTS THE ABSENCE OF SUCCESS. `op: "set"` answers a
//          refused write with `{ written: false, findings }` on a RESOLVED
//          promise, so the failure mode is a green "Saved." over a document the
//          backend threw away, with the reasons discarded.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type {
  ModelMeasureInfo,
  ModelOverview,
  ModelRelationshipInfo,
  ModelTableInfo,
} from "@api";

vi.mock("../lib/strategyBackend", () => ({
  strategyGet: vi.fn(),
  strategyValidate: vi.fn(),
  strategyRunTests: vi.fn(),
  strategySet: vi.fn(),
  strategyDelete: vi.fn(),
}));

vi.mock("@api/dialogs", () => ({
  confirmAsync: vi.fn(),
  alertAsync: vi.fn(),
  promptAsync: vi.fn(),
}));

import { confirmAsync } from "@api/dialogs";
import { strategyGet, strategySet, strategyValidate } from "../lib/strategyBackend";
import { StrategySection, buildRuleFromDraft, emptyRuleDraft } from "../components/sections/StrategySection";
import type { SectionCtx } from "../components/editorShared";
import type { Finding, StrategyDoc } from "../lib/strategyTypes";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function column(name: string, dataType = "Float64"): ModelTableInfo["columns"][number] {
  return {
    name,
    dataType,
    displayName: null,
    description: null,
    isHidden: false,
    isCalculated: false,
    isDynamic: false,
    formula: null,
    lookupResolution: null,
    sortByColumn: null,
    formatString: null,
  };
}

function table(name: string, cols: Array<[string, string]>): ModelTableInfo {
  return {
    name,
    displayName: null,
    description: null,
    isHidden: false,
    storageMode: "InMemory",
    bound: false,
    sourceId: null,
    columns: cols.map(([n, t]) => column(n, t)),
    refreshStrategies: [],
    incrementalRefresh: null,
    transformSteps: [],
    transformScript: "",
    sourceColumns: [],
  };
}

function measure(name: string): ModelMeasureInfo {
  return {
    name,
    table: "Sales",
    formula: "SUM(Sales[Amount])",
    hasSource: true,
    description: null,
    formatString: null,
    formatStringExpression: null,
    detailRows: null,
    isHidden: false,
    group: null,
  } as ModelMeasureInfo;
}

const RELATIONSHIP: ModelRelationshipInfo = {
  name: "Sales_Dim",
  fromTable: "Sales",
  toTable: "Dim",
  conditions: [{ fromColumn: "DeptKey", toColumn: "DeptKey" }],
  cardinality: "manyToOne",
  active: true,
  filterPropagation: "auto",
};

function overview(): ModelOverview {
  return {
    editable: true,
    readOnlyReason: null,
    tables: [
      table("Sales", [
        ["Amount", "Float64"],
        ["DeptKey", "Int64"],
      ]),
      table("Dim", [
        ["DeptKey", "Int64"],
        ["Dept", "String"],
      ]),
    ],
    relationships: [RELATIONSHIP],
    hierarchies: [],
    kpis: [],
    securityRoles: [],
    perspectives: [],
    cultures: [],
    calculationGroups: [],
    measures: [measure("Returns"), measure("Profit")],
    contexts: [],
    contextColumns: [],
    tableVariables: [],
    globalVariables: [],
    scriptFunctions: [],
    dateTable: null,
    defaultLookupResolution: null,
    modelName: "Test model",
    modelVersion: null,
    modelAuthor: null,
    modelDescription: null,
    sources: [],
    writebackColumns: [],
  };
}

/** Returns confirmed, Profit inferred — the tab's core contrast, both ways. */
const MIXED_DOC: StrategyDoc = {
  version: 1,
  measures: {
    Returns: { direction: "lowerIsBetter", reviewed: true },
    Profit: { direction: "higherIsBetter", reviewed: false },
  },
  tables: { Dim: { kind: "dimension", reviewed: false } },
};

let container: HTMLDivElement;
let root: Root;

function ctxFor(o: ModelOverview = overview(), readOnly = false): SectionCtx {
  return {
    connectionId: "conn-1",
    overview: o,
    readOnly,
    applyOverview: vi.fn(),
    applyMeasures: vi.fn(),
    reportError: vi.fn(),
  };
}

async function mount(ctx: SectionCtx = ctxFor()): Promise<void> {
  await act(async () => {
    root.render(<StrategySection ctx={ctx} />);
  });
}

function measureRow(name: string): HTMLElement {
  const el = container.querySelector(`tr[data-strategy-path="measures['${name}']"]`);
  if (!el) throw new Error(`no measure row for '${name}'`);
  return el as HTMLElement;
}

/** The one button in `scope` whose text is exactly `label`. */
function button(label: string, scope: ParentNode = container): HTMLButtonElement {
  const hits = [...scope.querySelectorAll("button")].filter(
    (b) => (b.textContent ?? "").trim() === label,
  );
  if (hits.length !== 1) throw new Error(`expected 1 '${label}' button, found ${hits.length}`);
  return hits[0] as HTMLButtonElement;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(strategyGet).mockResolvedValue(MIXED_DOC);
  vi.mocked(strategySet).mockResolvedValue({ written: true, findings: [] });
  vi.mocked(strategyValidate).mockResolvedValue({ written: false, findings: [] });
  vi.mocked(confirmAsync).mockReturnValue(Promise.resolve(true));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

// ---------------------------------------------------------------------------
// The confirmed / inferred contrast
// ---------------------------------------------------------------------------

describe("confirmed vs inferred", () => {
  it("renders an unreviewed row as inferred and a reviewed one as confirmed", async () => {
    await mount();

    const inferred = measureRow("Profit");
    expect(inferred.getAttribute("data-unconfirmed")).toBe("true");
    expect(inferred.textContent).toContain("inferred");
    expect(inferred.style.fontStyle).toBe("italic");
    // The Confirm affordance belongs to an unconfirmed row and only to one.
    expect([...inferred.querySelectorAll("button")].map((b) => b.textContent)).toContain("Confirm");

    // ...and the other direction, which is what makes the contrast a contrast.
    const confirmed = measureRow("Returns");
    expect(confirmed.getAttribute("data-unconfirmed")).toBe("false");
    expect(confirmed.textContent).not.toContain("inferred");
    expect(confirmed.textContent).toContain("confirmed");
    expect(confirmed.style.fontStyle).not.toBe("italic");
    expect([...confirmed.querySelectorAll("button")].map((b) => b.textContent)).not.toContain(
      "Confirm",
    );
  });

  it("a measure with no entry at all reads as inferred rather than as blank", async () => {
    vi.mocked(strategyGet).mockResolvedValue({ version: 1 });
    await mount();
    expect(measureRow("Returns").getAttribute("data-unconfirmed")).toBe("true");
    expect(measureRow("Profit").getAttribute("data-unconfirmed")).toBe("true");
  });

  it("Confirm flips only that row, and writes nothing", async () => {
    await mount();
    await click(button("Confirm", measureRow("Profit")));

    expect(measureRow("Profit").getAttribute("data-unconfirmed")).toBe("false");
    // The table entry, and the OTHER measure, are untouched.
    expect(measureRow("Returns").getAttribute("data-unconfirmed")).toBe("false");
    const table = container.querySelector('tr[data-strategy-path="tables[\'Dim\']"]');
    expect(table?.getAttribute("data-unconfirmed")).toBe("true");
    // Nothing writes until Save.
    expect(strategySet).not.toHaveBeenCalled();
  });

  it("Confirm all confirms every measure AND every table, still without writing", async () => {
    await mount();
    await click(button("Confirm all"));
    expect(measureRow("Profit").getAttribute("data-unconfirmed")).toBe("false");
    expect(
      container.querySelector('tr[data-strategy-path="tables[\'Dim\']"]')?.getAttribute("data-unconfirmed"),
    ).toBe("false");
    expect(strategySet).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

describe("Save", () => {
  const REFUSAL: Finding = {
    severity: "error",
    code: "direction-contradicts-kpi",
    path: "measures['Returns'].direction",
    message: "measure 'Returns' is declared lowerIsBetter, but its own KPI says higher is better",
  };

  it("does not report success when the write is REFUSED, and renders the findings", async () => {
    vi.mocked(strategySet).mockResolvedValue({ written: false, findings: [REFUSAL] });
    await mount();
    await click(button("Save"));

    expect(strategySet).toHaveBeenCalledTimes(1);
    const text = container.textContent ?? "";
    // A refusal RESOLVES, so the only thing standing between the user and a
    // false "Saved." is this branch.
    expect(text).toContain("Not saved");
    expect(text).not.toContain("Saved.");
    // The reasons must survive: they are the entire content of the refusal.
    expect(text).toContain("direction-contradicts-kpi");
    expect(text).toContain("but its own KPI says higher is better");
    expect(text).toContain("measures['Returns'].direction");
  });

  it("an error finding blocks Save and the button says how many", async () => {
    vi.mocked(strategyValidate).mockResolvedValue({ written: false, findings: [REFUSAL] });
    await mount();
    await click(button("Validate"));

    const save = [...container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").startsWith("Save"),
    ) as HTMLButtonElement;
    expect(save.textContent).toBe("Save — fix 1 error first");
    expect(save.disabled).toBe(true);
  });

  it("reports success only when the backend actually wrote", async () => {
    await mount();
    await click(button("Save"));
    expect(container.textContent).toContain("Saved.");
  });

  it("anchors a finding to the row its path names", async () => {
    vi.mocked(strategyValidate).mockResolvedValue({ written: false, findings: [REFUSAL] });
    await mount();
    await click(button("Validate"));
    // The finding's path is `measures['Returns'].direction` — one level BELOW
    // the row's own path, which a bare equality match would strand.
    expect(measureRow("Returns").textContent).toContain("error");
    expect(measureRow("Profit").textContent).not.toContain("error");
  });
});

// ---------------------------------------------------------------------------
// The scope editor
// ---------------------------------------------------------------------------

describe("the rule scope editor", () => {
  it("offers the model's columns as a picker, with no free-text column field", async () => {
    await mount();
    await click(button("Add rule"));
    await click(button("Add scope column"));

    const picker = container.querySelector<HTMLSelectElement>('[data-testid="scope-column"]');
    expect(picker, "the scope column must be a picker").not.toBeNull();
    expect(picker!.tagName).toBe("SELECT");
    expect([...picker!.options].map((o) => o.value)).toEqual([
      "",
      "Sales[Amount]",
      "Sales[DeptKey]",
      "Dim[DeptKey]",
      "Dim[Dept]",
    ]);
  });

  it("refuses a scope column the model does not have", async () => {
    // The guard is duplicated behind the picker on purpose: a typed name is a
    // rule that silently NEVER FIRES, which is indistinguishable from a rule
    // nobody needed.
    const built = buildRuleFromDraft(overview(), {
      ...emptyRuleDraft(),
      id: "r1",
      measure: "Returns",
      scope: [{ column: "Dim[Deptt]", kind: "members", members: "Refunds", from: "", to: "" }],
    });
    expect(built.ok).toBe(false);
    expect(built.ok === false && built.error).toContain("'Dim[Deptt]' is not a column in this model");
  });

  it("accepts a scope column the model does have", async () => {
    const built = buildRuleFromDraft(overview(), {
      ...emptyRuleDraft(),
      id: "r1",
      measure: "Returns",
      direction: "higherIsBetter",
      scope: [{ column: "Dim[Dept]", kind: "members", members: "Refunds, Retail", from: "", to: "" }],
    });
    expect(built.ok).toBe(true);
    expect(built.ok === true && built.rule).toEqual({
      id: "r1",
      measure: "Returns",
      scope: { "Dim[Dept]": ["Refunds", "Retail"] },
      set: { direction: "higherIsBetter" },
      note: undefined,
    });
  });

  it("refuses a measure the model does not have", async () => {
    const built = buildRuleFromDraft(overview(), {
      ...emptyRuleDraft(),
      id: "r1",
      measure: "Ghost",
    });
    expect(built.ok).toBe(false);
    expect(built.ok === false && built.error).toContain("'Ghost' is not a measure in this model");
  });
});

// ---------------------------------------------------------------------------
// Infer
// ---------------------------------------------------------------------------

describe("Infer", () => {
  it("asks before replacing, and does nothing when the answer is no", async () => {
    // mockReturnValue(Promise.resolve(false)) — the TAURI shape. A synchronous
    // `false` here would pass even against code that never awaited.
    vi.mocked(confirmAsync).mockReturnValue(Promise.resolve(false));
    await mount();
    await click(button("Infer"));

    expect(confirmAsync).toHaveBeenCalledTimes(1);
    // The draft is untouched: Returns is still the confirmed one.
    expect(measureRow("Returns").getAttribute("data-unconfirmed")).toBe("false");
    expect(strategySet).not.toHaveBeenCalled();
  });

  it("replaces the draft when the answer is yes — every entry unconfirmed", async () => {
    vi.mocked(confirmAsync).mockReturnValue(Promise.resolve(true));
    await mount();
    await click(button("Infer"));

    expect(measureRow("Returns").getAttribute("data-unconfirmed")).toBe("true");
    expect(measureRow("Profit").getAttribute("data-unconfirmed")).toBe("true");
    // Still nothing written — Infer proposes, Save commits.
    expect(strategySet).not.toHaveBeenCalled();
    expect(container.textContent).toContain("nothing is written until you press Save");
  });
});

// ---------------------------------------------------------------------------
// Read-only models
// ---------------------------------------------------------------------------

describe("a read-only model", () => {
  it("can still be validated, but not confirmed or saved", async () => {
    await mount(ctxFor(overview(), true));
    expect(button("Validate").disabled).toBe(false);
    expect(button("Confirm", measureRow("Profit")).disabled).toBe(true);
    expect(button("Infer").disabled).toBe(true);
    const save = [...container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").startsWith("Save"),
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });
});
