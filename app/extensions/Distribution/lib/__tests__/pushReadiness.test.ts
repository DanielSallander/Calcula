// FILENAME: app/extensions/Distribution/lib/__tests__/pushReadiness.test.ts
// PURPOSE: The Push button must never fail silently.
// CONTEXT: Reported from live testing: "when I try to publish changes to an
//          existing application nothing happens when I click Push — no errors,
//          warnings or confirmations." The button was `disabled={!canPush}` and
//          the only unmet condition was the change summary, whose placeholder is
//          a complete sentence and so reads as a filled field. Nothing was
//          broken underneath; the dialog simply refused to say what it wanted.
//
//          These tests pin the two halves of the fix: every refusal names a
//          FIELD, and a ready dialog is not refused.

import { describe, it, expect } from "vitest";
import { pushBlockingReason, type PushReadinessInput } from "../pushReadiness";

const ready: PushReadinessInput = {
  mode: "push",
  registryPath: "C:\\shared\\ws",
  packageName: "test",
  version: "1.0.1",
  changeSummary: "Adds the regional split.",
  pushed: false,
  sheetsSelected: 1,
  sheetsAvailable: 2,
  kind: "report",
  nameAlreadyTaken: false,
};

describe("pushBlockingReason", () => {
  it("does not block a dialog that is ready", () => {
    expect(pushBlockingReason(ready)).toBeNull();
  });

  it("blocks a push whose change summary is still empty, and says so", () => {
    // THE REPORTED BUG. Everything else is filled; only the summary is not,
    // and the placeholder makes it look like it is.
    const reason = pushBlockingReason({ ...ready, changeSummary: "" });
    expect(reason).toBeTruthy();
    expect(reason).toMatch(/what changed/i);
  });

  it("treats whitespace as empty — a space is not a change summary", () => {
    expect(pushBlockingReason({ ...ready, changeSummary: "   \n\t " })).toBeTruthy();
  });

  it("does NOT require a summary when creating: there is no history to explain", () => {
    expect(
      pushBlockingReason({ ...ready, mode: "create", changeSummary: "" }),
    ).toBeNull();
  });

  it("names the workspace, the name and the version each in their own words", () => {
    const ws = pushBlockingReason({ ...ready, registryPath: "" });
    const name = pushBlockingReason({ ...ready, packageName: "" });
    const ver = pushBlockingReason({ ...ready, version: "" });
    expect(ws).toMatch(/workspace/i);
    expect(name).toMatch(/name/i);
    expect(ver).toMatch(/version/i);
    // Three different fields must not produce one interchangeable sentence:
    // "fill in the required fields" is exactly what sent the user looking at
    // the wrong field.
    expect(new Set([ws, name, ver]).size).toBe(3);
  });

  it("tells an unlinked push to go and check the application out", () => {
    // A push with no workspace means no working-copy link, and the remedy is a
    // different menu item — so the message points at it rather than at the
    // field the user cannot usefully fill in by hand.
    expect(pushBlockingReason({ ...ready, registryPath: "" })).toMatch(
      /open the application for editing/i,
    );
  });

  it("says it is still loading rather than blaming an unfilled field", () => {
    const reason = pushBlockingReason({ ...ready, mode: "loading", changeSummary: "" });
    expect(reason).toMatch(/reading/i);
    // Not the summary message: the fields are not the user's problem yet.
    expect(reason).not.toMatch(/what changed/i);
  });

  it("stops blocking once the push has landed, so the dialog can be closed", () => {
    expect(pushBlockingReason({ ...ready, changeSummary: "", pushed: true })).toBeNull();
  });

  it("every reason is a sentence a person can act on", () => {
    const reasons = [
      pushBlockingReason({ ...ready, mode: "loading" }),
      pushBlockingReason({ ...ready, registryPath: "" }),
      pushBlockingReason({ ...ready, mode: "create", registryPath: "" }),
      pushBlockingReason({ ...ready, packageName: "" }),
      pushBlockingReason({ ...ready, version: "" }),
      pushBlockingReason({ ...ready, changeSummary: "" }),
    ];
    for (const r of reasons) {
      expect(r, "a blocked state returned no reason").toBeTruthy();
      expect(r!.length, `too terse to act on: ${r}`).toBeGreaterThan(20);
      expect(r!.trim().endsWith("."), `not a sentence: ${r}`).toBe(true);
    }
  });
});

describe("an empty tick-list is not an empty publish", () => {
  // Reported from live testing: "even if no sheets are selected it shows a diff
  // in the section above. It looks a bit glitchy."
  //
  // The glitch was the dialog being honest about a push the checkboxes denied.
  // On the wire an empty `sheetIndices` means "resolve the default", which for a
  // working copy is the base version's sheets — so pressing Push with every box
  // clear would have published the default set.

  it("blocks a push with nothing ticked, and says which control to use", () => {
    // SABOTAGE: delete the sheetsSelected check. The dialog then pushes the
    // base sheets while the list shows none selected.
    const reason = pushBlockingReason({ ...ready, sheetsSelected: 0 });
    expect(reason).toBeTruthy();
    expect(reason).toMatch(/sheet/i);
  });

  it("does not block before the sheet list has loaded", () => {
    // `sheetsAvailable === 0` is "still loading", not "nothing to publish".
    // SABOTAGE: drop the sheetsAvailable > 0 term — the button then refuses on
    // open, before the user could possibly have ticked anything.
    expect(
      pushBlockingReason({ ...ready, sheetsSelected: 0, sheetsAvailable: 0 }),
    ).toBeNull();
  });

  it("lets a LIBRARY publish zero sheets, because that is what a library is", () => {
    // A function library ships no data; zero sheets is the correct answer for
    // that kind and the only kind it is correct for.
    // SABOTAGE: drop the kind check.
    expect(
      pushBlockingReason({ ...ready, kind: "library", sheetsSelected: 0 }),
    ).toBeNull();
  });

  it("still blocks a report with nothing ticked even when a summary is present", () => {
    // Ordering guard: the summary check must not shadow this one.
    const reason = pushBlockingReason({
      ...ready,
      sheetsSelected: 0,
      changeSummary: "Something real",
    });
    expect(reason).toMatch(/sheet/i);
  });
});

describe("a name that is already taken is knowable before the click", () => {
  // `publish()` refuses it with ApplicationAlreadyExists, but only after the
  // button — a refusal for something the dialog could have known the moment the
  // workspace was chosen. Knowing it earlier is what lets the dialog offer the
  // right door (open that application for editing) instead of a dead end.

  it("blocks a create whose name already exists, and names both remedies", () => {
    // SABOTAGE: delete the nameAlreadyTaken check.
    const reason = pushBlockingReason({
      ...ready,
      mode: "create",
      packageName: "sales-report",
      nameAlreadyTaken: true,
    });
    expect(reason).toBeTruthy();
    expect(reason).toContain("sales-report");
    // Both ways out: rename, or check the existing one out.
    expect(reason).toMatch(/another name/i);
    expect(reason).toMatch(/editing/i);
  });

  it("does not block when the name is free", () => {
    expect(
      pushBlockingReason({ ...ready, mode: "create", nameAlreadyTaken: false }),
    ).toBeNull();
  });

  it("is checked before the version, so the user fixes the real problem first", () => {
    // Ordering guard: a taken name with an empty version must complain about the
    // NAME — the version is a field they can fill in, the name is a dead end.
    const reason = pushBlockingReason({
      ...ready,
      mode: "create",
      version: "",
      nameAlreadyTaken: true,
    });
    expect(reason).toMatch(/already exists/i);
  });
});
