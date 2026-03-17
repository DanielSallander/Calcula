# ISNA function

## Introduction

The ISNA function checks whether a value is the #N/A error and returns TRUE or FALSE. Unlike ISERROR, which catches all error types, ISNA specifically targets only the #N/A ("not available") error.

Use ISNA when you want to handle missing lookup values separately from other errors. This is particularly useful with VLOOKUP, HLOOKUP, XLOOKUP, and MATCH, which return #N/A when a lookup value is not found. By using ISNA, you can provide a fallback for missing data while still allowing other errors (like #REF! or #DIV/0!) to surface for debugging.

## Syntax

```
=ISNA(value)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| value | Required | The value, cell reference, or expression to test for the #N/A error. |

## Remarks

- ISNA returns TRUE only for #N/A errors. All other error types (#VALUE!, #REF!, #DIV/0!, etc.) return FALSE.
- For catching all errors, use ISERROR instead.
- For catching all errors except #N/A, use ISERR.

## Example

| | A | B |
|---|---|---|
| 1 | **Value** | **Is N/A?** |
| 2 | #N/A | =ISNA(A2) |
| 3 | #DIV/0! | =ISNA(A3) |
| 4 | 50 | =ISNA(A4) |

**Result (B2):** TRUE
**Result (B3):** FALSE
**Result (B4):** FALSE

Only the #N/A error in A2 returns TRUE. The #DIV/0! error and the valid number both return FALSE.
