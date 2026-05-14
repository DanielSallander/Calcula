//! FILENAME: app/extensions/Hyperlinks/__tests__/hyperlinkLogic.test.ts
// PURPOSE: Tests for hyperlink validation, URL parsing, cell reference parsing,
//          and email validation logic used in the Hyperlinks extension.
// CONTEXT: The logic is inline in InsertHyperlinkDialog.tsx and index.ts.
//          These tests verify the regex patterns and transformations used.

import { describe, it, expect } from "vitest";

// ============================================================================
// URL Validation & Protocol Auto-Prepend
// ============================================================================

/**
 * Replicates the URL normalization logic from InsertHyperlinkDialog handleOk.
 * If no protocol is specified, prepends "https://".
 */
function normalizeUrl(input: string): string {
  let addr = input.trim();
  if (!/^https?:\/\//i.test(addr) && !/^[a-z][a-z0-9+.-]*:/i.test(addr)) {
    addr = "https://" + addr;
  }
  return addr;
}

describe("URL normalization", () => {
  it("prepends https:// to bare domain", () => {
    expect(normalizeUrl("example.com")).toBe("https://example.com");
  });

  it("prepends https:// to www domain", () => {
    expect(normalizeUrl("www.example.com")).toBe("https://www.example.com");
  });

  it("preserves existing https://", () => {
    expect(normalizeUrl("https://example.com")).toBe("https://example.com");
  });

  it("preserves existing http://", () => {
    expect(normalizeUrl("http://example.com")).toBe("http://example.com");
  });

  it("preserves existing HTTP:// (case insensitive)", () => {
    expect(normalizeUrl("HTTP://example.com")).toBe("HTTP://example.com");
  });

  it("preserves ftp:// protocol", () => {
    expect(normalizeUrl("ftp://files.example.com")).toBe("ftp://files.example.com");
  });

  it("preserves custom protocol schemes", () => {
    expect(normalizeUrl("myapp://deep-link")).toBe("myapp://deep-link");
  });

  it("trims whitespace", () => {
    expect(normalizeUrl("  example.com  ")).toBe("https://example.com");
  });

  it("handles URL with path", () => {
    expect(normalizeUrl("example.com/page/sub")).toBe("https://example.com/page/sub");
  });

  it("handles URL with query params", () => {
    expect(normalizeUrl("example.com?q=test")).toBe("https://example.com?q=test");
  });
});

// ============================================================================
// Email Validation
// ============================================================================

/** Replicates the email validation regex from InsertHyperlinkDialog */
function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

describe("email validation", () => {
  it("accepts standard email", () => {
    expect(isValidEmail("user@example.com")).toBe(true);
  });

  it("accepts email with subdomain", () => {
    expect(isValidEmail("user@mail.example.com")).toBe(true);
  });

  it("accepts email with plus addressing", () => {
    expect(isValidEmail("user+tag@example.com")).toBe(true);
  });

  it("accepts email with dots in local part", () => {
    expect(isValidEmail("first.last@example.com")).toBe(true);
  });

  it("rejects email without @", () => {
    expect(isValidEmail("userexample.com")).toBe(false);
  });

  it("rejects email without domain", () => {
    expect(isValidEmail("user@")).toBe(false);
  });

  it("rejects email without TLD", () => {
    expect(isValidEmail("user@example")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidEmail("")).toBe(false);
  });

  it("rejects email with spaces", () => {
    expect(isValidEmail("user @example.com")).toBe(false);
  });

  it("trims whitespace before validation", () => {
    expect(isValidEmail("  user@example.com  ")).toBe(true);
  });
});

// ============================================================================
// mailto: Target Construction
// ============================================================================

/**
 * Replicates the mailto target construction from InsertHyperlinkDialog.
 */
function buildMailtoTarget(email: string, subject?: string): string {
  const subjectPart = subject?.trim()
    ? `?subject=${encodeURIComponent(subject.trim())}`
    : "";
  return `mailto:${email.trim()}${subjectPart}`;
}

describe("mailto target construction", () => {
  it("builds simple mailto without subject", () => {
    expect(buildMailtoTarget("user@example.com")).toBe("mailto:user@example.com");
  });

  it("builds mailto with subject", () => {
    expect(buildMailtoTarget("user@example.com", "Hello")).toBe(
      "mailto:user@example.com?subject=Hello",
    );
  });

  it("encodes special characters in subject", () => {
    expect(buildMailtoTarget("u@e.com", "Hello World & More")).toBe(
      "mailto:u@e.com?subject=Hello%20World%20%26%20More",
    );
  });

  it("ignores empty subject", () => {
    expect(buildMailtoTarget("u@e.com", "")).toBe("mailto:u@e.com");
  });

  it("ignores whitespace-only subject", () => {
    expect(buildMailtoTarget("u@e.com", "   ")).toBe("mailto:u@e.com");
  });
});

// ============================================================================
// mailto: Parsing (from populateFromHyperlink)
// ============================================================================

/**
 * Replicates the mailto parsing logic from InsertHyperlinkDialog populateFromHyperlink.
 */
