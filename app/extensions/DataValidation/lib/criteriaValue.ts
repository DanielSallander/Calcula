//! FILENAME: app/extensions/DataValidation/lib/criteriaValue.ts
// PURPOSE: Turn what was typed in the Minimum / Maximum / Value box into the
//          number the stored rule holds -- or refuse it, out loud.
// CONTEXT: The box was read with `parseFloat(text) || 0`, and the date field's
//          own placeholder invites "2024-01-01". parseFloat stops at the first
//          non-digit, so that placeholder's shape parses as 2024 -- Excel serial
//          2024 is 1905-07-12 -- and the dialog saved a rule about 1905 without
//          a word. A wrong-but-plausible date is a QUIETER failure than a zero,
//          so this module refuses what it cannot represent instead of coercing.
//          Date and time text is converted BY THE ENGINE (DATEVALUE /
//          TIMEVALUE), never by a second copy of core/engine/src/date_serial.rs
//          living in an extension.

import type { DataValidationOperator, DataValidationType } from "@api";

/** Evaluates one engine expression. Injected so this module stays pure. */
export type ExpressionEvaluator = (expression: string) => Promise<unknown>;

/** A criterion box's contents, resolved or refused. */
export type CriterionResult =
  | { ok: true; value: number }
  | { ok: false; message: string };

/** The validation types whose rule carries an operator and one or two values. */
const CRITERIA_TYPES: readonly DataValidationType[] = [
  "wholeNumber",
  "decimal",
  "date",
  "time",
  "textLength",
];

/** The operators that read a SECOND value. */
const RANGE_OPERATORS: readonly DataValidationOperator[] = ["between", "notBetween"];

/**
 * Whether this type shows (and stores) the operator + value boxes.
 * The dialog and the Settings tab both ask here, so what is DISPLAYED and what
 * is READ ON SAVE cannot drift apart.
 */
export function typeNeedsCriteria(type: DataValidationType): boolean {
  return CRITERIA_TYPES.includes(type);
}

/**
 * Whether this operator needs the second box filled in.
 *
 * It is not optional: `check_numeric_rule` answers FALSE for every value when
 * Between is given no formula2 (and TRUE for every value when NotBetween is), so
 * a half-filled "between" rule is not a loose rule -- it is a rule that rejects
 * everything, and it used to be saveable.
 */
export function operatorNeedsSecondValue(operator: DataValidationOperator): boolean {
  return RANGE_OPERATORS.includes(operator);
}

/** A number the user typed, not a prefix of one: "2024-01-01" is NOT 2024. */
const NUMBER_LITERAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Escape a string for an engine expression literal ("" is one quote). */
function quoteForEngine(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

async function evaluateToNumber(
  expression: string,
  evaluate: ExpressionEvaluator
): Promise<number | null> {
  try {
    const result = await evaluate(expression);
    // The engine answers an unparseable literal with the text "#VALUE!", so a
    // non-number result is a refusal, not an exception.
    return typeof result === "number" && Number.isFinite(result) ? result : null;
  } catch {
    return null;
  }
}

/**
 * Resolve one criterion box.
 *
 * A plain number is taken as written (a date field accepts a serial, as Excel's
 * does). Otherwise a date or time is handed to the engine's DATEVALUE /
 * TIMEVALUE. Anything else is refused with a reason -- including a formula or a
 * cell reference, which the stored rule cannot hold: `NumericRule.formula1` is
 * an `f64`, so an expression could only be saved as the number it happened to
 * have at the moment OK was pressed, and "the next 30 days" would silently stop
 * meaning that tomorrow.
 */
export async function parseCriterionValue(
  text: string,
  type: DataValidationType,
  label: string,
  evaluate: ExpressionEvaluator
): Promise<CriterionResult> {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: `${label} is required.` };
  }

  if (trimmed.startsWith("=")) {
    return {
      ok: false,
      message:
        `${label} cannot be a formula or a cell reference: this rule stores a fixed number, ` +
        `so the expression would be frozen at today's answer. Use the Custom type for a formula.`,
    };
  }

  if (NUMBER_LITERAL.test(trimmed)) {
    return { ok: true, value: Number(trimmed) };
  }

  if (type === "date") {
    const serial = await evaluateToNumber(`DATEVALUE(${quoteForEngine(trimmed)})`, evaluate);
    if (serial === null) {
      return { ok: false, message: `${label} is not a date. Try 2024-01-31 or 1/31/2024.` };
    }
    return { ok: true, value: serial };
  }

  if (type === "time") {
    const fraction = await evaluateToNumber(`TIMEVALUE(${quoteForEngine(trimmed)})`, evaluate);
    if (fraction === null) {
      return { ok: false, message: `${label} is not a time. Try 14:30 or 2:30 PM.` };
    }
    return { ok: true, value: fraction };
  }

  return { ok: false, message: `${label} must be a number.` };
}
