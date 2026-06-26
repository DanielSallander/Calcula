//! FILENAME: app/extensions/Charts/lib/__tests__/chartSnippets.test.ts
// PURPOSE: Every insert-snippet (B6) must expand to a fragment that, with its
//          tab-stops filled to their defaults, is (a) valid JSON and (b) valid
//          against the ChartSpec schema when dropped into its intended host. A
//          broken snippet would teach the user an invalid spec — fail CI instead.

import { describe, it, expect } from "vitest";
import { CHART_SNIPPETS } from "../chartSnippets";
import { chartSpecJsonSchema } from "../chartSpecSchema";
import { schemaViolations } from "./schemaValidate";
import type { ChartSpec } from "../../types";

// Resolve Monaco snippet syntax to the value a user would get pressing Tab
// through every stop accepting defaults: ${n|a,b|} -> a, ${n:def} -> def,
// ${n}/$0 -> "", and the Monaco literal-$ escape \$ -> $.
function fillSnippet(body: string): string {
  return body
    .replace(/\$\{\d+\|([^|}]*)\|\}/g, (_m, opts: string) => opts.split(",")[0])
    .replace(/\$\{\d+:([^}]*)\}/g, (_m, def: string) => def)
    .replace(/\$\{\d+\}/g, "")
    .replace(/\$0/g, "")
    .replace(/\\\$/g, "$");
}

// Every filled form a user could produce by picking ANY single choice option
// (with all other stops at default). Linear in total options — catches an
// invalid enum value hidden behind a non-default choice (e.g. dataLabels content).
function choiceVariants(body: string): string[] {
  const variants = new Set<string>([fillSnippet(body)]);
  const choiceRe = /\$\{(\d+)\|([^|}]*)\|\}/g;
  let m: RegExpExecArray | null;
  while ((m = choiceRe.exec(body)) !== null) {
    const id = m[1];
    for (const opt of m[2].split(",")) {
      const pinned = body.replace(new RegExp(`\\$\\{${id}\\|[^|}]*\\|\\}`, "g"), opt);
      variants.add(fillSnippet(pinned));
    }
  }
  return [...variants];
}

const baseSpec: ChartSpec = {
  mark: "bar",
  data: "Sheet1!A1:D13",
  hasHeaders: true,
  seriesOrientation: "columns",
  categoryIndex: 0,
  series: [{ name: "Revenue", sourceIndex: 1, color: null }],
  title: "T",
  xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
  yAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
  legend: { visible: false, position: "bottom" },
  palette: "default",
};

/** Parse a snippet's filled body as the single property it represents. */
function parseProperty(body: string): Record<string, unknown> {
  return JSON.parse("{" + fillSnippet(body) + "}");
}

describe("chart snippets (B6)", () => {
  it("has a useful catalog with unique labels", () => {
    expect(CHART_SNIPPETS.length).toBeGreaterThanOrEqual(15);
    const labels = CHART_SNIPPETS.map((s) => s.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("every snippet has a label, detail, and documentation", () => {
    for (const s of CHART_SNIPPETS) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.detail.length).toBeGreaterThan(0);
      expect(s.documentation.length).toBeGreaterThan(0);
    }
  });

  it("every snippet body fills to valid JSON (one top-level property)", () => {
    for (const s of CHART_SNIPPETS) {
      let parsed: Record<string, unknown> | undefined;
      expect(() => { parsed = parseProperty(s.body); }, `${s.label}: ${fillSnippet(s.body)}`).not.toThrow();
      // Each snippet is a single "key": value property.
      expect(Object.keys(parsed!), s.label).toHaveLength(1);
    }
  });

  it("every snippet validates against the ChartSpec schema — for EVERY choice option", () => {
    for (const s of CHART_SNIPPETS) {
      for (const variant of choiceVariants(s.body)) {
        let prop: Record<string, unknown>;
        try {
          prop = JSON.parse("{" + variant + "}");
        } catch (e) {
          throw new Error(`${s.label}: variant did not parse: {${variant}} (${String(e)})`);
        }
        const host = { ...baseSpec, ...prop } as ChartSpec;
        const violations = schemaViolations(host, chartSpecJsonSchema);
        expect(violations, `${s.label} [variant ${variant}]: ${violations.join("; ")}`).toEqual([]);
      }
    }
  });

  it("escapes the literal $ in the $category built-in (aggregate groupBy)", () => {
    const agg = CHART_SNIPPETS.find((s) => s.label === "transform: aggregate")!;
    // The raw body must escape it (\\$ in source -> \$ literal for Monaco)...
    expect(agg.body).toContain("\\$category");
    // ...and the filled form must be the real built-in, not a dropped-$ "category".
    const parsed = parseProperty(agg.body) as { transform: Array<{ groupBy: string[] }> };
    expect(parsed.transform[0].groupBy).toEqual(["$category"]);
  });

  it("covers the headline feature surface", () => {
    const labels = CHART_SNIPPETS.map((s) => s.label).join(" ");
    for (const needle of ["filter", "calculate", "aggregate", "lookup", "pivot", "trendline", "layer", "param", "encoding", "facet", "repeat", "concat", "override"]) {
      expect(labels, needle).toContain(needle);
    }
  });
});
