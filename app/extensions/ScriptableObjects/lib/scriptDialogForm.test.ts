//! FILENAME: app/extensions/ScriptableObjects/lib/scriptDialogForm.test.ts
// PURPOSE: The pure form-state half of the ui.dialog renderer — what a field
//          starts as, what blocks OK, and what the SCRIPT finally receives.
// CONTEXT: The result shape is the contract: a script branching on
//          `answers.lock` must get a boolean, and `answers.rate` a number, or
//          every consumer has to re-parse strings the dialog already knew the
//          type of. `null` for "left blank" is what lets a script tell an
//          unanswered optional field from one deliberately cleared.

import { describe, it, expect } from "vitest";
import type { ScriptDialogFormSpec } from "@api";
import {
  initialFieldValue,
  initialFormValues,
  validateFieldValue,
  validateFormValues,
  buildFormResult,
} from "./scriptDialogForm";

const spec: ScriptDialogFormSpec = {
  fields: [
    { name: "note", label: "Note", type: "text" },
    { name: "rate", label: "Rate", type: "number", min: 0, max: 10, default: 1 },
    { name: "period", label: "Period", type: "date", required: true },
    { name: "region", label: "Region", type: "select", options: ["EMEA", { value: "apac", label: "APAC" }] },
    { name: "lock", label: "Lock", type: "checkbox" },
  ],
};

describe("initial values", () => {
  it("seeds each control from its declared default", () => {
    expect(initialFormValues(spec)).toEqual({
      note: "",
      rate: "1",
      period: "",
      // A select with no default lands on its first option — a dropdown that
      // starts blank reads as a missing choice the script never offered.
      region: "EMEA",
      lock: false,
    });
  });

  it("a checkbox default is a boolean, never the string 'false'", () => {
    expect(initialFieldValue({ name: "a", label: "A", type: "checkbox" })).toBe(false);
    expect(initialFieldValue({ name: "a", label: "A", type: "checkbox", default: true })).toBe(true);
  });
});

describe("validation", () => {
  it("blocks an empty required field and allows an empty optional one", () => {
    expect(validateFieldValue({ name: "a", label: "A", type: "text", required: true }, "")).not.toBeNull();
    expect(validateFieldValue({ name: "a", label: "A", type: "text", required: true }, "   ")).not.toBeNull();
    expect(validateFieldValue({ name: "a", label: "A", type: "text" }, "")).toBeNull();
  });

  it("a required checkbox is the 'I agree' pattern — it must be ticked", () => {
    const field = { name: "ok", label: "I agree", type: "checkbox", required: true } as const;
    expect(validateFieldValue(field, false)).not.toBeNull();
    expect(validateFieldValue(field, true)).toBeNull();
  });

  it("enforces the number bounds the script declared", () => {
    const field = { name: "n", label: "N", type: "number", min: 0, max: 10 } as const;
    expect(validateFieldValue(field, "abc")).not.toBeNull();
    expect(validateFieldValue(field, "-1")).not.toBeNull();
    expect(validateFieldValue(field, "11")).not.toBeNull();
    expect(validateFieldValue(field, "5.5")).toBeNull();
  });

  it("a select answer must be one of the declared options", () => {
    const field = { name: "s", label: "S", type: "select", options: ["a", { value: "b" }] } as const;
    expect(validateFieldValue(field, "a")).toBeNull();
    expect(validateFieldValue(field, "b")).toBeNull();
    expect(validateFieldValue(field, "c")).not.toBeNull();
  });

  it("reports every offending field at once, keyed by name", () => {
    const errors = validateFormValues(spec, { note: "", rate: "99", period: "", region: "EMEA", lock: false });
    expect(Object.keys(errors).sort()).toEqual(["period", "rate"]);
  });

  it("passes a fully answered form", () => {
    expect(
      validateFormValues(spec, { note: "hi", rate: "2", period: "2026-07-31", region: "apac", lock: true }),
    ).toEqual({});
  });
});

describe("result shape", () => {
  it("types each answer from the FIELD's type, not from the DOM", () => {
    expect(
      buildFormResult(spec, { note: "hi", rate: "2.5", period: "2026-07-31", region: "apac", lock: true }),
    ).toEqual({ note: "hi", rate: 2.5, period: "2026-07-31", region: "apac", lock: true });
  });

  it("an unanswered optional field comes back null, not empty string", () => {
    const result = buildFormResult(spec, { note: "", rate: "", period: "2026-07-31", region: "EMEA", lock: false });
    expect(result.note).toBeNull();
    expect(result.rate).toBeNull();
    expect(result.lock).toBe(false);
  });

  it("an unticked checkbox is false, never null — a boolean is always answered", () => {
    const boolOnly: ScriptDialogFormSpec = { fields: [{ name: "lock", label: "Lock", type: "checkbox" }] };
    expect(buildFormResult(boolOnly, {})).toEqual({ lock: false });
  });

  it("returns only the declared fields — stray editor state cannot reach the script", () => {
    const result = buildFormResult(spec, {
      note: "hi", rate: "1", period: "2026-07-31", region: "EMEA", lock: false,
      sneaky: "should not appear",
    });
    expect(Object.keys(result).sort()).toEqual(["lock", "note", "period", "rate", "region"]);
  });
});
