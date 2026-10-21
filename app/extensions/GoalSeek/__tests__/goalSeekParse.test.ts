//! FILENAME: app/extensions/GoalSeek/__tests__/goalSeekParse.test.ts
// PURPOSE: Goal Seek's "To value" is read in the APP locale (P2 S9). Under
//          sv-SE "1,5" is 1.5 -- parseFloat read it as 1 and Goal Seek solved
//          for the wrong target without a word -- and the foreign "1.5" is
//          refused rather than misread.

import { describe, it, expect, afterEach } from "vitest";
import { useAppLocale, useInvariantLocale } from "../../Charts/lib/__tests__/appLocaleTestKit";
import { formatGoalSeekValue, parseGoalSeekTarget } from "../lib/goalSeekParse";

afterEach(async () => {
  await useInvariantLocale();
});

describe("Goal Seek target in the app locale", () => {
  it('sv-SE: "1,5" is 1.5 (it was 1)', async () => {
    await useAppLocale("sv-SE");
    expect(parseGoalSeekTarget("1,5")).toBe(1.5);
    expect(parseGoalSeekTarget("-1 234,5")).toBe(-1234.5);
  });

  it('sv-SE: the foreign "1.5" and words are refused (no number, no silent misread)', async () => {
    await useAppLocale("sv-SE");
    expect(parseGoalSeekTarget("1.5")).toBeNull();
    expect(parseGoalSeekTarget("abc")).toBeNull();
    expect(parseGoalSeekTarget("")).toBeNull();
    expect(parseGoalSeekTarget("12abc")).toBeNull();
  });

  it("en-US keeps reading the dot", async () => {
    await useAppLocale("en-US");
    expect(parseGoalSeekTarget("1.5")).toBe(1.5);
    expect(parseGoalSeekTarget("1,5")).toBeNull();
  });

  it("the result is shown in the app locale", async () => {
    await useAppLocale("de-DE");
    expect(formatGoalSeekValue(2.5)).toBe("2,5");
    expect(formatGoalSeekValue(1 / 3)).toBe("0,3333333333");
    expect(formatGoalSeekValue(Number.NaN)).toBe("NaN");
  });
});
