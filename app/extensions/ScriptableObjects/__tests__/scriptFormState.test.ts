//! FILENAME: app/extensions/ScriptableObjects/__tests__/scriptFormState.test.ts
// PURPOSE: The pure state half of the TypeScript Forms renderer — what a widget
//          starts as, what blocks Submit, what the SCRIPT finally receives, how
//          a patch lands, and which widgets the user actually touched.
// CONTEXT: The dirty set decides which refreshed seeds may overwrite what the
//          user typed, and the currency trap is the case that matters: a bound
//          cell seeds { value: 1234.5, display: "£1,234.50" }; the widget shows
//          the display and edits the value, and an UNTOUCHED widget must not
//          read as dirty merely because the two are spelled differently.

import { describe, it, expect } from "vitest";
import type { FormSeed, FormSpec } from "@api/scriptHost/scriptFormSpec";
import {
  applyFormPatch,
  buildFormResult,
  coerceValue,
  collectInputs,
  collectWidgets,
  containerSuppressed,
  dirtySet,
  effectiveOptions,
  initialFormValues,
  resolveOptions,
  sameFormValue,
  serialToIso,
  validateFormValues,
  validateInputValue,
  type FormInputWidget,
} from "../lib/scriptFormState";

const spec: FormSpec = {
  title: "Order",
  children: [
    { type: "label", text: "Heading", style: "heading" },
    { type: "textbox", name: "customer", label: "Customer", required: true, maxLength: 10 },
    {
      type: "group",
      title: "Money",
      children: [
        { type: "number", name: "amount", label: "Amount", min: 0, max: 10_000 },
        { type: "date", name: "due", label: "Due", min: "2026-01-01", max: "2026-12-31" },
      ],
    },
    {
      type: "tabs",
      pages: [
        {
          title: "A",
          children: [
            { type: "checkbox", name: "agree", label: "I agree", required: true },
            { type: "toggle", name: "urgent", label: "Urgent", default: true },
          ],
        },
        {
          title: "B",
          children: [
            { type: "radio", name: "region", label: "Region", options: ["EMEA", { value: "apac", label: "APAC" }] },
            { type: "dropdown", name: "tier", label: "Tier", options: ["gold", "silver"] },
            { type: "dropdown", name: "optional", label: "Optional", options: ["x"], allowEmpty: true },
            { type: "listbox", name: "tags", label: "Tags", options: { range: "Lists!A1:A3" }, multi: true },
          ],
        },
      ],
    },
    { type: "button", name: "go", text: "Go" },
  ],
};

const inputOf = (name: string): FormInputWidget => {
  const found = collectInputs(spec).find((e) => e.widget.name === name);
  if (!found) throw new Error(`no input ${name}`);
  return found.widget;
};

describe("tree walking", () => {
  it("lists every input in tree order with its path (pages count as a level)", () => {
    const inputs = collectInputs(spec);
    expect(inputs.map((e) => e.widget.name)).toEqual([
      "customer", "amount", "due", "agree", "urgent", "region", "tier", "optional", "tags",
    ]);
    expect(inputs.map((e) => e.path)).toEqual([
      [1], [2, 0], [2, 1], [3, 0, 0], [3, 0, 1], [3, 1, 0], [3, 1, 1], [3, 1, 2], [3, 1, 3],
    ]);
  });

  it("collectWidgets includes containers, labels and buttons too", () => {
    const all = collectWidgets(spec);
    expect(all).toHaveLength(13);
    expect(all.map((e) => e.widget.type).filter((t) => t === "button")).toEqual(["button"]);
  });
});

