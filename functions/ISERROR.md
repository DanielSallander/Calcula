# ISERROR function

## Introduction

The ISERROR function checks whether a value is any error type and returns TRUE or FALSE. It detects all error values including #N/A, #VALUE!, #REF!, #DIV/0!, #NUM!, #NAME?, and #NULL!.

Use ISERROR to trap errors in formulas before they propagate through your calculations. It is commonly used inside IF statements to provide alternative values or messages when a formula produces an error. For more targeted error handling, consider ISNA (which only detects #N/A) or ISERR (which detects all errors except #N/A).

## Syntax

```
=ISERROR(value)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| value | Required | The value, cell reference, or expression to test for an error. |

## Remarks

- ISERROR returns TRUE for ALL error types: #N/A, #VALUE!, #REF!, #DIV/0!, #NUM!, #NAME?, and #NULL!.
- To check for a specific error type, use ISNA (for #N/A) or ISERR (for all errors except #N/A).
- IFERROR is often a more concise alternative to IF(ISERROR(...), ..., ...).

## Example

| | A | B |
|---|---|---|
| 1 | **Formula** | **Has Error?** |
| 2 | =1/0 | =ISERROR(A2) |
| 3 | =VLOOKUP("X", A1:A1, 5) | =ISERROR(A3) |
| 4 | 100 | =ISERROR(A4) |

**Result (B2):** TRUE (A2 produces #DIV/0!)
**Result (B3):** TRUE (A3 produces #REF!)
**Result (B4):** FALSE

The function detects both the division-by-zero error and the reference error, while the valid number 100 returns FALSE.
