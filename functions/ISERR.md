# ISERR function

## Introduction

The ISERR function checks whether a value is any error type except #N/A and returns TRUE or FALSE. It detects #VALUE!, #REF!, #DIV/0!, #NUM!, #NAME?, and #NULL!, but specifically excludes #N/A.

Use ISERR when you want to catch formula errors that indicate genuine problems (like invalid references or division by zero) while allowing #N/A to pass through. This distinction is important because #N/A typically means "data not found" rather than a formula error, and you may want to handle these cases differently.

## Syntax

```
=ISERR(value)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| value | Required | The value, cell reference, or expression to test for an error (excluding #N/A). |

## Remarks

- ISERR returns FALSE for #N/A errors. Use ISNA to specifically test for #N/A, or ISERROR to test for all errors including #N/A.
- The errors detected by ISERR are: #VALUE!, #REF!, #DIV/0!, #NUM!, #NAME?, and #NULL!.

## Example

| | A | B |
|---|---|---|
| 1 | **Value** | **Is Err?** |
| 2 | #DIV/0! | =ISERR(A2) |
| 3 | #N/A | =ISERR(A3) |
| 4 | 100 | =ISERR(A4) |

**Result (B2):** TRUE
**Result (B3):** FALSE
**Result (B4):** FALSE

The #DIV/0! error returns TRUE, but #N/A returns FALSE because ISERR deliberately excludes it. The valid number also returns FALSE.
