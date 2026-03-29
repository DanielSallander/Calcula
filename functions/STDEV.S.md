# STDEV.S function

## Introduction
The STDEV.S function calculates the standard deviation of a sample. It estimates how much values in a dataset deviate from the sample mean. This is the updated version of the STDEV function and is identical in behavior.

## Syntax
```
=STDEV.S(number1, [number2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number1 | Required | The first number, cell reference, or range. |
| number2, ... | Optional | Additional numbers, cell references, or ranges. Up to 255 arguments. |

## Remarks
- Uses the sample standard deviation formula (divides by n-1).
- Text, logical values, and empty cells in ranges are ignored.
- If the data represents the entire population, use STDEV.P instead.
- Functionally identical to STDEV; provided for naming consistency with STDEV.P.

## Example

| | A | B |
|---|---|---|
| 1 | **Values** | |
| 2 | 10 | |
| 3 | 12 | |
| 4 | 23 | |
| 5 | 15 | |
| 6 | **Std Dev** | =STDEV.S(A2:A5) |

**Result:** Approximately 5.74
