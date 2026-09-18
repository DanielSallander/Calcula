/**
 * FILENAME: app/src/api/__tests__/pivotNotices.test.ts
 * PURPOSE: A pivot notice must reach the user, and a REFUSAL must not be
 *          dressed as a warning.
 *
 * CONTEXT: three of the callers that most often produce a notice — the
 * Slicer's filter bridge, the Insert Slicer dialog and the Controls pane's
 * filter bridge — reach `updateBiPivotFields` straight from `@api/backend`
 * and used to DISCARD the response entirely. A consumer wired anywhere inside
 * the Pivot extension would have been invisible on exactly those paths.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const showToast = vi.fn();
vi.mock("../notifications", () => ({
  showToast: (...args: unknown[]) => showToast(...args),
}));

import { surfacePivotNotices } from "../pivotNotices";

describe("surfacePivotNotices", () => {
  beforeEach(() => showToast.mockClear());

  it("shows a REFUSAL as an error — the user can act on it", () => {
    surfacePivotNotices({
      notices: [{ kind: "refused", message: 'the role chosen in "View as" denies it' }],
    });
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith(
      'the role chosen in "View as" denies it',
      { type: "error" },
    );
  });

  it("shows a DEGRADATION as a warning, not an error", () => {
    surfacePivotNotices({ notices: [{ kind: "degraded", message: "some columns were left out" }] });
    expect(showToast).toHaveBeenCalledWith("some columns were left out", { type: "warning" });
  });

  it("severity comes from the typed kind, never from the message text", () => {
    // A degradation whose WORDING mentions a role must still be a warning:
    // reading severity out of a string is the anti-pattern this type exists
    // to remove.
    surfacePivotNotices({
      notices: [{ kind: "degraded", message: "refused? no: the role is fine, the model is not" }],
    });
    expect(showToast).toHaveBeenCalledWith(expect.any(String), { type: "warning" });
  });

  it("says every notice, not just the first", () => {
    surfacePivotNotices({
      notices: [
        { kind: "degraded", message: "one" },
        { kind: "refused", message: "two" },
      ],
    });
    expect(showToast).toHaveBeenCalledTimes(2);
  });

  it("is silent on the ordinary path (no notices, empty, absent, null)", () => {
    surfacePivotNotices({ notices: [] });
    surfacePivotNotices({});
    surfacePivotNotices(null);
    surfacePivotNotices(undefined);
    expect(showToast).not.toHaveBeenCalled();
  });
});
