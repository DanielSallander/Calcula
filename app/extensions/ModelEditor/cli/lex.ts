// FILENAME: app/extensions/ModelEditor/cli/lex.ts
// PURPOSE: Tokenizer for the Model Editor command line. Splits a script into
//          logical lines (full-line comments dropped, indented lines continue
//          the previous command — multi-line DAX after `=` stays intact) and
//          lexes one logical line into tokens. Everything after a free-standing
//          `=` is captured RAW as the expression tail, so formulas are never
//          re-tokenized by the CLI.

export class CliError extends Error {
  /** 1-based line of the failing logical line's first physical line. */
  line: number | null;

  constructor(message: string, line?: number | null) {
    super(message);
    this.name = "CliError";
    this.line = line ?? null;
  }
}

// ---------------------------------------------------------------------------
// Logical lines
// ---------------------------------------------------------------------------

export interface LogicalLine {
  /** Command text; continuations joined with their newlines preserved. */
  text: string;
  /** 1-based physical line number where the command starts. */
  line: number;
}

const COMMENT_RE = /^\s*(#|\/\/)/;

/** Split script text into logical command lines. A physical line starting
 *  with whitespace continues the previous command (how multi-line formulas
 *  are written); full-line `#` / `//` comments and blank lines are dropped. */
export function logicalLines(source: string): LogicalLine[] {
  const out: LogicalLine[] = [];
  const physical = source.split(/\r\n|\r|\n/);
  for (let i = 0; i < physical.length; i++) {
    const raw = physical[i];
    if (raw.trim() === "" || COMMENT_RE.test(raw)) continue;
    if (/^\s/.test(raw) && out.length > 0) {
      out[out.length - 1].text += "\n" + raw;
    } else {
      out.push({ text: raw, line: i + 1 });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/** A positional or option value token. `colref` is `Table[Column]` (the table
 *  part may have been quoted: `"Dim Customer"[Id]`). `bracket` is a lone
 *  `[Name]` (measure-style reference). */
export interface ValueTok {
  kind: "word" | "string" | "bracket" | "colref";
  text: string;
  /** colref only */
  table?: string;
  /** colref only */
  column?: string;
  pos: number;
}

export type Token =
  | ValueTok
  | { kind: "comma"; pos: number }
  | { kind: "arrow"; pos: number }
  /** `=` glued to the preceding word: an option assignment (`hidden=true`). */
  | { kind: "eqAttached"; pos: number };

export interface LexedLine {
  tokens: Token[];
  /** Raw text after a free-standing `=` (the formula/expression tail). */
  expr: string | null;
}

function isSpace(c: string): boolean {
  return c === " " || c === "\t" || c === "\n";
}

const WORD_STOP = new Set([" ", "\t", "\n", '"', "'", "[", "]", ",", "="]);

/** Lex one logical line. Throws CliError on unterminated strings/brackets. */
export function lexLine(text: string): LexedLine {
  const tokens: Token[] = [];
  let i = 0;
  const n = text.length;

  const readQuoted = (): string => {
    const quote = text[i];
    const start = i;
    i++;
    let out = "";
    while (i < n) {
      const c = text[i];
      if (c === quote) {
        // Doubled quote = literal quote character (Excel/DAX style).
        if (text[i + 1] === quote) {
          out += quote;
          i += 2;
          continue;
        }
        i++;
        return out;
      }
      out += c;
      i++;
    }
    throw new CliError(`Unterminated ${quote}…${quote} string (starts at column ${start + 1})`);
  };

  const readBracket = (): string => {
    const start = i;
    i++; // consume '['
    let out = "";
    while (i < n) {
      const c = text[i];
      if (c === "]") {
        // Doubled ']' = literal ']' inside a name (DAX escaping).
        if (text[i + 1] === "]") {
          out += "]";
          i += 2;
          continue;
        }
        i++;
        return out;
      }
      out += c;
      i++;
    }
    throw new CliError(`Unterminated [ … ] name (starts at column ${start + 1})`);
  };

  while (i < n) {
    if (isSpace(text[i])) {
      i++;
      continue;
    }
    const pos = i;
    const c = text[i];

    if (c === ",") {
      tokens.push({ kind: "comma", pos });
      i++;
      continue;
    }
    if (c === "-" && text[i + 1] === ">") {
      tokens.push({ kind: "arrow", pos });
      i += 2;
      continue;
    }
    if (c === "=") {
      const prev = tokens[tokens.length - 1];
      const glued = pos > 0 && !isSpace(text[pos - 1]);
      if (glued && prev && prev.kind === "word") {
        tokens.push({ kind: "eqAttached", pos });
        i++;
        continue;
      }
      // Free-standing `=`: the rest of the logical line is the raw
      // expression tail (formula, SQL, JSON…), never tokenized.
      const tail = text.slice(pos + 1);
      return { tokens, expr: tail.trim() === "" ? "" : trimTail(tail) };
    }
    if (c === '"' || c === "'") {
      const s = readQuoted();
      // `"Dim Customer"[Id]` — quoted table glued to a bracket = column ref.
      if (text[i] === "[") {
        const col = readBracket();
        tokens.push({ kind: "colref", text: `${s}[${col}]`, table: s, column: col, pos });
      } else {
        tokens.push({ kind: "string", text: s, pos });
      }
      continue;
    }
    if (c === "[") {
      const name = readBracket();
      tokens.push({ kind: "bracket", text: name, pos });
      continue;
    }
    if (c === "]") {
      throw new CliError(`Unexpected ']' at column ${pos + 1}`);
    }

    // Word: run until a stop char or an `->` arrow.
    let w = "";
    while (i < n && !WORD_STOP.has(text[i])) {
      if (text[i] === "-" && text[i + 1] === ">") break;
      w += text[i];
      i++;
    }
    if (w === "") {
      throw new CliError(`Unexpected character '${c}' at column ${pos + 1}`);
    }
    // `Table[Col]` — word glued to a bracket = column ref.
    if (text[i] === "[") {
      const col = readBracket();
      tokens.push({ kind: "colref", text: `${w}[${col}]`, table: w, column: col, pos });
    } else {
      tokens.push({ kind: "word", text: w, pos });
    }
  }

  return { tokens, expr: null };
}

/** Trim the expression tail: leading whitespace (incl. the newline when the
 *  formula starts on a continuation line) and trailing whitespace, but
 *  PRESERVE internal newlines/indentation (multi-line DAX). */
function trimTail(tail: string): string {
  return tail.replace(/^\s+/, "").replace(/\s+$/, "");
}
