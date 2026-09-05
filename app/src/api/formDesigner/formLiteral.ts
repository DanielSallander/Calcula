//! FILENAME: app/src/api/formDesigner/formLiteral.ts
// PURPOSE: Turn the object literal a script hands to `form.define(...)` into
//          the plain value a designer can draw — or REFUSE, naming the
//          construct that stopped it and quoting the user's own code.
// CONTEXT: M5a of docs/design/typescript-forms.md §14.
//
//          THE RULE: EXACT OR NOTHING. A layout the designer half-understands
//          is worse than one it will not open, because the designer's next act
//          is to REWRITE the block — and everything it failed to understand
//          would be written back out as whatever it guessed. So a literal is
//          admitted only when every node in it maps to a value with no
//          interpretation left over: string, number, boolean, null, array,
//          plain object. A spread, a computed key, a variable, a call, a
//          template with substitutions, an arrow function, a type assertion —
//          each is a refusal that names itself, because the caller's next move
//          is to open the code editor and the user needs to know why.
//
//          `undefined` IS admitted, as ABSENCE. `{ hidden: undefined }` is what
//          `form.define` already receives as "no `hidden` key", so dropping it
//          is not an approximation — re-emitting the object without it produces
//          the identical runtime spec. In an ARRAY there is no such equivalence
//          (a hole is not the same as a shorter list), so there it is refused.
//
//          A NO-SUBSTITUTION TEMPLATE is admitted for the same reason: its
//          cooked text is exactly a string. A template with `${…}` in it is
//          not — its value depends on code that runs.

import type * as TS from "typescript";

import type { FormDesignerRefusal } from "./types";

/** Longest snippet of the user's code quoted back in a refusal. */
const MAX_QUOTED_CHARS = 72;

/** Property value that means "this key is not here". */
export const ABSENT = Symbol("form-designer-absent");

/** Thrown by the walk, caught by `readObjectLiteral`. */
class RefusalError extends Error {
  constructor(readonly refusal: FormDesignerRefusal) {
    super(refusal.message);
    this.name = "RefusalError";
  }
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= MAX_QUOTED_CHARS ? flat : `${flat.slice(0, MAX_QUOTED_CHARS - 3)}...`;
}

/**
 * The English name of what the designer just refused.
 *
 * Deliberately the user's vocabulary, not the compiler's: "a function call",
 * not "a CallExpression". The four the milestone names explicitly — a spread,
 * a computed key, a variable reference and a call — each get their own phrase
 * so the sentence reads as a description of the user's code.
 */
function describeKind(ts: typeof TS, node: TS.Node): string {
  const k = ts.SyntaxKind;
  switch (node.kind) {
    case k.CallExpression:
      return "a function call";
    case k.NewExpression:
      return "a `new` expression";
    case k.TaggedTemplateExpression:
      return "a tagged template string";
    case k.TemplateExpression:
      return "a template string with substitutions";
    case k.Identifier:
    case k.PropertyAccessExpression:
    case k.ElementAccessExpression:
      return "a reference to a variable";
    case k.ArrowFunction:
    case k.FunctionExpression:
      return "a function";
    case k.ConditionalExpression:
      return "a conditional expression";
    case k.BinaryExpression:
      return "a calculated expression";
    case k.AsExpression:
    case k.SatisfiesExpression:
    case k.TypeAssertionExpression:
      return "a TypeScript type assertion";
    case k.NonNullExpression:
      return "a TypeScript non-null assertion";
    case k.AwaitExpression:
      return "an `await`";
    case k.SpreadElement:
      return "a spread";
    case k.OmittedExpression:
      return "a gap in an array";
    case k.BigIntLiteral:
      return "a BigInt";
    case k.RegularExpressionLiteral:
      return "a regular expression";
    default:
      return "an expression";
  }
}

/** Build the refusal for one node, with its line and the code that caused it. */
function unrepresentable(
  ts: typeof TS,
  sourceFile: TS.SourceFile,
  node: TS.Node,
  what: string,
): RefusalError {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const nodeText = clip(node.getText(sourceFile));
  return new RefusalError({
    code: "unrepresentable",
    message:
      `The form layout uses ${what} on line ${line + 1} (\`${nodeText}\`). ` +
      "The designer can only draw a layout written out as plain values, so this one opens in the code editor instead.",
    nodeText,
    line: line + 1,
    column: character + 1,
  });
}

/** The name of a property, or a refusal if it is not one the designer can keep. */
function propertyKey(
  ts: typeof TS,
  sourceFile: TS.SourceFile,
  name: TS.PropertyName,
): string {
  if (ts.isComputedPropertyName(name)) throw unrepresentable(ts, sourceFile, name, "a computed key");
  let text: string;
  if (ts.isIdentifier(name)) text = name.text;
  else if (ts.isStringLiteral(name)) text = name.text;
  else if (ts.isNumericLiteral(name)) text = name.text;
  else throw unrepresentable(ts, sourceFile, name, "a key it does not recognise");
  // `__proto__: { … }` in a literal is not a property AT ALL — it re-points the
  // object's prototype — so it is the one key that would be read, validated and
  // re-emitted without ever existing: absent from `Object.keys`, invisible to
  // the duplicate-key refusal below and to `checkFormSpec`'s unknown-key gate,
  // yet readable as `spec.width` off the chain. Left alone it is the only
  // construct in this file that DELETES a line the author typed instead of
  // naming it. Both spellings behave identically (`{ __proto__: … }` and
  // `{ "__proto__": … }`), which is why the check is here, after the key's text
  // is known, rather than on the identifier branch alone.
  if (text === "__proto__") throw unrepresentable(ts, sourceFile, name, "a `__proto__` key");
  return text;
}

