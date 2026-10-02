// FILENAME: app/extensions/Collaboration/lib/__tests__/includeInApplication.test.ts
// PURPOSE: M4 -- the push dialog's "Include in application" and the push
//          readiness around it, as pure rules.
// CONTEXT: A macro, notebook or name the author creates in a working copy is
//          theirs, so a push withholds it; ticking "Include in application"
//          ADDS it -- under the author's key. So a tick is refused until the
//          code has been on screen, it names the hash RUST computed of that
//          code (never one computed here), and a tick whose code changed since
//          it was read is recognisable as such. And a button whose macro the
//          push leaves out blocks the push, naming the remedy that works.

import { describe, it, expect } from "vitest";
import type { UnshippedMacroLinkItem, WithheldContent } from "@api";
import {
  EMPTY_INCLUDE_STATE,
  includeList,
  includeSignature,
  isIncluded,
  isReviewed,
  isTickedForOtherCode,
  markReviewed,
  pruneTicks,
  setIncluded,
  unhonouredIncludes,
} from "../includeInApplication";
import { describeUnshippedLink, pushBlockingReason, type PushReadinessInput } from "../pushReadiness";

const MACRO: WithheldContent = {
  kind: "moduleScript",
  id: "macro-new",
  name: "New report",
  reason: "notInApplication",
  owner: "",
  includable: true,
  contentHash: "rust-hash-1",
  code: "NewReport();",
  detail: "",
};
const FOREIGN: WithheldContent = {
  kind: "moduleScript",
  id: "macro-fin",
  name: "Close the month",
  reason: "otherApplication",
  owner: "finance",
  includable: false,
  contentHash: "",
  code: "",
  detail: "",
};

describe("a tick needs the code on screen, and names Rust's hash", () => {
  // SABOTAGE: drop `|| !isReviewed(state, item)` from `setIncluded`.
  it("refuses a tick before the code was shown", () => {
    const before = setIncluded(EMPTY_INCLUDE_STATE, MACRO, true);
    expect(isIncluded(before, MACRO)).toBe(false);
    expect(includeList(before)).toEqual([]);

    const read = markReviewed(EMPTY_INCLUDE_STATE, MACRO);
    expect(isReviewed(read, MACRO)).toBe(true);
    const ticked = setIncluded(read, MACRO, true);
    expect(isIncluded(ticked, MACRO)).toBe(true);
    expect(includeList(ticked)).toEqual([{ kind: "moduleScript", id: "macro-new", hash: "rust-hash-1" }]);
  });

  it("never lets another application's code (or anything Rust did not offer) be ticked", () => {
    const read = markReviewed(EMPTY_INCLUDE_STATE, FOREIGN);
    expect(isReviewed(read, FOREIGN), "no code to read was offered").toBe(false);
    expect(includeList(setIncluded(read, FOREIGN, true))).toEqual([]);
    const noHash = { ...MACRO, contentHash: "" };
    expect(includeList(setIncluded(markReviewed(EMPTY_INCLUDE_STATE, noHash), noHash, true))).toEqual([]);
  });

  it("reading code at one hash is not reading it at another", () => {
    const read = markReviewed(EMPTY_INCLUDE_STATE, MACRO);
    const edited = { ...MACRO, contentHash: "rust-hash-2", code: "fetch('x');" };
    expect(isReviewed(read, edited)).toBe(false);
    expect(includeList(setIncluded(read, edited, true))).toEqual([]);
  });

  it("a tick for code that changed since is recognisable, and unticks cleanly", () => {
    const ticked = setIncluded(markReviewed(EMPTY_INCLUDE_STATE, MACRO), MACRO, true);
    const edited = { ...MACRO, contentHash: "rust-hash-2" };
    expect(isIncluded(ticked, edited)).toBe(false);
    expect(isTickedForOtherCode(ticked, edited)).toBe(true);
    // The answer came back without it (Rust withheld the edited macro).
    expect(unhonouredIncludes(ticked, [])).toEqual([{ kind: "moduleScript", id: "macro-new", hash: "rust-hash-1" }]);
    expect(unhonouredIncludes(ticked, [MACRO])).toEqual([]);
    expect(unhonouredIncludes(ticked, [edited]), "added under another hash is not what was read").toHaveLength(1);
    const unticked = setIncluded(ticked, edited, false);
    expect(includeList(unticked)).toEqual([]);
  });

  it("a workbook name is one item whatever its case; the signature is order-stable", () => {
    const name: WithheldContent = { ...MACRO, kind: "namedRange", id: "Rate", contentHash: "h-rate" };
    const read = markReviewed(markReviewed(EMPTY_INCLUDE_STATE, name), MACRO);
    const a = setIncluded(setIncluded(read, name, true), MACRO, true);
    const b = setIncluded(setIncluded(read, MACRO, true), name, true);
    expect(includeSignature(a)).toBe(includeSignature(b));
    expect(isIncluded(a, { ...name, id: "RATE" })).toBe(true);
  });
});

