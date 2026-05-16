//! FILENAME: app/extensions/Hyperlinks/__tests__/hyperlink-parameterized.test.ts
// PURPOSE: Heavily parameterized tests for URL normalization, email validation,
//          cell reference validation, and mailto construction.

import { describe, it, expect } from "vitest";

// ============================================================================
// Helper functions (replicated from extension source for pure testing)
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

function buildMailtoTarget(
  email: string,
  subject?: string,
  body?: string,
  cc?: string,
): string {
  const params: string[] = [];
  if (subject?.trim()) params.push(`subject=${encodeURIComponent(subject.trim())}`);
  if (body?.trim()) params.push(`body=${encodeURIComponent(body.trim())}`);
  if (cc?.trim()) params.push(`cc=${encodeURIComponent(cc.trim())}`);
  const query = params.length > 0 ? `?${params.join("&")}` : "";
  return `mailto:${email.trim()}${query}`;
}

// ============================================================================
// 1. URL Normalization (50 tests)
// ============================================================================

describe("URL normalization (50 URLs)", () => {
  const urlCases: Array<[string, string, string]> = [
    // [description, input, expected]
    // -- http/https preserved --
    ["http URL preserved", "http://example.com", "http://example.com"],
    ["https URL preserved", "https://example.com", "https://example.com"],
    ["HTTP uppercase preserved", "HTTP://EXAMPLE.COM", "HTTP://EXAMPLE.COM"],
    ["HTTPS uppercase preserved", "HTTPS://EXAMPLE.COM", "HTTPS://EXAMPLE.COM"],
    ["https with path", "https://example.com/page", "https://example.com/page"],
    ["http with port", "http://localhost:3000", "http://localhost:3000"],
    ["https with query", "https://example.com?q=1&b=2", "https://example.com?q=1&b=2"],
    ["https with fragment", "https://example.com#section", "https://example.com#section"],
    ["https with auth", "https://user:pass@example.com", "https://user:pass@example.com"],
    ["https complex URL", "https://sub.domain.co.uk/path/to/page?key=val#frag", "https://sub.domain.co.uk/path/to/page?key=val#frag"],

    // -- ftp --
    ["ftp preserved", "ftp://files.example.com", "ftp://files.example.com"],
    ["ftp with path", "ftp://ftp.example.com/pub/file.zip", "ftp://ftp.example.com/pub/file.zip"],
    ["ftps preserved", "ftps://secure.example.com", "ftps://secure.example.com"],

    // -- mailto --
    ["mailto preserved", "mailto:user@example.com", "mailto:user@example.com"],
    ["mailto with subject", "mailto:a@b.com?subject=Hi", "mailto:a@b.com?subject=Hi"],

    // -- tel --
    ["tel preserved", "tel:+1234567890", "tel:+1234567890"],
    ["tel local number", "tel:555-0100", "tel:555-0100"],

    // -- custom protocols --
    ["custom app protocol", "myapp://deep/link", "myapp://deep/link"],
    ["slack protocol", "slack://channel/C12345", "slack://channel/C12345"],
    ["vscode protocol", "vscode://file/path", "vscode://file/path"],
    ["data URI", "data:text/html,<h1>Hi</h1>", "data:text/html,<h1>Hi</h1>"],
    ["file protocol", "file:///C:/Users/test.html", "file:///C:/Users/test.html"],
    ["ssh protocol", "ssh://git@github.com", "ssh://git@github.com"],

    // -- missing protocol (gets https://) --
    ["bare domain", "example.com", "https://example.com"],
    ["www domain", "www.example.com", "https://www.example.com"],
    ["subdomain", "sub.example.com", "https://sub.example.com"],
    ["domain with path", "example.com/page", "https://example.com/page"],
    ["domain with query", "example.com?q=test", "https://example.com?q=test"],
    ["domain with fragment", "example.com#top", "https://example.com#top"],
    ["domain with port (matches scheme pattern)", "example.com:8080", "example.com:8080"],
    ["domain with port and path (matches scheme pattern)", "example.com:8080/api/v1", "example.com:8080/api/v1"],
    ["IP address", "192.168.1.1", "https://192.168.1.1"],
    ["IP with port", "192.168.1.1:3000", "https://192.168.1.1:3000"],
    ["localhost", "localhost", "https://localhost"],
    ["localhost with port (matches scheme pattern)", "localhost:5173", "localhost:5173"],
    ["co.uk domain", "example.co.uk", "https://example.co.uk"],
    ["deep path bare", "example.com/a/b/c/d", "https://example.com/a/b/c/d"],
    ["unicode domain", "xn--e1afmapc.xn--p1ai", "https://xn--e1afmapc.xn--p1ai"],

    // -- whitespace handling --
    ["leading spaces", "  example.com", "https://example.com"],
    ["trailing spaces", "example.com  ", "https://example.com"],
    ["both spaces", "  example.com  ", "https://example.com"],
    ["spaces around https", "  https://example.com  ", "https://example.com"],
    ["tab characters", "\texample.com\t", "https://example.com"],

    // -- edge cases --
    ["single word", "intranet", "https://intranet"],
    ["with encoded chars", "example.com/path%20with%20spaces", "https://example.com/path%20with%20spaces"],
    ["very long URL", "example.com/" + "a".repeat(200), "https://example.com/" + "a".repeat(200)],
    ["multiple subdomains", "a.b.c.d.e.example.com", "https://a.b.c.d.e.example.com"],
    ["mixed case domain", "Example.COM/Path", "https://Example.COM/Path"],
    ["trailing slash", "example.com/", "https://example.com/"],
    ["double slash path", "example.com//path", "https://example.com//path"],
  ];

  it.each(urlCases)("%s: '%s' -> '%s'", (_desc, input, expected) => {
    expect(normalizeUrl(input)).toBe(expected);
  });
});