/** One node of the literal, as a value. Throws `RefusalError` when it cannot. */
function valueOf(ts: typeof TS, sourceFile: TS.SourceFile, node: TS.Expression): unknown {
  const k = ts.SyntaxKind;
  switch (node.kind) {
    // Parentheses change nothing about the value, so unwrapping them is exact.
    // Type assertions are NOT unwrapped: dropping `as const` on the way back out
    // would silently delete something the author wrote.
    case k.ParenthesizedExpression:
      return valueOf(ts, sourceFile, (node as TS.ParenthesizedExpression).expression);
    case k.StringLiteral:
      return (node as TS.StringLiteral).text;
    case k.NoSubstitutionTemplateLiteral:
      return (node as TS.NoSubstitutionTemplateLiteral).text;
    case k.NumericLiteral: {
      const value = Number((node as TS.NumericLiteral).text);
      if (!Number.isFinite(value)) throw unrepresentable(ts, sourceFile, node, "a number it cannot store");
      return value;
    }
    case k.TrueKeyword:
      return true;
    case k.FalseKeyword:
      return false;
    case k.NullKeyword:
      return null;
    case k.PrefixUnaryExpression: {
      // `min: -1` is ordinary in a layout; anything else built out of an
      // operator is a calculation the designer would have to re-derive.
      const unary = node as TS.PrefixUnaryExpression;
      const signed = unary.operator === k.MinusToken || unary.operator === k.PlusToken;
      if (signed && unary.operand.kind === k.NumericLiteral) {
        const magnitude = Number((unary.operand as TS.NumericLiteral).text);
        if (!Number.isFinite(magnitude)) throw unrepresentable(ts, sourceFile, node, "a number it cannot store");
        return unary.operator === k.MinusToken ? -magnitude : magnitude;
      }
      throw unrepresentable(ts, sourceFile, node, "a calculated expression");
    }
    case k.Identifier: {
      if ((node as TS.Identifier).text === "undefined") return ABSENT;
      throw unrepresentable(ts, sourceFile, node, describeKind(ts, node));
    }
    case k.ArrayLiteralExpression: {
      const out: unknown[] = [];
      for (const element of (node as TS.ArrayLiteralExpression).elements) {
        if (ts.isSpreadElement(element)) throw unrepresentable(ts, sourceFile, element, "a spread");
        const value = valueOf(ts, sourceFile, element);
        if (value === ABSENT) throw unrepresentable(ts, sourceFile, element, "an `undefined` list entry");
        out.push(value);
      }
      return out;
    }
    case k.ObjectLiteralExpression: {
      const out: Record<string, unknown> = {};
      for (const member of (node as TS.ObjectLiteralExpression).properties) {
        if (ts.isSpreadAssignment(member)) throw unrepresentable(ts, sourceFile, member, "a spread");
        if (ts.isShorthandPropertyAssignment(member)) {
          throw unrepresentable(ts, sourceFile, member, "a reference to a variable");
        }
        if (ts.isMethodDeclaration(member)) throw unrepresentable(ts, sourceFile, member, "a method");
        if (ts.isGetAccessor(member)) throw unrepresentable(ts, sourceFile, member, "a getter");
        if (ts.isSetAccessor(member)) throw unrepresentable(ts, sourceFile, member, "a setter");
        if (!ts.isPropertyAssignment(member)) {
          throw unrepresentable(ts, sourceFile, member, "a property it does not recognise");
        }
        const key = propertyKey(ts, sourceFile, member.name);
        if (Object.prototype.hasOwnProperty.call(out, key)) {
          // Last-wins is what the runtime does, so this IS representable — but
          // re-emitting it would silently delete a line the author typed, and
          // a designer that deletes lines is one nobody opens twice.
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(member.getStart(sourceFile));
          throw new RefusalError({
            code: "unrepresentable",
            message:
              `The form layout sets "${key}" twice, the second time on line ${line + 1}. ` +
              "The designer would have to drop one of them, so this layout opens in the code editor instead.",
            nodeText: clip(member.getText(sourceFile)),
            line: line + 1,
            column: character + 1,
          });
        }
        const value = valueOf(ts, sourceFile, member.initializer);
        if (value === ABSENT) continue;
        out[key] = value;
      }
      return out;
    }
    default:
      throw unrepresentable(ts, sourceFile, node, describeKind(ts, node));
  }
}

/**
 * Read one object literal as a plain value.
 *
 * The only entry point: the recursion above throws its refusal and this is
 * where it becomes a return value, so no caller has to know about the
 * exception.
 */
export function readObjectLiteral(
  ts: typeof TS,
  sourceFile: TS.SourceFile,
  literal: TS.ObjectLiteralExpression,
): { ok: true; value: Record<string, unknown> } | { ok: false; refusal: FormDesignerRefusal } {
  try {
    return { ok: true, value: valueOf(ts, sourceFile, literal) as Record<string, unknown> };
  } catch (err) {
    if (err instanceof RefusalError) return { ok: false, refusal: err.refusal };
    throw err;
  }
}
