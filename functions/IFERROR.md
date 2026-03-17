# IFERROR function

## Introduction

The IFERROR function evaluates an expression and returns a specified value if the expression results in an error; otherwise, it returns the result of the expression itself. This function provides a clean way to trap and handle errors such as #VALUE!, #REF!, #DIV/0!, #N/A, #NAME?, #NULL!, and #NUM! without requiring complex nested IF and ISERROR combinations.

IFERROR is particularly useful when performing lookups that might not find a match, dividing numbers that could be zero, or referencing cells that may contain invalid data. Wrapping these formulas in IFERROR lets you display a friendly message or a default value instead of an error.

## Syntax

```
=IFERROR(value, value_if_error)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| value | Required | The expression or formula to evaluate. If it does not produce an error, this result is returned. |
| value_if_error | Required | The value to return if the expression results in an error. Can be a value, cell reference, formula, or text string. |

## Remarks

- IFERROR catches all error types: #VALUE!, #REF!, #DIV/0!, #N/A, #NAME?, #NULL!, and #NUM!.
- If you only want to catch #N/A errors (common with VLOOKUP), use IFNA instead for more precise error handling.
- An empty string ("") is often used as the value_if_error to display a blank cell.

## Example

| | A | B | C |
|---|---|---|---|
| 1 | **Revenue** | **Units** | **Price per Unit** |
| 2 | 5000 | 0 | =IFERROR(A2/B2, "N/A - No units") |
| 3 | 8000 | 200 | =IFERROR(A3/B3, "N/A - No units") |

**Result:** Cell C2 returns **"N/A - No units"** because dividing by zero produces a #DIV/0! error. Cell C3 returns **40**, the result of 8000 divided by 200.
