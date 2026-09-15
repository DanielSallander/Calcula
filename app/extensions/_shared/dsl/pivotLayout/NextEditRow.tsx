//! FILENAME: app/extensions/_shared/dsl/pivotLayout/NextEditRow.tsx
// PURPOSE: The row of next-edit suggestions under a design-query editor:
//          what the strategy thinks the query wants next, each with its
//          reason, accepted with one click.
// CONTEXT: Owner decision D9, 2026-09-11: suggestions everywhere the DSL is
//          edited, starting as an accept-able row below the editor. This row
//          needs NO model: it runs the rules in `@api/designQueryAssist/nextEdit`
//          over the parsed text (Tier 0), and the model's own chip (Milestone
//          B) is added beside these, never instead of them.
//
// THREE RULES THIS COMPONENT KEEPS, the same three as the describe row:
//
//  1. ACCEPT EDITS THE TEXT AND NOTHING ELSE. The edited query goes back into
//     the editor through `onApply`; Create, Save and Apply stay the person's
//     click. The edit is textual (`applyEditOp`), so the rest of the query is
//     left exactly as typed — and it is applied to what is in the editor NOW,
//     not to the text the chip was computed from. The first version carried a
//     precomputed string on each chip, so accepting a second chip reverted the
//     first, and accepting during the debounce threw away what had just been
//     typed.
//
//  2. A CHIP IS EARNED, AND THE BAR IS "DO NOT MAKE IT WORSE". A suggestion is
//     shown only if compiling the edited query reports no more errors and no
//     more warnings than the query already had. An ABSOLUTE bar (the edit must
//     compile cleanly) looked stricter and was wrong: the hosts substitute
//     `@Name` control parameters before they compile, this row does not, so
//     every query using the Reports @param binding failed the bar and the whole
//     row vanished — on exactly the half-finished queries where a suggestion is
//     worth most.
//
//  3. NO NAGGING, BUT NOT A ONE-WAY DOOR. A dismissed suggestion stays
//     dismissed for the editor's lifetime, and the row renders nothing when it
//     has nothing to say — but a dismissal is undoable while the rules would
//     still make it, and the row stays mounted for exactly that reason. It used
//     to unmount the moment the last chip went, which took the way back with
//     it: the one moment you want it is the one moment it was unreachable.
//
// THE MODEL'S CHIP IS BUILT AND OFF (`MODEL_CHIP_DEFAULT`, below). Milestone B
// wired it end to end and then measured it, and the built-in 1.5B got the next
// clause right zero times out of eighty while proposing one on all fifty-two
// queries that were already finished. Rule 3 is the reason it is off rather
// than merely disappointing: a suggestion that is always wrong and never quiet
// is how a person learns to ignore the row that the RULES are also on.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { getAiCompletionProvider } from "@api";
import {
  buildNextClauseRequest,
  chooseCandidates,
  nextClauseSuggestion,
  roleOfSuggestion,
  type DesignQueryModel,
  type NextEditSuggestion,
} from "@api/designQueryAssist";
import {
  MAX_CHIPS,
  applyEditOp,
  factsFromDsl,
  presentClauses,
  rulesChips,
  worseThan,
  type CompileVerdict,
  type NextEditChip,
} from "./nextEditFacts";
import { compileDesignQuery } from "./designQuery";
import type { BiPivotModelInfo } from "../../components/types";

// The chip loop, the compile veto and the cap live in `nextEditFacts` so the
// corpus gate and the offline runner measure the row rather than a copy of it,
// and they are imported FROM there — this module does not re-export them. A
// re-export with no importer is a second name for one thing, and the next
// reader has to find out which one is canonical.

/** Recompute after this much quiet, so a keystroke never races a chip. */
export const DEBOUNCE_MS = 300;

/**
 * Whether the model's chip is asked for at all, by default: NO.
 *
 * MEASURED, 2026-09-11, built-in runtime (llama.cpp + qwen2.5-coder-1.5b-
 * instruct, grammar honoured), `tests/eval/run-next-edit-eval.mjs` over every
 * prefix of the 52 correct queries in `tests/eval/design-queries.json`:
 *
 *   exact next clause   0 of 80   (rules alone 19; a perfect model scores 79)
 *   quiet on a finished query   0 of 52   — it proposed a clause every time
 *   latency             median 686 ms, p90 848 ms   (the gate was 400 ms)
 *
 * Not one right answer, a nag on every completed query, and twice the latency
 * budget. The plumbing is right — the grammar makes an invented name
 * impossible, the reply is always a legal clause, the empty reply is legal and
 * the runtime honours it — and the 1.5B still has nothing to add over rules
 * that read the strategy. So the chip stays built, measured and OFF, and the
 * runner decides when a better model makes it worth switching on. Turning it on
 * is one prop; the number that would justify it is one command.
 */
