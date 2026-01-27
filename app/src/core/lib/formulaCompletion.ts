//! FILENAME: app/src/core/lib/formulaCompletion.ts
// PURPOSE: Smart formula auto-completion (e.g., adding missing closing parentheses)
// CONTEXT: Used when committing a formula to fix common incomplete formulas

/**
 * Attempts to auto-complete an incomplete formula.
 * Currently handles:
 * - Missing closing parentheses: =SUM(A1:B2 --> =SUM(A1:B2)
 * - Missing closing quotes: ="Hello --> ="Hello"
 * 
 * @param formula The formula to complete
 * @returns The completed formula, or the original if no completion needed
 */
export function autoCompleteFormula(formula: string): string {
  if (!formula.startsWith("=")) {
    return formula;
  }

  let result = formula;

  // Count parentheses
  let parenDepth = 0;
  let inString = false;
  let stringChar = "";

  for (let i = 0; i < result.length; i++) {
    const char = result[i];
    const prevChar = i > 0 ? result[i - 1] : "";

    // Track string state
    if ((char === '"' || char === "'") && prevChar !== "\\") {
      if (!inString) {
        inString = true;
        stringChar = char;
      } else if (char === stringChar) {
        inString = false;
        stringChar = "";
      }
    }

    // Count parentheses only outside strings
    if (!inString) {
      if (char === "(") {
        parenDepth++;
      } else if (char === ")") {
        parenDepth--;
      }
    }
  }

  // Close any unclosed strings
  if (inString) {
    result += stringChar;
  }

  // Add missing closing parentheses
  if (parenDepth > 0) {
    result += ")".repeat(parenDepth);
  }

  return result;
}

/**
 * Checks if a formula appears to be incomplete and could benefit from auto-completion.
 * 
 * @param formula The formula to check
 * @returns true if the formula seems incomplete
 */
export function isIncompleteFormula(formula: string): boolean {
  if (!formula.startsWith("=")) {
    return false;
  }

  let parenDepth = 0;
  let inString = false;
  let stringChar = "";

  for (let i = 0; i < formula.length; i++) {
    const char = formula[i];
    const prevChar = i > 0 ? formula[i - 1] : "";

    if ((char === '"' || char === "'") && prevChar !== "\\") {
      if (!inString) {
        inString = true;
        stringChar = char;
      } else if (char === stringChar) {
        inString = false;
        stringChar = "";
      }
    }

    if (!inString) {
      if (char === "(") {
        parenDepth++;
      } else if (char === ")") {
        parenDepth--;
      }
    }
  }

  return inString || parenDepth > 0;
}