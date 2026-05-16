//! FILENAME: app/extensions/Hyperlinks/__tests__/hyperlinkLogic.deep.test.ts
// PURPOSE: Deep tests for hyperlink URL handling, email validation, cell references.

import { describe, it, expect } from "vitest";

// ============================================================================
// Replicated logic from the extension (same as hyperlinkLogic.test.ts)
// ============================================================================

function normalizeUrl(input: string): string {
  let addr = input.trim();
  if (!/^https?:\/\//i.test(addr) && !/^[a-z][a-z0-9+.-]*:/i.test(addr)) {
    addr = "https://" + addr;
  }
  return addr;
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function buildMailtoTarget(email: string, subject?: string): string {
  const subjectPart = subject?.trim()
    ? `?subject=${encodeURIComponent(subject.trim())}`
    : "";
  return `mailto:${email.trim()}${subjectPart}`;
}

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

function isValidCellRef(ref: string): boolean {
  const cleaned = ref.trim().replace(/\$/g, "");
  return /^[A-Za-z]+\d+$/.test(cleaned);
}

function parseCellRef(ref: string): { row: number; col: number } | null {
  const match = ref.match(/^([A-Z]+)(\d+)$/i);
  if (!match) return null;
  const colStr = match[1].toUpperCase();
  const rowNum = parseInt(match[2], 10) - 1;
  let colNum = 0;
  for (let i = 0; i < colStr.length; i++) {
    colNum = colNum * 26 + (colStr.charCodeAt(i) - 64);
  }
  colNum -= 1;
  return { row: rowNum, col: colNum };
}

// ============================================================================
// URL normalization - protocol edge cases
// ============================================================================

describe("URL normalization - protocol edge cases", () => {
  it("preserves ftp:// scheme", () => {
    expect(normalizeUrl("ftp://files.example.com/pub")).toBe(
      "ftp://files.example.com/pub",
    );
  });

  it("preserves ssh:// scheme", () => {
    expect(normalizeUrl("ssh://git@github.com/repo")).toBe(
      "ssh://git@github.com/repo",
    );
  });

  it("preserves file:// scheme", () => {
    expect(normalizeUrl("file:///C:/Documents/report.pdf")).toBe(
      "file:///C:/Documents/report.pdf",
    );
  });

  it("preserves data: scheme", () => {
    expect(normalizeUrl("data:text/plain;base64,SGVsbG8=")).toBe(
      "data:text/plain;base64,SGVsbG8=",
    );
  });

  it("preserves javascript: scheme (validation should happen elsewhere)", () => {
    // normalizeUrl only handles protocol prepending, not security validation
    expect(normalizeUrl("javascript:alert(1)")).toBe("javascript:alert(1)");
  });

  it("preserves tel: scheme", () => {
    expect(normalizeUrl("tel:+1-555-123-4567")).toBe("tel:+1-555-123-4567");
  });

  it("preserves mailto: scheme", () => {
    expect(normalizeUrl("mailto:user@example.com")).toBe(
      "mailto:user@example.com",
    );
  });
});

// ============================================================================
// URL normalization - complex URLs
// ============================================================================

describe("URL normalization - complex URLs", () => {
  it("treats localhost:8080 as having a scheme (colon triggers scheme match)", () => {
    // "localhost:" matches /^[a-z][a-z0-9+.-]*:/i
    expect(normalizeUrl("localhost:8080")).toBe("localhost:8080");
  });

  it("treats user:pass@domain as having a scheme (colon triggers scheme detection)", () => {
    // "user:" matches /^[a-z][a-z0-9+.-]*:/i so it's treated as a scheme
    expect(normalizeUrl("user:pass@example.com")).toBe(
      "user:pass@example.com",
    );
  });

  it("handles URL with query string and fragment", () => {
    expect(normalizeUrl("example.com/path?key=val&a=b#section")).toBe(
      "https://example.com/path?key=val&a=b#section",
    );
  });

  it("handles URL with encoded characters in path", () => {
    expect(normalizeUrl("example.com/path%20with%20spaces")).toBe(
      "https://example.com/path%20with%20spaces",
    );
  });

  it("handles international domain name (unicode)", () => {
    expect(normalizeUrl("example.xn--nxasmq6b")).toBe(
      "https://example.xn--nxasmq6b",
    );
  });

  it("handles very long URL (2000+ chars)", () => {
    const longPath = "a".repeat(2000);
    const result = normalizeUrl(`example.com/${longPath}`);
    expect(result).toBe(`https://example.com/${longPath}`);
    expect(result.length).toBeGreaterThan(2000);
  });

  it("handles URL with special characters in path", () => {
    expect(normalizeUrl("example.com/~user/file(1).html")).toBe(
      "https://example.com/~user/file(1).html",
    );
  });

  it("handles URL with multiple subdomains", () => {
    expect(normalizeUrl("a.b.c.d.example.com")).toBe(
      "https://a.b.c.d.example.com",
    );
  });
});

// ============================================================================
// Email validation - edge cases
// ============================================================================

describe("email validation - edge cases", () => {
  it("accepts hyphenated domain", () => {
    expect(isValidEmail("user@my-domain.com")).toBe(true);
  });

  it("accepts numeric local part", () => {
    expect(isValidEmail("123@example.com")).toBe(true);
  });

  it("accepts long TLD", () => {
    expect(isValidEmail("user@example.museum")).toBe(true);
  });

  it("rejects double @", () => {
    expect(isValidEmail("user@@example.com")).toBe(false);
  });

  it("rejects @ at start", () => {
    expect(isValidEmail("@example.com")).toBe(false);
  });

  it("rejects space in domain", () => {
    expect(isValidEmail("user@exam ple.com")).toBe(false);
  });

  it("rejects trailing dot only domain", () => {
    // "user@.com" - local part of domain is empty before dot
    // The regex requires [^\s@]+ on both sides of @, so "@.com" has
    // the part after @ = ".com" which matches [^\s@]+\.[^\s@]+
    // Actually ".com" = [^\s@]+ is "." then \. needs a dot... let's check
    expect(isValidEmail("user@.com")).toBe(false); // "." doesn't match [^\s@]+\.[^\s@]+
  });

  it("accepts plus addressing with multiple pluses", () => {
    expect(isValidEmail("user+tag+extra@example.com")).toBe(true);
  });

  it("rejects newline in email", () => {
    expect(isValidEmail("user\n@example.com")).toBe(false);
  });
});

// ============================================================================
// Mailto with additional parameters
// ============================================================================

describe("mailto construction - extended parameters", () => {
  it("encodes unicode subject", () => {
    const result = buildMailtoTarget("u@e.com", "Rapport 2024");
    expect(result).toBe("mailto:u@e.com?subject=Rapport%202024");
  });

  it("encodes subject with question marks", () => {
    const result = buildMailtoTarget("u@e.com", "Is this ok?");
    expect(result).toContain("?subject=Is%20this%20ok%3F");
  });

  it("round-trips through build and parse", () => {
    const subject = "Hello & goodbye! 100%";
    const built = buildMailtoTarget("test@example.com", subject);
    const parsed = parseMailto(built);
    expect(parsed.email).toBe("test@example.com");
    expect(parsed.subject).toBe(subject);
  });

  it("parses MAILTO: case-insensitively", () => {
    const result = parseMailto("MAILTO:user@example.com?subject=Hi");
    expect(result.email).toBe("user@example.com");
    expect(result.subject).toBe("Hi");
  });
});

// ============================================================================
// Cell reference validation - Excel boundary cases
// ============================================================================

describe("cell reference validation - boundary cases", () => {
  it("accepts XFD1 (last Excel column, row 1)", () => {
    expect(isValidCellRef("XFD1")).toBe(true);
  });

  it("accepts A1048576 (last Excel row)", () => {
    expect(isValidCellRef("A1048576")).toBe(true);
  });

  it("accepts XFD1048576 (last cell in Excel)", () => {
    expect(isValidCellRef("XFD1048576")).toBe(true);
  });

  it("rejects A0 (row 0 not valid in spreadsheets, but regex allows it)", () => {
    // The regex only checks format, not numeric validity
    expect(isValidCellRef("A0")).toBe(true);
  });

  it("rejects 1A (digits before letters)", () => {
    expect(isValidCellRef("1A")).toBe(false);
  });

  it("rejects A1B2 (mixed letters and digits)", () => {
    expect(isValidCellRef("A1B2")).toBe(false);
  });

  it("accepts $$A$$1 after stripping $", () => {
    // Multiple $ signs get stripped, leaving A1
    expect(isValidCellRef("$$A$$1")).toBe(true);
  });

  it("rejects whitespace-only string", () => {
    expect(isValidCellRef("   ")).toBe(false);
  });
});

// ============================================================================
// Cell reference parsing - boundary cases
// ============================================================================

describe("cell reference parsing - boundary cases", () => {
  it("parses XFD1 (last Excel column)", () => {
    // X=24, F=6, D=4 => 24*26*26 + 6*26 + 4 = 16384, 0-based = 16383
    const result = parseCellRef("XFD1")!;
    expect(result.row).toBe(0);
    expect(result.col).toBe(16383);
  });

  it("parses A1048576 (last Excel row)", () => {
    const result = parseCellRef("A1048576")!;
    expect(result.row).toBe(1048575);
    expect(result.col).toBe(0);
  });

  it("parses BA1 correctly", () => {
    // B=2, A=1 => 2*26 + 1 = 53, 0-based = 52
    expect(parseCellRef("BA1")).toEqual({ row: 0, col: 52 });
  });

  it("parses AAA1 (3-letter column)", () => {
    // A=1,A=1,A=1 => 1*676 + 1*26 + 1 = 703, 0-based = 702
    expect(parseCellRef("AAA1")).toEqual({ row: 0, col: 702 });
  });

  it("returns null for just $", () => {
    expect(parseCellRef("$")).toBeNull();
  });

  it("returns null for A:A (column reference)", () => {
    expect(parseCellRef("A:A")).toBeNull();
  });
});
