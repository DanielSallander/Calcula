// FILENAME: app/extensions/ModelEditor/__tests__/StrategySection.test.tsx
// PURPOSE: The Strategy tab in jsdom — the four-valued row state that replaced
//          the confirmed/inferred boolean, the infer-first mount, the ignored-
//          column disclosure, per-dimension aggregation, never-slice-by, what
//          Save does with a REFUSAL, what the scope editor will not accept, and
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
//
//          THE INHERITANCE TESTS ASSERT THE EMPTY OPTION, NOT THE VALUE. A
//          measure whose direction comes from a KPI writes NOTHING into the
//          document — the point is that the blank cell stops lying about that,
//          so the assertion is on what the empty option SAYS and on the
//          document staying untouched. A test that checked `select.value`
//          would pass just as well against a tab that had silently copied the
//          KPI's answer into the document, which is the exact drift this
//          feature exists to prevent.
//
//          A CONTROL IS CHANGED THROUGH THE PROTOTYPE SETTER. React patches
//          `value` on the element instance to track it, so `el.value = x`
//          updates the tracker too and the change event is then dropped as a
//          no-op. `change()` writes through `HTMLSelectElement.prototype`, which
//          the patch does not cover — without it an edit test passes while
//          nothing is edited.

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
  strategyInfer: vi.fn(),
  strategyPreview: vi.fn(),
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
import {
  strategyGet,
  strategyInfer,
  strategyPreview,
  strategySet,
  strategyValidate,
} from "../lib/strategyBackend";
import {
  StrategySection,
  buildRuleFromDraft,
  emptyRuleDraft,
  forgetUnsavedDrafts,
} from "../components/sections/StrategySection";
import type { SectionCtx } from "../components/editorShared";
import type {
  ResolvedMeasure,
  StrategyPreviewMeasure,
  StrategyPreviewResult,
} from "../lib/strategyBackend";
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
        ["Note", "String"],
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

/** What the BACKEND's inference answers with — every entry carries a value and
 *  none of them is confirmed. */
const INFERRED_DRAFT: StrategyDoc = {
  version: 1,
  measures: {
    Returns: { direction: "lowerIsBetter", reviewed: false },
    Profit: { direction: "higherIsBetter", reviewed: false },
  },
  tables: {
    Sales: { kind: "fact", reviewed: false },
    Dim: { kind: "dimension", reviewed: false },
  },
};

/**
 * A resolved measure EXACTLY as the backend serializes one.
 *
 * Every field is present, and an attribute nothing decided is `null` — NOT
 * absent. `ResolvedMeasure`'s `Option<Applied<T>>` fields carry no
 * `skip_serializing_if`, so serde writes the key with a null value.
 *
 * This helper used to list only the array fields and leave the attributes off,
 * which made them `undefined`. That is not a wire shape the backend can produce,
 * and it was the exact shape the buggy code expected — so ten tests passed while
 * the tab crashed on the first measure of any real model, on `null.value`. A
 * fixture that is more complete than reality tests the fixture.
 */
function resolvedMeasure(measure: string, over: Partial<ResolvedMeasure> = {}): ResolvedMeasure {
  return {
    measure,
    direction: null,
    aggregation: null,
    unit: null,
    target: null,
    materiality: null,
    cadence: null,
    priority: null,
    rankWeight: null,
    context: null,
    suppressedKinds: [],
    analysisDimensions: [],
    neverSliceBy: [],
    suppressions: [],
    ...over,
  };
}

function previewOf(...measures: StrategyPreviewMeasure[]): StrategyPreviewResult {
  return { measures, findings: [] };
}

/** A measure the MODEL has and the document says nothing about. */
function inherits(measure: string, over: Partial<ResolvedMeasure>): StrategyPreviewMeasure {
  return { measure, hasEntry: false, inModel: true, resolved: resolvedMeasure(measure, over) };
}

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

/** Let the preview land.
 *
 *  The first preview of a load is fired from an effect that runs AFTER the
 *  document has been installed, so it settles one turn later than the mount
 *  itself. The wait is a real macrotask rather than `Promise.resolve()`, so
 *  every microtask in the chain has drained by the time it returns. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** The direction picker of one measure row. */