describe("initial values", () => {
  it("uses the declared default, else the type's empty value", () => {
    expect(initialFormValues(spec, {})).toEqual({
      customer: "",
      amount: null,
      due: "",
      agree: false,
      urgent: true,
      region: "",
      // A dropdown with no default lands on its first option; allowEmpty starts blank.
      tier: "gold",
      optional: "",
      tags: [],
    });
  });

  it("a seed wins over the default and is coerced to the widget's type", () => {
    const seeds: Record<string, FormSeed> = {
      customer: { value: "ACME", display: "ACME" },
      amount: { value: 1234.5, display: "£1,234.50" },
      urgent: { value: 0 },
      tags: { value: "a", options: [{ value: "a" }, { value: "b" }] },
    };
    const values = initialFormValues(spec, seeds);
    expect(values.customer).toBe("ACME");
    expect(values.amount).toBe(1234.5);
    expect(values.urgent).toBe(false);
    expect(values.tags).toEqual(["a"]);
  });

  it("coerces per widget type: numbers stay numbers, never the display text", () => {
    const amount = inputOf("amount");
    expect(coerceValue(amount, "12")).toBe(12);
    expect(coerceValue(amount, "")).toBeNull();
    expect(coerceValue(amount, null)).toBeNull();
    // Unparseable text is KEPT so the validator can name it, not silently blanked.
    expect(coerceValue(amount, "abc")).toBe("abc");
    expect(coerceValue(inputOf("agree"), 1)).toBe(true);
    expect(coerceValue(inputOf("agree"), "TRUE")).toBe(true);
    expect(coerceValue(inputOf("tags"), ["a", "b"])).toEqual(["a", "b"]);
    expect(coerceValue(inputOf("tier"), ["silver"])).toBe("silver");
    // An Excel serial seeds a date widget as ISO.
    expect(serialToIso(45000)).toBe("2023-03-15");
    expect(coerceValue(inputOf("due"), 45000)).toBe("2023-03-15");
  });
});

describe("options", () => {
  it("normalizes inline options and reads a { range } list from the seed", () => {
    const region = inputOf("region");
    expect(region.type === "radio" && resolveOptions(region, {})).toEqual([
      { value: "EMEA", label: "EMEA" },
      { value: "apac", label: "APAC" },
    ]);
    const tags = inputOf("tags");
    expect(tags.type === "listbox" && resolveOptions(tags, {})).toEqual([]);
    expect(
      tags.type === "listbox" && resolveOptions(tags, { tags: { value: [], options: [{ value: "a" }] } }),
    ).toEqual([{ value: "a", label: "a" }]);
  });

  it("a patch override replaces the list", () => {
    const tier = inputOf("tier");
    expect(
      tier.type === "dropdown" && effectiveOptions(tier, {}, { tier: { options: [{ value: "bronze", label: "Bronze" }] } }),
    ).toEqual([{ value: "bronze", label: "Bronze" }]);
  });
});

