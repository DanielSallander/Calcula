//! FILENAME: app/extensions/_shared/dsl/pivotLayout/dslModelContexts.ts
// PURPOSE: One editing context per open design-query document, so a language
//          provider can tell which editor it is being asked about.
// CONTEXT: Monaco registers a provider per LANGUAGE and hands it a `model`.
//          There is therefore exactly ONE completion provider and ONE inline
//          provider however many DSL editors are open, and the only thing that
//          can distinguish them is the model.
//
//          It used to be a set of module-level "current" fields written by
//          whichever editor rendered last. Two DSL editors can be open at the
//          same time — a Reports dialog over a pivot's Design tab — and both
//          write on every `biModel` change, so the loser autocompleted against
//          the winner's schema. Keyed by model URI, that cannot happen.
//
//          NO MONACO IMPORT. A URI is a string here, which keeps this unit
//          testable; `pivotDslLanguage.ts` does the one-line adaptation.

import type { SourceField, BiPivotModelInfo } from "../../components/types";

/**
 * A named control/ribbon-filter that a DSL FILTERS clause can reference by
 * `@Name` (e.g. `Category = @Region`). Supplied by the Reports editor only;
 * the language module stays feature-neutral (no @api dependency).
 */
export interface DslControlHint {
  name: string;
  /** Short family label shown in the completion description (e.g. "filter"). */
  kind?: string;
  /** Current-value preview shown as completion detail. */
  detail?: string;
}

/** Everything a provider needs to answer for ONE editor's document. */
export interface DslModelContext {
  sourceFields: SourceField[];
  biModel?: BiPivotModelInfo;
  controlHints: DslControlHint[];
  /** For the compile veto behind in-editor next-edit suggestions. */
  connectionId?: string;
  /**
   * Offer next-edit suggestions as ghost text in this editor (Milestone C).
   * Off unless the host asks, so a surface that only wants highlighting and
   * autocomplete is unaffected.
   */
  inlineNextEdits?: boolean;
  /**
   * Suggestion ids the person has dismissed, SHARED with that editor's chip
   * row. One set, or dismissing a suggestion on the row would leave it sitting
   * in the text — the same nagging the row was built to avoid.
   */
  dismissed?: Set<string>;
}

const contexts = new Map<string, DslModelContext>();

/**
 * Fallback for a document nobody registered.
 *
 * Both hosts register per model, so this covers the window between a host's
 * `biModel` effect and its editor actually mounting, plus any future surface
 * that has not opted in. Deliberately NOT the primary path.
 */
let fallback: DslModelContext = { sourceFields: [], controlHints: [] };

/** Register (or replace) the context for one editor's document. */
export function setDslModelContext(modelUri: string, context: DslModelContext): void {
  contexts.set(modelUri, context);
}

/** Forget a document's context. Call it when the editor unmounts. */
export function clearDslModelContext(modelUri: string): void {
  contexts.delete(modelUri);
}

/** How many documents are registered right now. For tests and leak checks. */
export function dslModelContextCount(): number {
  return contexts.size;
}

/** Update the fallback field context used for autocomplete suggestions. */
export function setDslEditorContext(
  sourceFields: SourceField[],
  biModel?: BiPivotModelInfo,
  controlHints?: DslControlHint[],
): void {
  fallback = { sourceFields, biModel, controlHints: controlHints ?? [] };
}

/** Update only the fallback's control hints (the Reports editor's unmount cleanup). */
export function setDslControlHints(controlHints: DslControlHint[]): void {
  fallback = { ...fallback, controlHints };
}

/** The context for a document: its own if registered, else the fallback. */
export function dslContextForUri(modelUri: string | null | undefined): DslModelContext {
  if (!modelUri) return fallback;
  return contexts.get(modelUri) ?? fallback;
}

/** Test seam: forget everything, including the fallback. */
export function resetDslModelContexts(): void {
  contexts.clear();
  fallback = { sourceFields: [], controlHints: [] };
}
