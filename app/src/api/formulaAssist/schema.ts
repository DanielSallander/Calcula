//! FILENAME: app/src/api/formulaAssist/schema.ts
// PURPOSE: The JSON Schema a model's formula proposal must conform to.
// CONTEXT: Measured on this machine 2026-09-07 against Ollama 0.33.1: the
//          OpenAI-compatible endpoint honours
//          `response_format: {type: "json_schema", json_schema: {name, schema}}`
//          and a 1B model returned a conforming object. `{type: "json_object"}`
//          ALONE produced well-formed JSON describing something else entirely,
//          so it is never the fallback — a run either constrains the shape or
//          extracts from free text and verifies as usual.

/** The tool/schema name sent alongside the schema. */
export const FORMULA_PROPOSAL_SCHEMA_NAME = "calcula_formula_proposal";

/**
 * PORTABILITY RULES, and they are not stylistic.
 *
 * Only `type`, `properties`, `required`, `items`, `additionalProperties`,
 * `description` and STRING-valued `enum`s may appear. Ollama decodes
 * `properties.*.enum` into a Go `[]string`, so a numeric enum makes the whole
 * request fail at JSON-decode time with a 400 — the same trap the chat tool
 * surface records for `cube_kpi.property`. Nothing here uses an enum at all,
 * which is the safest version of that rule.
 */
export const FORMULA_PROPOSAL_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    formula: {
      type: "string",
      description:
        "One spreadsheet formula in invariant syntax: comma between arguments, dot as the decimal point. May start with =.",
    },
    explanation: {
      type: "string",
      description: "One sentence saying what the formula does.",
    },
    assumptions: {
      type: "array",
      items: { type: "string" },
      description: "Anything you had to guess. Empty when nothing was guessed.",
    },
    fillDown: {
      type: "boolean",
      description: "True when this formula belongs in every data row of the target column.",
    },
  },
  required: ["formula", "explanation", "assumptions", "fillDown"],
  additionalProperties: false,
};

/**
 * The same proposal without the free-text list.
 *
 * MEASURED REASON, not a preference. On 2026-09-07, `qwen2.5-coder:1.5b` hit the
 * reply limit on 52 of 60 tasks with the full schema — never in the formula,
 * always by repeating itself inside `assumptions` ("The formula assumes that the
 * Region and Rep columns are not the same for any two rows." nine times over).
 * An array of free text is an invitation a small model cannot decline, and every
 * token of it is decode time the user waits through.
 *
 * `assumptions` is worth having in the product, where it tells a user what the
 * model guessed. It is worth measuring WITHOUT, because if it costs most of the
 * latency and buys nothing on correctness, it should be earned rather than
 * assumed.
 */
export const FORMULA_PROPOSAL_SCHEMA_LEAN: Record<string, unknown> = {
  type: "object",
  properties: {
    formula: {
      type: "string",
      description:
        "One spreadsheet formula in invariant syntax: comma between arguments, dot as the decimal point.",
    },
    explanation: { type: "string", description: "One short sentence." },
  },
  required: ["formula", "explanation"],
  additionalProperties: false,
};

/** The `response_format` value for an OpenAI-compatible endpoint. */
export function responseFormat(lean = false): Record<string, unknown> {
  return {
    type: "json_schema",
    json_schema: {
      name: FORMULA_PROPOSAL_SCHEMA_NAME,
      schema: lean ? FORMULA_PROPOSAL_SCHEMA_LEAN : FORMULA_PROPOSAL_SCHEMA,
    },
  };
}
