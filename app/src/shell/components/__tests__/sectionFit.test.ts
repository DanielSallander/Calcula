// Tests for the pure fit-decision helpers behind the ribbon's launcher
// demotion: height thresholding and width-overflow collapse ordering.

import { describe, it, expect } from "vitest";
import {
  shouldDemoteForHeight,
  computeWidthDemotions,
  type WidthDemotionInput,
} from "../useSectionFit";
import { DEMOTE_HEIGHT, LAUNCHER_BAND_WIDTH } from "../../../api/layout";

function s(
  id: string,
  width: number,
  collapsePriority: number,
  alreadyLauncher = false,
): WidthDemotionInput {
  return { id, width, collapsePriority, alreadyLauncher };
}

describe("shouldDemoteForHeight", () => {
  it("keeps content at or under the threshold inline", () => {
    expect(shouldDemoteForHeight(0)).toBe(false);
    expect(shouldDemoteForHeight(80)).toBe(false);
    expect(shouldDemoteForHeight(DEMOTE_HEIGHT)).toBe(false);
  });

  it("demotes content above the threshold", () => {
    expect(shouldDemoteForHeight(DEMOTE_HEIGHT + 1)).toBe(true);
    expect(shouldDemoteForHeight(500)).toBe(true);
  });
});

describe("computeWidthDemotions", () => {
  it("demotes nothing when everything fits", () => {
    const result = computeWidthDemotions([s("a", 200, 1), s("b", 200, 2)], 500);
    expect(result.size).toBe(0);
  });

  it("demotes nothing for an unmeasured (zero-width) container", () => {
    const result = computeWidthDemotions([s("a", 900, 1)], 0);
    expect(result.size).toBe(0);
  });

  it("demotes the lowest collapsePriority first", () => {
    // a(300) + b(300) = 600 into 400: demoting b (priority 1) frees
    // 300 - LAUNCHER_BAND_WIDTH, enough to fit — a stays inline.
    const result = computeWidthDemotions([s("a", 300, 2), s("b", 300, 1)], 400);
    expect(result.has("b")).toBe(true);
    expect(result.has("a")).toBe(false);
  });

  it("demotes progressively until the strip fits", () => {
    const result = computeWidthDemotions(
      [s("a", 300, 3), s("b", 300, 1), s("c", 300, 2)],
      300 + LAUNCHER_BAND_WIDTH * 2,
    );
    expect(result.has("b")).toBe(true);
    expect(result.has("c")).toBe(true);
    expect(result.has("a")).toBe(false);
  });

  it("skips sections that are already launchers", () => {
    // b is already a launcher (counts LAUNCHER_BAND_WIDTH, cannot shrink more);
    // a must be demoted instead.
    const result = computeWidthDemotions(
      [s("a", 300, 2), s("b", 300, 1, true)],
      LAUNCHER_BAND_WIDTH * 2,
    );
    expect(result.has("a")).toBe(true);
    expect(result.has("b")).toBe(false);
  });

  it("stops once all candidates are demoted even if still overflowing", () => {
    const result = computeWidthDemotions([s("a", 300, 1), s("b", 300, 2)], 10);
    expect(result.size).toBe(2);
  });
});
