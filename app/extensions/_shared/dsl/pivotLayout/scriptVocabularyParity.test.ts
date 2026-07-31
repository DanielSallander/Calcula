//! FILENAME: app/extensions/_shared/dsl/pivotLayout/scriptVocabularyParity.test.ts
// PURPOSE: Pin the SCRIPT-side pivot vocabulary (@api scriptHost/
//          pivotLayoutVocabulary, used by pivot.addField / setAggregation /
//          setLayout) against THIS DSL's own constant sets.
// CONTEXT: A script that says `pivot.addField("Region", "rows")` and a user who
//          types `ROWS Region` must be saying the same thing. The API facade may
//          NOT import an extension (API NEUTRALITY, eslint.boundaries.js), so
//          the api-side module restates the vocabulary — and this test, which
//          lives on the extension side where importing both is legal, is what
//          makes the restatement safe. If someone adds an aggregation or a
//          LAYOUT directive to the DSL and forgets the script surface, this
//          fails with the exact missing word.

import { describe, it, expect } from "vitest";
import {
  PIVOT_AGGREGATIONS,
  PIVOT_LAYOUT_DIRECTIVES,
  aggregationToFunction,
  layoutDirectivesToConfig,
} from "@api";
import { AGGREGATION_NAMES, LAYOUT_DIRECTIVES } from "./tokens";

describe("script pivot vocabulary matches the Pivot Layout DSL", () => {
  it("accepts exactly the DSL's aggregation names", () => {
    expect([...PIVOT_AGGREGATIONS].sort()).toEqual([...AGGREGATION_NAMES].sort());
  });

  it("maps every DSL aggregation name to a backend aggregation function", () => {
    for (const name of AGGREGATION_NAMES) {
      expect(aggregationToFunction(name), `DSL aggregation "${name}" is unmapped for scripts`).not.toBeNull();
    }
  });

  it("accepts exactly the DSL's LAYOUT directives", () => {
    expect([...PIVOT_LAYOUT_DIRECTIVES].sort()).toEqual([...LAYOUT_DIRECTIVES].sort());
  });

  it("maps every DSL LAYOUT directive to a layout property", () => {
    for (const directive of LAYOUT_DIRECTIVES) {
      const { layout, unknown } = layoutDirectivesToConfig([directive]);
      expect(unknown, `DSL layout directive "${directive}" is unmapped for scripts`).toEqual([]);
      expect(Object.keys(layout).length).toBeGreaterThan(0);
    }
  });
});
