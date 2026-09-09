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
//          THE BULK-CONFIRM TESTS ASSERT THE SKIP *AND* THE SENTENCE. The
//          defect was not that `Confirm all` crashed — it confirmed everything,
//          findings included, which is the one gesture here that can turn the
//          validator's objection into a human's endorsement. So the assertions
//          are: the warned row stays unconfirmed, the unwarned ones do not, the
//          warning is STILL ON SCREEN afterwards, and the status says how many
//          were skipped and why. A silent skip would satisfy the first three.
//
//          THE INERT-FIELD TESTS ENUMERATE, THEY DO NOT SPOT-CHECK. Two of the
//          four model fields are stored and read by nothing, and the assertion
//          is on the WHOLE set of marked fields rather than on the two being
//          present — a note that survives its field acquiring a reader is the
//          same overstatement pointed the other way, and only an equality
//          catches that.
//
//          THE RULES TESTS EXIST BECAUSE A REVIEWER MISSED THE BUTTON. The
//          "Add rule" control was there all along; the empty state was a
//          sentence of theory with no call to action, so the rules path went
//          unexercised and a 100% path mismatch in its findings went unnoticed.
//          The assertions are therefore on DISCOVERABILITY — the empty state
//          offers the action and names what a rule does — and on a disabled
//          control explaining itself, which a `.disabled === true` assertion
//          alone would never have noticed was missing.
//
//          THE BAND TESTS ASSERT THE CONTROL, NOT A SECOND FIELD. Choosing
//          `targetBand` must switch the EXISTING target control into two
//          bounds: a document holding `direction: targetBand` beside
//          `target: 1000` has two answers and nothing saying which wins, so a
//          test that merely found two new inputs would pass against exactly the
//          shape the design refuses. The assertions are therefore that the
//          plain target field is GONE while the bounds are present, that a
//          half-filled band writes nothing, and that the value the switch took
//          away is named on screen.
//
//          THE INFER CALL COUNT IS NO LONGER THE GUARD. Inference now runs on
//          every load, because its draft is what a stored row is diffed against
//          to find a confirmation inference has overtaken. So "did the tab
//          re-infer?" is the wrong question and the tests ask the right one:
//          was the draft INSTALLED over the stored document or over the user's
//          unsaved one? A count assertion would have gone red for a change that
//          costs one model-only call and installs nothing.
//
//          THE DIVERGENCE TESTS ASSERT BOTH VALUES AND NO AUTO-APPLY. Silently
//          keeping a stale confirmed value and silently overwriting a human
//          decision are both unacceptable, so the row has to say what it says
//          AND what inference now proposes, and the document must still hold
//          the human's answer until somebody presses the button.
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
  addRuleBlockedReason,
  buildRuleFromDraft,
  emptyRuleDraft,
  forgetUnsavedDrafts,
} from "../components/sections/StrategySection";
import type { RuleDraft } from "../components/sections/StrategySection";
import { emptyStrategyDoc } from "../lib/strategyTypes";
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

/** Type into a text field and LEAVE it, which is what commits one.
 *
 *  The blur goes out as `focusout`. React maps `onBlur` to the native
 *  focusout event, which bubbles to the root listener; a plain `blur` event
 *  does not bubble, never reaches React, and the commit under test would
 *  simply never run — a test that then "passes" because nothing happened. */