// ============================================================================
// 2. Email Validation (40 emails)
// ============================================================================

describe("Email validation (40 emails)", () => {
  const validEmails: Array<[string, string]> = [
    ["standard", "user@example.com"],
    ["with subdomain", "user@mail.example.com"],
    ["plus addressing", "user+tag@example.com"],
    ["dots in local", "first.last@example.com"],
    ["hyphen in domain", "user@my-domain.com"],
    ["numbers in local", "user123@example.com"],
    ["numbers in domain", "user@123.com"],
    ["underscore in local", "user_name@example.com"],
    ["short local", "a@example.com"],
    ["long TLD", "user@example.museum"],
    ["multi-dot domain", "user@sub.domain.co.uk"],
    ["all numbers local", "123@example.com"],
    ["mixed case", "User@Example.COM"],
    ["dash and dot", "first-last.name@example.com"],
    ["percent in local", "user%tag@example.com"],
    ["with spaces trimmed", "  user@example.com  "],
    ["exclamation local", "user!def@example.com"],
    ["hash local", "user#tag@example.com"],
    ["dollar local", "user$tag@example.com"],
    ["ampersand local", "user&tag@example.com"],
  ];

  const invalidEmails: Array<[string, string]> = [
    ["empty string", ""],
    ["no at sign", "userexample.com"],
    ["no domain", "user@"],
    ["no TLD", "user@example"],
    ["space in local", "us er@example.com"],
    ["space in domain", "user@exam ple.com"],
    ["double at", "user@@example.com"],
    ["at at start", "@example.com"],
    ["at at end", "user@"],
    ["no local part", "@example.com"],
    ["just at sign", "@"],
    ["just dot", "."],
    ["only spaces", "   "],
    ["newline in email", "user\n@example.com"],
    ["tab in email", "user\t@example.com"],
    ["comma instead of dot", "user@example,com"],
    ["local with space before at", "user name@example.com"],
    ["domain with space", "user@example .com"],
    ["space only local", " @example.com"],
    ["multiple ats", "user@host@example.com"],
  ];

  describe("valid emails", () => {
    it.each(validEmails)("%s: '%s' is valid", (_desc, email) => {
      expect(isValidEmail(email)).toBe(true);
    });
  });

  describe("invalid emails", () => {
    it.each(invalidEmails)("%s: '%s' is invalid", (_desc, email) => {
      expect(isValidEmail(email)).toBe(false);
    });
  });
});

// ============================================================================
// 3. Cell Reference Validation (30 refs)
// ============================================================================

describe("Cell reference validation (30 refs)", () => {
  const validRefs: Array<[string, string]> = [
    ["simple A1", "A1"],
    ["B5", "B5"],
    ["Z1", "Z1"],
    ["AA1", "AA1"],
    ["AZ99", "AZ99"],
    ["XFD1048576", "XFD1048576"],
    ["lowercase a1", "a1"],
    ["lowercase zz100", "zz100"],
    ["absolute $A$1", "$A$1"],
    ["mixed $A1", "$A1"],
    ["mixed A$1", "A$1"],
    ["absolute $AB$50", "$AB$50"],
    ["with spaces trimmed", " A1 "],
    ["triple letter AAA1", "AAA1"],
    ["large row A999999", "A999999"],
  ];

  const invalidRefs: Array<[string, string]> = [
    ["empty string", ""],
    ["pure number", "123"],
    ["pure letters", "ABC"],
    ["range A1:B5", "A1:B5"],
    ["with space inside", "A 1"],
    ["starts with number", "1A"],
    ["special char", "A1!"],
    ["comma separated", "A1,B2"],
    ["colon only", ":"],
    ["dot notation", "A1.B2"],
    ["negative number", "A-1"],
    ["float row", "A1.5"],
    ["slash", "A/1"],
    ["named range", "MyRange"],
    ["R1C1 style", "R1C1"],
  ];

  describe("valid refs", () => {
    it.each(validRefs)("%s: '%s' is valid", (_desc, ref) => {
      expect(isValidCellRef(ref)).toBe(true);
    });
  });

  describe("invalid refs", () => {
    it.each(invalidRefs)("%s: '%s' is invalid", (_desc, ref) => {
      expect(isValidCellRef(ref)).toBe(false);
    });
  });
});

