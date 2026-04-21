//! FILENAME: app/extensions/FlashFill/lib/patternEngine.ts
// PURPOSE: Pattern detection and application engine for Flash Fill.
// CONTEXT: Learns string transformations from examples and applies them to new data.

// ============================================================================
// Types
// ============================================================================

/** A single example: source value(s) -> desired output. */
export interface Example {
  sources: string[];
  output: string;
}

/**
 * A program that can transform source strings into an output string.
 * Programs are composed of Expression nodes that extract/transform data.
 */
export type Expression =
  | { type: "constant"; value: string }
  | { type: "substring"; sourceIndex: number; start: number; end: number }
  | { type: "delimSplit"; sourceIndex: number; delimiter: string; partIndex: number }
  | { type: "upper"; inner: Expression }
  | { type: "lower"; inner: Expression }
  | { type: "capitalize"; inner: Expression }
  | { type: "concat"; parts: Expression[] };

/** A learned program: a sequence of expressions concatenated to produce output. */
export interface Program {
  expressions: Expression[];
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Learn a transformation from examples. Main entry point.
 * Returns null if no consistent pattern can be found.
 */
export function learn(examples: Example[]): Program | null {
  if (examples.length === 0) return null;

  const candidates = generateCandidates(examples[0]);

  for (const program of candidates) {
    let consistent = true;
    for (const ex of examples) {
      const result = applyProgram(program, ex.sources);
      if (result !== ex.output) {
        consistent = false;
        break;
      }
    }
    if (consistent) return program;
  }

  return null;
}

/**
 * Apply a learned program to source values.
 * Returns null if the program fails to produce output.
 */
export function applyProgram(program: Program, sources: string[]): string | null {
  try {
    return program.expressions.map((expr) => evaluateExpr(expr, sources)).join("");
  } catch {
    return null;
  }
}

// ============================================================================
// Expression Evaluation
// ============================================================================

function evaluateExpr(expr: Expression, sources: string[]): string {
  switch (expr.type) {
    case "constant":
      return expr.value;

    case "substring": {
      const src = sources[expr.sourceIndex] ?? "";
      return src.substring(expr.start, expr.end);
    }

    case "delimSplit": {
      const src = sources[expr.sourceIndex] ?? "";
      const parts = src.split(expr.delimiter);
      const idx = expr.partIndex < 0 ? parts.length + expr.partIndex : expr.partIndex;
      return parts[idx] ?? "";
    }

    case "upper":
      return evaluateExpr(expr.inner, sources).toUpperCase();

    case "lower":
      return evaluateExpr(expr.inner, sources).toLowerCase();

    case "capitalize": {
      const val = evaluateExpr(expr.inner, sources);
      return val.charAt(0).toUpperCase() + val.slice(1).toLowerCase();
    }

    case "concat":
      return expr.parts.map((p) => evaluateExpr(p, sources)).join("");
  }
}

// ============================================================================
// Candidate Generation
// ============================================================================

const COMMON_DELIMITERS = [" ", ",", ";", "-", "_", "@", ".", "/", "\\", "|", "\t", ", ", " - ", ": "];

/**
 * Generate all candidate programs for a single example.
 */
function generateCandidates(example: Example): Program[] {
  const { sources, output } = example;
  const candidates: Program[] = [];

  for (let si = 0; si < sources.length; si++) {
    const src = sources[si];
    if (!src) continue;

    // --- Case transformation of entire source ---
    if (src.toUpperCase() === output && src !== output) {
      candidates.push({ expressions: [{ type: "upper", inner: { type: "substring", sourceIndex: si, start: 0, end: src.length } }] });
    }
    if (src.toLowerCase() === output && src !== output) {
      candidates.push({ expressions: [{ type: "lower", inner: { type: "substring", sourceIndex: si, start: 0, end: src.length } }] });
    }
    if (capitalizeWord(src) === output && src !== output) {
      candidates.push({ expressions: [{ type: "capitalize", inner: { type: "substring", sourceIndex: si, start: 0, end: src.length } }] });
    }

    // --- Delimiter-based strategies (before substring — generalizes better) ---
    for (const delim of COMMON_DELIMITERS) {
      if (!src.includes(delim)) continue;
      const parts = src.split(delim);
      if (parts.length < 2 || parts.length > 10) continue;

      // Single part extraction (with optional case transform)
      for (let pi = 0; pi < parts.length; pi++) {
        if (parts[pi] === output) {
          candidates.push({ expressions: [{ type: "delimSplit", sourceIndex: si, delimiter: delim, partIndex: pi }] });
        }
        if (parts[pi].toUpperCase() === output && parts[pi] !== output) {
          candidates.push({ expressions: [{ type: "upper", inner: { type: "delimSplit", sourceIndex: si, delimiter: delim, partIndex: pi } }] });
        }
        if (parts[pi].toLowerCase() === output && parts[pi] !== output) {
          candidates.push({ expressions: [{ type: "lower", inner: { type: "delimSplit", sourceIndex: si, delimiter: delim, partIndex: pi } }] });
        }
      }

      // Multi-part joins: first N parts, last N parts
      for (let count = 2; count < parts.length; count++) {
        if (parts.slice(0, count).join(delim) === output) {
          candidates.push({ expressions: buildMultiPartExpr(si, delim, 0, count) });
        }
        if (parts.slice(parts.length - count).join(delim) === output) {
          candidates.push({ expressions: buildMultiPartExpr(si, delim, parts.length - count, parts.length) });
        }
      }

      // Initials (e.g., "John Smith" -> "JS", "J.S.", "J. S.")
      const nonEmptyParts = parts.filter((p) => p.length > 0);
      if (nonEmptyParts.length >= 2) {
        const initialsVariants = buildInitialsVariants(nonEmptyParts);
        for (const variant of initialsVariants) {
          if (output === variant.pattern) {
            const prog = buildInitialsProgram(si, src, delim, variant.upper, variant.sep);
            if (prog) candidates.push(prog);
          }
        }
      }

      // Decompose output as rearrangement of delim-split parts + literals
      const decomposed = decomposeFromParts(parts, output, si, delim);
      if (decomposed) {
        candidates.push({ expressions: decomposed });
      }
    }

    // --- Positional decomposition (e.g., "20240315" -> "2024-03-15") ---
    const positional = decomposePositional(si, src, output);
    if (positional) {
      candidates.push({ expressions: positional });
    }

    // --- Direct substring (last resort — position-based, fragile for variable-length inputs) ---
    const idx = src.indexOf(output);
    if (idx >= 0 && output.length > 0) {
      candidates.push({
        expressions: [{ type: "substring", sourceIndex: si, start: idx, end: idx + output.length }],
      });
    }
  }

  // --- Multi-source concatenation ---
  if (sources.length > 1) {
    const multiSource = tryMultiSourceConcat(sources, output);
    candidates.push(...multiSource);
  }

  // --- Delimiter reorder (e.g., "Smith, John" -> "John Smith") ---
  for (let si = 0; si < sources.length; si++) {
    const reorderPrograms = tryDelimiterReorder(si, sources[si], output);
    candidates.push(...reorderPrograms);
  }

  return candidates;
}

// ============================================================================
// Initials
// ============================================================================

function buildInitialsVariants(parts: string[]): Array<{ pattern: string; upper: boolean; sep: string }> {
  const initials = parts.map((p) => p[0]).join("");
  const initialsUpper = parts.map((p) => p[0].toUpperCase()).join("");
  const initialsDot = parts.map((p) => p[0].toUpperCase()).join(".");
  const initialsDotSpace = parts.map((p) => p[0].toUpperCase()).join(". ");

  return [
    { pattern: initials, upper: false, sep: "" },
    { pattern: initialsUpper, upper: true, sep: "" },
    { pattern: initialsDot, upper: true, sep: "." },
    { pattern: initialsDot + ".", upper: true, sep: ".." },
    { pattern: initialsDotSpace, upper: true, sep: ". " },
    { pattern: initialsDotSpace + ".", upper: true, sep: ". ." },
  ];
}

/**
 * Build a program that extracts the first character of each delim-split part.
 * Uses absolute character positions from the first example; validated against all examples.
 */
function buildInitialsProgram(
  sourceIndex: number,
  source: string,
  delimiter: string,
  toUpper: boolean,
  separator: string,
): Program | null {
  const parts = source.split(delimiter).filter((p) => p.length > 0);
  if (parts.length < 2) return null;

  const expressions: Expression[] = [];
  let searchStart = 0;

  for (let i = 0; i < parts.length; i++) {
    const partPos = source.indexOf(parts[i], searchStart);
    if (partPos < 0) return null;

    const firstCharExpr: Expression = {
      type: "substring",
      sourceIndex,
      start: partPos,
      end: partPos + 1,
    };

    if (toUpper) {
      expressions.push({ type: "upper", inner: firstCharExpr });
    } else {
      expressions.push(firstCharExpr);
    }

    // Add separator between parts (not after last)
    if (i < parts.length - 1 && separator.length > 0) {
      const sepBetween = separator.replace(/\.$/, "");
      if (sepBetween.length > 0) {
        expressions.push({ type: "constant", value: sepBetween });
      }
    }

    searchStart = partPos + parts[i].length;
  }

  // Trailing dot (e.g., "J.S." has separator "..")
  if (separator.endsWith(".")) {
    expressions.push({ type: "constant", value: "." });
  }

  return { expressions };
}

// ============================================================================
// Concatenation Decomposition
// ============================================================================

/**
 * Try to build output from delimiter-split parts of source with literal separators between them.
 */
function decomposeFromParts(
  parts: string[],
  output: string,
  sourceIndex: number,
  delimiter: string,
): Expression[] | null {
  const expressions: Expression[] = [];
  let remaining = output;
  let iterations = 0;

  while (remaining.length > 0 && iterations < 20) {
    iterations++;
    let matched = false;

    // Try to match a part (longest first for greedy matching)
    const sortedParts = parts
      .map((p, i) => ({ text: p, index: i }))
      .filter((p) => p.text.length > 0)
      .sort((a, b) => b.text.length - a.text.length);

    for (const { text, index } of sortedParts) {
      if (remaining.startsWith(text)) {
        expressions.push({ type: "delimSplit", sourceIndex, delimiter, partIndex: index });
        remaining = remaining.slice(text.length);
        matched = true;
        break;
      }
      // Case-insensitive match
      if (remaining.toLowerCase().startsWith(text.toLowerCase())) {
        const actualText = remaining.slice(0, text.length);
        if (actualText === text.toUpperCase()) {
          expressions.push({ type: "upper", inner: { type: "delimSplit", sourceIndex, delimiter, partIndex: index } });
        } else if (actualText === text.toLowerCase()) {
          expressions.push({ type: "lower", inner: { type: "delimSplit", sourceIndex, delimiter, partIndex: index } });
        } else if (actualText === capitalizeWord(text)) {
          expressions.push({ type: "capitalize", inner: { type: "delimSplit", sourceIndex, delimiter, partIndex: index } });
        } else {
          continue;
        }
        remaining = remaining.slice(text.length);
        matched = true;
        break;
      }
    }

    if (!matched) {
      // Take literal characters until we find a part match
      let literalEnd = 1;
      while (literalEnd < remaining.length) {
        const rest = remaining.slice(literalEnd);
        const hasPartMatch = sortedParts.some(
          ({ text }) => rest.startsWith(text) || rest.toLowerCase().startsWith(text.toLowerCase()),
        );
        if (hasPartMatch) break;
        literalEnd++;
      }
      expressions.push({ type: "constant", value: remaining.slice(0, literalEnd) });
      remaining = remaining.slice(literalEnd);
    }
  }

  if (remaining.length > 0) return null;
  const hasNonConstant = expressions.some((e) => e.type !== "constant");
  if (!hasNonConstant) return null;
  return expressions;
}

/**
 * Try to decompose output as positional substrings of source with inserted literals.
 * E.g., source="20240315", output="2024-03-15"
 */
function decomposePositional(sourceIndex: number, source: string, output: string): Expression[] | null {
  if (source.length < 2 || output.length < 2) return null;
  if (output.length <= source.length) return null;

  const expressions: Expression[] = [];
  let si = 0;
  let oi = 0;

  while (oi < output.length) {
    if (si < source.length && output[oi] === source[si]) {
      let matchLen = 0;
      while (si + matchLen < source.length && oi + matchLen < output.length && output[oi + matchLen] === source[si + matchLen]) {
        matchLen++;
      }
      if (matchLen > 0) {
        expressions.push({ type: "substring", sourceIndex, start: si, end: si + matchLen });
        si += matchLen;
        oi += matchLen;
      }
    } else {
      let literalEnd = oi + 1;
      while (literalEnd < output.length && (si >= source.length || output[literalEnd] !== source[si])) {
        literalEnd++;
      }
      expressions.push({ type: "constant", value: output.slice(oi, literalEnd) });
      oi = literalEnd;
    }
  }

  if (si !== source.length) return null;
  const hasNonConstant = expressions.some((e) => e.type !== "constant");
  if (!hasNonConstant) return null;
  return expressions;
}

// ============================================================================
// Multi-Source Concatenation
// ============================================================================

function tryMultiSourceConcat(sources: string[], output: string): Program[] {
  const programs: Program[] = [];
  const expressions: Expression[] = [];
  let remaining = output;
  let iterations = 0;

  while (remaining.length > 0 && iterations < 20) {
    iterations++;
    let matched = false;

    for (let si = 0; si < sources.length; si++) {
      const src = sources[si];
      if (src.length > 0 && remaining.startsWith(src)) {
        expressions.push({ type: "substring", sourceIndex: si, start: 0, end: src.length });
        remaining = remaining.slice(src.length);
        matched = true;
        break;
      }
    }

    if (!matched) {
      let literalEnd = 1;
      while (literalEnd < remaining.length) {
        const rest = remaining.slice(literalEnd);
        if (sources.some((s) => s.length > 0 && rest.startsWith(s))) break;
        literalEnd++;
      }
      expressions.push({ type: "constant", value: remaining.slice(0, literalEnd) });
      remaining = remaining.slice(literalEnd);
    }
  }

  if (remaining.length === 0 && expressions.some((e) => e.type !== "constant")) {
    programs.push({ expressions });
  }

  return programs;
}

// ============================================================================
// Delimiter Reorder
// ============================================================================

function tryDelimiterReorder(sourceIndex: number, source: string, output: string): Program[] {
  const programs: Program[] = [];

  for (const srcDelim of COMMON_DELIMITERS) {
    if (!source.includes(srcDelim)) continue;
    const srcParts = source.split(srcDelim);
    if (srcParts.length < 2 || srcParts.length > 6) continue;

    for (const outDelim of COMMON_DELIMITERS) {
      if (!output.includes(outDelim)) continue;
      const outParts = output.split(outDelim);
      if (outParts.length !== srcParts.length) continue;

      const trimmedSrc = srcParts.map((p) => p.trim());
      const trimmedOut = outParts.map((p) => p.trim());

      const mapping: number[] = [];
      let valid = true;

      for (const outPart of trimmedOut) {
        const srcIdx = trimmedSrc.findIndex((sp, i) => sp === outPart && !mapping.includes(i));
        if (srcIdx >= 0) {
          mapping.push(srcIdx);
        } else {
          valid = false;
          break;
        }
      }

      if (valid && mapping.length === srcParts.length) {
        const isIdentity = mapping.every((m, i) => m === i) && srcDelim === outDelim;
        if (!isIdentity) {
          const exprs: Expression[] = [];
          for (let i = 0; i < mapping.length; i++) {
            if (i > 0) {
              exprs.push({ type: "constant", value: outDelim });
            }
            exprs.push({ type: "delimSplit", sourceIndex, delimiter: srcDelim, partIndex: mapping[i] });
          }
          programs.push({ expressions: exprs });
        }
      }
    }
  }

  return programs;
}

// ============================================================================
// Helpers
// ============================================================================

function buildMultiPartExpr(sourceIndex: number, delimiter: string, from: number, to: number): Expression[] {
  const exprs: Expression[] = [];
  for (let i = from; i < to; i++) {
    if (i > from) {
      exprs.push({ type: "constant", value: delimiter });
    }
    exprs.push({ type: "delimSplit", sourceIndex, delimiter, partIndex: i });
  }
  return exprs;
}

function capitalizeWord(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
