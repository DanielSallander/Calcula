//! FILENAME: app/extensions/DataValidation/lib/__tests__/criteriaValue.test.ts
// PURPOSE: Pin what the Minimum / Maximum / Value box accepts, and pin that
//          everything else is REFUSED rather than coerced.
// CONTEXT: The box was read with `parseFloat(text) || 0`. parseFloat stops at
//          the first character that cannot continue a number, so the date
//          field's own placeholder shape, "2024-01-01", parsed as 2024 — a
//          perfectly plausible Excel serial (1905-07-12). The dialog then saved
//          a rule about 1905 and said nothing. A wrong-but-valid answer is a
//          quieter failure than a zero, which is why these tests assert on the
//          REFUSAL, not just on the happy path.

import { describe, it, expect, vi } from "vitest";
import {
  operatorNeedsSecondValue,
  parseCriterionValue,
  typeNeedsCriteria,
} from "../criteriaValue";

/** An evaluator that answers one expression and records what it was asked. */
function engine(answers: Record<string, unknown>) {
  const seen: string[] = [];
  const evaluate = vi.fn(async (expression: string) => {
    seen.push(expression);
    return expression in answers ? answers[expression] : "#VALUE!";
  });
  return { evaluate, seen };
}

describe("parseCriterionValue - literals", () => {
  it("takes a plain number as written", async () => {
    const { evaluate } = engine({});
    await expect(parseCriterionValue("42", "wholeNumber", "Value", evaluate)).resolves.toEqual({
      ok: true,
      value: 42,
    });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("takes a negative and a decimal number", async () => {
    const { evaluate } = engine({});
    await expect(parseCriterionValue("-3.5", "decimal", "Value", evaluate)).resolves.toEqual({
      ok: true,
      value: -3.5,
    });
  });

  it("does NOT read a date string as the number it starts with", async () => {
    // parseFloat("2024-01-01") === 2024, and serial 2024 is 1905-07-12. The old
    // dialog saved that without a word.
    const { evaluate } = engine({ 'DATEVALUE("2024-01-01")': 45292 });
    const result = await parseCriterionValue("2024-01-01", "date", "Minimum", evaluate);
    expect(result).toEqual({ ok: true, value: 45292 });
    expect(result).not.toEqual({ ok: true, value: 2024 });
  });
});

describe("parseCriterionValue - dates and times go to the engine", () => {
  it("converts a date through DATEVALUE, not through a second copy of date_serial.rs", async () => {
    const { evaluate, seen } = engine({ 'DATEVALUE("1/31/2024")': 45322 });
    await expect(parseCriterionValue("1/31/2024", "date", "Value", evaluate)).resolves.toEqual({
      ok: true,
      value: 45322,
    });
    expect(seen).toEqual(['DATEVALUE("1/31/2024")']);
  });

  it("converts a time through TIMEVALUE", async () => {
    const { evaluate, seen } = engine({ 'TIMEVALUE("14:30")': 0.604166666 });
    await expect(parseCriterionValue("14:30", "time", "Value", evaluate)).resolves.toEqual({
      ok: true,
      value: 0.604166666,
    });
    expect(seen).toEqual(['TIMEVALUE("14:30")']);
  });

  it("escapes a quote so the expression cannot be broken open", async () => {
    const { evaluate, seen } = engine({});
    await parseCriterionValue('a"b', "date", "Value", evaluate);
    expect(seen).toEqual(['DATEVALUE("a""b")']);
  });

  it("refuses text the engine answers with an error", async () => {
    const { evaluate } = engine({}); // every expression answers "#VALUE!"
    const result = await parseCriterionValue("last tuesday", "date", "Minimum", evaluate);
    expect(result.ok).toBe(false);
  });

  it("refuses rather than throwing when the engine call itself fails", async () => {
    const evaluate = vi.fn(async () => {
      throw new Error("backend unreachable");
    });
    const result = await parseCriterionValue("2024-01-01", "date", "Value", evaluate);
    expect(result.ok).toBe(false);
  });
});

describe("parseCriterionValue - refusals", () => {
  it("refuses an empty box instead of storing 0", async () => {
    const { evaluate } = engine({});
    const result = await parseCriterionValue("   ", "wholeNumber", "Maximum", evaluate);
    expect(result).toEqual({ ok: false, message: "Maximum is required." });
  });

  it("refuses junk instead of storing 0", async () => {
    const { evaluate } = engine({});
    const result = await parseCriterionValue("abc", "wholeNumber", "Value", evaluate);
    expect(result).toEqual({ ok: false, message: "Value must be a number." });
  });

  it("refuses a formula or a cell reference, and says why", async () => {
    const { evaluate } = engine({});
    const result = await parseCriterionValue("=TODAY()+30", "date", "Maximum", evaluate);
    expect(result.ok).toBe(false);
    // Freezing it at today's answer would make the rule quietly wrong tomorrow;
    // the message has to point somewhere that still works.
    expect(result.ok === false && result.message).toContain("Custom");
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("names the box it is talking about", async () => {
    const { evaluate } = engine({});
    const minimum = await parseCriterionValue("", "decimal", "Minimum", evaluate);
    expect(minimum.ok === false && minimum.message.startsWith("Minimum")).toBe(true);
  });
});

describe("what the Settings tab shows and what OK reads are one decision", () => {
  it("claims criteria boxes for exactly the five operator-bearing types", () => {
    expect(typeNeedsCriteria("wholeNumber")).toBe(true);
    expect(typeNeedsCriteria("decimal")).toBe(true);
    expect(typeNeedsCriteria("date")).toBe(true);
    expect(typeNeedsCriteria("time")).toBe(true);
    expect(typeNeedsCriteria("textLength")).toBe(true);
    expect(typeNeedsCriteria("none")).toBe(false);
    expect(typeNeedsCriteria("list")).toBe(false);
    expect(typeNeedsCriteria("custom")).toBe(false);
  });

  it("claims the second box for exactly the two range operators", () => {
    // Not cosmetic: check_numeric_rule answers FALSE for every value when
    // Between has no formula2, so a half-filled "between" rejects everything.
    expect(operatorNeedsSecondValue("between")).toBe(true);
    expect(operatorNeedsSecondValue("notBetween")).toBe(true);
    for (const op of [
      "equal",
      "notEqual",
      "greaterThan",
      "lessThan",
      "greaterThanOrEqual",
      "lessThanOrEqual",
    ] as const) {
      expect(operatorNeedsSecondValue(op)).toBe(false);
    }
  });
});