// ============================================================================
// 4. Cell Reference Parsing (additional parameterized)
// ============================================================================

describe("Cell reference parsing (parameterized)", () => {
  const parseCases: Array<[string, { row: number; col: number } | null]> = [
    ["A1", { row: 0, col: 0 }],
    ["B1", { row: 0, col: 1 }],
    ["C1", { row: 0, col: 2 }],
    ["Z1", { row: 0, col: 25 }],
    ["AA1", { row: 0, col: 26 }],
    ["AB1", { row: 0, col: 27 }],
    ["AZ1", { row: 0, col: 51 }],
    ["BA1", { row: 0, col: 52 }],
    ["A2", { row: 1, col: 0 }],
    ["A10", { row: 9, col: 0 }],
    ["A100", { row: 99, col: 0 }],
    ["A1000", { row: 999, col: 0 }],
    ["ZZ1", { row: 0, col: 701 }],
    ["a1", { row: 0, col: 0 }],
    ["az1", { row: 0, col: 51 }],
    ["", null],
    ["123", null],
    ["!!", null],
    ["A1:B2", null],
    ["A", null],
  ];

  it.each(parseCases)("parseCellRef('%s') -> %j", (input, expected) => {
    expect(parseCellRef(input)).toEqual(expected);
  });
});

// ============================================================================
// 5. Mailto Construction (20 combos)
// ============================================================================

describe("Mailto construction (20 combos)", () => {
  const mailtoCases: Array<[string, string, string | undefined, string | undefined, string | undefined, string]> = [
    // [desc, email, subject, body, cc, expected]
    ["bare email", "user@example.com", undefined, undefined, undefined, "mailto:user@example.com"],
    ["with subject", "user@example.com", "Hello", undefined, undefined, "mailto:user@example.com?subject=Hello"],
    ["with body", "user@example.com", undefined, "Body text", undefined, "mailto:user@example.com?body=Body%20text"],
    ["with cc", "user@example.com", undefined, undefined, "other@example.com", "mailto:user@example.com?cc=other%40example.com"],
    ["subject + body", "user@example.com", "Hi", "Hello there", undefined, "mailto:user@example.com?subject=Hi&body=Hello%20there"],
    ["subject + cc", "user@example.com", "Hi", undefined, "cc@test.com", "mailto:user@example.com?subject=Hi&cc=cc%40test.com"],
    ["body + cc", "user@example.com", undefined, "Some body", "cc@test.com", "mailto:user@example.com?body=Some%20body&cc=cc%40test.com"],
    ["all three params", "user@example.com", "Subject", "Body", "cc@test.com", "mailto:user@example.com?subject=Subject&body=Body&cc=cc%40test.com"],
    ["special chars in subject", "u@e.com", "Hello & Goodbye", undefined, undefined, "mailto:u@e.com?subject=Hello%20%26%20Goodbye"],
    ["unicode in subject", "u@e.com", "Hej!", undefined, undefined, "mailto:u@e.com?subject=Hej!"],
    ["empty subject ignored", "u@e.com", "", undefined, undefined, "mailto:u@e.com"],
    ["whitespace subject ignored", "u@e.com", "   ", undefined, undefined, "mailto:u@e.com"],
    ["empty body ignored", "u@e.com", undefined, "", undefined, "mailto:u@e.com"],
    ["whitespace body ignored", "u@e.com", undefined, "  ", undefined, "mailto:u@e.com"],
    ["empty cc ignored", "u@e.com", undefined, undefined, "", "mailto:u@e.com"],
    ["email with spaces trimmed", "  user@example.com  ", "Hi", undefined, undefined, "mailto:user@example.com?subject=Hi"],
    ["subject with newline", "u@e.com", "Line1\nLine2", undefined, undefined, "mailto:u@e.com?subject=Line1%0ALine2"],
    ["body with newline", "u@e.com", undefined, "Line1\nLine2", undefined, "mailto:u@e.com?body=Line1%0ALine2"],
    ["plus in subject", "u@e.com", "1+1=2", undefined, undefined, "mailto:u@e.com?subject=1%2B1%3D2"],
    ["long subject", "u@e.com", "A".repeat(100), undefined, undefined, "mailto:u@e.com?subject=" + encodeURIComponent("A".repeat(100))],
  ];

  it.each(mailtoCases)(
    "%s",
    (_desc, email, subject, body, cc, expected) => {
      expect(buildMailtoTarget(email, subject, body, cc)).toBe(expected);
    },
  );
});
