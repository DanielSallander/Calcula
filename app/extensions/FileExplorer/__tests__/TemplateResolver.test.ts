//! FILENAME: app/extensions/FileExplorer/__tests__/TemplateResolver.test.ts
// PURPOSE: Tests for template expression parsing and resolution.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the backend call
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
// hasTemplates Tests
// ============================================================================

describe("hasTemplates", () => {
  it("returns true for content with {{ }}", () => {
    expect(hasTemplates("Hello {{ A1 }}")).toBe(true);
  });

  it("returns true for multiple templates", () => {
    expect(hasTemplates("{{ A1 }} and {{ B2 }}")).toBe(true);
  });

  it("returns false for plain text", () => {
    expect(hasTemplates("Hello World")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(hasTemplates("")).toBe(false);
  });

  it("returns false for single braces", () => {
    expect(hasTemplates("{ not a template }")).toBe(false);
  });

  it("returns false for empty template braces", () => {
    // {{}} has nothing between braces — the regex requires .+?
    expect(hasTemplates("{{}}")).toBe(false);
  });
});

// ============================================================================
// resolveTemplates Tests
// ============================================================================

describe("resolveTemplates", () => {
  it("returns content unchanged when no templates present", async () => {
    const result = await resolveTemplates("plain text");
    expect(result).toBe("plain text");
    expect(mockEval).not.toHaveBeenCalled();
  });

  it("resolves a single template", async () => {
    mockEval.mockResolvedValueOnce(["42"]);
    const result = await resolveTemplates("Value: {{ SUM(A1:A10) }}");
    expect(result).toBe("Value: 42");
    expect(mockEval).toHaveBeenCalledWith(["SUM(A1:A10)"]);
  });

  it("resolves multiple templates", async () => {
    mockEval.mockResolvedValueOnce(["Alice", "100"]);
    const result = await resolveTemplates("Name: {{ A1 }}, Score: {{ B1 }}");
    expect(result).toBe("Name: Alice, Score: 100");
  });

  it("trims whitespace from expressions", async () => {
    mockEval.mockResolvedValueOnce(["5"]);
    await resolveTemplates("{{   A1   }}");
    expect(mockEval).toHaveBeenCalledWith(["A1"]);
  });

  it("replaces all templates with #ERROR! on backend failure", async () => {
    mockEval.mockRejectedValueOnce(new Error("Backend down"));
    const result = await resolveTemplates("{{ A1 }} and {{ B1 }}");
    expect(result).toBe("#ERROR! and #ERROR!");
  });

  it("preserves surrounding text", async () => {
    mockEval.mockResolvedValueOnce(["2026"]);
    const result = await resolveTemplates("Copyright {{ A1 }} Calcula");
    expect(result).toBe("Copyright 2026 Calcula");
  });

  it("handles templates at start and end of content", async () => {
    mockEval.mockResolvedValueOnce(["Start", "End"]);
    const result = await resolveTemplates("{{ X1 }} middle {{ Y1 }}");
    expect(result).toBe("Start middle End");
  });
});

// ============================================================================
// constants Tests
// ============================================================================

describe("FileExplorer constants", () => {
  it("FILE_VIEWER_PANE_ID is defined", async () => {
    const { FILE_VIEWER_PANE_ID } = await import("../constants");
    expect(FILE_VIEWER_PANE_ID).toBe("file-viewer-pane");
  });
});
