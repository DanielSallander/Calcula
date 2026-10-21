//! FILENAME: app/src/api/__tests__/localeGlobalsBan.test.ts
// PURPOSE: Prove that the app-locale lint bans (P2 S11) FIRE on newly written
//          code, in every kind of file -- and keep them fired.
// CONTEXT: The bans are LOCALE_RESTRICTED_PROPERTIES / LOCALE_RESTRICTED_SYNTAX
//          in eslint.boundaries.js, spread INTO the dialog block's
//          no-restricted-properties / no-restricted-syntax and into the two
//          colour blocks' no-restricted-syntax (the Model Editor and the
//          redesigned chrome). Those colour blocks set no-restricted-syntax for
//          their own files, and flat config is last-wins per rule id, so an
//          entry that lived only in the dialog block would be silently
//          replaced there. That is why each shape is linted in an ordinary
//          extension file AND a Model Editor file AND a chrome-colour file.
//
//          Same shape as dialogGlobalsBan.test.ts: one ESLint instance with the
//          real CI config over synthetic sources.

import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

let shared: ESLint | null = null;
function eslintInstance(): ESLint {
  shared ??= new ESLint({
    cwd: APP_DIR,
    overrideConfigFile: path.join(APP_DIR, "eslint.config.boundaries.js"),
    ignore: false,
  });
  return shared;
}

async function lint(relPath: string, source: string): Promise<ESLint.LintResult> {
  const [result] = await eslintInstance().lintText(source, {
    filePath: path.join(APP_DIR, relPath),
  });
  return result;
}

const LOCALE_RULES = new Set(["no-restricted-properties", "no-restricted-syntax"]);

/** The locale-ban reports in a lint result (identified by the shared message). */
function localeErrors(result: ESLint.LintResult): string[] {
  return result.messages
    .filter((m) => m.ruleId !== null && LOCALE_RULES.has(m.ruleId) && m.message.includes("@api/locale"))
    .map((m) => `${m.line}:${m.ruleId}`);
}

describe("the app-locale lint bans", () => {
  // The config load is setup, not assertion (see dialogGlobalsBan.test.ts for
  // the measured cost under the full suite).
  beforeAll(async () => {
    await lint("src/core/lib/__warmup_locale__.ts", "export const warm = 3;\n");
  }, 300_000);

  const SHAPES: [name: string, code: string][] = [
    ["n.toLocaleString()", `export function f(n: number) { return n.toLocaleString(); }\n`],
    ["toLocaleString with a locale", `export function f(n: number) { return n.toLocaleString("de-DE"); }\n`],
    ["d.toLocaleDateString()", `export function f(d: Date) { return d.toLocaleDateString(); }\n`],
    ["d.toLocaleTimeString()", `export function f(d: Date) { return d.toLocaleTimeString(); }\n`],
    ["a non-call reference", `export function f(n: number) { const g = n.toLocaleString; return g; }\n`],
    ["new Intl.NumberFormat", `export const f = new Intl.NumberFormat("en-US").format(1);\n`],
    ["Intl.NumberFormat() without new", `export const f = Intl.NumberFormat("en-US").format(1);\n`],
    ["new Intl.DateTimeFormat", `export const f = new Intl.DateTimeFormat().format(new Date());\n`],
    ["Intl.DateTimeFormat() without new", `export const f = Intl.DateTimeFormat().format(new Date());\n`],
    ["the retired getCachedLocale", `import { getCachedLocale } from "@api/locale";\nexport const f = getCachedLocale();\n`],
    ["the deleted parseDisplayNumber", `export function parseDisplayNumber(s: string) { return s.length; }\n`],
    ["Number(cell.display)", `export function f(cell: { display: string }) { return Number(cell.display); }\n`],
    ["Number(cell?.display)", `export function f(cell?: { display: string }) { return Number(cell?.display); }\n`],
    ["parseFloat(c.display)", `export function f(c: { display: string }) { return parseFloat(c.display); }\n`],
    ["Number.parseFloat(c.display)", `export function f(c: { display: string }) { return Number.parseFloat(c.display); }\n`],
  ];

  // An ordinary extension file, Core, the shell, the facade, a Model Editor
  // file and a redesigned chrome file (the last two are the last-wins blocks).
  const PATHS = [
    "extensions/Charts/lib/__synthetic__.ts",
    "src/core/lib/__synthetic__.ts",
    "src/shell/__synthetic__.tsx",
    "src/api/__synthetic__.ts",
    "extensions/ModelEditor/components/__synthetic__.tsx",
    "extensions/Settings/components/__synthetic__.tsx",
  ];

  for (const relPath of PATHS) {
    it.each(SHAPES)(`rejects %s in ${relPath}`, async (_name, code) => {
      const result = await lint(relPath, code);
      expect(localeErrors(result).length, JSON.stringify(result.messages)).toBeGreaterThan(0);
    });
  }

  it("names the sanctioned replacement in the message", async () => {
    const result = await lint("extensions/Charts/lib/__synthetic__.ts", SHAPES[0][1]);
    const message = result.messages.find((m) => m.message.includes("@api/locale"))?.message ?? "";
    expect(message).toContain("formatNumber");
    expect(message).toContain("parseNumber");
    expect(message).toContain("APP locale");
  });

  it("ACCEPTS @api/locale and other Intl members, so the rule is not a blanket ban", async () => {
    const result = await lint(
      "extensions/Charts/lib/__synthetic__.ts",
      `import { formatNumber, parseNumber, formatDate } from "@api/locale";\n` +
        `export const a = formatNumber(1234.5, { grouping: true });\n` +
        `export const b = parseNumber("1.234,5");\n` +
        `export const c = formatDate(45306);\n` +
        `export const d = Intl.Collator;\n` +
        `export const e = new Intl.Segmenter();\n`,
    );
    expect(localeErrors(result)).toEqual([]);
  });

  it("does not police TEST files (they may assert against the browser's own formatting)", async () => {
    const result = await lint(
      "extensions/Charts/lib/__tests__/__synthetic__.test.ts",
      `export const f = (n: number) => n.toLocaleString();\n`,
    );
    expect(localeErrors(result)).toEqual([]);
  });
});