function directionSelect(measure: string): HTMLSelectElement {
  return measureRow(measure).querySelectorAll("select")[0] as HTMLSelectElement;
}

/** The target field of one measure row (the row's first text input). */
function targetInput(measure: string): HTMLInputElement {
  return measureRow(measure).querySelectorAll("input")[0] as HTMLInputElement;
}

function measureRow(name: string): HTMLElement {
  const el = container.querySelector(`tr[data-strategy-path="measures['${name}']"]`);
  if (!el) throw new Error(`no measure row for '${name}'`);
  return el as HTMLElement;
}

function columnRow(table: string, col: string): HTMLElement | null {
  return container.querySelector(`tr[data-strategy-path="tables['${table}'].columns['${col}']"]`);
}

/** The one button in `scope` whose text is exactly `label`. */
function button(label: string, scope: ParentNode = container): HTMLButtonElement {
  const hits = [...scope.querySelectorAll("button")].filter(
    (b) => (b.textContent ?? "").trim() === label,
  );
  if (hits.length !== 1) throw new Error(`expected 1 '${label}' button, found ${hits.length}`);
  return hits[0] as HTMLButtonElement;
}

function byTestId<T extends Element>(id: string, scope: ParentNode = container): T {
  const el = scope.querySelector(`[data-testid="${id}"]`);
  if (!el) throw new Error(`no element with data-testid='${id}'`);
  return el as T;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** Change a controlled <select>/<input> the way a user would.
 *
 *  The value goes through the PROTOTYPE setter: React's value tracker is
 *  installed on the element instance, so a plain `el.value = v` updates the
 *  tracker as well and React then discards the change event as a no-op. */
async function change(el: HTMLSelectElement | HTMLInputElement, value: string): Promise<void> {
  const proto =
    el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (!setter) throw new Error("no prototype value setter — cannot drive the control");
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/** The document the last Save actually sent. */
function lastSaved(): StrategyDoc {
  const calls = vi.mocked(strategySet).mock.calls;
  if (calls.length === 0) throw new Error("Save was never called");
  return calls[calls.length - 1][1];
}

beforeEach(() => {
  vi.clearAllMocks();
  // Module state: without this a draft remembered by one case is handed to the
  // next one, and the auto-infer cases silently stop exercising inference.
  forgetUnsavedDrafts();
  vi.mocked(strategyGet).mockResolvedValue(MIXED_DOC);
  vi.mocked(strategyInfer).mockResolvedValue(INFERRED_DRAFT);
  // No inheritance by default: the cases that are not ABOUT the preview must
  // render exactly the grid they rendered before it existed.
  vi.mocked(strategyPreview).mockResolvedValue({ measures: [], findings: [] });
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
// The four row states
// ---------------------------------------------------------------------------

describe("the row state", () => {
  it("renders an unreviewed row as inferred and a reviewed one as confirmed", async () => {
    await mount();

    const inferred = measureRow("Profit");
    expect(inferred.getAttribute("data-unconfirmed")).toBe("true");
    expect(inferred.getAttribute("data-strategy-state")).toBe("inferred");
    expect(inferred.textContent).toContain("inferred");
    expect(inferred.style.fontStyle).toBe("italic");
    // The Confirm affordance belongs to an unconfirmed row and only to one.
    expect([...inferred.querySelectorAll("button")].map((b) => b.textContent)).toContain("Confirm");

    // ...and the other direction, which is what makes the contrast a contrast.
    const confirmed = measureRow("Returns");
    expect(confirmed.getAttribute("data-unconfirmed")).toBe("false");
    expect(confirmed.getAttribute("data-strategy-state")).toBe("confirmed");
    expect(confirmed.textContent).not.toContain("inferred");
    expect(confirmed.textContent).toContain("confirmed");
    expect(confirmed.style.fontStyle).not.toBe("italic");
    expect([...confirmed.querySelectorAll("button")].map((b) => b.textContent)).not.toContain(
      "Confirm",
    );
  });

  it("a measure the document says nothing about renders no inferred badge and a DISABLED Confirm", async () => {
    vi.mocked(strategyGet).mockResolvedValue({
      version: 1,
      measures: { Profit: { reviewed: false }, Returns: { direction: "lowerIsBetter", reviewed: false } },
    });
    await mount();

    const empty = measureRow("Profit");
    expect(empty.getAttribute("data-strategy-state")).toBe("empty");
    // The reviewed axis is unchanged — nobody has confirmed this row either.
    expect(empty.getAttribute("data-unconfirmed")).toBe("true");
    expect(empty.textContent).not.toContain("inferred");
    expect(empty.textContent).toContain("not set");
    // Confirming a row of "—" agrees to nothing, and a live button there teaches
    // people to confirm without reading.
    expect(button("Confirm", empty).disabled).toBe(true);
    expect(button("Confirm", empty).title).toContain("Nothing to confirm");
  });

  it("a measure the document does carry a value for renders the inferred badge and an ENABLED Confirm", async () => {
    vi.mocked(strategyGet).mockResolvedValue({
      version: 1,
      measures: { Profit: { reviewed: false }, Returns: { direction: "lowerIsBetter", reviewed: false } },
    });
    await mount();

    const guessed = measureRow("Returns");
    expect(guessed.getAttribute("data-strategy-state")).toBe("inferred");
    expect(guessed.textContent).toContain("inferred");
    expect(button("Confirm", guessed).disabled).toBe(false);
  });

  it("editing a field flips the row from a machine's guess to 'set by you'", async () => {
    await mount();
    const row = measureRow("Profit");
    expect(row.getAttribute("data-strategy-state")).toBe("inferred");

    await change(row.querySelectorAll("select")[0] as HTMLSelectElement, "neutral");

    const edited = measureRow("Profit");
    expect(edited.getAttribute("data-strategy-state")).toBe("authored");
    expect(edited.textContent).toContain("set by you");
    // Authorship is not confirmation: the row still has to be signed off.
    expect(edited.getAttribute("data-unconfirmed")).toBe("true");
    expect(button("Confirm", edited).disabled).toBe(false);
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
// Inheritance — what a cell already resolves to, and who decided it
// ---------------------------------------------------------------------------

describe("an attribute the document does not state", () => {
  /** Only Returns has an entry; Profit's answers come from its KPI. */
  const RETURNS_ONLY: StrategyDoc = {
    version: 1,
    measures: { Returns: { direction: "lowerIsBetter", reviewed: true } },
  };

  it("renders a measure the resolver decided NOTHING about, instead of crashing on it", async () => {
    // THE REGRESSION. An unannotated measure with no KPI resolves every
    // attribute to `null`, and `null` is what crosses the wire — the resolver's
    // Option fields do not skip when empty. The guards read `=== undefined`, so
    // the first such measure threw `Cannot read properties of null (reading
    // 'value')` out of `inheritedOption`, which the Model Editor's error
    // boundary turned into "failed to start" for the whole window.
    //
    // Most measures of most models are exactly this shape, so this is the
    // ordinary case rather than an edge one.
    vi.mocked(strategyGet).mockResolvedValue({ version: 1 });
    vi.mocked(strategyPreview).mockResolvedValue(
      previewOf(
        { measure: "Returns", hasEntry: false, inModel: true, resolved: resolvedMeasure("Returns") },
        { measure: "Profit", hasEntry: false, inModel: true, resolved: resolvedMeasure("Profit") },
      ),
    );
    await mount();
    await settle();
    // It renders at all, and the controls are simply blank — there is nothing
    // to inherit, so there is nothing to say.
    // The empty option is the ordinary "—" placeholder, NOT an inheritance
    // note: an inherited one reads "<value> — from KPI '<name>'", so the word
    // "from" is what distinguishes the two.
    expect(directionSelect("Profit").value).toBe("");
    expect(directionSelect("Profit").options[0].textContent).not.toContain("from");
    expect(targetInput("Profit").placeholder).not.toContain("from");
  });

  const FROM_KPI: StrategyPreviewResult = previewOf(
    inherits("Profit", {
      direction: { value: "higherIsBetter", source: { kpi: "Margin % KPI" } },
      target: { value: { type: "literal", value: 0.38 }, source: { kpi: "Margin % KPI" } },
    }),
  );

  it("shows the value it inherits and NAMES the KPI, instead of a blank", async () => {
    vi.mocked(strategyGet).mockResolvedValue(RETURNS_ONLY);
    vi.mocked(strategyPreview).mockResolvedValue(FROM_KPI);
    await mount();
    await settle();

    const picker = directionSelect("Profit");
    // Nothing was written: the document still says nothing about Profit.
    expect(picker.value).toBe("");
    const empty = picker.options[0];
    expect(empty.textContent).toContain("higherIsBetter");
    // "inherited" is not an answer anyone can go and check. The KPI's NAME is.
    expect(empty.textContent).toContain("Margin % KPI");
    expect(picker.title).toContain("overrides it");
  });

  it("carries the inherited target into the field's placeholder, KPI and all", async () => {
    vi.mocked(strategyGet).mockResolvedValue(RETURNS_ONLY);
    vi.mocked(strategyPreview).mockResolvedValue(FROM_KPI);
    await mount();
    await settle();

    const field = targetInput("Profit");
    expect(field.value).toBe("");
    expect(field.placeholder).toContain("0.38");
    expect(field.placeholder).toContain("Margin % KPI");
    // The accepted spellings still reach the person about to type over it.
    expect(field.title).toContain("band:");
  });

  it("choosing a value writes a LITERAL into the document — the explicit override", async () => {
    vi.mocked(strategyGet).mockResolvedValue(RETURNS_ONLY);
    vi.mocked(strategyPreview).mockResolvedValue(FROM_KPI);
    await mount();
    await settle();

    await change(directionSelect("Profit"), "lowerIsBetter");
    await click(button("Save"));

    expect(lastSaved().measures?.Profit.direction).toBe("lowerIsBetter");
    // And the row now reads as the user's own sentence, not the KPI's.
    expect(measureRow("Profit").getAttribute("data-strategy-state")).toBe("authored");
  });

  it("leaves a value the document DOES carry exactly as it was", async () => {
    vi.mocked(strategyGet).mockResolvedValue({
      version: 1,
      measures: { Profit: { direction: "lowerIsBetter", reviewed: false }, Returns: { reviewed: true } },
    });
    vi.mocked(strategyPreview).mockResolvedValue(
      previewOf({
        measure: "Profit",
        hasEntry: true,
        inModel: true,
        resolved: resolvedMeasure("Profit", {
          direction: { value: "lowerIsBetter", source: "strategy" },
        }),
      }),
    );
    await mount();
    await settle();

    const picker = directionSelect("Profit");
    expect(picker.value).toBe("lowerIsBetter");
    // The empty option is still the plain dash: there is nothing to inherit
    // where the document has already spoken.
    expect(picker.options[0].textContent).toBe("—");
  });

  it("marks a cell a scoped rule overrides, so the two cannot disagree in silence", async () => {
    vi.mocked(strategyGet).mockResolvedValue({
      version: 1,
      measures: { Profit: { direction: "higherIsBetter", reviewed: false }, Returns: { reviewed: true } },
    });
    vi.mocked(strategyPreview).mockResolvedValue(
      previewOf({
        measure: "Profit",
        hasEntry: true,
        inModel: true,
        resolved: resolvedMeasure("Profit", {
          direction: { value: "lowerIsBetter", source: { rule: "refunds-dept" } },
        }),
      }),
    );
    await mount();
    await settle();

    const mark = measureRow("Profit").querySelector('[data-testid="rule-override-direction-Profit"]');
    expect(mark).not.toBeNull();
    expect(mark?.getAttribute("title")).toContain("refunds-dept");
    // The measure with no rule over it carries no marker.
    expect(
      measureRow("Returns").querySelector('[data-testid="rule-override-direction-Returns"]'),
    ).toBeNull();
  });

  it("previews the UNSAVED document, so an edit's effect is legible before Save", async () => {
    await mount();
    await settle();
    const before = vi.mocked(strategyPreview).mock.calls.length;
    expect(before).toBeGreaterThan(0);

    await change(directionSelect("Profit"), "neutral");
    // Debounced: an edit does not fire a request per keystroke.
    expect(vi.mocked(strategyPreview).mock.calls.length).toBe(before);

    // The debounce is 300ms; this waits past it with real timers.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    const calls = vi.mocked(strategyPreview).mock.calls;
    expect(calls.length).toBeGreaterThan(before);
    // The IN-MEMORY document, not the stored one. Seeing the effect of an edit
    // before saving it is the whole reason a payload is sent at all.
    expect(calls[calls.length - 1][1]?.measures?.Profit.direction).toBe("neutral");
    expect(strategySet).not.toHaveBeenCalled();
  });

  it("stays usable, and simply shows no inheritance, when the preview fails", async () => {
    vi.mocked(strategyGet).mockResolvedValue(RETURNS_ONLY);
    vi.mocked(strategyPreview).mockRejectedValue(new Error("the connection dropped"));
    const ctx = ctxFor();
    await mount(ctx);
    await settle();

    // Silent: a decoration that failed must not spend the user's attention.
    expect(ctx.reportError).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("preview");
    expect(directionSelect("Profit").options[0].textContent).toBe("—");
    expect(measureRow("Profit").querySelector('[data-testid="why-Profit"]')).toBeNull();

    // And the row is still fully editable — inheritance never gates an edit.
    await change(directionSelect("Profit"), "neutral");
    await click(button("Save"));
    expect(lastSaved().measures?.Profit.direction).toBe("neutral");
  });
});

describe("the why affordance", () => {
  it("lists every resolved attribute with its source, and the suppression behind an empty one", async () => {
    vi.mocked(strategyPreview).mockResolvedValue(
      previewOf(
        inherits("Profit", {
          direction: { value: "higherIsBetter", source: { kpi: "Margin % KPI" } },
          unit: { value: "percent", source: "base" },
          cadence: { value: "monthly", source: "inferred" },
          suppressions: [
            {
              attribute: "direction",
              rule: "refunds-dept",
              reason: "a refund rising is not favourable in this department",
            },
          ],
        }),
      ),
    );
    await mount();
    await settle();

    const why = byTestId("why-Profit", measureRow("Profit")).getAttribute("title") ?? "";
    expect(why).toContain("direction: higherIsBetter (KPI 'Margin % KPI')");
    expect(why).toContain("unit: percent (base)");
    expect(why).toContain("cadence: monthly (inferred)");
    // "No favourability here, because rule X disagrees" is the single most
    // confusing thing the engine can do, and this tooltip is the only place a
    // person can learn it.
    expect(why).toContain("WITHHELD by rule 'refunds-dept'");
    expect(why).toContain("a refund rising is not favourable in this department");
  });

  it("is absent on a row no preview reached, rather than claiming nothing is decided", async () => {
    await mount();
    await settle();
    expect(measureRow("Profit").querySelector('[data-testid="why-Profit"]')).toBeNull();
  });
});

describe("an orphan entry", () => {
  it("is marked as naming a measure the model no longer has, and offers no editing", async () => {
    vi.mocked(strategyPreview).mockResolvedValue(
      previewOf({
        measure: "Retired Margin",
        hasEntry: true,
        inModel: false,
        resolved: resolvedMeasure("Retired Margin"),
      }),
    );
    await mount();
    await settle();

    const orphan = container.querySelector('tr[data-strategy-orphan="true"]');
    expect(orphan).not.toBeNull();
    expect(orphan?.textContent).toContain("Retired Margin");
    expect(orphan?.textContent).toContain("not in the model");
    // It is the thing to clean up, not a measure to tend: no dropdowns on it.
    expect(orphan?.querySelectorAll("select").length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Infer-first: the first view is a draft to correct, not a form to fill
// ---------------------------------------------------------------------------

describe("the first view of a model", () => {
  it("shows a stored strategy as it is, and infers nothing over it", async () => {
    await mount();
    expect(strategyGet).toHaveBeenCalledTimes(1);
    expect(strategyInfer).not.toHaveBeenCalled();
    expect(measureRow("Returns").getAttribute("data-unconfirmed")).toBe("false");
  });

  it("opens a model with no stored strategy on an inferred draft, saving nothing", async () => {
    vi.mocked(strategyGet).mockResolvedValue(null);
    await mount();

    expect(strategyInfer).toHaveBeenCalledWith("conn-1");
    // The draft is ON SCREEN: this is a document to correct, not a blank form.
    expect(measureRow("Profit").getAttribute("data-strategy-state")).toBe("inferred");
    expect(byTestId("strategy-status").textContent).toContain("inferred draft");
    expect(strategySet).not.toHaveBeenCalled();
  });

  it("keeps the unsaved draft when the tab is left and re-entered, rather than re-inferring over it", async () => {
    vi.mocked(strategyGet).mockResolvedValue(null);
    const ctx = ctxFor();
    await mount(ctx);
    await click(button("Confirm", measureRow("Profit")));
    expect(measureRow("Profit").getAttribute("data-unconfirmed")).toBe("false");

    // Leaving the section unmounts the tab; coming back re-runs the effect.
    await act(async () => {
      root.render(null);
    });
    await mount(ctx);

    expect(strategyInfer).toHaveBeenCalledTimes(1);
    expect(measureRow("Profit").getAttribute("data-unconfirmed")).toBe("false");
    expect(byTestId("strategy-status").textContent).toContain("unsaved draft");
  });

  it("falls back to an empty document, not an error screen, when the draft cannot be built", async () => {
    vi.mocked(strategyGet).mockResolvedValue(null);
    vi.mocked(strategyInfer).mockRejectedValue(new Error("the model has no measure ASTs"));
    const ctx = ctxFor();
    await mount(ctx);

    // The tab still works — every row is simply empty, and it says so.
    expect(measureRow("Profit").getAttribute("data-strategy-state")).toBe("empty");
    expect(byTestId("strategy-status").textContent).toContain("no strategy yet");
    expect(ctx.reportError).not.toHaveBeenCalled();
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
// Aggregation — additivity is per dimension
// ---------------------------------------------------------------------------

describe("the aggregation editor", () => {
  /** A semi-additive balance: additive over Department, last-value over Date. */
  const SEMI_ADDITIVE: StrategyDoc = {
    version: 1,
    measures: {
      Profit: {
        reviewed: false,
        aggregation: { default: "additive", byDimension: { "Dim[Dept]": "lastValue" } },
      },
      Returns: { reviewed: true },
    },
  };

  it("shows a per-dimension exception in the collapsed cell, without opening anything", async () => {
    vi.mocked(strategyGet).mockResolvedValue(SEMI_ADDITIVE);
    await mount();

    const cell = byTestId<HTMLButtonElement>("aggregation-Profit");
    const text = cell.textContent ?? "";
    expect(text).toContain("additive");
    // The exception itself, not just the default: the old cell showed `.default`
    // alone, so a byDimension map was invisible right up to the edit that
    // destroyed it.
    expect(text.toLowerCase()).toContain("last");
  });

  it("changing the default PRESERVES an existing per-dimension exception", async () => {
    vi.mocked(strategyGet).mockResolvedValue(SEMI_ADDITIVE);
    await mount();
    await click(byTestId("aggregation-Profit"));

    await change(byTestId<HTMLSelectElement>("aggregation-default"), "average");

    // Still exactly one exception row, and it still names the dimension.
    const rows = container.querySelectorAll('[data-testid="aggregation-exception"]');
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain("Dim[Dept]");

    await click(button("Close"));
    await click(button("Save"));
    expect(lastSaved().measures?.Profit.aggregation).toEqual({
      default: "average",
      byDimension: { "Dim[Dept]": "lastValue" },
    });
  });

  it("removes one exception without touching the default", async () => {
    vi.mocked(strategyGet).mockResolvedValue(SEMI_ADDITIVE);
    await mount();
    await click(byTestId("aggregation-Profit"));

    const row = byTestId("aggregation-exception");
    await click(button("×", row));

    expect(container.querySelectorAll('[data-testid="aggregation-exception"]').length).toBe(0);
    await click(button("Close"));
    await click(button("Save"));
    expect(lastSaved().measures?.Profit.aggregation?.default).toBe("additive");
  });
});

// ---------------------------------------------------------------------------
// Never slice by
// ---------------------------------------------------------------------------

describe("never slice by", () => {
  it("adds a column no breakdown of this measure may use, and takes it away again", async () => {
    await mount();
    const cell = byTestId("never-slice-Profit");

    await change(cell.querySelector("select") as HTMLSelectElement, "Dim[Dept]");
    // The CHIP, not the cell text: the picker still lists every column, so a
    // text match on the cell is satisfied by the <option> and proves nothing.
    const chipRemove = (): HTMLButtonElement | null =>
      byTestId("never-slice-Profit").querySelector('button[title="Remove Dim[Dept]"]');
    expect(chipRemove()).not.toBeNull();

    await click(button("Save"));
    expect(lastSaved().measures?.Profit.neverSliceBy).toEqual(["Dim[Dept]"]);

    await click(chipRemove() as HTMLButtonElement);
    expect(chipRemove()).toBeNull();
    await click(button("Save"));
    expect(lastSaved().measures?.Profit.neverSliceBy).toEqual([]);
  });

  it("says what the list is FOR, because the name alone does not carry it", async () => {
    await mount();
    const title = byTestId("never-slice-Profit").querySelector("div")?.getAttribute("title") ?? "";
    expect(title).toContain("misleading");
  });
});

// ---------------------------------------------------------------------------
// Ignored columns
// ---------------------------------------------------------------------------

describe("the columns grid", () => {
  /** Sales: one analysis column and two ignored ones. */
  const ROLED: StrategyDoc = {
    version: 1,
    tables: {
      Sales: {
        kind: "fact",
        reviewed: false,
        columns: {
          Amount: { role: "ignore" },
          DeptKey: { role: "ignore" },
          Note: { role: "analysis" },
        },
      },
    },
  };

  it("collapses the ignored columns behind a summary that names the count", async () => {
    vi.mocked(strategyGet).mockResolvedValue(ROLED);
    await mount();

    expect(columnRow("Sales", "Note")).not.toBeNull();
    expect(columnRow("Sales", "Amount")).toBeNull();
    expect(byTestId("ignored-summary-Sales").textContent).toContain("show 2 ignored columns");
  });

  it("expands to reveal the ignored columns still editable, and the count follows the edit", async () => {
    vi.mocked(strategyGet).mockResolvedValue(ROLED);
    await mount();
    // The summary carries a chevron glyph as well as its words, so it is
    // reached by its row rather than by an exact-text button lookup.
    await click(byTestId("ignored-summary-Sales").querySelector("button") as HTMLButtonElement);

    const amount = columnRow("Sales", "Amount");
    expect(amount).not.toBeNull();
    const role = amount!.querySelector("select") as HTMLSelectElement;
    expect(role.disabled).toBe(false);

    // A disclosure, never a filter: the hidden rows are real, editable rows,
    // and promoting one out of `ignore` is legible in the summary.
    await change(role, "analysis");
    expect(byTestId("ignored-summary-Sales").textContent).toContain("1 ignored column");
    expect(columnRow("Sales", "Amount")).not.toBeNull();
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
      "Sales[Note]",
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
    expect(strategyInfer).not.toHaveBeenCalled();
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

  it("draws its draft from the same backend inference the empty-model view uses", async () => {
    await mount();
    await click(button("Infer"));
    // One call, one source of truth: a second (weaker) frontend inferrer is how
    // the button and the first view came to disagree about what "inferred" is.
    expect(strategyInfer).toHaveBeenCalledTimes(1);
    expect(strategyInfer).toHaveBeenCalledWith("conn-1");
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