describe("a tick for an item the answer no longer offers at all is dropped", () => {
  // SABOTAGE: make `pruneTicks` return `state` unchanged.
  it("drops a tick for an item in neither list -- shipped since, or gone -- and keeps the rest", () => {
    const name: WithheldContent = { ...MACRO, kind: "namedRange", id: "Rate", contentHash: "h-rate" };
    const read = markReviewed(markReviewed(EMPTY_INCLUDE_STATE, name), MACRO);
    const ticked = setIncluded(setIncluded(read, name, true), MACRO, true);

    // The macro shipped with the last push: it is part of the application now.
    const pruned = pruneTicks(ticked, [name], []);
    expect(includeList(pruned)).toEqual([{ kind: "namedRange", id: "Rate", hash: "h-rate" }]);
    // What was read stays read.
    expect(isReviewed(pruned, MACRO)).toBe(true);

    // Still offered -- withheld (even at another hash: "changed since you read
    // it" is the dialog's to say) or added -- is kept.
    expect(pruneTicks(ticked, [{ ...MACRO, contentHash: "rust-hash-2" }], [name])).toBe(ticked);
    expect(pruneTicks(ticked, [], [MACRO, { ...name, id: "RATE" }]), "a name matches whatever its case").toBe(ticked);
  });
});

const ready: PushReadinessInput = {
  mode: "push",
  registryPath: "\\\\server\\reports",
  packageName: "sales",
  version: "1.0.1",
  changeSummary: "a change",
  pushed: false,
  sheetsSelected: 1,
  sheetsAvailable: 1,
  kind: "report",
  nameAlreadyTaken: false,
};

const link = (over: Partial<UnshippedMacroLinkItem>): UnshippedMacroLinkItem => ({
  cell: "Dashboard!B4",
  kind: "control",
  macroId: "macro-report",
  macroName: "Report",
  remedy: "include",
  owner: "",
  ...over,
});

describe("a button whose macro the push leaves out blocks the push, with its remedy", () => {
  // SABOTAGE: drop the `unshippedMacroLinks` rule from pushBlockingReason.
  it("names the button, the macro and the remedy that works -- all three kinds", () => {
    expect(pushBlockingReason({ ...ready, unshippedMacroLinks: [link({})] })).toBe(
      'The button at Dashboard!B4 runs the macro "Report", which this push does not publish: tick Include ' +
        "in application next to it, or unlink the button.",
    );
    const theirs = pushBlockingReason({
      ...ready,
      unshippedMacroLinks: [link({ remedy: "otherApplication", owner: "finance", macroName: "Close" })],
    });
    expect(theirs).toMatch(/runs "Close", which belongs to the application "finance"/);
    expect(theirs).toMatch(/cannot run another application's macro\. Unlink it, or copy the macro/);
    expect(theirs).not.toMatch(/tick Include/);
    const gone = pushBlockingReason({
      ...ready,
      unshippedMacroLinks: [link({ remedy: "missing", macroName: "", macroId: "macro-gone", kind: "cell" })],
    });
    expect(gone).toBe(
      'The button cell at Dashboard!B4 runs the macro "macro-gone", which does not exist in this workbook: ' +
        "unlink the button, or restore the macro.",
    );
  });

  it("counts the rest, and clears once the answer has none (the tick landed)", () => {
    const two = pushBlockingReason({ ...ready, unshippedMacroLinks: [link({}), link({ cell: "Dashboard!B9" })] });
    expect(two).toMatch(/and 1 more button\(s\)/);
    expect(pushBlockingReason({ ...ready, unshippedMacroLinks: [] })).toBeNull();
  });

  // SABOTAGE: drop the `includeStale` rule from pushBlockingReason.
  it("waits while the answer is for another inclusion -- and trusts neither direction", () => {
    const why = pushBlockingReason({ ...ready, includeStale: true, unshippedMacroLinks: [] });
    expect(why).toMatch(/Checking what you included in the application/);
    expect(why).toMatch(/press Preview/);
    expect(pushBlockingReason({ ...ready, includeStale: true, unshippedMacroLinks: [link({})] })).toMatch(
      /Checking what you included/,
    );
  });

  // SABOTAGE: drop the `includeChanged` rule from pushBlockingReason.
  it("blocks a tick whose code changed since it was read", () => {
    const why = pushBlockingReason({ ...ready, includeChanged: ["New report"] });
    expect(why).toMatch(/"New report" changed since you read it/);
    expect(why).toMatch(/open its code again and tick Include in application, or untick it/);
  });

  it("describes a link on its own for the panel", () => {
    expect(describeUnshippedLink(link({ kind: "cell" }))).toMatch(/^The button cell at Dashboard!B4/);
  });
});
