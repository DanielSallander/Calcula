//! FILENAME: app/extensions/FileExplorer/__tests__/TemplateResolver.deep.test.ts
// PURPOSE: Deep tests for TemplateResolver: edge cases, error handling, complex patterns.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@api/backend", () => ({
  evaluateExpressions: vi.fn(async () => []),
}));

import { hasTemplates, resolveTemplates } from "../TemplateResolver";
import { evaluateExpressions } from "@api/backend";

const mockEval = evaluateExpressions as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockEval.mockReset();
});

// ============================================================================
// Nested templates {{ outer {{ inner }} }}
// ============================================================================

describe("nested-like template patterns", () => {
  it("regex matches first closing }} greedily (non-greedy inner)", async () => {
    // {{ outer {{ inner }} should match "outer {{ inner" as expression
    mockEval.mockResolvedValueOnce(["resolved"]);
    const result = await resolveTemplates("{{ outer {{ inner }}");
    expect(mockEval).toHaveBeenCalledWith(["outer {{ inner"]);
    expect(result).toBe("resolved");
  });

  it("handles {{ a }} {{ b }} as two separate templates", async () => {
    mockEval.mockResolvedValueOnce(["X", "Y"]);
    const result = await resolveTemplates("{{ a }} {{ b }}");
    expect(result).toBe("X Y");
    expect(mockEval).toHaveBeenCalledWith(["a", "b"]);
  });

  it("handles }}} (triple brace) - matches first }}", async () => {
    mockEval.mockResolvedValueOnce(["val"]);
    const result = await resolveTemplates("{{ expr }}}");
    expect(result).toBe("val}");
  });
});

// ============================================================================
// Templates with whitespace variations
// ============================================================================

describe("whitespace variations", () => {
  it("handles tabs inside braces", async () => {
    mockEval.mockResolvedValueOnce(["10"]);
    await resolveTemplates("{{\tA1\t}}");
    expect(mockEval).toHaveBeenCalledWith(["A1"]);
  });

  it("handles newline inside braces", async () => {
    // .+? does not match newlines by default, so this should NOT match
    const result = hasTemplates("{{\nA1\n}}");
    expect(result).toBe(false);
  });

  it("handles lots of spaces", async () => {
    mockEval.mockResolvedValueOnce(["42"]);
    await resolveTemplates("{{         SUM(A1:A10)         }}");
    expect(mockEval).toHaveBeenCalledWith(["SUM(A1:A10)"]);
  });

  it("minimal whitespace {{ x }}", async () => {
    mockEval.mockResolvedValueOnce(["1"]);
    const result = await resolveTemplates("{{x}}");
    expect(result).toBe("1");
    expect(mockEval).toHaveBeenCalledWith(["x"]);
  });
});

// ============================================================================
// Multiple templates in single string
// ============================================================================

describe("multiple templates in single string", () => {
  it("resolves 5 templates in one string", async () => {
    mockEval.mockResolvedValueOnce(["a", "b", "c", "d", "e"]);
    const input = "{{ A1 }}-{{ B1 }}-{{ C1 }}-{{ D1 }}-{{ E1 }}";
    const result = await resolveTemplates(input);
    expect(result).toBe("a-b-c-d-e");
  });

  it("resolves 10 templates", async () => {
    const values = Array.from({ length: 10 }, (_, i) => `v${i}`);
    mockEval.mockResolvedValueOnce(values);
    const input = values.map((_, i) => `{{ X${i} }}`).join(",");
    const result = await resolveTemplates(input);
    expect(result).toBe(values.join(","));
  });

  it("adjacent templates with no separator", async () => {
    mockEval.mockResolvedValueOnce(["Hello", "World"]);
    const result = await resolveTemplates("{{ A1 }}{{ B1 }}");
    expect(result).toBe("HelloWorld");
  });
});

// ============================================================================
// Template resolution with errors (resolver throws)
// ============================================================================

