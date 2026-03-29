# VAR.S function

## Introduction
The VAR.S function calculates the variance of a sample. Variance measures how spread out values are from their mean. This is the updated version of the VAR function and is identical in behavior.

## Syntax
```
=VAR.S(number1, [number2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number1 | Required | The first number, cell reference, or range. |
| number2, ... | Optional | Additional numbers, cell references, or ranges. Up to 255 arguments. |

## Remarks
- Uses the sample variance formula (divides by n-1).
- Text, logical values, and empty cells in ranges are ignored.
- If the data represents the entire population, use VAR.P instead.
- Functionally identical to VAR; provided for naming consistency with VAR.P.

## Example

| | A | B |
|---|---|---|
| 1 | **Values** | |
| 2 | 10 | |
| 3 | 12 | |
| 4 | 23 | |
| 5 | 15 | |
| 6 | **Variance** | =VAR.S(A2:A5) |

**Result:** Approximately 32.92