describe("validation", () => {
  it("blocks the required text box and the required 'I agree' checkbox at once", () => {
    const errors = validateFormValues(spec, initialFormValues(spec, {}));
    expect(Object.keys(errors).sort()).toEqual(["agree", "customer"]);
  });

  it("enforces number bounds, date bounds, maxLength and option membership", () => {
    const base = { ...initialFormValues(spec, {}), customer: "ok", agree: true };
    expect(validateFormValues(spec, { ...base, amount: "abc" }).amount).toBe("Enter a number");
    expect(validateFormValues(spec, { ...base, amount: 20_000 }).amount).toMatch(/at most 10000/);
    expect(validateFormValues(spec, { ...base, amount: -1 }).amount).toMatch(/at least 0/);
    expect(validateFormValues(spec, { ...base, amount: 5.5 }).amount).toBeUndefined();
    expect(validateFormValues(spec, { ...base, due: "2025-12-31" }).due).toMatch(/on or after 2026-01-01/);
    expect(validateFormValues(spec, { ...base, due: "2027-01-01" }).due).toMatch(/on or before 2026-12-31/);
    expect(validateFormValues(spec, { ...base, due: "yesterday" }).due).toMatch(/Enter a date/);
    expect(validateFormValues(spec, { ...base, due: "2026-06-30" }).due).toBeUndefined();
    expect(validateFormValues(spec, { ...base, customer: "elevenchars" }).customer).toMatch(/10 characters/);
    expect(validateFormValues(spec, { ...base, region: "nowhere" }).region).toMatch(/listed options/);
    expect(validateFormValues(spec, { ...base, region: "apac" }).region).toBeUndefined();
    expect(validateFormValues(spec, { ...base, tier: "bronze" }).tier).toMatch(/listed options/);
  });

  it("a multi listbox must be a subset of the options the host resolved", () => {
    const base = { ...initialFormValues(spec, {}), customer: "ok", agree: true };
    const seeds = { tags: { value: [], options: [{ value: "a" }, { value: "b" }] } };
    expect(validateFormValues(spec, { ...base, tags: ["a", "b"] }, { seeds }).tags).toBeUndefined();
    expect(validateFormValues(spec, { ...base, tags: ["a", "zzz"] }, { seeds }).tags).toMatch(/listed/);
    // With no resolved list at all, nothing chosen can be right.
    expect(validateFormValues(spec, { ...base, tags: ["a"] }).tags).toMatch(/listed/);
  });

  it("does not judge widgets the user cannot act on: hidden, disabled, read-only", () => {
    const empty = initialFormValues(spec, {});
    expect(
      validateFormValues(spec, empty, { controls: { customer: { hidden: true }, agree: { disabled: true } } }),
    ).toEqual({});
    expect(
      validateFormValues(spec, empty, {
        seeds: { customer: { value: "", readOnly: true, reason: "protected" }, agree: { value: false, formula: "=A1" } },
      }),
    ).toEqual({});
  });

  it("does not judge an input a CONTAINER hides or disables from above", () => {
    // A hidden group is not rendered at all (Frame returns null), so an error
    // on a required input inside it can never be seen or fixed: the user
    // pressed Save, Submit was blocked, and nothing appeared anywhere.
    const nested: FormSpec = {
      children: [
        { type: "group", name: "advanced", hidden: true, children: [{ type: "textbox", name: "secret", label: "Secret", required: true }] },
        { type: "group", name: "offSection", disabled: true, children: [{ type: "number", name: "qty", label: "Qty", required: true, min: 1 }] },
        { type: "textbox", name: "visible", label: "Visible", required: true },
      ],
    };
    const values = initialFormValues(nested, {});
    // Only the widget the user can actually act on is judged.
    expect(Object.keys(validateFormValues(nested, values))).toEqual(["visible"]);

    // A script hiding the container through a control override counts too.
    const patched: FormSpec = {
      children: [
        { type: "group", name: "advanced", children: [{ type: "textbox", name: "secret", label: "Secret", required: true }] },
      ],
    };
    expect(validateFormValues(patched, initialFormValues(patched, {}))).toEqual({
      secret: expect.any(String),
    });
    expect(
      validateFormValues(patched, initialFormValues(patched, {}), { controls: { advanced: { hidden: true } } }),
    ).toEqual({});
    expect(
      validateFormValues(patched, initialFormValues(patched, {}), { controls: { advanced: { disabled: true } } }),
    ).toEqual({});
  });

  it("containerSuppressed names what is off from above, and nothing else", () => {
    const nested: FormSpec = {
      children: [
        { type: "group", name: "g", disabled: true, children: [
          { type: "textbox", name: "inner", label: "I" },
          { type: "tabs", name: "t", pages: [{ title: "p", children: [{ type: "textbox", name: "deep", label: "D" }] }] },
        ] },
        { type: "textbox", name: "top", label: "T", disabled: true },
      ],
    };
    const { hidden, disabled } = containerSuppressed(nested);
    expect([...disabled].sort()).toEqual(["deep", "inner"]);
    // `top` is disabled on its OWN account, not from above: the caller already
    // checks the widget's own flags, and conflating the two would hide which
    // rule fired.
    expect(disabled.has("top")).toBe(false);
    expect(hidden.size).toBe(0);
  });

  it("never runs a script-supplied pattern — only the declared bounds exist", () => {
    const widget = { type: "textbox", name: "t", label: "T", pattern: "(a+)+$" } as unknown as FormInputWidget;
    expect(validateInputValue(widget, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!")).toBeNull();
  });
});

describe("result shape", () => {
  it("types each answer from the WIDGET's type, not from the DOM", () => {
    const result = buildFormResult(spec, {
      customer: "ACME",
      amount: "12.5",
      due: "2026-06-30",
      agree: true,
      urgent: false,
      region: "apac",
      tier: "gold",
      optional: "",
      tags: ["a", "b"],
    });
    expect(result).toEqual({
      customer: "ACME",
      amount: 12.5,
      due: "2026-06-30",
      agree: true,
      urgent: false,
      region: "apac",
      tier: "gold",
      optional: null,
      tags: ["a", "b"],
    });
  });

  it("an unanswered optional widget comes back null; a required one keeps its text", () => {
    const result = buildFormResult(spec, { customer: "", amount: null, due: "" });
    expect(result.customer).toBe("");
    expect(result.amount).toBeNull();
    expect(result.due).toBeNull();
    expect(result.region).toBeNull();
    expect(result.agree).toBe(false);
    expect(result.tags).toEqual([]);
  });

  it("returns only the declared inputs — stray state cannot reach the script", () => {
    const result = buildFormResult(spec, { customer: "x", sneaky: "no", go: "no" });
    expect(Object.keys(result).sort()).toEqual([
      "agree", "amount", "customer", "due", "optional", "region", "tags", "tier", "urgent",
    ]);
  });
});

describe("patches", () => {
  it("merges values, accumulates control overrides, and never mutates its input", () => {
    const state = { values: { customer: "a", amount: 1 }, controls: { tier: { disabled: true } } };
    const next = applyFormPatch(state, {
      values: { customer: "b" },
      controls: {
        tier: { label: "Level", options: ["x", { value: "y", label: "Y" }] },
        amount: { error: "Too big" },
      },
    });
    expect(next.values).toEqual({ customer: "b", amount: 1 });
    expect(next.controls.tier).toEqual({
      disabled: true,
      label: "Level",
      options: [
        { value: "x", label: "x" },
        { value: "y", label: "Y" },
      ],
    });
    expect(next.controls.amount).toEqual({ error: "Too big" });
    expect(state.values).toEqual({ customer: "a", amount: 1 });
    expect(state.controls).toEqual({ tier: { disabled: true } });
  });

  it("error: null clears an error; a { range } options source changes nothing here", () => {
    const state = { values: {}, controls: { amount: { error: "Too big", options: [{ value: "a" }] } } };
    const next = applyFormPatch(state, { controls: { amount: { error: null, options: { range: "A1:A9" } } } });
    expect(next.controls.amount).toEqual({ options: [{ value: "a" }] });
  });

  it("progress value/max and text/hidden/disabled land on the override", () => {
    const next = applyFormPatch({ values: {}, controls: {} }, {
      controls: { done: { value: 40, max: 80, text: "Half", hidden: false, disabled: true } },
    });
    expect(next.controls.done).toEqual({ value: 40, max: 80, text: "Half", hidden: false, disabled: true });
  });
});

describe("dirty set — the currency trap", () => {
  const seeds: Record<string, FormSeed> = {
    amount: { value: 1234.5, display: "£1,234.50" },
    customer: { value: "ACME", display: "ACME" },
    agree: { value: 1 },
  };

  it("an untouched widget is NOT dirty, whatever the display text says", () => {
    const values = initialFormValues(spec, seeds);
    expect(dirtySet(values, seeds, spec)).toEqual(new Set());
    // Same without the spec: the seed value and the state value agree.
    expect(dirtySet(values, seeds)).toEqual(new Set());
  });

  it("editing 1234.5 to 1300 makes exactly that widget dirty", () => {
    const values = { ...initialFormValues(spec, seeds), amount: 1300 };
    expect(dirtySet(values, seeds, spec)).toEqual(new Set(["amount"]));
  });

  it("the same number spelled as text is not an edit", () => {
    const values = { ...initialFormValues(spec, seeds), amount: "1234.5" };
    expect(dirtySet(values, seeds, spec)).toEqual(new Set());
  });

  it("a checkbox seeded with 1 and holding true is untouched", () => {
    const values = { ...initialFormValues(spec, seeds) };
    expect(values.agree).toBe(true);
    expect(dirtySet(values, seeds, spec).has("agree")).toBe(false);
    expect(dirtySet({ ...values, agree: false }, seeds, spec).has("agree")).toBe(true);
  });

  it("only seeded names can be dirty", () => {
    const values = { ...initialFormValues(spec, seeds), region: "apac", tags: ["a"] };
    expect(dirtySet(values, seeds, spec)).toEqual(new Set());
  });

  it("sameFormValue compares meaning, not representation", () => {
    expect(sameFormValue(null, "")).toBe(true);
    expect(sameFormValue([], "")).toBe(true);
    expect(sameFormValue(["a"], "a")).toBe(true);
    expect(sameFormValue(["a", "b"], ["a"])).toBe(false);
    expect(sameFormValue(true, "TRUE")).toBe(true);
    expect(sameFormValue(false, 0)).toBe(true);
    expect(sameFormValue(1, "1.0")).toBe(true);
    expect(sameFormValue("x", "y")).toBe(false);
  });
});
