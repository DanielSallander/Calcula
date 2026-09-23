//! FILENAME: app/src/core/theme/__tests__/sourceText.ts
// PURPOSE: Strip the comments out of a TypeScript source file so the theme
//          parity guards scan only CODE for `var(--name)` spellings.
// CONTEXT: Test support only (not a *.test.ts file, so vitest never collects
//          it). Shared by themeTokenParity.test.ts and
//          layoutThemeParity.test.ts, which both read a token table as TEXT.
//
//          WHY A SCANNER AND NOT TWO REGEXES. The first version was
//          `replace(/\/\*[\s\S]*?\*\//g, "")` followed by cutting each line at
//          `//`. It looks right and it is not: a LINE comment that mentions a
//          glob such as `src/api/layout/**` contains `/**`, which the block
//          regex takes as a comment OPENER and then deletes everything up to
//          the next `*/` anywhere in the file. On app/src/api/layout/theme.ts
//          that swallowed the entire LT table — the guard found ONE name out of
//          fifty and would have passed with every other name misspelled. The
//          sibling suite only escaped the same fate because the `*/` it ran to
//          happened to sit just above its table. Comments have to be recognised
//          in the order they START, with string literals respected, and only a
//          left-to-right scan does that.

/**
 * `src` with every `//` line comment and every block comment removed. String
 * and template literals are kept intact (a `//` inside `"https://..."` is not
 * a comment). Newlines inside removed block comments are preserved, so line
 * numbers in the result still match the file.
 */
export function codeOf(src: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (quote !== null) {
      out += ch;
      if (ch === "\\" && next !== undefined) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      // Keep the line structure of what was removed.
      out += src.slice(i, stop).replace(/[^\n]/g, "");
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    out += ch;
    i++;
  }
  return out;
}
