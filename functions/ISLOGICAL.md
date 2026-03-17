# ISLOGICAL function

## Introduction

The ISLOGICAL function checks whether a value is a logical value (TRUE or FALSE) and returns TRUE or FALSE. It specifically tests for Boolean values, not for numbers or text that might represent logical concepts.

Use ISLOGICAL to validate that a cell contains a genuine Boolean value, which is useful in data validation, conditional formatting, and when building formulas that need to differentiate between logical values and other data types.

## Syntax

```
=ISLOGICAL(value)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| value | Required | The value, cell reference, or expression to test. |

## Remarks

- ISLOGICAL returns TRUE only for the Boolean values TRUE and FALSE.
- The text strings "TRUE" and "FALSE" return FALSE (they are text, not logical values).
- Numbers 0 and 1 return FALSE (they are numbers, not logical values).

## Example

| | A | B |
|---|---|---|
| 1 | **Value** | **Is Logical?** |
| 2 | TRUE | =ISLOGICAL(A2) |
| 3 | FALSE | =ISLOGICAL(A3) |
| 4 | 1 | =ISLOGICAL(A4) |
| 5 | "TRUE" | =ISLOGICAL(A5) |

**Result (B2):** TRUE
**Result (B3):** TRUE
**Result (B4):** FALSE
**Result (B5):** FALSE

Only the actual Boolean values TRUE and FALSE return TRUE. The number 1 and the text string "TRUE" return FALSE.
