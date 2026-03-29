# MODE.MULT function

## Introduction
The MODE.MULT function returns a vertical array of the most frequently occurring values in a dataset. Unlike MODE which returns only a single mode, MODE.MULT returns all values that share the highest frequency, making it essential for multimodal distributions.

## Syntax
```
=MODE.MULT(number1, [number2], ...)
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number1 | Required | The first number, cell reference, or range to evaluate. |
| number2, ... | Optional | Additional numbers, cell references, or ranges. Up to 255 arguments. |

## Remarks
- Returns a vertical array that spills downward.
- If no value is repeated, returns #N/A.
- Text, logical values, and empty cells in ranges are ignored.
- If there is only one mode, the result is a single value (same as MODE).

## Example

| | A | B |
|---|---|---|
| 1 | **Scores** | **Modes** |
| 2 | 3 | =MODE.MULT(A2:A8) |
| 3 | 5 | |
| 4 | 3 | |
| 5 | 7 | |
| 6 | 5 | |
| 7 | 9 | |
| 8 | 2 | |

**Result:** B2 = 3, B3 = 5 (both appear twice)
