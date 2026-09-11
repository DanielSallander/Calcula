//! FILENAME: app/src/api/formulaAssist/index.ts
// PURPOSE: The formula assistant's shared pieces, in one import path.
// CONTEXT: Both the product surface and the offline eval runner load from here,
//          which is the point: the runner measures the pipeline the product will
//          run rather than a re-implementation of it.
//
//          The generated pattern library is deliberately NOT re-exported. It is
//          ~350 KB and only a caller that has turned retrieval on should pay for
//          it, so it is imported directly from `./generated/formulaPatterns`.

export type {
  FormulaColumnKind,
  FormulaContextColumn,
  FormulaExpectation,
  FormulaFixtureCell,
  FormulaProposal,
  FormulaRegionContext,
  RetrievablePattern,
} from "./types";

export {
  buildFixtureContext,
  colLetter,
  kindOf,
  renderRegionContext,
  splitA1,
} from "./context";

export {
  FORMULA_PROPOSAL_SCHEMA,
  FORMULA_PROPOSAL_SCHEMA_LEAN,
  FORMULA_PROPOSAL_SCHEMA_NAME,
  responseFormat,
} from "./schema";

export type { FormulaGrammarOptions } from "./grammar";
export { FORMULA_EXPRESSION_RULES, buildFormulaGrammar } from "./grammar";

export type { PatternIndex, RankedPattern, RetrievalQuery } from "./retrieval";
export { buildIndex, namesFunction, rankPatterns, tokenize } from "./retrieval";

export {
  FORMULA_SYSTEM_PROMPT,
  buildRepairPrompt,
  buildUserPrompt,
  estimateTokens,
} from "./prompt";

export { extractProposal, looksLocalized, normalizeFormula } from "./normalize";