export const MODEL_CHIP_DEFAULT = false;

export interface NextEditRowProps {
  /** The editor's current text. */
  text: string;
  biModel: BiPivotModelInfo | null | undefined;
  /** For the compile check. Unused when there is no model. */
  connectionId?: string;
  /** Put the edited query into the editor. */
  onApply: (dsl: string) => void;
  /** Injected by tests; the real compiler otherwise. */
  compile?: (dsl: string) => CompileVerdict;
  /** Injected by tests; zero disables the debounce. */
  debounceMs?: number;
  /**
   * Ask the selected model for one more clause where the rules left room.
   *
   * OFF BY DEFAULT, on the measurement (see the note above the component).
   * When switched on, nothing is asked unless a model is selected AND its
   * runtime is known to honour a grammar — a wrong clause is worse than no
   * clause, and the grammar is what makes a wrong NAME impossible.
   */
  askModel?: boolean;
  /**
   * Dismissed suggestion ids, when the host wants to SHARE them with the
   * editor's ghost text (Milestone C). Two sets would mean dismissing a
   * suggestion here and finding it still sitting in the text. Omitted, the row
   * keeps its own for its lifetime, exactly as before.
   */
  dismissed?: Set<string>;
}

/**
 * The model's suggestion for the next clause, or null.
 *
 * Grammar-gated on purpose: `honorsGrammar()` is `true` only where the runtime
 * was measured to honour one (or is llama.cpp by identity and unmeasured), and
 * without it the model can name a column that does not exist. The rules never
 * wait for this; it arrives beside them or not at all.
 */
export async function askModelForNextClause(
  text: string,
  model: DesignQueryModel,
  signal: AbortSignal,
): Promise<NextEditSuggestion | null> {
  const provider = getAiCompletionProvider();
  if (!provider || !provider.isConfigured() || provider.honorsGrammar() !== true) return null;
  const facts = factsFromDsl(text, model.tables.map((t) => t.name));
  if (facts.hasParseErrors) return null;
  const request = buildNextClauseRequest(chooseCandidates(model, ""), presentClauses(facts), text);
  if (!request) return null;

  const reply = await provider.complete(
    {
      system: request.system,
      messages: [{ role: "user", text: request.user }],
      maxTokens: request.maxTokens,
      temperature: 0,
      grammar: request.grammar,
    },
    { signal },
  );
  return nextClauseSuggestion(reply.text, reply.model || provider.modelLabel() || "the model");
}

const EMPTY_MODEL: DesignQueryModel = { tables: [], measures: [] };

/**
 * The chips for a text, in this editor's terms: the host's model and connection
 * turned into the arguments `rulesChips` takes. The loop itself is not here —
 * the corpus gate and the offline runner call the same one.
 */
export function chipsFor(
  text: string,
  biModel: BiPivotModelInfo | null | undefined,
  connectionId: string,
  dismissed: ReadonlySet<string>,
  compile?: NextEditRowProps["compile"],
): NextEditChip[] {
  const tableNames = (biModel?.tables ?? []).map((t) => t.name);
  const model = (biModel as DesignQueryModel | null | undefined) ?? EMPTY_MODEL;
  const check = compile ?? (biModel ? (dsl: string) => compileDesignQuery(dsl, connectionId, biModel) : null);
  return rulesChips(text, model, tableNames, check, dismissed);
}

const rowStyle: React.CSSProperties = {
  display: "flex", flexWrap: "wrap", gap: 6, alignItems: "flex-start", marginTop: 6,
};
const chipStyle: React.CSSProperties = {
  display: "flex", flexDirection: "column", gap: 2, padding: "4px 8px", fontSize: 11,
  border: "1px solid var(--border-default, #d1d5db)", borderRadius: 4,
  background: "var(--panel-bg, #f9fafb)", color: "inherit", maxWidth: 360,
};
const chipHeadStyle: React.CSSProperties = { display: "flex", gap: 6, alignItems: "center" };
const acceptStyle: React.CSSProperties = {
  padding: "2px 8px", fontSize: 11, borderRadius: 3, border: "none", cursor: "pointer",
  background: "var(--accent-color, #1a5fb4)", color: "#fff", whiteSpace: "nowrap",
};
const dismissStyle: React.CSSProperties = {
  padding: "2px 6px", fontSize: 11, borderRadius: 3, border: "1px solid var(--border-default, #d1d5db)",
  background: "transparent", color: "inherit", cursor: "pointer",
};
const reasonStyle: React.CSSProperties = { color: "var(--text-secondary, #6b7280)", margin: 0 };
const undoStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 4, alignSelf: "center",
  padding: "3px 8px", fontSize: 11, borderRadius: 4,
  border: "1px dashed var(--border-default, #d1d5db)",
  background: "transparent", color: "var(--text-secondary, #6b7280)", cursor: "pointer",
};

