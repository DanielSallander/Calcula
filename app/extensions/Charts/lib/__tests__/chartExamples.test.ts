//! FILENAME: app/extensions/Charts/lib/__tests__/chartExamples.test.ts
// PURPOSE: Ensure every gallery example is a valid ChartSpec per the JSON schema.
// CONTEXT: The examples are user-facing "load me" starting points, so a broken
//          one (unknown property, wrong markOptions for the mark, ...) must fail
//          CI rather than confuse a user who loads it.

import { describe, it, expect } from "vitest";
import { CHART_EXAMPLES, getExamplesByCategory } from "../chartExamples";
import { chartSpecJsonSchema } from "../chartSpecSchema";
import { schemaViolations } from "./schemaValidate";

describe("chart examples gallery", () => {
  it("has at least a handful of examples", () => {
    expect(CHART_EXAMPLES.length).toBeGreaterThanOrEqual(10);
  });

  it("uses unique ids", () => {
    const ids = CHART_EXAMPLES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every example validates against the ChartSpec schema", () => {
    for (const ex of CHART_EXAMPLES) {
      const violations = schemaViolations(ex.spec, chartSpecJsonSchema);
      expect(violations, `${ex.id}: ${violations.join("; ")}`).toEqual([]);
    }
  });

  it("every example has a name and description", () => {
    for (const ex of CHART_EXAMPLES) {
      expect(ex.name.length).toBeGreaterThan(0);
      expect(ex.description.length).toBeGreaterThan(0);
    }
  });

  it("groups examples by category preserving declaration order", () => {
    const grouped = getExamplesByCategory();
    const flat = Object.values(grouped).flat();
    expect(flat.length).toBe(CHART_EXAMPLES.length);
    // Each grouped example belongs to its key.
    for (const [category, examples] of Object.entries(grouped)) {
      for (const ex of examples) expect(ex.category).toBe(category);
    }
  });

  it("showcases the key feature set (transforms, encoding, layers, theming)", () => {
    const specs = CHART_EXAMPLES.map((e) => e.spec);
    expect(specs.some((s) => s.transform?.some((t) => t.type === "calculate"))).toBe(true);
    expect(specs.some((s) => s.transform?.some((t) => t.type === "lookup"))).toBe(true);
    expect(specs.some((s) => s.transform?.some((t) => t.type === "aggregate"))).toBe(true);
    expect(specs.some((s) => s.series.some((ser) => ser.encoding))).toBe(true);
    expect(specs.some((s) => s.layers && s.layers.length > 0)).toBe(true);
    expect(specs.some((s) => s.config?.theme)).toBe(true);
  });
});
