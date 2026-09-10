//! FILENAME: app/src/api/designQueryAssist/schema.ts
// PURPOSE: The JSON Schema a model's design-query proposal must conform to.
// CONTEXT: The same portability rules as the formula assistant's schema, for
//          the same measured reasons: only `type`, `properties`, `required`,
//          `additionalProperties`, `description` and SIZE bounds; no enums;
//          every string field bounded, because a small model that starts
//          repeating itself fills whatever it is given, and a truncated reply
//          is unterminated JSON that loses the query along with the padding.
//
//          A query is short. Six hundred characters holds a dozen clauses;
//          nothing a person would type into the dialog comes close.

/** The tool/schema name sent alongside the schema. */
export const DESIGN_QUERY_SCHEMA_NAME = "calcula_design_query";

const MAX_DSL_CHARS = 600;
const MAX_EXPLANATION_CHARS = 160;

export const DESIGN_QUERY_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    dsl: {
      type: "string",
      maxLength: MAX_DSL_CHARS,
      description:
        "The design query: one clause per line, separated by real line breaks. Use only the listed names.",
    },
    explanation: {
      type: "string",
      maxLength: MAX_EXPLANATION_CHARS,
      description: "ONE short sentence saying what the query shows.",
    },
  },
  required: ["dsl", "explanation"],
  additionalProperties: false,
};

/** The seam's `responseSchema` value. */
export function designQueryResponseSchema(): { name: string; schema: Record<string, unknown> } {
  return { name: DESIGN_QUERY_SCHEMA_NAME, schema: DESIGN_QUERY_SCHEMA };
}

/** The `response_format` value for a bare OpenAI-compatible endpoint (the eval runner). */
export function designQueryResponseFormat(): Record<string, unknown> {
  return {
    type: "json_schema",
    json_schema: { name: DESIGN_QUERY_SCHEMA_NAME, schema: DESIGN_QUERY_SCHEMA },
  };
}