export function NextEditRow({
  text,
  biModel,
  connectionId = "",
  onApply,
  compile,
  debounceMs = DEBOUNCE_MS,
  askModel = MODEL_CHIP_DEFAULT,
  dismissed: sharedDismissed,
}: NextEditRowProps): React.ReactElement | null {
  const [chips, setChips] = useState<NextEditChip[]>([]);
  const [modelChip, setModelChip] = useState<NextEditChip | null>(null);
  const ownDismissed = useRef<Set<string>>(new Set());
 // The set the row reads and writes. A host that also renders ghost text passes
  // its own so the two surfaces share one; otherwise the row keeps its own for
  // its lifetime, exactly as before. Both references are stable, so this is not
  // a new object per render even though it is computed in the body.
  const dismissed = sharedDismissed ?? ownDismissed.current;
  // The editor's text as of the last commit. Accept reads THIS, not the string
  // a chip was built from, so a chip accepted after another chip (or after more
  // typing) edits what is actually in the editor.
  const latestText = useRef(text);
  useEffect(() => {
    latestText.current = text;
  }, [text]);

  // WHAT A DISMISS WOULD GIVE BACK, newest first.
  //
  // Derived rather than logged. A dismissal is remembered as an id in a set,
  // and a suggestion's id is a function of its kind and its edit — so the
  // suggestions this query WOULD offer, minus the filter, are exactly the
  // dismissed ones, labels and all. A separate log of what was dismissed would
  // be a second source of truth that goes stale the moment the query moves on:
  // it would keep offering to restore a suggestion the rules no longer make.
  //
  // Self-correcting for the same reason. Dismiss "add a time axis", then add
  // one by hand, and the rule stops firing — so there is nothing to restore and
  // the control quietly disappears instead of promising something it cannot do.
  const [restorable, setRestorable] = useState<NextEditChip[]>([]);

  const recompute = useCallback(() => {
    setChips(chipsFor(text, biModel, connectionId, dismissed, compile));
    // Only when something was actually dismissed: this is a second full pass
    // over the rules with the compile veto, and paying it on every debounce for
    // the overwhelmingly common empty set would double the row's cost for
    // nothing.
    if (dismissed.size === 0) {
      setRestorable([]);
      return;
    }
    const order = [...dismissed];
    setRestorable(
      chipsFor(text, biModel, connectionId, new Set(), compile)
        .filter((c) => dismissed.has(c.suggestion.id))
        .sort((a, b) => order.indexOf(b.suggestion.id) - order.indexOf(a.suggestion.id)),
    );
  }, [text, biModel, connectionId, compile]);

  useEffect(() => {
    if (debounceMs <= 0) {
      recompute();
      return;
    }
    const timer = setTimeout(recompute, debounceMs);
    return () => clearTimeout(timer);
  }, [recompute, debounceMs]);

  // The model's chip: asked for AFTER the rules, never blocking them, only
  // where there is room on the row, and abandoned the moment the text changes.
  //
  // The room is computed from THIS text, not from `chips`. `chips` is state set
  // by the debounced recompute, so reading it here asked the model about the
  // text before last — on the first render it is empty, so the model was asked
  // even when the rules were about to fill the row. `rulesChips` is pure and
  // cheap, and this effect already runs on the same debounce.
  useEffect(() => {
    setModelChip(null);
    if (!askModel || !biModel || !text.trim()) return;
    const controller = new AbortController();
    let cancelled = false;
    const timer = setTimeout(() => {
      const current = chipsFor(text, biModel, connectionId, dismissed, compile);
      if (current.length >= MAX_CHIPS) return;
      void askModelForNextClause(text, biModel as DesignQueryModel, controller.signal)
        .then((suggestion) => {
          if (cancelled || !suggestion || dismissed.has(suggestion.id)) return;
          const applied = applyEditOp(text, suggestion.op);
          if (applied === text) return;
          // NOT A SECOND CHIP FOR THE SAME EDIT. A rule that already proposes
          // this exact query says WHY from the document; the model can only say
          // it seemed likely. Milestone A dedupes the rules against each other
          // on the resulting edit for the same reason.
          if (current.some((c) => c.applied === applied)) return;
          const check = compile ?? ((dsl: string) => compileDesignQuery(dsl, connectionId, biModel));
          if (worseThan(check(text), check(applied))) return;
          setModelChip({ suggestion, applied });
        })
        .catch(() => {
          // A model that cannot answer costs the person nothing: the rules'
          // chips are already on screen and this one simply never appears.
        });
    }, Math.max(debounceMs, 0));
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [text, biModel, connectionId, compile, debounceMs, askModel]);

  const drop = useCallback((id: string) => {
    setChips((prev) => prev.filter((c) => c.suggestion.id !== id));
    setModelChip((prev) => (prev && prev.suggestion.id === id ? null : prev));
  }, []);

  const accept = useCallback((chip: NextEditChip) => {
    const current = latestText.current;
    const applied = applyEditOp(current, chip.suggestion.op);
    // The edit no longer applies to what is in the editor — the person accepted
    // another chip first, or typed past it. Take the chip away rather than
    // writing a stale query over their work.
    if (applied === current) {
      drop(chip.suggestion.id);
      return;
    }
    onApply(applied);
  }, [onApply, drop]);

  const dismiss = useCallback((chip: NextEditChip) => {
    dismissed.add(chip.suggestion.id);
    drop(chip.suggestion.id);
    // Recompute so the undo control appears in the same paint that the chip
    // leaves; without it the row can go empty for a debounce and take the way
    // back with it.
    recompute();
  }, [drop, recompute]);

  /** Put the most recently dismissed suggestion back. */
  const undismiss = useCallback(() => {
    const newest = restorable[0];
    if (!newest) return;
    dismissed.delete(newest.suggestion.id);
    recompute();
  }, [restorable, recompute]);

  // The rules first, the model last: a rule can say WHY from the document.
  const shown = modelChip ? [...chips, modelChip] : chips;
  // NOT `shown.length === 0`. Dismissing the last chip used to unmount the whole
  // row, which would take the undo control with it — so the one moment you most
  // want it back is the one moment it cannot be reached. The row survives while
  // anything is restorable.
  if (shown.length === 0 && restorable.length === 0) return null;

  return (
    <div style={rowStyle} data-testid="next-edit-row" aria-label="Suggested next edits">
      {shown.map((chip) => (
        <div
          key={chip.suggestion.id}
          style={chipStyle}
          data-testid="next-edit-chip"
          data-kind={chip.suggestion.kind}
          data-source={chip.suggestion.source}
          // Corrections and explorations look alike and mean different things:
          // one says the query is wrong, the other that it could go further.
          // Exposed so a test can tell them apart without parsing the label.
          data-role={roleOfSuggestion(chip.suggestion)}
        >
          <div style={chipHeadStyle}>
            <button type="button" style={acceptStyle} onClick={() => accept(chip)} data-testid="next-edit-accept">
              {chip.suggestion.text}
            </button>
            <button
              type="button"
              style={dismissStyle}
              onClick={() => dismiss(chip)}
              aria-label={`Dismiss the suggestion: ${chip.suggestion.text}`}
              data-testid="next-edit-dismiss"
            >
              Dismiss
            </button>
          </div>
          <p style={reasonStyle}>{chip.suggestion.reason}</p>
        </div>
      ))}

      {/* THE WAY BACK. A dismissal lasts for the editor's lifetime and leaves
          no trace, so without this the only recovery is closing the dialog and
          starting again — and nothing on screen would even say a suggestion had
          been hidden. It names what it will restore rather than saying "undo",
          because by the time you want it you have forgotten what you dismissed. */}
      {restorable.length > 0 ? (
        <button
          type="button"
          style={undoStyle}
          onClick={undismiss}
          title={`Bring back: ${restorable[0].suggestion.text}`}
          aria-label={`Bring back the dismissed suggestion: ${restorable[0].suggestion.text}`}
          data-testid="next-edit-undismiss"
        >
          <span aria-hidden="true">↩</span>
          {restorable.length > 1 ? `Undo dismiss (${restorable.length})` : "Undo dismiss"}
        </button>
      ) : null}
    </div>
  );
}
