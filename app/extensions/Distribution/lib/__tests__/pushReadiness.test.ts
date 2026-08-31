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
