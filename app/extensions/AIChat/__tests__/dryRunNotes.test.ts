//! FILENAME: app/extensions/AIChat/__tests__/dryRunNotes.test.ts
// PURPOSE: "It ran without error but changed no cells. That is expected if the
//          open sheet has nothing for it to act on" must NEVER be shown when the
//          reason for the zero is that the handler holding the work was never
//          fired.
// CONTEXT: docs/design/local-model-script-authoring.md §5c.1.
//
//          THE INVARIANT LIVES IN THE ORDER of the two branches, which is
//          exactly the kind of rule that survives review and dies on the next
//          edit — so it is pinned here rather than trusted to a component tree.

import { describe, it, expect } from "vitest";
import { dryRunCaveat } from "../lib/dryRunNotes";

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
});
