//! FILENAME: app/extensions/BuiltIn/FormulaAutocomplete/tokenParser.ts
// PURPOSE: Parse formula text at cursor position to extract autocomplete context.
// CONTEXT: Determines if the user is typing a function name and which argument
// they're in (for argument hints).

import { getCachedLocale } from "@api/locale";

/**
 * Context about what the user is typing at the cursor position.
 */
export interface TokenContext {
  /** The partial text being typed (e.g., "SU" from "=SU") */
  token: string;
  /** Start position of the token in the formula string */
  tokenStart: number;
  /** Whether autocomplete should trigger for a function name */
  shouldTrigger: boolean;
  /** The function name if cursor is inside parentheses (for argument hints) */
  enclosingFunction: string | null;
  /** Which argument the cursor is in (0-based), -1 if not inside a function */
  argumentIndex: number;
}

/** Characters that mark the start of a new token (where a function name can begin) */
const BASE_TRIGGER_CHARS = new Set(["=", "(", "+", "-", "*", "/", "^", "&", "<", ">", " "]);

/** Regex to detect cell references like A1, $B$2, AA100 */
const CELL_REF_PATTERN = /^\$?[A-Za-z]{1,3}\$?\d+$/;

/** Regex to detect column references like A:A, $B:$C */
const COLUMN_REF_PATTERN = /^\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}$/;

/** Regex to detect row references like 1:1, $5:$10 */
const ROW_REF_PATTERN = /^\$?\d+:\$?\d+$/;

/**
 * Get the locale's list separator (argument separator), defaulting to ",".
 */
function getListSeparator(): string {
  return getCachedLocale()?.listSeparator ?? ",";
}

/**
 * Check if a character can be part of a function name token: letters, digits,
 * underscore, and the dot.
 *
 * The dot is allowed so dotted built-in names such as `GET.CONTROLVALUE`,
 * `GET.ROW.HEIGHT`, and `GET.CELL.FILLCOLOR` are captured as a single token.
 * Numeric tokens that happen to contain a dot (e.g. `3.14`) are filtered out
 * afterwards by the "must start with a letter/underscore" trigger guard.
 */
function isFunctionNameChar(ch: string): boolean {
  return /[A-Za-z0-9_.]/.test(ch);
}

/**
 * Parse the formula at the given cursor position to determine autocomplete context.
 *
 * @param value - The full formula string (e.g., "=SU")
 * @param cursorPosition - The cursor position (index after the last typed character)
 * @returns TokenContext describing what the user is typing
 */
export function parseTokenAtCursor(value: string, cursorPosition: number): TokenContext {
  const noTrigger: TokenContext = {
    token: "",
    tokenStart: 0,
    shouldTrigger: false,
    enclosingFunction: null,
    argumentIndex: -1,
  };

  // Not a formula? No trigger.
  if (!value.startsWith("=")) {
    return noTrigger;
  }

  // Cursor at position 0 or 1 (just "=" typed)? No token yet.
  if (cursorPosition <= 1) {
    return {
      ...noTrigger,
      ...findEnclosingFunction(value, cursorPosition),
    };
  }

  const listSep = getListSeparator();

  // Scan backwards from cursor to find the token start.
  // A token is a contiguous sequence of function-name characters (letters,
  // digits, underscore, and dots). Dots are included so dotted built-in names
  // like GET.CONTROLVALUE filter as a single token once the user types past
  // the dot (e.g. "=GET.CONT" -> token "GET.CONT").
  let tokenStart = cursorPosition;
  while (tokenStart > 0) {
    const ch = value[tokenStart - 1];
    if (!isFunctionNameChar(ch)) {
      break;
    }
    tokenStart--;
  }

  const token = value.substring(tokenStart, cursorPosition);

  // Determine if we should trigger: the character before the token must be a trigger char
  // (or the token starts right after "=")
  let shouldTrigger = false;
  if (token.length > 0) {
    if (tokenStart === 1) {
      // Token starts right after "="
      shouldTrigger = true;
    } else if (tokenStart > 0) {
      const charBefore = value[tokenStart - 1];
      shouldTrigger = BASE_TRIGGER_CHARS.has(charBefore) || charBefore === listSep;
    }
  }

  // Reject tokens that look like cell references (A1, $B$2, AA100, etc.)
  if (shouldTrigger && token.length > 0) {
    if (CELL_REF_PATTERN.test(token) || COLUMN_REF_PATTERN.test(token) || ROW_REF_PATTERN.test(token)) {
      shouldTrigger = false;
    }

    // Function and named-range names always begin with a letter or underscore.
    // This one guard rejects numbers and decimals ("3", "3.14"), absolute-ref
    // markers ("$B$2"), and bare/leading dots -- while still allowing dotted
    // built-in names like "GET.CONTROLVALUE" (which begin with a letter).
    if (!/^[A-Za-z_]/.test(token)) {
      shouldTrigger = false;
    }
  }

  // Find the enclosing function for argument hints
  const enclosing = findEnclosingFunction(value, cursorPosition);

  return {
    token,
    tokenStart,
    shouldTrigger,
    enclosingFunction: enclosing.enclosingFunction,
    argumentIndex: enclosing.argumentIndex,
  };
}

