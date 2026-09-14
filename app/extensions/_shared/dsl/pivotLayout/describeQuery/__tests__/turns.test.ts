//! FILENAME: app/extensions/_shared/dsl/pivotLayout/describeQuery/__tests__/turns.test.ts
// PURPOSE: The decisions a draft turn makes, none of which needs a render.
// CONTEXT: These are the cases nobody clicks: a draft identical to the text
//          already in the editor, a draft whose dsl is empty, an Accept pressed
//          on turn 1 after turn 3 moved the editor underneath it. A component
//          test reaches them only through a render and a click; here they are
//          just function calls, which is why the logic lives outside the
//          component in the first place.

import { describe, it, expect } from "vitest";
import {
  dispositionFor,
  isActionable,
  priorFor,
  recheck,
  showsDiff,
  type DraftTurn,
} from "../turns";
import type { DesignQueryDraft } from "../../draft";

function draftOf(over: Partial<DesignQueryDraft> = {}): DesignQueryDraft {
  return {
    status: "compiled",
    dsl: "ROWS: Product.Category\nVALUES: [Revenue]",
    explanation: "",
    errors: [],
    warnings: [],
    request: null,
    dryRun: null,
    rounds: 1,
    model: "fake",
    summary: "Compiled by Calcula.",
    candidates: {} as DesignQueryDraft["candidates"],
    grammarUsed: false,
    ...over,
  };
}

function turnOf(over: Partial<DraftTurn> = {}): DraftTurn {
  return {
    id: 1,
    intent: "revenue by category",
    model: "fake",
    draft: draftOf(),
    failure: null,
    disposition: "pending",
    ...over,
  };
}

describe("dispositionFor", () => {
  it("offers a compiled draft that differs from the editor", () => {
    expect(dispositionFor(draftOf(), "ROWS: Product.Name")).toBe("pending");
  });

  it("calls a draft identical to the editor a no-op rather than a diff of nothing", () => {
    // Without this the panel shows a side-by-side with two identical panes and
    // an Accept that writes the same bytes back — which looks like the model
    // did something and reads as a change in the undo stack.
    const d = draftOf();
    expect(dispositionFor(d, d.dsl)).toBe("noop");
  });

  it("compares CANONICALLY, so clause order and whitespace are not a change", () => {
    // `sameDesignQuery` canonicalises before comparing. A model that answers
    // the same query with its clauses in a different order has proposed
    // nothing, and saying otherwise trains the person to accept diffs that do
    // not matter.
    const d = draftOf({ dsl: "VALUES: [Revenue]\nROWS: Product.Category" });
    expect(dispositionFor(d, "ROWS: Product.Category\nVALUES: [Revenue]")).toBe("noop");
  });

  it("treats an EMPTY dsl as a no-op even when the status says compiled", () => {
    // Reachable: the drafter can exhaust its repair budget with nothing
    // extractable. Applying "" over a working query silently blanks the editor,
    // which is the worst outcome in the whole feature.
    expect(dispositionFor(draftOf({ dsl: "" }), "ROWS: X.Y")).toBe("noop");
    expect(dispositionFor(draftOf({ dsl: "   \n  " }), "ROWS: X.Y")).toBe("noop");
  });

  it("still offers an INVALID draft, because the editor's markers are the fix", () => {
    // Deliberate inherited behaviour: a query that does not compile is put in
    // the editor ON PURPOSE, where the error markers point at what to change.
    // The gate changed WHEN that happens, not whether.
    expect(dispositionFor(draftOf({ status: "invalid" }), "ROWS: X.Y")).toBe("invalid");
  });

  it("has nothing to show for a declined reply", () => {
    expect(dispositionFor(draftOf({ status: "declined", dsl: "" }), "")).toBe("declined");
  });

  it("offers a first draft into an EMPTY editor rather than calling it a no-op", () => {
    // Two empty strings are canonically equal, so a naive compare would call
    // the very first draft a no-op and the feature would never apply anything.
    expect(dispositionFor(draftOf(), "")).toBe("pending");
    expect(dispositionFor(draftOf(), "   ")).toBe("pending");
  });
});

describe("showsDiff", () => {
  it("shows a diff only when there is something on the left", () => {
    expect(showsDiff(turnOf(), "ROWS: Product.Name")).toBe(true);
    // A diff whose original pane is blank is a worse way to read a query than
    // the query.
    expect(showsDiff(turnOf(), "")).toBe(false);
    expect(showsDiff(turnOf({ disposition: "applied" }), "ROWS: X.Y")).toBe(false);
  });
});

describe("recheck", () => {
  it("turns an Accept into a no-op when the editor already caught up", () => {
    // THE STALE-ACCEPT CASE. Turn 1 is offered, turn 3 is accepted, and then
    // turn 1's button is pressed. Its draft may now be exactly what is there.
    const turn = turnOf();
    const after = recheck(turn, turn.draft!.dsl);
    expect(after.disposition).toBe("noop");
  });

  it("leaves a still-valid turn alone, object identity included", () => {
    // Returning a new object on every render-time recheck would remount the
    // turn and restart its entry animation on every keystroke in the editor.
    const turn = turnOf();
    expect(recheck(turn, "ROWS: Other.Thing")).toBe(turn);
  });

  it("does not touch a turn that was already decided", () => {
    for (const d of ["applied", "rejected", "declined", "failed", "noop"] as const) {
      const turn = turnOf({ disposition: d });
      expect(recheck(turn, "anything")).toBe(turn);
      expect(isActionable(turn)).toBe(false);
    }
  });
});

describe("priorFor", () => {
  it("refines the most recent answer that still stands", () => {
    const prior = priorFor([
      turnOf({ id: 1, intent: "first", draft: draftOf({ dsl: "ROWS: A.B" }) }),
      turnOf({ id: 2, intent: "second", draft: draftOf({ dsl: "ROWS: C.D" }) }),
    ]);
    expect(prior).toEqual({ intent: "second", dsl: "ROWS: C.D" });
  });

  it("SKIPS a rejected turn — the person said that is not what they wanted", () => {
    // Sending a discarded draft back as the thing to modify is the opposite of
    // listening, and it is the case a naive "last turn" would get wrong.
    const prior = priorFor([
      turnOf({ id: 1, intent: "first", draft: draftOf({ dsl: "ROWS: A.B" }) }),
      turnOf({
        id: 2,
        intent: "second",
        draft: draftOf({ dsl: "ROWS: C.D" }),
        disposition: "rejected",
      }),
    ]);
    expect(prior).toEqual({ intent: "first", dsl: "ROWS: A.B" });
  });

  it("skips failures and declines, which carry no query to refine", () => {
    expect(
      priorFor([
        turnOf({ id: 1, draft: null, failure: "boom", disposition: "failed" }),
        turnOf({ id: 2, draft: draftOf({ dsl: "" }), disposition: "declined" }),
      ]),
    ).toBeNull();
  });

  it("starts fresh when there is no transcript", () => {
    expect(priorFor([])).toBeNull();
  });

  it("refines an APPLIED turn, which is the ordinary follow-up", () => {
    // "Revenue by category" → accept → "make it monthly". The accepted query is
    // exactly the thing the follow-up edits.
    const prior = priorFor([
      turnOf({ id: 1, intent: "revenue by category", disposition: "applied" }),
    ]);
    expect(prior?.intent).toBe("revenue by category");
  });
});