describe("resolver error handling", () => {
  it("replaces all templates with #ERROR! when backend throws", async () => {
    mockEval.mockRejectedValueOnce(new Error("connection refused"));
    const result = await resolveTemplates("{{ A1 }} and {{ B1 }} and {{ C1 }}");
    expect(result).toBe("#ERROR! and #ERROR! and #ERROR!");
  });

  it("replaces with #ERROR! when backend throws non-Error", async () => {
    mockEval.mockRejectedValueOnce("string error");
    const result = await resolveTemplates("{{ A1 }}");
    expect(result).toBe("#ERROR!");
  });

  it("handles empty results array from backend", async () => {
    mockEval.mockResolvedValueOnce([]);
    const result = await resolveTemplates("{{ A1 }}");
    // results[0] is undefined, so replacement is "undefined"
    expect(result).toBe("undefined");
  });

  it("handles null in results", async () => {
    mockEval.mockResolvedValueOnce([null]);
    const result = await resolveTemplates("{{ A1 }}");
    expect(result).toBe("null");
  });
});

// ============================================================================
// Recursive template resolution
// ============================================================================

describe("recursive template resolution", () => {
  it("does not recursively resolve templates in results", async () => {
    // If A1 evaluates to "{{ B1 }}", the result should be literal "{{ B1 }}"
    mockEval.mockResolvedValueOnce(["{{ B1 }}"]);
    const result = await resolveTemplates("{{ A1 }}");
    expect(result).toBe("{{ B1 }}");
    expect(mockEval).toHaveBeenCalledTimes(1);
  });

  it("manual two-pass resolution can be done by caller", async () => {
    mockEval.mockResolvedValueOnce(["{{ B1 }}"]);
    const pass1 = await resolveTemplates("{{ A1 }}");
    expect(pass1).toBe("{{ B1 }}");

    mockEval.mockResolvedValueOnce(["final"]);
    const pass2 = await resolveTemplates(pass1);
    expect(pass2).toBe("final");
  });
});

// ============================================================================
// Very long template strings
// ============================================================================

describe("very long template strings", () => {
  it("handles a 10,000-char string with one template", async () => {
    const padding = "x".repeat(10000);
    mockEval.mockResolvedValueOnce(["42"]);
    const result = await resolveTemplates(`${padding}{{ A1 }}${padding}`);
    expect(result).toBe(`${padding}42${padding}`);
    expect(result.length).toBe(20002);
  });

  it("handles very long expression inside template", async () => {
    const longExpr = "SUM(" + Array.from({ length: 100 }, (_, i) => `A${i + 1}`).join(",") + ")";
    mockEval.mockResolvedValueOnce(["999"]);
    const result = await resolveTemplates(`{{ ${longExpr} }}`);
    expect(result).toBe("999");
    expect(mockEval).toHaveBeenCalledWith([longExpr]);
  });

  it("handles 50 templates in a long string", async () => {
    const count = 50;
    const values = Array.from({ length: count }, (_, i) => `r${i}`);
    mockEval.mockResolvedValueOnce(values);
    const parts = Array.from({ length: count }, (_, i) => `prefix{{ cell${i} }}suffix`);
    const input = parts.join("|");
    const result = await resolveTemplates(input);
    const expected = values.map((v) => `prefix${v}suffix`).join("|");
    expect(result).toBe(expected);
  });
});

// ============================================================================
// hasTemplates edge cases
// ============================================================================

describe("hasTemplates edge cases", () => {
  it("returns true for template at very end", () => {
    expect(hasTemplates("end{{ A1 }}")).toBe(true);
  });

  it("returns true for template at very start", () => {
    expect(hasTemplates("{{ A1 }}start")).toBe(true);
  });

  it("returns false for {{ only (no closing)", () => {
    expect(hasTemplates("{{ A1")).toBe(false);
  });

  it("returns false for }} only (no opening)", () => {
    expect(hasTemplates("A1 }}")).toBe(false);
  });

  it("returns false for inverted braces }} {{", () => {
    expect(hasTemplates("}} content {{")).toBe(false);
  });
});
