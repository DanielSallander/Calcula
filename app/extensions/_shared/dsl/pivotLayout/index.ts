//! FILENAME: app/extensions/Pivot/dsl/index.ts
// PURPOSE: Barrel export for the Pivot Layout DSL module.

import { lex } from './lexer';
import { parse } from './parser';
import { compile, type CompileContext, type CompileResult } from './compiler';
import { validate } from './validator';
import { substituteControlRefs as substituteControlRefsImpl } from './controlRefs';
import type { DslError } from './errors';

export { lex, type LexResult } from './lexer';
export { parse, type ParseResult } from './parser';
export { compile, type CompileResult, type CompileContext } from './compiler';
export { serialize, type SerializeOptions } from './serializer';
export { validate, type ValidateContext } from './validator';

export type {
  PivotLayoutAST, FieldNode, ValueFieldNode, FilterFieldNode,
  SortNode, LayoutDirective, CalcFieldNode, TopNNode,
} from './ast';
export { emptyAST } from './ast';

export type { DslError, DslSeverity, SourceLocation } from './errors';
export { dslError, dslWarning, dslInfo } from './errors';

export {
  substituteControlRefs,
  type ControlResolver,
  type ControlSubstitutionResult,
} from './controlRefs';

export { TokenType, AGGREGATION_NAMES, LAYOUT_DIRECTIVES, SHOW_VALUES_AS_NAMES } from './tokens';
export type { Token } from './tokens';

/**
 * Full pipeline: text -> lex -> parse -> validate -> compile.
 * Convenience function for the Design editor.
 */
export function processDsl(
  text: string,
  ctx: CompileContext,
): CompileResult & { parseErrors: DslError[] } {
  // Field parameters: substitute @CONTROL(name) references with the named
  // control's current value before lexing (no-op without a resolver).
  let effectiveText = text;
  let controlErrors: DslError[] = [];
  if (ctx.resolveControl) {
    const substituted = substituteControlRefsImpl(text, ctx.resolveControl);
    effectiveText = substituted.text;
    controlErrors = substituted.errors;
  }
  const { tokens, errors: lexErrors } = lex(effectiveText);
  const { ast, errors: parseErrors } = parse(tokens);
  const validationErrors = validate(ast, ctx);
  const result = compile(ast, ctx);

  return {
    ...result,
    errors: [...controlErrors, ...lexErrors, ...parseErrors, ...validationErrors, ...result.errors],
    parseErrors: [...controlErrors, ...lexErrors, ...parseErrors],
  };
}
