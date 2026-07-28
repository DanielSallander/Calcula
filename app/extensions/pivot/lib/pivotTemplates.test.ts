//! FILENAME: app/extensions/Pivot/lib/pivotTemplates.test.ts
// PURPOSE: PIVOT_TEMPLATES starter layouts stay valid against the shared DSL.
// CONTEXT: These tests used to live in _shared/dsl/pivotLayout/dsl-workflows.test.ts,
//          which imported PIVOT_TEMPLATES from this extension — a boundary
//          violation (_shared must never depend on a specific extension, only
//          the other way round). The templates are Pivot-owned data, so the
//          tests that assert on them belong here; the DSL-only workflow tests
//          stayed behind in _shared.

import { describe, it, expect } from "vitest";
import { lex, parse } from "../../_shared/dsl/pivotLayout";
import { PIVOT_TEMPLATES } from "./namedConfigs";

describe("PIVOT_TEMPLATES", () => {
  it("has the expected starter templates", () => {
    expect(PIVOT_TEMPLATES.length).toBeGreaterThanOrEqual(4);
    const names = PIVOT_TEMPLATES.map((t) => t.name);
    expect(names).toContain("Basic Summary");
    expect(names).toContain("Cross-Tab");
    expect(names).toContain("Year-over-Year");
    expect(names).toContain("Detailed Report");
  });

  it("Basic Summary template lexes and parses without errors", () => {
    const template = PIVOT_TEMPLATES.find((t) => t.name === "Basic Summary")!;
    const { tokens, errors: lexErrors } = lex(template.dslText);
    expect(lexErrors).toHaveLength(0);
    const { errors: parseErrors } = parse(tokens);
    expect(parseErrors).toHaveLength(0);
  });

  it("Cross-Tab template lexes and parses without errors", () => {
    const template = PIVOT_TEMPLATES.find((t) => t.name === "Cross-Tab")!;
    const { tokens, errors: lexErrors } = lex(template.dslText);
    expect(lexErrors).toHaveLength(0);
    const { errors: parseErrors } = parse(tokens);
    expect(parseErrors).toHaveLength(0);
  });

  it("all templates produce valid token streams", () => {
    for (const template of PIVOT_TEMPLATES) {
      const { errors } = lex(template.dslText);
      expect(errors).toHaveLength(0);
    }
  });
});