/**
 * Extract the function name immediately to the left of an opening paren.
 * Dots are allowed so dotted built-ins (e.g. GET.CONTROLVALUE) resolve as a
 * single name instead of just the tail segment ("CONTROLVALUE") -- without
 * which the argument hint could never be looked up for those functions.
 *
 * @returns The raw (not upper-cased) name, or null for a bare grouping paren.
 */
function extractNameBeforeParen(value: string, parenIndex: number): string | null {
  const nameEnd = parenIndex;
  let nameStart = parenIndex - 1;
  while (nameStart >= 0 && isFunctionNameChar(value[nameStart])) {
    nameStart--;
  }
  nameStart++;

  // Trim any leading dots/digits that a preceding literal could contribute
  // (e.g. "=3.SUM(" -> keep "SUM"); real names start with a letter/underscore.
  while (nameStart < nameEnd && !/[A-Za-z_]/.test(value[nameStart])) {
    nameStart++;
  }

  return nameStart < nameEnd ? value.substring(nameStart, nameEnd) : null;
}

/**
 * Find the enclosing function call at the cursor and which argument the cursor
 * is in.
 *
 * The formula is scanned FORWARD from the start up to the cursor, maintaining a
 * stack of open parentheses. Scanning forward (rather than backward from the
 * cursor) is what makes string handling correct: a quote is unambiguously an
 * OPENING quote the first time it is seen, so a half-typed string argument with
 * only an opening quote (e.g. `=GET.CONTROLVALUE("Region`) no longer swallows
 * the enclosing `(` and function name -- the argument hint stays visible while
 * the user types a string argument.
 *
 * @param value - The full formula string
 * @param cursorPosition - Current cursor position
 * @returns The innermost enclosing function name and argument index
 */
function findEnclosingFunction(
  value: string,
  cursorPosition: number
): { enclosingFunction: string | null; argumentIndex: number } {
  const listSep = getListSeparator();

  // Each frame: the function name owning the paren (null for a bare grouping
  // paren) and the argument index the cursor is at within that call.
  const stack: Array<{ name: string | null; argIndex: number }> = [];
  let inString = false;
  let stringChar = "";

  const end = Math.min(cursorPosition, value.length);
  for (let i = 0; i < end; i++) {
    const ch = value[i];

    if (inString) {
      // A matching quote closes the string. (Excel's "" escape nets out to
      // close-then-reopen, which leaves us in-string -- the correct result.)
      if (ch === stringChar) {
        inString = false;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
    } else if (ch === "(") {
      stack.push({ name: extractNameBeforeParen(value, i), argIndex: 0 });
    } else if (ch === ")") {
      stack.pop();
    } else if (ch === listSep && stack.length > 0) {
      stack[stack.length - 1].argIndex++;
    }
  }

  // The innermost open call determines the hint. A bare grouping paren has no
  // name -> no hint (matching the prior behavior for e.g. "=SUM((").
  const top = stack[stack.length - 1];
  if (top && top.name) {
    return { enclosingFunction: top.name.toUpperCase(), argumentIndex: top.argIndex };
  }
  return { enclosingFunction: null, argumentIndex: -1 };
}
