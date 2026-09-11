//! FILENAME: app/src/api/designQueryAssist/index.ts
// PURPOSE: The design-query assistant's shared pieces, in one import path.
// CONTEXT: The product surface (`_shared/dsl/pivotLayout/draft.ts`) and the
//          offline eval runner (`tests/eval/run-design-query-eval.mjs`) both
//          load from here, which is the point: the runner measures the
//          pipeline the product runs rather than a re-implementation of it.
//          Sibling of `@api/formulaAssist`, and shaped the same way.
//
//          What is NOT here: the DSL compiler and the dry run. Both live on
//          the extension side (`_shared/dsl/pivotLayout`), which `@api` may
//          not import. The drafting loop there injects them.

export type {
  DesignMeasureHints,
  DesignQueryCandidates,
  DesignQueryColumn,
  DesignQueryMeasure,
  DesignQueryModel,
  DesignQueryProposal,
  DesignQueryTable,
  DesignStrategySummary,
} from "./types";

export {
  DSL_AGGREGATIONS,
  DSL_CLAUSE_KEYWORDS,
  DSL_LAYOUT_DIRECTIVES,
  DSL_SHOW_VALUES_AS,
  DSL_TAUGHT_AGGREGATIONS,
} from "./vocabulary";

export {
  MAX_CANDIDATE_DIMENSIONS,
  MAX_CANDIDATE_MEASURES,
  MAX_CANDIDATE_NUMERIC_COLUMNS,
  TIME_GRAIN_NONE,
  TIME_GRAIN_YEAR,
  chooseCandidates,
  dslFieldRef,
  timeGrain,
  intentOverlap,
  intentTokens,
  nameTokens,
  qualifiedToDsl,
  splitQualified,
} from "./candidates";

export {
  DESIGN_QUERY_SCHEMA,
  DESIGN_QUERY_SCHEMA_NAME,
  designQueryResponseFormat,
  designQueryResponseSchema,
} from "./schema";

export type { CompilerFinding, DesignQueryReplyFormat, NextClauseRequest, UserPromptParts } from "./prompt";
export {
  DESIGN_QUERY_CHEAT_SHEET,
  DESIGN_QUERY_NEXT_CLAUSE_PROMPT,
  DESIGN_QUERY_SYSTEM_PROMPT,
  DESIGN_QUERY_SYSTEM_PROMPT_BARE,
  NEXT_CLAUSE_MAX_TOKENS,
  buildExamples,
  buildNextClauseRequest,
  buildNextClauseUserPrompt,
  buildRepairPrompt,
  buildUserPrompt,
  designQuerySystemPrompt,
  estimateTokens,
} from "./prompt";

export type { GrammarClause, PresentClauses } from "./grammar";
export {
  GRAMMAR_CLAUSES,
  allowedNextClauses,
  buildDesignQueryGrammar,
  buildNextClauseGrammar,
  gbnfTerminal,
} from "./grammar";

export { extractDesignQuery, looksLikeDsl, normalizeDsl } from "./extract";

export type {
  AxisClause,
  EditOp,
  FactField,
  FactFilter,
  FactSort,
  FactValue,
  NextEditKind,
  NextEditSuggestion,
  QueryFacts,
} from "./nextEdit";
export {
  MODEL_CLAUSE_PRIORITY,
  NEXT_EDIT_RULES,
  nextClauseSuggestion,
  normalizeRef,
  suggestNextEdits,
} from "./nextEdit";
