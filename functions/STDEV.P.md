# STDEV.P function

## Introduction
The STDEV.P function calculates the standard deviation of an entire population. Unlike STDEV.S which estimates based on a sample, STDEV.P uses the population formula (divides by n), appropriate when you have data for every member of the population.

## Syntax
```
=STDEV.P(number1, [number2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number1 | Required | The first number, cell reference, or range. |
| number2, ... | Optional | Additional numbers, cell references, or ranges. Up to 255 arguments. |

## Remarks
- Uses the population standard deviation formula (divides by n, not n-1).
- Text, logical values, and empty cells in ranges are ignored.
- Functionally identical to STDEVP; provided for naming consistency with STDEV.S.
- If the data is a sample from a larger population, use STDEV.S instead.

## Example

| | A | B |
|---|---|---|
| 1 | **Values** | |
| 2 | 10 | |
| 3 | 12 | |
| 4 | 23 | |
| 5 | 15 | |
| 6 | **Std Dev** | =STDEV.P(A2:A5) |

**Result:** Approximately 4.97
