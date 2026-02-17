//! FILENAME: app/extensions/BuiltIn/FormulaAutocomplete/tokenParser.ts
// PURPOSE: Parse formula text at cursor position to extract autocomplete context.
// CONTEXT: Determines if the user is typing a function name and which argument
// they're in (for argument hints).

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
const TRIGGER_CHARS = new Set(["=", "(", ",", "+", "-", "*", "/", "^", "&", "<", ">", " "]);

/** Regex to detect cell references like A1, $B$2, AA100 */
const CELL_REF_PATTERN = /^\$?[A-Za-z]{1,3}\$?\d+$/;

/** Regex to detect column references like A:A, $B:$C */
const COLUMN_REF_PATTERN = /^\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}$/;

/** Regex to detect row references like 1:1, $5:$10 */
const ROW_REF_PATTERN = /^\$?\d+:\$?\d+$/;

/**
 * Check if a character is a valid function name character (letters, digits, underscore).
 */
function isIdentifierChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
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

  // Scan backwards from cursor to find the token start.
  // A token is a contiguous sequence of identifier characters.
  let tokenStart = cursorPosition;
  while (tokenStart > 0) {
    const ch = value[tokenStart - 1];
    if (!isIdentifierChar(ch)) {
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
      shouldTrigger = TRIGGER_CHARS.has(charBefore);
    }
  }

  // Reject tokens that look like cell references (A1, $B$2, AA100, etc.)
  if (shouldTrigger && token.length > 0) {
    if (CELL_REF_PATTERN.test(token) || COLUMN_REF_PATTERN.test(token) || ROW_REF_PATTERN.test(token)) {
      shouldTrigger = false;
    }

    // Also reject if the token is purely numeric (row number)
    if (/^\d+$/.test(token)) {
      shouldTrigger = false;
    }

    // Reject if the token starts with $ (absolute reference marker)
    if (token.startsWith("$")) {
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
 * Walk backwards through the formula to find the enclosing function call
 * and determine which argument the cursor is in.
 *
 * @param value - The full formula string
 * @param cursorPosition - Current cursor position
 * @returns The enclosing function name and argument index
 */
function findEnclosingFunction(
  value: string,
  cursorPosition: number
): { enclosingFunction: string | null; argumentIndex: number } {
  let parenDepth = 0;
  let argIndex = 0;
  let inString = false;
  let stringChar = "";

  for (let i = cursorPosition - 1; i >= 0; i--) {
    const ch = value[i];

    // Track string literals to ignore parentheses/commas inside them
    if ((ch === '"' || ch === "'") && !inString) {
      inString = true;
      stringChar = ch;
      continue;
    }
    if (inString && ch === stringChar) {
      inString = false;
      continue;
    }
    if (inString) {
      continue;
    }

    if (ch === ")") {
      parenDepth++;
    } else if (ch === "(") {
      if (parenDepth === 0) {
        // Found the opening paren of the enclosing function.
        // Look back to extract the function name.
        let nameEnd = i;
        let nameStart = i - 1;
        while (nameStart >= 0 && isIdentifierChar(value[nameStart])) {
          nameStart--;
        }
        nameStart++;

        if (nameStart < nameEnd) {
          const funcName = value.substring(nameStart, nameEnd).toUpperCase();
          return {
            enclosingFunction: funcName,
            argumentIndex: argIndex,
          };
        }
        // Opening paren without a function name (e.g., grouping parens)
        return { enclosingFunction: null, argumentIndex: -1 };
      }
      parenDepth--;
    } else if (ch === "," && parenDepth === 0) {
      argIndex++;
    }
  }

  return { enclosingFunction: null, argumentIndex: -1 };
}
