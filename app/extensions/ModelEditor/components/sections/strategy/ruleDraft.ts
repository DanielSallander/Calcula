// FILENAME: app/extensions/ModelEditor/components/sections/strategy/ruleDraft.ts
// PURPOSE: The editable shape of a rule, and the round trip between it and the
//          stored `Rule`.
// CONTEXT: Implements properties (4) and (18). A scope column is re-checked
//          against the model before the rule is accepted, because a typo in a
//          scope is not a broken rule — it is a rule that silently NEVER FIRES,
//          which looks exactly like a rule that was never needed. And
//          `buildRuleFromDraft` still PARSES the suppress string even though
//          the control is now checkboxes, because unsaved drafts outlive the
//          control that wrote them. See ../StrategySection.tsx.

import type { ModelOverview } from "@api";
import {
  bandExistsAnywhere,
  formatMaterialitySpec,
  formatTargetSpec,
  parseIsoDate,
  parseMaterialitySpec,
  parseSuppressSpec,
  parseTargetSpec,
  modelHasColumn,
} from "../../../lib/strategyTypes";
import type {
  AttributeSet,
  Cadence,
  Direction,
  Rule,
  Scope,
  ScopeValue,
  StrategyDoc,
} from "../../../lib/strategyTypes";

// ===========================================================================

/** One scope clause while it is being edited. */
export interface ScopeClauseDraft {
  /** `Table[Column]`, chosen from the model — never typed. */
  column: string;
  kind: "members" | "dateRange";
  /** Comma-separated members, for kind "members". */
  members: string;
  from: string;
  to: string;
}

export interface RuleDraft {
  id: string;
  measure: string;
  scope: ScopeClauseDraft[];
  direction: string;
  target: string;
  materiality: string;
  cadence: string;
  suppress: string;
  rankWeight: string;
  note: string;
}

export function emptyRuleDraft(): RuleDraft {
  return {
    id: "",
    measure: "",
    scope: [],
    direction: "",
    target: "",
    materiality: "",
    cadence: "",
    suppress: "",
    rankWeight: "",
    note: "",
  };
}

export function ruleToDraft(rule: Rule): RuleDraft {
  return {
    id: rule.id,
    measure: rule.measure,
    scope: Object.entries(rule.scope ?? {}).map(([column, value]) =>
      Array.isArray(value)
        ? { column, kind: "members" as const, members: value.join(", "), from: "", to: "" }
        : {
            column,
            kind: "dateRange" as const,
            members: "",
            from: value.from,
            // An absent end bound is "onwards"; the editor shows it as blank.
            to: value.to ?? "",
          },
    ),
    direction: rule.set.direction ?? "",
    target: formatTargetSpec(rule.set.target),
    materiality: formatMaterialitySpec(rule.set.materiality),
    cadence: rule.set.cadence ?? "",
    suppress: (rule.set.suppress ?? []).join(", "),
    rankWeight: rule.set.rankWeight !== undefined ? String(rule.set.rankWeight) : "",
    note: rule.note ?? "",
  };
}

/**
 * Turn a draft into a rule, or say why it cannot be one.
 *
 * The column check is the load-bearing one and is deliberately duplicated from
 * the <select> that produced the value: a scope naming a column the model does
 * not have is a rule that never fires, and nothing downstream would ever
 * mention it — `validate` reports it, but only once it has been SAVED.
 */
