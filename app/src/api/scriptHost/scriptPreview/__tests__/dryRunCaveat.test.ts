//! FILENAME: app/src/api/scriptHost/scriptPreview/__tests__/dryRunCaveat.test.ts
// PURPOSE: "It ran without error but changed no cells. That is expected if the
//          open sheet has nothing for it to act on" must NEVER be shown when the
//          reason for the zero is that the handler holding the work was never
//          fired.
// CONTEXT: docs/design/local-model-script-authoring.md §5c.1. Moved here from
//          `AIChat/__tests__/dryRunNotes.test.ts` on 2026-08-26 with the leaf,
//          five cases unchanged, plus the `tone` cases.
//
//          THE INVARIANT LIVES IN THE ORDER of the two branches, which is
//          exactly the kind of rule that survives review and dies on the next
//          edit — so it is pinned here rather than trusted to a component tree.

import { describe, it, expect } from "vitest";
import { dryRunCaveat } from "../dryRunCaveat";

/** The sentence that blames the user's data. Correct exactly once. */
const BLAMES_THE_DATA = "expected if the open sheet has nothing for it to act on";

describe("dryRunCaveat", () => {
  it("does NOT blame the open sheet when a handler was never fired", () => {
    const note = dryRunCaveat({ changedNothing: true, unexercisedHooks: ["onSelectionChange"] });
    expect(note, "the preview's own limitation is not the user's data").not.toContain(BLAMES_THE_DATA);
    expect(note).toContain("never fired");
    expect(note).toContain("onSelectionChange");
  });

  it("says it even when cells DID change — half a script is still half measured", () => {
    const note = dryRunCaveat({ changedNothing: false, unexercisedHooks: ["onSelectionChange"] });
    expect(note).toContain("never fired");
    expect(note).not.toContain(BLAMES_THE_DATA);
  });

  it("DOES blame the open sheet when nothing was left unfired", () => {
    // The positive control. Without it, an implementation that returned "" for
    // everything would pass the two cases above.
    const note = dryRunCaveat({ changedNothing: true, unexercisedHooks: [] });
    expect(note).toContain(BLAMES_THE_DATA);
    expect(note).not.toContain("never fired");
  });

  it("says nothing at all about an ordinary successful run", () => {
    expect(dryRunCaveat({ changedNothing: false, unexercisedHooks: [] })).toBe("");
  });

  it("tolerates a report that omits the field", () => {
    // Third-party providers and hand-built doubles reach this, and a render must
    // not throw. An absent list means the same as an empty one.
    const note = dryRunCaveat({ changedNothing: true, unexercisedHooks: undefined });
    expect(note).toContain(BLAMES_THE_DATA);
    expect(dryRunCaveat({ changedNothing: false, unexercisedHooks: undefined })).toBe("");
  });

  it("lists several handlers as a sentence, never as an array literal", () => {
    const note = dryRunCaveat({
      changedNothing: true,
      unexercisedHooks: ["onSelectionChange", "onDataChange"],
    });
    expect(note).toContain("onSelectionChange and onDataChange");
    expect(note).not.toContain("[");
  });

  // ---- tone -----------------------------------------------------------------

  it("defaults to the guided screen's wording, byte for byte", () => {
    // The default must be a NO-OP against what shipped, or moving this leaf
    // silently restyled a screen nobody asked to change.
    const hooks = dryRunCaveat({ changedNothing: true, unexercisedHooks: ["onSelectionChange"] });
    expect(hooks).toBe(
      "The script registered onSelectionChange, but the preview never fired it, so nothing " +
        "that handler does was measured. Try it on real data before relying on it.",
    );
    expect(dryRunCaveat({ changedNothing: true, unexercisedHooks: [], tone: "advice" })).toBe(
      dryRunCaveat({ changedNothing: true, unexercisedHooks: [] }),
    );
  });

  it("says 'before accepting' on the diff, where the next action is Accept", () => {
    // Byte-identical to what AiEditDiff.tsx already renders inline — that is
    // what keeps objectScriptEditorAiEdit.test.tsx:508 and :598 green.
    const one = dryRunCaveat({
      changedNothing: false, unexercisedHooks: ["onSelectionChange"], tone: "review",
    });
    expect(one).toContain("Read that handler yourself before accepting.");
    expect(one).not.toContain("Try it on real data");

    const many = dryRunCaveat({
      changedNothing: false, unexercisedHooks: ["onSelectionChange", "onDataChange"], tone: "review",
    });
    expect(many).toContain("Read those handlers yourself before accepting.");

    const zero = dryRunCaveat({ changedNothing: true, unexercisedHooks: [], tone: "review" });
    expect(zero).toContain(BLAMES_THE_DATA);
    expect(zero).toContain("read it yourself before accepting");
    expect(zero).not.toContain("check it against real data");
  });
});
