# TRUNC function

## Introduction
The TRUNC function truncates a number to a specified number of decimal places by removing (not rounding) the fractional part. Unlike ROUND, which considers the value of the removed digits, TRUNC simply cuts them off. This makes TRUNC ideal for extracting the integer portion of a number or reducing precision without rounding bias.

## Syntax
```
=TRUNC(number, [num_digits])
```

| Argument | Required/Optional | Description |
|----------|-------------------|-------------|
| number | Required | The number to truncate. |
| num_digits | Optional | The number of decimal places to keep. Defaults to 0 (truncates to an integer). |

## Remarks
- TRUNC removes decimal places without rounding.
- TRUNC(4.9) returns 4, not 5.
- TRUNC(-4.9) returns -4, not -5 (truncates toward zero).
- When **num_digits** is negative, it truncates digits to the left of the decimal point.

## Example

| | A | B |
|---|---|---|
| 1 | **Hours Worked** | **Full Hours** |
| 2 | 8.75 | =TRUNC(A2) |
| 3 | 7.25 | =TRUNC(A3) |

**Results:**
- B2: 8
- B3: 7

The formula extracts only the complete hours worked, discarding the fractional part without rounding.