export function buildRuleFromDraft(
  overview: ModelOverview,
  draft: RuleDraft,
  /** The document the rule is going INTO. Only the band check reads it, and it
   *  has to: whether a `targetBand` direction has a band to land on is a
   *  question about the whole document, not about this rule alone. */
  doc: StrategyDoc,
): { ok: true; rule: Rule } | { ok: false; error: string } {
  const id = draft.id.trim();
  if (id === "") return { ok: false, error: "A rule needs an id — findings name the rule that produced them." };
  if (draft.measure === "") return { ok: false, error: "A rule must annotate a measure." };
  if (!overview.measures.some((m) => m.name === draft.measure)) {
    return { ok: false, error: `'${draft.measure}' is not a measure in this model.` };
  }

  const scope: Scope = {};
  for (const clause of draft.scope) {
    if (clause.column === "") return { ok: false, error: "Every scope row needs a column." };
    if (!modelHasColumn(overview, clause.column)) {
      return { ok: false, error: `'${clause.column}' is not a column in this model.` };
    }
    if (scope[clause.column] !== undefined) {
      return { ok: false, error: `'${clause.column}' is constrained twice; a column may appear once.` };
    }
    if (clause.kind === "members") {
      const members = clause.members
        .split(",")
        .map((m) => m.trim())
        .filter((m) => m !== "");
      if (members.length === 0) {
        return { ok: false, error: `'${clause.column}' is constrained to no members, so the scope is empty.` };
      }
      scope[clause.column] = members;
    } else {
      if (clause.from.trim() === "") {
        return { ok: false, error: `'${clause.column}' needs a from date.` };
      }
      // THE BOUNDS ARE CHECKED AGAINST THE CALENDAR, not merely for being
      // non-empty. They are plain text boxes, and `IsoDate` validates in
      // `Deserialize`, so `2025-13-45` here did not produce a finding on this
      // rule — it made the whole strategy document unreadable. `2026-02-31` is
      // the same class of value and the same cost.
      const from = parseIsoDate(clause.from);
      if (!from.ok) return { ok: false, error: `'${clause.column}': ${from.error}` };
      // The end bound is OPTIONAL: "the Nordics floor took effect in 2025" has
      // no end, and inventing one would make the rule stop firing next year.
      if (clause.to.trim() === "") {
        scope[clause.column] = { from: from.date };
      } else {
        const to = parseIsoDate(clause.to);
        if (!to.ok) return { ok: false, error: `'${clause.column}': ${to.error}` };
        // WHETHER THE RANGE HOLDS ANYTHING IS NOT ASKED HERE. `from > to` is
        // the validator's `empty-scope` ERROR, which it reports against the
        // saved document; refusing it at this gate too would be a second rule
        // and would refuse a rule Save accepts and then explains.
        scope[clause.column] = { from: from.date, to: to.date };
      }
    }
  }

  const set: AttributeSet = {};
  if (draft.direction !== "") set.direction = draft.direction as Direction;
  if (draft.cadence !== "") set.cadence = draft.cadence as Cadence;

  const target = parseTargetSpec(draft.target);
  if (!target.ok) return { ok: false, error: target.error };
  if (target.target !== undefined) set.target = target.target;

  // A rule that narrows a measure to a BAND direction needs a band SOMEWHERE
  // for that direction to land on. The Rust rules loop never inspected
  // `set.direction` at all, so this was the same silent loss of favourability
  // as on a measure entry with no finding anywhere to say so. The measure grid
  // makes the state hard to reach by switching its target control; the modal's
  // target is one text field, so the refusal is here — and it is scope-blind in
  // exactly the way the validator is, or it would refuse a rule the backend
  // accepts, which is worse than not checking at all.
  if (
    set.direction === "targetBand" &&
    set.target?.type !== "band" &&
    !bandExistsAnywhere(doc, draft.measure, id)
  ) {
    return {
      ok: false,
      error:
        "A targetBand direction needs a band to judge against, and measure '" +
        draft.measure +
        "' has none — not on its entry and not on any other rule. Write this rule's target as band:0.8,1.2 (band:[0.8,1.2) for an exclusive high bound), or give the measure a band. Without one the direction takes the measure's favourability away in this scope and puts nothing back.",
    };
  }

  const materiality = parseMaterialitySpec(draft.materiality);
  if (!materiality.ok) return { ok: false, error: materiality.error };
  if (materiality.materiality !== undefined) set.materiality = materiality.materiality;

  // THE PICKER CANNOT PRODUCE A BAD VALUE; A RESTORED DRAFT CAN. Unsaved rule
  // drafts are persisted, so a draft written before `suppress` became a closed
  // set outlives the control that used to accept it. Refusing here is what
  // keeps that from reaching a backend that answers an unknown variant by
  // discarding the entire strategy document.
  const suppress = parseSuppressSpec(draft.suppress);
  if (!suppress.ok) return { ok: false, error: suppress.error };
  if (suppress.kinds.length > 0) set.suppress = suppress.kinds;

  if (draft.rankWeight.trim() !== "") {
    const weight = Number(draft.rankWeight);
    if (!Number.isFinite(weight)) {
      return { ok: false, error: `Rank weight must be a number (got '${draft.rankWeight}').` };
    }
    set.rankWeight = weight;
  }

  const note = draft.note.trim();
  return {
    ok: true,
    rule: { id, measure: draft.measure, scope, set, note: note === "" ? undefined : note },
  };
}

// ===========================================================================
// Confirm all — the bulk gesture, and the two things it refuses to confirm
