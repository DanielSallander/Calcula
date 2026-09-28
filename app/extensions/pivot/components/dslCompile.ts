//! FILENAME: app/extensions/Pivot/components/dslCompile.ts
// PURPOSE: Compile the field pane's Pivot Layout DSL text AND name the filter
//          fields whose inclusion list (`Field = ("a", "b")`) could not be
//          turned into hidden items.
// CONTEXT: A pivot filter stores the items it HIDES. The compiler inverts an
//          inclusion list against the field's full item list
//          (`filterUniqueValues`), which the pane only knows for a field whose
//          report-filter dropdown was used in this pane session. Without it the
//          compiler hands the field back with NO list -- exactly the shape of a
//          field whose clause was deleted. The editor reads the difference
//          between the old and the new zones as the user's item-filter edit, so
//          `Sales.Channel = ("Store")` on a field hiding "Web" was sent as
//          "remove the filter": the user asked to show only Store and got every
//          channel (review3 finding 3).
//
//          `compileForEditor` names those fields (`unresolvedInclusions`) so
//          the editor keeps what the pivot has for them, and marks each such
//          clause with a WARNING saying the filter was left unchanged and what
//          to write instead. The names come from the compiler itself
//          (`CompileResult.unresolvedInclusions`, reported where it gives up on
//          the inversion). Round 3 inferred them instead, from which item lists
//          the compiler happened to LOOK UP and not find -- which held only
//          while the inversion was the compiler's one reader of
//          `filterUniqueValues`, so any new lookup would have marked a field
//          that had nothing to do with an inclusion.

import { processDsl, type CompileContext } from '../../_shared/dsl/pivotLayout';
import { dslWarning, type DslError } from '../../_shared/dsl/pivotLayout/errors';

/** What `processDsl` returns, with the inclusions the editor must not apply
 *  as a SET OF NAMES (what the editor's zone diff consumes). */
export type EditorCompileResult = Omit<ReturnType<typeof processDsl>, 'unresolvedInclusions'> & {
  /** Filter field names (as compiled) whose `= (...)` list could not be
   *  inverted into hidden items. Their hidden items in `filters` are NOT the
   *  user's intent and must be treated as "no change". */
  unresolvedInclusions: Set<string>;
};

/**
 * Compile `text` for the field pane: `processDsl`, plus the filter fields whose
 * inclusion list could not be resolved, each with a warning on its clause.
 */
export function compileForEditor(text: string, ctx: CompileContext): EditorCompileResult {
  const result = processDsl(text, ctx);
  const unresolvedInclusions = new Set(result.unresolvedInclusions.map((u) => u.fieldName));
  const warnings: DslError[] = result.unresolvedInclusions.map(({ fieldName: name, location }) =>
    dslWarning(
      `${name} = (...) was not applied: the field's list of items is not loaded, so the ` +
        `items to show cannot be turned into items to hide. The filter was left as it is. ` +
        `Write ${name} NOT IN (...) instead, or pick the items in the field's filter dropdown.`,
      location,
    ),
  );
  return {
    ...result,
    errors: [...result.errors, ...warnings],
    unresolvedInclusions,
  };
}