async function commitText(el: HTMLInputElement, value: string): Promise<void> {
  await change(el, value);
  await act(async () => {
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
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

  it("Confirm all confirms the measures AND the tables that say something, still without writing", async () => {
    await mount();
    await click(button("Confirm all"));
    expect(measureRow("Profit").getAttribute("data-unconfirmed")).toBe("false");
    expect(
      container.querySelector('tr[data-strategy-path="tables[\'Dim\']"]')?.getAttribute("data-unconfirmed"),
    ).toBe("false");
    expect(strategySet).not.toHaveBeenCalled();

    // Sales has no entry at all, so there is nothing there to agree to: the
    // bulk confirm leaves it alone rather than minting `{reviewed: true}` for
    // a row the grid then keeps drawing as "not set".
    await click(button("Save"));
    expect(lastSaved().tables?.Sales).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Confirm all — the one gesture that could launder a warning
// ---------------------------------------------------------------------------

describe("Confirm all", () => {
  /** Both measures say something and neither is confirmed, so the only thing
   *  separating them in these cases is the finding. */
  const TWO_UNCONFIRMED: StrategyDoc = {
    version: 1,
    measures: {
      Returns: { direction: "lowerIsBetter", reviewed: false },
      Profit: { direction: "higherIsBetter", reviewed: false },
    },
    tables: { Dim: { kind: "dimension", reviewed: false } },
  };

  const PROFIT_WARNING: Finding = {
    severity: "warning",
    code: "direction-contradicts-usage",
    path: "measures['Profit'].direction",
    message: "'Profit' is declared higherIsBetter, but every pivot sorts it the other way",
  };

  /** Load findings the way a person does — Validate, then look. */
  async function validated(doc: StrategyDoc, findings: Finding[]): Promise<void> {
    vi.mocked(strategyGet).mockResolvedValue(doc);
    vi.mocked(strategyValidate).mockResolvedValue({ written: false, findings });
    await mount();
    await click(button("Validate"));
  }

  it("leaves a row carrying a finding unconfirmed, and says how many it skipped", async () => {
    await validated(TWO_UNCONFIRMED, [PROFIT_WARNING]);
    await click(button("Confirm all"));

    // The warned row is exactly where it was. Confirm is what the
    // decomposition engine reads as "a human vouched for this", and a bulk
    // click is not a human reading a warning.
    expect(measureRow("Profit").getAttribute("data-unconfirmed")).toBe("true");
    // ...and it is STILL VISIBLY WARNED. A skip whose evidence has been wiped
    // off the screen is its own kind of lie.
    expect(measureRow("Profit").textContent).toContain("warning");

    const status = byTestId("strategy-status").textContent ?? "";
    expect(status).toContain("Confirmed 2 rows.");
    expect(status).toContain("Skipped 1 row carrying a finding");
    expect(strategySet).not.toHaveBeenCalled();
  });

  it("still confirms the rows nothing is wrong with", async () => {
    await validated(TWO_UNCONFIRMED, [PROFIT_WARNING]);
    await click(button("Confirm all"));

    expect(measureRow("Returns").getAttribute("data-unconfirmed")).toBe("false");
    expect(
      container.querySelector('tr[data-strategy-path="tables[\'Dim\']"]')?.getAttribute("data-unconfirmed"),
    ).toBe("false");

    // And the skip is a skip, not a rollback: what it did confirm is what Save
    // sends, with the warned row still unreviewed.
    await click(button("Save"));
    expect(lastSaved().measures?.Returns.reviewed).toBe(true);
    expect(lastSaved().measures?.Profit.reviewed).toBe(false);
  });

  it("skips an entry with no values, for the reason per-row Confirm is disabled on one", async () => {
    await validated(
      {
        version: 1,
        measures: {
          Profit: { reviewed: false },
          Returns: { direction: "lowerIsBetter", reviewed: false },
        },
      },
      [],
    );
    await click(button("Confirm all"));

    const empty = measureRow("Profit");
    expect(empty.getAttribute("data-strategy-state")).toBe("empty");
    expect(empty.getAttribute("data-unconfirmed")).toBe("true");
    expect(byTestId("strategy-status").textContent).toContain("empty row");

    await click(button("Save"));
    expect(lastSaved().measures?.Profit.reviewed).toBe(false);
    expect(lastSaved().measures?.Returns.reviewed).toBe(true);
  });

  it("leaves per-row Confirm alone — a person reading one warned row may still confirm it", async () => {
    await validated(TWO_UNCONFIRMED, [PROFIT_WARNING]);

    const confirm = button("Confirm", measureRow("Profit"));
    expect(confirm.disabled).toBe(false);
    await click(confirm);

    expect(measureRow("Profit").getAttribute("data-unconfirmed")).toBe("false");
    await click(button("Save"));
    expect(lastSaved().measures?.Profit.reviewed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A band direction — a statement in two halves
// ---------------------------------------------------------------------------

describe("choosing a band direction", () => {
  function bandCell(measure: string): Element | null {
    return container.querySelector(`[data-testid="band-${measure}"]`);
  }

  it("switches the TARGET control into two bounds, and back again", async () => {
    await mount();
    // Before: the ordinary target field, and no bounds anywhere.
    expect(bandCell("Profit")).toBeNull();
    expect(targetInput("Profit").placeholder).toContain("kpi");

    await change(directionSelect("Profit"), "targetBand");

    // The bounds are IN the target control, not beside it: a document holding
    // `direction: targetBand` next to `target: 1000` has two answers and
    // nothing saying which one wins.
    expect(bandCell("Profit")).not.toBeNull();
    expect(byTestId<HTMLInputElement>("band-low-Profit").tagName).toBe("INPUT");
    expect(byTestId<HTMLInputElement>("band-high-Profit").tagName).toBe("INPUT");

    await change(directionSelect("Profit"), "higherIsBetter");
    expect(bandCell("Profit")).toBeNull();
    expect(targetInput("Profit").placeholder).toContain("kpi");
  });

  it("writes ONE band target from the two bounds, each with its own inclusivity", async () => {
    await mount();
    await change(directionSelect("Profit"), "targetBand");
    await commitText(byTestId<HTMLInputElement>("band-low-Profit"), "0.8");
    await commitText(byTestId<HTMLInputElement>("band-high-Profit"), "1.2");

    await click(button("Save"));
    // An ordinary band writes no inclusivity keys at all — absent means
    // inclusive, and a document that gains two keys per band just by being
    // opened is a document nobody can review a diff of.
    expect(lastSaved().measures?.Profit.target).toEqual({ type: "band", low: 0.8, high: 1.2 });

    await change(byTestId<HTMLSelectElement>("band-high-op-Profit"), "exclusive");
    await click(button("Save"));
    expect(lastSaved().measures?.Profit.target).toEqual({
      type: "band",
      low: 0.8,
      high: 1.2,
      highInclusive: false,
    });
  });

  it("writes NOTHING while only one bound is filled, and keeps the one that is", async () => {
    await mount();
    await change(directionSelect("Profit"), "targetBand");
    await commitText(byTestId<HTMLInputElement>("band-low-Profit"), "0.8");

    // A half band cannot be stored — `Target::Band` needs both — so the
    // incomplete state lives in the UI where it is visible and fixable, never
    // in the saved document where only the validator could catch it.
    await click(button("Save"));
    expect(lastSaved().measures?.Profit.target).toBeUndefined();
    // ...and the bound the person typed is still on screen. A field that
    // empties itself as you type reads as a value that was rejected.
    expect(byTestId<HTMLInputElement>("band-low-Profit").value).toBe("0.8");
  });

  it("surfaces the validator's refusal on the row, and blocks Save with it", async () => {
    vi.mocked(strategyValidate).mockResolvedValue({
      written: false,
      findings: [
        {
          severity: "error",
          code: "target-band-without-band",
          path: "measures['Profit'].direction",
          message: "'Profit' is judged against a band but the entry declares none",
        },
      ],
    });
    await mount();
    await change(directionSelect("Profit"), "targetBand");

    // The tab says it at the keystroke; the VALIDATOR is what makes it
    // impossible, and the wording points at that rather than pretending to be
    // the refusal itself.
    expect(byTestId("band-incomplete-Profit").textContent).toContain("both bounds");

    await click(button("Validate"));
    expect(measureRow("Profit").textContent).toContain("error");
    const save = [...container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").startsWith("Save"),
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.textContent).toContain("fix 1 error");
  });

  it("clears a target that is not a band, and says which value it took away", async () => {
    vi.mocked(strategyGet).mockResolvedValue({
      version: 1,
      measures: {
        Profit: { direction: "higherIsBetter", target: { type: "literal", value: 1000 }, reviewed: false },
        Returns: { direction: "lowerIsBetter", reviewed: true },
      },
    });
    await mount();
    await change(directionSelect("Profit"), "targetBand");

    // Silent collateral damage is what the aggregation cell's data-loss bug was
    // made of. The one edit that touches something it was not asked to touch
    // names the value it removed.
    const status = byTestId("strategy-status").textContent ?? "";
    expect(status).toContain("1000");
    expect(status).toContain("band");

    await click(button("Save"));
    expect(lastSaved().measures?.Profit.target).toBeUndefined();
    expect(lastSaved().measures?.Profit.direction).toBe("targetBand");
  });

  it("refuses a RULE whose band direction has no band ANYWHERE to land on", async () => {
    // The Rust rules loop never inspected `set.direction`, so this is the same
    // silent loss of favourability as on a measure entry, with no finding
    // anywhere to say so. The modal's target is one text field, so the refusal
    // is at the point the rule is built.
    const bandless: RuleDraft = {
      ...emptyRuleDraft(),
      id: "r1",
      measure: "Returns",
      direction: "targetBand",
    };
    const built = buildRuleFromDraft(overview(), bandless, emptyStrategyDoc());
    expect(built.ok).toBe(false);
    expect(built.ok === false && built.error).toContain("band:0.8,1.2");

    // SCOPE-BLIND, exactly as the validator is. A band on the measure's own
    // entry is a band this direction can land on, so a rule that only narrows
    // the direction is legal — refusing it here would be a stricter rule than
    // the backend's, which is worse than not checking at all.
    const withEntryBand = buildRuleFromDraft(overview(), bandless, {
      version: 1,
      measures: { Returns: { target: { type: "band", low: 0.8, high: 1.2 }, reviewed: false } },
    });
    expect(withEntryBand.ok).toBe(true);

    // ...and a rule carrying its own band is accepted, inclusivity and all.
    const withBand = buildRuleFromDraft(
      overview(),
      { ...bandless, target: "band:[0.8,1.2)" },
      emptyStrategyDoc(),
    );
    expect(withBand.ok).toBe(true);
    expect(withBand.ok === true && withBand.rule.set.target).toEqual({
      type: "band",
      low: 0.8,
      high: 1.2,
      highInclusive: false,
    });
  });

  it("does not let the version of a rule still in the document vouch for its own edit", async () => {
    // Editing `r1` to REMOVE its band must be refused, and it would not be if
    // the check counted the stored copy of the very rule being replaced.
    const stored: StrategyDoc = {
      version: 1,
      measures: { Returns: { reviewed: false } },
      rules: [
        {
          id: "r1",
          measure: "Returns",
          set: { direction: "targetBand", target: { type: "band", low: 0.8, high: 1.2 } },
        },
      ],
    };
    const built = buildRuleFromDraft(
      overview(),
      { ...emptyRuleDraft(), id: "r1", measure: "Returns", direction: "targetBand" },
      stored,
    );
    expect(built.ok).toBe(false);
    // A DIFFERENT rule's band still counts, because it is still there.
    const other = buildRuleFromDraft(
      overview(),
      { ...emptyRuleDraft(), id: "r2", measure: "Returns", direction: "targetBand" },
      stored,
    );
    expect(other.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Un-confirming, and what an edit does to a confirmation
// ---------------------------------------------------------------------------

describe("un-confirming a row", () => {
  it("is reachable from the CONFIRMED BADGE, not only from a bulk action", async () => {
    await mount();
    const row = measureRow("Returns");
    expect(row.getAttribute("data-strategy-state")).toBe("confirmed");

    // Confirm is a claim a human vouched for a value, and `Confirm all` can
    // make it across a whole grid in one click. An irreversible assertion a
    // mis-click can perform is a bad pair, so the way back is on the claim.
    await click(byTestId("unconfirm-Returns", row));

    const after = measureRow("Returns");
    expect(after.getAttribute("data-strategy-state")).toBe("inferred");
    expect(after.getAttribute("data-unconfirmed")).toBe("true");
    await click(button("Save"));
    expect(lastSaved().measures?.Returns.reviewed).toBe(false);
    // The VALUES are untouched: un-confirming withdraws agreement, it does not
    // edit anything.
    expect(lastSaved().measures?.Returns.direction).toBe("lowerIsBetter");
  });

  it("neither Confirm nor un-confirm re-authors a machine's guess", async () => {
    vi.mocked(strategyGet).mockResolvedValue({
      version: 1,
      measures: {
        Profit: { direction: "higherIsBetter", reviewed: false, source: "inferred" },
        Returns: { reviewed: true },
      },
    });
    await mount();
    await click(button("Confirm", measureRow("Profit")));
    await click(byTestId("unconfirm-Profit", measureRow("Profit")));

    // Round trip, back where it started. If Confirm authored, the row would
    // come back reading "set by you" about values no person ever typed.
    expect(measureRow("Profit").getAttribute("data-strategy-state")).toBe("inferred");
    await click(button("Save"));
    expect(lastSaved().measures?.Profit.source).toBe("inferred");
    expect(lastSaved().measures?.Profit.reviewed).toBe(false);
  });

  it("EDITING a confirmed row drops the confirmation and reads 'set by you'", async () => {
    await mount();
    expect(measureRow("Returns").getAttribute("data-strategy-state")).toBe("confirmed");

    await change(directionSelect("Returns"), "neutral");

    // The defect: the edit re-stamped `source: "authored"` and left
    // `reviewed: true` standing, so the row went on claiming a human had
    // vouched for a value no human had ever seen.
    const row = measureRow("Returns");
    expect(row.getAttribute("data-strategy-state")).toBe("authored");
    expect(row.textContent).toContain("set by you");
    expect(row.getAttribute("data-unconfirmed")).toBe("true");

    await click(button("Save"));
    expect(lastSaved().measures?.Returns.reviewed).toBe(false);
    expect(lastSaved().measures?.Returns.source).toBe("authored");
  });

  it("drops a TABLE's confirmation when one of its columns is re-roled", async () => {
    vi.mocked(strategyGet).mockResolvedValue({
      version: 1,
      tables: { Sales: { kind: "fact", reviewed: true, columns: { Amount: { role: "ignore" } } } },
    });
    await mount();
    const tableRow = (): Element | null =>
      container.querySelector('tr[data-strategy-path="tables[\'Sales\']"]');
    expect(tableRow()?.getAttribute("data-strategy-state")).toBe("confirmed");

    // The column map is part of what the table entry SAYS, so a column edit is
    // an edit to the entry a person confirmed.
    await click(byTestId("ignored-summary-Sales").querySelector("button") as HTMLButtonElement);
    await change(
      columnRow("Sales", "Amount")!.querySelector("select") as HTMLSelectElement,
      "analysis",
    );
    expect(tableRow()?.getAttribute("data-strategy-state")).toBe("authored");
  });
});

// ---------------------------------------------------------------------------
// A confirmation overtaken by inference
// ---------------------------------------------------------------------------

describe("a row inference has overtaken", () => {
  /** Returns was confirmed as lowerIsBetter; inference now says the opposite. */
  async function diverging(): Promise<void> {
    vi.mocked(strategyGet).mockResolvedValue({
      version: 1,
      measures: {
        Returns: { direction: "lowerIsBetter", reviewed: true },
        Profit: { direction: "higherIsBetter", reviewed: false },
      },
    });
    vi.mocked(strategyInfer).mockResolvedValue({
      version: 1,
      measures: {
        Returns: { direction: "higherIsBetter", unit: "percent", reviewed: false, source: "inferred" },
        Profit: { direction: "neutral", reviewed: false, source: "inferred" },
      },
    });
    await mount();
  }

  it("says BOTH answers, and applies neither on its own", async () => {
    await diverging();

    const note = byTestId("divergence-Returns", measureRow("Returns"));
    // "This is out of date" is not something a person can act on. Both values,
    // and the verb that says whose decision is being contradicted.
    expect(note.textContent).toContain("You confirmed");
    expect(note.textContent).toContain("lowerIsBetter");
    expect(note.textContent).toContain("higherIsBetter");
    // A field the row says NOTHING about is the commonest half of this pair —
    // a column was added after the row was confirmed.
    expect(note.textContent).toContain("(nothing)");
    expect(note.textContent).toContain("percent");

    // NOTHING is auto-applied: the row still says what the person confirmed,
    // and it is still confirmed.
    expect(measureRow("Returns").getAttribute("data-strategy-state")).toBe("confirmed");
    await click(button("Save"));
    expect(lastSaved().measures?.Returns.direction).toBe("lowerIsBetter");
  });

  it("takes inference's values when asked, and the row goes back to being a proposal", async () => {
    await diverging();
    await click(byTestId("take-inference-Returns", measureRow("Returns")));

    // The values are the machine's again, so the badge says so — and nobody has
    // vouched for the NEW values, so the confirmation does not carry over.
    const row = measureRow("Returns");
    expect(row.getAttribute("data-strategy-state")).toBe("inferred");
    expect(container.querySelector('[data-testid="divergence-Returns"]')).toBeNull();

    await click(button("Save"));
    expect(lastSaved().measures?.Returns.direction).toBe("higherIsBetter");
    expect(lastSaved().measures?.Returns.unit).toBe("percent");
    expect(lastSaved().measures?.Returns.reviewed).toBe(false);
    expect(lastSaved().measures?.Returns.source).toBe("inferred");
  });

  it("says nothing about a row nobody has decided on", async () => {
    await diverging();
    // Profit is an unconfirmed guess that disagrees with today's guess. That is
    // a stale draft, not a decision anybody needs interrupting over.
    expect(measureRow("Profit").getAttribute("data-strategy-state")).toBe("inferred");
    expect(container.querySelector('[data-testid="divergence-Profit"]')).toBeNull();
  });

  it("says nothing at all when no draft could be built", async () => {
    vi.mocked(strategyInfer).mockRejectedValue(new Error("the model has no measure ASTs"));
    const ctx = ctxFor();
    await mount(ctx);

    // Returns is confirmed and there is nothing to compare it against. A tab
    // that cannot infer simply shows no divergences — it never guesses at one.
    expect(container.querySelector('[data-testid="divergence-Returns"]')).toBeNull();
    expect(ctx.reportError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The model-wide panel
// ---------------------------------------------------------------------------

describe("the model panel", () => {
  function axisSelect(): HTMLSelectElement {
    return byTestId<HTMLSelectElement>("model-default-time-axis");
  }

  it("edits the time axis through the document helper, and writes nothing until Save", async () => {
    await mount();

    // A picker over the model's own columns, never free text: a typo here is
    // not a broken axis, it is an axis that silently disables every time fact.
    expect(axisSelect().tagName).toBe("SELECT");
    await change(axisSelect(), "Sales[DeptKey]");
    expect(strategySet).not.toHaveBeenCalled();

    await click(button("Save"));
    expect(lastSaved().model?.defaultTimeAxis).toBe("Sales[DeptKey]");
    // The rest of the document is untouched by a model-level edit.
    expect(lastSaved().measures?.Returns.direction).toBe("lowerIsBetter");
  });

  it("offers the marked date table's columns first without hiding the others", async () => {
    const withCalendar = overview();
    withCalendar.tables = [
      ...withCalendar.tables,
      table("Calendar", [
        ["Day", "Date"],
        ["MonthName", "String"],
      ]),
    ];
    withCalendar.dateTable = "Calendar";
    await mount(ctxFor(withCalendar));

    const groups = [...axisSelect().querySelectorAll("optgroup")];
    expect(groups[0].getAttribute("label")).toContain("Calendar");
    // The WHOLE date table, not its date-typed columns alone: the validator
    // compares the axis's TABLE, and a calendar's key column is routinely an
    // integer.
    expect([...groups[0].querySelectorAll("option")].map((o) => o.value)).toEqual([
      "Calendar[Day]",
      "Calendar[MonthName]",
    ]);
    // A PREFERENCE, not a filter. The validator only WARNS about an axis
    // outside the marked date table, so a model whose time axis really does
    // live on the fact table must still be authorable here.
    expect([...axisSelect().querySelectorAll("option")].map((o) => o.value)).toContain(
      "Sales[Amount]",
    );
  });

  it("refuses a fiscal year start that is not MM-DD, and says why", async () => {
    await mount();
    const field = byTestId<HTMLInputElement>("model-fiscal-year-start");

    // The commonest wrong answer: a fiscal year start RECURS, so it carries no
    // year. Nothing reads the field yet, so what a malformed value buys today
    // is a stored trap that springs on whoever wires it up — which is the
    // reason to refuse it at the keystroke rather than at Save.
    await commitText(field, "2026-04-01");
    const message = byTestId("model-fiscal-year-start-error").textContent ?? "";
    expect(message).toContain("MM-DD");
    expect(message).toContain("2026-04-01");
    // Refused means NOT WRITTEN — and the typed text stays, because a value
    // that silently reverts reads as accepted.
    expect(field.value).toBe("2026-04-01");
    await click(button("Save"));
    expect(lastSaved().model?.fiscalYearStart).toBeUndefined();
  });

  it("takes an MM-DD fiscal year start", async () => {
    await mount();
    await commitText(byTestId<HTMLInputElement>("model-fiscal-year-start"), "04-01");
    expect(container.querySelector('[data-testid="model-fiscal-year-start-error"]')).toBeNull();

    await click(button("Save"));
    expect(lastSaved().model?.fiscalYearStart).toBe("04-01");
  });

  it("refuses 02-31 on screen while still taking 02-29", async () => {
    // `02-31` is ten characters of correct SHAPE naming a day no year has, so
    // the shape message is the wrong one to show and a shape-only check would
    // have stored it. `MonthDay::new` refuses it at deserialize, which costs
    // the whole document rather than this field — hence the keystroke refusal.
    //
    // `02-29` is the case that stops this becoming a full date check: an MM-DD
    // names no year, so whether the 29th of February exists is unanswerable
    // here and the backend accepts it. A tab stricter than Save is a second
    // rule nobody wrote down. (Which months have which ceilings is diffed
    // against the Rust table in lib/strategyTypes.test.ts; this row is about
    // what the PANEL does with the answer.)
    await mount();
    const field = byTestId<HTMLInputElement>("model-fiscal-year-start");

    await commitText(field, "02-31");
    const message = byTestId("model-fiscal-year-start-error").textContent ?? "";
    expect(message).toContain("02-31");
    expect(message).toContain("29");
    await click(button("Save"));
    expect(lastSaved().model?.fiscalYearStart).toBeUndefined();

    await commitText(field, "02-29");
    expect(container.querySelector('[data-testid="model-fiscal-year-start-error"]')).toBeNull();
    await click(button("Save"));
    expect(lastSaved().model?.fiscalYearStart).toBe("02-29");
  });

  it("marks exactly the two fields nothing reads yet, and neither of the two that are read", async () => {
    await mount();

    // An EQUALITY, not two presence checks. `defaultTimeAxis` and `priority`
    // are both consulted, so a note on either of them would be a fresh lie; and
    // when one of these two fields finally acquires a reader, its note has to
    // go, which only an exhaustive assertion notices.
    const marked = [...container.querySelectorAll("[data-inert-field]")]
      .map((el) => el.getAttribute("data-inert-field"))
      .sort();
    // `reportingCurrency` is NOT here because it was DELETED rather than
    // labelled — it had no reader and none coming, and deleting is the cheaper
    // reversal. `unit` and `cadence` are marked in the measures grid's header
    // instead of per row, so they appear once each.
    expect(marked).toEqual(["cadence", "fiscalYearStart", "unit"]);
  });

  it("says an inert value is SAVED as well as unread, in visible text rather than a tooltip", async () => {
    await mount();
    // Both halves. "Nothing reads this" alone reads as "typing here is
    // pointless", and the value is in fact stored and carried with the model.
    const note = byTestId("model-not-consulted-fiscalYearStart");
    expect(note.textContent).toContain("Saved");
    expect(note.textContent).toContain("nothing reads it yet");
    // On screen, not hidden in a title: a tooltip is not a promise anyone reads
    // before typing, which is the entire objection this note answers.
    expect(note.tagName).not.toBe("INPUT");
  });

  it("shows the priority order and can clear it, without pretending to reorder it", async () => {
    vi.mocked(strategyGet).mockResolvedValue({
      ...MIXED_DOC,
      model: { priority: ["Profit", "Returns"] },
    });
    await mount();

    const list = byTestId("model-priority");
    expect([...list.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "Profit",
      "Returns",
    ]);

    await click(button("Clear order", list));
    expect(list.querySelectorAll("li").length).toBe(0);
    await click(button("Save"));
    expect(lastSaved().model?.priority).toBeUndefined();
  });

  it("renders a model finding beside the field it names", async () => {
    vi.mocked(strategyValidate).mockResolvedValue({
      written: false,
      findings: [
        {
          severity: "error",
          code: "unknown-column",
          path: "model.defaultTimeAxis",
          message: "the default time axis 'Gone[Day]' is not a column in the model",
        },
      ],
    });
    await mount();
    await click(button("Validate"));

    const panel = byTestId("model-panel");
    expect(panel.textContent).toContain("unknown-column");
    expect(panel.textContent).toContain("is not a column in the model");
  });

  it("carries the same badge a row does, and Confirm flips it", async () => {
    // `defaultTimeAxis` is a value guessed from a calendar that was itself
    // guessed. The insights output announces that guess; until now the one
    // place a person could ACCEPT it did not.
    vi.mocked(strategyGet).mockResolvedValue({
      ...MIXED_DOC,
      model: { defaultTimeAxis: "Sales[DeptKey]", reviewed: false },
    });
    await mount();

    const panel = (): HTMLElement => byTestId("model-panel");
    expect(panel().getAttribute("data-strategy-state")).toBe("inferred");
    expect(panel().textContent).toContain("inferred");

    await click(button("Confirm", panel()));
    expect(panel().getAttribute("data-strategy-state")).toBe("confirmed");

    await click(button("Save"));
    expect(lastSaved().model?.reviewed).toBe(true);
    // Confirming agrees with the values; it does not write them. The axis is
    // untouched and the block still says a machine chose it.
    expect(lastSaved().model?.defaultTimeAxis).toBe("Sales[DeptKey]");
    expect(lastSaved().model?.source).toBeUndefined();
  });

  it("un-confirms from the badge, and an edit drops the confirmation by itself", async () => {
    vi.mocked(strategyGet).mockResolvedValue({
      ...MIXED_DOC,
      model: { defaultTimeAxis: "Sales[DeptKey]", reviewed: true },
    });
    await mount();
    const panel = (): HTMLElement => byTestId("model-panel");

    await click(byTestId("unconfirm-model", panel()));
    expect(panel().getAttribute("data-strategy-state")).toBe("inferred");

    await click(button("Confirm", panel()));
    expect(panel().getAttribute("data-strategy-state")).toBe("confirmed");

    // ...and then an actual edit: the block cannot go on claiming a human
    // vouched for an axis they have not seen.
    await change(axisSelect(), "Sales[Amount]");
    expect(panel().getAttribute("data-strategy-state")).toBe("authored");
    await click(button("Save"));
    expect(lastSaved().model?.reviewed).toBe(false);
    expect(lastSaved().model?.source).toBe("authored");
  });

  it("offers nothing to confirm when the block says nothing", async () => {
    await mount();
    // MIXED_DOC carries no model block at all. Confirming four empty boxes
    // agrees to nothing, exactly as on an empty row.
    const panel = byTestId("model-panel");
    expect(panel.getAttribute("data-strategy-state")).toBe("empty");
    expect(button("Confirm", panel).disabled).toBe(true);
  });

  it("marks a confirmed axis that inference no longer proposes, and can take the new one", async () => {
    vi.mocked(strategyGet).mockResolvedValue({
      ...MIXED_DOC,
      model: { defaultTimeAxis: "Sales[DeptKey]", reviewed: true },
    });
    vi.mocked(strategyInfer).mockResolvedValue({
      ...INFERRED_DRAFT,
      model: { defaultTimeAxis: "Dim[DeptKey]", reviewed: false, source: "inferred" },
    });
    await mount();

    const note = byTestId("divergence-model", byTestId("model-panel"));
    expect(note.textContent).toContain("Sales[DeptKey]");
    expect(note.textContent).toContain("Dim[DeptKey]");

    await click(byTestId("take-inference-model", byTestId("model-panel")));
    expect(axisSelect().value).toBe("Dim[DeptKey]");
    await click(button("Save"));
    expect(lastSaved().model?.defaultTimeAxis).toBe("Dim[DeptKey]");
    expect(lastSaved().model?.reviewed).toBe(false);
  });

  it("keeps an axis the model no longer has selected, and says it is gone", async () => {
    vi.mocked(strategyGet).mockResolvedValue({
      ...MIXED_DOC,
      model: { defaultTimeAxis: "Gone[Day]" },
    });
    await mount();

    // A <select> whose value matches no option renders blank, which would read
    // as "nobody set an axis" and erase the setting on the next edit.
    expect(axisSelect().value).toBe("Gone[Day]");
    expect(axisSelect().textContent).toContain("not a column in this model");
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
  it("shows a stored strategy as it is, and never installs a draft over it", async () => {
    await mount();
    expect(strategyGet).toHaveBeenCalledTimes(1);
    // Inference IS run for a stored document — its draft is the other half of
    // the live divergence check, and it is model-only, so it costs a call and
    // no lock. What must never happen is the draft being INSTALLED: the stored
    // document is the authority, so Returns is still confirmed and Profit still
    // says what the document says, not what the draft proposes.
    expect(strategyInfer).toHaveBeenCalledWith("conn-1");
    expect(measureRow("Returns").getAttribute("data-unconfirmed")).toBe("false");
    expect(directionSelect("Profit").value).toBe("higherIsBetter");
    // ...and the tab does not announce a draft, because it is not showing one.
    expect(container.querySelector('[data-testid="strategy-status"]')).toBeNull();
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

    // The teeth are the CONFIRMATION, not the call count: inference runs on
    // every load now (it is what divergence is measured against), so the thing
    // that must not happen is the second draft being INSTALLED over the one the
    // user has been working on.
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
// The rules section — discoverable, or the path goes untested
// ---------------------------------------------------------------------------

describe("the rules section with no rules in it", () => {
  it("invites the action and names what a rule DOES, rather than defining one", async () => {
    await mount();
    const emptyState = byTestId("rules-empty");
    const text = emptyState.textContent ?? "";

    // Concrete things a person can want, not a category. The old sentence —
    // "A rule annotates facts in a scope; it never generates one." — is true
    // and teaches nobody what to do with the feature.
    expect(text).toContain("direction");
    expect(text).toContain("target");
    expect(text).toContain("materiality");
    // The clause people actually get wrong survives; it just no longer stands
    // in for the invitation.
    expect(text).toContain("never generates one");
  });

  it("carries the action itself, so the 11px header button is not the only way in", async () => {
    await mount();

    const add = byTestId<HTMLButtonElement>("rules-empty-add", byTestId("rules-empty"));
    expect(add.disabled).toBe(false);
    await click(add);

    // It opens the same editor the header button opens — the invitation is the
    // real action, not a label pointing at one somewhere else.
    expect(container.textContent).toContain("New rule");
    expect(button("Add scope column")).not.toBeNull();
  });

  it("explains a grey add control instead of only greying it out", async () => {
    await mount(ctxFor(overview(), true));

    expect(byTestId<HTMLButtonElement>("rules-empty-add").disabled).toBe(true);
    expect(button("Add rule").disabled).toBe(true);
    // THE POINT. A reviewer read a grey button with no sentence beside it and
    // concluded rules could not be authored at all; nobody then exercised the
    // rules path, and a 100% path mismatch in its findings went unnoticed.
    const why = byTestId("rules-add-blocked").textContent ?? "";
    expect(why).toContain("read-only");
    expect(why).toContain("subscribed");
    // One sentence, beside the control a person is looking at — not one under
    // the heading and another in the empty state saying the same thing.
    expect(container.querySelectorAll('[data-testid="rules-add-blocked"]').length).toBe(1);
  });

  it("prefers the host's own read-only reason over a guess made here", async () => {
    const subscribed = overview();
    subscribed.readOnlyReason = "this model came from the 'Nordics KPIs' application";
    await mount(ctxFor(subscribed, true));

    // The banner above already knows why this model refuses edits. A second
    // sentence invented in the Strategy tab would be a second source of truth
    // that drifts from it.
    expect(byTestId("rules-add-blocked").textContent).toContain("Nordics KPIs");
  });

  it("says nothing at all when the add control is live", async () => {
    await mount();
    expect(container.querySelector('[data-testid="rules-add-blocked"]')).toBeNull();
  });
});

describe("why Add rule is grey", () => {
  const LIVE = { readOnly: false, readOnlyReason: null, loaded: true, busy: false };

  it("distinguishes a read-only model from a document that has not arrived", async () => {
    const notLoaded = addRuleBlockedReason({ ...LIVE, loaded: false });
    const readOnly = addRuleBlockedReason({ ...LIVE, readOnly: true });

    expect(notLoaded).not.toBe(readOnly);
    // One of the two fixes itself in a second; the other never will, and
    // sending someone to look for a subscription that is not there is the worse
    // of the two wrong answers.
    expect(notLoaded).toContain("has not loaded");
    expect(readOnly).toContain("read-only");
  });

  it("answers 'not loaded' first for a read-only model that has not loaded either", async () => {
    expect(addRuleBlockedReason({ readOnly: true, readOnlyReason: null, loaded: false, busy: false })).toBe(
      addRuleBlockedReason({ ...LIVE, loaded: false }),
    );
  });

  it("names the running action rather than the model when the tab is merely busy", async () => {
    const busy = addRuleBlockedReason({ ...LIVE, busy: true });
    expect(busy).toContain("still running");
    expect(busy).not.toContain("read-only");
  });

  it("is null when nothing is in the way, so a live control carries no apology", async () => {
    expect(addRuleBlockedReason(LIVE)).toBeNull();
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
    const built = buildRuleFromDraft(
      overview(),
      {
        ...emptyRuleDraft(),
        id: "r1",
        measure: "Returns",
        scope: [{ column: "Dim[Deptt]", kind: "members", members: "Refunds", from: "", to: "" }],
      },
      // The document is only read by the band check, and this rule declares no
      // band direction — an empty one keeps that irrelevance visible.
      emptyStrategyDoc(),
    );
    expect(built.ok).toBe(false);
    expect(built.ok === false && built.error).toContain("'Dim[Deptt]' is not a column in this model");
  });

  it("accepts a scope column the model does have", async () => {
    const built = buildRuleFromDraft(
      overview(),
      {
        ...emptyRuleDraft(),
        id: "r1",
        measure: "Returns",
        direction: "higherIsBetter",
        scope: [
          { column: "Dim[Dept]", kind: "members", members: "Refunds, Retail", from: "", to: "" },
        ],
      },
      emptyStrategyDoc(),
    );
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
    const built = buildRuleFromDraft(
      overview(),
      { ...emptyRuleDraft(), id: "r1", measure: "Ghost" },
      emptyStrategyDoc(),
    );
    expect(built.ok).toBe(false);
    expect(built.ok === false && built.error).toContain("'Ghost' is not a measure in this model");
  });

  // -------------------------------------------------------------------------
  // Scope date bounds — the boxes behind `aria-label="Scope from"` are plain
  // text, and `IsoDate` validates in `Deserialize`. A bad bound saved here does
  // not earn a finding on this rule; it makes the WHOLE document unreadable.
  // -------------------------------------------------------------------------

  function dateRuleDraft(from: string, to: string): Parameters<typeof buildRuleFromDraft>[1] {
    return {
      ...emptyRuleDraft(),
      id: "r1",
      measure: "Returns",
      scope: [{ column: "Dim[Dept]", kind: "dateRange", members: "", from, to }],
    };
  }

  it("refuses a scope date that has the right shape and is not a date", async () => {
    // `2025-13-45` counts ten characters and two hyphens and is nothing on a
    // calendar. The old check asked only whether `from` was non-empty.
    const built = buildRuleFromDraft(overview(), dateRuleDraft("2025-13-45", ""), emptyStrategyDoc());
    expect(built.ok).toBe(false);
    expect(built.ok === false && built.error).toContain("2025-13-45");
    expect(built.ok === false && built.error).toContain("YYYY-MM-DD");
  });

  it("refuses a scope date whose day does not exist in its month", async () => {
    // The day-in-month case, which a `1..=31` range check waves through:
    // February never has 31 days in any year.
    const built = buildRuleFromDraft(overview(), dateRuleDraft("2026-02-31", ""), emptyStrategyDoc());
    expect(built.ok).toBe(false);
    expect(built.ok === false && built.error).toContain("2026-02-31");
  });

  it("refuses a malformed END bound as readily as a malformed start", async () => {
    // The end bound is optional, and "optional" was doing the work of
    // "unchecked" — a present-but-malformed `to` reached the document.
    const built = buildRuleFromDraft(
      overview(),
      dateRuleDraft("2025-01-01", "2025-06-31"),
      emptyStrategyDoc(),
    );
    expect(built.ok).toBe(false);
    expect(built.ok === false && built.error).toContain("2025-06-31");
  });

  it("takes a real date range, and an open-ended one", async () => {
    const bounded = buildRuleFromDraft(
      overview(),
      dateRuleDraft("2024-02-29", "2025-06-30"),
      emptyStrategyDoc(),
    );
    // A LEAP DAY, deliberately: 2024-02-29 exists and a naive "February has 28
    // days" check would refuse a legal bound, which is the opposite failure and
    // just as bad — the tab would be a second, stricter rule nobody wrote down.
    expect(bounded.ok).toBe(true);
    expect(bounded.ok === true && bounded.rule.scope).toEqual({
      "Dim[Dept]": { from: "2024-02-29", to: "2025-06-30" },
    });

    const open = buildRuleFromDraft(overview(), dateRuleDraft("2025-01-01", ""), emptyStrategyDoc());
    expect(open.ok).toBe(true);
    // No `to` key at all, not `to: undefined`: every container carries
    // `deny_unknown_fields` and an explicit undefined is what serialization
    // turns into a null the backend refuses.
    expect(open.ok === true && open.rule.scope).toEqual({ "Dim[Dept]": { from: "2025-01-01" } });
  });

  it("leaves 'from after to' to the validator rather than refusing it here", async () => {
    // NOT a form question. The backend raises `empty-scope` as an ERROR against
    // the saved document and explains it; refusing it at this gate would be a
    // second rule, and it would refuse a rule Save accepts.
    const built = buildRuleFromDraft(
      overview(),
      dateRuleDraft("2025-06-30", "2025-01-01"),
      emptyStrategyDoc(),
    );
    expect(built.ok).toBe(true);
  });

  it("still refuses an empty from date, with the sentence it always had", async () => {
    const built = buildRuleFromDraft(overview(), dateRuleDraft("", "2025-06-30"), emptyStrategyDoc());
    expect(built.ok).toBe(false);
    expect(built.ok === false && built.error).toContain("needs a from date");
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
    // The load's own inference (the divergence reference) has already run, so
    // "did the button infer?" is a question about the calls AFTER the mount.
    const onMount = vi.mocked(strategyInfer).mock.calls.length;
    await click(button("Infer"));

    expect(confirmAsync).toHaveBeenCalledTimes(1);
    expect(vi.mocked(strategyInfer).mock.calls.length).toBe(onMount);
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
    const onMount = vi.mocked(strategyInfer).mock.calls.length;
    await click(button("Infer"));
    // ONE source of truth, not one call: the button re-asks the backend rather
    // than re-deriving anything here. A second (weaker) frontend inferrer is
    // how the button and the first view came to disagree about what "inferred"
    // means, and the guard against it is that every draft in this tab arrives
    // from `op: "infer"` — this one, and the load's divergence reference.
    expect(vi.mocked(strategyInfer).mock.calls.length).toBe(onMount + 1);
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

// ---------------------------------------------------------------------------
// The table kind — whose answer is on screen, and what the model disproves
// ---------------------------------------------------------------------------

describe("the table kind", () => {
  /** One table row's kind cell. */
  function kindCell(table: string): HTMLElement {
    return byTestId<HTMLElement>(`table-kind-${table}`);
  }

  function kindSelect(table: string): HTMLSelectElement {
    return kindCell(table).querySelector("select") as HTMLSelectElement;
  }

  function option(table: string, kind: string): HTMLOptionElement {
    const hit = [...kindSelect(table).options].find((o) => o.value === kind);
    if (!hit) throw new Error(`no '${kind}' option on ${table}`);
    return hit;
  }

  it("tells a kind a person CHOSE from one the engine merely detected", async () => {
    // The fixture document names Dim a dimension and says nothing about Sales;
    // inference reads Sales as a fact. Before `kind` did anything the two
    // rendered identically — and they must not, because the backend HONOURS
    // the first (it stops classifying that table for itself) and DISREGARDS
    // the second, re-deriving it from today's relationship graph.
    await mount();
    await settle();

    expect(kindCell("Dim").getAttribute("data-kind-origin")).toBe("chosen");
    expect(byTestId("kind-origin-Dim").textContent).toContain("chosen");

    expect(kindCell("Sales").getAttribute("data-kind-origin")).toBe("detected");
    expect(byTestId("kind-origin-Sales").textContent).toContain("detected");
  });

  it("shows the detected kind in the EMPTY option and writes nothing for it", async () => {
    // The same discipline the inherited direction follows: a blank cell reads
    // as "nobody has decided", which for `kind` stopped being true — the
    // backend classifies every table anyway. Showing it must not be the same
    // as storing it, or a machine's reading would become a person's statement
    // by being looked at.
    await mount();
    await settle();

    expect(kindSelect("Sales").value).toBe("");
    expect([...kindSelect("Sales").options][0].textContent).toContain("fact — detected");
    expect(strategySet).not.toHaveBeenCalled();
  });

  it("says nothing at all about a table neither the document nor inference names", async () => {
    // The third state. A badge here would claim an opinion nobody has.
    vi.mocked(strategyGet).mockResolvedValue({ version: 1 });
    vi.mocked(strategyInfer).mockResolvedValue({ version: 1 });
    await mount();
    await settle();

    expect(kindCell("Sales").getAttribute("data-kind-origin")).toBe("none");
    expect(container.querySelector('[data-testid="kind-origin-Sales"]')).toBeNull();
  });

  it("REFUSES a lookup claim the topology disproves, in the dropdown, with the reason", async () => {
    // Sales is the FROM side of the fixture's only relationship, so filters
    // flow out of it and nothing can look it up. `calendar` and `dimension`
    // both assert the opposite, and the validator answers that with a
    // Save-blocking error — so the cheapest fix is to make the state hard to
    // reach rather than to explain a whole-document refusal afterwards.
    await mount();
    await settle();

    expect(option("Sales", "calendar").disabled).toBe(true);
    expect(option("Sales", "dimension").disabled).toBe(true);
    expect(option("Sales", "calendar").title).toContain("'Dim'");
    // MEANING CHANGE, DELIBERATE. These three used to be asserted REACHABLE, on
    // the rule that the tab must never be stricter than the backend. That rule
    // still governs `tableKindTopologyRefusal`; this is a second, separate
    // reason — `fact`, `bridge` and `other` reach nothing on the run path, so
    // the backend accepts them and IGNORES them, and a control that takes a
    // value nothing will read is the defect. Disabled, not dropped, because an
    // inferred draft stores one of these on nearly every table.
    for (const inert of ["fact", "bridge", "other"]) {
      expect(option("Sales", inert).disabled, `'${inert}' is unreadable`).toBe(true);
      expect(option("Sales", inert).title).toContain("Only 'calendar' and 'dimension'");
    }
    // ...and the two the engine DOES read stay reachable on a table whose
    // topology permits them, which is what makes this a restriction and not a
    // removal.
    expect(option("Dim", "calendar").disabled).toBe(false);
    expect(option("Dim", "dimension").disabled).toBe(false);
  });

  it("surfaces the validator's topology refusal on the row, and blocks Save with it", async () => {
    // The dropdown makes the state hard to reach; the VALIDATOR is what makes
    // it impossible, and a hand-edited document can arrive already in it. The
    // finding's path is one level BELOW the row's, which a bare equality match
    // would strand.
    vi.mocked(strategyGet).mockResolvedValue({
      version: 1,
      tables: { Sales: { kind: "calendar", reviewed: false, source: "authored" } },
    });
    vi.mocked(strategyValidate).mockResolvedValue({
      written: false,
      findings: [
        {
          severity: "error",
          code: "authored-kind-contradicts-topology",
          path: "tables['Sales'].kind",
          message:
            "'Sales' is declared calendar, but nothing looks 'Sales' up — it is the FROM side of a relationship to 'Dim'",
        },
      ],
    });
    await mount();
    await settle();
    await click(button("Validate"));

    // On the ROW, and specifically in the cell the finding names.
    expect(kindCell("Sales").textContent).toContain("error");

    const save = [...container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").startsWith("Save"),
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.textContent).toContain("fix 1 error");
  });
});

// ---------------------------------------------------------------------------
// The confirmation column stays reachable
// ---------------------------------------------------------------------------

describe("the reviewed column", () => {
  /** Every cell of one row, in document order. */
  function cells(row: Element): HTMLTableCellElement[] {
    return [...row.children].filter(
      (c) => c.tagName === "TD" || c.tagName === "TH",
    ) as HTMLTableCellElement[];
  }

  it("is PINNED to the trailing edge in the measures grid, and is still last", async () => {
    // Eleven columns in an `overflow-x: auto` card pushed `reviewed` off the
    // right-hand edge, and it is the column a person works DOWN while
    // confirming a draft. The assertion is on the MECHANISM — sticky, pinned
    // right — because a width is a number this test would have to be retuned
    // for every column anybody adds.
    await mount();
    await settle();

    const row = measureRow("Profit");
    const last = cells(row)[cells(row).length - 1];
    expect(last.getAttribute("data-sticky")).toBe("reviewed");
    expect(last.style.position).toBe("sticky");
    expect(last.style.right).toBe("0px");
    // The Confirm control is IN the pinned cell, which is the whole point.
    expect(last.querySelector("button")).not.toBeNull();
    // A sticky cell floats over the columns sliding beneath it, so it must be
    // opaque — `rowTone` gives `transparent` for three of its four states.
    expect(last.style.background).not.toBe("");
    expect(last.style.background).not.toBe("transparent");
  });

  it("pins the measures HEADER cell too, so the pinned column keeps its name", async () => {
    await mount();
    await settle();
    const header = container.querySelector('th[data-sticky="reviewed"]') as HTMLTableCellElement;
    expect(header.textContent).toBe("reviewed");
    expect(header.style.position).toBe("sticky");
    expect(header.style.right).toBe("0px");
  });

  it("is pinned in the TABLES grid as well, where the same confirming happens", async () => {
    await mount();
    await settle();

    const row = container.querySelector(
      "tr[data-strategy-path=\"tables['Dim']\"]",
    ) as HTMLElement;
    const last = cells(row)[cells(row).length - 1];
    expect(last.getAttribute("data-sticky")).toBe("reviewed");
    expect(last.style.position).toBe("sticky");
    expect(last.style.right).toBe("0px");
    expect(last.querySelector("button")).not.toBeNull();
  });

  it("leaves every other column exactly where it was", async () => {
    // "Do not change what any column contains." Pinning is a style on ONE
    // cell; a reordering would have moved the answer in front of the values it
    // answers for, and this is what tells the two apart.
    await mount();
    await settle();
    const headerRow = [...container.querySelectorAll("thead tr")].find(
      (r) => r.firstElementChild?.textContent === "measure",
    );
    expect(headerRow, "the measures grid must still have a header row").toBeDefined();
    // The `*` on two of them is the not-yet-consulted mark, said once in the
    // header rather than once per row. It is part of the header's text, so it
    // is asserted here rather than stripped — a silent strip would let the mark
    // disappear without this noticing.
    expect([...headerRow!.children].map((h) => h.textContent)).toEqual([
      "measure",
      "direction",
      "aggregation",
      "unit*",
      "target",
      "materiality",
      "cadence*",
      "priority",
      "analysis dimensions",
      "never slice by",
      "reviewed",
    ]);
  });
});

// ---------------------------------------------------------------------------
// suppress — a closed set, so the control is the vocabulary
// ---------------------------------------------------------------------------

describe("the rule's suppress field", () => {
  it("offers the eight fact kinds as toggles, with no free text to mistype into", async () => {
    // It was a text box. Since `suppress` became `Vec<SuppressibleFactKind>` a
    // near-miss is not a suppression that does nothing — the document fails
    // serde and the backend discards the WHOLE strategy, so a box that can
    // type an unsaveable value is worse than the untyped version it replaced.
    await mount();
    await settle();
    await click(button("Add rule"));

    const picker = byTestId<HTMLElement>("suppress-picker");
    const boxes = [...picker.querySelectorAll("input")] as HTMLInputElement[];
    expect(boxes.map((b) => b.type)).toEqual(new Array(8).fill("checkbox"));
    expect(picker.textContent).toContain("definitionalDriver");
    expect(picker.textContent).toContain("memberMove");
    // The example this field's hint used to offer, and a value nothing emits.
    expect(picker.textContent).not.toContain("outlier");
  });

  it("writes the chosen kinds in VOCABULARY order, whatever order they were clicked", async () => {
    // A set of kinds has to produce one string, or two people who chose the
    // same suppressions get two different documents and a diff nobody can read.
    await mount();
    await settle();
    await click(button("Add rule"));

    await click(byTestId("suppress-trend"));
    await click(byTestId("suppress-contribution"));

    const id = container.querySelector(
      'input[placeholder="refunds-dept"]',
    ) as HTMLInputElement;
    await change(id, "r1");
    const measure = [...container.querySelectorAll("select")].find(
      (s) => s.options[0]?.textContent === "(select measure)",
    ) as HTMLSelectElement;
    await change(measure, "Returns");
    await click(button("OK"));
    await click(button("Save"));

    expect(lastSaved().rules?.[0]?.set.suppress).toEqual(["contribution", "trend"]);
  });

  it("refuses a RESTORED draft carrying a spelling the picker can no longer produce", async () => {
    // Unsaved rule drafts are persisted, so a draft written before the closed
    // set existed outlives the control that accepted it. This is the only
    // route a bad kind still has, and it must not reach a backend that answers
    // an unknown variant by discarding the entire document.
    const built = buildRuleFromDraft(
      overview(),
      { ...emptyRuleDraft(), id: "r1", measure: "Returns", suppress: "trend,contribtion" },
      emptyStrategyDoc(),
    );
    expect(built.ok).toBe(false);
    expect(built.ok === false && built.error).toContain("Did you mean 'contribution'?");
  });
});
