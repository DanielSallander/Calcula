//FILENAME: app/src/lib/gridRenderer/styles/cellFormatting.ts
//PURPOSE: Cell value type detection utilities
//CONTEXT: Determines if cell values are numbers, errors, or text

/**
 * Determine if a string represents a number.
 */
export function isNumericValue(value: string): boolean {
  if (value === "") {
    return false;
  }
  // Check if it's a number (possibly formatted with currency, percentage, etc.)
  const trimmed = value.trim();
  // Remove common formatting characters for number detection
  const cleaned = trimmed.replace(/[$%,\s]/g, "").replace(/^\((.+)\)$/, "-$1");
  return !isNaN(Number(cleaned)) && cleaned !== "" && isFinite(Number(cleaned));
}

/**
 * Determine if a string represents an error value.
 */
export function isErrorValue(value: string): boolean {
  const errorPatterns = ["#VALUE!", "#REF!", "#NAME?", "#DIV/0!", "#NULL!", "#N/A", "#NUM!", "#ERROR"];
  const upper = value.toUpperCase();
  return errorPatterns.some((pattern) => upper.startsWith(pattern.replace("?", "")));
}