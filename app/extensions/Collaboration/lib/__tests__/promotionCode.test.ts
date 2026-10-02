//! FILENAME: app/extensions/Collaboration/lib/__tests__/promotionCode.test.ts
// PURPOSE: The code summary's headline and confirm wording (plan_M8 S5), case
//          by case: a first promotion never says "again", a reserved script id
//          outranks everything, a failure is a failure, and an answer with no
//          code list is never read as "no code changes".

import { describe, it, expect } from "vitest";
import type { PromotionCodeChange } from "@api/collaboration";
import {
  describeCodeForConfirm,
  describeCodeHeadline,
  nameCodeChange,
  promotionCodeConfirm,
  promotionCodeFailed,
  promotionCodeFromImpact,
  PROMOTION_CODE_LOADING,
  type PromotionCodeState,
} from "../promotionCode";

function change(overrides: Partial<PromotionCodeChange> = {}): PromotionCodeChange {
  return {
    kind: "buttonCellAction",
    id: "s!A1:action",
    name: "A1 \"Run\"",
    sheetName: "Dashboard",
    change: "added",
    detail: "",
    consequence: "runsAfterApproval",
    before: null,
    after: "runs macro m",
    beforeTruncated: false,
    afterTruncated: false,
    addedCapabilities: [],
    ...overrides,
  };
}

const ready = (changes: PromotionCodeChange[], asks: boolean): PromotionCodeState => ({
  status: "ready",
  changes,
  asksApprovalAgain: asks,
  error: null,
});

describe("the headline", () => {
  it("never says 'again' on a first promotion", () => {
    // SABOTAGE: drop the firstPromotion branch of the last return.
    expect(describeCodeHeadline(ready([change()], false), "prod", true, "1.0.0")).toBe(
      "Code: 1 item, and nobody in prod is asked to approve anything.",
    );
    expect(describeCodeHeadline(ready([change()], false), "prod", false, "1.1.0")).toBe(
      "Code: 1 change, and nobody in prod is asked to approve anything again.",
    );
    expect(describeCodeHeadline(ready([], false), "prod", true, "1.0.0")).toBe(
      "Code: v1.0.0 carries no code, so nobody is asked to approve anything.",
    );
  });

  it("a reserved script id outranks every other sentence, even unchanged", () => {
    const blocked = change({ kind: "reservedScript", change: "unchanged", consequence: "refusesVersion" });
    expect(describeCodeHeadline(ready([blocked], false), "prod", false, "1.1.0")).toBe(
      "Code: no changes. Subscribers in prod cannot take v1.1.0: it carries a script under an id Calcula reserves.",
    );
  });

  // SABOTAGE: word every refusesVersion row as a reserved id again (the
  // reason clause in promotionCode.ts).
  it("a version refused because a FILE of its code cannot be read says that -- never 'a reserved id'", () => {
    const unreadable = change({
      kind: "macro",
      id: "mod-report",
      name: "Report",
      sheetName: null,
      consequence: "refusesVersion",
      detail: "its file cannot be read (expected value at line 1 column 1), so subscribers cannot take this version",
    });
    const headline = describeCodeHeadline(ready([unreadable], false), "prod", false, "1.1.0");
    expect(headline).toBe('Code: 1 change. Subscribers in prod cannot take v1.1.0: a file of its code cannot be read (macro "Report").');
    const confirm = describeCodeForConfirm(promotionCodeConfirm(ready([unreadable], false)), "prod", "1.1.0", false);
    expect(confirm).toContain('Subscribers in prod cannot take v1.1.0: a file of its code cannot be read (macro "Report").');
    expect(confirm).not.toContain("reserves");
    // Both reasons at once: each one named.
    const reserved = change({ kind: "reservedScript", change: "unchanged", consequence: "refusesVersion" });
    expect(describeCodeHeadline(ready([unreadable, reserved], false), "prod", false, "1.1.0")).toBe(
      "Code: 1 change. Subscribers in prod cannot take v1.1.0: it carries a script under an id Calcula reserves, " +
        'and a file of its code cannot be read (macro "Report").',
    );
  });

  it("says a failure as a failure, and loading as loading", () => {
    expect(describeCodeHeadline(promotionCodeFailed("boom."), "prod", false, "1.1.0")).toBe(
      "Code: the comparison failed: boom.",
    );
    expect(describeCodeHeadline(PROMOTION_CODE_LOADING, "prod", false, "1.1.0")).toBe("Code: comparing…");
  });
});

describe("reading the impact", () => {
  it("an answer with no code list, or a codeError, is a failure -- never 'no changes'", () => {
    // SABOTAGE: drop the Array.isArray guard.
    expect(
      promotionCodeFromImpact({ codeChanges: undefined as unknown as PromotionCodeChange[], asksApprovalAgain: false, codeError: null })
        .status,
    ).toBe("failed");
    expect(promotionCodeFromImpact({ codeChanges: [], asksApprovalAgain: false, codeError: "x" }).status).toBe("failed");
    expect(promotionCodeFromImpact({ codeChanges: [], asksApprovalAgain: false, codeError: null }).status).toBe("ready");
    expect(promotionCodeFailed("").error).toBe("the comparison returned no reason");
  });
});

describe("the confirm", () => {
  it("names a change with its sheet and gained capability", () => {
    expect(
      nameCodeChange(change({ kind: "objectScript", name: "Fetcher", sheetName: null, addedCapabilities: ["net.fetch"] })),
    ).toBe('object script "Fetcher" (new, gains net.fetch)');
    expect(nameCodeChange(change())).toBe('button cell "A1 "Run"" on Dashboard (new)');
  });

  it("says a summary still loading had not finished, never 'no changes'", () => {
    const c = promotionCodeConfirm(PROMOTION_CODE_LOADING);
    expect(describeCodeForConfirm(c, "prod", "1.1.0", false)).toContain("it had not finished when you pressed Promote");
  });

  it("a first promotion with nothing asking says so without 'again'", () => {
    const c = promotionCodeConfirm(ready([change()], false));
    expect(describeCodeForConfirm(c, "prod", "1.0.0", true)).toBe(
      'Code it carries: button cell "A1 "Run"" on Dashboard (new). Nobody in prod is asked to approve anything.',
    );
  });
});