function parseMailto(target: string): { email: string; subject: string } {
  const mailtoMatch = target.match(/^mailto:([^?]+)(?:\?subject=(.*))?$/i);
  if (mailtoMatch) {
    return {
      email: mailtoMatch[1],
      subject: decodeURIComponent(mailtoMatch[2] ?? ""),
    };
  }
  return { email: target, subject: "" };
}

describe("mailto parsing", () => {
  it("parses simple mailto", () => {
    const result = parseMailto("mailto:user@example.com");
    expect(result.email).toBe("user@example.com");
    expect(result.subject).toBe("");
  });

  it("parses mailto with subject", () => {
    const result = parseMailto("mailto:user@example.com?subject=Hello");
    expect(result.email).toBe("user@example.com");
    expect(result.subject).toBe("Hello");
  });

  it("decodes encoded subject", () => {
    const result = parseMailto("mailto:u@e.com?subject=Hello%20World");
    expect(result.subject).toBe("Hello World");
  });

  it("falls back to raw target for non-mailto strings", () => {
    const result = parseMailto("user@example.com");
    expect(result.email).toBe("user@example.com");
    expect(result.subject).toBe("");
  });

  it("handles mailto with empty subject parameter", () => {
    const result = parseMailto("mailto:user@example.com?subject=");
    expect(result.email).toBe("user@example.com");
    expect(result.subject).toBe("");
  });
});

// ============================================================================
// Cell Reference Validation
// ============================================================================

/**
 * Replicates the cell reference validation from InsertHyperlinkDialog.
 */
function isValidCellRef(ref: string): boolean {
  const cleaned = ref.trim().replace(/\$/g, "");
  return /^[A-Za-z]+\d+$/.test(cleaned);
}

describe("cell reference validation", () => {
  it("accepts A1", () => {
    expect(isValidCellRef("A1")).toBe(true);
  });

  it("accepts B5", () => {
    expect(isValidCellRef("B5")).toBe(true);
  });

  it("accepts AA100", () => {
    expect(isValidCellRef("AA100")).toBe(true);
  });

  it("accepts lowercase a1", () => {
    expect(isValidCellRef("a1")).toBe(true);
  });

  it("accepts $A$1 (absolute reference)", () => {
    expect(isValidCellRef("$A$1")).toBe(true);
  });

  it("accepts $A1 (mixed reference)", () => {
    expect(isValidCellRef("$A1")).toBe(true);
  });

  it("accepts A$1 (mixed reference)", () => {
    expect(isValidCellRef("A$1")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isValidCellRef("")).toBe(false);
  });

  it("rejects pure numbers", () => {
    expect(isValidCellRef("123")).toBe(false);
  });

  it("rejects pure letters", () => {
    expect(isValidCellRef("ABC")).toBe(false);
  });

  it("rejects range references", () => {
    expect(isValidCellRef("A1:B5")).toBe(false);
  });
});

// ============================================================================
// Cell Reference to Column/Row Parsing
// ============================================================================

/**
 * Replicates the cell reference parsing from the navigateToInternalRef function.
 */
function parseCellRef(ref: string): { row: number; col: number } | null {
  const match = ref.match(/^([A-Z]+)(\d+)$/i);
  if (!match) return null;
  const colStr = match[1].toUpperCase();
  const rowNum = parseInt(match[2], 10) - 1; // 0-based
  let colNum = 0;
  for (let i = 0; i < colStr.length; i++) {
    colNum = colNum * 26 + (colStr.charCodeAt(i) - 64);
  }
  colNum -= 1; // 0-based
  return { row: rowNum, col: colNum };
}

describe("cell reference parsing", () => {
  it("parses A1 to row=0, col=0", () => {
    expect(parseCellRef("A1")).toEqual({ row: 0, col: 0 });
  });

  it("parses B1 to row=0, col=1", () => {
    expect(parseCellRef("B1")).toEqual({ row: 0, col: 1 });
  });

  it("parses Z1 to row=0, col=25", () => {
    expect(parseCellRef("Z1")).toEqual({ row: 0, col: 25 });
  });

  it("parses AA1 to row=0, col=26", () => {
    expect(parseCellRef("AA1")).toEqual({ row: 0, col: 26 });
  });

  it("parses AB1 to row=0, col=27", () => {
    expect(parseCellRef("AB1")).toEqual({ row: 0, col: 27 });
  });

  it("parses A10 to row=9, col=0", () => {
    expect(parseCellRef("A10")).toEqual({ row: 9, col: 0 });
  });

  it("parses lowercase a1", () => {
    expect(parseCellRef("a1")).toEqual({ row: 0, col: 0 });
  });

  it("returns null for invalid reference", () => {
    expect(parseCellRef("123")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseCellRef("")).toBeNull();
  });

  it("parses AZ1 correctly", () => {
    // AZ = 26*1 + 26 = 52, 0-based = 51
    expect(parseCellRef("AZ1")).toEqual({ row: 0, col: 51 });
  });
});

// ============================================================================
// cellKey helper
// ============================================================================

/** Replicates the cellKey helper from Hyperlinks/index.ts */
function cellKey(row: number, col: number): string {
  return `${row},${col}`;
}

describe("cellKey", () => {
  it("formats row,col correctly", () => {
    expect(cellKey(0, 0)).toBe("0,0");
    expect(cellKey(5, 10)).toBe("5,10");
    expect(cellKey(1000, 255)).toBe("1000,255");
  });
});
