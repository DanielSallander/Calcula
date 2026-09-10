//! FILENAME: app/extensions/_shared/dsl/pivotLayout/designQueryVocabulary.test.ts
// PURPOSE: The DSL vocabularies `@api/designQueryAssist` teaches a model are
//          the DSL's own, word for word.
// CONTEXT: `@api` may not import this folder, so the assistant carries COPIES
//          of the aggregation names, layout directives and show-values-as
//          labels. This test is what stops a directive added to `tokens.ts`
//          from silently never being offered to a model, and a name the
//          prompt teaches from silently failing to parse.

import { describe, it, expect } from "vitest";
import {
  DSL_AGGREGATIONS,
  DSL_CLAUSE_KEYWORDS,
  DSL_LAYOUT_DIRECTIVES,
  DSL_SHOW_VALUES_AS,
  DSL_TAUGHT_AGGREGATIONS,
} from "@api/designQueryAssist";
import { AGGREGATION_NAMES, KEYWORDS, LAYOUT_DIRECTIVES, SHOW_VALUES_AS_NAMES } from "./tokens";

describe("the assistant's vocabularies mirror tokens.ts", () => {
  it("aggregations", () => {
    expect([...DSL_AGGREGATIONS].sort()).toEqual([...AGGREGATION_NAMES].sort());
    for (const a of DSL_TAUGHT_AGGREGATIONS) expect(AGGREGATION_NAMES.has(a), a).toBe(true);
  });

  it("layout directives", () => {
    expect([...DSL_LAYOUT_DIRECTIVES].sort()).toEqual([...LAYOUT_DIRECTIVES].sort());
  });

  it("show-values-as labels", () => {
    expect([...DSL_SHOW_VALUES_AS].sort()).toEqual([...SHOW_VALUES_AS_NAMES.keys()].sort());
  });

  it("clause keywords are keywords the lexer knows", () => {
    for (const k of DSL_CLAUSE_KEYWORDS) expect(KEYWORDS[k], k).toBeDefined();
  });
});
